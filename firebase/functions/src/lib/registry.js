/**
 * ทะเบียนนักเรียน ครู การนำเข้าเป็นชุด การสมัครใช้งานของนักเรียน และค่าตั้งของโรงเรียน (ผู้ดูแล)
 * ตรรกะเดียวกับ gas/Registry.js แต่จัดเก็บบน Firestore และสร้างบัญชีบน Firebase Auth
 *
 * - รหัสนักเรียนเก็บเป็นข้อความเสมอ (00123 ไม่หาย) และไม่ซ้ำในโรงเรียน (เอกสาร uniq/{schoolId}~student~{code})
 * - ค่าว่างในไฟล์นำเข้าไม่ลบข้อมูลเดิม นำเข้าซ้ำไม่สร้างซ้ำ ระบบไม่เดาเติมเลขศูนย์
 * - การสมัครใช้งานเองต้องรอผู้ดูแลอนุมัติเสมอ (บัญชี Auth ถูกสร้างแบบปิดใช้งานจนกว่าจะอนุมัติ)
 */
import crypto from 'node:crypto';
import { FieldValue } from 'firebase-admin/firestore';
import {
  db, adminAuth, nowIso, newId, str, requireStr, optInt, getDoc, getMany, queryDocs, writeInChunks, audit, notify,
  requireAdmin, tempPassword
} from './core.js';
import { raise } from './errors.js';
import { getSchool, checkStrength, createAuthUser, deleteAuthUser, userDoc, syncClaims } from './accounts.js';
import { authEmail, personName, roomLabel, DEFAULT_SETTINGS } from '../shared/config.js';
import FileCheck from '../shared/filecheck.js';
import { linkEnrollmentsUid } from './courses.js';

const CODE_RE = /^[0-9A-Za-z._-]{1,30}$/;
const STUDENT_STATUS = ['active', 'graduated', 'transferred', 'withdrawn', 'inactive'];
const PREFIXES = ['เด็กชาย', 'เด็กหญิง', 'นางสาว', 'นาย', 'นาง', 'ด.ช.', 'ด.ญ.', 'น.ส.'];
const uniqRef = (schoolId, kind, code) => db.doc('uniq/' + encodeURIComponent(schoolId + '~' + kind + '~' + String(code).toLowerCase()));

export function cleanStudent(d) {
  const code = requireStr(d.studentCode, 'รหัสนักเรียน', 30);
  if (!CODE_RE.test(code)) raise('VALIDATION', 'รหัสนักเรียนใช้ได้เฉพาะตัวเลข ตัวอักษรอังกฤษ . _ - (ไม่เกิน 30 ตัว)');
  const status = d.status || 'active';
  if (STUDENT_STATUS.indexOf(status) < 0) raise('VALIDATION', 'สถานะนักเรียนไม่ถูกต้อง');
  const s = {
    code, prefix: str(d.prefix, 30, 'คำนำหน้า'), firstName: requireStr(d.firstName, 'ชื่อ', 100), lastName: str(d.lastName, 100, 'นามสกุล'),
    classLevel: str(d.classLevel, 20, 'ชั้น'), room: str(d.room, 20, 'ห้อง'), rollNo: optInt(d.rollNo, 'เลขที่', 0, 9999), status
  };
  s.name = personName(s);
  s.roomLabel = roomLabel(s.classLevel, s.room);
  return s;
}

/** อัปเดตชื่อ/ห้องในรายชื่อของทุกรายวิชาที่นักเรียนลงทะเบียน (roster ที่เพื่อนร่วมชั้นเห็น) */
async function refreshRosters(students) {
  const ops = [];
  for (let i = 0; i < students.length; i += 30) {
    const chunk = students.slice(i, i + 30);
    const byId = new Map(chunk.map((s) => [s.id, s]));
    const snap = await db.collectionGroup('enrollments').where('studentId', 'in', chunk.map((s) => s.id)).get();
    snap.docs.forEach((d) => {
      const s = byId.get(d.get('studentId'));
      ops.push((b) => b.set(d.ref.parent.parent.collection('roster').doc(s.id), { name: s.name, roomLabel: s.roomLabel }, { merge: true }));
    });
  }
  await writeInChunks(ops);
}

