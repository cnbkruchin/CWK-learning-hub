'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('crypto');
const { loadGas, plain } = require('./harness/load');
const S = require('./harness/samples');

const g = loadGas();
const C = g.Crypto;
const u8 = (buf) => Array.from(buf);

test('SHA-256 ตรงกับ Node.js ทุกความยาวขอบบล็อกและอักษรไทย', () => {
  for (const s of ['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(63), 'a'.repeat(64), 'a'.repeat(1000), 'ภาษาไทย 😀']) {
    assert.equal(C.hex(C.sha256(C.utf8(s))), nodeCrypto.createHash('sha256').update(s, 'utf8').digest('hex'));
  }
  const h = new C.Hasher();
  h.update(C.utf8('hello ')); h.update(C.utf8('world'));
  assert.equal(C.hex(h.digest()), nodeCrypto.createHash('sha256').update('hello world').digest('hex'));
});

test('HMAC-SHA256 และ PBKDF2-HMAC-SHA256 ตรงกับ Node.js', () => {
  assert.equal(C.hex(C.hmac(C.utf8('key'), C.utf8('msg'))), nodeCrypto.createHmac('sha256', 'key').update('msg').digest('hex'));
  assert.equal(C.hex(C.hmac(C.utf8('k'.repeat(100)), C.utf8('m'))), nodeCrypto.createHmac('sha256', 'k'.repeat(100)).update('m').digest('hex'));
  const dk = C.hex(C.pbkdf2(C.utf8('รหัสผ่าน123'), C.utf8('saltsalt'), 60000, 32));
  assert.equal(dk, nodeCrypto.pbkdf2Sync('รหัสผ่าน123', 'saltsalt', 60000, 32, 'sha256').toString('hex'));
  assert.equal(C.hex(C.pbkdf2(C.utf8('p'.repeat(80)), C.utf8('s'), 3, 40)), nodeCrypto.pbkdf2Sync('p'.repeat(80), 's', 3, 40, 'sha256').toString('hex'));
});

test('รหัสผ่าน: hash มี salt ต่างกันทุกครั้ง ตรวจถูก/ผิดได้ และไม่มีรหัสจริงในค่าที่เก็บ', () => {
  const env = loadGas();
  env.Setup.ensureSecrets(env.PropertiesService.getScriptProperties());
  const a = env.Auth.hashPassword('CorrectHorse9');
  const b = env.Auth.hashPassword('CorrectHorse9');
  assert.notEqual(a, b);
  assert.ok(!a.includes('CorrectHorse9'));
  assert.ok(env.Auth.verifyPassword('CorrectHorse9', a));
  assert.ok(!env.Auth.verifyPassword('CorrectHorse8', a));
  // pepper ต่างกัน → ตรวจไม่ผ่าน (ตารางผู้ใช้หลุดอย่างเดียวเดารหัสไม่ได้)
  env.PropertiesService.getScriptProperties().setProperty('PEPPER', 'other');
  env.Props.reset(); // คำขอใหม่อ่านค่า Script Properties ใหม่
  assert.ok(!env.Auth.verifyPassword('CorrectHorse9', a));
});

const limits = { maxBytes: 25 * 1024 * 1024, zipMaxEntries: 2000, zipMaxUncompressedBytes: 200 * 1024 * 1024 };
function check(ext, buf, extra = {}) {
  const head = u8(buf.subarray(0, 4096));
  const tailOffset = Math.max(0, buf.length - 66581);
  return plain(g.FileCheck.check(Object.assign({ ext, size: buf.length, head, tail: u8(buf.subarray(tailOffset)), tailOffset, limits }, extra)));
}

test('ตรวจชนิดจริง: PDF PNG JPG DOCX XLSX TXT ผ่าน', () => {
  assert.equal(check('pdf', S.pdf()).ok, true);
  assert.equal(check('png', S.png()).ok, true);
  assert.equal(check('jpg', S.jpg()).ok, true);
  assert.equal(check('docx', S.docx()).ok, true);
  assert.equal(check('xlsx', S.xlsx()).ok, true);
  assert.equal(check('txt', S.txt()).ok, true);
});

test('A12 ปลอมชนิด: PDF ตั้งชื่อ .docx, DOCX ตั้งชื่อ .xlsx, PNG ตั้งชื่อ .pdf ถูกปฏิเสธ', () => {
  assert.equal(check('docx', S.pdf()).code, 'FILE_SIGNATURE_MISMATCH');
  assert.equal(check('xlsx', S.docx()).code, 'FILE_REJECTED');
  assert.equal(check('pdf', S.png()).code, 'FILE_SIGNATURE_MISMATCH');
});

test('A12 ไฟล์ปฏิบัติการที่เปลี่ยนนามสกุลถูกปฏิเสธ', () => {
  const r = check('pdf', S.exe());
  assert.equal(r.ok, false);
  assert.equal(r.code, 'FILE_REJECTED');
  assert.match(r.reason, /โปรแกรม/);
});

test('เอกสารที่มีมาโคร ZIP ถูกเข้ารหัส และ zip bomb ถูกปฏิเสธ (อ่านแค่ central directory ไม่แตกไฟล์)', () => {
  assert.match(check('docx', S.docx([{ name: 'word/vbaProject.bin', data: 'x' }])).reason, /มาโคร/);
  const enc = S.makeZip([{ name: '[Content_Types].xml', data: 'x' }, { name: 'word/document.xml', data: 'x' }], { encrypted: true });
  assert.match(check('docx', enc).reason, /เข้ารหัส/);
  const bomb = S.makeZip([{ name: '[Content_Types].xml', data: 'x' }, { name: 'word/document.xml', data: Buffer.alloc(1000), fakeSize: 50 * 1024 * 1024 }]);
  assert.match(check('docx', bomb).reason, /zip bomb/);
  const traversal = S.makeZip([{ name: '../evil.txt', data: 'x' }]);
  assert.match(check('zip', traversal).reason, /ไม่ปลอดภัย/);
});

test('ไฟล์ว่างและนามสกุลที่ไม่รองรับถูกปฏิเสธ', () => {
  assert.equal(check('pdf', Buffer.alloc(0)).code, 'FILE_REJECTED');
  assert.equal(check('exe', S.exe()).code, 'FILE_TYPE_NOT_ALLOWED');
  assert.equal(check('svg', Buffer.from('<svg/>')).code, 'FILE_TYPE_NOT_ALLOWED');
});

test('กรองชื่อไฟล์: ตัดเส้นทาง อักขระควบคุม อักขระกลับทิศ และจำกัดความยาว', () => {
  const s = (n) => plain(g.FileCheck.sanitizeName(n));
  assert.deepEqual(s('../../etc/passwd.PDF'), { name: 'passwd.pdf', ext: 'pdf' });
  assert.deepEqual(s('C:\\Users\\a\\งาน<1>.docx'), { name: 'งาน_1_.docx', ext: 'docx' });
  assert.equal(s('invoice\u202Efdp.exe').name, 'invoicefdp.exe');
  assert.equal(s('a'.repeat(300) + '.pdf').name.length, 154);
  assert.equal(s('   ').name, 'file');
});
