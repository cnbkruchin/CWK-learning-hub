'use strict';
/**
 * ทดสอบหน้าเว็บในเบราว์เซอร์จริง (Chromium ผ่าน Playwright) กับเซิร์ฟเวอร์จำลอง tools/dev-server.js
 * เส้นทาง: นักเรียนอัปโหลด/ส่งงานเดี่ยว (มีไฟล์ปลอมถูกปฏิเสธ) → จัดกลุ่ม เชิญ ตอบรับ → ส่งงานกลุ่ม
 *          → ครูเปิดดูไฟล์ ส่งคืนแก้ไข สร้างภาระงาน → นักเรียนเห็นสถานะส่งคืน → ผู้ดูแลเปลี่ยนรหัสผ่านและดูสถานะ
 * ใช้: npm run test:e2e   (ต้องมี playwright; ตั้ง SHOTS_DIR เพื่อเก็บภาพหน้าจอ)
 */
const fs = require('fs');
const path = require('path');
const { start } = require('../../tools/dev-server');

function loadPlaywright() {
  try { return require('playwright'); } catch (e) {
    const root = require('child_process').execSync('npm root -g').toString().trim();
    return require(path.join(root, 'playwright'));
  }
}
const { chromium } = loadPlaywright();
const SHOTS = process.env.SHOTS_DIR || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const shot = (p, name, opts) => (SHOTS ? p.screenshot(Object.assign({ path: path.join(SHOTS, name) }, opts || {})) : Promise.resolve());
let acc;
let BASE;
const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n1 0 obj << >> endobj\n'), Buffer.alloc(3 * 1024 * 1024, 0x20), Buffer.from('\n%%EOF\n')]);
const png = Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]), Buffer.alloc(2000, 7)]);
const errors = [];
const check = (cond, msg) => { if (!cond) throw new Error('ASSERT: ' + msg); };
async function login(page, u, p) {
  await page.goto(BASE);
  await page.fill('#u', u); await page.fill('#p', p || acc[u]);
  await page.click('#login-form button[type=submit]');
}
(async () => {
  const port = 8000 + Math.floor(Math.random() * 900);
  const srv = await start(port);
  acc = srv.accounts;
  BASE = 'http://localhost:' + port + '/';
  const browser = await chromium.launch();
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const page = await mobile.newPage();
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/fonts\.g/.test(m.text())) errors.push('console: ' + m.text()); });
  page.on('dialog', d => d.accept());
  await login(page, '00121');
  await page.waitForSelector('text=รายวิชาของฉัน');
  await shot(page, '01-student-home.png');
  await page.click('text=วิทยาการคำนวณ');
  await page.waitForSelector('text=ใบงานที่ 1');
  await shot(page, '02-student-course.png');
  await page.click('text=ใบงานที่ 1');
  await page.waitForSelector('#drop');
  await page.setInputFiles('#file-input', [
    { name: 'ผังงาน.pdf', mimeType: 'application/pdf', buffer: pdf },
    { name: 'รูปถ่าย.png', mimeType: 'image/png', buffer: png },
    { name: 'ปลอม.pdf', mimeType: 'application/pdf', buffer: png }
  ]);
  await page.waitForFunction(() => document.querySelectorAll('#uploads .chip').length === 3, null, { timeout: 30000 });
  await shot(page, '03-student-uploaded.png', { fullPage: true });
  const statuses = await page.$$eval('#uploads .chip', els => els.map(e => e.textContent));
  check(statuses.filter((x) => /ฉบับร่าง/.test(x)).length === 2 && /ไม่ตรงกับนามสกุล/.test(statuses[2]), 'upload statuses ' + statuses);
  await page.waitForFunction(() => document.querySelectorAll('#drafts .file-row').length === 2);
  await page.fill('#comment', 'ส่งงานครับ');
  await page.click('#btn-submit');
  await page.waitForSelector('dialog[open] >> text=ส่งงานสำเร็จ', { timeout: 15000 });
  await shot(page, '04-student-receipt.png');
  const receipt = await page.textContent('dialog code');
  check(/^CWK-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(receipt.trim()), 'receipt ' + receipt);
  await page.click('dialog [data-close]');
  await page.waitForSelector('text=รุ่นที่ 1');
  // group work
  await page.click('[data-back]');
  await page.waitForSelector('text=โครงงานกลุ่ม');
  await page.click('text=โครงงานกลุ่ม');
  await page.waitForSelector('#new-group');
  await page.fill('#new-group', 'ทีมแอปช่วยเรียน');
  await page.click('#btn-create');
  await page.waitForSelector('#invite-sel');
  await page.selectOption('#invite-sel', { label: 'นางสาว ขวัญใจ ทดสอบ2 (ห้อง 1)' });
  await page.click('#btn-invite');
  await page.waitForSelector('text=รอตอบรับคำเชิญ');
  await shot(page, '05-student-group.png', { fullPage: true });

  const p2ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const p2 = await p2ctx.newPage();
  p2.on('pageerror', e => errors.push('p2 pageerror: ' + e.message));
  p2.on('dialog', d => d.accept());
  await login(p2, '00122');
  await p2.waitForSelector('text=รายวิชาของฉัน');
  await p2.click('text=วิทยาการคำนวณ');
  await p2.click('text=โครงงานกลุ่ม');
  await p2.waitForSelector('text=คำเชิญถึงคุณ');
  await p2.click('[data-respond][data-ok="1"]');
  await p2.waitForSelector('text=ทีมแอปช่วยเรียน');
  await p2.waitForSelector('#drop');
  await p2.setInputFiles('#file-input', [{ name: 'สไลด์.pdf', mimeType: 'application/pdf', buffer: pdf.subarray(0, 5000) }]);
  await p2.waitForSelector('#uploads .chip.ok');
  await p2.fill('#links', 'https://example.com/demo-app');
  await p2.click('#btn-submit');
  await p2.waitForSelector('dialog[open] >> text=ส่งงานสำเร็จ');
  await p2.click('dialog [data-close]');
  await p2.waitForSelector('text=สมาชิก ณ เวลาส่ง');
  await shot(p2, '06-group-submitted.png', { fullPage: true });

  // teacher on desktop
  const t = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
  t.on('pageerror', e => errors.push('t pageerror: ' + e.message));
  t.on('dialog', d => d.accept());
  await login(t, 'demo_t001');
  await t.waitForSelector('text=รายวิชาที่สอน');
  await t.click('text=วิทยาการคำนวณ');
  await t.waitForSelector('text=สร้างภาระงาน');
  await shot(t, '07-teacher-offering.png');
  await t.click('[data-queue]');
  await t.waitForSelector('#qrows tr');
  await shot(t, '08-teacher-queue.png');
  await t.click('[data-sub]');
  await t.waitForSelector('text=ตรวจรุ่นที่ 1');
  await t.click('[data-open]');
  await t.waitForSelector('dialog[open] iframe, dialog[open] img', { timeout: 20000 });
  await shot(t, '09-teacher-preview.png');
  await t.click('dialog [data-close]');
  await t.fill('#rnote', 'เพิ่มคำอธิบายขั้นตอนที่ 3');
  await t.click('#btn-return');
  await t.waitForSelector('text=ส่งคืนแก้ไข');
  // teacher groups page
  await t.click('[data-back]'); await t.click('[data-back]');
  await t.waitForSelector('[data-groups]');
  await t.click('[data-groups]');
  await t.waitForSelector('text=การจัดกลุ่ม');
  await shot(t, '10-teacher-groups.png', { fullPage: true });
  // teacher creates assessment
  await t.click('[data-back]');
  await t.click('#btn-new');
  await t.fill('#f-code', 'W2'); await t.fill('#f-title', 'ใบงานที่ 2'); await t.fill('#f-max', '10'); await t.fill('#f-weight', '0');
  await t.click('#af button[type=submit]');
  await t.waitForSelector('#af-msg .notice');
  check(/น้ำหนัก/.test(await t.textContent('#af-msg')), 'server-side validation shown');
  await t.fill('#f-weight', '10');
  await t.fill('#f-due', '2026-10-15T16:30');
  await t.selectOption('#f-status', 'published');
  await t.click('#af button[type=submit]');
  await t.waitForSelector('text=ใบงานที่ 2');
  const dueCell = await t.textContent('tr:has-text("ใบงานที่ 2") td:nth-child(4)');
  check(/15 ต\.ค\. 2569 16:30/.test(dueCell), 'due date in Bangkok time/BE: ' + dueCell);

  // student sees returned
  await page.reload();
  await page.waitForSelector('text=รายวิชาของฉัน'); // session ยังอยู่หลังรีเฟรช
  await page.click('text=วิทยาการคำนวณ');
  await page.waitForSelector('text=ส่งคืนแก้ไข');
  await shot(page, '11-student-returned.png');

  // admin
  const a = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  a.on('pageerror', e => errors.push('a pageerror: ' + e.message));
  await login(a, 'demo_admin');
  await a.waitForSelector('text=ตั้งรหัสผ่านใหม่');
  await a.fill('#o', acc.demo_admin); await a.fill('#n1', 'Admin#Strong2026'); await a.fill('#n2', 'Admin#Strong2026');
  await a.click('#pw-form button[type=submit]');
  await a.waitForSelector('text=ผู้ดูแลระบบ');
  await shot(a, '12-admin.png', { fullPage: true });
  const real = errors.filter((e) => !/ERR_CERT|fonts|Failed to load resource/.test(e));
  check(!real.length, 'browser errors: ' + real.join('; '));
  await browser.close();
  srv.server.close();
  console.log('UI E2E: ผ่าน');
})().catch((e) => { console.error('UI E2E: ไม่ผ่าน', e); console.log('errors:', errors); process.exit(1); });
