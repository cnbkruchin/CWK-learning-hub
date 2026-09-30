/**
 * ที่เก็บไฟล์บน Google Drive
 *
 * - ไฟล์ทั้งหมดอยู่ในโฟลเดอร์ส่วนตัวของบัญชีเจ้าของสคริปต์ ไม่แชร์ ไม่เปิดสาธารณะ
 * - ผู้ใช้เข้าถึงไฟล์ผ่านระบบเท่านั้น (ตรวจสิทธิ์ก่อนทุกครั้ง แล้วส่งข้อมูลเป็นช่วงผ่าน google.script.run)
 * - ตัวเชื่อมถาวรคือ drive_file_id ในตาราง file_assets การย้ายโฟลเดอร์หรือเปลี่ยนชื่อไม่ทำให้ลิงก์หลักฐานเสีย
 * - อัปโหลดด้วย Drive API แบบ resumable ทีละช่วง (chunk) เพื่อรองรับไฟล์ใหญ่และแสดงความคืบหน้าได้
 *
 * โครงสร้างโฟลเดอร์จริง (สำหรับผู้ดูแลกู้คืนด้วยมือ ผู้ใช้เห็นโฟลเดอร์เสมือนจากฐานข้อมูล)
 *   04_files/<ปีการศึกษา>-<ภาค>/<รหัสวิชา>_<กลุ่มเรียน>_<รหัสย่อ>/<รหัสงาน>_<รหัสย่อ>/<file_asset_id>.<ext>
 *   02_staging/<YYYY-MM-DD>/<file_asset_id>.<ext>     ไฟล์ที่อัปโหลดแล้วแต่ยังไม่กดส่ง
 *   03_quarantine/<file_asset_id>.<ext>                ไฟล์ที่ตรวจไม่ผ่าน
 */
