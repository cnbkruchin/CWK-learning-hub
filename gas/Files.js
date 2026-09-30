/**
 * การเปิด/ดาวน์โหลดไฟล์ และแฟ้มเสมือน
 *
 * ดาวน์โหลด: ตรวจสิทธิ์ → ออก "ตั๋ว" อายุสั้นผูกกับผู้ใช้และไฟล์ → หน้าเว็บขอข้อมูลทีละช่วงด้วยตั๋ว
 * ไม่มีการแชร์ไฟล์บน Drive หรือสร้างลิงก์สาธารณะ
 *
 * แฟ้มเสมือน (สร้างจากฐานข้อมูล ไม่ใช่โฟลเดอร์จริง):
 *   รายบุคคล: ปีการศึกษา / ภาคเรียน / รายวิชา-กลุ่มเรียน / รหัส-ชื่อนักเรียน / งาน / รุ่นที่ส่ง / ไฟล์
 *   รายกลุ่ม: ปีการศึกษา / ภาคเรียน / รายวิชา-กลุ่มเรียน / กลุ่มของงาน / งาน / รุ่นที่ส่ง / ไฟล์
 * งานกลุ่มเก็บไฟล์จริงชุดเดียวต่อรุ่น และปรากฏในแฟ้มของสมาชิกทุกคนใน snapshot ของรุ่นนั้นโดยการอ้างอิง
 */
