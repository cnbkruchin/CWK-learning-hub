/**
 * Service worker ของ PWA (สร้างตอน build: ใส่รายการไฟล์และเลขรุ่นอัตโนมัติ)
 * - เก็บไฟล์แอปทั้งหมดไว้ในเครื่อง → เปิดแอปได้แม้ไม่มีอินเทอร์เน็ต (ข้อมูลมาจากแคชของ Firestore)
 * - หน้าแอป: ลองเครือข่ายก่อน (ได้รุ่นใหม่ทันทีที่ deploy) ถ้าออฟไลน์ใช้สำเนาในเครื่อง
 * - ไม่แคชการเรียก Firebase (ต่างโดเมน) ข้อมูลเรียลไทม์จึงไม่ค้าง
 */
const VERSION = 'cwk-__VERSION__';
const PRECACHE = __PRECACHE__;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('cwk-') && k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then((r) => {
      if (r.ok) { const copy = r.clone(); caches.open(VERSION).then((c) => c.put('/', copy)); }
      return r;
    }).catch(() => caches.match('/', { ignoreSearch: true })));
    return;
  }
  e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((r) => {
    if (r.ok && (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/'))) { const copy = r.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
    return r;
  })));
});
