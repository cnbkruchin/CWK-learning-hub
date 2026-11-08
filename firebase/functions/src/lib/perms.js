/**
 * สิทธิ์ตามบทบาทและความสัมพันธ์กับรายวิชาที่เปิดสอน (ตรวจที่เซิร์ฟเวอร์ทุกครั้ง)
 * - ครูเจ้าของรายวิชา: ทุกสิทธิ์ · ครูร่วมสอน: ตามธงสิทธิ์ใน offerings/{id}/staff/{uid}
 * - ผู้ดูแล: ดู/จัดการ/ส่งออก/ปิดผล ทุกรายวิชาในโรงเรียน · ผู้ดูแลคะแนน (grade_admin): ดู/ให้คะแนน/แก้คะแนน/ประกาศ
 * - นักเรียน: เฉพาะรายวิชาที่ลงทะเบียน (offerings/{id}/enrollments/{studentId})
 */
import { db, getDoc } from './core.js';
import { raise } from './errors.js';
import { OFFERING_PERMISSIONS } from '../shared/config.js';

export function nonePerms() {
  const p = { student: false, enrollment: null, owner: false };
  OFFERING_PERMISSIONS.forEach((k) => { p[k] = false; });
  return p;
}

export async function computePerms(ctx, offering, t) {
  const p = nonePerms();
  if (!offering || offering.schoolId !== ctx.schoolId) return p;
  if (ctx.roles.admin) { p.can_view = p.can_export = p.can_manage = p.can_close = true; }
  if (ctx.roles.grade_admin) { p.can_view = p.can_grade = p.can_edit_scores = p.can_publish = true; }
  if (ctx.roles.teacher) {
    const staff = await getDoc(t, db.doc('offerings/' + offering.id + '/staff/' + ctx.uid));
    if (staff && staff.active) {
      if (staff.role === 'owner') { OFFERING_PERMISSIONS.forEach((k) => { p[k] = true; }); p.owner = true; }
      else OFFERING_PERMISSIONS.forEach((k) => { if (staff.perms && staff.perms[k]) p[k] = true; });
    }
  }
  if (ctx.studentId) {
    const enr = await getDoc(t, db.doc('offerings/' + offering.id + '/enrollments/' + ctx.studentId));
    if (enr) { p.student = true; p.enrollment = enr; }
  }
  return p;
}

/** โหลดรายวิชาและตรวจสิทธิ์ครู/ผู้ดูแล (ใช้ได้ทั้งนอกและใน transaction — อ่านก่อนเขียนเสมอ) */
export async function requireOffering(ctx, offeringId, perm, t) {
  if (!offeringId || typeof offeringId !== 'string') raise('NOT_FOUND');
  const o = await getDoc(t, db.doc('offerings/' + offeringId));
  if (!o || o.schoolId !== ctx.schoolId) raise('NOT_FOUND');
  const perms = await computePerms(ctx, o, t);
  if (!perms[perm || 'can_view']) raise('FORBIDDEN');
  return { offering: o, perms };
}

/** นักเรียนต้องลงทะเบียนในรายวิชา; activeOnly = ยังเรียนอยู่ */
export async function requireEnrollment(ctx, offeringId, activeOnly, t) {
  if (!ctx.studentId) raise('FORBIDDEN');
  const o = await getDoc(t, db.doc('offerings/' + offeringId));
  if (!o || o.schoolId !== ctx.schoolId) raise('NOT_FOUND');
  const enr = await getDoc(t, db.doc('offerings/' + offeringId + '/enrollments/' + ctx.studentId));
  if (!enr) raise('NOT_ENROLLED');
  if (activeOnly && enr.status !== 'active') raise('NOT_ENROLLED', 'การลงทะเบียนรายวิชานี้สิ้นสุดแล้ว');
  return { offering: o, enrollment: enr };
}

export function openForChanges(offering) {
  if (offering.status === 'closed' || offering.status === 'archived') raise('OFFERING_CLOSED');
}