var Files = {
  open: function (ctx, req) {
    var asset = Db.get('file_assets', Util.requireId(req.fileAssetId, 'fileAssetId'));
    if (!asset || !Authz.canReadFile(ctx, asset)) Errors.raise('NOT_FOUND');
    if (!asset.drive_file_id) Errors.raise('NOT_FOUND');
    var ticket = Rand.token(24);
    CacheService.getScriptCache().put('dl:' + ticket, JSON.stringify({ uid: ctx.user.id, fid: asset.id, did: asset.drive_file_id, size: asset.size_bytes }), APP.DOWNLOAD_TICKET_TTL_SEC);
    Audit.log(ctx, 'file.open', 'file_assets', asset.id, { name: asset.original_name });
    return {
      ticket: ticket, name: asset.original_name, size: asset.size_bytes, ext: asset.extension,
      mime: FileCheck.safeMime(asset.extension), preview: FileCheck.previewKind(asset.extension),
      chunkSize: APP.DOWNLOAD_CHUNK_BYTES, chunks: Math.max(1, Math.ceil(asset.size_bytes / APP.DOWNLOAD_CHUNK_BYTES)),
      sha256: asset.sha256
    };
  },

  chunk: function (ctx, req) {
    var raw = CacheService.getScriptCache().get('dl:' + String(req.ticket || ''));
    if (!raw) Errors.raise('SESSION_EXPIRED', 'ลิงก์ดาวน์โหลดหมดอายุ กรุณากดเปิดไฟล์อีกครั้ง');
    var t = JSON.parse(raw);
    if (t.uid !== ctx.user.id) Errors.raise('FORBIDDEN');
    var index = Number(req.index);
    var start = index * APP.DOWNLOAD_CHUNK_BYTES;
    if (!(index >= 0) || start >= t.size) Errors.raise('VALIDATION');
    var end = Math.min(t.size, start + APP.DOWNLOAD_CHUNK_BYTES) - 1;
    return { index: index, data: Utilities.base64Encode(DriveStore.readRange(t.did, start, end)) };
  },

  _offeringPath: function (off) {
    var course = Db.get('courses', off.course_id);
    var term = Db.get('terms', off.term_id);
    var year = term ? Db.get('academic_years', term.academic_year_id) : null;
    return {
      yearBe: year ? year.year_be : '', termNo: term ? term.term_no : '',
      offering: (course ? course.course_code + ' ' + course.name_th : '') + ' (' + off.section_code + ')'
    };
  },

  _versionsWithFiles: function (sub, filterFn) {
    return Db.find('submission_versions', { submission_id: sub.id })
      .filter(function (v) { return !filterFn || filterFn(v); })
      .sort(function (a, b) { return a.version_no - b.version_no; })
      .map(function (v) { return Submission.versionDto(v, true); });
  },

  /** แฟ้มรายบุคคลของนักเรียนในรายวิชา (รวมงานกลุ่มที่นักเรียนอยู่ใน snapshot) */
  studentFolder: function (ctx, req) {
    var offeringId = req.offeringId;
    var studentId = req.studentId || (ctx.student && ctx.student.id);
    var off = Db.get('course_offerings', offeringId);
    if (!off) Errors.raise('NOT_FOUND');
    var perms = Authz.offeringPerms(ctx, off);
    var isSelf = ctx.student && ctx.student.id === studentId && perms.student;
    if (!perms.can_view && !isSelf) Errors.raise('FORBIDDEN');
    var s = Db.get('students', studentId);
    if (!s || s.school_id !== ctx.schoolId) Errors.raise('NOT_FOUND');
    var path = Files._offeringPath(off);
    var assessments = Db.find('assessments', { offering_id: off.id }).filter(function (a) {
      return a.status !== 'draft' && Submission.requiresSubmission(a);
    });
    var items = assessments.map(function (a) {
      var versions = [];
      if (a.kind === 'group') {
        var snaps = Db.find('assignment_member_snapshots', { assessment_id: a.id }).filter(function (m) { return m.student_id === s.id; });
        var groupIds = snaps.map(function (m) { return m.group_id; }).filter(function (v, i, arr) { return arr.indexOf(v) === i; });
        groupIds.forEach(function (gid) {
          var sub = Db.one('submissions', { assessment_id: a.id, owner_type: 'group', owner_id: gid });
          if (!sub) return;
          var g = Db.get('groups', gid);
          var mySnaps = snaps.filter(function (m) { return m.group_id === gid; }).map(function (m) { return m.snapshot_no; });
          Files._versionsWithFiles(sub, function (v) { return mySnaps.indexOf(v.member_snapshot_no) >= 0; }).forEach(function (v) {
            v.groupName = g ? g.name : '';
            v.viaGroup = true;
            versions.push(v);
          });
        });
      } else {
        var sub2 = Db.one('submissions', { assessment_id: a.id, owner_type: 'student', owner_id: s.id });
        if (sub2) versions = Files._versionsWithFiles(sub2, null);
      }
      return { assessmentId: a.id, code: a.code, title: a.title, kind: a.kind, versions: versions };
    });
    return {
      path: [String(path.yearBe), 'ภาคเรียนที่ ' + path.termNo, path.offering, s.student_code + ' ' + Groups.studentName(s)],
      student: { id: s.id, code: s.student_code, name: Groups.studentName(s) },
      items: items
    };
  },

  /** แฟ้มงานกลุ่ม (ครู) */
  groupFolder: function (ctx, req) {
    var a = Db.get('assessments', req.assessmentId);
    if (!a || a.kind !== 'group') Errors.raise('NOT_FOUND');
    var auth = Authz.requireOffering(ctx, a.offering_id, 'can_view');
    var path = Files._offeringPath(auth.offering);
    var gs = Db.one('assignment_group_sets', { assessment_id: a.id });
    var groups = gs ? Db.find('groups', { group_set_id: gs.id }) : [];
    return {
      path: [String(path.yearBe), 'ภาคเรียนที่ ' + path.termNo, path.offering, a.code + ' ' + a.title],
      groups: groups.filter(function (g) { return g.status !== 'disbanded'; }).map(function (g) {
        var sub = Db.one('submissions', { assessment_id: a.id, owner_type: 'group', owner_id: g.id });
        return { groupId: g.id, name: g.name, members: Groups.memberNames(g), versions: sub ? Files._versionsWithFiles(sub, null) : [] };
      })
    };
  }
};
