/**
 * งานของครู: รายวิชาที่สอน รายการภาระงาน สร้าง/แก้ภาระงาน ขยายเวลา
 */
var Teaching = {
  myOfferings: function (ctx) {
    if (!ctx.teacher && !ctx.roles.admin) Errors.raise('FORBIDDEN');
    var offerings = Db.all('course_offerings').filter(function (o) { return o.school_id === ctx.schoolId && o.status !== 'archived'; });
    return offerings.map(function (o) {
      var p = Authz.offeringPerms(ctx, o);
      if (!p.can_view) return null;
      var info = Files._offeringPath(o);
      var course = Db.get('courses', o.course_id);
      return {
        offeringId: o.id, courseCode: course && course.course_code, courseName: course && course.name_th, section: o.section_code,
        yearBe: info.yearBe, termNo: info.termNo, status: o.status, calcMethod: o.calc_method,
        isOwner: p.owner, perms: Util.pick(p, APP.OFFERING_PERMISSIONS),
        students: Db.find('enrollments', { offering_id: o.id }).filter(function (e) { return e.status === 'active'; }).length
      };
    }).filter(Boolean);
  },

  assessments: function (ctx, offeringId) {
    var auth = Authz.requireOffering(ctx, offeringId, 'can_view');
    var sets = Util.indexBy(Db.find('assignment_group_sets', { offering_id: offeringId }), 'assessment_id');
    return {
      offering: { id: auth.offering.id, status: auth.offering.status, calcMethod: auth.offering.calc_method, section: auth.offering.section_code, path: Files._offeringPath(auth.offering) },
      perms: Util.pick(auth.perms, APP.OFFERING_PERMISSIONS),
      categories: Db.find('score_categories', { offering_id: offeringId }).map(function (c) { return { id: c.id, name: c.name, weight: c.weight }; }),
      schoolLimits: Teaching._schoolLimits(ctx),
      items: Db.find('assessments', { offering_id: offeringId }).filter(function (a) { return a.status !== 'archived'; })
        .sort(function (a, b) { return (a.sort || 0) - (b.sort || 0) || (a.created_at < b.created_at ? -1 : 1); })
        .map(function (a) { return Teaching.assessmentDto(a, sets[a.id]); })
    };
  },

  _schoolLimits: function (ctx) {
    var s = Settings.get(ctx.schoolId);
    return { allowedTypes: Util.csvList(s.allowed_file_types), maxFileMb: s.max_file_mb, maxFiles: s.max_files_per_submission };
  },

  assessmentDto: function (a, gs) {
    return {
      id: a.id, version: a.version, code: a.code, title: a.title, description: a.description, kind: a.kind,
      submissionMode: a.submission_mode, categoryId: a.category_id, maxScore: a.max_score, weight: a.weight,
      innerWeight: a.inner_weight, countsTowardGrade: a.counts_toward_grade,
      openAt: a.open_at, dueAt: a.due_at, closeAt: a.close_at, allowLate: a.allow_late,
      allowedTypes: a.allowed_types, maxFiles: a.max_files, maxFileMb: a.max_file_mb, maxAttempts: a.max_attempts,
      allowLinks: a.allow_links, groupSubmitPolicy: a.group_submit_policy, status: a.status,
      group: gs ? { minSize: gs.min_size, maxSize: gs.max_size, formationCloseAt: gs.formation_close_at, requireApproval: gs.require_approval, source: gs.source || 'self' } : null
    };
  },

  /** สร้าง/แก้ภาระงาน (ตรวจเงื่อนไขทั้งหมดที่เซิร์ฟเวอร์) */
  saveAssessment: function (ctx, req) {
    var auth = Authz.requireOffering(ctx, req.offeringId, 'can_manage');
    if (auth.offering.status === 'closed' || auth.offering.status === 'archived') Errors.raise('VALIDATION', 'รายวิชาปิดผลแล้ว แก้ภาระงานไม่ได้');
    var limits = Teaching._schoolLimits(ctx);
    var kind = req.kind;
    if (['individual', 'group', 'exam', 'score_only'].indexOf(kind) < 0) Errors.raise('VALIDATION', 'ประเภทงานไม่ถูกต้อง');
    var mode = kind === 'exam' || kind === 'score_only' ? 'none' : (req.allowLinks ? 'file_or_link' : 'file');
    var counts = req.countsTowardGrade !== false;
    var maxScore = Dec.isValid(req.maxScore) ? Dec.normalize(req.maxScore) : '';
    var weight = req.weight === '' || req.weight === undefined || req.weight === null ? '0' : req.weight;
    if (!Dec.isValid(weight) || Number(weight) < 0) Errors.raise('VALIDATION', 'น้ำหนักต้องเป็นตัวเลขไม่ติดลบ');
    weight = Dec.normalize(weight);
    if (counts && (!maxScore || Number(maxScore) <= 0)) Errors.raise('VALIDATION', 'รายการที่นับคะแนนต้องมีคะแนนเต็มมากกว่า 0');
    if (counts && auth.offering.calc_method === 'per_item' && Number(weight) <= 0) Errors.raise('VALIDATION', 'รายการที่นับคะแนนต้องมีน้ำหนักเป็นบวก (งานฝึกให้เลือก "ไม่นับคะแนน")');
    if (!counts) weight = '0';
    var open = req.openAt ? Util.toIso(req.openAt) : '';
    var due = req.dueAt ? Util.toIso(req.dueAt) : '';
    var close = req.closeAt ? Util.toIso(req.closeAt) : '';
    if (open && due && open > due) Errors.raise('VALIDATION', 'วันเปิดรับต้องไม่หลังกำหนดส่ง');
    if (due && close && close < due) Errors.raise('VALIDATION', 'วันปิดรับต้องไม่ก่อนกำหนดส่ง');
    var types = req.allowedTypes ? Util.csvList(req.allowedTypes) : [];
    types.forEach(function (t) { if (limits.allowedTypes.indexOf(t) < 0) Errors.raise('VALIDATION', 'ชนิดไฟล์ .' + t + ' ไม่อยู่ในรายการที่โรงเรียนอนุญาต'); });
    var maxFiles = req.maxFiles ? Number(req.maxFiles) : '';
    if (maxFiles !== '' && (!(maxFiles >= 1) || maxFiles > limits.maxFiles)) Errors.raise('VALIDATION', 'จำนวนไฟล์ต้องอยู่ระหว่าง 1–' + limits.maxFiles);
    var maxMb = req.maxFileMb ? Number(req.maxFileMb) : '';
    if (maxMb !== '' && (!(maxMb >= 1) || maxMb > limits.maxFileMb)) Errors.raise('VALIDATION', 'ขนาดไฟล์ต้องไม่เกิน ' + limits.maxFileMb + ' MB (เพดานของโรงเรียน)');
    var attempts = Number(req.maxAttempts || 0);
    if (!(attempts >= 0) || Math.floor(attempts) !== attempts) Errors.raise('VALIDATION', 'จำนวนครั้งที่ส่งได้ไม่ถูกต้อง');
    var group = null;
    if (kind === 'group') {
      var g = req.group || {};
      var min = Number(g.minSize), max = Number(g.maxSize);
      if (!(min >= 1) || !(max >= min) || max > 50 || Math.floor(min) !== min || Math.floor(max) !== max) Errors.raise('VALIDATION', 'จำนวนสมาชิกกลุ่มไม่ถูกต้อง');
      var source = g.source === 'work_groups' ? 'work_groups' : 'self';
      group = {
        min_size: min, max_size: max, formation_close_at: g.formationCloseAt ? Util.toIso(g.formationCloseAt) : '',
        require_approval: source === 'self' && !!g.requireApproval, source: source
      };
    }
    var data = {
      offering_id: auth.offering.id, category_id: req.categoryId || '', code: Util.requireStr(req.code, 'รหัสงาน', 30),
      title: Util.requireStr(req.title, 'ชื่องาน', 200), description: Util.str(req.description, 10000),
      kind: kind, submission_mode: mode, max_score: maxScore, weight: weight,
      inner_weight: req.innerWeight ? Dec.normalize(req.innerWeight) : '', counts_toward_grade: counts,
      open_at: open, due_at: due, close_at: close, allow_late: !!req.allowLate,
      allowed_types: types.join(','), max_files: maxFiles, max_file_mb: maxMb, max_attempts: attempts,
      allow_links: !!req.allowLinks, group_submit_policy: req.groupSubmitPolicy === 'leader_only' ? 'leader_only' : 'any_member'
    };
    // ไม่ส่ง status มา = คงสถานะเดิม (งานใหม่เริ่มเป็นฉบับร่าง)
    if (req.status !== undefined) data.status = req.status === 'published' ? 'published' : 'draft';
    else if (!req.id) data.status = 'draft';
    if (data.category_id) {
      var cat = Db.get('score_categories', data.category_id);
      if (!cat || cat.offering_id !== auth.offering.id) Errors.raise('VALIDATION', 'หมวดคะแนนไม่ถูกต้อง');
    }
    return Db.tx('assessment.save', function (tx) {
      var a;
      if (req.id) {
        var cur = tx.get('assessments', req.id);
        if (!cur || cur.offering_id !== auth.offering.id) Errors.raise('NOT_FOUND');
        var hasSubs = tx.find('submissions', { assessment_id: cur.id }).some(function (s) { return s.current_version_no > 0; });
        if (hasSubs && cur.kind !== kind) Errors.raise('VALIDATION', 'มีการส่งงานแล้ว เปลี่ยนประเภทงานไม่ได้');
        var scored = tx.find('student_grades', { assessment_id: cur.id }).some(function (g2) { return g2.status === 'scored'; });
        if (scored && (Dec.normalize(cur.max_score) !== maxScore || Dec.normalize(cur.weight || '0') !== weight || cur.counts_toward_grade !== counts)) {
          Errors.raise('VALIDATION', 'มีคะแนนแล้ว การเปลี่ยนคะแนนเต็ม/น้ำหนักต้องทำผ่านการสร้างรุ่นนโยบายคะแนนใหม่พร้อมเหตุผล');
        }
        a = tx.update('assessments', cur.id, data, { expectedVersion: req.version });
      } else {
        data.sort = tx.find('assessments', { offering_id: auth.offering.id }).length + 1;
        a = tx.insert('assessments', data);
      }
      var gs = tx.one('assignment_group_sets', { assessment_id: a.id });
      if (group) {
        if (gs) {
          var biggest = tx.find('groups', { group_set_id: gs.id }).reduce(function (m, x) { return Math.max(m, x.status === 'disbanded' ? 0 : Number(x.active_count || 0)); }, 0);
          if (group.source === 'self' && biggest > group.max_size) Errors.raise('VALIDATION', 'มีกลุ่มที่มีสมาชิก ' + biggest + ' คน มากกว่าจำนวนสูงสุดใหม่');
          if ((gs.source || 'self') !== group.source) {
            var formed = tx.find('groups', { group_set_id: gs.id }).some(function (x) { return x.status !== 'disbanded' && (x.frozen_at || Number(x.active_count || 0) > 0); });
            if (formed && group.source === 'work_groups') Errors.raise('VALIDATION', 'นักเรียนจัดกลุ่มเฉพาะงานนี้ไว้แล้ว เปลี่ยนไปใช้กลุ่มประจำรายวิชาไม่ได้');
          }
          tx.update('assignment_group_sets', gs.id, group);
        } else {
          tx.insert('assignment_group_sets', Object.assign({ offering_id: auth.offering.id, assessment_id: a.id, section_restricted: true }, group));
        }
        if (group.source === 'work_groups') WorkGroups.syncOffering(tx, auth.offering.id, null, ctx);
      }
      tx.afterCommit(function () { Audit.log(ctx, req.id ? 'assessment.update' : 'assessment.create', 'assessments', a.id, { code: a.code, status: a.status }, '', auth.offering.id); });
      return Teaching.assessmentDto(a, group ? tx.one('assignment_group_sets', { assessment_id: a.id }) : null);
    }, { actorId: ctx.user.id });
  },

  grantExtension: function (ctx, req) {
    var a = Db.get('assessments', req.assessmentId);
    if (!a) Errors.raise('NOT_FOUND');
    Authz.requireOffering(ctx, a.offering_id, 'can_manage');
    if (['student', 'group'].indexOf(req.targetType) < 0) Errors.raise('VALIDATION');
    var reason = Util.requireStr(req.reason, 'เหตุผล', 500);
    var due = req.dueAt ? Util.toIso(req.dueAt) : '';
    var close = req.closeAt ? Util.toIso(req.closeAt) : '';
    if (!due && !close) Errors.raise('VALIDATION', 'กรุณาระบุวันที่ขยาย');
    if (due && close && close < due) Errors.raise('VALIDATION', 'วันปิดรับต้องไม่ก่อนกำหนดส่ง');
    return Db.tx('assessment.extend', function (tx) {
      if (req.targetType === 'student') {
        var enr = tx.one('enrollments', { offering_id: a.offering_id, student_id: req.targetId });
        if (!enr) Errors.raise('NOT_FOUND');
      } else {
        var g = tx.get('groups', req.targetId);
        if (!g || g.assessment_id !== a.id) Errors.raise('NOT_FOUND');
      }
      var x = tx.insert('assessment_extensions', { assessment_id: a.id, target_type: req.targetType, target_id: req.targetId, due_at: due, close_at: close, reason: reason });
      tx.afterCommit(function () { Audit.log(ctx, 'assessment.extend', 'assessment_extensions', x.id, { target: req.targetId, due: due, close: close }, reason, a.offering_id); });
      return { id: x.id };
    }, { actorId: ctx.user.id });
  }
};
