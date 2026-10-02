'use strict';
/**
 * ทดสอบหน้าเว็บในเบราว์เซอร์จริง (Chromium ผ่าน Playwright) กับเซิร์ฟเวอร์จำลอง tools/dev-server.js
 * เส้นทาง: นักเรียนอัปโหลด/ส่งงานเดี่ยว (มีไฟล์ปลอมถูกปฏิเสธ) → จัดกลุ่ม เชิญ ตอบรับ → ส่งงานกลุ่ม
 *          → ครูเปิดดูไฟล์ ส่งคืนแก้ไข สร้างภาระงาน → นักเรียนเห็นสถานะส่งคืน → ผู้ดูแลเปลี่ยนรหัสผ่านและดูสถานะ
 *          → ผู้ดูแลเพิ่มนักเรียน/นำเข้าเป็นชุด/อนุมัติการสมัครเอง → ครูลงทะเบียนนักเรียน จัดกลุ่มประจำรายวิชา
 *          → ให้คะแนนกลุ่ม (กระจายให้สมาชิก) ปรับรายคน ประกาศ → รายงาน PDF/Excel → นักเรียนเห็นคะแนนของตน
 * ใช้: npm run test:e2e   (ต้องมี playwright; ตั้ง SHOTS_DIR เพื่อเก็บภาพหน้าจอ, SAMPLES_DIR เพื่อเก็บตัวอย่าง PDF/XLSX)
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
  // ชื่อไฟล์ดาวน์โหลดภาษาไทยต้องใช้ locale แบบ UTF-8 (เครื่องที่ไม่ตั้ง LANG Chromium จะเปลี่ยนชื่อเป็น "download")
  const browser = await chromium.launch({ env: Object.assign({}, process.env, { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' }) });
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

  // ---------- ทะเบียนนักเรียน: เพิ่มทีละคน / นำเข้าเป็นชุด / สมัครเองและอนุมัติ ----------
  await a.click('[data-admin="adminStudents"]');
  await a.waitForSelector('#btn-add');
  await a.click('#btn-add');
  await a.fill('#s-code', '00950'); await a.fill('#s-prefix', 'นาย'); await a.fill('#s-first', 'นักเรียน'); await a.fill('#s-last', 'เพิ่มใหม่');
  await a.fill('#s-class', 'ม.5'); await a.fill('#s-room', '1'); await a.fill('#s-roll', '9');
  await a.click('#sf2 button[type=submit]');
  await a.waitForSelector('dialog[open] .temp-pw');
  check(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test((await a.textContent('dialog[open] .temp-pw')).trim()), 'temp password shown once');
  await shot(a, '13-admin-new-student.png');
  await a.click('dialog [data-close]');
  await a.click('#btn-import');
  await a.fill('#imp-text', 'รหัสนักเรียน\tคำนำหน้า\tชื่อ\tนามสกุล\tชั้น\tห้อง\tเลขที่\n00951\tนางสาว\tนำเข้า\tหนึ่ง\tม.5\t1\t10\n00952\tนาย\tนำเข้า\tสอง\tม.5\t1\t11\n00121\t\t\t\t\t\t\n');
  await a.click('#imp-check');
  await a.waitForSelector('#imp-commit');
  await shot(a, '14-admin-import-preview.png', { fullPage: true });
  await a.click('#imp-commit');
  await a.waitForSelector('dialog[open] >> text=บัญชีนักเรียนที่สร้างใหม่ 2 บัญชี');
  await a.click('dialog [data-close]');
  await a.click('[data-back]'); await a.click('[data-back]');
  await a.click('[data-admin="adminRegistrations"]');
  await a.waitForSelector('#rs-on');
  await a.check('#rs-on');
  await a.click('#rs button[type=submit]');
  await a.waitForSelector('#rs-on:checked');
  const r = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  r.on('pageerror', e => errors.push('r pageerror: ' + e.message));
  await r.goto(BASE);
  await r.waitForSelector('#btn-register', { state: 'visible' });
  await r.click('#btn-register');
  await r.fill('#r-code', '00960'); await r.selectOption('#r-prefix', 'เด็กหญิง'); await r.fill('#r-first', 'สมัคร'); await r.fill('#r-last', 'ด้วยตนเอง');
  await r.fill('#r-class', 'ม.5'); await r.fill('#r-room', '2'); await r.fill('#r-pw', 'Register#2569'); await r.fill('#r-pw2', 'Register#2569');
  await r.click('#reg-form button[type=submit]');
  await r.waitForSelector('text=ส่งคำขอแล้ว');
  await shot(r, '15-student-register.png');
  await a.reload();
  await a.waitForSelector('[data-admin="adminRegistrations"]');
  await a.click('[data-admin="adminRegistrations"]');
  await a.waitForSelector('[data-approve]');
  await a.click('[data-approve]');
  await a.waitForSelector('text=ไม่มีคำขอ');
  await login(r, '00960', 'Register#2569');
  await r.waitForSelector('text=รายวิชาของฉัน');

  // ---------- ครู: ลงทะเบียนนักเรียน กลุ่มประจำรายวิชา ให้คะแนนกลุ่ม ปรับรายคน ประกาศ ----------
  await t.click('.tab:has-text("นักเรียน")');
  await t.waitForSelector('#cand input[name=enr]');
  await t.fill('#c-q', '00950');
  await t.waitForFunction(() => document.querySelectorAll('#cand input[name=enr]').length === 1);
  await t.check('#cand input[name=enr]');
  await t.click('#btn-enroll');
  await t.waitForSelector('td:has-text("00950")');
  await t.click('#join-on');
  await t.waitForSelector('#join-code');
  await shot(t, '16-teacher-roster.png', { fullPage: true });
  await t.click('.tab:has-text("กลุ่มประจำรายวิชา")');
  await t.waitForSelector('h3:has-text("ทีมอัลฟา")');
  const alpha = '.card:has(h3:has-text("ทีมอัลฟา"))';
  const optVal = await t.$eval(alpha + ' select', (el) => Array.from(el.options).find((o) => /00950/.test(o.textContent)).value);
  await t.selectOption(alpha + ' select', optVal);
  await t.click(alpha + ' [data-add]');
  await t.waitForSelector(alpha + ' >> text=00950');
  await shot(t, '17-teacher-workgroups.png', { fullPage: true });
  await t.click('.tab:has-text("ภาระงาน")');
  await t.click('tr:has-text("GP1") [data-grade]');
  await t.waitForSelector('h1:has-text("ให้คะแนนกลุ่ม")');
  const ga = '[data-group]:has(h2:has-text("ทีมอัลฟา"))';
  await t.fill(ga + ' input.score', '9');
  await t.click(ga + ' [data-save-group]');
  await t.waitForSelector('#pv-ok');
  check((await t.$$('dialog[open] tbody tr')).length === 4, 'preview lists all 4 members');
  await t.click('#pv-ok');
  await t.waitForSelector(ga + ' >> text=ได้คะแนนกลุ่ม');
  await t.click(ga + ' tr:has-text("00122") [data-ov]');
  await t.fill('#ov-sc', '6'); await t.fill('#ov-rs', 'มีส่วนร่วมน้อยตามบันทึกการทำงานกลุ่ม');
  await t.click('#ovf button[type=submit]');
  await t.waitForSelector(ga + ' tr:has-text("00122") >> text=ปรับรายคน');
  await shot(t, '18-teacher-group-grading.png', { fullPage: true });
  await t.click('#btn-publish');
  await t.waitForSelector('text=นักเรียนเห็นคะแนนล่าสุดแล้ว');
  await t.click('[data-back]');
  await t.click('.tab:has-text("สมุดคะแนน")');
  await t.waitForSelector('.grade-table');
  await shot(t, '19-teacher-gradebook.png', { fullPage: true });
  await t.click('.tab:has-text("รายงาน")');
  const SAMPLES = process.env.SAMPLES_DIR || '';
  if (SAMPLES) fs.mkdirSync(SAMPLES, { recursive: true });
  for (const [key, name] of [['groups', 'ตัวอย่าง-ผลประเมินงานกลุ่ม'], ['room', 'ตัวอย่าง-สมุดคะแนนแยกตามห้อง']]) {
    await t.click('[data-rv="' + key + '"]');
    await t.waitForSelector('#report');
    check(/ทีมอัลฟา|ห้อง ม\.5\/1/.test(await t.textContent('#report')), 'report content ' + key);
    if (SAMPLES) {
      await t.emulateMedia({ media: 'print' });
      await t.pdf({ path: path.join(SAMPLES, name + '.pdf'), format: 'A4', landscape: true, printBackground: true, preferCSSPageSize: true });
      await t.emulateMedia({ media: 'screen' });
    }
    await shot(t, '20-report-' + key + '.png', { fullPage: true });
    const [dl] = await Promise.all([t.waitForEvent('download'), t.click('#rv-xlsx')]);
    check(/\.xlsx$/.test(dl.suggestedFilename()), 'xlsx download ' + dl.suggestedFilename());
    if (SAMPLES) await dl.saveAs(path.join(SAMPLES, name + '.xlsx'));
    await t.click('[data-back]');
  }

  // ---------- นักเรียนเห็นคะแนนที่ประกาศของตนเอง (ไม่เห็นของเพื่อน) และกลุ่มประจำรายวิชา ----------
  await p2.goto(BASE);
  await p2.waitForSelector('text=รายวิชาของฉัน');
  await p2.click('text=วิทยาการคำนวณ');
  await p2.click('.tab:has-text("คะแนนของฉัน")');
  await p2.waitForSelector('tr:has-text("GP1")');
  check(/\b6\b/.test(await p2.textContent('tr:has-text("GP1")')), 'student sees own overridden score 6');
  await shot(p2, '21-student-grades.png', { fullPage: true });
  await p2.click('.tab:has-text("กลุ่มของฉัน")');
  await p2.waitForSelector('text=นักเรียน เพิ่มใหม่');
  await shot(p2, '22-student-workgroup.png', { fullPage: true });
  await page.goto(BASE);
  await page.waitForSelector('text=รายวิชาของฉัน');
  await page.click('text=วิทยาการคำนวณ');
  await page.click('.tab:has-text("คะแนนของฉัน")');
  await page.waitForSelector('tr:has-text("GP1")');
  check(/\b9\b/.test(await page.textContent('tr:has-text("GP1")')), 'leader sees group score 9');

  const real = errors.filter((e) => !/ERR_CERT|fonts|Failed to load resource/.test(e));
  check(!real.length, 'browser errors: ' + real.join('; '));
  await browser.close();
  srv.server.close();
  console.log('UI E2E: ผ่าน');
})().catch((e) => { console.error('UI E2E: ไม่ผ่าน', e); console.log('errors:', errors); process.exit(1); });
