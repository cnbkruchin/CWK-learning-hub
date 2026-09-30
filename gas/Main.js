/**
 * จุดเข้าใช้งานระดับบนสุด (ฟังก์ชันเหล่านี้เท่านั้นที่ตั้งใจให้เรียกจากภายนอก)
 *
 * - doGet / apiCall / include   : เว็บแอป
 * - setup / setupDemo / seedDemo / installTriggers / backupNow : รันจาก Apps Script editor โดยเจ้าของสคริปต์
 * - runHourlyMaintenance / runDailyMaintenance : งานตั้งเวลา (ติดตั้งด้วย installTriggers)
 *
 * ฟังก์ชันผู้ดูแลตรวจ Guard เพราะเบราว์เซอร์เรียกฟังก์ชันระดับบนสุดได้ทุกตัวผ่าน google.script.run
 */

function doGet() {
  var name = APP.NAME_DEFAULT;
  try {
    var school = Db.all('schools')[0];
    if (school && school.app_name) name = school.app_name;
  } catch (e) { /* ยังไม่ติดตั้ง: แสดงหน้าเว็บพร้อมข้อความแจ้ง */ }
  return HtmlService.createTemplateFromFile('ui/Index').evaluate()
    .setTitle(name)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

function apiCall(request) {
  return Api.handle(request);
}

function include(name) {
  var allowed = ['ui/Styles', 'ui/App'];
  if (allowed.indexOf(name) < 0) throw new Error('not allowed');
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

/** ติดตั้งระบบใช้งานจริง (รันซ้ำได้ เพื่อเพิ่มตาราง/คอลัมน์ใหม่) */
function setup() {
  Guard.requireOwner();
  var p = PropertiesService.getScriptProperties();
  if (!p.getProperty('ENV')) p.setProperty('ENV', 'production');
  var r = Setup.run({});
  console.log('ติดตั้งเสร็จ โฟลเดอร์รากบน Drive: ' + r.rootFolderId);
  r.databases.forEach(function (d) { console.log('ฐานข้อมูล ' + d.db + ': https://docs.google.com/spreadsheets/d/' + d.id); });
  if (r.admin) {
    console.log('บัญชีผู้ดูแล: ' + r.admin.username + '  รหัสผ่านชั่วคราว: ' + r.admin.tempPassword + '  (ต้องเปลี่ยนเมื่อเข้าใช้ครั้งแรก — ห้ามบันทึกรหัสนี้ไว้ที่อื่น)');
  }
  return 'OK';
}

/** ติดตั้งระบบสาธิต (ต้องเป็นโปรเจกต์ Apps Script แยกจากระบบใช้งานจริง) แล้วใส่ข้อมูลสมมติ */
function setupDemo() {
  Guard.requireOwner();
  var p = PropertiesService.getScriptProperties();
  if (p.getProperty('ENV') === 'production') throw new Error('โปรเจกต์นี้ตั้งเป็นระบบใช้งานจริงแล้ว ห้ามใส่ข้อมูลสาธิต');
  p.setProperty('ENV', 'demo');
  Setup.run({ schoolCode: 'DEMO', schoolName: 'โรงเรียนสาธิต (ข้อมูลสมมติ)', isDemo: true, adminUsername: 'demo_admin' });
  return seedDemo();
}

function seedDemo() {
  Guard.requireOwner();
  var out = Seed.run();
  console.log('สร้างข้อมูลสาธิตแล้ว บัญชีทดสอบ (รหัสผ่านสุ่ม ใช้ในระบบสาธิตเท่านั้น):');
  out.accounts.forEach(function (a) { console.log(a.role + '\t' + a.username + '\t' + a.password); });
  return 'OK';
}

function installTriggers() {
  Guard.requireOwner();
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (['runHourlyMaintenance', 'runDailyMaintenance'].indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('runHourlyMaintenance').timeBased().everyHours(1).create();
  ScriptApp.newTrigger('runDailyMaintenance').timeBased().everyDays(1).atHour(2).inTimezone(APP.TIMEZONE).create();
  return 'OK';
}

function runHourlyMaintenance(e) {
  Guard.requireTriggerOrOwner(e);
  return Maintenance.hourly();
}

function runDailyMaintenance(e) {
  Guard.requireTriggerOrOwner(e);
  return Maintenance.daily();
}

function backupNow() {
  Guard.requireOwner();
  return Maintenance.backup();
}
