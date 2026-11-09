/**
 * CWK Learning Hub — แอปมือถือ/เว็บ (PWA + Capacitor iOS/Android) บน Firebase
 * ข้อมูลอัปเดตแบบเรียลไทม์ด้วย Firestore onSnapshot ทุกหน้า การเขียนผ่าน Cloud Function 'api'
 */
// ฟอนต์ไทย Sarabun อยู่ในแอป (ใช้ได้ออฟไลน์ในแอป iOS/Android และฝังลง PDF ได้)
import '@fontsource/sarabun/400.css';
import '@fontsource/sarabun/600.css';
import '@fontsource/sarabun/700.css';
import './styles.css';
import { Capacitor } from '@capacitor/core';
import { collection, query, orderBy, limit, onSnapshot } from 'firebase/firestore';
import { db, live, useEmulators, configMissing } from './lib/fb.js';
import { views, render, setHome, onRender, home, reset, go, back, depth } from './lib/router.js';
import { h, q, esc, errBox, backBtn, bindBack, initModal, toast } from './lib/ui.js';
import { session, startSession, setRole, logout } from './lib/session.js';
import './views/common.js';
import './views/student.js';
import './views/teacher.js';
import './views/grading.js';
import './views/admin.js';
import './views/reports.js';

setHome(() => {
  if (!session.user) return 'login';
  if (!session.profile) return 'loadingProfile';
  if (session.profile.mustChangePassword) return 'changePassword';
  if (session.role === 'admin') return 'adminHome';
  if (session.role === 'teacher' || session.role === 'grade_admin') return 'teacherHome';
  if (session.role === 'student') return 'studentHome';
  return 'noRole';
});

onRender((t, err) => {
  document.getElementById('topbar').hidden = !session.user || !session.profile;
  if (err) {
    if (!session.user && t.name !== 'login') return;
    h(backBtn() + errBox(err));
    bindBack();
    return;
  }
  h('<div class="loading">กำลังโหลด…</div>');
});

views.loadingProfile = () => h('<div class="loading">กำลังโหลดข้อมูลบัญชี…</div>');
views.noRole = () => {
  h('<div class="card"><h1>ยังไม่มีสิทธิ์ใช้งาน</h1><p>บัญชีนี้ยังไม่ได้รับบทบาทในระบบ กรุณาติดต่อผู้ดูแลระบบ</p><p><button class="btn" id="nr-out">ออกจากระบบ</button></p></div>');
  q('#nr-out').addEventListener('click', logout);
};

let notifUnsub = null;
function topbar() {
  const p = session.profile, s = session.school;
  document.getElementById('app-name').textContent = (s && s.appName) || 'CWK Learning Hub';
  document.getElementById('school-name').textContent = (s ? s.nameTh + ' · ' : '') + (p ? p.displayName : '');
  document.getElementById('demo-banner').hidden = !(s && s.isDemo) && !useEmulators;
  const sw = document.getElementById('role-switch');
  const names = { admin: 'ผู้ดูแลระบบ', teacher: 'ครู', grade_admin: 'ผู้ดูแลคะแนน', student: 'นักเรียน' };
  sw.hidden = session.roles.length < 2;
  sw.innerHTML = session.roles.map((r) => '<option value="' + r + '"' + (r === session.role ? ' selected' : '') + '>' + names[r] + '</option>').join('');
  if (session.user && !notifUnsub) {
    // แจ้งเตือนแบบเรียลไทม์ (ไม่ผูกกับหน้า จึงไม่ใช้ขอบเขตของ router)
    notifUnsub = onSnapshot(query(collection(db, 'notifications', session.user.uid, 'items'), orderBy('at', 'desc'), limit(50)), (snap) => {
      const n = snap.docs.filter((d) => !d.data().readAt).length;
      const b = document.getElementById('notify-count');
      b.hidden = !n; b.textContent = n;
      document.getElementById('btn-notify').setAttribute('aria-label', 'แจ้งเตือน ยังไม่อ่าน ' + n + ' รายการ');
      snap.docChanges().forEach((c) => { if (c.type === 'added' && !snap.metadata.fromCache && c.doc.data().at > startedAt) toast('🔔 ' + c.doc.data().title); });
    }, () => {});
  }
}
const startedAt = new Date().toISOString();

