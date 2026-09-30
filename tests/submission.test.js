'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('crypto');
const { call, ok, upload, plain } = require('./harness/load');
const { fixture, idemKey } = require('./harness/fixture');
const S = require('./harness/samples');

const sha = (buf) => nodeCrypto.createHash('sha256').update(buf).digest('hex');

function submit(f, user, assessmentId, extra = {}) {
  const d = ok(f.g, 'student.assessment', { assessmentId }, f.t(user));
  return call(f.g, 'submission.submit', Object.assign({ assessmentId, baseVersionNo: d.currentVersionNo, idempotencyKey: idemKey() }, extra), f.t(user));
}

test('A11 อัปโหลดรูป PDF เอกสาร แล้วส่ง ได้ใบยืนยัน; ส่งใหม่สร้างรุ่น 2 และรุ่น 1 ยังอยู่ครบ', () => {
  const f = fixture();
  const tok = f.t('00121');
  const pdfBuf = S.pdf(3 * 1024 * 1024 + 123); // มากกว่า 1 ช่วง (chunk 2 MiB)
  for (const [name, buf] of [['รายงาน.pdf', pdfBuf], ['ภาพผังงาน.png', S.png(5000)], ['สรุป.docx', S.docx()]]) {
    const r = upload(f.g, tok, f.W1, name, buf);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.data.accepted, true, JSON.stringify(r.data));
  }
  let d = ok(f.g, 'student.assessment', { assessmentId: f.W1 }, tok);
  assert.equal(d.status, 'draft', 'อัปโหลดเสร็จยังไม่ถือว่าส่ง');
  assert.equal(d.draftFiles.length, 3);
  const teacherView = ok(f.g, 'teacher.submissions', { assessmentId: f.W1 }, f.t('demo_t001'));
  assert.equal(teacherView.counts.submitted, 0);

  const r1 = submit(f, '00121', f.W1, { comment: 'ส่งครั้งแรก' });
  assert.equal(r1.ok, true, JSON.stringify(r1));
  assert.match(r1.data.receiptCode, /^CWK-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(r1.data.versionNo, 1);
  assert.equal(r1.data.files.length, 3);
  assert.equal(r1.data.files[0].sha256, sha(pdfBuf));
  assert.ok(Math.abs(Date.parse(r1.data.submittedAt) - Date.now()) < 5000, 'ใช้เวลาเซิร์ฟเวอร์');
  assert.match(r1.data.submittedAtText, /\/25\d\d /, 'แสดงปี พ.ศ.');

  const r = upload(f.g, tok, f.W1, 'แก้ไข.pdf', S.pdf(900));
  assert.equal(r.data.accepted, true);
  const r2 = submit(f, '00121', f.W1);
  assert.equal(r2.data.versionNo, 2);
  d = ok(f.g, 'student.assessment', { assessmentId: f.W1 }, tok);
  assert.equal(d.versions.length, 2);
  const v1 = d.versions.find((v) => v.versionNo === 1);
  assert.equal(v1.files.length, 3, 'รุ่นเดิมยังเก็บไฟล์ครบ');
  assert.equal(v1.comment, 'ส่งครั้งแรก');
  assert.equal(d.versions.find((v) => v.versionNo === 2).files.length, 1);
  assert.equal(d.status, 'submitted');
});