// ---------------------------------------------------------------- นักเรียน
export async function saveStudent(ctx, d) {
  requireAdmin(ctx);
  const data = cleanStudent(d);
  const school = await getSchool(ctx.schoolId);
  const creating = !d.id;
  const wantAccount = creating && d.createAccount !== false;
  const pw = wantAccount ? tempPassword() : '';
  const uid = wantAccount ? await createAuthUser(school, data.code, data.name, pw) : '';
  const id = d.id || newId();
  let result, renamed = null;
  try {
    result = await db.runTransaction(async (t) => {
      const ref = db.doc('students/' + id);
      const cur = creating ? null : await getDoc(t, ref);
      if (!creating && (!cur || cur.schoolId !== ctx.schoolId)) raise('NOT_FOUND');
      if (cur && d.version !== undefined && d.version !== null && Number(d.version) !== Number(cur.version)) raise('CONFLICT');
      const uq = await getDoc(t, uniqRef(ctx.schoolId, 'student', data.code));
      if (uq && uq.refId !== id) raise('DUPLICATE', 'รหัสนักเรียน ' + data.code + ' มีในระบบแล้ว');
      const now = nowIso();
      if (cur && cur.code.toLowerCase() !== data.code.toLowerCase()) {
        t.delete(uniqRef(ctx.schoolId, 'student', cur.code));
        if (cur.uid && cur.username === cur.code.toLowerCase()) renamed = { uid: cur.uid, username: data.code.toLowerCase() };
      }
      t.set(uniqRef(ctx.schoolId, 'student', data.code), { refId: id, kind: 'student' });
      const doc = Object.assign({}, data, { schoolId: ctx.schoolId, updatedAt: now, updatedBy: ctx.uid, version: (cur ? cur.version || 0 : 0) + 1 });
      if (creating) { doc.createdAt = now; doc.createdBy = ctx.uid; doc.uid = uid; doc.username = uid ? data.code.toLowerCase() : ''; }
      t.set(ref, doc, { merge: true });
      if (uid) t.set(db.doc('users/' + uid), userDoc(ctx.schoolId, data.code, data.name, ['student'], { studentId: id }));
      if (cur && cur.uid) t.update(db.doc('users/' + cur.uid), Object.assign({ displayName: data.name }, renamed ? { username: renamed.username } : {}));
      return Object.assign({ id }, cur || {}, doc);
    });
  } catch (e) {
    if (uid) await deleteAuthUser(uid);
    throw e;
  }
  if (uid) await syncClaims(uid);
  if (renamed) await adminAuth.updateUser(renamed.uid, { email: authEmail(renamed.username, school.code) });
  if (result.uid) await adminAuth.updateUser(result.uid, { displayName: result.name });
  if (!creating) await refreshRosters([result]);
  await audit(ctx, creating ? 'student.create' : 'student.update', 'students', id, { code: data.code, account: !!uid });
  return { student: { id, code: result.code, name: result.name, version: result.version }, account: uid ? { username: data.code.toLowerCase(), tempPassword: pw } : null };
}

export async function createStudentAccount(ctx, d) {
  requireAdmin(ctx);
  const school = await getSchool(ctx.schoolId);
  const s = await getDoc(null, db.doc('students/' + String(d.studentId || '')));
  if (!s || s.schoolId !== ctx.schoolId) raise('NOT_FOUND');
  if (s.uid) raise('DUPLICATE', 'นักเรียนคนนี้มีบัญชีแล้ว ใช้ "รีเซ็ตรหัสผ่าน" แทน');
  const pw = tempPassword();
  const uid = await createAuthUser(school, s.code, s.name, pw);
  try {
    await db.runTransaction(async (t) => {
      const cur = await getDoc(t, db.doc('students/' + s.id));
      if (cur.uid) raise('DUPLICATE');
      t.update(db.doc('students/' + s.id), { uid, username: s.code.toLowerCase() });
      t.set(db.doc('users/' + uid), userDoc(ctx.schoolId, s.code, s.name, ['student'], { studentId: s.id }));
    });
  } catch (e) { await deleteAuthUser(uid); throw e; }
  await syncClaims(uid);
  await linkEnrollmentsUid(s.id, uid);
  await audit(ctx, 'student.account', 'students', s.id, {});
  return { username: s.code.toLowerCase(), tempPassword: pw };
}

