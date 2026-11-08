import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { doc, getDoc, getDocs, collection, collectionGroup, query, where, onSnapshot, updateDoc } from 'firebase/firestore';
import { signInWithEmailAndPassword } from 'firebase/auth';
import { freshSeed, login, device, rejects, until, cleanup, PASSWORD } from './helpers.mjs';
import { authEmail } from '../functions/src/shared/config.js';

let S;
before(async () => { S = await freshSeed(); });
after(cleanup);

test('A13 Security Rules: นักเรียนเห็นเฉพาะของตนเอง ไม่เห็นคะแนนร่าง/ข้อมูลของเพื่อน', async () => {
  const st = await login('00121');
  const A = S.offerings.A;
  // รายวิชาของตนผ่าน collection group
  const mine = await getDocs(query(collectionGroup(st.db, 'enrollments'), where('uid', '==', st.uid)));
  assert.equal(mine.size, 2, 'เรียน 2 รายวิชา (A และ C)');
  assert.equal((await getDoc(doc(st.db, 'offerings', A))).data().courseCode, 'ว32201');
  await rejects(getDoc(doc(st.db, 'offerings', S.offerings.B)), 'permission-denied');
  // ทะเบียนนักเรียน: เห็นของตนเอง ไม่เห็นของเพื่อน
  assert.equal((await getDoc(doc(st.db, 'students', S.students['00121']))).data().code, '00121');
  await rejects(getDoc(doc(st.db, 'students', S.students['00122'])), 'permission-denied');
  await rejects(getDocs(collection(st.db, 'students')), 'permission-denied');
  // เพื่อนในรายวิชาเห็นแค่ชื่อและห้อง
  const roster = await getDocs(collection(st.db, 'offerings', A, 'roster'));
  assert.equal(roster.size, 8);
  assert.deepEqual(Object.keys(roster.docs[0].data()).sort(), ['active', 'name', 'roomLabel', 'workGroupId']);
  // คะแนนร่างและคะแนนกลุ่ม: ครูเท่านั้น
  await rejects(getDocs(collection(st.db, 'offerings', A, 'grades')), 'permission-denied');
  await rejects(getDocs(collection(st.db, 'offerings', A, 'groupGrades')), 'permission-denied');
  await rejects(getDoc(doc(st.db, 'offerings', A, 'published', S.students['00122'])), 'permission-denied');
  // งานที่ยังเป็นฉบับร่าง: นักเรียนต้องค้นเฉพาะที่เผยแพร่
  await rejects(getDocs(collection(st.db, 'offerings', A, 'assessments')), 'permission-denied');
  const pub = await getDocs(query(collection(st.db, 'offerings', A, 'assessments'), where('status', '==', 'published')));
  assert.equal(pub.size, 3);
  // เขียน Firestore ตรงไม่ได้ (ต้องผ่าน Cloud Functions)
  await rejects(updateDoc(doc(st.db, 'students', S.students['00121']), { firstName: 'แก้เอง' }), 'permission-denied');
});

test('A14 ครูนอกรายวิชาอ่าน/แก้ไม่ได้; ครูร่วมสอนอ่านได้ตามที่ได้รับมอบหมาย', async () => {
  const t3 = await login('demo_t003');
  await rejects(getDoc(doc(t3.db, 'offerings', S.offerings.A)), 'permission-denied');
  await rejects(getDocs(collection(t3.db, 'offerings', S.offerings.A, 'grades')), 'permission-denied');
  await rejects(t3.api('grades.save', { offeringId: S.offerings.A, assessmentId: S.assessments.W1, entries: [{ studentId: S.students['00121'], status: 'scored', score: '1' }] }), 'FORBIDDEN');
  const t2 = await login('demo_t002');
  const list = await getDocs(query(collection(t2.db, 'offerings'), where('schoolId', '==', S.schoolId), where('staffUids', 'array-contains', t2.uid)));
  assert.equal(list.size, 2, 'เจ้าของ B และร่วมสอน A');
  assert.equal((await getDocs(collection(t2.db, 'offerings', S.offerings.A, 'grades'))).size, 0);
});

test('บัญชีที่ผู้ดูแลสร้าง: ต้องเปลี่ยนรหัสผ่านก่อนใช้งาน และ session เดิมถูกเพิกถอนหลังเปลี่ยน', async () => {
  const admin = await login('demo_admin');
  const r = await admin.api('admin.saveStudent', { studentCode: '00950', prefix: 'นาย', firstName: 'ใหม่', lastName: 'ทดสอบ', classLevel: 'ม.5', room: '1' });
  assert.match(r.account.tempPassword, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  const s = await login('00950', r.account.tempPassword);
  const me = (await getDoc(doc(s.db, 'users', s.uid))).data();
  assert.equal(me.mustChangePassword, true);
  assert.deepEqual(me.roles, ['student']);
  await rejects(s.api('student.join', { code: 'XXXXXX' }), 'PASSWORD_CHANGE_REQUIRED');
  await rejects(s.api('auth.changePassword', { newPassword: '123' }), 'VALIDATION');
  await s.api('auth.changePassword', { newPassword: 'NewStrong#950' });
  const s2 = await login('00950', 'NewStrong#950');
  assert.equal((await getDoc(doc(s2.db, 'users', s2.uid))).data().mustChangePassword, false);
  await rejects(signInWithEmailAndPassword(device().auth, authEmail('00950', 'DEMO'), r.account.tempPassword)); // รหัสชั่วคราวเดิมใช้ไม่ได้แล้ว
  // ผู้ดูแลรีเซ็ตรหัส → ต้องเปลี่ยนใหม่
  const reset = await admin.api('admin.resetPassword', { userId: s2.uid });
  const s3 = await login('00950', reset.tempPassword);
  assert.equal((await getDoc(doc(s3.db, 'users', s3.uid))).data().mustChangePassword, true);
  // ปิดบัญชี → เข้าไม่ได้
  await admin.api('admin.setUserStatus', { userId: s3.uid, status: 'disabled', reason: 'ทดสอบ' });
  await rejects(login('00950', reset.tempPassword));
});

test('เรียลไทม์: ผู้ดูแลให้สิทธิ์ผู้ดูแลคะแนน → claimsRev เปลี่ยนในเอกสาร users ทันที (แอปขอโทเคนใหม่)', async () => {
  const admin = await login('demo_admin');
  const t1 = await login('demo_t001');
  const revs = [];
  const unsub = onSnapshot(doc(t1.db, 'users', t1.uid), (snap) => revs.push(snap.data().claimsRev));
  await until(() => revs.length >= 1);
  await admin.api('admin.setRole', { userId: t1.uid, role: 'grade_admin', grant: true, reason: 'ทดสอบ' });
  await until(() => revs.length >= 2 && revs[revs.length - 1] > revs[0]);
  unsub();
  await t1.user.getIdToken(true);
  const claims = (await t1.user.getIdTokenResult()).claims;
  assert.ok(claims.roles.includes('grade_admin'));
  void PASSWORD;
});