test('ไฟล์จริงเก็บใน Drive โฟลเดอร์ของงาน ชื่อไฟล์เป็นรหัสภายใน ไม่ใช่ชื่อที่นักเรียนตั้ง', () => {
  const f = fixture();
  const r = upload(f.g, f.t('00121'), f.W1, '../../ชื่อแปลก<>.pdf', S.pdf());
  const asset = f.g.Db.get('file_assets', r.data.file.fileAssetId);
  assert.equal(asset.original_name, 'ชื่อแปลก__.pdf');
  assert.equal(asset.storage_name, asset.id + '.pdf');
  const file = f.g.DriveApp.getFileById(asset.drive_file_id);
  assert.equal(file.getName(), asset.id + '.pdf');
  const staging = f.g.PropertiesService.getScriptProperties().getProperty('FOLDER_STAGING');
  assert.equal(file.parent.parent.id, staging, 'ก่อนส่งอยู่ใน staging/<วันที่>');
  submit(f, '00121', f.W1);
  const path = [];
  for (let p = file.parent; p; p = p.parent) path.unshift(p.name);
  assert.equal(path[2], '04_files');
  assert.equal(path[3], '2569-1');
  assert.match(path[4], /^ว32201_ม\.5_1_/);
  assert.match(path[5], /^W1_/);
  assert.equal(f.g.Db.get('file_assets', asset.id).state, 'stored');
});

test('A12 เกินขนาด ชนิดไม่อนุญาต ปลอมชนิด และไฟล์ปฏิบัติการ ถูกปฏิเสธก่อนหรือระหว่างอัปโหลด', () => {
  const f = fixture();
  const tok = f.t('00121');
  const big = call(f.g, 'upload.begin', { assessmentId: f.W1, fileName: 'big.pdf', size: 26 * 1024 * 1024 }, tok);
  assert.equal(big.error.code, 'FILE_TOO_LARGE');
  const txt = call(f.g, 'upload.begin', { assessmentId: f.W1, fileName: 'note.txt', size: 10 }, tok);
  assert.equal(txt.error.code, 'FILE_TYPE_NOT_ALLOWED');
  assert.ok(txt.error.details.allowed.includes('pdf'));
  const spoof = upload(f.g, tok, f.W1, 'fake.pdf', S.png());
  assert.equal(spoof.error.code, 'FILE_SIGNATURE_MISMATCH');
  const exe = upload(f.g, tok, f.W1, 'virus.pdf', S.exe());
  assert.equal(exe.error.code, 'FILE_REJECTED');
  const noext = call(f.g, 'upload.begin', { assessmentId: f.W1, fileName: 'README', size: 10 }, tok);
  assert.equal(noext.error.code, 'FILE_NAME_INVALID');
  assert.equal(f.g.Db.all('file_assets').length, 0, 'ไม่มีไฟล์ถูกบันทึก');
  assert.equal(ok(f.g, 'student.assessment', { assessmentId: f.W1 }, tok).draftFiles.length, 0);
});

test('A12 ไฟล์ผ่านช่วงแรกแต่โครงสร้างไม่ผ่าน (มีมาโคร) ถูกกักไว้ ไม่เข้าฉบับร่าง และส่งไม่ได้', () => {
  const f = fixture();
  const tok = f.t('00121');
  const r = upload(f.g, tok, f.W1, 'macro.docx', S.docx([{ name: 'word/vbaProject.bin', data: 'x' }]));
  assert.equal(r.ok, true);
  assert.equal(r.data.accepted, false);
  assert.match(r.data.message, /มาโคร/);
  const asset = f.g.Db.all('file_assets')[0];
  assert.equal(asset.state, 'quarantined');
  assert.equal(asset.check_status, 'rejected');
  const file = f.g.DriveApp.getFileById(asset.drive_file_id);
  assert.equal(file.parent.id, f.g.PropertiesService.getScriptProperties().getProperty('FOLDER_QUARANTINE'));
  assert.equal(ok(f.g, 'student.assessment', { assessmentId: f.W1 }, tok).draftFiles.length, 0);
  const s = call(f.g, 'submission.submit', { assessmentId: f.W1, baseVersionNo: 0, idempotencyKey: idemKey(), fileAssetIds: [asset.id] }, tok);
  assert.equal(s.error.code, 'FILE_NOT_READY');
  assert.equal(call(f.g, 'files.open', { fileAssetId: asset.id }, tok).error.code, 'NOT_FOUND', 'นักเรียนเปิดไฟล์ที่ถูกกักไม่ได้');
});

