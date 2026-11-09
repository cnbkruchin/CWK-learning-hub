/**
 * ทดสอบแอปจริงแบบ end-to-end บน Firebase Emulator (รันด้วย: npm run test:e2e)
 * เปิดหลายเบราว์เซอร์พร้อมกัน (ครู 2 คน นักเรียน 3 คน ผู้ดูแล 1 คน) แล้วตรวจว่าการเปลี่ยนแปลงของคนหนึ่ง
 * ปรากฏบนหน้าจอของอีกคน "ทันทีโดยไม่ต้องรีเฟรช" (Firestore realtime) รวมถึงการส่งงาน ให้คะแนนกลุ่ม ประกาศคะแนน และส่งออกรายงาน
 * ภาพหน้าจอบันทึกที่ docs/screenshots/
 */
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createServer } from 'vite';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = fileURLToPath(new URL('..', import.meta.url));
const shots = fileURLToPath(new URL('../../docs/screenshots/', import.meta.url));
mkdirSync(shots, { recursive: true });

const PASSWORD = 'E2e#Pass2569';
const T = 30000;
const results = [];
const pageErrors = [];
const step = async (name, fn) => {
  const t0 = Date.now();
  try { await fn(); results.push(['✓', name, Date.now() - t0]); console.log('✓ ' + name + ' (' + (Date.now() - t0) + ' ms)'); }
  catch (e) { results.push(['✗', name, Date.now() - t0]); console.error('✗ ' + name + '\n', e); throw e; }
};

// ---------------------------------------------------------------- เตรียมข้อมูลสาธิตและเปิดแอป
const { seedDemo } = await import('../scripts/seed-lib.mjs');
const seed = await seedDemo({ password: PASSWORD });
const S = seed.students, A = seed.assessments;
const server = await createServer({ configFile: root + 'app/vite.config.js', mode: 'emulator', server: { port: 5199, strictPort: true }, logLevel: 'warn' });
await server.listen();
const URL_ = 'http://127.0.0.1:5199/';
const browser = await chromium.launch({ env: Object.assign({}, process.env, { LANG: 'C.UTF-8' }) });
const desktop = { viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1, locale: 'th-TH', timezoneId: 'Asia/Bangkok', acceptDownloads: true };
const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'th-TH', timezoneId: 'Asia/Bangkok',
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' };

async function open(user, opts) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  page.setDefaultTimeout(T);
  page.on('pageerror', (e) => { pageErrors.push(user + ': ' + e.message); console.error('[pageerror ' + user + ']', e.message); });
  page.on('dialog', (d) => d.accept());
  await page.goto(URL_);
  await page.fill('#u', user);
  await page.fill('#p', PASSWORD);
  await page.click('#login-form button[type=submit]');
  await page.waitForSelector('#topbar:not([hidden])');
  return page;
}
const course = async (page, code) => { await page.locator('[data-off]', { hasText: code }).first().click(); };
const shot = (page, name) => page.screenshot({ path: shots + name + '.png' });

