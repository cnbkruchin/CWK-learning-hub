/**
 * ติดตั้ง/ปรับโครงสร้างระบบ (รันซ้ำได้อย่างปลอดภัย)
 *
 * สิ่งที่ทำ
 * 1. สร้างโฟลเดอร์รากและโฟลเดอร์ย่อยบน Drive (ส่วนตัว ไม่แชร์)
 * 2. สร้าง secret (PEPPER) ใน Script Properties
 * 3. สร้างไฟล์ Google Sheets ตามกลุ่มฐานข้อมูล และชีตทุกตารางพร้อมหัวตาราง
 *    ถ้ามีอยู่แล้วจะเพิ่มเฉพาะชีต/คอลัมน์ที่ขาด (ไม่ลบ ไม่สลับคอลัมน์)
 * 4. สร้างโรงเรียนเริ่มต้นและบัญชีผู้ดูแลพร้อมรหัสผ่านชั่วคราว (ครั้งแรกเท่านั้น)
 */
var Setup = {
  run: function (opts) {
    opts = opts || {};
    var p = PropertiesService.getScriptProperties();
    Setup.ensureFolders(p);
    Setup.ensureSecrets(p);
    Setup.ensureDatabases(p);
    Db.reset();
    var admin = Setup.ensureSchoolAndAdmin(opts);
    p.setProperty('SCHEMA_VERSION', String(APP.SCHEMA_VERSION));
    return {
      rootFolderId: p.getProperty('FOLDER_ROOT'),
      databases: Object.keys(APP.DB_GROUPS).map(function (db) { return { db: db, id: p.getProperty('DB_' + db.toUpperCase()) }; }),
      admin: admin
    };
  },

  ensureFolders: function (p) {
    var root = null;
    var rootId = p.getProperty('FOLDER_ROOT');
    if (rootId) {
      try { root = DriveApp.getFolderById(rootId); } catch (e) { root = null; }
    }
    if (!root) {
      root = DriveApp.createFolder(APP.ROOT_FOLDER_NAME);
      p.setProperty('FOLDER_ROOT', root.getId());
    }
    Object.keys(APP.DRIVE_FOLDERS).forEach(function (key) {
      var prop = 'FOLDER_' + key;
      var id = p.getProperty(prop);
      if (id) {
        try { DriveApp.getFolderById(id); return; } catch (e) { /* สร้างใหม่ */ }
      }
      var name = APP.DRIVE_FOLDERS[key];
      var it = root.getFoldersByName(name);
      var folder = it.hasNext() ? it.next() : root.createFolder(name);
      p.setProperty(prop, folder.getId());
    });
  },

  ensureSecrets: function (p) {
    if (!p.getProperty('PEPPER')) p.setProperty('PEPPER', Util.b64(Rand.bytes(32)));
  },

  ensureDatabases: function (p) {
    var dbFolder = DriveApp.getFolderById(p.getProperty('FOLDER_DB'));
    Object.keys(APP.DB_GROUPS).forEach(function (db) {
      var prop = 'DB_' + db.toUpperCase();
      var id = p.getProperty(prop);
      var ss;
      if (id) {
        ss = SpreadsheetApp.openById(id);
      } else {
        ss = SpreadsheetApp.create(APP.DB_GROUPS[db]);
        DriveApp.getFileById(ss.getId()).moveTo(dbFolder);
        p.setProperty(prop, ss.getId());
      }
      Schema.byDb(db).forEach(function (name) { Setup.ensureTable(ss, name); });
      // ลบชีตเริ่มต้นที่ว่าง
      ss.getSheets().forEach(function (s) {
        if (!Schema.tables[s.getName()] && s.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(s);
      });
    });
  },

  ensureTable: function (ss, name) {
    var def = Schema.get(name);
    var names = def.fields.map(function (f) { return f.name; });
    var sheet = ss.getSheetByName(name);
    if (!sheet) sheet = ss.insertSheet(name);
    var lastCol = sheet.getLastColumn();
    var existing = lastCol ? sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String) : [];
    var missing = names.filter(function (n) { return existing.indexOf(n) < 0; });
    var need = existing.length + missing.length;
    if (sheet.getMaxColumns() < need) sheet.insertColumnsAfter(sheet.getMaxColumns(), need - sheet.getMaxColumns());
    if (missing.length) {
      sheet.getRange(1, existing.length + 1, 1, missing.length).setValues([missing.map(Db.protect)]);
    }
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, need).setFontWeight('bold').setBackground('#e8eef7');
    try {
      sheet.protect().setWarningOnly(true).setDescription('แก้ข้อมูลผ่านระบบเท่านั้น การแก้ตรงในชีตข้ามการตรวจสิทธิ์และประวัติ');
    } catch (e) { /* ไม่บังคับ */ }
    return { table: name, added: missing };
  },

  ensureSchoolAndAdmin: function (opts) {
    var schools = Db.all('schools');
    if (schools.length) return null;
    var tempPassword = Setup.tempPassword();
    var username = (opts.adminUsername || 'admin').toLowerCase();
    Db.tx('setup.school', function (tx) {
      var school = tx.insert('schools', {
        code: opts.schoolCode || 'CWK',
        name_th: opts.schoolName || 'โรงเรียนจุนวิทยาคม',
        app_name: APP.NAME_DEFAULT,
        timezone: APP.TIMEZONE,
        is_demo: !!opts.isDemo,
        status: 'active'
      });
      var user = tx.insert('users', {
        school_id: school.id,
        username: username,
        display_name: 'ผู้ดูแลระบบ',
        password_hash: Auth.hashPassword(tempPassword),
        must_change_password: true,
        status: 'active',
        session_epoch: 0
      });
      tx.insert('role_assignments', { school_id: school.id, user_id: user.id, role: 'admin' });
      // ผู้ดูแลคนแรกได้สิทธิ์ให้/แก้คะแนน (grade_admin) ด้วย เพื่อให้ผู้ดูแลให้คะแนนแทนครูได้ — เพิกถอนได้ที่หน้าจัดการบัญชี และทุกการแก้มีบันทึก
      tx.insert('role_assignments', { school_id: school.id, user_id: user.id, role: 'grade_admin', reason: 'ผู้ดูแลคนแรก' });
    });
    return { username: username, tempPassword: tempPassword };
  },

  /** รหัสผ่านชั่วคราว 12 ตัว (ไม่มีอักขระที่สับสน) */
  tempPassword: function () {
    return Util.shortCode(4) + '-' + Util.shortCode(4) + '-' + Util.shortCode(4);
  },

  status: function () {
    var p = PropertiesService.getScriptProperties();
    return {
      installed: !!p.getProperty('DB_CORE'),
      schemaVersion: Number(p.getProperty('SCHEMA_VERSION') || 0),
      codeSchemaVersion: APP.SCHEMA_VERSION
    };
  }
};