test('อัปโหลดไม่ครบ (เน็ตหลุด) ต้องไม่แสดงว่าสำเร็จ และส่งงานไม่ได้; ส่งช่วงเดิมซ้ำไม่ทำให้ไฟล์เสีย', () => {
  const f = fixture();
  const tok = f.t('00121');
  const buf = S.pdf(5 * 1024 * 1024);
  const part = upload(f.g, tok, f.W1, 'big.pdf', buf, { stopAfterFirstChunk: true });
  const fin = call(f.g, 'upload.finalize', { uploadId: part.data.uploadId }, tok);
  assert.equal(fin.error.code, 'FILE_NOT_READY');
  assert.equal(submit(f, '00121', f.W1).error.code, 'NOTHING_TO_SUBMIT');
  // ส่งช่วงแรกซ้ำ (เหมือนกดลองใหม่หลังเน็ตหลุด) แล้วส่งต่อจนครบ
  const chunk = 2 * 1024 * 1024;
  const again = ok(f.g, 'upload.chunk', { uploadId: part.data.uploadId, offset: 0, data: buf.subarray(0, chunk).toString('base64') }, tok);
  assert.equal(again.duplicate, true);
  const skip = call(f.g, 'upload.chunk', { uploadId: part.data.uploadId, offset: chunk * 2, data: buf.subarray(chunk * 2).toString('base64') }, tok);
  assert.equal(skip.error.code, 'UPLOAD_OUT_OF_ORDER');
  let offset = again.received;
  while (offset < buf.length) {
    offset = ok(f.g, 'upload.chunk', { uploadId: part.data.uploadId, offset, data: buf.subarray(offset, offset + chunk).toString('base64') }, tok).received;
  }
  const done = ok(f.g, 'upload.finalize', { uploadId: part.data.uploadId }, tok);
  assert.equal(done.accepted, true);
  assert.equal(done.file.sha256, sha(buf));
  // เรียก finalize ซ้ำได้ผลเดิม ไม่สร้างแถวซ้ำ
  ok(f.g, 'upload.finalize', { uploadId: part.data.uploadId }, tok);
  assert.equal(f.g.Db.all('file_assets').length, 1);
});

test('A22 กดส่งซ้ำ (idempotency key เดิม) ได้ใบยืนยันเดิม ไม่สร้างรุ่นซ้ำ; รุ่นฐานไม่ตรงได้ CONFLICT', () => {
  const f = fixture();
  const tok = f.t('00121');
  upload(f.g, tok, f.W1, 'a.pdf', S.pdf());
  const key = idemKey();
  const a = ok(f.g, 'submission.submit', { assessmentId: f.W1, baseVersionNo: 0, idempotencyKey: key }, tok);
  f.g.CacheService.getScriptCache()._map.clear(); // จำลองแคชหาย ต้องพึ่งตาราง idempotency_keys
  const tok2 = f.t('00121');
  void tok2;
  const b = call(f.g, 'submission.submit', { assessmentId: f.W1, baseVersionNo: 0, idempotencyKey: key }, tok);
  // แคชหายทำให้ session หายด้วย → เข้าสู่ระบบใหม่แล้วส่งซ้ำ
  assert.equal(b.error.code, 'SESSION_EXPIRED');
  const tok3 = ok(f.g, 'auth.login', { username: '00121', password: f.accounts['00121'] }).token;
  const c = ok(f.g, 'submission.submit', { assessmentId: f.W1, baseVersionNo: 0, idempotencyKey: key }, tok3);
  assert.equal(c.replayed, true);
  assert.equal(c.receiptCode, a.receiptCode);
  assert.equal(f.g.Db.all('submission_versions').length, 1);
  upload(f.g, tok3, f.W1, 'b.pdf', S.pdf());
  const stale = call(f.g, 'submission.submit', { assessmentId: f.W1, baseVersionNo: 0, idempotencyKey: idemKey() }, tok3);
  assert.equal(stale.error.code, 'CONFLICT');
  assert.equal(stale.error.details.currentVersionNo, 1);
});

