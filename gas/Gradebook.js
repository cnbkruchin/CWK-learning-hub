/**
 * สมุดคะแนนและการให้คะแนน
 *
 * - งานเดี่ยว/สอบ/รับคะแนนอย่างเดียว: ให้คะแนนรายบุคคล (บันทึกหลายคนในครั้งเดียว)
 * - งานกลุ่ม: ครูให้คะแนนกลุ่มครั้งเดียว → คะแนนกลุ่มเก็บที่ group_grades (คะแนนกลุ่มของงานนั้นอยู่ที่กลุ่มเสมอ)
 *   แล้วระบบสร้าง/ปรับคะแนนรายบุคคล (student_grades) ของสมาชิกทุกคนใน snapshot ในธุรกรรมเดียวกัน
 *   คะแนนกลุ่มไม่ถูกหารด้วยจำนวนสมาชิก (กลุ่มได้ 16/20 ทุกคนได้ 16/20)
 * - ครูปรับคะแนนเฉพาะบุคคลพร้อมเหตุผลได้ การปรับนี้ไม่ถูกเขียนทับเมื่อแก้คะแนนกลุ่มครั้งถัดไป
 *   เว้นแต่ครูเลือกยกเลิกการปรับอย่างชัดเจน (มีหน้าตัวอย่างก่อนยืนยัน)
 * - ทุกการเปลี่ยนคะแนนสร้าง grade_revisions (ค่าก่อน/หลัง ที่มา เหตุผล ผู้แก้ เวลา)
 * - นักเรียนเห็นเฉพาะค่าที่ประกาศแล้ว (published_*) การแก้หลังประกาศต้องประกาศใหม่จึงจะเห็น
 * - ผลรวมคำนวณจาก Grading.compute (แหล่งเดียวกับรายงาน PDF/XLSX)
 */
