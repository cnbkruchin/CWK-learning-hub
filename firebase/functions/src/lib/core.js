/**
 * แกนกลางของ Cloud Functions: Admin SDK, บริบทผู้ใช้, ตัวช่วยตรวจข้อมูล, บันทึกตรวจสอบ, แจ้งเตือน
 *
 * หลักการ (เหมือนรุ่น Apps Script)
 * - การเขียนข้อมูลทั้งหมดผ่าน Cloud Functions (แอปอ่านแบบเรียลไทม์ด้วย Firestore ตาม Security Rules)
 * - ตรวจสิทธิ์ที่เซิร์ฟเวอร์ทุกคำขอ: บทบาท (จากเอกสาร users/{uid}) + ความสัมพันธ์กับรายวิชา
 * - เขียนหลายเอกสารใน transaction เดียว (ครบทุกเอกสารหรือไม่บันทึกเลย) และใช้ version ตรวจการแก้พร้อมกัน
 * - เวลาเป็นเวลาเซิร์ฟเวอร์ เก็บเป็นข้อความ ISO 8601 (UTC)
 */
import crypto from 'node:crypto';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { getStorage } from 'firebase-admin/storage';
import Dec from '../shared/dec.js';
import { raise } from './errors.js';

// ใน Cloud Functions ใช้ค่าจาก FIREBASE_CONFIG; สคริปต์บนเครื่อง (seed/ทดสอบกับ emulator) ใช้ GCLOUD_PROJECT
function init() {
  if (process.env.FIREBASE_CONFIG) return initializeApp();
  const projectId = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || 'demo-cwk';
  return initializeApp({ projectId, storageBucket: process.env.STORAGE_BUCKET || projectId + '.appspot.com' });
}
export const app = getApps()[0] || init();
export const db = getFirestore(app);
export const adminAuth = getAuth(app);
export const bucket = () => getStorage(app).bucket();

export const nowIso = () => new Date().toISOString();
export const newId = () => db.collection('_').doc().id;

// ---------------------------------------------------------------- บริบทผู้ใช้
export async function buildCtx(request, opts = {}) {
  const a = request && request.auth;
  if (!a) {
    if (opts.public) return null;
    raise('AUTH_REQUIRED');
  }
  const snap = await db.doc('users/' + a.uid).get();
  if (!snap.exists) raise('AUTH_REQUIRED', 'ยังไม่มีข้อมูลบัญชีในระบบ (อาจรอผู้ดูแลอนุมัติ)');
  const u = snap.data();
  if (u.status !== 'active') raise('AUTH_DISABLED');
  if (u.mustChangePassword && !opts.allowMustChange) raise('PASSWORD_CHANGE_REQUIRED');
  const roles = {};
  (u.roles || []).forEach((r) => { roles[r] = true; });
  return {
    uid: a.uid, schoolId: u.schoolId, roles, teacherId: u.teacherId || '', studentId: u.studentId || '',
    name: u.displayName || u.username, user: u, requestId: crypto.randomBytes(4).toString('hex')
  };
}

export function requireAdmin(ctx) { if (!ctx || !ctx.roles.admin) raise('FORBIDDEN'); }
export function requireStaff(ctx) { if (!ctx || (!ctx.roles.admin && !ctx.roles.teacher && !ctx.roles.grade_admin)) raise('FORBIDDEN'); }
export function requireStudent(ctx) { if (!ctx || !ctx.studentId) raise('FORBIDDEN'); }

