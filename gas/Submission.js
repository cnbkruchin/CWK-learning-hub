/**
 * การส่งงาน
 *
 * ลำดับ: อัปโหลดไฟล์เข้าฉบับร่าง (Upload.js) → กด "ส่งงาน" → สร้างรุ่นการส่ง + ใบยืนยัน
 * - ไฟล์อัปโหลดเสร็จยังไม่ถือว่าส่ง ต้องกดส่งและได้รับใบยืนยัน (รหัสการส่ง เวลาเซิร์ฟเวอร์ รายการไฟล์)
 * - ส่งซ้ำ = รุ่นใหม่ รุ่นเดิมและผู้ส่ง/เวลาเดิมถูกเก็บไว้
 * - ใช้ idempotency key ป้องกันการกดซ้ำหรือเน็ตหลุดแล้วส่งใหม่สร้างรายการซ้ำ
 * - ใช้ baseVersionNo ป้องกันสมาชิกกลุ่มสองคนส่งทับกันเงียบ ๆ
 * - เวลาใช้เวลาเซิร์ฟเวอร์เท่านั้น
 */
var Submission = {
  STATUS_LABELS: {
    not_open: 'ยังไม่ถึงเวลา',
    not_submitted: 'ยังไม่ส่ง',
    draft: 'ฉบับร่าง',
    submitted: 'ส่งแล้ว รอตรวจ',
    late: 'ส่งช้า รอตรวจ',
    resubmitted: 'ส่งใหม่ รอพิจารณา',
    returned: 'ส่งคืนแก้ไข',
    accepted: 'ตรวจแล้ว',
    graded: 'ประกาศคะแนนแล้ว',
    closed: 'ปิดรับแล้ว (ไม่ได้ส่ง)',
    score_only: 'รับคะแนนอย่างเดียว'
  },

  /** เพดานไฟล์ที่ใช้จริง = ชุดย่อยของค่าระดับโรงเรียน */
  limits: function (settings, assessment) {
    var school = Util.csvList(settings.allowed_file_types);
    var wanted = assessment.allowed_types ? Util.csvList(assessment.allowed_types) : school;
    var types = wanted.filter(function (t) { return school.indexOf(t) >= 0 && FileCheck.TYPES[t]; });
    if (types.indexOf('jpg') >= 0 && types.indexOf('jpeg') < 0) types.push('jpeg');
    var maxMb = Math.min(Number(settings.max_file_mb), Number(assessment.max_file_mb || settings.max_file_mb));
    var maxFiles = Math.min(Number(settings.max_files_per_submission), Number(assessment.max_files || settings.max_files_per_submission));
    return { allowedTypes: types, maxFileMb: maxMb, maxFileBytes: maxMb * 1024 * 1024, maxFiles: maxFiles, allowLinks: !!assessment.allow_links && assessment.submission_mode === 'file_or_link' };
  },

  extensionFor: function (assessmentId, studentId, groupId) {
    var list = Db.find('assessment_extensions', { assessment_id: assessmentId }).filter(function (x) {
      return !x.revoked_at && ((x.target_type === 'student' && x.target_id === studentId) || (x.target_type === 'group' && groupId && x.target_id === groupId));
    }).sort(function (a, b) { return a.created_at < b.created_at ? 1 : -1; });
    var own = list.filter(function (x) { return x.target_type === 'student'; })[0];
    return own || list[0] || null;
  },

  window: function (a, ext) {
    var due = (ext && ext.due_at) || a.due_at || '';
    var close = (ext && ext.close_at) || a.close_at || '';
    var hard = a.allow_late ? (close || '') : (due || close || '');
    return { openAt: a.open_at || '', dueAt: due, closeAt: close, hardCloseAt: hard, allowLate: !!a.allow_late, extended: !!ext };
  },

  /** โหลดบริบทการส่งงานของนักเรียนสำหรับรายการประเมินหนึ่ง (ใช้ได้ทั้งนอกและในธุรกรรม) */
  resolve: function (ctx, assessmentId, forWrite) {
    Authz.requireStudent(ctx);
    var a = Db.get('assessments', assessmentId);
    if (!a || a.status !== 'published') Errors.raise('NOT_FOUND');
    var e = Authz.requireEnrollment(ctx, a.offering_id, forWrite);
    var rc = {
      assessment: a, offering: e.offering, enrollment: e.enrollment, student: ctx.student,
      groupSet: null, group: null, membership: null, ownerType: 'student', ownerId: ctx.student.id, submission: null
    };
    if (a.kind === 'group') {
      rc.groupSet = Db.one('assignment_group_sets', { assessment_id: a.id });
      if (rc.groupSet) {
        rc.membership = Db.find('group_memberships', { group_set_id: rc.groupSet.id, student_id: ctx.student.id, status: 'active' })[0] || null;
        rc.group = rc.membership ? Db.get('groups', rc.membership.group_id) : null;
      }
      rc.ownerType = 'group';
      rc.ownerId = rc.group ? rc.group.id : '';
    }
    if (rc.ownerId) rc.submission = Db.one('submissions', { assessment_id: a.id, owner_type: rc.ownerType, owner_id: rc.ownerId });
    rc.extension = Submission.extensionFor(a.id, ctx.student.id, rc.group ? rc.group.id : '');
    rc.window = Submission.window(a, rc.extension);
    return rc;
  },

  requiresSubmission: function (a) {
    return (a.kind === 'individual' || a.kind === 'group') && a.submission_mode !== 'none';
  },

  checkWritable: function (rc, nowIso, forSubmit) {
    var a = rc.assessment;
    if (!Submission.requiresSubmission(a)) Errors.raise('SUBMISSION_NOT_REQUIRED');
    if (rc.window.openAt && nowIso < rc.window.openAt) Errors.raise('SUBMISSION_NOT_OPEN');
    if (rc.window.hardCloseAt && nowIso > rc.window.hardCloseAt) Errors.raise('SUBMISSION_CLOSED');
    if (a.kind !== 'group') return;
    if (!rc.group) Errors.raise('GROUP_REQUIRED');
    if (a.group_submit_policy === 'leader_only' && rc.group.leader_student_id !== rc.student.id) Errors.raise('GROUP_LEADER_ONLY');
    if (rc.group.frozen_at && !Groups.inCurrentSnapshot(rc.group, rc.student.id)) Errors.raise('GROUP_FROZEN');
    if (forSubmit) {
      var gs = rc.groupSet;
      if (gs.require_approval && ['approved', 'frozen'].indexOf(rc.group.status) < 0) Errors.raise('GROUP_NOT_APPROVED');
      var n = Number(rc.group.active_count || 0);
      if (!rc.group.size_exception && (n < gs.min_size || n > gs.max_size)) {
        Errors.raise('GROUP_SIZE_INVALID', 'กลุ่มมีสมาชิก ' + n + ' คน แต่งานนี้กำหนด ' +
          (gs.min_size === gs.max_size ? gs.min_size : gs.min_size + '–' + gs.max_size) + ' คน กรุณาเพิ่มสมาชิกหรือขอข้อยกเว้นจากครู');
      }
    }
  },

  draftFiles: function (submissionId) {
    if (!submissionId) return [];
    return Db.find('submission_files', { submission_id: submissionId, state: 'draft' });
  },

  fileDto: function (asset, ref) {
    return {
      fileAssetId: asset.id,
      refId: ref ? ref.id : '',
      name: asset.original_name,
      ext: asset.extension,
      size: asset.size_bytes,
      sha256: asset.sha256,
      preview: FileCheck.previewKind(asset.extension),
      checkStatus: asset.check_status,
      uploadedBy: asset.uploaded_by_user_id
    };
  },

  versionDto: function (v, withFiles) {
    var dto = {
      id: v.id, versionNo: v.version_no, submittedAt: v.submitted_at, submittedAtText: Util.formatThai(v.submitted_at),
      submittedByUserId: v.submitted_by_user_id, isLate: !!v.is_late, lateSeconds: v.late_seconds,
      comment: v.comment, links: v.links_json || [], fileCount: v.file_count, totalBytes: v.total_bytes,
      receiptCode: v.receipt_code, reviewStatus: v.review_status, reviewNote: v.review_status === 'returned' ? v.review_note : '',
      memberSnapshotNo: v.member_snapshot_no
    };
    if (withFiles) {
      dto.files = Db.find('submission_files', { submission_version_id: v.id }).filter(function (r) { return r.state === 'submitted'; })
        .sort(function (a, b) { return (a.sort || 0) - (b.sort || 0); })
        .map(function (r) { return Submission.fileDto(Db.get('file_assets', r.file_asset_id), r); });
    }
    var submitter = Db.get('users', v.submitted_by_user_id);
    dto.submittedByName = submitter ? submitter.display_name || submitter.username : '';
    return dto;
  },

  /** รายชื่อสมาชิกตาม snapshot ของรุ่นการส่ง (ชื่อและรหัส) */
  snapshotMembers: function (groupId, snapshotNo) {
    if (!snapshotNo) return [];
    return Db.find('assignment_member_snapshots', { group_id: groupId, snapshot_no: snapshotNo })
      .map(function (m) { var s = Db.get('students', m.student_id); return s ? { studentCode: s.student_code, name: [s.prefix, s.first_name, s.last_name].join(' ').trim() } : null; })
      .filter(Boolean);
  },

  studentStatus: function (a, submission, latest, grade, hasDraft, nowIso, win) {
    if (!Submission.requiresSubmission(a)) {
      return grade && grade.published_at ? 'graded' : 'score_only';
    }
    if (win.openAt && nowIso < win.openAt) return 'not_open';
    if (grade && grade.published_at) return 'graded';
    if (!submission || !submission.current_version_no) {
      if (hasDraft) return 'draft';
      if (win.hardCloseAt && nowIso > win.hardCloseAt) return 'closed';
      return 'not_submitted';
    }
    if (submission.status === 'returned') return 'returned';
    if (submission.status === 'resubmitted') return 'resubmitted';
    if (submission.status === 'accepted') return 'accepted';
    if (latest && latest.is_late) return 'late';
    return 'submitted';
  },

  // ======================= นักเรียน =======================
  myCourses: function (ctx) {
    Authz.requireStudent(ctx);
    return Db.find('enrollments', { student_id: ctx.student.id }).map(function (enr) {
      var off = Db.get('course_offerings', enr.offering_id);
      if (!off || off.status === 'draft') return null;
      var course = Db.get('courses', off.course_id);
      var term = Db.get('terms', off.term_id);
      var year = term ? Db.get('academic_years', term.academic_year_id) : null;
      var t = Db.get('teachers', off.owner_teacher_id);
      return {
        offeringId: off.id, courseCode: course && course.course_code, courseName: course && course.name_th,
        section: off.section_code, yearBe: year && year.year_be, termNo: term && term.term_no,
        teacherName: t ? [t.prefix, t.first_name, t.last_name].join(' ').trim() : '',
        enrollmentStatus: enr.status, offeringStatus: off.status
      };
    }).filter(Boolean);
  },

  myAssessments: function (ctx, offeringId) {
    var e = Authz.requireEnrollment(ctx, offeringId, false);
    var now = Util.nowIso();
    var myMemberships = Db.find('group_memberships', { student_id: ctx.student.id, status: 'active' });
    return Db.find('assessments', { offering_id: offeringId, status: 'published' })
      .sort(function (a, b) { return (a.due_at || '9') < (b.due_at || '9') ? -1 : 1; })
      .map(function (a) {
        var ownerType = a.kind === 'group' ? 'group' : 'student';
        var ownerId = ctx.student.id;
        var groupName = '';
        if (a.kind === 'group') {
          var gs = Db.one('assignment_group_sets', { assessment_id: a.id });
          var mem = gs ? myMemberships.filter(function (m) { return m.group_set_id === gs.id; })[0] : null;
          var g = mem ? Db.get('groups', mem.group_id) : null;
          ownerId = g ? g.id : '';
          groupName = g ? g.name : '';
        }
        var sub = ownerId ? Db.one('submissions', { assessment_id: a.id, owner_type: ownerType, owner_id: ownerId }) : null;
        var latest = sub && sub.latest_version_id ? Db.get('submission_versions', sub.latest_version_id) : null;
        var grade = Db.one('student_grades', { assessment_id: a.id, enrollment_id: e.enrollment.id });
        var ext = Submission.extensionFor(a.id, ctx.student.id, ownerType === 'group' ? ownerId : '');
        var win = Submission.window(a, ext);
        var hasDraft = sub ? Submission.draftFiles(sub.id).length > 0 : false;
        var status = Submission.studentStatus(a, sub, latest, grade, hasDraft, now, win);
        return {
          id: a.id, code: a.code, title: a.title, kind: a.kind, maxScore: a.max_score, weight: a.weight,
          openAt: win.openAt, dueAt: win.dueAt, closeAt: win.hardCloseAt, extended: win.extended,
          status: status, statusLabel: Submission.STATUS_LABELS[status], groupName: groupName,
          overdue: !!(win.dueAt && now > win.dueAt && (!sub || !sub.current_version_no)),
          publishedScore: grade && grade.published_at ? grade.published_score : null,
          publishedStatus: grade && grade.published_at ? grade.published_status : null
        };
      });
  },

  /** รายละเอียดงานสำหรับนักเรียน: คำชี้แจง เพดานไฟล์ ฉบับร่าง รุ่นที่ส่ง */
  detailForStudent: function (ctx, assessmentId) {
    var rc = Submission.resolve(ctx, assessmentId, false);
    var a = rc.assessment;
    var now = Util.nowIso();
    var settings = Settings.get(ctx.schoolId);
    var sub = rc.submission;
    var drafts = sub ? Submission.draftFiles(sub.id) : [];
    var versions = sub ? Db.find('submission_versions', { submission_id: sub.id })
      .filter(function (v) { return Authz.studentCanSeeSubmission(ctx, sub, v.member_snapshot_no || null); })
      .sort(function (x, y) { return y.version_no - x.version_no; })
      .map(function (v) {
        var dto = Submission.versionDto(v, true);
        if (sub.owner_type === 'group') dto.members = Submission.snapshotMembers(sub.owner_id, v.member_snapshot_no)
          .map(function (m) { return { name: m.name }; });
        return dto;
      }) : [];
    var grade = Db.one('student_grades', { assessment_id: a.id, enrollment_id: rc.enrollment.id });
    var latest = sub && sub.latest_version_id ? Db.get('submission_versions', sub.latest_version_id) : null;
    var status = Submission.studentStatus(a, sub, latest, grade, drafts.length > 0, now, rc.window);
    var writable = true, blockReason = '';
    try { Submission.checkWritable(rc, now, false); } catch (e) {
      if (!Errors.isApp(e)) throw e;
      writable = false; blockReason = e.message;
    }
    var attachments = (a.attachments_json || []).map(function (id) {
      var f = Db.get('file_assets', id);
      return f ? Submission.fileDto(f, null) : null;
    }).filter(Boolean);
    return {
      assessment: {
        id: a.id, code: a.code, title: a.title, description: a.description, kind: a.kind,
        maxScore: a.max_score, weight: a.weight, countsTowardGrade: a.counts_toward_grade,
        submissionMode: a.submission_mode, maxAttempts: a.max_attempts, groupSubmitPolicy: a.group_submit_policy,
        attachments: attachments
      },
      window: rc.window,
      nowText: Util.formatThai(now),
      limits: Submission.limits(settings, a),
      group: rc.group ? Groups.groupDtoForStudent(rc.group) : null,
      needsGroup: a.kind === 'group' && !rc.group,
      submissionId: sub ? sub.id : '',
      currentVersionNo: sub ? sub.current_version_no : 0,
      status: status,
      statusLabel: Submission.STATUS_LABELS[status],
      writable: writable,
      blockReason: blockReason,
      draftFiles: drafts.map(function (r) { return Submission.fileDto(Db.get('file_assets', r.file_asset_id), r); }),
      versions: versions,
      grade: grade && grade.published_at ? { status: grade.published_status, score: grade.published_score, publishedAt: grade.published_at } : null
    };
  },

  /** นำไฟล์จากรุ่นก่อนกลับมาเป็นฉบับร่าง (อ้างอิงไฟล์เดิม ไม่คัดลอกซ้ำ) */
  copyVersionToDraft: function (ctx, assessmentId, versionId) {
    return Db.tx('submission.copyToDraft', function (tx) {
      var rc = Submission.resolve(ctx, assessmentId, true);
      Submission.checkWritable(rc, tx.now, false);
      var v = tx.get('submission_versions', versionId);
      if (!v || !rc.submission || v.submission_id !== rc.submission.id) Errors.raise('NOT_FOUND');
      var limits = Submission.limits(Settings.get(ctx.schoolId), rc.assessment);
      var drafts = tx.find('submission_files', { submission_id: rc.submission.id, state: 'draft' });
      var have = drafts.map(function (d) { return d.file_asset_id; });
      var files = tx.find('submission_files', { submission_version_id: v.id }).filter(function (r) { return r.state === 'submitted' && have.indexOf(r.file_asset_id) < 0; });
      if (drafts.length + files.length > limits.maxFiles) Errors.raise('FILE_COUNT_EXCEEDED');
      files.forEach(function (r, i) {
        tx.insert('submission_files', { submission_id: rc.submission.id, submission_version_id: '', file_asset_id: r.file_asset_id, added_by_user_id: ctx.user.id, state: 'draft', sort: drafts.length + i + 1 });
      });
      return { added: files.length };
    }, { actorId: ctx.user.id });
  },

  removeDraftFile: function (ctx, assessmentId, refId) {
    return Db.tx('submission.removeDraft', function (tx) {
      var rc = Submission.resolve(ctx, assessmentId, true);
      var ref = tx.get('submission_files', refId);
      if (!ref || !rc.submission || ref.submission_id !== rc.submission.id || ref.state !== 'draft') Errors.raise('NOT_FOUND');
      if (rc.assessment.kind === 'group' && rc.group.frozen_at && !Groups.inCurrentSnapshot(rc.group, ctx.student.id)) Errors.raise('GROUP_FROZEN');
      tx.update('submission_files', ref.id, { state: 'removed' });
      return true;
    }, { actorId: ctx.user.id });
  },

  /**
   * ส่งงาน
   * @param {{assessmentId:string, fileAssetIds:string[], comment:string, links:string[], baseVersionNo:number, idempotencyKey:string}} req
   */
  submit: function (ctx, req) {
    Authz.requireStudent(ctx);
    var key = Util.str(req.idempotencyKey, 100);
    if (!/^[A-Za-z0-9_-]{16,100}$/.test(key)) Errors.raise('VALIDATION', 'idempotencyKey ไม่ถูกต้อง');
    var comment = Util.str(req.comment, 5000, 'คำอธิบาย');
    var links = (req.links || []).map(function (l) { return Util.str(l, 2000); }).filter(String);
    links.forEach(function (l) { if (!Util.isHttpUrl(l)) Errors.raise('VALIDATION', 'ลิงก์ต้องขึ้นต้นด้วย http:// หรือ https://'); });
    if (links.length > 10) Errors.raise('VALIDATION', 'แนบลิงก์ได้ไม่เกิน 10 รายการ');
    var wanted = req.fileAssetIds ? req.fileAssetIds.map(String) : null;
    var cacheKey = 'idem:' + ctx.user.id + ':' + key;
    var cached = CacheService.getScriptCache().get(cacheKey);
    if (cached) { var c = JSON.parse(cached); c.replayed = true; return c; }

    Groups.preFreeze(req.assessmentId);
    var moves = [];
    var result = Db.tx('submission.submit', function (tx) {
      var prev = tx.find('idempotency_keys', { key: key }).filter(function (r) { return r.user_id === ctx.user.id; })[0];
      if (prev) { var r0 = prev.result_json; r0.replayed = true; return r0; }

      var rc = Submission.resolve(ctx, req.assessmentId, true);
      var a = rc.assessment;
      if (rc.groupSet) Groups.freezeSetIfClosed(tx, rc.groupSet);
      if (rc.group) rc.group = tx.get('groups', rc.group.id);
      Submission.checkWritable(rc, tx.now, true);

      var sub = rc.submission ? tx.get('submissions', rc.submission.id) : null;
      var currentNo = sub ? Number(sub.current_version_no || 0) : 0;
      if (Number(req.baseVersionNo || 0) !== currentNo) {
        var latest = sub && sub.latest_version_id ? tx.get('submission_versions', sub.latest_version_id) : null;
        var who = latest ? Db.get('users', latest.submitted_by_user_id) : null;
        Errors.raise('CONFLICT', 'มีการส่งรุ่นที่ ' + currentNo + ' แล้ว' +
          (latest ? ' โดย ' + (who ? who.display_name || who.username : '') + ' เวลา ' + Util.formatThai(latest.submitted_at) : '') +
          ' กรุณาตรวจสอบก่อนส่งรุ่นใหม่', { currentVersionNo: currentNo });
      }
      if (Number(a.max_attempts || 0) > 0 && currentNo >= Number(a.max_attempts) && (!sub || sub.status !== 'returned')) {
        Errors.raise('ATTEMPTS_EXCEEDED');
      }

      var limits = Submission.limits(Settings.get(ctx.schoolId), a);
      var drafts = sub ? tx.find('submission_files', { submission_id: sub.id, state: 'draft' }) : [];
      var chosen = wanted ? drafts.filter(function (d) { return wanted.indexOf(d.file_asset_id) >= 0; }) : drafts;
      if (wanted && chosen.length !== wanted.length) Errors.raise('FILE_NOT_READY', 'บางไฟล์ไม่อยู่ในฉบับร่าง (อาจถูกลบหรือยังอัปโหลดไม่เสร็จ) กรุณาโหลดหน้าใหม่');
      if (!limits.allowLinks && links.length) Errors.raise('VALIDATION', 'งานนี้ไม่อนุญาตให้ส่งเป็นลิงก์');
      if (!chosen.length && !links.length) Errors.raise('NOTHING_TO_SUBMIT');
      if (chosen.length > limits.maxFiles) Errors.raise('FILE_COUNT_EXCEEDED');
      var assets = chosen.map(function (d) {
        var f = tx.get('file_assets', d.file_asset_id);
        if (!f || f.check_status !== 'passed' || (f.state !== 'staging' && f.state !== 'stored')) Errors.raise('FILE_NOT_READY');
        if (limits.allowedTypes.indexOf(f.extension) < 0) Errors.raise('FILE_TYPE_NOT_ALLOWED', 'ไฟล์ ' + f.original_name + ' เป็นชนิดที่งานนี้ไม่รับ');
        if (f.size_bytes > limits.maxFileBytes) Errors.raise('FILE_TOO_LARGE', 'ไฟล์ ' + f.original_name + ' ใหญ่เกินกำหนด');
        return f;
      });

      if (!sub) {
        sub = tx.insert('submissions', { assessment_id: a.id, offering_id: a.offering_id, owner_type: rc.ownerType, owner_id: rc.ownerId, status: 'draft', current_version_no: 0 });
      }
      var snapshotNo = '';
      if (rc.group) {
        if (!rc.group.frozen_at) Groups.freeze(tx, rc.group, 'first_submission', '', ctx);
        rc.group = tx.get('groups', rc.group.id);
        snapshotNo = rc.group.snapshot_no;
      }
      var lateSec = rc.window.dueAt && tx.now > rc.window.dueAt ? Math.round((Util.ms(tx.now) - Util.ms(rc.window.dueAt)) / 1000) : 0;
      var totalBytes = assets.reduce(function (s, f) { return s + Number(f.size_bytes || 0); }, 0);
      var receipt = 'CWK-' + Util.shortCode(4) + '-' + Util.shortCode(4);
      var version = tx.insert('submission_versions', {
        submission_id: sub.id, assessment_id: a.id, version_no: currentNo + 1,
        submitted_by_user_id: ctx.user.id, submitted_by_student_id: ctx.student.id,
        submitted_at: tx.now, due_at_effective: rc.window.dueAt, is_late: lateSec > 0, late_seconds: lateSec,
        comment: comment, links_json: links, file_count: assets.length, total_bytes: totalBytes,
        receipt_code: receipt, member_snapshot_no: snapshotNo, review_status: 'pending'
      });
      chosen.forEach(function (d, i) {
        tx.update('submission_files', d.id, { submission_version_id: version.id, state: 'submitted', sort: i + 1 });
      });
      var folderNeeded = false;
      assets.forEach(function (f) {
        if (f.state === 'staging') {
          tx.update('file_assets', f.id, { state: 'stored', offering_id: a.offering_id, assessment_id: a.id });
          moves.push(f.drive_file_id);
          folderNeeded = true;
        }
      });
      if (sub.latest_version_id) {
        var prevV = tx.get('submission_versions', sub.latest_version_id);
        if (prevV && prevV.review_status === 'pending') tx.update('submission_versions', prevV.id, { review_status: 'superseded' });
      }
      var reviewed = sub.status === 'accepted' || sub.status === 'returned' || !!sub.accepted_version_id;
      tx.update('submissions', sub.id, {
        current_version_no: currentNo + 1,
        latest_version_id: version.id,
        status: reviewed ? 'resubmitted' : 'submitted',
        first_submitted_at: sub.first_submitted_at || tx.now,
        last_submitted_at: tx.now
      });
      var out = {
        receiptCode: receipt,
        submissionId: sub.id,
        versionId: version.id,
        versionNo: currentNo + 1,
        submittedAt: tx.now,
        submittedAtText: Util.formatThai(tx.now),
        isLate: lateSec > 0,
        lateSeconds: lateSec,
        assessmentTitle: a.title,
        files: assets.map(function (f) { return { name: f.original_name, size: f.size_bytes, sha256: f.sha256 }; }),
        links: links,
        resubmitted: reviewed
      };
      tx.insert('idempotency_keys', {
        key: key, user_id: ctx.user.id, action: 'submission.submit', result_json: out,
        expires_at: new Date(Util.ms(tx.now) + APP.IDEMPOTENCY_TTL_HOURS * 3600000).toISOString()
      });
      var memberUserIds = rc.group ? Groups.snapshotUserIds(rc.group) : [ctx.user.id];
      var offeringId = a.offering_id, assessment = a;
      tx.afterCommit(function () {
        CacheService.getScriptCache().put(cacheKey, JSON.stringify(out), 21600);
        if (folderNeeded) Submission.moveToFinalFolder(moves, offeringId, assessment);
        Audit.log(ctx, 'submission.submit', 'submission_versions', version.id,
          { receipt: receipt, versionNo: out.versionNo, files: out.files.length, late: out.isLate }, '', offeringId);
        Notify.sendMany(memberUserIds, 'submission', 'ส่งงานสำเร็จ: ' + assessment.title,
          'รุ่นที่ ' + out.versionNo + ' รหัสยืนยัน ' + receipt + ' เวลา ' + out.submittedAtText, 'assessment:' + assessment.id);
      });
      return out;
    }, { actorId: ctx.user.id });
    return result;
  },

  /** ย้ายไฟล์จาก staging ไปโฟลเดอร์ของงาน (ถ้าล้มเหลว งานบำรุงรักษาจะย้ายให้ภายหลัง ฐานข้อมูลยังถูกต้อง) */
  moveToFinalFolder: function (driveIds, offeringId, assessment) {
    try {
      var offering = Db.get('course_offerings', offeringId);
      var folderId = DriveStore.assessmentFolderId(offering, assessment);
      driveIds.forEach(function (id) {
        try { DriveStore.move(id, folderId); } catch (e) { Maintenance.queueMove(id, offeringId, assessment.id); }
      });
    } catch (e) {
      console.warn('moveToFinalFolder deferred: ' + e);
      driveIds.forEach(function (id) { Maintenance.queueMove(id, offeringId, assessment.id); });
    }
  },

  // ======================= ครู =======================
  /** รายการการส่งของงานหนึ่ง (รายคนหรือรายกลุ่ม) สำหรับคิวตรวจงาน */
  listForTeacher: function (ctx, assessmentId) {
    var a = Db.get('assessments', assessmentId);
    if (!a) Errors.raise('NOT_FOUND');
    Authz.requireOffering(ctx, a.offering_id, 'can_view');
    var subs = Db.find('submissions', { assessment_id: a.id });
    var byOwner = Util.indexBy(subs, 'owner_id');
    var now = Util.nowIso();
    function row(sub, extra) {
      var latest = sub && sub.latest_version_id ? Db.get('submission_versions', sub.latest_version_id) : null;
      var status = !sub || !sub.current_version_no ? (sub && Submission.draftFiles(sub.id).length ? 'draft' : 'not_submitted')
        : (sub.status === 'returned' ? 'returned' : sub.status === 'resubmitted' ? 'resubmitted' : sub.status === 'accepted' ? 'accepted' : latest && latest.is_late ? 'late' : 'submitted');
      return Object.assign({
        submissionId: sub ? sub.id : '', status: status, statusLabel: Submission.STATUS_LABELS[status],
        versionNo: sub ? sub.current_version_no : 0, lastSubmittedAt: sub ? sub.last_submitted_at : '',
        lastSubmittedAtText: sub && sub.last_submitted_at ? Util.formatThai(sub.last_submitted_at) : '',
        isLate: !!(latest && latest.is_late), fileCount: latest ? latest.file_count : 0,
        acceptedVersionId: sub ? sub.accepted_version_id : ''
      }, extra);
    }
    var rows;
    if (a.kind === 'group') {
      var gs = Db.one('assignment_group_sets', { assessment_id: a.id });
      rows = gs ? Db.find('groups', { group_set_id: gs.id }).filter(function (g) { return g.status !== 'disbanded'; }).map(function (g) {
        return row(byOwner[g.id], { ownerType: 'group', ownerId: g.id, name: g.name, members: Groups.memberNames(g), frozen: !!g.frozen_at });
      }) : [];
    } else {
      rows = Db.find('enrollments', { offering_id: a.offering_id }).map(function (enr) {
        var s = Db.get('students', enr.student_id);
        var sub = byOwner[enr.student_id];
        if (enr.status !== 'active' && !sub) return null;
        return row(sub, {
          ownerType: 'student', ownerId: s.id, studentCode: s.student_code,
          name: [s.prefix, s.first_name, s.last_name].join(' ').trim(), room: s.room, rollNo: s.roll_no, enrollmentStatus: enr.status
        });
      }).filter(Boolean).sort(function (x, y) {
        return String(x.room).localeCompare(String(y.room)) || (x.rollNo || 0) - (y.rollNo || 0) || String(x.studentCode).localeCompare(String(y.studentCode));
      });
    }
    var submitted = rows.filter(function (r) { return r.versionNo > 0; }).length;
    return {
      assessment: { id: a.id, code: a.code, title: a.title, kind: a.kind, dueAt: a.due_at, maxScore: a.max_score, weight: a.weight },
      rows: rows,
      counts: {
        owners: rows.length,
        submitted: submitted,
        late: rows.filter(function (r) { return r.isLate; }).length,
        notSubmitted: rows.length - submitted,
        pastDue: !!(a.due_at && now > a.due_at)
      }
    };
  },

  /** รายละเอียดการส่ง (ครูผู้สอน หรือเจ้าของงาน) */
  detail: function (ctx, submissionId) {
    var sub = Db.get('submissions', submissionId);
    if (!sub) Errors.raise('NOT_FOUND');
    var off = Db.get('course_offerings', sub.offering_id);
    var perms = Authz.offeringPerms(ctx, off);
    var isTeacher = perms.can_view;
    if (!isTeacher && !Authz.studentCanSeeSubmission(ctx, sub, null)) Errors.raise('FORBIDDEN');
    var a = Db.get('assessments', sub.assessment_id);
    var versions = Db.find('submission_versions', { submission_id: sub.id })
      .filter(function (v) { return isTeacher || Authz.studentCanSeeSubmission(ctx, sub, v.member_snapshot_no || null); })
      .sort(function (x, y) { return y.version_no - x.version_no; })
      .map(function (v) {
        var dto = Submission.versionDto(v, true);
        if (isTeacher) dto.reviewNote = v.review_note;
        if (sub.owner_type === 'group') dto.members = Submission.snapshotMembers(sub.owner_id, v.member_snapshot_no);
        return dto;
      });
    var owner;
    if (sub.owner_type === 'group') {
      var g = Db.get('groups', sub.owner_id);
      owner = { type: 'group', name: g ? g.name : '', members: g ? Groups.memberNames(g) : [] };
    } else {
      var s = Db.get('students', sub.owner_id);
      owner = { type: 'student', name: s ? [s.prefix, s.first_name, s.last_name].join(' ').trim() : '', studentCode: s ? s.student_code : '' };
    }
    return {
      submissionId: sub.id, version: sub.version, status: sub.status, statusLabel: Submission.STATUS_LABELS[sub.status] || sub.status,
      acceptedVersionId: sub.accepted_version_id, owner: owner, canReview: perms.can_grade,
      assessment: { id: a.id, code: a.code, title: a.title, maxScore: a.max_score, weight: a.weight, dueAt: a.due_at, description: a.description },
      versions: versions
    };
  },

  /** ครูรับรุ่นเพื่อประเมิน หรือส่งคืนแก้ไข (ไม่แตะคะแนน คะแนนเดิมยังอยู่) */
  review: function (ctx, req) {
    var action = req.action;
    if (['accept', 'return'].indexOf(action) < 0) Errors.raise('VALIDATION');
    var note = Util.str(req.note, 5000, 'ข้อความถึงนักเรียน');
    if (action === 'return' && !note) Errors.raise('VALIDATION', 'กรุณาระบุสิ่งที่ต้องแก้ไข');
    var out = Db.tx('submission.review', function (tx) {
      var v = tx.get('submission_versions', req.versionId);
      if (!v) Errors.raise('NOT_FOUND');
      var sub = tx.get('submissions', v.submission_id);
      var auth = Authz.requireOffering(ctx, sub.offering_id, 'can_grade');
      if (req.expectedVersion !== undefined && Number(req.expectedVersion) !== Number(sub.version)) Errors.raise('CONFLICT');
      tx.update('submission_versions', v.id, { review_status: action === 'accept' ? 'accepted' : 'returned', review_note: note, reviewed_by: ctx.user.id, reviewed_at: tx.now });
      var patch = { status: action === 'accept' ? 'accepted' : 'returned' };
      if (action === 'accept') patch.accepted_version_id = v.id;
      tx.update('submissions', sub.id, patch);
      var a = tx.get('assessments', sub.assessment_id);
      var userIds = sub.owner_type === 'group' ? Groups.snapshotUserIds(tx.get('groups', sub.owner_id))
        : [(Db.get('students', sub.owner_id) || {}).user_id];
      tx.afterCommit(function () {
        Audit.log(ctx, 'submission.' + action, 'submission_versions', v.id, { versionNo: v.version_no }, note, auth.offering.id);
        if (action === 'return') Notify.sendMany(userIds, 'returned', 'งานถูกส่งคืนแก้ไข: ' + a.title, 'กรุณาเปิดงานเพื่ออ่านสิ่งที่ครูให้แก้ไข', 'assessment:' + a.id);
      });
      return { ok: true, status: patch.status };
    }, { actorId: ctx.user.id });
    return out;
  }
};
