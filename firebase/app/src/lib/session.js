/**
 * สถานะผู้ใช้: ฟังเอกสาร users/{uid} แบบเรียลไทม์
 * - claimsRev เปลี่ยน (ผู้ดูแลให้/ถอนบทบาท) → ขอโทเคนใหม่ทันที เพื่อให้ Security Rules เห็นสิทธิ์ล่าสุด
 * - status ไม่ active → ออกจากระบบ, mustChangePassword → บังคับตั้งรหัสผ่านใหม่
 */
import { onAuthStateChanged, signInWithEmailAndPassword, signOut, reauthenticateWithCredential, EmailAuthProvider } from 'firebase/auth';
import { doc, onSnapshot } from 'firebase/firestore';
import { auth, db, api, DEFAULT_SCHOOL_CODE } from './fb.js';
import { authEmail } from '@shared/config.js';

export const session = { user: null, profile: null, school: null, role: null, roles: [], claimsRev: null };
let unsubs = [];
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set: (k, v) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* ignore */ } }
};
export { store };

export function schoolCode() { return store.get('cwk_school') || DEFAULT_SCHOOL_CODE; }

export function startSession(onChange) {
  onAuthStateChanged(auth, (user) => {
    unsubs.splice(0).forEach((u) => u());
    Object.assign(session, { user, profile: null, school: null, role: null, roles: [], claimsRev: null });
    if (!user) { onChange('signedOut'); return; }
    unsubs.push(onSnapshot(doc(db, 'users', user.uid), async (snap) => {
      if (!snap.exists()) { onChange('noProfile'); return; }
      const p = snap.data();
      if (p.status !== 'active') { await signOut(auth); return; }
      const rev = p.claimsRev || 0;
      const changedRoles = session.claimsRev !== null && rev !== session.claimsRev;
      if (session.claimsRev === null) {
        const claims = (await user.getIdTokenResult()).claims;
        if (JSON.stringify(claims.roles || []) !== JSON.stringify(p.roles || [])) await user.getIdToken(true);
      } else if (changedRoles) {
        await user.getIdToken(true);
      }
      session.claimsRev = rev;
      session.profile = p;
      session.roles = (p.roles || []).filter((r) => ['admin', 'teacher', 'grade_admin', 'student'].includes(r));
      const saved = store.get('cwk_role_' + user.uid);
      session.role = session.roles.includes(saved) ? saved : (['admin', 'teacher', 'grade_admin', 'student'].find((r) => session.roles.includes(r)) || null);
      if (!session.school && p.schoolId) {
        unsubs.push(onSnapshot(doc(db, 'schools', p.schoolId), (s) => { session.school = s.exists() ? Object.assign({ id: s.id }, s.data()) : null; onChange('school'); }, () => {}));
      }
      onChange(changedRoles ? 'roles' : 'profile');
    }, (e) => { console.warn(e); onChange('error', e); }));
  });
}

/** สิทธิ์จริงตาม custom claims (ไม่ขึ้นกับบทบาทที่เลือกแสดงผล) */
export function hasRole(r) { return !!(session.profile && (session.profile.roles || []).includes(r)); }
export const schoolId = () => session.profile && session.profile.schoolId;

export function setRole(role) {
  session.role = role;
  if (session.user) store.set('cwk_role_' + session.user.uid, role);
}

export async function login(username, password, code) {
  const sc = (code || schoolCode()).trim().toUpperCase();
  store.set('cwk_school', sc);
  await signInWithEmailAndPassword(auth, authEmail(username, sc), password);
}

export async function logout() { await signOut(auth); }

/** เปลี่ยนรหัสผ่าน: ยืนยันรหัสเดิม → เซิร์ฟเวอร์ตั้งรหัสใหม่และเพิกถอน session เดิม → เข้าสู่ระบบใหม่ด้วยรหัสใหม่ */
export async function changePassword(oldPassword, newPassword) {
  const user = auth.currentUser;
  await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, oldPassword));
  await api('auth.changePassword', { newPassword });
  await signInWithEmailAndPassword(auth, user.email, newPassword);
}