test('เวลา: ก่อนเปิดรับ ส่งช้า ปิดรับ และขยายเวลารายบุคคล (ตรวจด้วยเวลาเซิร์ฟเวอร์)', () => {
  const f = fixture();
  f.patchAssessment('W1', { open_at: f.iso(1) });
  assert.equal(call(f.g, 'upload.begin', { assessmentId: f.W1, fileName: 'a.pdf', size: 10 }, f.t('00121')).error.code, 'SUBMISSION_NOT_OPEN');
  f.patchAssessment('W1', { open_at: f.iso(-5), due_at: f.iso(-1), close_at: f.iso(2), allow_late: true });
  upload(f.g, f.t('00121'), f.W1, 'a.pdf', S.pdf());
  const late = ok(f.g, 'submission.submit', { assessmentId: f.W1, baseVersionNo: 0, idempotencyKey: idemKey() }, f.t('00121'));
  assert.equal(late.isLate, true);
  assert.ok(late.lateSeconds >= 86000);
  const list = ok(f.g, 'student.assessments', { offeringId: f.offA }, f.t('00121'));
  assert.equal(list.find((a) => a.id === f.W1).status, 'late');
  // ปิดรับแล้ว
  f.patchAssessment('W1', { close_at: f.iso(-0.5) });
  assert.equal(call(f.g, 'upload.begin', { assessmentId: f.W1, fileName: 'a.pdf', size: 10 }, f.t('00122')).error.code, 'SUBMISSION_CLOSED');
  // ไม่อนุญาตส่งช้า: ปิดที่กำหนดส่ง
  f.patchAssessment('W1', { allow_late: false, close_at: f.iso(3) });
  assert.equal(call(f.g, 'upload.begin', { assessmentId: f.W1, fileName: 'a.pdf', size: 10 }, f.t('00122')).error.code, 'SUBMISSION_CLOSED');
  // ครูขยายเวลาให้ 00122 คนเดียว
  ok(f.g, 'teacher.grantExtension', { assessmentId: f.W1, targetType: 'student', targetId: f.studentId('00122'), dueAt: f.iso(2), reason: 'ป่วย มีใบรับรองแพทย์' }, f.t('demo_t001'));
  const r = upload(f.g, f.t('00122'), f.W1, 'a.pdf', S.pdf());
  assert.equal(r.data.accepted, true);
  const ontime = ok(f.g, 'submission.submit', { assessmentId: f.W1, baseVersionNo: 0, idempotencyKey: idemKey() }, f.t('00122'));
  assert.equal(ontime.isLate, false);
  assert.equal(call(f.g, 'upload.begin', { assessmentId: f.W1, fileName: 'a.pdf', size: 10 }, f.t('00123')).error.code, 'SUBMISSION_CLOSED');
});

