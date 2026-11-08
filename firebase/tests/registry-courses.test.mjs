import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { doc, getDoc, getDocs, collection, collectionGroup, query, where } from 'firebase/firestore';
import { freshSeed, login, rejects, cleanup, adminDb } from './helpers.mjs';

let S;
beforeEach(async () => { S = await freshSeed(); });
after(cleanup);

test('A01 นำเข้านักเรียนเป็นชุด: หัวตารางไทย ศูนย์นำหน้าคงอยู่ แถวผิดถูกแจ้ง นำเข้าซ้ำไม่สร้างซ้ำ ค่าว่างไม่ลบข้อมูลเดิม', async () => {
  const admin = await login('demo_admin');
  const text = '﻿รหัสนักเรียน,คำนำหน้า,ชื่อ,นามสกุล,ชั้น,เลขที่\n00501,นาย,สมชาย,ใจดี,ม.4/1,1\n00502,นางสาว,สมหญิง,"รัก, เรียน",ม.4/1,2\n00501,นาย,ซ้ำ,ซ้ำ,ม.4/1,3\n,นาย,ไม่มีรหัส,,ม.4/1,4\n00121,,,,ม.5/1,\n';
  const pv = await admin.api('admin.importStudents', { text });
  assert.deepEqual(pv.counts, { insert: 2, update: 0, skip: 1, error: 2 });
  await rejects(admin.api('admin.importStudents', { text, commit: true }), 'VALIDATION');
  const done = await admin.api('admin.importStudents', { text, commit: true, skipErrors: true });
  assert.equal(done.accounts.length, 2);
  const db = await adminDb();
  const s = (await db.collection('students').where('code', '==', '00502').get()).docs[0].data();
  assert.equal(s.lastName, 'รัก, เรียน');
  assert.equal(s.roomLabel, 'ม.4/1');
  const again = await admin.api('admin.importStudents', { text: 'student_code,first_name,last_name,class_level,room\n00501,สมชาย,ใจดี,ม.4,1\n00502,สมหญิง,ใหม่,ม.4,1\n', commit: true });
  assert.deepEqual(again.counts, { insert: 0, update: 1, skip: 1, error: 0 });
  assert.equal((await db.collection('students').where('code', '==', '00501').get()).size, 1);
  const warn = await admin.api('admin.importStudents', { text: 'รหัสนักเรียน\tชื่อ-นามสกุล\n601\tนายเอ บี\n00602\tนางสาวซี ดี\n' });
  assert.ok(warn.warnings.some((w) => /ศูนย์นำหน้า/.test(w)));
  const t = await login('demo_t001');
  await rejects(t.api('admin.importStudents', { text }), 'FORBIDDEN');
  // นักเรียนนำเข้าเข้าสู่ระบบด้วยรหัสชั่วคราว
  const s501 = await login('00501', done.accounts.find((a) => a.code === '00501').tempPassword);
  assert.equal((await getDoc(doc(s501.db, 'users', s501.uid))).data().mustChangePassword, true);
});

test('นักเรียนสมัครใช้งานเอง: ปิดเป็นค่าเริ่มต้น ต้องใช้รหัสลงทะเบียน รอผู้ดูแลอนุมัติก่อนเข้าระบบ', async () => {
  const admin = await login('demo_admin');
  const guest = (await import('./helpers.mjs')).device();
  const form = { schoolCode: 'DEMO', studentCode: '00777', prefix: 'เด็กหญิง', firstName: 'ใหม่', lastName: 'สมัครเอง', classLevel: 'ม.5', room: '1', password: 'MyOwnPass#77' };
  assert.equal((await guest.api('auth.registrationInfo', { schoolCode: 'DEMO' })).enabled, false);
  await rejects(guest.api('auth.register', form), 'REGISTRATION_CLOSED');
  await admin.api('admin.updateSettings', { changes: { selfRegistrationEnabled: true, selfRegistrationCode: 'CWK2569' } });
  assert.equal((await guest.api('auth.registrationInfo', { schoolCode: 'DEMO' })).needsCode, true);
  await rejects(guest.api('auth.register', Object.assign({ registrationCode: 'ผิด' }, form)), 'VALIDATION');
  assert.equal((await guest.api('auth.register', Object.assign({ registrationCode: 'CWK2569' }, form))).status, 'pending');
  await rejects(guest.api('auth.register', Object.assign({ registrationCode: 'CWK2569' }, form)), 'DUPLICATE');
  await rejects(guest.api('auth.register', Object.assign({ registrationCode: 'CWK2569' }, form, { studentCode: '00121' })), 'DUPLICATE');
  await rejects(login('00777', form.password)); // บัญชียังปิดอยู่จนกว่าจะอนุมัติ
  const reqs = await getDocs(query(collection(admin.db, 'registrationRequests'), where('schoolId', '==', S.schoolId), where('status', '==', 'pending')));
  assert.equal(reqs.size, 1);
  assert.ok(!JSON.stringify(reqs.docs[0].data()).includes(form.password), 'ไม่เก็บรหัสผ่าน');
  await admin.api('admin.decideRegistration', { id: reqs.docs[0].id, approve: true });
  const s = await login('00777', form.password);
  const u = (await getDoc(doc(s.db, 'users', s.uid))).data();
  assert.equal(u.mustChangePassword, false);
  assert.ok(u.studentId);
});

