/**
 * สร้างโรงเรียน ผู้ดูแล และข้อมูลสาธิต โดยเรียกบริการจริงของ Cloud Functions (functions/src/lib) ผ่าน Admin SDK
 * ใช้กับ Firebase Emulator หรือโปรเจกต์สาธิตเท่านั้น (สคริปต์ seed.mjs ตรวจก่อนรัน)
 */
import crypto from 'node:crypto';
import { db, adminAuth, nowIso } from '../functions/src/lib/core.js';
import { authEmail } from '../functions/src/shared/config.js';
import { userDoc, syncClaims } from '../functions/src/lib/accounts.js';
import * as registry from '../functions/src/lib/registry.js';
import * as courses from '../functions/src/lib/courses.js';
import * as wg from '../functions/src/lib/workgroups.js';
import * as assessments from '../functions/src/lib/assessments.js';

export const randomPassword = () => crypto.randomBytes(9).toString('base64url');

/** โรงเรียน + ผู้ดูแลคนแรก (admin + grade_admin) คืน { schoolId, uid, username, password } */
export async function bootstrapSchool({ code, nameTh, isDemo, adminUsername, adminPassword, mustChange }) {
  const existing = await db.collection('schools').where('code', '==', code).limit(1).get();
  if (!existing.empty) throw new Error('มีโรงเรียนรหัส ' + code + ' แล้ว');
  const schoolRef = db.collection('schools').doc();
  await schoolRef.set({ code, nameTh, appName: 'CWK Learning Hub', isDemo: !!isDemo, settings: {}, createdAt: nowIso() });
  const username = (adminUsername || 'admin').toLowerCase();
  const password = adminPassword || randomPassword();
  const rec = await adminAuth.createUser({ email: authEmail(username, code), password, displayName: 'ผู้ดูแลระบบ' });
  await db.doc('users/' + rec.uid).set(userDoc(schoolRef.id, username, 'ผู้ดูแลระบบ', ['admin', 'grade_admin'], { mustChangePassword: mustChange !== false }));
  await syncClaims(rec.uid);
  return { schoolId: schoolRef.id, uid: rec.uid, username, password };
}

async function setKnownPassword(uid, password) {
  await adminAuth.updateUser(uid, { password });
  await db.doc('users/' + uid).update({ mustChangePassword: false });
}

/**
 * ข้อมูลสาธิต (ไม่ใช่นักเรียนจริง): ครู 3 คน รายวิชาที่เปิดสอน 3 กลุ่ม นักเรียน 12 คน (00121–00132)
 * รายวิชา A = ว32201 ม.5/1 (T001 เจ้าของ, T002 ร่วมสอน): งาน W1 งานเดี่ยว, G1 งานกลุ่ม, EX1 สอบ
 * กลุ่มประจำรายวิชา A: ทีมอัลฟา (00121–00123), ทีมเบต้า (00124–00126)
 */