test('จำนวนครั้งที่ส่งได้ และการส่งคืนแก้ไขเปิดให้ส่งใหม่ได้ (สถานะ "ส่งใหม่ รอพิจารณา")', () => {
  const f = fixture();
  f.patchAssessment('W1', { max_attempts: 1 });
  upload(f.g, f.t('00121'), f.W1, 'a.pdf', S.pdf());
  const v1 = ok(f.g, 'submission.submit', { assessmentId: f.W1, baseVersionNo: 0, idempotencyKey: idemKey() }, f.t('00121'));
  upload(f.g, f.t('00121'), f.W1, 'b.pdf', S.pdf());
  assert.equal(submit(f, '00121', f.W1).error.code, 'ATTEMPTS_EXCEEDED');
  const miss = call(f.g, 'teacher.review', { versionId: v1.versionId, action: 'return', note: '' }, f.t('demo_t001'));
  assert.equal(miss.error.code, 'VALIDATION', 'ส่งคืนต้องระบุสิ่งที่ต้องแก้');
  ok(f.g, 'teacher.review', { versionId: v1.versionId, action: 'return', note: 'เพิ่มคำอธิบายขั้นตอนที่ 3' }, f.t('demo_t001'));
  let d = ok(f.g, 'student.assessment', { assessmentId: f.W1 }, f.t('00121'));
  assert.equal(d.status, 'returned');
  assert.equal(d.versions[0].reviewNote, 'เพิ่มคำอธิบายขั้นตอนที่ 3');
  const v2 = submit(f, '00121', f.W1);
  assert.equal(v2.ok, true);
  d = ok(f.g, 'student.assessment', { assessmentId: f.W1 }, f.t('00121'));
  assert.equal(d.status, 'resubmitted');
  assert.equal(d.versions.find((v) => v.versionNo === 1).reviewStatus, 'returned', 'ประวัติการตรวจรุ่นเดิมยังอยู่');
  const notes = ok(f.g, 'notify.list', {}, f.t('00121'));
  assert.ok(notes.some((n) => n.type === 'returned'));
  assert.ok(notes.every((n) => !/คะแนน\s*\d/.test(n.body)), 'แจ้งเตือนไม่มีคะแนน');
});

test('A13 นักเรียนเรียก API/URL ของคนอื่น: ไม่เห็นไฟล์ งาน หรือแฟ้มของผู้อื่น', () => {
  const f = fixture();
  const r = upload(f.g, f.t('00121'), f.W1, 'mine.pdf', S.pdf());
  const fileId = r.data.file.fileAssetId;
  const sub = ok(f.g, 'submission.submit', { assessmentId: f.W1, baseVersionNo: 0, idempotencyKey: idemKey() }, f.t('00121'));
  const other = f.t('00122');
  assert.equal(call(f.g, 'files.open', { fileAssetId: fileId }, other).error.code, 'NOT_FOUND');
  assert.equal(call(f.g, 'submission.detail', { submissionId: sub.submissionId }, other).error.code, 'FORBIDDEN');
  assert.equal(call(f.g, 'files.studentFolder', { offeringId: f.offA, studentId: f.studentId('00121') }, other).error.code, 'FORBIDDEN');
  assert.equal(call(f.g, 'teacher.submissions', { assessmentId: f.W1 }, other).error.code, 'FORBIDDEN');
  // ใช้ตั๋วดาวน์โหลดของคนอื่น
  const ticket = ok(f.g, 'files.open', { fileAssetId: fileId }, f.t('00121')).ticket;
  assert.equal(call(f.g, 'files.chunk', { ticket, index: 0 }, other).error.code, 'FORBIDDEN');
  // ใช้ uploadId ของคนอื่น
  const b = ok(f.g, 'upload.begin', { assessmentId: f.W1, fileName: 'x.pdf', size: 100 }, f.t('00121'));
  assert.equal(call(f.g, 'upload.chunk', { uploadId: b.uploadId, offset: 0, data: S.pdf(100).toString('base64') }, other).error.code, 'FORBIDDEN');
  // นักเรียนที่ไม่ได้ลงทะเบียนรายวิชา A (00129)
  assert.equal(call(f.g, 'student.assessment', { assessmentId: f.W1 }, f.t('00129')).error.code, 'NOT_ENROLLED');
  assert.equal(call(f.g, 'upload.begin', { assessmentId: f.W1, fileName: 'x.pdf', size: 100 }, f.t('00129')).error.code, 'NOT_ENROLLED');
  // นักเรียนเรียกคำสั่งครู/ผู้ดูแล
  assert.equal(call(f.g, 'teacher.offerings', {}, other).error.code, 'FORBIDDEN');
  assert.equal(call(f.g, 'admin.status', {}, other).error.code, 'FORBIDDEN');
});

