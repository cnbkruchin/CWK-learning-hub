/**
 * การตรวจสิทธิ์ (ทำที่เซิร์ฟเวอร์ทุกคำขอ รวมถึงการดูไฟล์ การนำเข้า และการส่งออก)
 *
 * สิทธิ์ = บทบาท (admin/teacher/student/grade_admin) + ความสัมพันธ์กับรายวิชาที่เปิดสอน
 * - ครูเจ้าของรายวิชา: ทุกสิทธิ์ในรายวิชานั้น
 * - ครูร่วมสอน: ตามธง can_* ใน teaching_assignments
 * - ผู้ดูแล: ดู/จัดการ/ส่งออก/ปิดผลในโรงเรียน แต่แก้คะแนนได้เฉพาะเมื่อมีบทบาท grade_admin
 * - นักเรียน: เฉพาะรายวิชาที่ลงทะเบียน และเฉพาะข้อมูลของตน/กลุ่มของตน
 */
var Authz = {
  NONE: function () {
    var p = { student: false, enrollment: null, owner: false };
    APP.OFFERING_PERMISSIONS.forEach(function (k) { p[k] = false; });
    return p;
  },

  requireAdmin: function (ctx) {
    if (!ctx || !ctx.roles || !ctx.roles.admin) Errors.raise('FORBIDDEN');
  },

  requireTeacher: function (ctx) {
    if (!ctx || !ctx.teacher) Errors.raise('FORBIDDEN');
  },

  requireStudent: function (ctx) {
    if (!ctx || !ctx.student) Errors.raise('FORBIDDEN');
  },

  offeringPerms: function (ctx, offering) {
    var p = Authz.NONE();
    if (!offering || !ctx || offering.school_id !== ctx.schoolId) return p;
    if (ctx.roles.admin) { p.can_view = p.can_export = p.can_manage = p.can_close = true; }
    if (ctx.roles.grade_admin) { p.can_view = p.can_grade = p.can_edit_scores = p.can_publish = true; }
    if (ctx.teacher) {
      if (offering.owner_teacher_id === ctx.teacher.id) {
        APP.OFFERING_PERMISSIONS.forEach(function (k) { p[k] = true; });
        p.owner = true;
      } else {
        Db.find('teaching_assignments', { offering_id: offering.id, teacher_id: ctx.teacher.id }).forEach(function (ta) {
          if (ta.revoked_at) return;
          if (ta.role === 'owner') {
            APP.OFFERING_PERMISSIONS.forEach(function (k) { p[k] = true; });
            p.owner = true;
          } else {
            APP.OFFERING_PERMISSIONS.forEach(function (k) { if (ta[k]) p[k] = true; });
          }
        });
      }
    }
    if (ctx.student) {
      var enr = Db.one('enrollments', { offering_id: offering.id, student_id: ctx.student.id });
      if (enr) { p.student = true; p.enrollment = enr; }
    }
    return p;
  },

  /** โหลดรายวิชาที่เปิดสอนและตรวจสิทธิ์ครู/ผู้ดูแล */
  requireOffering: function (ctx, offeringId, perm) {
    var offering = Db.get('course_offerings', offeringId);
    if (!offering || offering.school_id !== ctx.schoolId) Errors.raise('NOT_FOUND');
    var perms = Authz.offeringPerms(ctx, offering);
    if (!perms[perm || 'can_view']) Errors.raise('FORBIDDEN');
    return { offering: offering, perms: perms };
  },

  /** นักเรียนต้องลงทะเบียนในรายวิชา; activeOnly = ต้องยังเรียนอยู่ (สำหรับการส่งงาน) */
  requireEnrollment: function (ctx, offeringId, activeOnly) {
    Authz.requireStudent(ctx);
    var offering = Db.get('course_offerings', offeringId);
    if (!offering || offering.school_id !== ctx.schoolId) Errors.raise('NOT_FOUND');
    var enr = Db.one('enrollments', { offering_id: offeringId, student_id: ctx.student.id });
    if (!enr) Errors.raise('NOT_ENROLLED');
    if (activeOnly && enr.status !== 'active') Errors.raise('NOT_ENROLLED', 'การลงทะเบียนรายวิชานี้สิ้นสุดแล้ว');
    return { offering: offering, enrollment: enr };
  },

  /** นักเรียนดูการส่งงานนี้ได้หรือไม่ (ของตนเอง หรือของกลุ่มที่ตนเป็นสมาชิก/อยู่ใน snapshot) */
  studentCanSeeSubmission: function (ctx, submission, versionSnapshotNo) {
    if (!ctx.student || !submission) return false;
    if (submission.owner_type === 'student') return submission.owner_id === ctx.student.id;
    var groupId = submission.owner_id;
    if (versionSnapshotNo) {
      return Db.find('assignment_member_snapshots', { group_id: groupId, snapshot_no: versionSnapshotNo, student_id: ctx.student.id }).length > 0;
    }
    var active = Db.find('group_memberships', { group_id: groupId, student_id: ctx.student.id, status: 'active' }).length > 0;
    if (active) return true;
    return Db.find('assignment_member_snapshots', { group_id: groupId, student_id: ctx.student.id }).length > 0;
  },

  /** ตรวจสิทธิ์อ่านไฟล์ (ใช้ทุกครั้งก่อนเปิด/ดาวน์โหลด) */
  canReadFile: function (ctx, asset) {
    if (!asset || asset.school_id !== ctx.schoolId) return false;
    if (asset.state === 'purged' || asset.state === 'trashed') return false;
    // ผู้อัปโหลดเห็นไฟล์ที่ตนอัปโหลด (รวมฉบับร่างและไฟล์ที่ถูกกัก เพื่อดูเหตุผล)
    if (asset.uploaded_by_user_id === ctx.user.id && asset.state !== 'quarantined') return true;
    if (asset.state === 'quarantined') {
      // ไฟล์ที่ถูกกักเปิดได้เฉพาะผู้ดูแล (เพื่อตรวจสอบ)
      return !!ctx.roles.admin;
    }
    var refs = Db.find('submission_files', { file_asset_id: asset.id }).filter(function (r) { return r.state !== 'removed'; });
    for (var i = 0; i < refs.length; i++) {
      var ref = refs[i];
      var sub = Db.get('submissions', ref.submission_id);
      if (!sub) continue;
      if (ctx.teacher || ctx.roles.admin || ctx.roles.grade_admin) {
        var off = Db.get('course_offerings', sub.offering_id);
        if (Authz.offeringPerms(ctx, off).can_view) return true;
      }
      if (ctx.student) {
        if (ref.state === 'draft') {
          if (Authz.studentCanSeeSubmission(ctx, sub, null) &&
            (sub.owner_type === 'student' || Db.find('group_memberships', { group_id: sub.owner_id, student_id: ctx.student.id, status: 'active' }).length)) return true;
        } else {
          var ver = Db.get('submission_versions', ref.submission_version_id);
          if (ver && Authz.studentCanSeeSubmission(ctx, sub, ver.member_snapshot_no || null)) return true;
        }
      }
    }
    // ไฟล์แนบของครูในภาระงาน: นักเรียนในรายวิชาและครูผู้สอนดูได้
    if (asset.purpose === 'attachment' && asset.offering_id) {
      var offering = Db.get('course_offerings', asset.offering_id);
      var p = Authz.offeringPerms(ctx, offering);
      if (p.can_view || p.student) return true;
    }
    return false;
  }
};