var Gradebook = {
  STATUSES: ['not_assessed', 'scored', 'missing', 'excused', 'needs_revision'],
  STATUS_LABELS: { not_assessed: 'ยังไม่ประเมิน', scored: 'มีคะแนน', missing: 'ยังไม่ส่ง/ขาดสอบ', excused: 'ยกเว้น', needs_revision: 'รอแก้ไข' },
  SOURCE_LABELS: { '': '', teacher: 'ครูบันทึก', group: 'คะแนนกลุ่ม', import: 'นำเข้า', rubric: 'รูบริก' },

  // ---------------------------------------------------------------- นโยบายและการคำนวณ (แหล่งเดียว)
  policy: function (offering) {
    var pol = offering.active_policy_version_id ? Db.get('grading_policy_versions', offering.active_policy_version_id) : null;
    var bands = pol ? Db.find('grade_bands', { policy_version_id: pol.id }).sort(function (a, b) { return (a.sort || 0) - (b.sort || 0); })
      .map(function (b) { return { min: b.min_score, max: b.max_score, label: b.grade_label, point: b.grade_point }; }) : [];
    return {
      policyVersionId: pol ? pol.id : '', versionNo: pol ? pol.version_no : null,
      method: pol ? pol.calc_method : offering.calc_method,
      digits: pol && pol.rounding_digits !== null && pol.rounding_digits !== undefined ? Number(pol.rounding_digits) : 2,
      bands: bands.length ? bands : Grading.DEFAULT_BANDS,
      categories: Db.find('score_categories', { offering_id: offering.id }).map(function (c) {
        return { id: c.id, name: c.name, weight: c.weight, innerMode: c.inner_weight_mode || 'equal' };
      })
    };
  },

  assessmentsOf: function (offeringId) {
    return Db.find('assessments', { offering_id: offeringId }).filter(function (a) { return a.status !== 'archived'; })
      .sort(function (a, b) { return (a.sort || 0) - (b.sort || 0) || (a.created_at < b.created_at ? -1 : 1); });
  },

  items: function (assessments) {
    return assessments.map(function (a) {
      return { id: a.id, categoryId: a.category_id, max: a.max_score || '0', weight: a.weight || '0', innerWeight: a.inner_weight, counts: !!a.counts_toward_grade };
    });
  },

  compute: function (policy, items, gradeMap) {
    return Grading.compute({ method: policy.method, digits: policy.digits, bands: policy.bands, categories: policy.categories, items: items, grades: gradeMap });
  },

  cell: function (g) {
    if (!g) return { status: 'not_assessed', score: '', version: 0 };
    return {
      id: g.id, version: g.version, status: g.status, score: g.status === 'scored' ? g.final_score || g.raw_score : '',
      source: g.source, isOverride: !!g.is_override, overrideReason: g.override_reason, excuseReason: g.excuse_reason,
      groupGradeId: g.group_grade_id, publication: g.publication, publishedStatus: g.published_status, publishedScore: g.published_score,
      publishedAt: g.published_at, dirty: g.status !== 'not_assessed' && (g.publication !== 'published')
    };
  },

  /** กลุ่มของนักเรียนแต่ละคนในงานกลุ่ม (รายชื่อที่ตรึงแล้วใช้ snapshot ปัจจุบัน) */
  groupOfStudents: function (assessmentId) {
    var out = {};
    var gs = Db.one('assignment_group_sets', { assessment_id: assessmentId });
    if (!gs) return out;
    var groups = Util.indexBy(Db.find('groups', { group_set_id: gs.id }), 'id');
    Db.find('group_memberships', { group_set_id: gs.id }).forEach(function (m) {
      var g = groups[m.group_id];
      if (m.status === 'active' && g && !g.frozen_at && g.status !== 'disbanded') out[m.student_id] = { groupId: g.id, name: g.name };
    });
    Db.find('assignment_member_snapshots', { assessment_id: assessmentId }).forEach(function (s) {
      var g = groups[s.group_id];
      if (g && s.is_current && g.frozen_at && Number(s.snapshot_no) === Number(g.snapshot_no)) out[s.student_id] = { groupId: g.id, name: g.name };
    });
    return out;
  },

  /** ข้อมูลสมุดคะแนนเต็ม (ใช้ทั้งหน้าจอครูและรายงาน) */
  build: function (offering) {
    var policy = Gradebook.policy(offering);
    var assessments = Gradebook.assessmentsOf(offering.id);
    var items = Gradebook.items(assessments);
    var byKey = {};
    Db.find('student_grades', { offering_id: offering.id }).forEach(function (g) { byKey[g.enrollment_id + '|' + g.assessment_id] = g; });
    var groupMaps = {};
    var sets = Util.indexBy(Db.find('assignment_group_sets', { offering_id: offering.id }), 'assessment_id');
    assessments.forEach(function (a) { if (a.kind === 'group') groupMaps[a.id] = Gradebook.groupOfStudents(a.id); });
    var students = Db.find('enrollments', { offering_id: offering.id }).map(function (e) {
      var s = Db.get('students', e.student_id);
      if (!s) return null;
      var cells = {}, gradeMap = {};
      assessments.forEach(function (a) {
        var g = byKey[e.id + '|' + a.id];
        var c = Gradebook.cell(g);
        if (a.kind === 'group' && groupMaps[a.id][s.id]) c.groupName = groupMaps[a.id][s.id].name;
        cells[a.id] = c;
        gradeMap[a.id] = { status: c.status, score: c.score };
      });
      return {
        studentId: s.id, enrollmentId: e.id, code: s.student_code, name: Registry.personName(s), classLevel: s.class_level, room: s.room,
        roomLabel: Registry.roomLabel(s.class_level, s.room), rollNo: s.roll_no, enrollmentStatus: e.status, cells: cells,
        total: Gradebook.compute(policy, items, gradeMap), _s: s
      };
    }).filter(Boolean).sort(function (a, b) { return Registry.compareStudents(a._s, b._s); });
    students.forEach(function (r) { delete r._s; });
    var adto = assessments.map(function (a) {
      var st = { scored: 0, missing: 0, excused: 0, not_assessed: 0, needs_revision: 0, unpublished: 0 };
      students.forEach(function (r) {
        if (r.enrollmentStatus !== 'active') return;
        var c = r.cells[a.id];
        st[c.status] = (st[c.status] || 0) + 1;
        if (c.dirty) st.unpublished++;
      });
      return {
        id: a.id, code: a.code, title: a.title, kind: a.kind, maxScore: a.max_score, weight: a.weight || '0', countsTowardGrade: !!a.counts_toward_grade,
        categoryId: a.category_id, status: a.status, groupSource: a.kind === 'group' && sets[a.id] ? (sets[a.id].source || 'self') : '', stats: st
      };
    });
    return { policy: policy, assessments: adto, students: students };
  },

  sheet: function (ctx, offeringId) {
    var auth = Authz.requireOffering(ctx, offeringId, 'can_view');
    var data = Gradebook.build(auth.offering);
    data.offering = Courses.offeringDto(ctx, auth.offering, auth.perms);
    data.perms = Util.pick(auth.perms, APP.OFFERING_PERMISSIONS);
    data.statusLabels = Gradebook.STATUS_LABELS;
    return data;
  },

  // ---------------------------------------------------------------- บันทึกคะแนน
  _checkValue: function (a, status, score) {
    if (Gradebook.STATUSES.indexOf(status) < 0) Errors.raise('VALIDATION', 'สถานะคะแนนไม่ถูกต้อง');
    if (status !== 'scored') return '';
    if (!Dec.isValid(score)) Errors.raise('VALIDATION', 'คะแนนต้องเป็นตัวเลข (ช่องว่างไม่ถือเป็นศูนย์)');
    var v = Dec.normalize(score);
    var R = Dec.R;
    if (R.cmp(R.of(v), R.zero()) < 0) Errors.raise('VALIDATION', 'คะแนนติดลบไม่ได้');
    if (R.cmp(R.of(v), R.of(a.max_score || '0')) > 0) Errors.raise('VALIDATION', 'คะแนน ' + v + ' เกินคะแนนเต็ม ' + a.max_score);
    return v;
  },

  _expect: function (row, expected, details) {
    if (expected === undefined || expected === null || expected === '') return;
    if (Number(row ? row.version : 0) !== Number(expected)) Errors.raise('CONFLICT', 'คะแนนนี้ถูกแก้ไขโดยผู้อื่นแล้ว กรุณาโหลดข้อมูลล่าสุด', details || null);
  },

  _openForGrading: function (offering) {
    if (offering.status === 'closed' || offering.status === 'archived') Errors.raise('OFFERING_CLOSED');
  },

  /**
   * เขียนคะแนนรายบุคคล + ประวัติ (ในธุรกรรม) คืน { changed, grade }
   * next: { status, score, source, sourceRef, groupGradeId, isOverride, overrideReason, excuseReason, gradedVersionId, reason }
   */
  _write: function (tx, offering, assessment, enrollment, current, next) {
    var score = next.status === 'scored' ? next.score : '';
    var prev = current ? { status: current.status, score: current.raw_score } : { status: 'not_assessed', score: '' };
    var same = current && current.status === next.status && String(current.raw_score || '') === String(score || '') &&
      (next.isOverride === undefined || !!current.is_override === !!next.isOverride) &&
      (next.groupGradeId === undefined || String(current.group_grade_id || '') === String(next.groupGradeId || '')) &&
      (next.excuseReason === undefined || String(current.excuse_reason || '') === String(next.excuseReason || ''));
    if (same) return { changed: false, grade: current };
    var patch = {
      status: next.status, raw_score: score, final_score: score, late_penalty: '', source: next.source || 'teacher',
      source_ref: next.sourceRef || '', publication: 'draft'
    };
    if (next.groupGradeId !== undefined) patch.group_grade_id = next.groupGradeId || '';
    if (next.isOverride !== undefined) { patch.is_override = !!next.isOverride; patch.override_reason = next.isOverride ? (next.overrideReason || '') : ''; }
    if (next.excuseReason !== undefined) patch.excuse_reason = next.status === 'excused' ? next.excuseReason : '';
    if (next.gradedVersionId !== undefined) patch.graded_version_id = next.gradedVersionId || '';
    var g;
    if (current) g = tx.update('student_grades', current.id, patch);
    else {
      g = tx.insert('student_grades', Object.assign({
        offering_id: offering.id, assessment_id: assessment.id, enrollment_id: enrollment.id, student_id: enrollment.student_id
      }, patch));
    }
    tx.insert('grade_revisions', {
      student_grade_id: g.id, revision_no: g.version, from_status: prev.status, from_score: prev.score || '',
      to_status: g.status, to_score: g.raw_score || '', source: patch.source, source_ref: patch.source_ref, reason: next.reason || ''
    });
    return { changed: true, grade: g };
  },

  /** ให้คะแนนรายบุคคล (งานเดี่ยว สอบ รับคะแนนอย่างเดียว) หลายคนในธุรกรรมเดียว */
  saveScores: function (ctx, req) {
    var a = Db.get('assessments', req.assessmentId);
    if (!a) Errors.raise('NOT_FOUND');
    var auth = Authz.requireOffering(ctx, a.offering_id, 'can_grade');
    Gradebook._openForGrading(auth.offering);
    if (a.kind === 'group') Errors.raise('VALIDATION', 'งานกลุ่มให้คะแนนที่กลุ่ม หรือปรับรายคนพร้อมเหตุผล');
    var entries = req.entries || [];
    if (!entries.length) Errors.raise('VALIDATION', 'ไม่มีคะแนนที่จะบันทึก');
    if (entries.length > 500) Errors.raise('VALIDATION', 'บันทึกได้ครั้งละไม่เกิน 500 รายการ');
    var clean = entries.map(function (e) {
      var status = e.status || 'scored';
      var reason = Util.str(e.reason, 1000, 'เหตุผล');
      if (status === 'excused' && !reason) Errors.raise('VALIDATION', 'การยกเว้นต้องระบุเหตุผล');
      return { studentId: String(e.studentId || ''), status: status, score: Gradebook._checkValue(a, status, e.score), reason: reason, expectedVersion: e.expectedVersion };
    });
    var out = Db.tx('grades.save', function (tx) {
      var res = { saved: 0, unchanged: 0, grades: [] };
      clean.forEach(function (e) {
        var enr = tx.one('enrollments', { offering_id: a.offering_id, student_id: e.studentId });
        if (!enr) Errors.raise('NOT_FOUND', 'นักเรียนไม่ได้ลงทะเบียนในรายวิชานี้');
        var g = tx.one('student_grades', { assessment_id: a.id, enrollment_id: enr.id });
        if (!g && enr.status !== 'active') Errors.raise('VALIDATION', 'นักเรียนถอน/ย้ายออกจากรายวิชาแล้ว');
        Gradebook._expect(g, e.expectedVersion, { studentId: e.studentId });
        if (g && g.status === 'scored' && !auth.perms.can_edit_scores && (e.status !== 'scored' || String(e.score) !== String(g.raw_score))) {
          Errors.raise('FORBIDDEN', 'แก้คะแนนที่บันทึกแล้วต้องมีสิทธิ์ "แก้คะแนน"');
        }
        var r = Gradebook._write(tx, auth.offering, a, enr, g, {
          status: e.status, score: e.score, source: 'teacher', isOverride: false, excuseReason: e.status === 'excused' ? e.reason : '', reason: e.reason
        });
        if (r.changed) res.saved++; else res.unchanged++;
        res.grades.push({ studentId: e.studentId, version: r.grade.version, status: r.grade.status, score: r.grade.raw_score });
      });
      tx.afterCommit(function () { Audit.log(ctx, 'grade.save', 'assessments', a.id, { saved: res.saved }, '', a.offering_id); });
      return res;
    }, { actorId: ctx.user.id });
    return out;
  },

  // ---------------------------------------------------------------- คะแนนกลุ่ม
  groupSheet: function (ctx, assessmentId) {
    var a = Db.get('assessments', assessmentId);
    if (!a || a.kind !== 'group') Errors.raise('NOT_FOUND');
    var auth = Authz.requireOffering(ctx, a.offering_id, 'can_view');
    var gs = Db.one('assignment_group_sets', { assessment_id: a.id });
    var ggs = Util.indexBy(Db.find('group_grades', { assessment_id: a.id }), 'group_id');
    var enrolls = Util.indexBy(Db.find('enrollments', { offering_id: a.offering_id }), 'student_id');
    var grades = {};
    Db.find('student_grades', { assessment_id: a.id }).forEach(function (g) { grades[g.enrollment_id] = g; });
    var subs = Util.indexBy(Db.find('submissions', { assessment_id: a.id }).filter(function (s) { return s.owner_type === 'group'; }), 'owner_id');
    var covered = {};
    var groups = (gs ? Db.find('groups', { group_set_id: gs.id }) : []).filter(function (g) { return g.status !== 'disbanded' || g.frozen_at; })
      .sort(function (x, y) { return String(x.name).localeCompare(String(y.name), 'th', { numeric: true }); })
      .map(function (g) {
        var gg = ggs[g.id];
        var members = Groups.memberNames(g).map(function (m) {
          covered[m.studentId] = true;
          var enr = enrolls[m.studentId];
          var c = Gradebook.cell(enr ? grades[enr.id] : null);
          var state = !enr ? 'not_enrolled' : c.isOverride ? 'override' :
            (gg && c.groupGradeId === gg.id && c.status === gg.status && String(c.score || '') === String(gg.status === 'scored' ? gg.raw_score : '')) ? 'synced' :
              (gg ? 'pending' : 'none');
          return Object.assign(m, { grade: c, state: state, enrollmentStatus: enr ? enr.status : '' });
        });
        var sub = subs[g.id];
        return {
          id: g.id, name: g.name, frozen: !!g.frozen_at, snapshotNo: g.snapshot_no, members: members, workGroupId: g.work_group_id,
          groupGrade: gg ? { id: gg.id, version: gg.version, status: gg.status, score: gg.status === 'scored' ? gg.raw_score : '', note: gg.note, snapshotNo: gg.snapshot_no } : null,
          submission: sub ? { versionNo: sub.current_version_no, status: sub.status, statusLabel: Submission.STATUS_LABELS[sub.status] || sub.status } : null
        };
      });
    var ungrouped = Object.keys(enrolls).filter(function (sid) { return enrolls[sid].status === 'active' && !covered[sid]; }).map(function (sid) {
      var s = Db.get('students', sid);
      return { studentId: sid, studentCode: s.student_code, name: Registry.personName(s), room: s.room, grade: Gradebook.cell(grades[enrolls[sid].id]) };
    });
    return {
      assessment: { id: a.id, code: a.code, title: a.title, maxScore: a.max_score, weight: a.weight || '0', source: gs ? gs.source || 'self' : 'self' },
      offering: Courses.offeringDto(ctx, auth.offering, auth.perms),
      groups: groups, ungrouped: ungrouped,
      perms: Util.pick(auth.perms, APP.OFFERING_PERMISSIONS)
    };
  },

  /**
   * ให้คะแนนกลุ่ม: บันทึก group_grades + กระจายคะแนนให้สมาชิกใน snapshot ทุกคนในธุรกรรมเดียว (ครบทุกคนหรือไม่บันทึกเลย)
   * req: { assessmentId, groupId, status, score, note, expectedVersion, preview, clearOverrides: [studentId] | true }
   */
  saveGroup: function (ctx, req) {
    var a = Db.get('assessments', req.assessmentId);
    if (!a || a.kind !== 'group') Errors.raise('NOT_FOUND');
    var auth = Authz.requireOffering(ctx, a.offering_id, 'can_grade');
    Gradebook._openForGrading(auth.offering);
    var status = req.status || 'scored';
    var score = Gradebook._checkValue(a, status, req.score);
    var note = Util.str(req.note, 2000, 'หมายเหตุ');
    var clearAll = req.clearOverrides === true;
    var clearIds = Array.isArray(req.clearOverrides) ? req.clearOverrides.map(String) : [];
    var shouldClear = function (sid) { return clearAll || clearIds.indexOf(sid) >= 0; };

    var plan = function (finder, g, gg) {
      var memberIds = g.frozen_at ? finder.find('assignment_member_snapshots', { group_id: g.id, snapshot_no: g.snapshot_no }).map(function (m) { return m.student_id; })
        : finder.find('group_memberships', { group_id: g.id, status: 'active' }).map(function (m) { return m.student_id; });
      return memberIds.map(function (sid) {
        var s = finder.get('students', sid);
        var enr = finder.one('enrollments', { offering_id: a.offering_id, student_id: sid });
        var cur = enr ? finder.one('student_grades', { assessment_id: a.id, enrollment_id: enr.id }) : null;
        var before = cur ? { status: cur.status, score: cur.status === 'scored' ? cur.raw_score : '', isOverride: !!cur.is_override, reason: cur.override_reason } : { status: 'not_assessed', score: '' };
        var action = !enr ? 'skip_not_enrolled' : (cur && cur.is_override && !shouldClear(sid)) ? 'keep_override' : 'apply';
        return {
          studentId: sid, studentCode: s ? s.student_code : '', name: Registry.personName(s), enrollment: enr, current: cur, before: before, action: action,
          after: action === 'apply' ? { status: status, score: score } : before
        };
      });
    };
    var publicPlan = function (rows) {
      return rows.map(function (r) { return { studentId: r.studentId, studentCode: r.studentCode, name: r.name, action: r.action, before: r.before, after: r.after }; });
    };

    if (req.preview) {
      var g0 = Db.get('groups', req.groupId);
      if (!g0 || g0.assessment_id !== a.id) Errors.raise('NOT_FOUND');
      var gg0 = Db.one('group_grades', { assessment_id: a.id, group_id: g0.id });
      var rows0 = plan(Db, g0, gg0);
      return {
        preview: true, groupName: g0.name, willFreeze: !g0.frozen_at,
        before: gg0 ? { status: gg0.status, score: gg0.raw_score } : null, after: { status: status, score: score },
        members: publicPlan(rows0), overrides: rows0.filter(function (r) { return r.current && r.current.is_override; }).length
      };
    }

    return Db.tx('grades.group', function (tx) {
      var g = tx.get('groups', req.groupId);
      if (!g || g.assessment_id !== a.id || (g.status === 'disbanded' && !g.frozen_at)) Errors.raise('NOT_FOUND');
      if (!g.frozen_at) {
        if (!tx.find('group_memberships', { group_id: g.id, status: 'active' }).length) Errors.raise('VALIDATION', 'กลุ่มนี้ยังไม่มีสมาชิก');
        Groups.freeze(tx, g, 'teacher', 'ครูให้คะแนนกลุ่ม', ctx);
        g = tx.get('groups', g.id);
      }
      var gg = tx.one('group_grades', { assessment_id: a.id, group_id: g.id });
      Gradebook._expect(gg, req.expectedVersion, { groupId: g.id });
      if (gg && gg.status === 'scored' && !auth.perms.can_edit_scores && (status !== 'scored' || score !== gg.raw_score)) {
        Errors.raise('FORBIDDEN', 'แก้คะแนนที่บันทึกแล้วต้องมีสิทธิ์ "แก้คะแนน"');
      }
      var sub = tx.one('submissions', { assessment_id: a.id, owner_type: 'group', owner_id: g.id });
      var ggData = { snapshot_no: g.snapshot_no, raw_score: score, status: status, note: note, submission_version_id: sub ? (sub.accepted_version_id || sub.latest_version_id || '') : '' };
      gg = gg ? tx.update('group_grades', gg.id, ggData) : tx.insert('group_grades', Object.assign({ assessment_id: a.id, group_id: g.id }, ggData));
      var rows = plan(tx, g, gg);
      var res = { applied: 0, kept: 0, skipped: 0, unchanged: 0 };
      rows.forEach(function (r) {
        if (r.action === 'skip_not_enrolled') { res.skipped++; return; }
        if (r.action === 'keep_override') { res.kept++; return; }
        var w = Gradebook._write(tx, auth.offering, a, r.enrollment, r.current, {
          status: status, score: score, source: 'group', sourceRef: gg.id, groupGradeId: gg.id, isOverride: false,
          excuseReason: status === 'excused' ? (note || 'ยกเว้นทั้งกลุ่ม') : '',
          gradedVersionId: ggData.submission_version_id, reason: r.current && r.current.is_override ? 'ยกเลิกการปรับรายคน ใช้คะแนนกลุ่ม' : (note || 'คะแนนกลุ่ม')
        });
        if (w.changed) res.applied++; else res.unchanged++;
      });
      var ggId = gg.id, ggVersion = gg.version;
      tx.afterCommit(function () {
        Audit.log(ctx, 'grade.group', 'group_grades', ggId, { groupId: g.id, status: status, score: score, applied: res.applied, kept: res.kept }, note, a.offering_id);
      });
      return Object.assign(res, { groupGradeId: ggId, version: ggVersion, members: publicPlan(rows) });
    }, { actorId: ctx.user.id });
  },

  /** ปรับคะแนนรายคนจากคะแนนกลุ่ม (ต้องมีเหตุผล) หรือยกเลิกการปรับ (clear=true) เพื่อกลับไปใช้คะแนนกลุ่ม */
  override: function (ctx, req) {
    var a = Db.get('assessments', req.assessmentId);
    if (!a || a.kind !== 'group') Errors.raise('NOT_FOUND');
    var auth = Authz.requireOffering(ctx, a.offering_id, 'can_grade');
    Gradebook._openForGrading(auth.offering);
    var reason = Util.requireStr(req.reason, 'เหตุผลหรือหลักฐานการมีส่วนร่วม', 1000);
    var status = req.clear ? '' : (req.status || 'scored');
    var score = req.clear ? '' : Gradebook._checkValue(a, status, req.score);
    return Db.tx('grades.override', function (tx) {
      var enr = tx.one('enrollments', { offering_id: a.offering_id, student_id: req.studentId });
      if (!enr) Errors.raise('NOT_FOUND', 'นักเรียนไม่ได้ลงทะเบียนในรายวิชานี้');
      var cur = tx.one('student_grades', { assessment_id: a.id, enrollment_id: enr.id });
      Gradebook._expect(cur, req.expectedVersion, { studentId: req.studentId });
      if (cur && cur.status === 'scored' && !auth.perms.can_edit_scores) Errors.raise('FORBIDDEN', 'แก้คะแนนที่บันทึกแล้วต้องมีสิทธิ์ "แก้คะแนน"');
      var snap = tx.find('assignment_member_snapshots', { assessment_id: a.id }).filter(function (m) {
        if (m.student_id !== req.studentId || !m.is_current) return false;
        var g = tx.get('groups', m.group_id);
        return g && Number(g.snapshot_no) === Number(m.snapshot_no);
      })[0];
      var groupId = snap ? snap.group_id : '';
      if (!groupId) {
        var gs = tx.one('assignment_group_sets', { assessment_id: a.id });
        var mem = gs ? tx.find('group_memberships', { group_set_id: gs.id, student_id: req.studentId, status: 'active' })[0] : null;
        groupId = mem ? mem.group_id : '';
      }
      var gg = groupId ? tx.one('group_grades', { assessment_id: a.id, group_id: groupId }) : null;
      var w;
      if (req.clear) {
        if (!gg) Errors.raise('VALIDATION', 'กลุ่มของนักเรียนยังไม่มีคะแนนกลุ่ม');
        w = Gradebook._write(tx, auth.offering, a, enr, cur, {
          status: gg.status, score: gg.status === 'scored' ? gg.raw_score : '', source: 'group', sourceRef: gg.id, groupGradeId: gg.id,
          isOverride: false, reason: 'ยกเลิกการปรับรายคน: ' + reason
        });
      } else {
        w = Gradebook._write(tx, auth.offering, a, enr, cur, {
          status: status, score: score, source: 'teacher', sourceRef: gg ? gg.id : '', groupGradeId: gg ? gg.id : '',
          isOverride: true, overrideReason: reason, excuseReason: status === 'excused' ? reason : '', reason: reason
        });
      }
      var g = w.grade;
      tx.afterCommit(function () { Audit.log(ctx, req.clear ? 'grade.override.clear' : 'grade.override', 'student_grades', g.id, { status: g.status, score: g.raw_score }, reason, a.offering_id); });
      return { changed: w.changed, grade: Gradebook.cell(g) };
    }, { actorId: ctx.user.id });
  },

  // ---------------------------------------------------------------- ประกาศคะแนน
  publish: function (ctx, req) {
    var a = Db.get('assessments', req.assessmentId);
    if (!a) Errors.raise('NOT_FOUND');
    var auth = Authz.requireOffering(ctx, a.offering_id, 'can_publish');
    var unpublish = req.action === 'unpublish';
    var reason = Util.str(req.reason, 1000, 'เหตุผล');
    if (unpublish && !reason) Errors.raise('VALIDATION', 'การเรียกคืนการประกาศต้องระบุเหตุผล');
    var users = [];
    var res = Db.tx('grades.publish', function (tx) {
      var n = 0;
      tx.find('student_grades', { assessment_id: a.id }).forEach(function (g) {
        if (unpublish) {
          if (!g.published_at) return;
          tx.update('student_grades', g.id, { publication: 'draft', published_at: '', published_score: '', published_status: '' });
        } else if (g.status === 'not_assessed') {
          if (!g.published_at) return;
          tx.update('student_grades', g.id, { publication: 'published', published_at: '', published_score: '', published_status: '' });
        } else {
          var val = g.status === 'scored' ? (g.final_score || g.raw_score) : '';
          if (g.publication === 'published' && g.published_status === g.status && String(g.published_score || '') === String(val || '') && g.published_at) return;
          tx.update('student_grades', g.id, { publication: 'published', published_at: tx.now, published_status: g.status, published_score: val });
          var s = tx.get('students', g.student_id);
          if (s && s.user_id) users.push(s.user_id);
        }
        n++;
      });
      return { changed: n };
    }, { actorId: ctx.user.id });
    Db.append('grade_publications', { offering_id: a.offering_id, assessment_id: a.id, action: unpublish ? 'unpublish' : 'publish', student_count: res.changed, reason: reason }, ctx.user.id);
    Audit.log(ctx, unpublish ? 'grade.unpublish' : 'grade.publish', 'assessments', a.id, { count: res.changed }, reason, a.offering_id);
    if (!unpublish && users.length) Notify.sendMany(users, 'grade', 'ประกาศคะแนนแล้ว: ' + a.title, 'เปิดรายวิชาเพื่อดูคะแนนของคุณ', 'assessment:' + a.id);
    return res;
  },

  history: function (ctx, req) {
    var g = Db.get('student_grades', req.studentGradeId);
    if (!g) Errors.raise('NOT_FOUND');
    Authz.requireOffering(ctx, g.offering_id, 'can_view');
    return Db.find('grade_revisions', { student_grade_id: g.id }).sort(function (x, y) { return x.revision_no - y.revision_no; }).map(function (r) {
      var u = Db.get('users', r.created_by);
      return {
        revisionNo: r.revision_no, at: r.created_at, by: u ? u.display_name || u.username : '', fromStatus: r.from_status, fromScore: r.from_score,
        toStatus: r.to_status, toScore: r.to_score, source: r.source, sourceLabel: Gradebook.SOURCE_LABELS[r.source] || r.source, reason: r.reason
      };
    });
  },

  // ---------------------------------------------------------------- นักเรียน
  /** คะแนนของฉันในรายวิชา (เฉพาะค่าที่ประกาศแล้ว) พร้อมคะแนนสะสม */
  mine: function (ctx, offeringId) {
    var e = Authz.requireEnrollment(ctx, offeringId, false);
    var o = e.offering;
    var policy = Gradebook.policy(o);
    var assessments = Gradebook.assessmentsOf(o.id);
    var mine = {};
    Db.find('student_grades', { student_id: ctx.student.id }).forEach(function (g) { if (g.enrollment_id === e.enrollment.id) mine[g.assessment_id] = g; });
    var gradeMap = {};
    var hidden = 0;
    var list = [];
    assessments.forEach(function (a) {
      var g = mine[a.id];
      var pub = g && g.published_at ? { status: g.published_status, score: g.published_score } : null;
      gradeMap[a.id] = pub ? { status: pub.status, score: pub.score } : { status: 'not_assessed' };
      if (a.status !== 'published') { if (a.counts_toward_grade) hidden++; return; }
      list.push({
        id: a.id, code: a.code, title: a.title, kind: a.kind, maxScore: a.max_score, weight: a.weight || '0', countsTowardGrade: !!a.counts_toward_grade,
        status: pub ? pub.status : 'not_published', statusLabel: pub ? Gradebook.STATUS_LABELS[pub.status] : 'ยังไม่ประกาศ',
        score: pub && pub.status === 'scored' ? pub.score : null,
        weighted: pub && pub.status === 'scored' && a.counts_toward_grade && Number(a.weight) > 0 ? Grading.weighted(pub.score, a.max_score, a.weight, policy.digits) : null,
        publishedAt: g && g.published_at ? g.published_at : ''
      });
    });
    var total = Gradebook.compute(policy, Gradebook.items(assessments), gradeMap);
    total.blockers = total.blockers.length; // ไม่เปิดเผยรหัสรายการที่ยังไม่ประกาศ
    return {
      method: policy.method, items: list, total: total, hiddenItems: hidden,
      note: total.status === 'complete' ? '' : 'คะแนนสะสมจากรายการที่ครูประกาศแล้วบนฐานเต็ม 100 (ยังไม่ใช่ผลสุดท้าย)'
    };
  }
};
