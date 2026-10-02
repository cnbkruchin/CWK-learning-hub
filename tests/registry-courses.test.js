'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { call, ok } = require('./harness/load');
const { fixture } = require('./harness/fixture');

test('ผู้ดูแลเพิ่มนักเรียนพร้อมบัญชี: รหัส 00999 ไม่หาย เข้าระบบด้วยรหัสชั่วคราวแล้วต้องเปลี่ยนรหัสผ่าน', () => {
  const f = fixture();
  const adm = f.admin();
  const r = ok(f.g, 'admin.saveStudent', { studentCode: '00999', prefix: 'นาย', firstName: 'ทดลอง', lastName: 'เพิ่มใหม่', classLevel: 'ม.5', room: '3', rollNo: 7 }, adm);
  assert.equal(r.student.code, '00999');
  assert.equal(r.account.username, '00999');
  assert.match(r.account.tempPassword, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  const login = ok(f.g, 'auth.login', { username: '00999', password: r.account.tempPassword });
  assert.equal(login.mustChangePassword, true);
  assert.equal(call(f.g, 'student.courses', {}, login.token).error.code, 'PASSWORD_CHANGE_REQUIRED');
  assert.equal(call(f.g, 'admin.saveStudent', { studentCode: '00999', firstName: 'ซ้ำ' }, adm).error.code, 'DUPLICATE');
  assert.equal(call(f.g, 'admin.saveStudent', { studentCode: '00998', firstName: 'x' }, f.t('demo_t001')).error.code, 'FORBIDDEN');
  // ครูเห็นรายชื่อเฉพาะข้อมูลที่จำเป็น
  const list = ok(f.g, 'registry.students', { classLevel: 'ม.5', room: '3' }, f.t('demo_t001'));
  assert.equal(list.students.length, 1);
  assert.deepEqual(Object.keys(list.students[0]).sort(), ['classLevel', 'code', 'id', 'name', 'rollNo', 'room', 'roomLabel', 'status']);
  assert.ok(list.rooms.some((x) => x.label === 'ม.5/3'));
  assert.equal(call(f.g, 'registry.students', {}, f.t('00121')).error.code, 'FORBIDDEN');
});

test('A01 นำเข้านักเรียนเป็นชุด: หัวตารางภาษาไทย ศูนย์นำหน้าคงอยู่ แถวผิดถูกแจ้ง นำเข้าซ้ำไม่สร้างซ้ำ ค่าว่างไม่ลบข้อมูลเดิม', () => {
  const f = fixture();
  const adm = f.admin();
  const text = '﻿รหัสนักเรียน,คำนำหน้า,ชื่อ,นามสกุล,ชั้น,เลขที่\n' +
    '00501,นาย,สมชาย,ใจดี,ม.4/1,1\n' +
    '00502,นางสาว,สมหญิง,"รัก, เรียน",ม.4/1,2\n' +
    '00501,นาย,ซ้ำ,ซ้ำ,ม.4/1,3\n' +
    ',นาย,ไม่มีรหัส,,ม.4/1,4\n' +
    '00121,,,,ม.5/1,\n';
  const pv = ok(f.g, 'admin.importStudents', { text }, adm);
  assert.deepEqual(pv.counts, { insert: 2, update: 0, skip: 1, error: 2 });
  assert.equal(pv.rows.find((r) => r.rowNo === 4).result, 'error');
  assert.match(pv.rows.find((r) => r.rowNo === 4).message, /ซ้ำกับแถวที่ 2/);
  assert.equal(pv.rows.find((r) => r.code === '00121').result, 'skip', 'ค่าว่างไม่ทับข้อมูลเดิม');
  assert.equal(f.g.Db.find('students', { student_code: '00501' }).length, 0, 'หน้าตัวอย่างยังไม่บันทึก');
  assert.equal(call(f.g, 'admin.importStudents', { text, commit: true }, adm).error.code, 'VALIDATION', 'มีแถวผิดต้องแก้ก่อน');
  const done = ok(f.g, 'admin.importStudents', { text, commit: true, skipErrors: true }, adm);
  assert.equal(done.accounts.length, 2);
  assert.deepEqual(done.skippedRows.map((r) => r.rowNo), [4, 5]);
  const s = f.g.Db.one('students', { student_code: '00502' });
  assert.equal(s.last_name, 'รัก, เรียน');
  assert.equal(s.class_level, 'ม.4');
  assert.equal(s.room, '1');
  assert.equal(f.g.Db.one('students', { student_code: '00121' }).first_name, 'กิตติ');
  // นำเข้าซ้ำ → ไม่มีรายการเพิ่ม
  const again = ok(f.g, 'admin.importStudents', { text: 'student_code,first_name,last_name,class_level,room\n00501,สมชาย,ใจดี,ม.4,1\n00502,สมหญิง,ใหม่,ม.4,1\n', commit: true }, adm);
  assert.deepEqual(again.counts, { insert: 0, update: 1, skip: 1, error: 0 });
  assert.equal(f.g.Db.find('students', { student_code: '00501' }).length, 1);
  assert.equal(f.g.Db.one('users', { username: '00502' }).display_name, 'นางสาว สมหญิง ใหม่');
  // รหัสยาวไม่เท่ากัน → เตือนเลขศูนย์นำหน้าหาย
  const warn = ok(f.g, 'admin.importStudents', { text: 'รหัสนักเรียน\tชื่อ-นามสกุล\n601\tนายเอ บี\n00602\tนางสาวซี ดี\n' }, adm);
  assert.ok(warn.warnings.some((w) => /ศูนย์นำหน้า/.test(w)));
  assert.equal(warn.rows[1].name, 'นางสาว ซี ดี');
  assert.ok(f.g.Db.all('import_jobs').length >= 2);
});

test('นักเรียนสมัครใช้งานเอง: ปิดเป็นค่าเริ่มต้น ต้องใช้รหัสลงทะเบียน และรอผู้ดูแลอนุมัติก่อนเข้าระบบ', () => {
  const f = fixture();
  const adm = f.admin();
  const form = { studentCode: '00777', prefix: 'เด็กหญิง', firstName: 'ใหม่', lastName: 'สมัครเอง', classLevel: 'ม.5', room: '1', password: 'MyOwnPass#77' };
  assert.equal(ok(f.g, 'auth.registrationInfo', {}).enabled, false);
  assert.equal(call(f.g, 'auth.register', form).error.code, 'REGISTRATION_CLOSED');
  ok(f.g, 'admin.updateSettings', { changes: { self_registration_enabled: true, self_registration_code: 'CWK2569' } }, adm);
  assert.deepEqual(ok(f.g, 'auth.registrationInfo', {}).needsCode, true);
  assert.equal(call(f.g, 'auth.register', Object.assign({ registrationCode: 'ผิด' }, form)).error.code, 'VALIDATION');
  assert.equal(call(f.g, 'auth.register', Object.assign({ registrationCode: 'CWK2569' }, form, { password: '123' })).error.code, 'VALIDATION');
  assert.equal(ok(f.g, 'auth.register', Object.assign({ registrationCode: 'CWK2569' }, form)).status, 'pending');
  assert.equal(call(f.g, 'auth.register', Object.assign({ registrationCode: 'CWK2569' }, form)).error.code, 'DUPLICATE');
  assert.equal(call(f.g, 'auth.register', Object.assign({ registrationCode: 'CWK2569' }, form, { studentCode: '00121' })).error.code, 'DUPLICATE', 'รหัสที่มีบัญชีแล้วสมัครซ้ำไม่ได้');
  assert.equal(call(f.g, 'auth.login', { username: '00777', password: form.password }).error.code, 'AUTH_INVALID', 'ยังไม่อนุมัติ');
  const reqs = ok(f.g, 'admin.registrations', {}, adm);
  assert.equal(reqs.length, 1);
  assert.equal(JSON.stringify(reqs).indexOf('pbkdf2'), -1, 'ไม่ส่ง hash รหัสผ่านให้หน้าเว็บ');
  ok(f.g, 'admin.decideRegistration', { id: reqs[0].id, approve: true }, adm);
  const tok = ok(f.g, 'auth.login', { username: '00777', password: form.password });
  assert.equal(tok.mustChangePassword, false);
  assert.equal(ok(f.g, 'auth.me', {}, tok.token).student.code, '00777');
  assert.equal(call(f.g, 'admin.decideRegistration', { id: reqs[0].id, approve: false }, adm).error.code, 'CONFLICT');
});

test('ผู้ดูแลเพิ่มครูพร้อมบัญชี ปีการศึกษา/ภาคเรียน และเปิดรายวิชาให้ครู; ครูเพิ่มรายวิชาของตนเองได้หลายวิชา', () => {
  const f = fixture();
  const adm = f.admin();
  const tr = ok(f.g, 'admin.saveTeacher', { teacherCode: 'T009', prefix: 'นาย', firstName: 'ครูใหม่', lastName: 'ทดสอบ', department: 'ภาษาไทย' }, adm);
  assert.equal(tr.account.username, 't009');
  const yr = ok(f.g, 'admin.saveYear', { yearBe: 2570 }, adm);
  const terms = ok(f.g, 'course.terms', {}, adm);
  const t2570 = terms.find((y) => y.id === yr.id);
  assert.deepEqual(t2570.terms.map((t) => t.termNo), [1, 2]);
  const course = ok(f.g, 'course.save', { code: 'ท31101', nameTh: 'ภาษาไทย 1', credits: '1.5' }, adm);
  const off = ok(f.g, 'offering.save', { courseId: course.id, termId: t2570.terms[0].id, sectionCode: 'ม.4/1', ownerTeacherId: tr.teacher.id }, adm);
  // ครูใหม่เปลี่ยนรหัสผ่านแล้วเห็นรายวิชา
  const t0 = ok(f.g, 'auth.login', { username: 't009', password: tr.account.tempPassword }).token;
  const tt = ok(f.g, 'auth.changePassword', { oldPassword: tr.account.tempPassword, newPassword: 'TeacherNew#2570' }, t0).token;
  const mine = ok(f.g, 'teacher.offerings', {}, tt);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].offeringId, off.offeringId);
  assert.equal(mine[0].isOwner, true);
  // ครูเพิ่มรายวิชาในหลักสูตรและเปิดสอนเอง (เป็นเจ้าของอัตโนมัติ)
  const c2 = ok(f.g, 'course.save', { code: 'ท31102', nameTh: 'ภาษาไทย 2' }, tt);
  const off2 = ok(f.g, 'offering.save', { courseId: c2.id, termId: t2570.terms[0].id, sectionCode: 'ม.4/2' }, tt);
  assert.equal(ok(f.g, 'teacher.offerings', {}, tt).length, 2);
  assert.equal(call(f.g, 'offering.save', { courseId: c2.id, termId: t2570.terms[0].id, sectionCode: 'ม.4/2' }, tt).error.code, 'DUPLICATE');
  assert.equal(call(f.g, 'course.save', { id: course.id, version: 1, code: 'ท31101', nameTh: 'แก้' }, tt).error.code, 'FORBIDDEN', 'แก้ได้เฉพาะวิชาที่ตนสร้าง');
  const pol = f.g.Db.get('course_offerings', off2.offeringId).active_policy_version_id;
  assert.ok(pol, 'มีรุ่นนโยบายคะแนนและเกณฑ์เกรดเริ่มต้น');
  assert.equal(f.g.Db.find('grade_bands', { policy_version_id: pol }).length, 8);
  // ครูให้สิทธิ์ครูร่วมสอน
  ok(f.g, 'offering.setCoTeacher', { offeringId: off2.offeringId, teacherId: f.g.Db.one('teachers', { teacher_code: 'T003' }).id, perms: { can_grade: true } }, tt);
  const co = ok(f.g, 'teacher.offerings', {}, f.t('demo_t003')).find((o) => o.offeringId === off2.offeringId);
  assert.equal(co.perms.can_grade, true);
  assert.equal(co.perms.can_manage, false);
});

