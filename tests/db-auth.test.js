'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGas, bootDemo, call, ok, login, plain } = require('./harness/load');

function installed() {
  const g = loadGas();
  const r = g.Setup.run({ schoolName: 'โรงเรียนทดสอบ' });
  return { g, admin: r.admin, school: g.Db.all('schools')[0] };
}

test('setup สร้างโฟลเดอร์ Drive ไฟล์ Sheets 6 กลุ่ม และทุกตาราง; รันซ้ำไม่สร้างซ้ำ', () => {
  const { g } = installed();
  const p = g.PropertiesService.getScriptProperties();
  const ids = ['CORE', 'PLAN', 'WORK', 'FILES', 'GRADES', 'SYSTEM'].map((k) => p.getProperty('DB_' + k));
  assert.ok(ids.every(Boolean));
  const tables = g.Schema.names();
  for (const name of tables) {
    const def = g.Schema.get(name);
    const ss = g.SpreadsheetApp.openById(p.getProperty('DB_' + def.db.toUpperCase()));
    const sheet = ss.getSheetByName(name);
    assert.ok(sheet, 'missing sheet ' + name);
    const header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    assert.deepEqual(plain(header), plain(def.fields.map((f) => f.name)));
  }
  const again = g.Setup.run({});
  assert.equal(again.admin, null, 'ไม่สร้างผู้ดูแลซ้ำ');
  assert.equal(g.Db.all('schools').length, 1);
  assert.deepEqual(['CORE', 'PLAN', 'WORK', 'FILES', 'GRADES', 'SYSTEM'].map((k) => p.getProperty('DB_' + k)), ids);
  // ไม่มีการแชร์ไฟล์: fake DriveApp โยน error หากเรียก setSharing
  assert.ok(Object.values(g._drive.folders).length >= 9);
});

test('setup เพิ่มคอลัมน์ที่ขาดต่อท้ายโดยไม่ลบข้อมูลเดิม (migration แบบเพิ่มอย่างเดียว)', () => {
  const { g } = installed();
  const sheet = g.Db.info('students').sheet;
  const lastCol = sheet.getLastColumn();
  // จำลองชีตรุ่นเก่าที่ยังไม่มีคอลัมน์ status
  sheet.getRange(1, lastCol, 1, 1).clearContent();
  g.Db.reset();
  assert.throws(() => g.Db.all('students'), (e) => e.code === 'DB_SCHEMA_MISMATCH');
  g.Setup.run({});
  g.Db.reset();
  assert.equal(g.Db.all('students').length, 0);
});

test('A01 รหัส 00123 ยังเป็นข้อความ; ข้อความขึ้นต้นด้วย = + - @ ไม่ถูกตีความเป็นสูตร', () => {
  const { g, school } = installed();
  g.Db.tx('t', (tx) => {
    tx.insert('students', { school_id: school.id, student_code: '00123', first_name: '=HYPERLINK("http://x","y")', last_name: '+66-1', class_level: '@m', room: '-1', status: 'active' });
  });
  g.Db.reset();
  const s = g.Db.one('students', { student_code: '00123' });
  assert.equal(s.student_code, '00123');
  assert.equal(s.first_name, '=HYPERLINK("http://x","y")');
  assert.equal(s.last_name, '+66-1');
  assert.equal(s.room, '-1');
  assert.deepEqual(g._stats.formulaWrites, []);
  assert.equal(g._stats.coercions, 0, 'ไม่มีค่าใดถูก Sheets แปลงชนิดอัตโนมัติ');
});

test('A01 ข้อกำหนดไม่ซ้ำ: รหัสนักเรียนซ้ำในโรงเรียนเดียวกันถูกปฏิเสธ', () => {
  const { g, school } = installed();
  const add = () => g.Db.tx('t', (tx) => tx.insert('students', { school_id: school.id, student_code: '00123', first_name: 'ก' }));
  add();
  assert.throws(add, (e) => e.code === 'DUPLICATE');
  assert.equal(g.Db.find('students', { student_code: '00123' }).length, 1);
});

test('A22 แก้ข้อมูลพร้อมกัน: expectedVersion ไม่ตรงได้ CONFLICT ไม่เขียนทับเงียบ ๆ', () => {
  const { g, school } = installed();
  const s = g.Db.tx('t', (tx) => tx.insert('students', { school_id: school.id, student_code: '1', first_name: 'ก' }));
  g.Db.tx('a', (tx) => tx.update('students', s.id, { first_name: 'ข' }, { expectedVersion: 1 }));
  assert.throws(() => g.Db.tx('b', (tx) => tx.update('students', s.id, { first_name: 'ค' }, { expectedVersion: 1 })), (e) => e.code === 'CONFLICT');
  g.Db.reset();
  const cur = g.Db.get('students', s.id);
  assert.equal(cur.first_name, 'ข');
  assert.equal(cur.version, 2);
});