var DriveStore = {
  UPLOAD_URL: 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&fields=id,size,md5Checksum,sha256Checksum,mimeType',
  FILES_URL: 'https://www.googleapis.com/drive/v3/files/',

  folderId: function (key) {
    var id = Props.get('FOLDER_' + key);
    if (!id) Errors.raise('SETUP_REQUIRED');
    return id;
  },

  /** หา/สร้างโฟลเดอร์ย่อยตามชื่อ (จำรหัสไว้ใน cache) */
  childFolderId: function (parentId, name) {
    var cache = CacheService.getScriptCache();
    var key = 'fld:' + parentId + ':' + Crypto.hex(Crypto.sha256(Crypto.utf8(name))).slice(0, 32);
    var cached = cache.get(key);
    if (cached) return cached;
    var parent = DriveApp.getFolderById(parentId);
    var it = parent.getFoldersByName(name);
    var folder = it.hasNext() ? it.next() : parent.createFolder(name);
    cache.put(key, folder.getId(), 21600);
    return folder.getId();
  },

  stagingFolderId: function () {
    return DriveStore.childFolderId(DriveStore.folderId('STAGING'), Util.dateKey());
  },

  safeFolderName: function (s) {
    return String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 80);
  },

  /** โฟลเดอร์ของภาระงาน (สร้างเมื่อจำเป็น) */
  assessmentFolderId: function (offering, assessment) {
    var term = Db.get('terms', offering.term_id);
    var year = term ? Db.get('academic_years', term.academic_year_id) : null;
    var course = Db.get('courses', offering.course_id);
    var termName = (year ? year.year_be : 'ปี') + '-' + (term ? term.term_no : 'ภาค');
    var termFolder = DriveStore.childFolderId(DriveStore.folderId('FILES'), termName);
    var offName = DriveStore.safeFolderName((course ? course.course_code : 'วิชา') + '_' + offering.section_code + '_' + offering.id.slice(0, 8));
    var offFolder = DriveStore.childFolderId(termFolder, offName);
    return DriveStore.childFolderId(offFolder, DriveStore.safeFolderName(assessment.code + '_' + assessment.id.slice(0, 8)));
  },

  authHeaders: function () {
    return { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() };
  },

  header: function (resp, name) {
    var h = resp.getHeaders() || {};
    var lower = name.toLowerCase();
    for (var k in h) if (k.toLowerCase() === lower) return h[k];
    return null;
  },

  startResumable: function (meta) {
    var headers = DriveStore.authHeaders();
    headers['X-Upload-Content-Type'] = meta.mimeType;
    headers['X-Upload-Content-Length'] = String(meta.size);
    var resp = UrlFetchApp.fetch(DriveStore.UPLOAD_URL, {
      method: 'post',
      contentType: 'application/json; charset=UTF-8',
      headers: headers,
      payload: JSON.stringify({ name: meta.name, mimeType: meta.mimeType, parents: [meta.parentId], description: meta.description || '' }),
      muteHttpExceptions: true
    });
    var loc = DriveStore.header(resp, 'Location');
    if (resp.getResponseCode() !== 200 || !loc) {
      console.error('resumable start failed: ' + resp.getResponseCode());
      Errors.raise('UPLOAD_FAILED');
    }
    return loc;
  },

  _parseRange: function (resp) {
    var r = DriveStore.header(resp, 'Range');
    if (!r) return 0;
    var m = String(r).match(/bytes=0-(\d+)/);
    return m ? Number(m[1]) + 1 : 0;
  },

  _finish: function (resp) {
    var code = resp.getResponseCode();
    if (code === 200 || code === 201) return { done: true, meta: JSON.parse(resp.getContentText()) };
    if (code === 308) return { done: false, received: DriveStore._parseRange(resp) };
    if (code === 404 || code === 410) Errors.raise('UPLOAD_EXPIRED');
    console.error('resumable chunk failed: ' + code);
    Errors.raise('UPLOAD_FAILED');
  },

  /** ส่งหนึ่งช่วงไฟล์ (bytes เป็นไบต์แบบมีเครื่องหมายจาก Utilities.base64Decode) */
  putChunk: function (url, bytes, offset, total) {
    var headers = DriveStore.authHeaders();
    headers['Content-Range'] = 'bytes ' + offset + '-' + (offset + bytes.length - 1) + '/' + total;
    var resp = UrlFetchApp.fetch(url, {
      method: 'put',
      contentType: 'application/octet-stream',
      headers: headers,
      payload: bytes,
      muteHttpExceptions: true
    });
    var r = DriveStore._finish(resp);
    if (r.done) r.received = total;
    return r;
  },

  queryResumable: function (url, total) {
    var headers = DriveStore.authHeaders();
    headers['Content-Range'] = 'bytes */' + total;
    var resp = UrlFetchApp.fetch(url, { method: 'put', headers: headers, muteHttpExceptions: true });
    var r = DriveStore._finish(resp);
    if (r.done) r.received = total;
    return r;
  },

  meta: function (driveFileId) {
    var resp = UrlFetchApp.fetch(DriveStore.FILES_URL + encodeURIComponent(driveFileId) +
      '?supportsAllDrives=true&fields=id,name,size,mimeType,md5Checksum,sha256Checksum', {
      headers: DriveStore.authHeaders(), muteHttpExceptions: true
    });
    if (resp.getResponseCode() !== 200) Errors.raise('NOT_FOUND', 'ไม่พบไฟล์ในที่เก็บ');
    return JSON.parse(resp.getContentText());
  },

  /** อ่านช่วงไบต์ [start, end] (รวมปลาย) คืนไบต์แบบมีเครื่องหมาย */
  readRange: function (driveFileId, start, end) {
    var headers = DriveStore.authHeaders();
    headers.Range = 'bytes=' + start + '-' + end;
    var resp = UrlFetchApp.fetch(DriveStore.FILES_URL + encodeURIComponent(driveFileId) + '?alt=media&supportsAllDrives=true', {
      headers: headers, muteHttpExceptions: true
    });
    var code = resp.getResponseCode();
    if (code !== 206 && code !== 200) Errors.raise('NOT_FOUND', 'อ่านไฟล์ไม่สำเร็จ');
    var bytes = resp.getContent();
    if (code === 200 && (start > 0 || bytes.length > end - start + 1)) bytes = bytes.slice(start, end + 1);
    return bytes;
  },

  /** คำนวณ SHA-256 ทีละช่วง (ใช้เมื่อ Drive ไม่คืน sha256Checksum) */
  sha256: function (driveFileId, size) {
    var h = new Crypto.Hasher();
    var step = 4 * 1024 * 1024;
    for (var off = 0; off < size; off += step) {
      h.update(DriveStore.readRange(driveFileId, off, Math.min(size, off + step) - 1));
    }
    return Crypto.hex(h.digest());
  },

  move: function (driveFileId, folderId) {
    DriveApp.getFileById(driveFileId).moveTo(DriveApp.getFolderById(folderId));
  },

  trash: function (driveFileId) {
    DriveApp.getFileById(driveFileId).setTrashed(true);
  },

  usage: function () {
    return { used: DriveApp.getStorageUsed(), limit: DriveApp.getStorageLimit() };
  }
};