test('ลงทะเบียนเรียน: ครูเลือกนักเรียนเข้ารายวิชา ถอนพร้อมเหตุผล และนักเรียนลงทะเบียนเองด้วยรหัสเข้าร่วม (A23)', () => {
  const f = fixture();
  const t = f.t('demo_t001');
  const cand = ok(f.g, 'offering.candidates', { offeringId: f.offA, room: '2' }, t);
  const codes = cand.students.map((s) => s.code);
  assert.ok(codes.includes('00129') && !codes.includes('00127'), 'แสดงเฉพาะคนที่ยังไม่ลงทะเบียน');
  const r = ok(f.g, 'offering.enroll', { offeringId: f.offA, studentIds: [f.studentId('00129'), f.studentId('00127')] }, t);
  assert.deepEqual(r, { added: 1, reactivated: 0, skipped: 1 });
  assert.equal(f.g.Db.find('student_grades', { student_id: f.studentId('00129') }).length, 0, 'เพิ่มกลางภาคไม่สร้างศูนย์ย้อนหลัง');
  assert.equal(call(f.g, 'offering.enroll', { offeringId: f.offA, studentIds: [f.studentId('00130')] }, f.t('demo_t003')).error.code, 'FORBIDDEN');
  assert.equal(call(f.g, 'offering.withdraw', { offeringId: f.offA, studentId: f.studentId('00129') }, t).error.code, 'VALIDATION');
  ok(f.g, 'offering.withdraw', { offeringId: f.offA, studentId: f.studentId('00129'), reason: 'ย้ายโรงเรียน' }, t);
  const roster = ok(f.g, 'offering.roster', { offeringId: f.offA }, t);
  assert.equal(roster.students.find((s) => s.code === '00129').status, 'withdrawn');
  assert.ok(f.g.Db.all('enrollment_history').some((h) => h.action === 'withdraw' && h.reason === 'ย้ายโรงเรียน'));
  // รหัสเข้าร่วม
  const st = f.t('00131');
  assert.equal(call(f.g, 'student.join', { code: 'ABCDEF' }, st).error.code, 'JOIN_CODE_INVALID');
  const j = ok(f.g, 'offering.setJoin', { offeringId: f.offA, enabled: true }, t);
  assert.match(j.joinCode, /^[A-Z2-9]{6}$/);
  const joined = ok(f.g, 'student.join', { code: j.joinCode.toLowerCase() }, st);
  assert.equal(joined.offeringId, f.offA);
  assert.equal(ok(f.g, 'student.join', { code: j.joinCode }, st).already, true);
  assert.ok(ok(f.g, 'student.courses', {}, st).some((c) => c.offeringId === f.offA));
  // ผู้ที่ครูถอนแล้วลงทะเบียนเองซ้ำไม่ได้
  assert.equal(call(f.g, 'student.join', { code: j.joinCode }, f.t('00129')).error.code, 'FORBIDDEN');
  ok(f.g, 'offering.setJoin', { offeringId: f.offA, enabled: false }, t);
  assert.equal(call(f.g, 'student.join', { code: j.joinCode }, f.t('00132')).error.code, 'JOIN_CODE_INVALID');
});
