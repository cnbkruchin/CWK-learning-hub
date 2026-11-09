/**
 * เชื่อมต่อ Firebase (Auth, Firestore แบบเรียลไทม์ + แคชออฟไลน์, Cloud Functions, Storage)
 * - ค่าโปรเจกต์อ่านจากตัวแปร VITE_FIREBASE_* (ไฟล์ .env) — ค่า config ฝั่งเว็บของ Firebase ไม่ใช่ความลับ
 *   ความปลอดภัยอยู่ที่ Security Rules และการตรวจสิทธิ์ใน Cloud Functions
 * - VITE_USE_EMULATORS=true ใช้ Firebase Emulator บนเครื่อง (โหมดสาธิต/ทดสอบ)
 * - ใน Capacitor (iOS/Android) ใช้ initializeAuth แทน getAuth (ไม่โหลดตัวจัดการ popup/redirect ที่ใช้ใน WebView ไม่ได้)
 */
import { initializeApp } from 'firebase/app';
import { initializeAuth, indexedDBLocalPersistence, browserLocalPersistence, connectAuthEmulator } from 'firebase/auth';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager, memoryLocalCache, connectFirestoreEmulator,
  onSnapshot, getDocs, getDoc
} from 'firebase/firestore';
import { getFunctions, connectFunctionsEmulator, httpsCallable } from 'firebase/functions';
import { getStorage, connectStorageEmulator } from 'firebase/storage';
import { REGION } from '@shared/config.js';
import { currentScope } from './router.js';

const env = import.meta.env;
export const useEmulators = env.VITE_USE_EMULATORS === 'true';
const projectId = env.VITE_FIREBASE_PROJECT_ID || 'demo-cwk';
export const config = {
  apiKey: env.VITE_FIREBASE_API_KEY || 'demo-key',
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN || projectId + '.firebaseapp.com',
  projectId,
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET || projectId + '.appspot.com',
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID || '',
  appId: env.VITE_FIREBASE_APP_ID || 'demo-app'
};
/** build สำหรับใช้งานจริงแต่ยังไม่ได้ใส่ค่าโปรเจกต์ใน app/.env.local */
export const configMissing = !useEmulators && !env.VITE_FIREBASE_API_KEY;
export const DEFAULT_SCHOOL_CODE = env.VITE_SCHOOL_CODE || (useEmulators ? 'DEMO' : 'CWK');

export const app = initializeApp(config);
export const auth = initializeAuth(app, { persistence: [indexedDBLocalPersistence, browserLocalPersistence] });

function cache() {
  if (useEmulators || env.VITE_OFFLINE_CACHE === 'false') return memoryLocalCache();
  try { return persistentLocalCache({ tabManager: persistentMultipleTabManager() }); } catch (e) { return memoryLocalCache(); }
}
// experimentalAutoDetectLongPolling: เครือข่ายบางแห่ง/WebView บางรุ่นไม่รองรับ streaming ระบบจะสลับเป็น long polling ให้เอง
export const db = initializeFirestore(app, { localCache: cache(), experimentalAutoDetectLongPolling: true });
export const functions = getFunctions(app, REGION);
export const storage = getStorage(app);

if (useEmulators) {
  const host = env.VITE_EMULATOR_HOST || (typeof location !== 'undefined' ? location.hostname : '127.0.0.1');
  connectAuthEmulator(auth, 'http://' + host + ':' + (env.VITE_AUTH_PORT || 9099), { disableWarnings: true });
  connectFirestoreEmulator(db, host, Number(env.VITE_FIRESTORE_PORT || 8085));
  connectFunctionsEmulator(functions, host, Number(env.VITE_FUNCTIONS_PORT || 5001));
  connectStorageEmulator(storage, host, Number(env.VITE_STORAGE_PORT || 9199));
}

const apiFn = httpsCallable(functions, 'api', { timeout: 300000 });

/** เรียกบริการฝั่งเซิร์ฟเวอร์ (Cloud Function เดียว) — ข้อผิดพลาดมีข้อความภาษาไทยและ code ของระบบ */
export async function api(action, payload, opts = {}) {
  let attempt = 0;
  for (;;) {
    try {
      return (await apiFn({ action, payload: payload || {} })).data;
    } catch (e) {
      const err = normalizeError(e);
      if (opts.retry && attempt < opts.retry && (err.code === 'NETWORK' || err.code === 'BUSY')) {
        attempt++;
        await new Promise((r) => setTimeout(r, 800 * 2 ** attempt));
        continue;
      }
      throw err;
    }
  }
}

export function normalizeError(e) {
  if (!e) return { code: 'INTERNAL', message: 'เกิดข้อผิดพลาด' };
  const code = (e.details && e.details.code) || String(e.code || '').replace(/^(functions|firestore|auth|storage)\//, '');
  const map = {
    unavailable: ['NETWORK', 'เชื่อมต่อเซิร์ฟเวอร์ไม่สำเร็จ กรุณาตรวจอินเทอร์เน็ตแล้วลองใหม่'],
    'deadline-exceeded': ['NETWORK', 'เซิร์ฟเวอร์ตอบช้า กรุณาลองใหม่'],
    'permission-denied': ['FORBIDDEN', 'คุณไม่มีสิทธิ์ดูหรือทำรายการนี้'],
    'invalid-credential': ['AUTH_INVALID', 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง'],
    'wrong-password': ['AUTH_INVALID', 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง'],
    'user-not-found': ['AUTH_INVALID', 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง'],
    'user-disabled': ['AUTH_DISABLED', 'บัญชีนี้ถูกปิดใช้งานหรือยังรอผู้ดูแลอนุมัติ'],
    'too-many-requests': ['AUTH_LOCKED', 'ลองเข้าสู่ระบบผิดหลายครั้ง กรุณารอสักครู่แล้วลองใหม่'],
    'network-request-failed': ['NETWORK', 'ไม่มีการเชื่อมต่ออินเทอร์เน็ต'],
    unauthorized: ['FORBIDDEN', 'คุณไม่มีสิทธิ์ทำรายการนี้']
  };
  if (e.details && e.details.code) return { code: e.details.code, message: e.message, details: e.details };
  if (map[code]) return { code: map[code][0], message: map[code][1] };
  return { code: code || 'INTERNAL', message: e.message || 'เกิดข้อผิดพลาด' };
}

const withId = (s) => Object.assign({ id: s.id }, s.data());

/**
 * ฟังข้อมูลแบบเรียลไทม์ (onSnapshot) และยกเลิกอัตโนมัติเมื่อเปลี่ยนหน้า
 * target: DocumentReference หรือ Query; cb(data) ได้ object (เอกสาร) / array (query) / null (ไม่มีเอกสาร)
 */
export function live(target, cb, onErr) {
  const isDoc = target.type === 'document';
  const unsub = onSnapshot(target, (snap) => {
    if (isDoc) cb(snap.exists() ? withId(snap) : null, snap);
    else cb(snap.docs.map(withId), snap);
  }, (e) => { console.warn('listener error', e); if (onErr) onErr(normalizeError(e)); });
  const scope = currentScope();
  if (scope) scope.push(unsub);
  return unsub;
}

export async function fetchAll(q) { return (await getDocs(q)).docs.map(withId); }
export async function fetchOne(r) { const s = await getDoc(r); return s.exists() ? withId(s) : null; }
