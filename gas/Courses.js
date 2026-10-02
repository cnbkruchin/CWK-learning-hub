/**
 * ปีการศึกษา ภาคเรียน รายวิชาในหลักสูตร รายวิชาที่เปิดสอน และการลงทะเบียนเรียน
 *
 * - ผู้ดูแลจัดการปีการศึกษา/ภาคเรียน และเปิดรายวิชาให้ครูคนใดก็ได้
 * - ครูเพิ่มรายวิชาในหลักสูตรและเปิดสอนรายวิชาของตนเองได้หลายวิชา (ครูผู้สร้างเป็นครูเจ้าของรายวิชา)
 * - ลงทะเบียนเรียน: ครู/ผู้ดูแลเลือกนักเรียนที่มีในทะเบียน (ทีละคนหรือทั้งห้อง) หรือเปิดรหัสเข้าร่วมให้นักเรียนลงทะเบียนเอง
 * - ถอนรายวิชาไม่ลบข้อมูล เก็บวันมีผลและประวัติ; เพิ่มกลางภาคไม่สร้างคะแนนศูนย์ย้อนหลัง
 */
var Courses = {
  // ---------------------------------------------------------------- ปีการศึกษาและภาคเรียน
  terms: function (ctx) {
    Registry.requireStaff(ctx);
    var years = Db.all('academic_years').filter(function (y) { return y.school_id === ctx.schoolId; })
      .sort(function (a, b) { return b.year_be - a.year_be; });
    var terms = Db.all('terms').filter(function (t) { return t.school_id === ctx.schoolId; });
    return years.map(function (y) {
      return {
        id: y.id, version: y.version, yearBe: y.year_be, startDate: y.start_date, endDate: y.end_date, status: y.status,
        terms: terms.filter(function (t) { return t.academic_year_id === y.id; }).sort(function (a, b) { return a.term_no - b.term_no; })
          .map(function (t) { return { id: t.id, version: t.version, termNo: t.term_no, name: t.name, startDate: t.start_date, endDate: t.end_date, status: t.status, label: 'ปี ' + y.year_be + ' ภาค ' + t.term_no }; })
      };
    });
  },

  _date: function (v, label) {
    var s = Util.str(v, 10);
    if (s && !/^\d{4}-\d{2}-\d{2}$/.test(s)) Errors.raise('VALIDATION', label + ' ต้องเป็นวันที่ (ปปปป-ดด-วว ค.ศ.)');
    return s;
  },

  saveYear: function (ctx, req) {
    Authz.requireAdmin(ctx);
    var year = Number(req.yearBe);
    if (!(year >= 2500 && year <= 2700) || Math.floor(year) !== year) Errors.raise('VALIDATION', 'ปีการศึกษาต้องเป็นปี พ.ศ. เช่น 2569');
    var data = {
      year_be: year, start_date: Courses._date(req.startDate, 'วันเริ่ม'), end_date: Courses._date(req.endDate, 'วันสิ้นสุด'),
      status: ['planning', 'active', 'closed'].indexOf(req.status) >= 0 ? req.status : 'active'
    };
    return Db.tx('course.saveYear', function (tx) {
      var y;
      if (req.id) {
        var cur = tx.get('academic_years', req.id);
        if (!cur || cur.school_id !== ctx.schoolId) Errors.raise('NOT_FOUND');
        y = tx.update('academic_years', cur.id, data, { expectedVersion: req.version });
      } else {
        data.school_id = ctx.schoolId;
        y = tx.insert('academic_years', data);
        // สร้างภาคเรียน 1 และ 2 ให้อัตโนมัติ (แก้/เพิ่มภาคฤดูร้อนได้ภายหลัง)
        if (req.createTerms !== false) [1, 2].forEach(function (n) { tx.insert('terms', { school_id: ctx.schoolId, academic_year_id: y.id, term_no: n, name: 'ภาคเรียนที่ ' + n, status: 'active' }); });
      }
      tx.afterCommit(function () { Audit.log(ctx, 'year.save', 'academic_years', y.id, { yearBe: y.year_be }); });
      return { id: y.id };
    }, { actorId: ctx.user.id });
  },

  saveTerm: function (ctx, req) {
    Authz.requireAdmin(ctx);
    var no = Number(req.termNo);
    if ([1, 2, 3].indexOf(no) < 0) Errors.raise('VALIDATION', 'ภาคเรียนต้องเป็น 1, 2 หรือ 3 (ฤดูร้อน)');
    var data = {
      term_no: no, name: Util.str(req.name, 50) || (no === 3 ? 'ภาคฤดูร้อน' : 'ภาคเรียนที่ ' + no),
      start_date: Courses._date(req.startDate, 'วันเริ่ม'), end_date: Courses._date(req.endDate, 'วันสิ้นสุด'),
      status: ['planning', 'active', 'closed'].indexOf(req.status) >= 0 ? req.status : 'active'
    };
    return Db.tx('course.saveTerm', function (tx) {
      var t;
      if (req.id) {
        var cur = tx.get('terms', req.id);
        if (!cur || cur.school_id !== ctx.schoolId) Errors.raise('NOT_FOUND');
        t = tx.update('terms', cur.id, data, { expectedVersion: req.version });
      } else {
        var y = tx.get('academic_years', req.academicYearId);
        if (!y || y.school_id !== ctx.schoolId) Errors.raise('NOT_FOUND');
        data.school_id = ctx.schoolId; data.academic_year_id = y.id;
        t = tx.insert('terms', data);
      }
      return { id: t.id };
    }, { actorId: ctx.user.id });
  },

  // ---------------------------------------------------------------- รายวิชาในหลักสูตร
  courseDto: function (c) {
    return {
      id: c.id, version: c.version, code: c.course_code, nameTh: c.name_th, nameEn: c.name_en, learningArea: c.learning_area,
      gradeLevel: c.grade_level, credits: c.credits, hours: c.hours, description: c.description, status: c.status, createdBy: c.created_by
    };
  },

  catalog: function (ctx) {
    Registry.requireStaff(ctx);
    return Db.all('courses').filter(function (c) { return c.school_id === ctx.schoolId; })
      .sort(function (a, b) { return String(a.course_code).localeCompare(String(b.course_code), 'th', { numeric: true }); })
      .map(Courses.courseDto);
  },

  saveCourse: function (ctx, req) {
    Registry.requireStaff(ctx);
    var code = Util.requireStr(req.code, 'รหัสวิชา', 30);
    var credits = req.credits === '' || req.credits === undefined || req.credits === null ? '' : req.credits;
    if (credits !== '' && (!Dec.isValid(credits) || Number(credits) < 0)) Errors.raise('VALIDATION', 'หน่วยกิตต้องเป็นตัวเลข');
    var hours = req.hours === '' || req.hours === undefined || req.hours === null ? '' : Number(req.hours);
    if (hours !== '' && (!(hours >= 0) || Math.floor(hours) !== hours)) Errors.raise('VALIDATION', 'ชั่วโมงเรียนต้องเป็นจำนวนเต็ม');
    var data = {
      course_code: code, name_th: Util.requireStr(req.nameTh, 'ชื่อวิชา', 200), name_en: Util.str(req.nameEn, 200),
      learning_area: Util.str(req.learningArea, 100), grade_level: Util.str(req.gradeLevel, 20), description: Util.str(req.description, 5000),
      credits: credits === '' ? '' : Dec.normalize(credits), hours: hours, status: req.status === 'inactive' ? 'inactive' : 'active'
    };
    return Db.tx('course.saveCourse', function (tx) {
      var c;
      if (req.id) {
        var cur = tx.get('courses', req.id);
        if (!cur || cur.school_id !== ctx.schoolId) Errors.raise('NOT_FOUND');
        if (!ctx.roles.admin && cur.created_by !== ctx.user.id) Errors.raise('FORBIDDEN', 'แก้ได้เฉพาะรายวิชาที่คุณสร้าง หรือให้ผู้ดูแลแก้');
        c = tx.update('courses', cur.id, data, { expectedVersion: req.version });
      } else {
        data.school_id = ctx.schoolId;
        c = tx.insert('courses', data);
      }
      tx.afterCommit(function () { Audit.log(ctx, req.id ? 'course.update' : 'course.create', 'courses', c.id, { code: c.course_code }); });
      return Courses.courseDto(c);
    }, { actorId: ctx.user.id });
  },

  // ---------------------------------------------------------------- รายวิชาที่เปิดสอน
  teacherName: function (teacherId) {
    var t = Db.get('teachers', teacherId);
    return t ? Registry.personName(t) : '';
  },

  offeringDto: function (ctx, o, perms) {
    var course = Db.get('courses', o.course_id);
    var path = Files._offeringPath(o);
    var p = perms || Authz.offeringPerms(ctx, o);
    return {
      offeringId: o.id, version: o.version, courseId: o.course_id, termId: o.term_id, courseCode: course && course.course_code,
      courseName: course && course.name_th, section: o.section_code, displayName: o.display_name, yearBe: path.yearBe, termNo: path.termNo,
      status: o.status, calcMethod: o.calc_method, ownerTeacherId: o.owner_teacher_id, ownerName: Courses.teacherName(o.owner_teacher_id),
      isOwner: p.owner, perms: Util.pick(p, APP.OFFERING_PERMISSIONS),
      joinEnabled: p.can_manage ? !!o.join_enabled : undefined, joinCode: p.can_manage ? o.join_code : undefined,
      groupSettings: { maxSize: Number(o.group_max_size || 0), leaderDirectAdd: !!o.leader_direct_add, locked: !!o.groups_locked },
      students: Db.find('enrollments', { offering_id: o.id }).filter(function (e) { return e.status === 'active'; }).length
    };
  },

  /** รายวิชาที่เปิดสอนทั้งหมดที่ผู้ใช้มีสิทธิ์ดู (ผู้ดูแลเห็นทั้งโรงเรียน) */
  offerings: function (ctx, req) {
    Registry.requireStaff(ctx);
    req = req || {};
    return Db.all('course_offerings').filter(function (o) {
      return o.school_id === ctx.schoolId && (!req.termId || o.term_id === req.termId) && (req.includeArchived || o.status !== 'archived');
    }).map(function (o) {
      var p = Authz.offeringPerms(ctx, o);
      return p.can_view ? Courses.offeringDto(ctx, o, p) : null;
    }).filter(Boolean).sort(function (a, b) {
      return (b.yearBe - a.yearBe) || (b.termNo - a.termNo) || String(a.courseCode).localeCompare(String(b.courseCode), 'th', { numeric: true }) ||
        String(a.section).localeCompare(String(b.section), 'th', { numeric: true });
    });
  },

  saveOffering: function (ctx, req) {
    Registry.requireStaff(ctx);
    var section = Util.requireStr(req.sectionCode, 'กลุ่มเรียน', 30);
    var calc = req.calcMethod === 'per_category' ? 'per_category' : 'per_item';
    var status = ['draft', 'open', 'archived'].indexOf(req.status) >= 0 ? req.status : 'open';
    var displayName = Util.str(req.displayName, 200);
    return Db.tx('course.saveOffering', function (tx) {
      var o;
      if (req.id) {
        var cur = tx.get('course_offerings', req.id);
        if (!cur || cur.school_id !== ctx.schoolId) Errors.raise('NOT_FOUND');
        var perms = Authz.offeringPerms(ctx, cur);
        if (!ctx.roles.admin && !perms.owner) Errors.raise('FORBIDDEN');
        if (cur.status === 'closed') Errors.raise('OFFERING_CLOSED');
        var patch = { section_code: section, display_name: displayName, status: status };
        if (calc !== cur.calc_method) {
          var scored = tx.find('student_grades', { offering_id: cur.id }).some(function (g) { return g.status === 'scored'; });
          if (scored) Errors.raise('VALIDATION', 'มีคะแนนแล้ว เปลี่ยนวิธีคำนวณไม่ได้ (ต้องสร้างรุ่นนโยบายคะแนนใหม่พร้อมเหตุผล)');
          patch.calc_method = calc;
          if (cur.active_policy_version_id) tx.update('grading_policy_versions', cur.active_policy_version_id, { calc_method: calc });
        }
        if (req.ownerTeacherId && req.ownerTeacherId !== cur.owner_teacher_id) {
          if (!ctx.roles.admin) Errors.raise('FORBIDDEN', 'เปลี่ยนครูเจ้าของรายวิชาได้เฉพาะผู้ดูแล');
          var nt = tx.get('teachers', req.ownerTeacherId);
          if (!nt || nt.school_id !== ctx.schoolId) Errors.raise('NOT_FOUND', 'ไม่พบครู');
          tx.find('teaching_assignments', { offering_id: cur.id }).forEach(function (ta) {
            if (ta.role === 'owner' && !ta.revoked_at) tx.update('teaching_assignments', ta.id, { revoked_at: tx.now, revoked_by: ctx.user.id });
          });
          Courses._insertOwnerAssignment(tx, ctx.schoolId, cur.id, nt.id);
          patch.owner_teacher_id = nt.id;
        }
        o = tx.update('course_offerings', cur.id, patch, { expectedVersion: req.version });
      } else {
        var course = tx.get('courses', req.courseId);
        if (!course || course.school_id !== ctx.schoolId) Errors.raise('NOT_FOUND', 'ไม่พบรายวิชาในหลักสูตร');
        var term = tx.get('terms', req.termId);
        if (!term || term.school_id !== ctx.schoolId) Errors.raise('NOT_FOUND', 'ไม่พบภาคเรียน');
        if (term.status === 'closed') Errors.raise('VALIDATION', 'ภาคเรียนนี้ปิดแล้ว');
        var ownerId;
        if (ctx.roles.admin && req.ownerTeacherId) ownerId = req.ownerTeacherId;
        else if (ctx.teacher) ownerId = ctx.teacher.id;
        else Errors.raise('VALIDATION', 'กรุณาเลือกครูเจ้าของรายวิชา');
        var owner = tx.get('teachers', ownerId);
        if (!owner || owner.school_id !== ctx.schoolId) Errors.raise('NOT_FOUND', 'ไม่พบครู');
        o = tx.insert('course_offerings', {
          school_id: ctx.schoolId, course_id: course.id, term_id: term.id, section_code: section,
          display_name: displayName || (course.name_th + ' ' + section), owner_teacher_id: owner.id, status: status, calc_method: calc
        });
        Courses._insertOwnerAssignment(tx, ctx.schoolId, o.id, owner.id);
        var pol = tx.insert('grading_policy_versions', { offering_id: o.id, version_no: 1, calc_method: calc, rounding_digits: 2, rounding_mode: 'half_up', status: 'active', activated_at: tx.now, activated_by: ctx.user.id });
        Grading.DEFAULT_BANDS.forEach(function (b, i) {
          tx.insert('grade_bands', { policy_version_id: pol.id, min_score: b.min, max_score: b.max, grade_label: b.label, grade_point: b.point, sort: i + 1 });
        });
        o = tx.update('course_offerings', o.id, { active_policy_version_id: pol.id });
      }
      var id = o.id;
      tx.afterCommit(function () { Audit.log(ctx, req.id ? 'offering.update' : 'offering.create', 'course_offerings', id, { section: section }, '', id); });
      return { offeringId: o.id };
    }, { actorId: ctx.user.id });
  },

  _insertOwnerAssignment: function (tx, schoolId, offeringId, teacherId) {
    var row = { school_id: schoolId, offering_id: offeringId, teacher_id: teacherId, role: 'owner' };
    APP.OFFERING_PERMISSIONS.forEach(function (k) { row[k] = true; });
    tx.insert('teaching_assignments', row);
  },

  /** เพิ่ม/แก้/เพิกถอนครูร่วมสอนพร้อมสิทธิ์แยกรายการ (ผู้ดูแลหรือครูเจ้าของ) */
  setCoTeacher: function (ctx, req) {
    var auth = Authz.requireOffering(ctx, req.offeringId, 'can_view');
    if (!ctx.roles.admin && !auth.perms.owner) Errors.raise('FORBIDDEN');
    return Db.tx('course.coTeacher', function (tx) {
      var t = tx.get('teachers', req.teacherId);
      if (!t || t.school_id !== ctx.schoolId) Errors.raise('NOT_FOUND');
      if (t.id === auth.offering.owner_teacher_id) Errors.raise('VALIDATION', 'ครูคนนี้เป็นครูเจ้าของรายวิชาอยู่แล้ว');
      var cur = tx.find('teaching_assignments', { offering_id: auth.offering.id, teacher_id: t.id }).filter(function (x) { return !x.revoked_at && x.role === 'co_teacher'; })[0];
      if (req.revoke) {
        if (cur) tx.update('teaching_assignments', cur.id, { revoked_at: tx.now, revoked_by: ctx.user.id });
        return { ok: true };
      }
      var perms = { can_view: true };
      APP.OFFERING_PERMISSIONS.forEach(function (k) { if (k !== 'can_view') perms[k] = !!(req.perms && req.perms[k]); });
      if (cur) tx.update('teaching_assignments', cur.id, perms);
      else tx.insert('teaching_assignments', Object.assign({ school_id: ctx.schoolId, offering_id: auth.offering.id, teacher_id: t.id, role: 'co_teacher' }, perms));
      tx.afterCommit(function () { Audit.log(ctx, 'offering.coTeacher', 'teachers', t.id, perms, '', auth.offering.id); });
      return { ok: true };
    }, { actorId: ctx.user.id });
  },

  coTeachers: function (ctx, offeringId) {
    var auth = Authz.requireOffering(ctx, offeringId, 'can_view');
    return Db.find('teaching_assignments', { offering_id: auth.offering.id }).filter(function (x) { return !x.revoked_at; }).map(function (x) {
      return { teacherId: x.teacher_id, name: Courses.teacherName(x.teacher_id), role: x.role, perms: Util.pick(x, APP.OFFERING_PERMISSIONS) };
    });
  },

  // ---------------------------------------------------------------- ทะเบียนผู้เรียนของรายวิชา
  roster: function (ctx, req) {
    var auth = Authz.requireOffering(ctx, req.offeringId, 'can_view');
    var wgName = {};
    Db.find('work_group_members', { offering_id: auth.offering.id }).forEach(function (m) {
      if (m.status !== 'active') return;
      var wg = Db.get('work_groups', m.work_group_id);
      if (wg && wg.status === 'active') wgName[m.student_id] = wg.name;
    });
    var rows = Db.find('enrollments', { offering_id: auth.offering.id }).map(function (e) {
      var s = Db.get('students', e.student_id);
      if (!s) return null;
      return {
        enrollmentId: e.id, studentId: s.id, code: s.student_code, name: Registry.personName(s), classLevel: s.class_level, room: s.room,
        rollNo: s.roll_no, roomLabel: Registry.roomLabel(s.class_level, s.room), status: e.status, effectiveFrom: e.effective_from,
        effectiveTo: e.effective_to, source: e.source, workGroup: wgName[s.id] || '', _s: s
      };
    }).filter(Boolean).sort(function (a, b) { return Registry.compareStudents(a._s, b._s); });
    rows.forEach(function (r) { delete r._s; });
    return {
      offering: Courses.offeringDto(ctx, auth.offering, auth.perms),
      students: rows,
      counts: { active: rows.filter(function (r) { return r.status === 'active'; }).length, total: rows.length }
    };
  },

  /** นักเรียนในทะเบียนที่ยังไม่ได้ลงทะเบียนในรายวิชา (ข้อมูลที่จำเป็นเท่านั้น) */
  candidates: function (ctx, req) {
    var auth = Authz.requireOffering(ctx, req.offeringId, 'can_manage');
    var enrolled = {};
    Db.find('enrollments', { offering_id: auth.offering.id }).forEach(function (e) { if (e.status === 'active') enrolled[e.student_id] = true; });
    var list = Registry.listStudents(ctx, { classLevel: req.classLevel, room: req.room, q: req.q, status: 'active' });
    return {
      students: list.students.filter(function (s) { return !enrolled[s.id]; }).map(function (s) { return Util.pick(s, ['id', 'code', 'name', 'classLevel', 'room', 'rollNo', 'roomLabel']); }),
      rooms: list.rooms
    };
  },

  _history: function (tx, ctx, enrollmentId, action, from, to, reason) {
    var row = { enrollment_id: enrollmentId, action: action, from_status: from || '', to_status: to, effective_at: tx.now, reason: reason || '' };
    tx.afterCommit(function () { try { Db.append('enrollment_history', row, ctx.user.id); } catch (e) { console.error(e); } });
  },

  /** ลงทะเบียนนักเรียนที่เลือก (ไม่สร้างคะแนนย้อนหลัง) */
  enroll: function (ctx, req) {
    var auth = Authz.requireOffering(ctx, req.offeringId, 'can_manage');
    if (['closed', 'archived'].indexOf(auth.offering.status) >= 0) Errors.raise('OFFERING_CLOSED', 'รายวิชาปิดแล้ว เพิ่มนักเรียนไม่ได้');
    var ids = (req.studentIds || []).map(String).filter(function (v, i, a) { return v && a.indexOf(v) === i; });
    if (!ids.length) Errors.raise('VALIDATION', 'กรุณาเลือกนักเรียน');
    if (ids.length > 500) Errors.raise('VALIDATION', 'เลือกได้ครั้งละไม่เกิน 500 คน');
    return Db.tx('course.enroll', function (tx) {
      var out = { added: 0, reactivated: 0, skipped: 0 };
      ids.forEach(function (sid) {
        var s = tx.get('students', sid);
        if (!s || s.school_id !== ctx.schoolId) Errors.raise('NOT_FOUND', 'ไม่พบนักเรียน');
        if (s.status !== 'active') Errors.raise('VALIDATION', 'นักเรียน ' + s.student_code + ' ไม่อยู่ในสถานะกำลังศึกษา');
        var e = tx.one('enrollments', { offering_id: auth.offering.id, student_id: s.id });
        if (e && e.status === 'active') { out.skipped++; return; }
        if (e) {
          tx.update('enrollments', e.id, { status: 'active', effective_from: tx.now, effective_to: '', reason: Util.str(req.reason, 500) });
          Courses._history(tx, ctx, e.id, 'reactivate', e.status, 'active', req.reason);
          out.reactivated++;
        } else {
          var ne = tx.insert('enrollments', { school_id: ctx.schoolId, offering_id: auth.offering.id, student_id: s.id, status: 'active', effective_from: tx.now, source: 'manual' });
          Courses._history(tx, ctx, ne.id, 'enroll', '', 'active', req.reason);
          out.added++;
        }
      });
      tx.afterCommit(function () { Audit.log(ctx, 'enrollment.add', 'course_offerings', auth.offering.id, out, '', auth.offering.id); });
      return out;
    }, { actorId: ctx.user.id });
  },

  withdraw: function (ctx, req) {
    var auth = Authz.requireOffering(ctx, req.offeringId, 'can_manage');
    var reason = Util.requireStr(req.reason, 'เหตุผล', 500);
    var status = req.status === 'transferred_out' ? 'transferred_out' : 'withdrawn';
    return Db.tx('course.withdraw', function (tx) {
      var e = tx.one('enrollments', { offering_id: auth.offering.id, student_id: req.studentId });
      if (!e) Errors.raise('NOT_FOUND');
      if (e.status !== 'active') return { ok: true, unchanged: true };
      tx.update('enrollments', e.id, { status: status, effective_to: tx.now, reason: reason });
      Courses._history(tx, ctx, e.id, status === 'withdrawn' ? 'withdraw' : 'transfer_out', 'active', status, reason);
      WorkGroups.onWithdraw(tx, ctx, auth.offering.id, req.studentId);
      tx.afterCommit(function () { Audit.log(ctx, 'enrollment.' + status, 'enrollments', e.id, {}, reason, auth.offering.id); });
      return { ok: true };
    }, { actorId: ctx.user.id });
  },

  /** เปิด/ปิดรหัสเข้าร่วมรายวิชา (สร้างรหัสใหม่ได้) */
  setJoin: function (ctx, req) {
    var auth = Authz.requireOffering(ctx, req.offeringId, 'can_manage');
    return Db.tx('course.setJoin', function (tx) {
      var o = tx.get('course_offerings', auth.offering.id);
      var patch = { join_enabled: !!req.enabled };
      if (req.enabled && (!o.join_code || req.regenerate)) {
        var code, guard = 0;
        do {
          code = Util.shortCode(6);
          if (++guard > 20) Errors.raise('BUSY');
        } while (tx.find('course_offerings', { join_code: code }).length);
        patch.join_code = code;
      }
      o = tx.update('course_offerings', o.id, patch);
      tx.afterCommit(function () { Audit.log(ctx, 'offering.join', 'course_offerings', o.id, { enabled: o.join_enabled }, '', o.id); });
      return { joinEnabled: o.join_enabled, joinCode: o.join_code };
    }, { actorId: ctx.user.id });
  },

  /** นักเรียนลงทะเบียนเรียนเองด้วยรหัสเข้าร่วม */
  joinByCode: function (ctx, req) {
    Authz.requireStudent(ctx);
    var code = Util.str(req.code, 20).toUpperCase().replace(/\s+/g, '');
    if (!code) Errors.raise('JOIN_CODE_INVALID');
    var o = Db.all('course_offerings').filter(function (x) { return x.school_id === ctx.schoolId && x.join_code === code; })[0];
    if (!o || !o.join_enabled || o.status !== 'open') Errors.raise('JOIN_CODE_INVALID');
    if (ctx.student.status && ctx.student.status !== 'active') Errors.raise('FORBIDDEN');
    var r = Db.tx('course.join', function (tx) {
      var e = tx.one('enrollments', { offering_id: o.id, student_id: ctx.student.id });
      if (e && e.status === 'active') return { offeringId: o.id, already: true };
      if (e) Errors.raise('FORBIDDEN', 'ครูถอนคุณออกจากรายวิชานี้แล้ว กรุณาติดต่อครูผู้สอน');
      var ne = tx.insert('enrollments', { school_id: ctx.schoolId, offering_id: o.id, student_id: ctx.student.id, status: 'active', effective_from: tx.now, source: 'self' });
      Courses._history(tx, ctx, ne.id, 'enroll', '', 'active', 'ลงทะเบียนเองด้วยรหัสเข้าร่วม');
      return { offeringId: o.id, already: false };
    }, { actorId: ctx.user.id });
    var course = Db.get('courses', o.course_id);
    r.courseName = course ? course.course_code + ' ' + course.name_th : '';
    r.section = o.section_code;
    if (!r.already) Audit.log(ctx, 'enrollment.self', 'course_offerings', o.id, {}, '', o.id);
    return r;
  }
};