export async function seedDemo({ password } = {}) {
  const pw = password || randomPassword();
  const boot = await bootstrapSchool({ code: 'DEMO', nameTh: 'โรงเรียนสาธิต (ข้อมูลสมมติ)', isDemo: true, adminUsername: 'demo_admin', adminPassword: pw, mustChange: false });
  const admin = { uid: boot.uid, schoolId: boot.schoolId, roles: { admin: true, grade_admin: true }, teacherId: '', studentId: '', name: 'ผู้ดูแลระบบ', user: {}, requestId: 'seed' };
  const accounts = { demo_admin: pw };
  const teachers = [];
  for (const t of [['T001', 'นาง', 'สมศรี', 'ใจดี', 'วิทยาศาสตร์และเทคโนโลยี'], ['T002', 'นาย', 'ประเสริฐ', 'ตั้งใจสอน', 'วิทยาศาสตร์และเทคโนโลยี'], ['T003', 'นางสาว', 'วิภา', 'รักเรียน', 'คณิตศาสตร์']]) {
    const r = await registry.saveTeacher(admin, { teacherCode: t[0], prefix: t[1], firstName: t[2], lastName: t[3], department: t[4], username: 'demo_' + t[0].toLowerCase() });
    const tdoc = (await db.doc('teachers/' + r.teacher.id).get()).data();
    await setKnownPassword(tdoc.uid, pw);
    accounts['demo_' + t[0].toLowerCase()] = pw;
    teachers.push(Object.assign({ id: r.teacher.id }, tdoc));
  }
  const { termIds } = await courses.saveYear(admin, { yearBe: 2569 });
  const term1 = termIds[0];
  const courseIds = [];
  for (const c of [['ว32201', 'วิทยาการคำนวณ', 'วิทยาศาสตร์และเทคโนโลยี'], ['ว32281', 'การออกแบบและเทคโนโลยี', 'วิทยาศาสตร์และเทคโนโลยี'], ['ค32101', 'คณิตศาสตร์พื้นฐาน', 'คณิตศาสตร์']]) {
    courseIds.push((await courses.saveCourse(admin, { code: c[0], nameTh: c[1], learningArea: c[2], gradeLevel: 'ม.5', credits: '1', hours: 40 })).id);
  }
  const offerings = [];
  for (const [ci, section, ti] of [[0, 'ม.5/1', 0], [1, 'ม.5/2', 1], [2, 'ม.5/1', 2]]) {
    offerings.push((await courses.saveOffering(admin, { courseId: courseIds[ci], termId: term1, sectionCode: section, ownerTeacherId: teachers[ti].id })).offeringId);
  }
  await courses.setCoTeacher(admin, { offeringId: offerings[0], teacherId: teachers[1].id, perms: { can_grade: true, can_export: true } });
  const first = ['กิตติ', 'ขวัญใจ', 'คณิน', 'จิราพร', 'ชยพล', 'ณัฐธิดา', 'ธนกร', 'นภัสสร', 'ปภาวิน', 'พิมพ์ชนก', 'ภูมิพัฒน์', 'วรรณวิสา'];
  const students = [];
  for (let i = 0; i < first.length; i++) {
    const code = ('00' + (121 + i)).slice(-5);
    const r = await registry.saveStudent(admin, {
      studentCode: code, prefix: i % 2 === 0 ? 'นาย' : 'นางสาว', firstName: first[i], lastName: 'ทดสอบ' + (i + 1),
      classLevel: 'ม.5', room: i < 6 ? '1' : '2', rollNo: (i % 6) + 1
    });
    const sdoc = (await db.doc('students/' + r.student.id).get()).data();
    await setKnownPassword(sdoc.uid, pw);
    accounts[code] = pw;
    students.push(Object.assign({ id: r.student.id }, sdoc));
  }
  const ids = (list) => list.map((s) => s.id);
  await courses.enroll(admin, { offeringId: offerings[0], studentIds: ids(students.slice(0, 8)) });
  await courses.enroll(admin, { offeringId: offerings[1], studentIds: ids(students.slice(4, 12)) });
  await courses.enroll(admin, { offeringId: offerings[2], studentIds: ids(students) });
  const offA = offerings[0];
  await wg.save(admin, { offeringId: offA, name: 'ทีมอัลฟา', studentIds: ids(students.slice(0, 3)), leaderStudentId: students[0].id });
  await wg.save(admin, { offeringId: offA, name: 'ทีมเบต้า', studentIds: ids(students.slice(3, 6)), leaderStudentId: students[3].id });
  const day = 86400000, iso = (n) => new Date(Date.now() + n * day).toISOString();
  const W1 = await assessments.saveAssessment(admin, {
    offeringId: offA, code: 'W1', title: 'ใบงานที่ 1 ผังงานและรหัสเทียม', description: 'เขียนผังงานของโจทย์ในใบงาน ส่งเป็น PDF หรือรูปถ่ายที่ชัดเจน',
    kind: 'individual', maxScore: '20', weight: '30', countsTowardGrade: true, openAt: iso(-3), dueAt: iso(7), closeAt: iso(10), allowLate: true,
    allowedTypes: 'pdf,jpg,jpeg,png,docx', maxFiles: 5, status: 'published'
  });
  const G1 = await assessments.saveAssessment(admin, {
    offeringId: offA, code: 'G1', title: 'โครงงานกลุ่ม: แอปพลิเคชันช่วยเรียน', description: 'ใช้กลุ่มประจำรายวิชา ส่งเอกสารโครงงานและสไลด์นำเสนอ',
    kind: 'group', maxScore: '20', weight: '20', countsTowardGrade: true, openAt: iso(-3), dueAt: iso(14), closeAt: iso(14), allowLinks: true,
    allowedTypes: 'pdf,pptx,docx,jpg,png', maxFiles: 10, group: { minSize: 2, maxSize: 4 }, status: 'published'
  });
  const EX1 = await assessments.saveAssessment(admin, { offeringId: offA, code: 'EX1', title: 'สอบกลางภาค', kind: 'exam', maxScore: '50', weight: '50', countsTowardGrade: true, dueAt: iso(20), status: 'published' });
  return {
    schoolId: boot.schoolId, accounts, password: pw, offerings: { A: offA, B: offerings[1], C: offerings[2] },
    assessments: { W1: W1.id, G1: G1.id, EX1: EX1.id }, students: Object.fromEntries(students.map((s) => [s.code, s.id])),
    teachers: Object.fromEntries(teachers.map((t) => [t.code, t.id]))
  };
}