// ---------------------------------------------------------------- นำเข้าเป็นชุด (หัวตารางไทย/อังกฤษ)
const HEADER_ALIASES = {
  studentCode: ['student_code', 'code', 'id', 'student_id', 'รหัสนักเรียน', 'รหัส', 'เลขประจำตัว', 'เลขประจำตัวนักเรียน'],
  prefix: ['prefix', 'title', 'คำนำหน้า', 'คำนำหน้าชื่อ'],
  firstName: ['first_name', 'firstname', 'ชื่อ'],
  lastName: ['last_name', 'lastname', 'surname', 'นามสกุล', 'สกุล'],
  fullName: ['full_name', 'name', 'ชื่อ-สกุล', 'ชื่อ-นามสกุล', 'ชื่อ - นามสกุล', 'ชื่อสกุล', 'ชื่อ นามสกุล'],
  classLevel: ['class_level', 'class', 'grade', 'ชั้น', 'ระดับชั้น', 'ชั้นเรียน'],
  room: ['room', 'ห้อง'],
  rollNo: ['roll_no', 'no', 'number', 'เลขที่']
};

export function parseTable(text) {
  text = String(text || '').replace(/^﻿/, '');
  const first = text.split(/\r?\n/)[0] || '';
  const delim = first.includes('\t') ? '\t' : (first.split(';').length > first.split(',').length ? ';' : ',');
  const rows = []; let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; } else field += c;
    } else if (c === '"' && field === '') inQ = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return { delimiter: delim, rows: rows.filter((r) => r.some((v) => String(v).trim() !== '')) };
}

function mapHeader(header) {
  const map = {};
  header.forEach((h, i) => {
    const key = String(h || '').trim().toLowerCase().replace(/\s+/g, ' ');
    Object.keys(HEADER_ALIASES).forEach((f) => { if (map[f] === undefined && HEADER_ALIASES[f].includes(key)) map[f] = i; });
  });
  return map;
}

function splitName(full) {
  let s = String(full || '').trim().replace(/\s+/g, ' '), prefix = '';
  PREFIXES.some((p) => { if (s.startsWith(p)) { prefix = p; s = s.slice(p.length).trim(); return true; } return false; });
  const i = s.indexOf(' ');
  return { prefix, first: i < 0 ? s : s.slice(0, i), last: i < 0 ? '' : s.slice(i + 1) };
}

function rowToStudent(map, r) {
  const get = (f) => (map[f] === undefined ? '' : String(r[map[f]] === undefined ? '' : r[map[f]]).trim());
  const out = { studentCode: get('studentCode'), prefix: get('prefix'), firstName: get('firstName'), lastName: get('lastName'), classLevel: get('classLevel'), room: get('room'), rollNo: get('rollNo') };
  if (!out.firstName && get('fullName')) {
    const n = splitName(get('fullName'));
    out.firstName = n.first; out.lastName = out.lastName || n.last; out.prefix = out.prefix || n.prefix;
  }
  if (out.classLevel.indexOf('/') > 0 && !out.room) {
    const parts = out.classLevel.split('/');
    out.classLevel = parts[0].trim(); out.room = parts.slice(1).join('/').trim();
  }
  return out;
}

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

