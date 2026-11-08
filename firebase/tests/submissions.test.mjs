import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { doc, getDoc, getDocs, collection, query, where } from 'firebase/firestore';
import { ref, uploadBytes, getBytes } from 'firebase/storage';
import { createHash } from 'node:crypto';
import { freshSeed, login, rejects, cleanup, adminDb, samples, download } from './helpers.mjs';

let S;
beforeEach(async () => { S = await freshSeed(); });
after(cleanup);

let n = 0;
async function upload(d, assessmentId, name, buf) {
  const path = 'uploads/' + d.uid + '/' + Date.now() + '-' + (++n);
  await uploadBytes(ref(d.storage, path), new Uint8Array(buf));
  return d.api('submission.attach', { offeringId: S.offerings.A, assessmentId, uploadPath: path, fileName: name });
}
const key = () => 'test-key-' + Date.now() + '-' + (++n) + '-abcdef';

test('A11/A12 อัปโหลดเข้าฉบับร่าง (ไฟล์ปลอม/โปรแกรมถูกปฏิเสธ) → ส่งงานได้ใบยืนยัน → ส่งซ้ำเป็นรุ่น 2 รุ่น 1 อยู่ครบ', async () => {
  const st = await login('00121');
  const W1 = S.assessments.W1;
  const ok1 = await upload(st, W1, 'รายงาน.pdf', samples.pdf(300000));
  assert.equal(ok1.accepted, true);
  const ok2 = await upload(st, W1, 'ภาพ.png', samples.png());
  assert.equal(ok2.accepted, true);
  const fake = await upload(st, W1, 'ปลอม.pdf', samples.png());
  assert.equal(fake.accepted, false);
  assert.equal(fake.code, 'FILE_SIGNATURE_MISMATCH');
  const exe = await upload(st, W1, 'virus.pdf', samples.exe());
  assert.equal(exe.code, 'FILE_REJECTED');
  const ext = await upload(st, W1, 'script.exe', samples.pdf());
  assert.equal(ext.code, 'FILE_TYPE_NOT_ALLOWED');
  const subId = W1 + '_' + S.students['00121'];
  const draft = (await getDoc(doc(st.db, 'offerings', S.offerings.A, 'drafts', subId))).data();
  assert.equal(draft.files.length, 2, 'อัปโหลดเสร็จยังไม่ถือว่าส่ง (อยู่ในฉบับร่าง)');
  const k = key();
  const r1 = await st.api('submission.submit', { offeringId: S.offerings.A, assessmentId: W1, baseVersionNo: 0, idempotencyKey: k, comment: 'ส่งครั้งแรก' });
  assert.match(r1.receiptCode, /^CWK-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(r1.versionNo, 1);
  assert.equal(r1.files.length, 2);
  assert.ok(Math.abs(Date.parse(r1.submittedAt) - Date.now()) < 10000, 'เวลาเซิร์ฟเวอร์');
  const replay = await st.api('submission.submit', { offeringId: S.offerings.A, assessmentId: W1, baseVersionNo: 0, idempotencyKey: k });
  assert.equal(replay.replayed, true, 'กดซ้ำไม่สร้างรายการซ้ำ');
  assert.equal(replay.receiptCode, r1.receiptCode);
  await rejects(st.api('submission.submit', { offeringId: S.offerings.A, assessmentId: W1, baseVersionNo: 1, idempotencyKey: key() }), 'NOTHING_TO_SUBMIT');
  await upload(st, W1, 'แก้ไข.pdf', samples.pdf());
  await rejects(st.api('submission.submit', { offeringId: S.offerings.A, assessmentId: W1, baseVersionNo: 0, idempotencyKey: key() }), 'CONFLICT');
  const r2 = await st.api('submission.submit', { offeringId: S.offerings.A, assessmentId: W1, baseVersionNo: 1, idempotencyKey: key() });
  assert.equal(r2.versionNo, 2);
  const versions = await getDocs(query(collection(st.db, 'offerings', S.offerings.A, 'submissions', subId, 'versions'), where('memberIds', 'array-contains', S.students['00121'])));
  assert.equal(versions.size, 2);
  assert.equal(versions.docs.find((d) => d.id === '1').data().files.length, 2, 'รุ่นเดิมเก็บไฟล์ครบ');
  // ไฟล์: เจ้าของและครูเปิดได้ (ไฟล์ 300 KB เกิน 1 ช่วงหรือไม่ก็ได้ ตรวจ sha256 ตรง) เพื่อน/ครูนอกรายวิชาเปิดไม่ได้
  const fileDoc = (await getDoc(doc(st.db, 'offerings', S.offerings.A, 'files', ok1.file.id))).data();
  const mineBuf = await download(st, S.offerings.A, ok1.file.id);
  assert.equal(createHash('sha256').update(mineBuf).digest('hex'), fileDoc.sha256);
  const t = await login('demo_t001');
  assert.equal((await download(t, S.offerings.A, ok1.file.id)).length, fileDoc.size);
  const friend = await login('00122');
  await rejects(download(friend, S.offerings.A, ok1.file.id), 'NOT_FOUND');
  await rejects(getDoc(doc(friend.db, 'offerings', S.offerings.A, 'submissions', subId)), 'permission-denied');
  await rejects(getBytes(ref(st.storage, fileDoc.path)), 'storage/unauthorized'); // ไม่มีการอ่านไฟล์จาก Storage ตรง
  const t3 = await login('demo_t003');
  await rejects(download(t3, S.offerings.A, ok1.file.id), 'NOT_FOUND');
  // ครูส่งคืนแก้ไข (ต้องมีข้อความ)
  await rejects(t.api('submission.review', { offeringId: S.offerings.A, submissionId: subId, versionNo: 2, action: 'return' }), 'VALIDATION');
  await t.api('submission.review', { offeringId: S.offerings.A, submissionId: subId, versionNo: 2, action: 'return', note: 'เพิ่มขั้นตอนที่ 3' });
  assert.equal((await getDoc(doc(st.db, 'offerings', S.offerings.A, 'submissions', subId))).data().status, 'returned');
});

test('งานกลุ่ม: สมาชิกคนใดก็ส่งแทนกลุ่มได้ ส่งครั้งแรกตรึงรายชื่อ ไฟล์ชุดเดียวทุกคนในกลุ่มเปิดได้ คนนอกกลุ่มเปิดไม่ได้', async () => {
  const G1 = S.assessments.G1;
  const s2 = await login('00122');
  const up = await upload(s2, G1, 'โครงงาน.pdf', samples.pdf());
  assert.equal(up.accepted, true);
  const s1 = await login('00121');
  const r = await s1.api('submission.submit', { offeringId: S.offerings.A, assessmentId: G1, baseVersionNo: 0, idempotencyKey: key(), links: ['https://example.com/slides'] });
  assert.equal(r.versionNo, 1);
  const db = await adminDb();
  const g = (await db.doc('offerings/' + S.offerings.A + '/' + 'groups/' + r.submissionId.slice(G1.length + 1)).get()).data();
  assert.equal(g.frozen, true);
  assert.equal(g.frozenReason, 'first_submission');
  assert.equal(g.snapshots['1'].length, 3);
  const fileDoc = (await db.doc('offerings/' + S.offerings.A + '/files/' + up.file.id).get()).data();
  for (const u of ['00121', '00122', '00123']) {
    const d = await login(u);
    assert.equal((await download(d, S.offerings.A, up.file.id)).length, fileDoc.size, u);
  }
  const outsider = await login('00124');
  await rejects(download(outsider, S.offerings.A, up.file.id), 'NOT_FOUND');
  // สมาชิกกลุ่มที่ส่งทับพร้อมกันได้ CONFLICT
  await upload(s2, G1, 'b.pdf', samples.pdf());
  await rejects(s2.api('submission.submit', { offeringId: S.offerings.A, assessmentId: G1, baseVersionNo: 0, idempotencyKey: key() }), 'CONFLICT');
});

test('ช่วงเวลา: ยังไม่ถึงเวลาเปิด/ปิดรับแล้ว ส่งไม่ได้; ขยายเวลารายคนแล้วส่งได้ (บันทึกว่าส่งช้า)', async () => {
  const t = await login('demo_t001');
  const A = S.offerings.A;
  const past = (h) => new Date(Date.now() - h * 3600000).toISOString();
  const a = await t.api('assessment.save', { offeringId: A, code: 'W9', title: 'งานหมดเวลา', kind: 'individual', maxScore: 10, weight: 5, openAt: past(48), dueAt: past(24), closeAt: past(2), allowLate: true, status: 'published' });
  const st = await login('00125');
  const res = await upload(st, a.id, 'a.pdf', samples.pdf()).catch((e) => e);
  assert.equal(res.details.code, 'SUBMISSION_CLOSED');
  await t.api('assessment.extend', { offeringId: A, assessmentId: a.id, targetType: 'student', targetId: S.students['00125'], closeAt: new Date(Date.now() + 3600000).toISOString(), reason: 'ป่วย' });
  assert.equal((await upload(st, a.id, 'a.pdf', samples.pdf())).accepted, true);
  const r = await st.api('submission.submit', { offeringId: A, assessmentId: a.id, baseVersionNo: 0, idempotencyKey: key() });
  assert.equal(r.isLate, true);
});