// ---------------------------------------------------------------- ตรวจข้อมูล
export function str(v, max, label) {
  let s = v === null || v === undefined ? '' : String(v);
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  if (max && s.length > max) raise('VALIDATION', (label || 'ข้อความ') + ' ยาวเกิน ' + max + ' ตัวอักษร');
  return s;
}
export function requireStr(v, label, max) {
  const s = str(v, max || 500, label);
  if (!s) raise('VALIDATION', 'กรุณาระบุ ' + label, { field: label });
  return s;
}
export function optInt(v, label, min, max) {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) raise('VALIDATION', label + ' ต้องเป็นจำนวนเต็ม ' + min + '–' + max);
  return n;
}
export function decimal(v, label) {
  if (v === undefined || v === null || v === '') return '';
  try { return Dec.normalize(v); } catch (e) { raise('VALIDATION', label + ' ต้องเป็นตัวเลข'); }
  return '';
}
export function isoOrEmpty(v, label) {
  if (!v) return '';
  const d = new Date(v);
  if (isNaN(d.getTime())) raise('VALIDATION', 'รูปแบบวันเวลาไม่ถูกต้อง: ' + (label || v));
  return d.toISOString();
}
export function uniqueIds(list, max) {
  const ids = (list || []).map(String).filter((v, i, a) => v && a.indexOf(v) === i);
  if (max && ids.length > max) raise('VALIDATION', 'เลือกได้ครั้งละไม่เกิน ' + max + ' รายการ');
  return ids;
}

/** รหัสสั้นอ่านง่าย (ไม่มี 0/O/1/I) */
export function shortCode(len) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[crypto.randomInt(alphabet.length)];
  return out;
}
export const tempPassword = () => shortCode(4) + '-' + shortCode(4) + '-' + shortCode(4);

/** อ่านหลายเอกสาร (ในหรือนอก transaction) คืน Map id → data (ไม่มี = ไม่อยู่ใน Map) */
export async function getMany(t, refs) {
  if (!refs.length) return new Map();
  const snaps = t ? await t.getAll(...refs) : await db.getAll(...refs);
  const m = new Map();
  snaps.forEach((s) => { if (s.exists) m.set(s.id, Object.assign({ id: s.id }, s.data())); });
  return m;
}
export async function getDoc(t, ref) {
  const s = t ? await t.get(ref) : await ref.get();
  return s.exists ? Object.assign({ id: s.id }, s.data()) : null;
}
export async function queryDocs(t, q) {
  const s = t ? await t.get(q) : await q.get();
  return s.docs.map((d) => Object.assign({ id: d.id }, d.data()));
}

/** เขียนเป็นชุดละไม่เกิน 450 รายการ (สำหรับงานใหญ่ที่ไม่ต้อง atomic ทั้งหมด เช่น นำเข้า) */
export async function writeInChunks(ops) {
  for (let i = 0; i < ops.length; i += 450) {
    const b = db.batch();
    ops.slice(i, i + 450).forEach((op) => op(b));
    await b.commit();
  }
}

// ---------------------------------------------------------------- บันทึกตรวจสอบและแจ้งเตือน
const SENSITIVE = /pass|token|secret|ticket|hash|url/i;
function sanitize(v, depth = 0) {
  if (depth > 5) return '[truncated]';
  if (Array.isArray(v)) return v.slice(0, 100).map((x) => sanitize(x, depth + 1));
  if (v && typeof v === 'object') {
    const o = {};
    Object.keys(v).forEach((k) => { o[k] = SENSITIVE.test(k) ? '[redacted]' : sanitize(v[k], depth + 1); });
    return o;
  }
  if (typeof v === 'string' && v.length > 500) return v.slice(0, 500) + '…';
  return v === undefined ? null : v;
}

export async function audit(ctx, action, entity, entityId, detail, reason, offeringId) {
  try {
    await db.collection('auditLog').add({
      schoolId: ctx && ctx.schoolId || '', actorUid: ctx && ctx.uid || '', actorName: ctx && ctx.name || '',
      action, entity: entity || '', entityId: entityId || '', offeringId: offeringId || '',
      detail: sanitize(detail || null), reason: reason || '', requestId: ctx && ctx.requestId || '', at: nowIso()
    });
  } catch (e) {
    console.error('audit failed', e);
  }
}

/** แจ้งเตือนในแอป (ข้อความต้องไม่มีคะแนนส่วนตัว) */
export async function notify(uids, type, title, body, link) {
  const list = (uids || []).filter(Boolean).filter((v, i, a) => a.indexOf(v) === i);
  if (!list.length) return;
  try {
    const at = nowIso();
    await writeInChunks(list.map((uid) => (b) => b.set(db.collection('notifications').doc(uid).collection('items').doc(), {
      type, title, body: body || '', link: link || '', at, readAt: ''
    })));
  } catch (e) {
    console.error('notify failed', e);
  }
}