export async function importStudents(ctx, d) {
  requireAdmin(ctx);
  const parsed = parseTable(d.text);
  if (parsed.rows.length < 2) raise('VALIDATION', 'ไม่พบข้อมูล (แถวแรกต้องเป็นหัวตาราง เช่น รหัสนักเรียน, คำนำหน้า, ชื่อ, นามสกุล, ชั้น, ห้อง, เลขที่)');
  const map = mapHeader(parsed.rows[0]);
  if (map.studentCode === undefined) raise('VALIDATION', 'ไม่พบคอลัมน์รหัสนักเรียน (student_code หรือ รหัสนักเรียน)');
  if (map.firstName === undefined && map.fullName === undefined) raise('VALIDATION', 'ไม่พบคอลัมน์ชื่อ (first_name หรือ ชื่อ หรือ ชื่อ-นามสกุล)');
  const body = parsed.rows.slice(1);
  if (body.length > 500) raise('VALIDATION', 'นำเข้าได้ครั้งละไม่เกิน 500 แถว กรุณาแบ่งไฟล์');
  const existing = new Map();
  (await queryDocs(null, db.collection('students').where('schoolId', '==', ctx.schoolId))).forEach((s) => existing.set(s.code, s));
  const seen = {};
  const fields = ['prefix', 'firstName', 'lastName', 'classLevel', 'room', 'rollNo'];
  const rows = body.map((r, i) => {
    const rowNo = i + 2;
    const src = rowToStudent(map, r);
    const res = { rowNo, code: src.studentCode, name: [src.prefix, src.firstName, src.lastName].filter(Boolean).join(' '), room: roomLabel(src.classLevel, src.room) };
    try {
      if (!src.studentCode) raise('VALIDATION', 'ไม่มีรหัสนักเรียน');
      if (seen[src.studentCode]) raise('VALIDATION', 'รหัสซ้ำกับแถวที่ ' + seen[src.studentCode]);
      seen[src.studentCode] = rowNo;
      const cur = existing.get(src.studentCode);
      if (cur) {
        const merged = cleanStudent({
          studentCode: src.studentCode, prefix: src.prefix || cur.prefix, firstName: src.firstName || cur.firstName, lastName: src.lastName || cur.lastName,
          classLevel: src.classLevel || cur.classLevel, room: src.room || cur.room, rollNo: src.rollNo !== '' ? src.rollNo : cur.rollNo, status: cur.status
        });
        const changed = fields.filter((f) => String(merged[f] ?? '') !== String(cur[f] ?? ''));
        Object.assign(res, { result: changed.length ? 'update' : 'skip', message: changed.length ? 'แก้ไข: ' + changed.join(', ') : 'มีอยู่แล้ว ข้อมูลเหมือนเดิม', data: merged, id: cur.id, changed, cur });
      } else {
        Object.assign(res, { data: cleanStudent(src), result: 'insert', message: 'เพิ่มใหม่' });
      }
    } catch (e) {
      if (!e.code || e.code === 'INTERNAL') throw e;
      res.result = 'error'; res.message = e.message;
    }
    return res;
  });
  const counts = { insert: 0, update: 0, skip: 0, error: 0 };
  rows.forEach((r) => { counts[r.result]++; });
  const warnings = [];
  const codes = rows.filter((r) => r.result !== 'error').map((r) => r.code);
  if (codes.length && codes.every((c) => /^\d+$/.test(c))) {
    const lens = [...new Set(codes.map((c) => c.length))].sort();
    if (lens.length > 1) warnings.push('รหัสนักเรียนยาวไม่เท่ากัน (' + lens.join(', ') + ' หลัก) อาจมีเลขศูนย์นำหน้าหายไปจาก Excel ระบบไม่เติมศูนย์ให้เอง กรุณาตรวจก่อนยืนยัน');
  }
  const mapping = {};
  Object.keys(map).forEach((k) => { mapping[k] = parsed.rows[0][map[k]]; });
  const publicRows = rows.map((r) => ({ rowNo: r.rowNo, code: r.code, name: r.name, room: r.room, result: r.result, message: r.message }));
  if (!d.commit) return { counts, warnings, mapping, delimiter: parsed.delimiter === '\t' ? 'tab' : parsed.delimiter, rows: publicRows };
  if (counts.error && !d.skipErrors) raise('VALIDATION', 'มีแถวที่ผิด ' + counts.error + ' แถว กรุณาแก้ไขก่อน หรือเลือกนำเข้าเฉพาะแถวที่ถูกต้อง', { counts });

  const school = await getSchool(ctx.schoolId);
  const createAccounts = d.createAccounts !== false;
  const inserts = rows.filter((r) => r.result === 'insert');
  const now = nowIso();
  // บัญชี Auth สร้างก่อน (ทีละ 10) หากรหัสนั้นมีบัญชีอยู่แล้วจะไม่สร้างนักเรียนแถวนั้นและรายงานเป็นแถวผิด
  const accounts = [];
  await pool(inserts, 10, async (r) => {
    r.id = newId();
    if (!createAccounts) return;
    r.pw = tempPassword();
    try { r.uid = await createAuthUser(school, r.data.code, r.data.name, r.pw); } catch (e) { r.result = 'error'; r.message = e.message; }
  });
  const ops = [];
  inserts.filter((r) => r.result === 'insert').forEach((r) => {
    const doc = Object.assign({}, r.data, { schoolId: ctx.schoolId, createdAt: now, createdBy: ctx.uid, updatedAt: now, updatedBy: ctx.uid, version: 1, uid: r.uid || '', username: r.uid ? r.data.code.toLowerCase() : '' });
    ops.push((b) => b.set(db.doc('students/' + r.id), doc));
    ops.push((b) => b.set(uniqRef(ctx.schoolId, 'student', r.data.code), { refId: r.id, kind: 'student' }));
    if (r.uid) {
      ops.push((b) => b.set(db.doc('users/' + r.uid), userDoc(ctx.schoolId, r.data.code, r.data.name, ['student'], { studentId: r.id })));
      accounts.push({ code: r.data.code, name: r.data.name, room: r.data.roomLabel, username: r.data.code.toLowerCase(), tempPassword: r.pw });
    }
  });
  const updated = [];
  rows.filter((r) => r.result === 'update').forEach((r) => {
    const patch = { updatedAt: now, updatedBy: ctx.uid, version: FieldValue.increment(1) };
    r.changed.forEach((f) => { patch[f] = r.data[f]; });
    patch.name = r.data.name; patch.roomLabel = r.data.roomLabel;
    ops.push((b) => b.update(db.doc('students/' + r.id), patch));
    if (r.cur.uid) ops.push((b) => b.update(db.doc('users/' + r.cur.uid), { displayName: r.data.name }));
    updated.push({ id: r.id, name: r.data.name, roomLabel: r.data.roomLabel });
  });
  await writeInChunks(ops);
  await pool(inserts.filter((r) => r.uid && r.result === 'insert'), 10, (r) => syncClaims(r.uid));
  if (updated.length) await refreshRosters(updated);
  const finalCounts = { insert: 0, update: 0, skip: 0, error: 0 };
  rows.forEach((r) => { finalCounts[r.result]++; });
  const job = await db.collection('importJobs').add({ schoolId: ctx.schoolId, kind: 'students', status: 'committed', committedAt: now, by: ctx.uid, mapping, counts: finalCounts });
  await audit(ctx, 'student.import', 'importJobs', job.id, { counts: finalCounts, accounts: accounts.length });
  return { importJobId: job.id, counts: finalCounts, accounts, skippedRows: rows.filter((r) => r.result === 'error').map((r) => ({ rowNo: r.rowNo, code: r.code, message: r.message })) };
}

