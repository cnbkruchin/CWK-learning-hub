/**
 * รายงาน (แยกตามห้อง หรือแยกตามกลุ่ม) — ส่งออกเป็น Excel (.xlsx) หรือ PDF (หน้าพิมพ์ในเบราว์เซอร์)
 *
 * ทุกรูปแบบสร้างจาก "เอกสารรายงาน" ชุดเดียวกันที่เซิร์ฟเวอร์คำนวณผ่าน Gradebook/Grading
 * หน้าจอ PDF และ XLSX จึงแสดงคะแนน เกรด สถานะ รหัส และรายชื่อตรงกัน
 *
 * เอกสารรายงาน: { kind, title, meta: [[หัวข้อ, ค่า]], provisional, sections: [{ title, sheetName, columns, rows }], legend, notes }
 *   cell = 'ข้อความ' | { v: '16.5', t: 'n' } (ตัวเลข)
 *
 * สิทธิ์: รายงานรายวิชา/รายกลุ่มต้องมีสิทธิ์ส่งออก (can_export) ของรายวิชานั้น
 *         รายงานรายห้องรวมเฉพาะรายวิชาที่ผู้ขอมีสิทธิ์ส่งออก (ผู้ดูแลเห็นทุกวิชา)
 */
var Reports = {
  SHORT: { not_assessed: '-', missing: 'ขส', excused: 'ยว', needs_revision: 'รอแก้' },
  LEGEND: ['ขส = ยังไม่ส่งงาน/ขาดสอบ', 'ยว = ได้รับการยกเว้น (ตัดออกจากฐานคะแนนของคนนั้น)', 'รอแก้ = รอแก้ไขงาน', '- = ยังไม่ประเมิน (ไม่ใช่ศูนย์)'],
  METHOD: { per_item: 'น้ำหนักรายรายการ', per_category: 'น้ำหนักรายหมวด' },
  KIND: { individual: 'งานเดี่ยว', group: 'งานกลุ่ม', exam: 'สอบ', score_only: 'รับคะแนนอย่างเดียว' },

  num: function (v) { return v === null || v === undefined || v === '' ? '' : { v: String(v), t: 'n' }; },

  scoreCell: function (c) {
    if (!c) return '-';
    if (c.status === 'scored') return Reports.num(c.score);
    return Reports.SHORT[c.status] || '-';
  },

  totalCells: function (t) {
    if (t.status === 'complete') return [Reports.num(t.final), 'ครบ', t.grade ? t.grade.label : ''];
    if (t.status === 'incomplete') return [Reports.num(t.provisional), 'ยังไม่ครบ (ตรวจแล้ว ' + t.assessedWeightPct + '%)', ''];
    return ['', t.label, ''];
  },

  _school: function (ctx) {
    var school = Db.get('schools', ctx.schoolId);
    var st = Settings.get(ctx.schoolId);
    return { name: school ? school.name_th : '', appName: (school && school.app_name) || st.app_name };
  },

  _base: function (ctx, kind, title) {
    var now = Util.nowIso();
    var school = Reports._school(ctx);
    return {
      kind: kind, title: title, school: school.name, appName: school.appName, issuedAt: now, issuedAtText: Util.formatThai(now),
      issuedBy: ctx.user.display_name || ctx.user.username, meta: [['โรงเรียน', school.name]], sections: [], legend: Reports.LEGEND.slice(), notes: []
    };
  },

  _offeringMeta: function (doc, o, policy) {
    var course = Db.get('courses', o.course_id);
    var path = Files._offeringPath(o);
    var teachers = Db.find('teaching_assignments', { offering_id: o.id }).filter(function (x) { return !x.revoked_at; })
      .sort(function (a, b) { return a.role === 'owner' ? -1 : b.role === 'owner' ? 1 : 0; })
      .map(function (x) { return Courses.teacherName(x.teacher_id) + (x.role === 'owner' ? '' : ' (ร่วมสอน)'); })
      .filter(function (v, i, a) { return v && a.indexOf(v) === i; });
    doc.meta.push(['รายวิชา', course ? course.course_code + ' ' + course.name_th : '']);
    doc.meta.push(['ปีการศึกษา / ภาคเรียน', path.yearBe + ' / ' + path.termNo]);
    doc.meta.push(['กลุ่มเรียน', o.section_code]);
    doc.meta.push(['ครูผู้สอน', teachers.join(', ')]);
    if (policy) {
      doc.meta.push(['วิธีคำนวณ', Reports.METHOD[policy.method] || policy.method]);
      doc.meta.push(['การปัดเศษ', 'ปัดครั้งเดียวตอนสรุป ' + policy.digits + ' ตำแหน่ง (half up)']);
      if (policy.versionNo) doc.meta.push(['รุ่นนโยบายคะแนน', String(policy.versionNo)]);
    }
    doc.provisional = o.status !== 'closed';
    doc.meta.push(['สถานะรายงาน', doc.provisional ? 'รายงานชั่วคราว (ยังไม่ปิดผลรายวิชา)' : 'ผลหลังปิดรายวิชา']);
    doc.meta.push(['วันที่ออกรายงาน', doc.issuedAtText]);
    doc.fileBase = [course ? course.course_code : 'course', o.section_code, path.yearBe + '-' + path.termNo].join('_');
    doc.courseLine = (course ? course.course_code + ' ' + course.name_th : '') + ' · กลุ่มเรียน ' + o.section_code + ' · ปี ' + path.yearBe + ' ภาค ' + path.termNo;
  },

  _assessmentHeader: function (a) {
    return a.code + ' (เต็ม ' + a.maxScore + (a.countsTowardGrade ? ' / น้ำหนัก ' + a.weight : ' / ไม่นับคะแนน') + ')';
  },

  // ---------------------------------------------------------------- สมุดคะแนนรายวิชา แยกตามห้อง
  offering: function (ctx, req) {
    var auth = Authz.requireOffering(ctx, req.offeringId, 'can_export');
    var o = auth.offering;
    var gb = Gradebook.build(o);
    var doc = Reports._base(ctx, 'offering', req.groupBy === 'all' ? 'สมุดคะแนนรายวิชา' : 'สมุดคะแนนรายวิชา แยกตามห้อง');
    Reports._offeringMeta(doc, o, gb.policy);
    doc.fileBase = 'สมุดคะแนน_' + doc.fileBase;
    var columns = [{ label: 'ที่' }, { label: 'รหัสนักเรียน' }, { label: 'ชื่อ - สกุล' }, { label: 'ห้อง' }, { label: 'เลขที่' }]
      .concat(gb.assessments.map(function (a) { return { label: Reports._assessmentHeader(a), kind: 'num' }; }))
      .concat([{ label: 'คะแนนรวม (100)', kind: 'num' }, { label: 'สถานะ' }, { label: 'เกรด' }]);
    var rowOf = function (r, i) {
      return [String(i + 1), r.code, r.name, r.roomLabel, r.rollNo === null || r.rollNo === '' ? '' : String(r.rollNo)]
        .concat(gb.assessments.map(function (a) { return Reports.scoreCell(r.cells[a.id]); }))
        .concat(Reports.totalCells(r.total));
    };
    var active = gb.students.filter(function (r) { return r.enrollmentStatus === 'active'; });
    var left = gb.students.filter(function (r) { return r.enrollmentStatus !== 'active'; });
    var buckets = [];
    if (req.groupBy === 'all') buckets.push({ title: 'นักเรียนทั้งหมด', sheetName: 'คะแนน', rows: active });
    else {
      var byRoom = {};
      active.forEach(function (r) { (byRoom[r.roomLabel] = byRoom[r.roomLabel] || []).push(r); });
      Object.keys(byRoom).sort(function (a, b) { return a.localeCompare(b, 'th', { numeric: true }); }).forEach(function (k) {
        buckets.push({ title: 'ห้อง ' + k + ' (' + byRoom[k].length + ' คน)', sheetName: 'ห้อง ' + k, rows: byRoom[k] });
      });
    }
    if (left.length) buckets.push({ title: 'ถอน/ย้ายออกจากรายวิชา (' + left.length + ' คน)', sheetName: 'ถอน-ย้ายออก', rows: left });
    buckets.forEach(function (b) { doc.sections.push({ title: b.title, sheetName: b.sheetName, columns: columns, rows: b.rows.map(rowOf) }); });
    if (!buckets.length) doc.sections.push({ title: 'ยังไม่มีนักเรียนในรายวิชา', sheetName: 'คะแนน', columns: columns, rows: [] });
    doc.sections.push({
      title: 'รายการประเมิน', sheetName: 'รายการประเมิน',
      columns: [{ label: 'รหัส' }, { label: 'ชื่อรายการ' }, { label: 'ประเภท' }, { label: 'คะแนนเต็ม', kind: 'num' }, { label: 'น้ำหนักในรายวิชา', kind: 'num' }, { label: 'นับคะแนน' }],
      rows: gb.assessments.map(function (a) { return [a.code, a.title, Reports.KIND[a.kind], Reports.num(a.maxScore), Reports.num(a.weight), a.countsTowardGrade ? 'นับ' : 'ไม่นับ']; })
    });
    doc.notes.push('คะแนนรวมคำนวณ: ' + (gb.policy.method === 'per_category'
      ? 'สัดส่วนของแต่ละหมวด (ถ่วงน้ำหนักภายในหมวด) × น้ำหนักหมวด ปรับเป็นฐาน 100'
      : 'Σ(น้ำหนัก × คะแนน/คะแนนเต็ม) ÷ Σ(น้ำหนักที่นับ) × 100'));
    doc.notes.push('คะแนนเต็มกับน้ำหนักเป็นคนละค่า งานที่ได้รับการยกเว้นถูกตัดออกจากฐานคะแนนของคนนั้น');
    doc.notes.push('"ยังไม่ครบ" = มีรายการที่ยังไม่ประเมิน คะแนนรวมเป็นคะแนนสะสมบนฐาน 100 ยังไม่ใช่ผลสุดท้ายและไม่ออกเกรด');
    doc.notes.push('เกณฑ์เกรด: ' + gb.policy.bands.map(function (b) { return b.label + ' = ' + b.min + '–' + b.max; }).join(', ') + ' (ตัวอย่างค่าเริ่มต้น ไม่ใช่ระเบียบของโรงเรียนจนกว่าจะยืนยัน)');
    doc.notes.push('งานกลุ่ม: คะแนนกลุ่มของแต่ละงานเก็บที่กลุ่ม และบันทึกเป็นคะแนนรายบุคคลของสมาชิกโดยอัตโนมัติ (ไม่หารด้วยจำนวนสมาชิก)');
    doc.orientation = columns.length > 9 ? 'landscape' : 'portrait';
    return doc;
  },

  // ---------------------------------------------------------------- ผลประเมินงานกลุ่ม แยกตามกลุ่ม
  groups: function (ctx, req) {
    var auth = Authz.requireOffering(ctx, req.offeringId, 'can_export');
    var o = auth.offering;
    var doc = Reports._base(ctx, 'groups', 'ผลประเมินงานกลุ่ม แยกตามกลุ่ม');
    Reports._offeringMeta(doc, o, Gradebook.policy(o));
    doc.fileBase = 'คะแนนกลุ่ม_' + doc.fileBase;
    var groupAssessments = Gradebook.assessmentsOf(o.id).filter(function (a) { return a.kind === 'group'; });
    var sheets = groupAssessments.map(function (a) { return { a: a, sheet: Gradebook.groupSheet(ctx, a.id) }; });
    // สรุป: แถวละกลุ่มประจำรายวิชา (กลุ่มเดียวกันทำได้หลายงาน) + กลุ่มที่จัดเฉพาะงาน
    var summaryRows = [];
    var wgs = Db.find('work_groups', { offering_id: o.id }).filter(function (w) { return w.status === 'active'; })
      .sort(function (x, y) { return String(x.name).localeCompare(String(y.name), 'th', { numeric: true }); });
    var groupScore = function (g) {
      if (!g || !g.groupGrade) return '';
      return g.groupGrade.status === 'scored' ? Reports.num(g.groupGrade.score) : (Reports.SHORT[g.groupGrade.status] || '-');
    };
    wgs.forEach(function (w) {
      var members = Db.find('work_group_members', { work_group_id: w.id, status: 'active' }).map(function (m) {
        var s = Db.get('students', m.student_id); return s ? Registry.personName(s) + (w.leader_student_id === s.id ? ' (หัวหน้า)' : '') : '';
      }).filter(Boolean);
      summaryRows.push([w.name, 'กลุ่มประจำรายวิชา', members.join(', ')].concat(sheets.map(function (x) {
        return groupScore(x.sheet.groups.filter(function (g) { return g.workGroupId === w.id; })[0]);
      })));
    });
    sheets.forEach(function (x, idx) {
      x.sheet.groups.filter(function (g) { return !g.workGroupId; }).forEach(function (g) {
        var cells = sheets.map(function (y, j) { return j === idx ? groupScore(g) : ''; });
        summaryRows.push([g.name, 'เฉพาะงาน ' + x.a.code, g.members.map(function (m) { return m.name + (m.isLeader ? ' (หัวหน้า)' : ''); }).join(', ')].concat(cells));
      });
    });
    doc.sections.push({
      title: 'สรุปคะแนนกลุ่มทุกงาน', sheetName: 'สรุปคะแนนกลุ่ม',
      columns: [{ label: 'กลุ่ม' }, { label: 'ประเภทกลุ่ม' }, { label: 'สมาชิกปัจจุบัน' }].concat(sheets.map(function (x) {
        return { label: x.a.code + ' (เต็ม ' + x.a.max_score + ')', kind: 'num' };
      })),
      rows: summaryRows
    });
    sheets.forEach(function (x) {
      var rows = [];
      x.sheet.groups.forEach(function (g) {
        g.members.forEach(function (m, i) {
          var note = m.state === 'override' ? 'ปรับรายคน: ' + (m.grade.overrideReason || '') :
            m.state === 'pending' ? 'ยังไม่ได้รับคะแนนกลุ่มล่าสุด (เข้ากลุ่มภายหลัง)' : m.state === 'not_enrolled' ? 'ไม่ได้ลงทะเบียนแล้ว' : '';
          rows.push([i === 0 ? g.name : '', i === 0 ? groupScore(g) : '', m.studentCode, m.name + (m.isLeader ? ' (หัวหน้า)' : ''), m.room || '', Reports.scoreCell(m.grade), note]);
        });
        if (!g.members.length) rows.push([g.name, groupScore(g), '', '(ไม่มีสมาชิก)', '', '', '']);
      });
      x.sheet.ungrouped.forEach(function (u) { rows.push(['(ไม่มีกลุ่ม)', '', u.studentCode, u.name, u.room || '', Reports.scoreCell(u.grade), 'ยังไม่มีกลุ่มในงานนี้']); });
      doc.sections.push({
        title: x.a.code + ' ' + x.a.title + ' — คะแนนเต็ม ' + x.a.max_score + ' น้ำหนัก ' + (x.a.weight || 0),
        sheetName: x.a.code + ' สมาชิก',
        columns: [{ label: 'กลุ่ม' }, { label: 'คะแนนกลุ่ม', kind: 'num' }, { label: 'รหัสนักเรียน' }, { label: 'ชื่อ - สกุล' }, { label: 'ห้อง' }, { label: 'คะแนนรายบุคคล', kind: 'num' }, { label: 'หมายเหตุ' }],
        rows: rows
      });
    });
    if (!groupAssessments.length) doc.notes.push('รายวิชานี้ยังไม่มีงานกลุ่ม');
    doc.notes.push('คะแนนกลุ่มของแต่ละงานเก็บที่กลุ่มของงานนั้น ระบบบันทึกเป็นคะแนนรายบุคคลของสมาชิกที่ตรึงรายชื่อไว้ทุกคน (ไม่หารด้วยจำนวนสมาชิก)');
    doc.notes.push('สมาชิกที่ครูปรับคะแนนรายคนจะคงคะแนนที่ปรับไว้ แม้แก้คะแนนกลุ่มภายหลัง จนกว่าครูจะยกเลิกการปรับ');
    doc.orientation = 'landscape';
    return doc;
  },

  // ---------------------------------------------------------------- สรุปคะแนนรายห้อง (ทุกรายวิชา)
  room: function (ctx, req) {
    Registry.requireStaff(ctx);
    var classLevel = Util.str(req.classLevel, 20), room = Util.str(req.room, 20);
    if (!classLevel && !room) Errors.raise('VALIDATION', 'กรุณาเลือกห้องเรียน');
    var label = Registry.roomLabel(classLevel, room);
    var doc = Reports._base(ctx, 'room', 'สรุปคะแนนรายห้อง ' + label);
    var students = Db.all('students').filter(function (s) {
      return s.school_id === ctx.schoolId && s.status === 'active' && String(s.class_level || '') === classLevel && String(s.room || '') === room;
    }).sort(Registry.compareStudents);
    var ids = Util.indexBy(students, 'id');
    var term = req.termId ? Db.get('terms', req.termId) : null;
    if (req.termId && (!term || term.school_id !== ctx.schoolId)) Errors.raise('NOT_FOUND');
    var offerings = Db.all('course_offerings').filter(function (o) {
      if (o.school_id !== ctx.schoolId || o.status === 'archived' || (term && o.term_id !== term.id)) return false;
      if (!Authz.offeringPerms(ctx, o).can_export) return false;
      return Db.find('enrollments', { offering_id: o.id }).some(function (e) { return ids[e.student_id] && e.status === 'active'; });
    });
    var results = offerings.map(function (o) {
      var gb = Gradebook.build(o);
      var course = Db.get('courses', o.course_id);
      var path = Files._offeringPath(o);
      return {
        o: o, label: (course ? course.course_code + ' ' + course.name_th : '') + ' (' + o.section_code + ', ' + path.yearBe + '/' + path.termNo + ')',
        by: Util.indexBy(gb.students.filter(function (r) { return r.enrollmentStatus === 'active'; }), 'studentId'), path: path, course: course
      };
    }).sort(function (a, b) { return a.label.localeCompare(b.label, 'th', { numeric: true }); });
    // ครูเห็นเฉพาะนักเรียนที่เรียนรายวิชาของตน (ผู้ดูแลเห็นทั้งห้อง)
    if (!ctx.roles.admin) students = students.filter(function (s) { return results.some(function (r) { return r.by[s.id]; }); });
    doc.meta.push(['ห้องเรียน', label]);
    var termYear = term ? Db.get('academic_years', term.academic_year_id) : null;
    doc.meta.push(['ภาคเรียน', term ? (termYear ? termYear.year_be : '') + ' / ' + term.term_no : 'ทุกภาคเรียนที่ยังไม่เก็บถาวร']);
    doc.meta.push(['จำนวนนักเรียน', String(students.length) + ' คน']);
    doc.meta.push(['จำนวนรายวิชา', String(results.length) + ' รายวิชา']);
    doc.provisional = results.some(function (r) { return r.o.status !== 'closed'; });
    doc.meta.push(['สถานะรายงาน', doc.provisional ? 'รายงานชั่วคราว (มีรายวิชาที่ยังไม่ปิดผล)' : 'ผลหลังปิดรายวิชา']);
    doc.meta.push(['วันที่ออกรายงาน', doc.issuedAtText]);
    var columns = [{ label: 'ที่' }, { label: 'รหัสนักเรียน' }, { label: 'ชื่อ - สกุล' }, { label: 'เลขที่' }];
    results.forEach(function (r) { columns.push({ label: r.label + ' คะแนน', kind: 'num' }, { label: 'เกรด' }); });
    doc.sections.push({
      title: 'ห้อง ' + label, sheetName: 'ห้อง ' + label, columns: columns,
      rows: students.map(function (s, i) {
        var row = [String(i + 1), s.student_code, Registry.personName(s), s.roll_no === null ? '' : String(s.roll_no)];
        results.forEach(function (r) {
          var x = r.by[s.id];
          if (!x) { row.push('', 'ไม่ได้เรียน'); return; }
          var t = x.total;
          if (t.status === 'complete') row.push(Reports.num(t.final), t.grade ? t.grade.label : '');
          else if (t.status === 'incomplete') row.push(Reports.num(t.provisional), 'ยังไม่ครบ');
          else row.push('', 'ไม่มีฐานคะแนน');
        });
        return row;
      })
    });
    doc.sections.push({
      title: 'รายวิชาในรายงาน', sheetName: 'รายวิชา',
      columns: [{ label: 'รายวิชา' }, { label: 'ครูเจ้าของรายวิชา' }, { label: 'สถานะ' }],
      rows: results.map(function (r) { return [r.label, Courses.teacherName(r.o.owner_teacher_id), r.o.status === 'closed' ? 'ปิดผลแล้ว' : 'ยังไม่ปิดผล (ชั่วคราว)']; })
    });
    doc.legend = ['"ยังไม่ครบ" = คะแนนสะสมบนฐาน 100 จากรายการที่ประเมินแล้ว ยังไม่ออกเกรด', '"ไม่ได้เรียน" = ไม่ได้ลงทะเบียนในรายวิชานั้น'];
    doc.notes.push('คะแนนแต่ละรายวิชาคำนวณด้วยแผนคะแนนของรายวิชานั้น (โมดูลคำนวณเดียวกับสมุดคะแนน)');
    doc.fileBase = 'สรุปรายห้อง_' + label.replace(/\//g, '-') + (term ? '_' + term.term_no : '');
    doc.orientation = columns.length > 8 ? 'landscape' : 'portrait';
    return doc;
  },

  build: function (ctx, req) {
    var kind = req.kind;
    var doc;
    if (kind === 'offering') doc = Reports.offering(ctx, req);
    else if (kind === 'groups') doc = Reports.groups(ctx, req);
    else if (kind === 'room') doc = Reports.room(ctx, req);
    else Errors.raise('VALIDATION', 'ไม่รู้จักชนิดรายงาน');
    return doc;
  },

  /** ข้อมูลรายงานสำหรับหน้าจอ/หน้าพิมพ์ PDF */
  data: function (ctx, req) {
    var doc = Reports.build(ctx, req);
    Audit.log(ctx, 'report.view', 'report', req.offeringId || '', { kind: req.kind, room: req.room || '' }, '', req.offeringId || '');
    return doc;
  },

  /** แปลงเอกสารรายงานเป็นชีต Excel */
  toSheets: function (doc) {
    var info = [[{ v: doc.title, s: 'title' }], []];
    doc.meta.forEach(function (m) { info.push([{ v: m[0], s: 'bold' }, m[1]]); });
    info.push(['ออกโดย', doc.issuedBy + ' (' + doc.appName + ')']);
    if (doc.legend && doc.legend.length) { info.push([]); info.push([{ v: 'ความหมายสัญลักษณ์', s: 'bold' }]); doc.legend.forEach(function (l) { info.push([l]); }); }
    if (doc.notes && doc.notes.length) { info.push([]); info.push([{ v: 'คำอธิบายเกณฑ์', s: 'bold' }]); doc.notes.forEach(function (n) { info.push([n]); }); }
    var sheets = [{ name: 'ข้อมูลรายงาน', rows: info, widths: [26, 90] }];
    doc.sections.forEach(function (sec) {
      var header = sec.columns.map(function (c) { return { v: c.label, s: 'header' }; });
      var widths = sec.columns.map(function (c, i) {
        var max = String(c.label).length;
        sec.rows.forEach(function (r) { var v = r[i]; var s = v && typeof v === 'object' ? String(v.v) : String(v === undefined || v === null ? '' : v); max = Math.max(max, s.length); });
        return Math.min(Math.max(6, Math.round(max * 1.1) + 2), 48);
      });
      sheets.push({ name: sec.sheetName || sec.title, rows: [header].concat(sec.rows), widths: widths, freezeRows: 1 });
    });
    return sheets;
  },

  xlsx: function (ctx, req) {
    var doc = Reports.build(ctx, req);
    var bytes = Xlsx.build(Reports.toSheets(doc), { title: doc.title, created: doc.issuedAt });
    var name = (doc.fileBase || 'report').replace(/[\\\/:*?"<>|\s]+/g, '_') + '.xlsx';
    Audit.log(ctx, 'report.export', 'report', req.offeringId || '', { kind: req.kind, format: 'xlsx', room: req.room || '' }, '', req.offeringId || '');
    return { fileName: name, mime: Xlsx.MIME, size: bytes.length, base64: Utilities.base64Encode(Util.toSigned(bytes)) };
  }
};