test('A14 ครูที่ไม่อยู่รายวิชาถูกปฏิเสธ; ครูร่วมสอนทำได้ตามสิทธิ์ที่ได้รับเท่านั้น', () => {
  const f = fixture();
  upload(f.g, f.t('00121'), f.W1, 'a.pdf', S.pdf());
  const sub = ok(f.g, 'submission.submit', { assessmentId: f.W1, baseVersionNo: 0, idempotencyKey: idemKey() }, f.t('00121'));
  const outsider = f.t('demo_t003');
  assert.equal(call(f.g, 'teacher.submissions', { assessmentId: f.W1 }, outsider).error.code, 'FORBIDDEN');
  assert.equal(call(f.g, 'teacher.review', { versionId: sub.versionId, action: 'accept' }, outsider).error.code, 'FORBIDDEN');
  assert.equal(call(f.g, 'teacher.saveAssessment', { offeringId: f.offA, code: 'X', title: 'x', kind: 'individual', maxScore: 10, weight: 0, countsTowardGrade: false }, outsider).error.code, 'FORBIDDEN');
  assert.equal(call(f.g, 'files.open', { fileAssetId: sub.files.length && f.g.Db.all('file_assets')[0].id }, outsider).error.code, 'NOT_FOUND');
  const before = f.g.Db.get('submission_versions', sub.versionId).review_status;
  assert.equal(before, 'pending', 'ไม่มีข้อมูลเปลี่ยน');
  // ครูร่วมสอน T002: ดูและตรวจได้ แต่แก้ภาระงานไม่ได้
  const co = f.t('demo_t002');
  assert.equal(ok(f.g, 'teacher.submissions', { assessmentId: f.W1 }, co).counts.submitted, 1);
  ok(f.g, 'teacher.review', { versionId: sub.versionId, action: 'accept' }, co);
  assert.equal(call(f.g, 'teacher.saveAssessment', { offeringId: f.offA, code: 'X', title: 'x', kind: 'individual', maxScore: 10, weight: 0, countsTowardGrade: false }, co).error.code, 'FORBIDDEN');
  const offs = ok(f.g, 'teacher.offerings', {}, co);
  const a = offs.find((o) => o.offeringId === f.offA);
  assert.equal(a.isOwner, false);
  assert.equal(a.perms.can_close, false);
});

test('ดาวน์โหลดผ่านตั๋วชั่วคราวทีละช่วง ได้ไฟล์ตรงกับต้นฉบับ (SHA-256)', () => {
  const f = fixture();
  const buf = S.pdf(7 * 1024 * 1024 + 11);
  const r = upload(f.g, f.t('00121'), f.W1, 'big.pdf', buf);
  ok(f.g, 'submission.submit', { assessmentId: f.W1, baseVersionNo: 0, idempotencyKey: idemKey() }, f.t('00121'));
  const teacher = f.t('demo_t001');
  const open = ok(f.g, 'files.open', { fileAssetId: r.data.file.fileAssetId }, teacher);
  assert.equal(open.preview, 'pdf');
  assert.equal(open.mime, 'application/pdf');
  const parts = [];
  for (let i = 0; i < open.chunks; i++) parts.push(Buffer.from(ok(f.g, 'files.chunk', { ticket: open.ticket, index: i }, teacher).data, 'base64'));
  assert.equal(sha(Buffer.concat(parts)), sha(buf));
  assert.equal(call(f.g, 'files.chunk', { ticket: 'nope', index: 0 }, teacher).error.code, 'SESSION_EXPIRED');
});