// ---------------------------------------------------------------- ครู
export async function saveTeacher(ctx, d) {
  requireAdmin(ctx);
  const code = requireStr(d.teacherCode, 'รหัสครู', 30);
  if (!CODE_RE.test(code)) raise('VALIDATION', 'รหัสครูใช้ได้เฉพาะตัวเลข ตัวอักษรอังกฤษ . _ -');
  const data = {
    code, prefix: str(d.prefix, 30), firstName: requireStr(d.firstName, 'ชื่อ', 100), lastName: str(d.lastName, 100),
    department: str(d.department, 100, 'กลุ่มสาระ'), status: d.status === 'inactive' ? 'inactive' : 'active'
  };
  data.name = personName(data);
  const creating = !d.id;
  const username = creating ? String(d.username || code).trim().toLowerCase() : '';
  if (creating && !/^[a-z0-9._@-]{3,100}$/.test(username)) raise('VALIDATION', 'ชื่อผู้ใช้ใช้ได้เฉพาะ a-z 0-9 . _ - (หรืออีเมล) อย่างน้อย 3 ตัว');
  const school = await getSchool(ctx.schoolId);
  const pw = creating && d.createAccount !== false ? tempPassword() : '';
  const uid = pw ? await createAuthUser(school, username, data.name, pw) : '';
  const id = d.id || newId();
  let result;
  try {
    result = await db.runTransaction(async (t) => {
      const ref = db.doc('teachers/' + id);
      const cur = creating ? null : await getDoc(t, ref);
      if (!creating && (!cur || cur.schoolId !== ctx.schoolId)) raise('NOT_FOUND');
      if (cur && d.version !== undefined && d.version !== null && Number(d.version) !== Number(cur.version)) raise('CONFLICT');
      const uq = await getDoc(t, uniqRef(ctx.schoolId, 'teacher', code));
      if (uq && uq.refId !== id) raise('DUPLICATE', 'รหัสครู ' + code + ' มีในระบบแล้ว');
      if (cur && cur.code.toLowerCase() !== code.toLowerCase()) t.delete(uniqRef(ctx.schoolId, 'teacher', cur.code));
      t.set(uniqRef(ctx.schoolId, 'teacher', code), { refId: id, kind: 'teacher' });
      const doc = Object.assign({}, data, { schoolId: ctx.schoolId, updatedAt: nowIso(), version: (cur ? cur.version || 0 : 0) + 1 });
      if (creating) Object.assign(doc, { uid, username: uid ? username : '', createdAt: nowIso() });
      t.set(ref, doc, { merge: true });
      if (uid) t.set(db.doc('users/' + uid), userDoc(ctx.schoolId, username, data.name, ['teacher'], { teacherId: id }));
      if (cur && cur.uid) t.update(db.doc('users/' + cur.uid), { displayName: data.name });
      return Object.assign({ id }, cur || {}, doc);
    });
  } catch (e) { if (uid) await deleteAuthUser(uid); throw e; }
  if (uid) await syncClaims(uid);
  if (!creating) {
    const offs = await queryDocs(null, db.collection('offerings').where('ownerTeacherId', '==', id));
    await writeInChunks(offs.map((o) => (b) => b.update(db.doc('offerings/' + o.id), { ownerName: data.name })));
  }
  await audit(ctx, creating ? 'teacher.create' : 'teacher.update', 'teachers', id, { code });
  return { teacher: { id, code, name: data.name, version: result.version }, account: uid ? { username, tempPassword: pw } : null };
}

