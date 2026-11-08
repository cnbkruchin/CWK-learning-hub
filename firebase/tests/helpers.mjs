/**
 * ตัวช่วยทดสอบกับ Firebase Emulator (Auth, Firestore, Functions, Storage)
 * - เข้าสู่ระบบด้วย Firebase JS SDK เหมือนแอปจริง แล้วเรียก Cloud Function 'api' และอ่าน Firestore ตาม Security Rules
 * - รันผ่าน: npm test (firebase emulators:exec ตั้งตัวแปร *_EMULATOR_HOST ให้)
 */
import { initializeApp, deleteApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, signInWithEmailAndPassword, signOut } from 'firebase/auth';
import { getFirestore, connectFirestoreEmulator } from 'firebase/firestore';
import { getFunctions, connectFunctionsEmulator, httpsCallable } from 'firebase/functions';
import { getStorage, connectStorageEmulator } from 'firebase/storage';
import { authEmail, REGION } from '../functions/src/shared/config.js';

export const PROJECT = process.env.GCLOUD_PROJECT || 'demo-cwk';
export const PASSWORD = 'Test#Pass2569';
const FS = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8085';
const AUTH = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';
const ST = process.env.FIREBASE_STORAGE_EMULATOR_HOST || '127.0.0.1:9199';
export const config = { apiKey: 'demo-key', projectId: PROJECT, authDomain: PROJECT + '.firebaseapp.com', storageBucket: PROJECT + '.appspot.com', appId: 'demo-app' };

export async function resetEmulators() {
  await fetch('http://' + FS + '/emulator/v1/projects/' + PROJECT + '/databases/(default)/documents', { method: 'DELETE' });
  await fetch('http://' + AUTH + '/emulator/v1/projects/' + PROJECT + '/accounts', { method: 'DELETE' });
}

let seq = 0;
const apps = [];

/** แอปจำลองหนึ่งเครื่อง (หนึ่งผู้ใช้) */
export function device() {
  const app = initializeApp(config, 'u' + (++seq) + '-' + Date.now());
  apps.push(app);
  const auth = getAuth(app);
  connectAuthEmulator(auth, 'http://' + AUTH, { disableWarnings: true });
  const db = getFirestore(app);
  const [fh, fp] = FS.split(':');
  connectFirestoreEmulator(db, fh, Number(fp));
  const functions = getFunctions(app, REGION);
  connectFunctionsEmulator(functions, '127.0.0.1', 5001);
  const storage = getStorage(app);
  const [sh, sp] = ST.split(':');
  connectStorageEmulator(storage, sh, Number(sp));
  const apiFn = httpsCallable(functions, 'api', { timeout: 120000 });
  const api = async (action, payload) => (await apiFn({ action, payload: payload || {} })).data;
  return { app, auth, db, functions, storage, api };
}

export async function login(username, password, schoolCode = 'DEMO') {
  const d = device();
  const cred = await signInWithEmailAndPassword(d.auth, authEmail(username, schoolCode), password || PASSWORD);
  d.uid = cred.user.uid;
  d.user = cred.user;
  return d;
}

export async function logout(d) { await signOut(d.auth); }

/** ดาวน์โหลดไฟล์ผ่าน files.open / files.chunk (เหมือนแอป) คืน Buffer */
export async function download(d, offeringId, fileId) {
  const m = await d.api('files.open', { offeringId, fileId });
  const parts = [];
  for (let i = 0; i < m.chunks; i++) parts.push(Buffer.from((await d.api('files.chunk', { offeringId, fileId, index: i })).data, 'base64'));
  return Buffer.concat(parts);
}

/** รอให้ promise ล้มด้วยรหัสข้อผิดพลาดของระบบ (details.code) หรือรหัส Firebase */
export async function rejects(p, code) {
  try {
    await p;
  } catch (e) {
    const got = (e.details && e.details.code) || e.code;
    if (code && got !== code && !String(e.code || '').endsWith('/' + code)) {
      throw new Error('expected ' + code + ' but got ' + got + ': ' + e.message);
    }
    return e;
  }
  throw new Error('expected rejection ' + (code || ''));
}

/** รอจนเงื่อนไขเป็นจริง (สำหรับข้อมูลเรียลไทม์) */
export async function until(fn, ms = 8000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < ms) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e; }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('timeout waiting: ' + (last && last.message || last));
}

export async function cleanup() {
  await Promise.all(apps.splice(0).map((a) => deleteApp(a).catch(() => {})));
}

let seeded = null;
/** ล้างข้อมูลแล้วใส่ข้อมูลสาธิตใหม่ (ใช้บริการจริงผ่าน Admin SDK) */
export async function freshSeed() {
  await resetEmulators();
  const { seedDemo } = await import('../scripts/seed-lib.mjs');
  seeded = await seedDemo({ password: PASSWORD });
  return seeded;
}

export async function adminDb() {
  return (await import('../functions/src/lib/core.js')).db;
}

/** ไฟล์ตัวอย่างที่มีโครงสร้างจริง */
export const samples = {
  pdf: (n = 2000) => Buffer.concat([Buffer.from('%PDF-1.7\n1 0 obj << >> endobj\n'), Buffer.alloc(n, 0x20), Buffer.from('\n%%EOF\n')]),
  png: (n = 2000) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(n, 7)]),
  exe: () => Buffer.concat([Buffer.from('MZ'), Buffer.alloc(500, 1)])
};
