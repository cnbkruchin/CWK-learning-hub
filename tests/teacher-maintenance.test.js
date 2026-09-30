'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { call, ok, upload } = require('./harness/load');
const { fixture, idemKey } = require('./harness/fixture');
const S = require('./harness/samples');

test('ครูสร้างภาระงาน: ตรวจเงื่อนไขที่เซิร์ฟเวอร์ (คะแนนเต็ม น้ำหนัก วันที่ ชนิดไฟล์ เพดานโรงเรียน)', () => {
  const f = fixture();
  const t = f.t('demo_t001');
  const base = { offeringId: f.offA, code: 'W9', title: 'งานทดสอบ', kind: 'individual', maxScore: 10, weight: 5, countsTowardGrade: true };
  const bad = (patch, re) => {
    const r = call(f.g, 'teacher.saveAssessment', Object.assign({}, base, patch), t);
    assert.equal(r.ok, false, JSON.stringify(patch));
    if (re) assert.match(r.error.message, re);
  };
  bad({ maxScore: 0 }, /คะแนนเต็ม/);
  bad({ weight: 0 }, /น้ำหนัก/);
  bad({ weight: -1 }, /ไม่ติดลบ/);
  bad({ openAt: f.iso(5), dueAt: f.iso(1) }, /วันเปิดรับ/);
  bad({ dueAt: f.iso(5), closeAt: f.iso(1) }, /วันปิดรับ/);
  bad({ allowedTypes: 'pdf,exe' }, /ไม่อยู่ในรายการ/);
  bad({ maxFileMb: 100 }, /เพดานของโรงเรียน/);
  bad({ maxFiles: 99 }, /จำนวนไฟล์/);
  bad({ kind: 'group', group: { minSize: 3, maxSize: 2 } }, /สมาชิก/);
  bad({ code: 'W1' }, /ซ้ำ/);
  const a = ok(f.g, 'teacher.saveAssessment', Object.assign({}, base, { allowedTypes: 'pdf', status: 'published' }), t);
  assert.equal(a.submissionMode, 'file');
  const practice = ok(f.g, 'teacher.saveAssessment', Object.assign({}, base, { code: 'P1', countsTowardGrade: false, weight: 30 }), t);
  assert.equal(practice.weight, '0', 'งานฝึกที่ไม่นับคะแนนมีน้ำหนักศูนย์');
  // แก้พร้อมกัน: รุ่นเก่า → CONFLICT
  ok(f.g, 'teacher.saveAssessment', Object.assign({}, base, { id: a.id, version: a.version, title: 'แก้ครั้งที่ 1' }), t);
  assert.equal(call(f.g, 'teacher.saveAssessment', Object.assign({}, base, { id: a.id, version: a.version, title: 'แก้ทับ' }), t).error.code, 'CONFLICT');
  // นักเรียนเห็นเฉพาะงานที่ประกาศแล้ว
  const list = ok(f.g, 'student.assessments', { offeringId: f.offA }, f.t('00121'));
  assert.ok(list.some((x) => x.code === 'W9'));
  assert.ok(!list.some((x) => x.code === 'P1'));
});

test('คิวตรวจงานของครู: นับผู้ส่ง/ส่งช้า/ยังไม่ส่ง จากจำนวนคน ไม่ใช่จำนวนไฟล์', () => {
  const f = fixture();
  upload(f.g, f.t('00121'), f.W1, 'a.pdf', S.pdf());
  upload(f.g, f.t('00121'), f.W1, 'b.pdf', S.pdf());
  ok(f.g, 'submission.submit', { assessmentId: f.W1, baseVersionNo: 0, idempotencyKey: idemKey() }, f.t('00121'));
  upload(f.g, f.t('00122'), f.W1, 'a.pdf', S.pdf());
  const q = ok(f.g, 'teacher.submissions', { assessmentId: f.W1 }, f.t('demo_t001'));
  assert.equal(q.counts.owners, 8);
  assert.equal(q.counts.submitted, 1);
  assert.equal(q.counts.notSubmitted, 7);
  assert.equal(q.rows.find((r) => r.studentCode === '00122').status, 'draft');
  const detail = ok(f.g, 'submission.detail', { submissionId: q.rows.find((r) => r.studentCode === '00121').submissionId }, f.t('demo_t001'));
  assert.equal(detail.versions[0].files.length, 2);
  assert.equal(detail.canReview, true);
});

test('งานรายวันล้างไฟล์ฉบับร่างกำพร้าที่เก่ากว่ากำหนด แต่ไม่แตะไฟล์ที่ส่งแล้วหรือร่างที่ยังเปิดรับ', () => {
  const f = fixture();
  const tok = f.t('00121');
  const orphan = upload(f.g, tok, f.W1, 'ทิ้ง.pdf', S.pdf());
  ok(f.g, 'submission.removeDraft', { assessmentId: f.W1, refId: orphan.data.file.refId }, tok);
  const keep = upload(f.g, tok, f.W1, 'ส่ง.pdf', S.pdf());
  ok(f.g, 'submission.submit', { assessmentId: f.W1, baseVersionNo: 0, idempotencyKey: idemKey(), fileAssetIds: [keep.data.file.fileAssetId] }, tok);
  const draft = upload(f.g, f.t('00122'), f.W1, 'ร่าง.pdf', S.pdf());
  // ทำให้ทุกไฟล์เก่ากว่าระยะเก็บ staging (72 ชม.)
  const old = new Date(Date.now() - 100 * 3600000).toISOString();
  const sheet = f.g.Db.info('file_assets').sheet;
  const col = f.g.Db.info('file_assets').col.created_at + 1;
  for (let r = 2; r <= sheet.getLastRow(); r++) sheet.getRange(r, col).setValue("'" + old);
  f.g.Db.reset();
  const n = f.g.Maintenance.cleanupStaging();
  assert.equal(n, 1);
  f.g.Db.reset();
  const o = f.g.Db.get('file_assets', orphan.data.file.fileAssetId);
  assert.equal(o.state, 'trashed');
  assert.equal(f.g.DriveApp.getFileById(o.drive_file_id).isTrashed(), true);
  assert.equal(f.g.Db.get('file_assets', keep.data.file.fileAssetId).state, 'stored');
  assert.equal(f.g.Db.get('file_assets', draft.data.file.fileAssetId).state, 'staging', 'ร่างของงานที่ยังเปิดรับไม่ถูกลบ');
});