let lastState = '';
function onSession(state) {
  if (state === 'signedOut') {
    if (notifUnsub) { notifUnsub(); notifUnsub = null; }
    lastState = state;
    reset('login');
    return;
  }
  topbar();
  if (state === 'school') return;
  if (state === 'noProfile') { reset('noRole'); return; }
  // โปรไฟล์เปลี่ยนเล็กน้อย (เช่น ชื่อ) ไม่ต้องรีเฟรชหน้าที่กำลังทำงาน ยกเว้นครั้งแรก/บทบาทเปลี่ยน/ต้องเปลี่ยนรหัส
  const key = session.user.uid + '|' + session.role + '|' + (session.profile.mustChangePassword ? 'mcp' : '') + '|' + state.replace('profile', '');
  if (key !== lastState) { lastState = key; home(); }
}
if (configMissing) {
  h('<div class="card" style="max-width:560px;margin:32px auto"><h1>ยังไม่ได้ตั้งค่า Firebase</h1><p>คัดลอก <code>app/.env.example</code> เป็น <code>app/.env.local</code> ใส่ค่าของโปรเจกต์ Firebase แล้ว build ใหม่</p>' +
    '<p class="small muted">ทดลองบนเครื่องโดยไม่ต้องมีโปรเจกต์: <code>npm run dev:demo</code></p></div>');
} else {
  startSession(onSession);
}

initModal();
document.getElementById('btn-home').addEventListener('click', home);
document.getElementById('btn-logout').addEventListener('click', logout);
document.getElementById('btn-notify').addEventListener('click', () => go('notifications'));
document.getElementById('role-switch').addEventListener('change', (e) => { setRole(e.target.value); lastState = ''; topbar(); home(); });

function netState() {
  const off = !navigator.onLine;
  document.getElementById('offline-banner').hidden = !off;
  const ls = document.getElementById('live-state');
  ls.innerHTML = '<span class="live-dot' + (off ? ' off' : '') + '"></span>' + (off ? 'ออฟไลน์' : 'เรียลไทม์');
}
window.addEventListener('online', netState);
window.addEventListener('offline', netState);
netState();

// PWA: ติดตั้งลงหน้าจอหลัก + service worker (ไม่ใช้ในแอป Capacitor ซึ่งมีไฟล์ในเครื่องอยู่แล้ว)
const native = Capacitor.isNativePlatform();
if (!native && 'serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('sw', e)));
}
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  try { if (localStorage.getItem('cwk_install_no')) return; } catch (x) { /* ignore */ }
  document.getElementById('install-banner').hidden = false;
});
document.getElementById('btn-install').addEventListener('click', async () => {
  document.getElementById('install-banner').hidden = true;
  if (deferredPrompt) { deferredPrompt.prompt(); deferredPrompt = null; }
});
document.getElementById('btn-install-no').addEventListener('click', () => {
  document.getElementById('install-banner').hidden = true;
  try { localStorage.setItem('cwk_install_no', '1'); } catch (x) { /* ignore */ }
});
if (native) {
  document.documentElement.classList.add('native');
  // ปุ่มย้อนกลับของ Android: ปิดหน้าต่าง → ย้อนหน้าในแอป → ถ้าอยู่หน้าแรกให้ย่อแอป (ไม่ปิดทิ้ง)
  import('@capacitor/app').then(({ App }) => {
    App.addListener('backButton', () => {
      const d = document.getElementById('modal');
      if (d.open) { d.close(); return; }
      if (depth() > 1) back(); else App.minimizeApp();
    });
    // กลับเข้าแอป: Firestore ต่อการเชื่อมต่อเรียลไทม์ให้เอง แค่ตรวจสถานะเครือข่ายใหม่
    App.addListener('resume', netState);
  }).catch(() => {});
}
void esc; void render; void live;