test('ผู้ดูแลเพิ่มครู/ปีการศึกษา/รายวิชาและเปิดให้ครู; ครูเปิดรายวิชาของตนเองได้หลายวิชา; ครูร่วมสอนตามสิทธิ์', async () => {
  const admin = await login('demo_admin');
  const tr = await admin.api('admin.saveTeacher', { teacherCode: 'T009', prefix: 'นาย', firstName: 'ครูใหม่', lastName: 'ทดสอบ', department: 'ภาษาไทย' });
  assert.equal(tr.account.username, 't009');
  const { termIds } = await admin.api('admin.saveYear', { yearBe: 2570 });
  assert.equal(termIds.length, 2);
  await rejects(admin.api('admin.saveYear', { yearBe: 2570 }), 'DUPLICATE');
  const course = await admin.api('course.save', { code: 'ท31101', nameTh: 'ภาษาไทย 1', credits: '1.5' });
  const off = await admin.api('offering.save', { courseId: course.id, termId: termIds[0], sectionCode: 'ม.4/1', ownerTeacherId: tr.teacher.id });
  const t9 = await login('t009', tr.account.tempPassword);
  await t9.api('auth.changePassword', { newPassword: 'TeacherNew#2570' });
  const t = await login('t009', 'TeacherNew#2570');
  const c2 = await t.api('course.save', { code: 'ท31102', nameTh: 'ภาษาไทย 2' });
  await t.api('offering.save', { courseId: c2.id, termId: termIds[0], sectionCode: 'ม.4/2' });
  const mine = await getDocs(query(collection(t.db, 'offerings'), where('schoolId', '==', S.schoolId), where('staffUids', 'array-contains', t.uid)));
  assert.equal(mine.size, 2);
  await rejects(t.api('offering.save', { courseId: c2.id, termId: termIds[0], sectionCode: 'ม.4/2' }), 'DUPLICATE');
  await rejects(t.api('course.save', { id: course.id, code: 'ท31101', nameTh: 'แก้' }), 'FORBIDDEN');
  const o = (await getDoc(doc(t.db, 'offerings', off.offeringId))).data();
  assert.equal(o.policy.bands.length, 8, 'เกณฑ์เกรดเริ่มต้น');
  await t.api('offering.setCoTeacher', { offeringId: mine.docs.find((d) => d.data().section === 'ม.4/2').id, teacherId: S.teachers.T003, perms: { can_grade: true } });
  const t3 = await login('demo_t003');
  const t3list = await getDocs(query(collection(t3.db, 'offerings'), where('schoolId', '==', S.schoolId), where('staffUids', 'array-contains', t3.uid)));
  assert.equal(t3list.size, 2);
});

test('A23 ลงทะเบียน/ถอน (ไม่สร้างคะแนนศูนย์ย้อนหลัง) และนักเรียนลงทะเบียนเองด้วยรหัสเข้าร่วม', async () => {
  const A = S.offerings.A;
  const t = await login('demo_t001');
  const r = await t.api('offering.enroll', { offeringId: A, studentIds: [S.students['00129'], S.students['00127']] });
  assert.deepEqual(r, { added: 1, reactivated: 0, skipped: 1 });
  const db = await adminDb();
  assert.equal((await db.collection('offerings/' + A + '/grades').where('studentId', '==', S.students['00129']).get()).size, 0);
  await rejects(t.api('offering.withdraw', { offeringId: A, studentId: S.students['00129'] }), 'VALIDATION');
  await t.api('offering.withdraw', { offeringId: A, studentId: S.students['00129'], reason: 'ย้ายโรงเรียน' });
  const enr = (await db.doc('offerings/' + A + '/enrollments/' + S.students['00129']).get()).data();
  assert.equal(enr.status, 'withdrawn');
  assert.equal(enr.history.length, 2);
  const st = await login('00131');
  await rejects(st.api('student.join', { code: 'ABCDEF' }), 'JOIN_CODE_INVALID');
  const j = await t.api('offering.setJoin', { offeringId: A, enabled: true });
  assert.match(j.joinCode, /^[A-Z2-9]{6}$/);
  assert.equal((await st.api('student.join', { code: j.joinCode.toLowerCase() })).offeringId, A);
  assert.equal((await st.api('student.join', { code: j.joinCode })).already, true);
  const mine = await getDocs(query(collectionGroup(st.db, 'enrollments'), where('uid', '==', st.uid)));
  assert.ok(mine.docs.some((d) => d.ref.parent.parent.id === A));
  await rejects((await login('00129')).api('student.join', { code: j.joinCode }), 'FORBIDDEN');
  await t.api('offering.setJoin', { offeringId: A, enabled: false });
  await rejects((await login('00132')).api('student.join', { code: j.joinCode }), 'JOIN_CODE_INVALID');
});
