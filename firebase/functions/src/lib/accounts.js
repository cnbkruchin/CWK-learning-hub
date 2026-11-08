/**
 * บัญชีผู้ใช้บน Firebase Auth + เอกสาร users/{uid} + custom claims สำหรับ Security Rules
 *
 * - ชื่อผู้ใช้ (เช่น รหัสนักเรียน) → อีเมลภายใน (authEmail) นักเรียนไม่ต้องมีอีเมลจริง
 * - บทบาทอยู่ในเอกสาร users/{uid}.roles (แหล่งความจริงที่ Cloud Functions ใช้) และคัดลอกเป็น custom claims
 *   { sid, roles, tid, stid } ให้ Security Rules ใช้ตรวจการอ่านแบบเรียลไทม์
 *   เมื่อ claims เปลี่ยน ระบบเพิ่ม claimsRev ในเอกสาร users แอปที่ฟังอยู่จะขอโทเคนใหม่ทันที
 * - รหัสผ่านชั่วคราวต้องเปลี่ยนเมื่อเข้าใช้ครั้งแรก (mustChangePassword)
 */
import { db, adminAuth, nowIso, tempPassword, getDoc, audit, requireAdmin } from './core.js';
import { raise } from './errors.js';
import { authEmail } from '../shared/config.js';

export async function getSchool(schoolId) {
  const s = await getDoc(null, db.doc('schools/' + schoolId));
  if (!s) raise('SETUP_REQUIRED');
  return s;
}

export function checkStrength(password, username) {
  const pw = String(password || '');
  if (pw.length < 8) raise('VALIDATION', 'รหัสผ่านต้องยาวอย่างน้อย 8 ตัวอักษร');
  if (pw.length > 128) raise('VALIDATION', 'รหัสผ่านยาวเกินไป');
  if (/^(.)\1+$/.test(pw)) raise('VALIDATION', 'รหัสผ่านต้องไม่เป็นตัวอักษรซ้ำกันทั้งหมด');
  if (username && pw.toLowerCase().includes(String(username).toLowerCase())) raise('VALIDATION', 'รหัสผ่านต้องไม่มีชื่อผู้ใช้อยู่ในนั้น');
}

export function claimsOf(u) {
  return { sid: u.schoolId, roles: u.roles || [], tid: u.teacherId || '', stid: u.studentId || '' };
}

export async function syncClaims(uid) {
  const u = await getDoc(null, db.doc('users/' + uid));
  if (!u) return;
  await adminAuth.setCustomUserClaims(uid, claimsOf(u));
  await db.doc('users/' + uid).update({ claimsRev: (u.claimsRev || 0) + 1 });
}

/**
 * สร้างผู้ใช้ใน Firebase Auth (นอก transaction) — ผู้เรียกต้องเขียนเอกสาร users/{uid} เองใน transaction
 * และลบผู้ใช้ด้วย deleteAuthUser หาก transaction ล้มเหลว
 */
export async function createAuthUser(school, username, displayName, password, opts = {}) {
  try {
    const rec = await adminAuth.createUser({
      email: authEmail(username, school.code), password, displayName: displayName || username, disabled: !!opts.disabled, emailVerified: false
    });
    return rec.uid;
  } catch (e) {
    if (e && (e.code === 'auth/email-already-exists' || e.code === 'auth/uid-already-exists')) raise('DUPLICATE', 'ชื่อผู้ใช้ ' + username + ' มีในระบบแล้ว');
    if (e && e.code === 'auth/invalid-password') raise('VALIDATION', 'รหัสผ่านไม่ถูกต้องตามเงื่อนไข');
    throw e;
  }
}
export async function deleteAuthUser(uid) {
  try { await adminAuth.deleteUser(uid); } catch (e) { console.error('cleanup auth user failed', uid, e); }
}

export function userDoc(schoolId, username, displayName, roles, extra) {
  return Object.assign({
    schoolId, username: String(username).toLowerCase(), displayName: displayName || username, roles,
    teacherId: '', studentId: '', status: 'active', mustChangePassword: true, tempIssuedAt: nowIso(),
    claimsRev: 0, createdAt: nowIso()
  }, extra || {});
}

