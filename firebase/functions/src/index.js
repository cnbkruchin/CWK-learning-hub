/**
 * CWK Learning Hub — Cloud Functions (รุ่น Firebase)
 *
 * แอปเรียกฟังก์ชันเดียว: httpsCallable(functions, 'api')({ action, payload })
 * (เหมือน apiCall ของรุ่น Apps Script) — instance เดียวรับทุกคำสั่ง ลด cold start และค่าใช้จ่าย
 * การอ่านข้อมูลแบบเรียลไทม์ทำผ่าน Firestore โดยตรงตาม Security Rules (firestore.rules)
 */
import { setGlobalOptions } from 'firebase-functions/v2';
import { onCall } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { REGION } from './shared/config.js';
import { buildCtx, bucket } from './lib/core.js';
import { AppError, toHttps } from './lib/errors.js';
import * as accounts from './lib/accounts.js';
import * as registry from './lib/registry.js';
import * as courses from './lib/courses.js';
import * as wg from './lib/workgroups.js';
import * as assessments from './lib/assessments.js';
import * as submissions from './lib/submissions.js';
import * as grades from './lib/grades.js';
import * as files from './lib/files.js';

setGlobalOptions({ region: REGION, maxInstances: 20 });

export const routes = {
  // บัญชี
  'auth.changePassword': { fn: accounts.changePassword, allowMustChange: true },
  'auth.registrationInfo': { fn: registry.registrationInfo, public: true },
  'auth.register': { fn: registry.register, public: true },
  // ผู้ดูแล
  'admin.resetPassword': { fn: accounts.resetPassword },
  'admin.setUserStatus': { fn: accounts.setUserStatus },
  'admin.setRole': { fn: accounts.setRole },
  'admin.saveStudent': { fn: registry.saveStudent },
  'admin.createStudentAccount': { fn: registry.createStudentAccount },
  'admin.importStudents': { fn: registry.importStudents },
  'admin.saveTeacher': { fn: registry.saveTeacher },
  'admin.updateSettings': { fn: registry.updateSettings },
  'admin.decideRegistration': { fn: registry.decideRegistration },
  'admin.saveTerm': { fn: courses.saveTerm },
  'admin.saveYear': { fn: courses.saveYear },
  // รายวิชาและทะเบียนผู้เรียน
  'course.save': { fn: courses.saveCourse },
  'offering.save': { fn: courses.saveOffering },
  'offering.setCoTeacher': { fn: courses.setCoTeacher },
  'offering.enroll': { fn: courses.enroll },
  'offering.withdraw': { fn: courses.withdraw },
  'offering.setJoin': { fn: courses.setJoin },
  'student.join': { fn: courses.joinByCode },
  // กลุ่มประจำรายวิชา
  'wg.settings': { fn: wg.saveSettings },
  'wg.save': { fn: wg.save },
  'wg.addMembers': { fn: wg.addMembers },
  'wg.removeMember': { fn: wg.removeMember },
  'wg.disband': { fn: wg.disband },
  'wg.auto': { fn: wg.autoGroup },
  'wg.create': { fn: wg.studentCreate },
  'wg.invite': { fn: wg.invite },
  'wg.respond': { fn: wg.respond },
  'wg.leave': { fn: wg.leave },
  'wg.leaderRemove': { fn: wg.leaderRemove },
  // ภาระงานและการส่งงาน
  'assessment.save': { fn: assessments.saveAssessment },
  'assessment.extend': { fn: assessments.grantExtension },
  'group.moveFrozen': { fn: assessments.moveFrozenMember },
  'submission.attach': { fn: submissions.attachUpload },
  'submission.removeDraft': { fn: submissions.removeDraft },
  'submission.submit': { fn: submissions.submit },
  'submission.review': { fn: submissions.review },
  'files.open': { fn: files.open },
  'files.chunk': { fn: files.chunk },
  // คะแนน
  'grades.save': { fn: grades.saveScores },
  'grades.saveGroup': { fn: grades.saveGroup },
  'grades.override': { fn: grades.override },
  'grades.publish': { fn: grades.publish }
};

export async function dispatch(request) {
  const data = request.data || {};
  const route = Object.prototype.hasOwnProperty.call(routes, data.action) ? routes[data.action] : null;
  try {
    if (!route) throw new AppError('NOT_FOUND', 'ไม่รู้จักคำสั่ง');
    const ctx = await buildCtx(request, route);
    return await route.fn(ctx, data.payload || {}, request);
  } catch (e) {
    throw toHttps(e);
  }
}

export const api = onCall({ memory: '512MiB', timeoutSeconds: 300, concurrency: 40 }, dispatch);

/** ลบไฟล์ที่อัปโหลดแล้วไม่ได้นำเข้าฉบับร่าง (ค้างใน uploads/ เกิน 24 ชั่วโมง) */
export const cleanupUploads = onSchedule({ schedule: 'every day 02:10', timeZone: 'Asia/Bangkok' }, async () => {
  const [files] = await bucket().getFiles({ prefix: 'uploads/' });
  const cutoff = Date.now() - 24 * 3600 * 1000;
  let n = 0;
  for (const f of files) {
    const created = Date.parse(f.metadata.timeCreated || 0);
    if (created && created < cutoff) { await f.delete().catch(() => {}); n++; }
  }
  console.log('cleanupUploads removed', n);
});