// ---------------------------------------------------------------- ค่าตั้งโรงเรียน
const EDITABLE = {
  appName: (v) => requireStr(v, 'ชื่อระบบ', 100),
  maxFileMb: (v) => intIn(v, 1, 100, 'ขนาดไฟล์สูงสุด (MB)'),
  maxFilesPerSubmission: (v) => intIn(v, 1, 50, 'จำนวนไฟล์ต่อการส่ง'),
  allowedFileTypes: (v) => {
    const list = (Array.isArray(v) ? v : String(v || '').split(/[,\s;]+/)).map((x) => String(x).trim().toLowerCase()).filter(Boolean);
    list.forEach((ext) => { if (!FileCheck.TYPES[ext]) raise('VALIDATION', 'ระบบยังไม่รองรับการตรวจชนิดไฟล์ .' + ext); });
    if (!list.length) raise('VALIDATION', 'ต้องอนุญาตอย่างน้อยหนึ่งชนิดไฟล์');
    return list;
  },
  selfRegistrationEnabled: (v) => v === true || v === 'true'
};
function intIn(v, min, max, label) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) raise('VALIDATION', label + ' ต้องเป็นจำนวนเต็ม ' + min + '–' + max);
  return n;
}

export async function updateSettings(ctx, d) {
  requireAdmin(ctx);
  const clean = {};
  const changes = d.changes || {};
  Object.keys(changes).forEach((k) => {
    if (k === 'selfRegistrationCode') return;
    if (!EDITABLE[k]) raise('VALIDATION', 'แก้ค่า ' + k + ' ไม่ได้');
    clean['settings.' + k] = EDITABLE[k](changes[k]);
  });
  if (Object.keys(clean).length) await db.doc('schools/' + ctx.schoolId).update(clean);
  if (changes.selfRegistrationCode !== undefined) {
    await db.doc('schoolSecrets/' + ctx.schoolId).set({ selfRegistrationCode: str(changes.selfRegistrationCode, 50, 'รหัสลงทะเบียน') }, { merge: true });
  }
  await audit(ctx, 'settings.update', 'schools', ctx.schoolId, Object.assign({}, clean, changes.selfRegistrationCode !== undefined ? { selfRegistrationCode: '(changed)' } : {}));
  return { ok: true };
}