// ---------------------------------------------------------------- เปลี่ยน/รีเซ็ตรหัสผ่าน สถานะ บทบาท
/**
 * เปลี่ยนรหัสผ่านของตนเอง: ต้องเพิ่งยืนยันตัวตน (เข้าสู่ระบบหรือยืนยันรหัสเดิมภายใน 5 นาที)
 * หลังเปลี่ยน session เดิมทุกเครื่องถูกเพิกถอน แอปต้องเข้าสู่ระบบใหม่ด้วยรหัสใหม่
 */
export async function changePassword(ctx, data, request) {
  const authTime = Number(request && request.auth && request.auth.token && request.auth.token.auth_time || 0);
  if (!authTime || Date.now() / 1000 - authTime > 300) raise('FORBIDDEN', 'กรุณายืนยันรหัสผ่านเดิมอีกครั้งก่อนเปลี่ยนรหัสผ่าน');
  checkStrength(data.newPassword, ctx.user.username);
  await adminAuth.updateUser(ctx.uid, { password: String(data.newPassword) });
  await db.doc('users/' + ctx.uid).update({ mustChangePassword: false, passwordUpdatedAt: nowIso() });
  await adminAuth.revokeRefreshTokens(ctx.uid);
  await audit(ctx, 'password.change', 'users', ctx.uid, {});
  return { ok: true };
}

export async function resetPassword(ctx, data) {
  requireAdmin(ctx);
  const u = await getDoc(null, db.doc('users/' + String(data.userId || '')));
  if (!u || u.schoolId !== ctx.schoolId) raise('NOT_FOUND');
  const pw = tempPassword();
  await adminAuth.updateUser(u.id, { password: pw });
  await adminAuth.revokeRefreshTokens(u.id);
  await db.doc('users/' + u.id).update({ mustChangePassword: true, tempIssuedAt: nowIso() });
  await audit(ctx, 'password.reset', 'users', u.id, {});
  return { username: u.username, tempPassword: pw };
}

export async function setUserStatus(ctx, data) {
  requireAdmin(ctx);
  const status = data.status;
  if (['active', 'disabled'].indexOf(status) < 0) raise('VALIDATION');
  if (data.userId === ctx.uid) raise('VALIDATION', 'ปิดบัญชีตนเองไม่ได้');
  const u = await getDoc(null, db.doc('users/' + String(data.userId || '')));
  if (!u || u.schoolId !== ctx.schoolId) raise('NOT_FOUND');
  await adminAuth.updateUser(u.id, { disabled: status === 'disabled' });
  if (status === 'disabled') await adminAuth.revokeRefreshTokens(u.id);
  await db.doc('users/' + u.id).update({ status });
  await audit(ctx, 'user.status', 'users', u.id, { status }, String(data.reason || ''));
  return { ok: true };
}

/** ให้/เพิกถอนบทบาทพิเศษ admin หรือ grade_admin (ผู้ดูแลที่ให้/แก้คะแนนได้ ต้องมีบันทึก) */
export async function setRole(ctx, data) {
  requireAdmin(ctx);
  const role = data.role;
  if (['admin', 'grade_admin'].indexOf(role) < 0) raise('VALIDATION', 'กำหนดได้เฉพาะบทบาทผู้ดูแลระบบหรือผู้ดูแลคะแนน');
  if (data.userId === ctx.uid && role === 'admin' && !data.grant) raise('VALIDATION', 'เพิกถอนสิทธิ์ผู้ดูแลของตนเองไม่ได้');
  const ref = db.doc('users/' + String(data.userId || ''));
  await db.runTransaction(async (t) => {
    const u = await getDoc(t, ref);
    if (!u || u.schoolId !== ctx.schoolId) raise('NOT_FOUND');
    const roles = (u.roles || []).filter((r) => r !== role);
    if (data.grant) roles.push(role);
    t.update(ref, { roles });
  });
  await syncClaims(ref.id);
  await audit(ctx, data.grant ? 'role.grant' : 'role.revoke', 'users', ref.id, { role }, String(data.reason || ''));
  return { ok: true };
}
