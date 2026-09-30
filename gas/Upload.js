/**
 * อัปโหลดไฟล์เข้าฉบับร่าง (ยังไม่ใช่การส่งงาน)
 *
 * 1. begin    ตรวจสิทธิ์ เวลา ชนิด/ขนาดที่ประกาศ จำนวนไฟล์ โควตา แล้วเปิด Drive resumable session ในโฟลเดอร์ staging
 * 2. chunk    รับข้อมูลทีละช่วง (base64) ส่งต่อไป Drive; ช่วงแรกตรวจ magic bytes ทันที
 *             ส่งช่วงเดิมซ้ำได้อย่างปลอดภัย (ตรวจ offset) หากเน็ตหลุดให้เริ่มจาก received ที่ได้รับกลับ
 * 3. finalize ตรวจไฟล์ฉบับสมบูรณ์จาก Drive (ขนาด, magic bytes, โครงสร้าง ZIP/Office, SHA-256)
 *             ผ่าน → บันทึก file_assets (staging) + เพิ่มในฉบับร่าง
 *             ไม่ผ่าน → บันทึกเป็น quarantined แล้วย้ายไฟล์ไปโฟลเดอร์กัก ไม่ถูกใช้ในการส่ง
 * สถานะรอบอัปโหลดเก็บใน CacheService (มี URL resumable ซึ่งเป็นความลับ ไม่บันทึกลงชีตหรือ log)
 */