export function settingsOf(school) {
  return Object.assign({}, DEFAULT_SETTINGS, school && school.settings || {});
}

// ---------------------------------------------------------------- นักเรียนสมัครใช้งานเอง
async function findSchool(schoolCode) {
  if (schoolCode) {
    const list = await queryDocs(null, db.collection('schools').where('code', '==', String(schoolCode)).limit(1));
    return list[0] || null;
  }
  const list = await queryDocs(null, db.collection('schools').limit(2));
  return list.length === 1 ? list[0] : null;
}

export async function registrationInfo(ctx, d) {
  const school = await findSchool(d.schoolCode);
  if (!school) return { enabled: false };
  const secret = await getDoc(null, db.doc('schoolSecrets/' + school.id));
  return { enabled: !!settingsOf(school).selfRegistrationEnabled, needsCode: !!(secret && secret.selfRegistrationCode), schoolName: school.nameTh, schoolCode: school.code };
}

async function rateLimit(key, max, seconds) {
  const ref = db.doc('rateLimits/' + key + '~' + Math.floor(Date.now() / 1000 / seconds));
  await db.runTransaction(async (t) => {
    const s = await t.get(ref);
    const n = s.exists ? s.get('n') : 0;
    if (n >= max) raise('BUSY');
    t.set(ref, { n: n + 1, expireAt: new Date(Date.now() + seconds * 2000) });
  });
}

export async function register(ctx, d) {
  const school = await findSchool(d.schoolCode);
  if (!school || !settingsOf(school).selfRegistrationEnabled) raise('REGISTRATION_CLOSED');
  const secret = await getDoc(null, db.doc('schoolSecrets/' + school.id));
  const code = secret && secret.selfRegistrationCode || '';
  if (code) {
    const a = Buffer.from(String(d.registrationCode || '').trim()), b = Buffer.from(code);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) raise('VALIDATION', 'รหัสลงทะเบียนไม่ถูกต้อง (ขอรหัสจากครูหรือผู้ดูแลระบบ)');
  }
  const data = cleanStudent(d);
  checkStrength(d.password, data.code);
  await rateLimit('register~' + school.id, 200, 3600);
  await rateLimit('register~' + school.id + '~' + data.code, 5, 3600);
  const existing = await queryDocs(null, db.collection('students').where('schoolId', '==', school.id).where('code', '==', data.code).limit(1));
  if (existing[0] && existing[0].uid) raise('DUPLICATE', 'รหัสนักเรียนนี้มีบัญชีอยู่แล้ว หากลืมรหัสผ่านกรุณาติดต่อครูหรือผู้ดูแลระบบ');
  let uid;
  try {
    uid = await createAuthUser(school, data.code, data.name, String(d.password), { disabled: true });
  } catch (e) {
    if (e.code === 'DUPLICATE') raise('DUPLICATE', 'มีคำขอลงทะเบียนของรหัสนี้รอการอนุมัติอยู่แล้ว');
    throw e;
  }
  const ref = await db.collection('registrationRequests').add(Object.assign({}, data, { schoolId: school.id, uid, status: 'pending', createdAt: nowIso() }));
  await audit({ schoolId: school.id }, 'registration.request', 'registrationRequests', ref.id, { code: data.code });
  const admins = await queryDocs(null, db.collection('users').where('schoolId', '==', school.id).where('roles', 'array-contains', 'admin'));
  await notify(admins.map((a) => a.id), 'registration', 'มีคำขอลงทะเบียนนักเรียนใหม่', 'รหัส ' + data.code + ' รอการอนุมัติ', 'registrations');
  return { status: 'pending', message: 'ส่งคำขอแล้ว กรุณารอผู้ดูแลอนุมัติ จากนั้นเข้าสู่ระบบด้วยรหัสนักเรียนและรหัสผ่านที่ตั้งไว้' };
}