test('A24 สำรองฐานข้อมูลแล้วเปิดชุดสำรอง: งาน สมาชิก และการอ้างอิงไฟล์ยังสัมพันธ์กันครบ', () => {
  const f = fixture();
  const up = upload(f.g, f.t('00121'), f.W1, 'a.pdf', S.pdf());
  ok(f.g, 'submission.submit', { assessmentId: f.W1, baseVersionNo: 0, idempotencyKey: idemKey() }, f.t('00121'));
  const r = f.g.Maintenance.backup();
  assert.equal(r.copies, 6);
  const root = f.g.DriveApp.getFolderById(f.g.PropertiesService.getScriptProperties().getProperty('FOLDER_BACKUPS'));
  const folder = root.getFoldersByName(r.folder).next();
  const manifest = JSON.parse(folder.getFilesByName('manifest.json').next().getBlob().getDataAsString());
  // กู้คืน: ชี้ Script Properties ไปที่ชุดสำรอง แล้วอ่านข้อมูลผ่านระบบ
  const p = f.g.PropertiesService.getScriptProperties();
  manifest.databases.forEach((d) => p.setProperty('DB_' + d.db.toUpperCase(), d.id));
  f.g.Db.reset();
  const asset = f.g.Db.get('file_assets', up.data.file.fileAssetId);
  assert.equal(asset.state, 'stored');
  const ref = f.g.Db.one('submission_files', { file_asset_id: asset.id });
  const ver = f.g.Db.get('submission_versions', ref.submission_version_id);
  assert.equal(ver.version_no, 1);
  assert.ok(f.g.DriveApp.getFileById(asset.drive_file_id), 'ไฟล์บน Drive ยังเปิดได้จาก drive_file_id');
  assert.equal(f.g.Db.all('students').length, 12);
});

test('ผู้ดูแลดูสถานะระบบ/พื้นที่ และแก้เพดานไฟล์ได้ภายในขอบเขตที่ตรวจแล้ว', () => {
  const f = fixture();
  const admin0 = ok(f.g, 'auth.login', { username: 'demo_admin', password: f.accounts.demo_admin }).token;
  const admin = ok(f.g, 'auth.changePassword', { oldPassword: f.accounts.demo_admin, newPassword: 'Admin#Strong2026' }, admin0).token;
  const st = ok(f.g, 'admin.status', {}, admin);
  assert.equal(st.env, 'demo');
  assert.equal(st.counts.students, 12);
  assert.equal(call(f.g, 'admin.updateSettings', { changes: { max_file_mb: 0 } }, admin).error.code, 'VALIDATION');
  assert.equal(call(f.g, 'admin.updateSettings', { changes: { allowed_file_types: 'pdf,exe' } }, admin).error.code, 'VALIDATION');
  assert.equal(call(f.g, 'admin.updateSettings', { changes: { password: 'x' } }, admin).error.code, 'VALIDATION');
  ok(f.g, 'admin.updateSettings', { changes: { max_file_mb: 5, allowed_file_types: 'pdf,png' } }, admin);
  assert.equal(call(f.g, 'upload.begin', { assessmentId: f.W1, fileName: 'a.pdf', size: 6 * 1024 * 1024 }, f.t('00121')).error.code, 'FILE_TOO_LARGE');
  assert.equal(call(f.g, 'upload.begin', { assessmentId: f.W1, fileName: 'a.docx', size: 100 }, f.t('00121')).error.code, 'FILE_TYPE_NOT_ALLOWED', 'งานขอ docx แต่โรงเรียนปิดแล้ว');
});

test('โครงสร้างข้อมูล: ref ชี้ตารางที่มีอยู่ ตารางใหญ่มีดัชนี และข้อกำหนดไม่ซ้ำอ้างคอลัมน์จริง', () => {
  const f = fixture();
  const Schema = f.g.Schema;
  for (const name of Schema.names()) {
    const t = Schema.get(name);
    for (const fl of t.fields) if (fl.ref) assert.ok(Schema.tables[fl.ref], `${name}.${fl.name} → ${fl.ref}`);
    for (const u of t.unique) for (const c of u) assert.ok(t.fieldMap[c], `${name} unique ${c}`);
    for (const c of t.idx) assert.ok(t.fieldMap[c], `${name} idx ${c}`);
    if (t.size === 'large') assert.ok(t.idx.length > 1, `${name} ต้องมีดัชนีค้นหา`);
  }
});