var Upload = {
  CACHE_PREFIX: 'up:',

  _state: function (ctx, uploadId) {
    var raw = CacheService.getScriptCache().get(Upload.CACHE_PREFIX + Util.requireId(uploadId, 'uploadId'));
    if (!raw) Errors.raise('UPLOAD_EXPIRED');
    var st = JSON.parse(raw);
    if (st.uid !== ctx.user.id) Errors.raise('FORBIDDEN');
    return st;
  },

  _save: function (st) {
    CacheService.getScriptCache().put(Upload.CACHE_PREFIX + st.id, JSON.stringify(st), APP.UPLOAD_SESSION_TTL_SEC);
  },

  begin: function (ctx, req) {
    var rc = Submission.resolve(ctx, req.assessmentId, true);
    var now = Util.nowIso();
    Submission.checkWritable(rc, now, false);
    var settings = Settings.get(ctx.schoolId);
    var limits = Submission.limits(settings, rc.assessment);
    var clean = FileCheck.sanitizeName(req.fileName);
    if (!clean.ext) Errors.raise('FILE_NAME_INVALID', 'ไฟล์ต้องมีนามสกุล เช่น .pdf');
    if (limits.allowedTypes.indexOf(clean.ext) < 0) {
      Errors.raise('FILE_TYPE_NOT_ALLOWED', 'งานนี้รับเฉพาะ: ' + limits.allowedTypes.join(', '), { allowed: limits.allowedTypes });
    }
    var size = Number(req.size);
    if (!(size > 0) || Math.floor(size) !== size) Errors.raise('VALIDATION', 'ขนาดไฟล์ไม่ถูกต้อง');
    if (size > limits.maxFileBytes) Errors.raise('FILE_TOO_LARGE', 'ไฟล์ต้องไม่เกิน ' + limits.maxFileMb + ' MB', { maxMb: limits.maxFileMb });
    var drafts = rc.submission ? Submission.draftFiles(rc.submission.id).length : 0;
    if (drafts >= limits.maxFiles) Errors.raise('FILE_COUNT_EXCEEDED', 'ส่งได้ไม่เกิน ' + limits.maxFiles + ' ไฟล์ต่อครั้ง');
    Upload._checkQuota(settings, size);

    var fileAssetId = Util.uuid();
    var type = FileCheck.TYPES[clean.ext];
    var url = DriveStore.startResumable({
      name: fileAssetId + '.' + clean.ext,
      mimeType: type.family === 'text' ? 'text/plain' : type.mime,
      parentId: DriveStore.stagingFolderId(),
      size: size,
      description: 'CWK file_asset ' + fileAssetId
    });
    var st = {
      id: Util.uuid().replace(/-/g, ''),
      uid: ctx.user.id, aid: rc.assessment.id, fid: fileAssetId, name: clean.name, ext: clean.ext,
      mime: Util.str(req.mimeType, 100), size: size, url: url, recv: 0, done: false, driveId: '', meta: null,
      headOk: false, result: null, created: now
    };
    Upload._save(st);
    return { uploadId: st.id, chunkSize: APP.UPLOAD_CHUNK_BYTES, fileAssetId: fileAssetId, name: clean.name };
  },

  _checkQuota: function (settings, size) {
    var usage = DriveStore.usage();
    if (usage.limit > 0 && usage.used + size > usage.limit * 0.98) Errors.raise('QUOTA_EXCEEDED', 'พื้นที่ Google Drive ของระบบใกล้เต็ม กรุณาแจ้งผู้ดูแล');
    if (Number(settings.quota_total_mb) > 0) {
      var appUsed = Number(PropertiesService.getScriptProperties().getProperty('USAGE_BYTES') || 0);
      if (appUsed + size > Number(settings.quota_total_mb) * 1024 * 1024) Errors.raise('QUOTA_EXCEEDED');
    }
  },

  chunk: function (ctx, req) {
    var st = Upload._state(ctx, req.uploadId);
    if (st.result && !st.result.accepted) Errors.raise(st.result.code || 'FILE_REJECTED', st.result.message);
    if (st.done) return { received: st.size, done: true };
    var offset = Number(req.offset);
    if (offset < st.recv) return { received: st.recv, done: false, duplicate: true };
    if (offset > st.recv) Errors.raise('UPLOAD_OUT_OF_ORDER', null, { received: st.recv });
    var bytes = Utilities.base64Decode(String(req.data || ''));
    if (!bytes.length) Errors.raise('VALIDATION', 'ไม่มีข้อมูลไฟล์');
    if (bytes.length > APP.UPLOAD_CHUNK_BYTES) Errors.raise('VALIDATION', 'ช่วงข้อมูลใหญ่เกินกำหนด');
    if (offset + bytes.length > st.size) Errors.raise('VALIDATION', 'ข้อมูลเกินขนาดไฟล์ที่แจ้งไว้');
    if (offset + bytes.length < st.size && bytes.length % (256 * 1024) !== 0) Errors.raise('VALIDATION', 'ขนาดช่วงข้อมูลไม่ถูกต้อง');

    if (offset === 0) {
      // ตรวจเบื้องต้นจากต้นไฟล์ทันที ไม่ต้องรออัปโหลดครบ
      var head = Util.toUnsigned(bytes.slice(0, 4096));
      var sig = FileCheck.sniff(head);
      var fam = FileCheck.TYPES[st.ext].family;
      var expected = { pdf: 'pdf', jpeg: 'jpeg', png: 'png', webp: 'webp', gif: 'gif', ooxml: 'zip', odf: 'zip', zip: 'zip', text: 'text' }[fam];
      if (sig !== expected && !(expected === 'text' && bytes.length < 16)) {
        st.result = { accepted: false, code: ['exe', 'elf', 'macho'].indexOf(sig) >= 0 ? 'FILE_REJECTED' : 'FILE_SIGNATURE_MISMATCH', message: 'เนื้อหาไฟล์ไม่ตรงกับนามสกุล .' + st.ext };
        Upload._save(st);
        Audit.log(ctx, 'upload.rejected_early', 'file_assets', st.fid, { ext: st.ext, detected: sig });
        Errors.raise(st.result.code, st.result.message);
      }
      st.headOk = true;
    }

    var r;
    try {
      r = DriveStore.putChunk(st.url, bytes, offset, st.size);
    } catch (e) {
      if (Errors.isApp(e) && e.code === 'UPLOAD_EXPIRED') throw e;
      // เน็ต/บริการสะดุด: ถามสถานะจริงจาก Drive เพื่อให้เริ่มส่งต่อจากตำแหน่งที่ถูกต้อง
      try { r = DriveStore.queryResumable(st.url, st.size); } catch (e2) { throw e; }
    }
    st.recv = r.received;
    if (r.done) {
      st.done = true;
      st.driveId = r.meta.id;
      st.meta = { size: Number(r.meta.size), md5: r.meta.md5Checksum || '', sha256: r.meta.sha256Checksum || '' };
    }
    Upload._save(st);
    return { received: st.recv, done: st.done };
  },

  finalize: function (ctx, req) {
    var st = Upload._state(ctx, req.uploadId);
    if (st.result) return st.result;
    var existing = Db.get('file_assets', st.fid);
    if (existing) {
      // เรียกซ้ำหลังบันทึกไปแล้ว (เช่น เน็ตหลุดตอนรอผล) คืนผลเดิม ไม่สร้างแถวซ้ำ
      var ref0 = Db.find('submission_files', { file_asset_id: existing.id })[0] || null;
      return existing.check_status === 'passed'
        ? { accepted: true, file: Submission.fileDto(existing, ref0), submissionId: ref0 ? ref0.submission_id : '' }
        : { accepted: false, code: 'FILE_REJECTED', message: ERR.FILE_REJECTED + ' (' + existing.check_detail + ')' };
    }
    if (!st.done) {
      var q = DriveStore.queryResumable(st.url, st.size);
      if (!q.done) Errors.raise('FILE_NOT_READY', 'ไฟล์ยังอัปโหลดไม่ครบ (' + q.received + '/' + st.size + ' ไบต์)', { received: q.received });
      st.done = true; st.driveId = q.meta.id;
      st.meta = { size: Number(q.meta.size), md5: q.meta.md5Checksum || '', sha256: q.meta.sha256Checksum || '' };
    }
    var settings = Settings.get(ctx.schoolId);
    var a = Db.get('assessments', st.aid);
    var limits = Submission.limits(settings, a);
    // ตรวจไฟล์ฉบับสมบูรณ์
    var check;
    if (st.meta.size !== st.size) {
      check = { ok: false, code: 'UPLOAD_FAILED', reason: 'ขนาดไฟล์ที่ได้รับไม่ตรงกับที่แจ้ง', detected: '' };
    } else {
      var head = Util.toUnsigned(DriveStore.readRange(st.driveId, 0, Math.min(st.size, 4096) - 1));
      var fam = FileCheck.TYPES[st.ext].family;
      var tail = null, tailOffset = 0;
      if (fam === 'ooxml' || fam === 'odf' || fam === 'zip') {
        tailOffset = Math.max(0, st.size - 65557 - 1024);
        tail = Util.toUnsigned(DriveStore.readRange(st.driveId, tailOffset, st.size - 1));
      }
      if (fam === 'text' && st.size > 4096) head = Util.toUnsigned(DriveStore.readRange(st.driveId, 0, Math.min(st.size, 65536) - 1));
      check = FileCheck.check({
        ext: st.ext, size: st.size, head: head, tail: tail, tailOffset: tailOffset,
        fetchRange: function (off, len) { return Util.toUnsigned(DriveStore.readRange(st.driveId, off, off + len - 1)); },
        limits: {
          maxBytes: limits.maxFileBytes,
          zipMaxEntries: settings.zip_max_entries,
          zipMaxUncompressedBytes: settings.zip_max_uncompressed_mb * 1024 * 1024
        }
      });
    }
    var sha = st.meta.sha256 || DriveStore.sha256(st.driveId, st.size);
    var base = {
      id: st.fid, school_id: ctx.schoolId, drive_file_id: st.driveId, storage_name: st.fid + '.' + st.ext,
      original_name: st.name, extension: st.ext, declared_mime: st.mime, detected_type: check.detected || '',
      size_bytes: st.size, sha256: sha, md5: st.meta.md5, uploaded_by_user_id: ctx.user.id, purpose: 'submission',
      offering_id: a.offering_id, assessment_id: a.id
    };
    var result;
    if (!check.ok) {
      Db.tx('upload.quarantine', function (tx) {
        tx.insert('file_assets', Object.assign({}, base, { state: 'quarantined', check_status: 'rejected', check_detail: check.reason }));
      }, { actorId: ctx.user.id });
      try { DriveStore.move(st.driveId, DriveStore.folderId('QUARANTINE')); } catch (e) { console.warn('quarantine move later: ' + e); }
      Audit.log(ctx, 'upload.quarantined', 'file_assets', st.fid, { reason: check.reason, detected: check.detected });
      result = { accepted: false, code: check.code || 'FILE_REJECTED', message: (ERR[check.code] || ERR.FILE_REJECTED) + (check.reason ? ' (' + check.reason + ')' : '') };
    } else {
      try {
        Groups.preFreeze(st.aid);
        result = Db.tx('upload.finalize', function (tx) {
          var rc = Submission.resolve(ctx, st.aid, true);
          if (rc.groupSet) Groups.freezeSetIfClosed(tx, rc.groupSet);
          Submission.checkWritable(rc, tx.now, false);
          var sub = rc.submission ? tx.get('submissions', rc.submission.id) : null;
          if (!sub) sub = tx.insert('submissions', { assessment_id: a.id, offering_id: a.offering_id, owner_type: rc.ownerType, owner_id: rc.ownerId, status: 'draft', current_version_no: 0 });
          var drafts = tx.find('submission_files', { submission_id: sub.id, state: 'draft' });
          if (drafts.length >= limits.maxFiles) Errors.raise('FILE_COUNT_EXCEEDED');
          var asset = tx.insert('file_assets', Object.assign({}, base, { state: 'staging', check_status: 'passed', check_detail: check.utf8 === false ? 'non-utf8 text' : '' }));
          var ref = tx.insert('submission_files', { submission_id: sub.id, submission_version_id: '', file_asset_id: asset.id, added_by_user_id: ctx.user.id, state: 'draft', sort: drafts.length + 1 });
          return { accepted: true, file: Submission.fileDto(asset, ref), submissionId: sub.id };
        }, { actorId: ctx.user.id });
        var props = PropertiesService.getScriptProperties();
        props.setProperty('USAGE_BYTES', String(Number(props.getProperty('USAGE_BYTES') || 0) + st.size));
      } catch (e) {
        if (!Errors.isApp(e)) throw e;
        // บันทึกไม่ได้ (เช่น เกินจำนวนไฟล์/ปิดรับแล้ว) → ทิ้งไฟล์ใน staging ให้งานล้างไฟล์กำพร้าจัดการ
        try { DriveStore.trash(st.driveId); } catch (e2) { console.warn(e2); }
        result = { accepted: false, code: e.code, message: e.message };
      }
    }
    st.result = result;
    Upload._save(st);
    return result;
  }
};