/** อนุมัติ: ผูกกับทะเบียนเดิมถ้ามี (ผู้ดูแลเพิ่มไว้แต่ยังไม่มีบัญชี) มิฉะนั้นสร้างทะเบียนใหม่ แล้วเปิดใช้บัญชี */
export async function decideRegistration(ctx, d) {
  requireAdmin(ctx);
  const reason = str(d.reason, 500);
  const ref = db.doc('registrationRequests/' + String(d.id || ''));
  const out = await db.runTransaction(async (t) => {
    const r = await getDoc(t, ref);
    if (!r || r.schoolId !== ctx.schoolId) raise('NOT_FOUND');
    if (r.status !== 'pending') raise('CONFLICT', 'คำขอนี้ถูกพิจารณาแล้ว');
    if (!d.approve) {
      t.update(ref, { status: 'rejected', decidedBy: ctx.uid, decidedAt: nowIso(), reason });
      return { status: 'rejected', uid: r.uid };
    }
    const uq = await getDoc(t, uniqRef(ctx.schoolId, 'student', r.code));
    let student = uq ? await getDoc(t, db.doc('students/' + uq.refId)) : null;
    if (student && student.uid) raise('DUPLICATE', 'รหัสนักเรียนนี้มีบัญชีแล้ว ให้ปฏิเสธคำขอนี้');
    const sid = student ? student.id : newId();
    const now = nowIso();
    if (!student) {
      t.set(db.doc('students/' + sid), {
        schoolId: ctx.schoolId, code: r.code, prefix: r.prefix || '', firstName: r.firstName, lastName: r.lastName || '', name: r.name,
        classLevel: r.classLevel || '', room: r.room || '', roomLabel: r.roomLabel, rollNo: r.rollNo ?? null, status: 'active',
        uid: r.uid, username: r.code.toLowerCase(), createdAt: now, updatedAt: now, version: 1
      });
      t.set(uniqRef(ctx.schoolId, 'student', r.code), { refId: sid, kind: 'student' });
    } else {
      t.update(db.doc('students/' + sid), { uid: r.uid, username: r.code.toLowerCase() });
    }
    t.set(db.doc('users/' + r.uid), userDoc(ctx.schoolId, r.code, student ? student.name : r.name, ['student'], { studentId: sid, mustChangePassword: false }));
    t.update(ref, { status: 'approved', studentId: sid, decidedBy: ctx.uid, decidedAt: now, reason });
    return { status: 'approved', uid: r.uid, studentId: sid };
  });
  if (out.status === 'approved') {
    await adminAuth.updateUser(out.uid, { disabled: false });
    await syncClaims(out.uid);
    await linkEnrollmentsUid(out.studentId, out.uid);
    await notify([out.uid], 'registration', 'บัญชีของคุณได้รับการอนุมัติแล้ว', 'เข้าสู่ระบบด้วยรหัสนักเรียนและรหัสผ่านที่ตั้งไว้', '');
  } else {
    await deleteAuthUser(out.uid);
  }
  await audit(ctx, 'registration.' + out.status, 'registrationRequests', ref.id, {}, reason);
  return { status: out.status, studentId: out.studentId || '' };
}