test('A16 เขียนล้มเหลวกลางธุรกรรม: ย้อนกลับครบ ไม่มีแถวค้างบางส่วน', () => {
  const { g, school } = installed();
  const s = g.Db.tx('t', (tx) => tx.insert('students', { school_id: school.id, student_code: '1', first_name: 'เดิม' }));
  const before = g.Db.info('teachers').sheet.getLastRow();
  let n = 0;
  g.Db._testHooks.beforeWrite = (table) => { if (++n === 2) throw new Error('simulated failure on ' + table); };
  assert.throws(() => g.Db.tx('multi', (tx) => {
    tx.update('students', s.id, { first_name: 'ใหม่' });
    tx.insert('teachers', { school_id: school.id, teacher_code: 'T9', first_name: 'ครู' });
  }), /simulated/);
  g.Db._testHooks.beforeWrite = null;
  g.Db.reset();
  assert.equal(g.Db.get('students', s.id).first_name, 'เดิม');
  assert.equal(g.Db.info('teachers').sheet.getLastRow(), before);
  assert.equal(g.PropertiesService.getScriptProperties().getProperty('TX_PENDING'), null);
});

test('A16/A24 สคริปต์ถูกตัดกลางคัน: ธุรกรรมถัดไปกู้คืนจาก journal ก่อนทำงาน', () => {
  const { g, school } = installed();
  const s = g.Db.tx('t', (tx) => tx.insert('students', { school_id: school.id, student_code: '1', first_name: 'เดิม' }));
  // จำลอง: เขียน journal + แถวแรกแล้ว execution ตาย (ไม่ได้ rollback และไม่ได้ mark committed)
  const realRelease = g.LockService.getScriptLock().releaseLock;
  let n = 0;
  g.Db._testHooks.beforeWrite = () => { if (++n === 2) { const e = new Error('Exceeded maximum execution time'); e.fatal = true; throw e; } };
  const origJournalMark = g.Db.info('tx_journal').sheet;
  // ปิดการ rollback ทันทีโดยทำให้ setValues ของ rollback ล้มเหลวด้วย
  const studentsSheet = g.Db.info('students').sheet;
  const origGetRange = studentsSheet.getRange.bind(studentsSheet);
  let rollbackAttempt = false;
  studentsSheet.getRange = (...a) => {
    const r = origGetRange(...a);
    if (n >= 2) { rollbackAttempt = true; r.setValues = () => { throw new Error('dead'); }; }
    return r;
  };
  assert.throws(() => g.Db.tx('multi', (tx) => {
    tx.update('students', s.id, { first_name: 'ครึ่งทาง' });
    tx.insert('teachers', { school_id: school.id, teacher_code: 'T9', first_name: 'ครู' });
  }));
  studentsSheet.getRange = origGetRange;
  g.Db._testHooks.beforeWrite = null;
  assert.ok(rollbackAttempt);
  assert.ok(g.PropertiesService.getScriptProperties().getProperty('TX_PENDING'), 'journal ค้างรอการกู้คืน');
  g.Db.reset();
  assert.equal(g.Db.get('students', s.id).first_name, 'ครึ่งทาง', 'ข้อมูลเสียครึ่งทางก่อนกู้คืน');
  g.Db.tx('next', () => null);
  g.Db.reset();
  assert.equal(g.Db.get('students', s.id).first_name, 'เดิม');
  assert.equal(g.PropertiesService.getScriptProperties().getProperty('TX_PENDING'), null);
  void realRelease; void origJournalMark;
});

test('ล็อกไม่ว่าง: ได้ BUSY และไม่มีข้อมูลเปลี่ยน', () => {
  const { g, school } = installed();
  g.LockService._state.busy = true;
  assert.throws(() => g.Db.tx('t', (tx) => tx.insert('students', { school_id: school.id, student_code: '1', first_name: 'ก' })), (e) => e.code === 'BUSY');
  g.LockService._state.busy = false;
  assert.equal(g.Db.all('students').length, 0);
});

test('เข้าสู่ระบบ: ผิดรหัสได้ข้อความกลาง ๆ, ผิดครบ 5 ครั้งล็อกชั่วคราว', () => {
  const { g, accounts } = bootDemo();
  const bad = call(g, 'auth.login', { username: '00121', password: 'wrong' });
  assert.equal(bad.error.code, 'AUTH_INVALID');
  const nouser = call(g, 'auth.login', { username: 'nobody', password: 'wrong' });
  assert.equal(nouser.error.code, 'AUTH_INVALID');
  for (let i = 0; i < 5; i++) call(g, 'auth.login', { username: '00122', password: 'x' });
  const locked = call(g, 'auth.login', { username: '00122', password: accounts['00122'] });
  assert.equal(locked.error.code, 'AUTH_LOCKED');
  assert.ok(login(g, accounts, '00121'));
});

