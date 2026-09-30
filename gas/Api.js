/**
 * ตัวกลางรับคำขอจากหน้าเว็บ: google.script.run.apiCall({ action, token, payload })
 * ตอบกลับ { ok:true, data } หรือ { ok:false, error:{ code, message, details } }
 *
 * ทุก action (ยกเว้นที่ระบุ public) ต้องผ่าน Auth.authenticate และตรวจสิทธิ์ภายในบริการเอง
 * ข้อผิดพลาดที่ไม่คาดคิดตอบเป็น INTERNAL พร้อมรหัสอ้างอิง ไม่ส่ง stack trace ให้ผู้ใช้
 */
var Api = {
  routes: {
    // บัญชี
    'auth.login': { public: true, fn: function (p) { return Auth.login(p.username, p.password, { userAgent: p.userAgent, schoolCode: p.schoolCode }); } },
    'auth.logout': { public: true, fn: function (p, ctx, req) { return Auth.logout(req.token); } },
    'auth.me': { allowMustChange: true, fn: function (p, ctx) { return Auth.profile(ctx); } },
    'auth.changePassword': { allowMustChange: true, fn: function (p, ctx) { return Auth.changePassword(ctx, p.oldPassword, p.newPassword); } },
    'notify.list': { fn: function (p, ctx) { return Notify.listMine(ctx); } },
    'notify.markRead': { fn: function (p, ctx) { return Notify.markRead(ctx, p.ids); } },

    // นักเรียน
    'student.courses': { fn: function (p, ctx) { return Submission.myCourses(ctx); } },
    'student.assessments': { fn: function (p, ctx) { return Submission.myAssessments(ctx, p.offeringId); } },
    'student.assessment': { fn: function (p, ctx) { return Submission.detailForStudent(ctx, p.assessmentId); } },
    'student.folder': { fn: function (p, ctx) { return Files.studentFolder(ctx, { offeringId: p.offeringId }); } },
    'upload.begin': { fn: function (p, ctx) { return Upload.begin(ctx, p); } },
    'upload.chunk': { fn: function (p, ctx) { return Upload.chunk(ctx, p); } },
    'upload.finalize': { fn: function (p, ctx) { return Upload.finalize(ctx, p); } },
    'submission.removeDraft': { fn: function (p, ctx) { return Submission.removeDraftFile(ctx, p.assessmentId, p.refId); } },
    'submission.copyToDraft': { fn: function (p, ctx) { return Submission.copyVersionToDraft(ctx, p.assessmentId, p.versionId); } },
    'submission.submit': { fn: function (p, ctx) { return Submission.submit(ctx, p); } },
    'submission.detail': { fn: function (p, ctx) { return Submission.detail(ctx, p.submissionId); } },
    'group.forStudent': { fn: function (p, ctx) { return Groups.forStudent(ctx, p.assessmentId); } },
    'group.create': { fn: function (p, ctx) { return Groups.create(ctx, p); } },
    'group.invite': { fn: function (p, ctx) { return Groups.invite(ctx, p); } },
    'group.respond': { fn: function (p, ctx) { return Groups.respond(ctx, p); } },
    'group.requestJoin': { fn: function (p, ctx) { return Groups.requestJoin(ctx, p); } },
    'group.decideRequest': { fn: function (p, ctx) { return Groups.decideRequest(ctx, p); } },
    'group.leave': { fn: function (p, ctx) { return Groups.leave(ctx, p); } },

    // ครู
    'teacher.offerings': { fn: function (p, ctx) { return Teaching.myOfferings(ctx); } },
    'teacher.assessments': { fn: function (p, ctx) { return Teaching.assessments(ctx, p.offeringId); } },
    'teacher.saveAssessment': { fn: function (p, ctx) { return Teaching.saveAssessment(ctx, p); } },
    'teacher.grantExtension': { fn: function (p, ctx) { return Teaching.grantExtension(ctx, p); } },
    'teacher.submissions': { fn: function (p, ctx) { return Submission.listForTeacher(ctx, p.assessmentId); } },
    'teacher.review': { fn: function (p, ctx) { return Submission.review(ctx, p); } },
    'teacher.groups': { fn: function (p, ctx) { return Groups.teacherOverview(ctx, p.assessmentId); } },
    'teacher.groupApprove': { fn: function (p, ctx) { return Groups.teacherApprove(ctx, p); } },
    'teacher.groupAssign': { fn: function (p, ctx) { return Groups.teacherAssign(ctx, p); } },
    'teacher.groupCopy': { fn: function (p, ctx) { return Groups.teacherCopyFrom(ctx, p); } },

    // ไฟล์และแฟ้มเสมือน
    'files.open': { fn: function (p, ctx) { return Files.open(ctx, p); } },
    'files.chunk': { fn: function (p, ctx) { return Files.chunk(ctx, p); } },
    'files.studentFolder': { fn: function (p, ctx) { return Files.studentFolder(ctx, p); } },
    'files.groupFolder': { fn: function (p, ctx) { return Files.groupFolder(ctx, p); } },

    // ผู้ดูแล
    'admin.status': { fn: function (p, ctx) { return Maintenance.status(ctx); } },
    'admin.updateSettings': { fn: function (p, ctx) { return Settings.update(ctx, p.changes); } },
    'admin.resetPassword': { fn: function (p, ctx) { return Auth.adminResetPassword(ctx, p.userId); } },
    'admin.setUserStatus': { fn: function (p, ctx) { return Auth.adminSetStatus(ctx, p.userId, p.status, p.reason); } }
  },

  handle: function (request) {
    var started = Date.now();
    Db.reset();
    var req = request || {};
    try {
      var route = Object.prototype.hasOwnProperty.call(Api.routes, req.action) ? Api.routes[req.action] : null;
      if (!route) Errors.raise('NOT_FOUND', 'ไม่รู้จักคำสั่ง');
      var ctx = null;
      if (!route.public) {
        ctx = Auth.authenticate(req.token);
        if (ctx.user.must_change_password && !route.allowMustChange) Errors.raise('PASSWORD_CHANGE_REQUIRED');
      }
      var data = route.fn(req.payload || {}, ctx, req);
      return { ok: true, data: data === undefined ? null : data, ms: Date.now() - started };
    } catch (e) {
      if (Errors.isApp(e)) {
        return { ok: false, error: { code: e.code, message: e.message, details: e.details || null } };
      }
      var ref = Util.uuid().slice(0, 8);
      console.error('[' + ref + '] ' + String(req.action) + ': ' + (e && e.stack || e));
      return { ok: false, error: { code: 'INTERNAL', message: ERR.INTERNAL + ' (รหัสอ้างอิง ' + ref + ')', ref: ref } };
    }
  }
};