let teacher, teacher2, alpha1, alpha2, gamma, admin, newbie, importedPw = '';
try {
  await step('เข้าสู่ระบบพร้อมกัน 5 เครื่อง (ครู 2 · นักเรียนบนมือถือ 3)', async () => {
    [teacher, teacher2, alpha1, alpha2, gamma] = await Promise.all([open('demo_t001', desktop), open('demo_t002', desktop), open('00121', phone), open('00122', phone), open('00127', phone)]);
    await teacher.waitForSelector('text=รายวิชาที่สอน');
    await alpha1.waitForSelector('text=รายวิชาของฉัน');
  });

  await step('ครูสร้างกลุ่มและเลือกสมาชิก → นักเรียนเห็นกลุ่มของตนทันที (ไม่รีเฟรช)', async () => {
    await course(gamma, 'ว32201');
    await gamma.click('[data-tab=studentGroups]');
    await gamma.waitForSelector('text=คุณยังไม่มีกลุ่มในรายวิชานี้');
    await course(teacher, 'ว32201');
    await teacher.click('[data-otab=workGroups]');
    await teacher.click('summary:has-text("สร้างกลุ่มและเลือกสมาชิก")');
    await teacher.fill('#wg-name', 'ทีมแกมมา');
    await teacher.check('[name=wgnew][value="' + S['00127'] + '"]');
    await teacher.check('[name=wgnew][value="' + S['00128'] + '"]');
    await teacher.selectOption('#wg-leader', S['00127']);
    const t0 = Date.now();
    await teacher.click('#wg-create');
    await gamma.waitForSelector('h2:has-text("ทีมแกมมา")');
    console.log('   ↳ นักเรียนเห็นกลุ่มใหม่หลังครูกดบันทึก ' + (Date.now() - t0) + ' ms');
    await gamma.waitForSelector('text=คุณเป็นหัวหน้ากลุ่ม');
    await shot(gamma, 'mobile-student-group');
  });

  await step('นักเรียนอัปโหลดและส่งงาน → งานเข้าคิวตรวจของครูทันที + ได้รหัสยืนยัน', async () => {
    await teacher.click('[data-otab=teacherQueue]');
    await teacher.waitForSelector('text=ไม่มีงานรอตรวจ');
    await course(alpha1, 'ว32201');
    await alpha1.click('[data-a="' + A.W1 + '"]');
    await alpha1.waitForSelector('#file-input', { state: 'attached' });
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Count 0/Kids[]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
    await alpha1.setInputFiles('#file-input', { name: 'ใบงาน1-กิตติ.pdf', mimeType: 'application/pdf', buffer: pdf });
    await alpha1.waitForSelector('text=อยู่ในฉบับร่าง');
    await alpha1.fill('#comment', 'ส่งใบงานครับ');
    const t0 = Date.now();
    await alpha1.click('#btn-submit');
    await alpha1.waitForSelector('text=ส่งงานสำเร็จ');
    const receipt = await alpha1.locator('.receipt code').textContent();
    assert.match(receipt, /\S{6,}/);
    await teacher.waitForSelector('#tq li:has-text("กิตติ")');
    console.log('   ↳ คิวตรวจของครูอัปเดตหลังนักเรียนกดส่ง ' + (Date.now() - t0) + ' ms · รหัสยืนยัน ' + receipt);
    await shot(alpha1, 'mobile-student-receipt');
    await alpha1.click('#modal [data-close]');
  });

  await step('ครูรับงาน → สถานะบนมือถือนักเรียนเปลี่ยนทันที', async () => {
    await teacher.click('#tq li:has-text("กิตติ")');
    await teacher.waitForSelector('text=ใบงาน1-กิตติ.pdf');
    await teacher.click('[data-review=accept]');
    await alpha1.waitForSelector('#status-chip:has-text("ตรวจแล้ว")');
  });

  await step('ครูคนที่ 1 ให้คะแนนรายบุคคล → หน้าให้คะแนนของครูคนที่ 2 แสดงค่าใหม่ทันที', async () => {
    await course(teacher2, 'ว32201');
    await teacher2.click('[data-a="' + A.W1 + '"]');
    await teacher2.click('#go-grade');
    await teacher2.waitForSelector('#sc-' + S['00121']);
    await teacher.click('[data-back]');
    await teacher.click('[data-otab=teacherOffering]');
    await teacher.click('[data-a="' + A.W1 + '"]');
    await teacher.click('#go-grade');
    await teacher.fill('#sc-' + S['00121'], '15');
    await teacher.fill('#sc-' + S['00122'], '17.5');
    await teacher.click('#ge-save');
    await teacher.waitForSelector('text=บันทึกแล้ว 2 รายการ');
    await teacher2.waitForFunction((id) => document.getElementById('sc-' + id).value === '15', S['00121']);
    assert.equal(await teacher2.inputValue('#sc-' + S['00122']), '17.5');
    await teacher.click('#pub-go');
    await teacher.waitForSelector('text=ประกาศคะแนนล่าสุดครบแล้ว');
  });

  await step('ให้คะแนนกลุ่มครั้งเดียว → บันทึกเป็นคะแนนของสมาชิกทุกคนอัตโนมัติ → ประกาศ → นักเรียนเห็นทันที', async () => {
    await course(alpha2, 'ว32201');
    await alpha2.click('[data-tab=studentGrades]');
    await alpha2.waitForSelector('#row-' + A.G1 + ':has-text("ยังไม่ประกาศ")');
    await teacher.click('[data-back]');
    await teacher.click('[data-back]');
    await teacher.click('[data-a="' + A.G1 + '"]');
    await teacher.click('#go-grade');
    const card = teacher.locator('.card', { has: teacher.locator('h2', { hasText: 'ทีมอัลฟา' }) });
    await card.locator('.g-sc').fill('18');
    await card.locator('.g-note').fill('นำเสนอดีมาก');
    await card.locator('[data-gsave]').click();
    await teacher.waitForSelector('#modal >> text=ตรวจก่อนบันทึก');
    await teacher.click('#pv-ok');
    await teacher.waitForFunction(() => {
      const c = [...document.querySelectorAll('.card')].find((x) => x.querySelector('h2') && x.querySelector('h2').textContent.includes('ทีมอัลฟา'));
      return c && [...c.querySelectorAll('tbody td.num strong')].length === 3 && [...c.querySelectorAll('tbody td.num strong')].every((s) => s.textContent.trim() === '18');
    });
    await shot(teacher, 'desktop-teacher-group-grading');
    const t0 = Date.now();
    await teacher.click('#pub-go');
    await alpha2.waitForSelector('#row-' + A.G1 + ' strong:has-text("18")');
    console.log('   ↳ หน้าคะแนนของนักเรียนแสดงคะแนนกลุ่มหลังครูกดประกาศ ' + (Date.now() - t0) + ' ms');
    await alpha2.waitForFunction(() => document.getElementById('total').textContent.trim() !== '–');
    await alpha2.waitForSelector('#row-' + A.W1 + ' strong:has-text("17.5")');
    await shot(alpha2, 'mobile-student-grades');
  });

  await step('ครูปรับคะแนนรายคน → คงไว้เมื่อแก้คะแนนกลุ่มภายหลัง (คะแนนกลุ่มยังอยู่ที่กลุ่ม)', async () => {
    await teacher.click('[data-ov="' + S['00123'] + '"]');
    await teacher.fill('#ov-sc', '12');
    await teacher.fill('#ov-rs', 'ไม่ได้ร่วมนำเสนอ');
    await teacher.click('#ov-ok');
    const card = teacher.locator('.card', { has: teacher.locator('h2', { hasText: 'ทีมอัลฟา' }) });
    await card.locator('.chip.warn:has-text("ปรับรายคน")').waitFor();
    await card.locator('.g-sc').fill('19');
    await card.locator('[data-gsave]').click();
    await teacher.waitForSelector('#modal >> text=คงคะแนนที่ปรับรายคน');
    await teacher.click('#pv-ok');
    await teacher.waitForFunction(() => {
      const c = [...document.querySelectorAll('.card')].find((x) => x.querySelector('h2') && x.querySelector('h2').textContent.includes('ทีมอัลฟา'));
      const vals = c ? [...c.querySelectorAll('tbody td.num strong')].map((s) => s.textContent.trim()).sort() : [];
      return vals.join(',') === '12,19,19';
    });
  });

  await step('สมุดคะแนนของครูอัปเดตทันทีและคำนวณคะแนนรวมด้วยโมดูลเดียวกับเซิร์ฟเวอร์', async () => {
    await teacher2.click('[data-back]');
    await teacher2.click('[data-back]');
    await teacher2.click('[data-otab=gradebook]');
    await teacher2.waitForSelector('.grade-table');
    const row = teacher2.locator('tr', { hasText: 'กิตติ' });
    await row.locator('text=15').first().waitFor();
    await shot(teacher2, 'desktop-gradebook');
  });

  await step('ผู้ดูแลออกรายงานแยกตามห้องและแยกตามกลุ่ม เป็น Excel และ PDF', async () => {
    admin = await open('demo_admin', desktop);
    await admin.click('[data-go=adminReports]');
    await admin.waitForSelector('#ar-off');
    await admin.selectOption('#ar-off', seed.offerings.A);
    await admin.click('[data-k=offering][data-g=room]');
    await admin.waitForSelector('#report');
    await admin.waitForSelector('#report h2:has-text("ห้อง ม.5/1")');
    const [x] = await Promise.all([admin.waitForEvent('download'), admin.click('#rv-xlsx')]);
    const xb = readFileSync(await x.path());
    assert.equal(xb.subarray(0, 2).toString(), 'PK');
    assert.match(x.suggestedFilename(), /\.xlsx$/);
    const [p] = await Promise.all([admin.waitForEvent('download', { timeout: 120000 }), admin.click('#rv-pdf')]);
    const pb = readFileSync(await p.path());
    assert.equal(pb.subarray(0, 5).toString(), '%PDF-');
    console.log('   ↳ ' + x.suggestedFilename() + ' (' + xb.length + ' B), ' + p.suggestedFilename() + ' (' + pb.length + ' B)');
    await shot(admin, 'desktop-report');
    if (process.env.E2E_ARTIFACTS) { copyFileSync(await p.path(), process.env.E2E_ARTIFACTS + '/report.pdf'); copyFileSync(await x.path(), process.env.E2E_ARTIFACTS + '/report.xlsx'); }
    await admin.click('[data-back]');
    await admin.waitForSelector('#ar-off');
    assert.equal(await admin.inputValue('#ar-off'), seed.offerings.A, 'จำรายวิชาที่เลือกไว้เมื่อย้อนกลับ');
    await admin.click('[data-k=groups]');
    await admin.waitForSelector('#report h2:has-text("สรุปคะแนนกลุ่มทุกงาน")');
    const txt = await admin.locator('#report').textContent();
    assert.ok(txt.includes('ทีมแกมมา') && txt.includes('ปรับรายคน'));
    const [g] = await Promise.all([admin.waitForEvent('download'), admin.click('#rv-xlsx')]);
    assert.equal(readFileSync(await g.path()).subarray(0, 2).toString(), 'PK');
  });

  await step('ผู้ดูแลเพิ่มนักเรียน → ได้รหัสผ่านชั่วคราว → รายชื่อของผู้ดูแลอีกหน้าจออัปเดตทันที', async () => {
    const list = await (await browser.newContext(desktop)).newPage();
    list.on('dialog', (d) => d.accept());
    await list.goto(URL_);
    await list.fill('#u', 'demo_admin'); await list.fill('#p', PASSWORD); await list.click('#login-form button[type=submit]');
    await list.click('[data-go=adminStudents]');
    await list.waitForSelector('#st-list table');
    await admin.click('#btn-home');
    await admin.click('[data-go=adminStudents]');
    await admin.click('#st-new');
    await admin.fill('#s-code', '00999'); await admin.fill('#s-prefix', 'นางสาว'); await admin.fill('#s-first', 'ทดลอง'); await admin.fill('#s-last', 'ระบบ');
    await admin.fill('#s-class', 'ม.5'); await admin.fill('#s-room', '3'); await admin.fill('#s-roll', '1');
    await admin.click('#sf-form button[type=submit]');
    await admin.waitForSelector('text=รหัสผ่านชั่วคราว');
    await list.waitForSelector('#st-list td:has-text("00999")');
    await admin.click('#modal [data-close]');
  });

  await step('ครูเพิ่มงานใหม่และประกาศ → รายการงานบนมือถือนักเรียนเพิ่มขึ้นทันที', async () => {
    await alpha1.click('#btn-home');
    await course(alpha1, 'ว32201');
    await alpha1.waitForSelector('#alist li');
    await teacher.click('#btn-home');
    await course(teacher, 'ว32201');
    await teacher.click('#ta-new');
    await teacher.fill('#a-code', 'W2');
    await teacher.fill('#a-title', 'ใบงานที่ 2 ลูปและเงื่อนไข');
    await teacher.fill('#a-max', '10');
    await teacher.fill('#a-weight', '10');
    await teacher.selectOption('#a-status', 'published');
    await teacher.click('#af button[type=submit]');
    await teacher.waitForSelector('#tad h1:has-text("W2")');
    await alpha1.waitForSelector('#alist li:has-text("W2")');
  });

  await step('ครูลงทะเบียนนักเรียนจากรายชื่อในระบบ → รายวิชาปรากฏบนมือถือนักเรียนทันที', async () => {
    newbie = await open('00130', phone);
    await newbie.waitForSelector('#courses [data-off]');
    assert.equal(await newbie.locator('#courses [data-off]:has-text("ว32201")').count(), 0);
    await teacher.click('[data-back]');
    await teacher.click('[data-otab=offeringRoster]');
    await teacher.click('#add-toggle');
    await teacher.check('[name=add][value="' + S['00130'] + '"]');
    await teacher.click('#ad-save');
    await newbie.waitForSelector('#courses [data-off]:has-text("ว32201")');
    await teacher.waitForSelector('#enr-box td:has-text("00130")');
  });

  await step('หัวหน้ากลุ่มเลือกเพื่อนเข้ากลุ่ม → เพื่อนเห็นคำเชิญทันที → ตอบรับ → หัวหน้าเห็นสมาชิกใหม่ทันที', async () => {
    await gamma.waitForSelector('h2:has-text("ทีมแกมมา")');
    await gamma.waitForSelector('[name=inv][value="' + S['00130'] + '"]');
    await course(newbie, 'ว32201');
    await newbie.click('[data-tab=studentGroups]');
    await newbie.waitForSelector('text=คุณยังไม่มีกลุ่มในรายวิชานี้');
    await gamma.check('[name=inv][value="' + S['00130'] + '"]');
    await gamma.click('#btn-inv');
    await newbie.waitForSelector('text=คำเชิญถึงคุณ');
    await newbie.click('[data-respond][data-ok="1"]');
    await newbie.waitForSelector('h2:has-text("ทีมแกมมา")');
    await gamma.waitForSelector('.member-list li:has-text("ทดสอบ10")');
  });

  await step('นักเรียนลงทะเบียนเรียนเองด้วยรหัสเข้าร่วมรายวิชา', async () => {
    await teacher.click('[data-otab=offeringRoster]');
    await teacher.click('#jc-on');
    const code = (await teacher.locator('#join-box .big-code').textContent()).trim();
    const s31 = await open('00131', phone);
    await s31.waitForSelector('#courses [data-off]');
    await s31.fill('#join-code', code);
    await s31.click('#join-form button[type=submit]');
    await s31.waitForSelector('#courses [data-off]:has-text("ว32201")');
    await teacher.waitForSelector('#enr-box td:has-text("00131")');
    await s31.context().close();
  });

  await step('แจ้งเตือนในแอป: นักเรียนเห็นรายการ "ประกาศคะแนนแล้ว"', async () => {
    await alpha2.click('#btn-notify');
    await alpha2.waitForSelector('#nlist li:has-text("ประกาศคะแนนแล้ว")');
    await alpha2.waitForSelector('#notify-count', { state: 'hidden' });
  });

  await step('เปิดหน้าอื่น ๆ ของครูและผู้ดูแลได้ครบ (ครูร่วมสอน, นำเข้า, ปีการศึกษา, คำขอสมัคร, ตั้งค่า, รายงานรายห้อง)', async () => {
    await teacher.click('[data-otab=offeringSettings]');
    await teacher.click('#os-addco');
    await teacher.selectOption('#co-t', { label: 'นางสาว วิภา รักเรียน (คณิตศาสตร์)' });
    await teacher.click('#co-ok');
    await teacher.waitForSelector('#os li:has-text("วิภา")');
    await teacher.click('[data-otab=workGroups]');
    await teacher.waitForSelector('#wg-box .grid');
    await admin.click('#btn-home');
    await admin.click('[data-go=adminTeachers]');
    await admin.waitForSelector('#t-list table');
    await admin.click('[data-back]');
    await admin.click('[data-go=adminCourses]');
    await admin.waitForSelector('#terms li');
    await admin.waitForSelector('#courses li');
    await admin.click('[data-back]');
    await admin.click('[data-go=adminImport]');
    await admin.fill('#imp-text', 'รหัสนักเรียน\tคำนำหน้า\tชื่อ\tนามสกุล\tชั้น\tห้อง\tเลขที่\n00201\tนาย\tนำเข้า\tหนึ่ง\tม.4\t1\t1\n00121\tนาย\tกิตติ\tทดสอบ1\tม.5\t1\t1\n');
    await admin.click('#imp-check');
    await admin.waitForSelector('#imp-result >> text=เพิ่มใหม่');
    await admin.click('#imp-commit');
    await admin.waitForSelector('#imp-result >> text=บัญชีใหม่ 1 บัญชี');
    importedPw = (await admin.locator('#imp-result td.temp-pw').nth(1).textContent()).trim();
    await admin.click('[data-back]');
    await admin.click('[data-go=adminRegistrations]');
    await admin.waitForSelector('#reg >> text=ไม่มีคำขอ');
    await admin.click('[data-back]');
    await admin.click('[data-go=adminSettings]');
    await admin.waitForSelector('#set');
    await admin.click('[data-back]');
    await admin.click('[data-go=adminReports]');
    await admin.selectOption('#ar-room', 'ม.5|1');
    await admin.click('#ar-go');
    await admin.waitForSelector('#report h1:has-text("สรุปคะแนนรายห้อง")');
    const t = await admin.locator('#report').textContent();
    assert.ok(t.includes('ว32201') && t.includes('กิตติ'));
    await admin.click('[data-back]');
    await admin.click('[data-back]');
    await admin.click('[data-go=teacherHome]');
    await admin.waitForSelector('[data-off]');
  });

  await step('นักเรียนที่นำเข้าใหม่เข้าระบบด้วยรหัสชั่วคราว → ถูกบังคับตั้งรหัสใหม่ → เข้าหน้าแรกได้', async () => {
    assert.ok(importedPw.length >= 8);
    const ctx = await browser.newContext(phone);
    const pg = await ctx.newPage();
    pg.on('pageerror', (e) => pageErrors.push('00201: ' + e.message));
    await pg.goto(URL_);
    await pg.fill('#u', '00201'); await pg.fill('#p', importedPw); await pg.click('#login-form button[type=submit]');
    await pg.waitForSelector('#pw-form');
    await pg.fill('#o', importedPw); await pg.fill('#n1', 'New#Pass2569x'); await pg.fill('#n2', 'New#Pass2569x');
    await pg.click('#pw-form button[type=submit]');
    await pg.waitForSelector('text=รายวิชาของฉัน');
    await ctx.close();
  });

  await step('หน้าจอมือถือ: รายวิชาและงานของนักเรียน', async () => {
    await alpha1.click('#btn-home');
    await course(alpha1, 'ว32201');
    await alpha1.waitForSelector('#alist li');
    await shot(alpha1, 'mobile-student-course');
  });
  await step('ไม่มีข้อผิดพลาด JavaScript ในทุกหน้าที่เปิด', async () => { assert.deepEqual(pageErrors, []); });
} finally {
  console.log('\nสรุป: ' + results.filter((r) => r[0] === '✓').length + '/' + results.length + ' ขั้นตอนผ่าน');
  await browser.close().catch(() => {});
  await server.close().catch(() => {});
}
process.exit(results.every((r) => r[0] === '✓') ? 0 : 1);