test('session: โทเคนผิด/หมดอายุ/ปิดบัญชี/รีเซ็ตรหัส ถูกปฏิเสธ', () => {
  const { g, accounts } = bootDemo();
  const tok = login(g, accounts, '00121');
  assert.equal(call(g, 'auth.me', {}, 'forged').error.code, 'SESSION_EXPIRED');
  assert.equal(call(g, 'auth.me', {}, undefined).error.code, 'AUTH_REQUIRED');
  // หมดเวลาเมื่อไม่ใช้งาน
  const key = g.Auth.tokenKey(tok);
  const cache = g.CacheService.getScriptCache();
  const s = JSON.parse(cache.get(key));
  s.last -= 3 * 3600 * 1000;
  cache.put(key, JSON.stringify(s));
  assert.equal(call(g, 'auth.me', {}, tok).error.code, 'SESSION_EXPIRED');
  // ผู้ดูแลรีเซ็ตรหัส → session เดิมใช้ไม่ได้, รหัสชั่วคราวต้องเปลี่ยนก่อนใช้งาน
  const tok2 = login(g, accounts, '00121');
  const admin = ok(g, 'auth.login', { username: 'demo_admin', password: accounts.demo_admin }).token;
  ok(g, 'auth.changePassword', { oldPassword: accounts.demo_admin, newPassword: 'NewAdminPass#1' }, admin);
  const admin2 = ok(g, 'auth.login', { username: 'demo_admin', password: 'NewAdminPass#1' }).token;
  const uid = ok(g, 'auth.me', {}, tok2).userId;
  const temp = ok(g, 'admin.resetPassword', { userId: uid }, admin2).tempPassword;
  assert.equal(call(g, 'auth.me', {}, tok2).error.code, 'SESSION_EXPIRED');
  const tok3 = ok(g, 'auth.login', { username: '00121', password: temp }).token;
  assert.equal(call(g, 'student.courses', {}, tok3).error.code, 'PASSWORD_CHANGE_REQUIRED');
  assert.equal(call(g, 'auth.changePassword', { oldPassword: temp, newPassword: 'short' }, tok3).error.code, 'VALIDATION');
  const tok4 = ok(g, 'auth.changePassword', { oldPassword: temp, newPassword: 'MyNewPass#2026' }, tok3).token;
  assert.ok(ok(g, 'student.courses', {}, tok4).length > 0);
  // ปิดบัญชี
  ok(g, 'admin.setUserStatus', { userId: uid, status: 'disabled', reason: 'ทดสอบ' }, admin2);
  assert.equal(call(g, 'student.courses', {}, tok4).error.code, 'AUTH_DISABLED');
  assert.equal(call(g, 'auth.login', { username: '00121', password: 'MyNewPass#2026' }).error.code, 'AUTH_DISABLED');
});

test('ฟังก์ชันผู้ดูแลระดับบนสุดเรียกจากเบราว์เซอร์ไม่ได้ (ผู้ใช้อื่น/ไม่ระบุตัวตน/ตั๋ว trigger ปลอม)', () => {
  const g = loadGas({ activeUser: '' });
  assert.throws(() => g.setup(), /เจ้าของสคริปต์/);
  assert.throws(() => g.seedDemo(), /เจ้าของสคริปต์/);
  assert.throws(() => g.runDailyMaintenance({ triggerUid: '12345' }), /เจ้าของสคริปต์/);
  g.Session._active = 'student@school.ac.th';
  assert.throws(() => g.installTriggers(), /เจ้าของสคริปต์/);
  assert.throws(() => g.include('Config'), /not allowed/);
});

test('API: คำสั่งไม่รู้จัก และข้อผิดพลาดภายในไม่เปิดเผย stack trace', () => {
  const { g, accounts } = bootDemo();
  assert.equal(call(g, 'constructor', {}).error.code, 'NOT_FOUND');
  assert.equal(call(g, '__proto__', {}).error.code, 'NOT_FOUND');
  const tok = login(g, accounts, '00121');
  g.Submission.myCourses = () => { throw new TypeError('secret internal detail at line 42'); };
  const r = call(g, 'student.courses', {}, tok);
  assert.equal(r.error.code, 'INTERNAL');
  assert.ok(!/secret|line 42/.test(r.error.message));
  assert.match(r.error.message, /รหัสอ้างอิง/);
});

test('บันทึกตรวจสอบไม่มีรหัสผ่าน/โทเคน', () => {
  const { g, accounts } = bootDemo();
  login(g, accounts, '00121');
  const detail = plain(g.Audit.sanitize({ password: 'x', token: 'y', nested: { resumableUrl: 'z', ok: 1 } }));
  assert.deepEqual(detail, { password: '[redacted]', token: '[redacted]', nested: { resumableUrl: '[redacted]', ok: 1 } });
  const logs = g.Db.all('audit_log');
  assert.ok(logs.some((l) => l.action === 'login'));
  const dump = JSON.stringify(logs);
  assert.ok(!dump.includes(accounts['00121']));
  // แคช session/บริบทผู้ใช้ไม่มี hash รหัสผ่านหรือโทเคนจริง
  ok(g, 'auth.me', {}, login(g, accounts, '00122'));
  const cacheDump = JSON.stringify(Array.from(g.CacheService.getScriptCache()._map.entries()));
  assert.ok(!cacheDump.includes('pbkdf2_sha256'));
});
