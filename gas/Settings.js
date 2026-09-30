/**
 * ค่าตั้งระดับโรงเรียน = ค่าเริ่มต้นใน APP.DEFAULT_SETTINGS ทับด้วยแถวในตาราง settings
 */
var Settings = {
  get: function (schoolId) {
    var out = JSON.parse(JSON.stringify(APP.DEFAULT_SETTINGS));
    if (!schoolId) return out;
    Db.find('settings', { school_id: schoolId }).forEach(function (r) {
      if (r.value_json !== null && r.value_json !== undefined) out[r.key] = r.value_json;
    });
    return out;
  },

  /** ค่าที่ผู้ดูแลแก้ได้ พร้อมเงื่อนไขตรวจ */
  EDITABLE: {
    app_name: function (v) { return Util.requireStr(v, 'ชื่อระบบ', 100); },
    max_file_mb: function (v) { return Settings._int(v, 1, 1024, 'ขนาดไฟล์สูงสุด (MB)'); },
    max_files_per_submission: function (v) { return Settings._int(v, 1, 50, 'จำนวนไฟล์ต่อการส่ง'); },
    allowed_file_types: function (v) {
      var list = Util.csvList(v);
      list.forEach(function (ext) {
        if (!FileCheck.TYPES[ext]) Errors.raise('VALIDATION', 'ระบบยังไม่รองรับการตรวจชนิดไฟล์ .' + ext);
      });
      if (!list.length) Errors.raise('VALIDATION', 'ต้องอนุญาตอย่างน้อยหนึ่งชนิดไฟล์');
      return list;
    },
    staging_retention_hours: function (v) { return Settings._int(v, 1, 24 * 30, 'อายุไฟล์ที่ยังไม่ส่ง (ชั่วโมง)'); },
    quarantine_retention_days: function (v) { return Settings._int(v, 1, 365, 'อายุไฟล์ที่ถูกกัก (วัน)'); },
    quota_total_mb: function (v) { return Settings._int(v, 0, 10 * 1024 * 1024, 'โควตารวม (MB)'); },
    quota_warn_percent: function (v) { return Settings._int(v, 50, 99, 'แจ้งเตือนเมื่อใช้พื้นที่ (%)'); },
    session_idle_minutes: function (v) { return Settings._int(v, 5, 24 * 60, 'หมดเวลาเมื่อไม่ใช้งาน (นาที)'); },
    session_absolute_hours: function (v) { return Settings._int(v, 1, 72, 'อายุ session สูงสุด (ชั่วโมง)'); },
    backup_retention_days: function (v) { return Settings._int(v, 1, 365, 'อายุไฟล์สำรอง (วัน)'); }
  },

  _int: function (v, min, max, label) {
    var n = Number(v);
    if (!isFinite(n) || Math.floor(n) !== n || n < min || n > max) {
      Errors.raise('VALIDATION', label + ' ต้องเป็นจำนวนเต็ม ' + min + '–' + max);
    }
    return n;
  },

  update: function (ctx, changes) {
    Authz.requireAdmin(ctx);
    var clean = {};
    Object.keys(changes || {}).forEach(function (k) {
      if (!Settings.EDITABLE[k]) Errors.raise('VALIDATION', 'แก้ค่า ' + k + ' ไม่ได้');
      clean[k] = Settings.EDITABLE[k](changes[k]);
    });
    return Db.tx('settings.update', function (tx) {
      Object.keys(clean).forEach(function (k) {
        var row = tx.one('settings', { school_id: ctx.schoolId, key: k });
        if (row) tx.update('settings', row.id, { value_json: clean[k] });
        else tx.insert('settings', { school_id: ctx.schoolId, key: k, value_json: clean[k] });
      });
      tx.afterCommit(function () { Audit.log(ctx, 'settings.update', 'settings', ctx.schoolId, clean); });
      return Settings.get(ctx.schoolId);
    }, { actorId: ctx.user.id });
  }
};

/**
 * ป้องกันฟังก์ชันผู้ดูแลที่ต้องอยู่ระดับบนสุด (setup, seed, งานตั้งเวลา)
 * เพราะเบราว์เซอร์เรียกฟังก์ชันระดับบนสุดได้ผ่าน google.script.run
 */
var Guard = {
  requireOwner: function () {
    var active = '', effective = '';
    try {
      active = Session.getActiveUser().getEmail() || '';
      effective = Session.getEffectiveUser().getEmail() || '';
    } catch (e) { /* ignore */ }
    if (!active || !effective || active.toLowerCase() !== effective.toLowerCase()) {
      throw new Error('ฟังก์ชันนี้รันได้จาก Apps Script editor โดยเจ้าของสคริปต์เท่านั้น');
    }
  },
  requireTriggerOrOwner: function (e) {
    if (e && e.triggerUid) {
      var ok = ScriptApp.getProjectTriggers().some(function (t) { return String(t.getUniqueId()) === String(e.triggerUid); });
      if (ok) return;
    }
    Guard.requireOwner();
  }
};