test('ลบไฟล์ออกจากฉบับร่าง และนำไฟล์รุ่นก่อนมาใช้ใหม่โดยไม่คัดลอกไฟล์ซ้ำ', () => {
  const f = fixture();
  const tok = f.t('00121');
  const a = upload(f.g, tok, f.W1, 'a.pdf', S.pdf());
  const b = upload(f.g, tok, f.W1, 'b.png', S.png());
  ok(f.g, 'submission.removeDraft', { assessmentId: f.W1, refId: b.data.file.refId }, tok);
  const v1 = ok(f.g, 'submission.submit', { assessmentId: f.W1, baseVersionNo: 0, idempotencyKey: idemKey() }, tok);
  assert.deepEqual(v1.files.map((x) => x.name), ['a.pdf']);
  const assets = f.g.Db.all('file_assets').length;
  ok(f.g, 'submission.copyToDraft', { assessmentId: f.W1, versionId: v1.versionId }, tok);
  const d = ok(f.g, 'student.assessment', { assessmentId: f.W1 }, tok);
  assert.equal(d.draftFiles.length, 1);
  assert.equal(d.draftFiles[0].fileAssetId, a.data.file.fileAssetId);
  assert.equal(f.g.Db.all('file_assets').length, assets);
  const v2 = ok(f.g, 'submission.submit', { assessmentId: f.W1, baseVersionNo: 1, idempotencyKey: idemKey() }, tok);
  assert.equal(v2.versionNo, 2);
});

test('จำนวนไฟล์เกินกำหนดถูกปฏิเสธ และงานสอบไม่เปิดรับไฟล์', () => {
  const f = fixture();
  f.patchAssessment('W1', { max_files: 2 });
  const tok = f.t('00121');
  upload(f.g, tok, f.W1, '1.pdf', S.pdf());
  upload(f.g, tok, f.W1, '2.pdf', S.pdf());
  assert.equal(call(f.g, 'upload.begin', { assessmentId: f.W1, fileName: '3.pdf', size: 100 }, tok).error.code, 'FILE_COUNT_EXCEEDED');
  assert.equal(call(f.g, 'upload.begin', { assessmentId: f.EX1, fileName: '3.pdf', size: 100 }, tok).error.code, 'SUBMISSION_NOT_REQUIRED');
});

test('ย้ายไฟล์บน Drive ล้มเหลวตอนส่ง: การส่งยังสำเร็จ และงานรายชั่วโมงย้ายให้ภายหลัง', () => {
  const f = fixture();
  const r = upload(f.g, f.t('00121'), f.W1, 'a.pdf', S.pdf());
  f.g._drive.failNextMove = true;
  const s = ok(f.g, 'submission.submit', { assessmentId: f.W1, baseVersionNo: 0, idempotencyKey: idemKey() }, f.t('00121'));
  assert.equal(s.versionNo, 1);
  const asset = f.g.Db.get('file_assets', r.data.file.fileAssetId);
  const file = f.g.DriveApp.getFileById(asset.drive_file_id);
  assert.notEqual(file.parent.name.slice(0, 2), 'W1');
  assert.equal(JSON.parse(f.g.PropertiesService.getScriptProperties().getProperty('PENDING_MOVES')).length, 1);
  f.g.Db.reset();
  f.g.Maintenance.hourly();
  assert.match(file.parent.name, /^W1_/);
});

test('แฟ้มเสมือนรายบุคคล: ปี / ภาค / รายวิชา / รหัส-ชื่อ / งาน / รุ่น / ไฟล์', () => {
  const f = fixture();
  upload(f.g, f.t('00121'), f.W1, 'a.pdf', S.pdf());
  ok(f.g, 'submission.submit', { assessmentId: f.W1, baseVersionNo: 0, idempotencyKey: idemKey() }, f.t('00121'));
  const mine = ok(f.g, 'student.folder', { offeringId: f.offA }, f.t('00121'));
  assert.deepEqual(plain(mine.path.slice(0, 2)), ['2569', 'ภาคเรียนที่ 1']);
  assert.match(mine.path[3], /^00121 /);
  const w1 = mine.items.find((i) => i.code === 'W1');
  assert.equal(w1.versions[0].files[0].name, 'a.pdf');
  const teacherView = ok(f.g, 'files.studentFolder', { offeringId: f.offA, studentId: f.studentId('00121') }, f.t('demo_t001'));
  assert.equal(teacherView.items.find((i) => i.code === 'W1').versions.length, 1);
});
