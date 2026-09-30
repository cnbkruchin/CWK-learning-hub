/**
 * ยูทิลิตี้ทั่วไป: เวลา รหัส ไบต์ และการตรวจข้อมูลพื้นฐาน
 *
 * เวลาเก็บเป็นข้อความ ISO 8601 แบบ UTC (เช่น 2026-09-30T02:15:00.000Z) เสมอ
 * การแสดงผลแปลงเป็น Asia/Bangkok และปี พ.ศ. ที่หน้าจอ/รายงาน
 */
var Util = {
  /** เวลาปัจจุบันของเซิร์ฟเวอร์ (ห้ามใช้เวลาจากเครื่องผู้ใช้) */
  now: function () {
    return new Date();
  },

  nowIso: function () {
    return Util.now().toISOString();
  },

  toIso: function (d) {
    if (d === null || d === undefined || d === '') return '';
    var date = d instanceof Date ? d : new Date(d);
    if (isNaN(date.getTime())) Errors.raise('VALIDATION', 'รูปแบบวันเวลาไม่ถูกต้อง: ' + d);
    return date.toISOString();
  },

  ms: function (iso) {
    return iso ? Date.parse(iso) : NaN;
  },

  addMinutes: function (date, minutes) {
    return new Date(date.getTime() + minutes * 60000);
  },

  /** แสดงวันเวลาแบบไทย ปี พ.ศ. เขตเวลา Asia/Bangkok เช่น 30/09/2569 09:15 */
  formatThai: function (iso) {
    if (!iso) return '';
    var d = new Date(iso);
    var s = Utilities.formatDate(d, APP.TIMEZONE, 'dd/MM/yyyy HH:mm:ss');
    var parts = s.split(' ');
    var dmy = parts[0].split('/');
    return dmy[0] + '/' + dmy[1] + '/' + (Number(dmy[2]) + 543) + ' ' + parts[1];
  },

  dateKey: function (date) {
    return Utilities.formatDate(date || Util.now(), APP.TIMEZONE, 'yyyy-MM-dd');
  },

  uuid: function () {
    return Utilities.getUuid();
  },

  /** รหัสสั้นอ่านง่าย (ไม่มี 0/O/1/I) สำหรับใบยืนยันการส่งงาน */
  shortCode: function (len) {
    var alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    var bytes = Rand.bytes(len);
    var out = '';
    for (var i = 0; i < len; i++) out += alphabet.charAt(bytes[i] % alphabet.length);
    return out;
  },

  // ---------- ไบต์ ----------
  /** แปลงเป็นไบต์ไม่มีเครื่องหมาย 0..255 (Apps Script คืนไบต์แบบ Java คือ -128..127) */
  toUnsigned: function (bytes) {
    var out = new Array(bytes.length);
    for (var i = 0; i < bytes.length; i++) out[i] = bytes[i] & 0xff;
    return out;
  },

  /** แปลงเป็นไบต์แบบมีเครื่องหมายสำหรับส่งเข้า Utilities/Blob */
  toSigned: function (bytes) {
    var out = new Array(bytes.length);
    for (var i = 0; i < bytes.length; i++) {
      var b = bytes[i] & 0xff;
      out[i] = b > 127 ? b - 256 : b;
    }
    return out;
  },

  bytesToHex: function (bytes) {
    var hex = '';
    for (var i = 0; i < bytes.length; i++) {
      var b = bytes[i] & 0xff;
      hex += (b < 16 ? '0' : '') + b.toString(16);
    }
    return hex;
  },

  utf8Bytes: function (str) {
    return Util.toUnsigned(Utilities.newBlob(str).getBytes());
  },

  b64: function (bytes) {
    return Utilities.base64Encode(Util.toSigned(bytes));
  },

  b64url: function (bytes) {
    return Utilities.base64EncodeWebSafe(Util.toSigned(bytes)).replace(/=+$/, '');
  },

  // ---------- การตรวจข้อมูล ----------
  str: function (v, maxLen, fieldName) {
    var s = v === null || v === undefined ? '' : String(v);
    s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
    if (maxLen && s.length > maxLen) {
      Errors.raise('VALIDATION', (fieldName || 'ข้อความ') + ' ยาวเกิน ' + maxLen + ' ตัวอักษร');
    }
    return s;
  },

  requireStr: function (v, fieldName, maxLen) {
    var s = Util.str(v, maxLen || 500, fieldName);
    if (!s) Errors.raise('VALIDATION', 'กรุณาระบุ ' + fieldName, { field: fieldName });
    return s;
  },

  requireId: function (v, fieldName) {
    var s = Util.str(v, 64, fieldName);
    if (!/^[A-Za-z0-9_-]{6,64}$/.test(s)) Errors.raise('VALIDATION', 'รหัสอ้างอิงไม่ถูกต้อง: ' + (fieldName || ''));
    return s;
  },

  isHttpUrl: function (s) {
    return /^https?:\/\/[^\s<>"']+$/i.test(s) && s.length <= 2000;
  },

  pick: function (obj, keys) {
    var out = {};
    keys.forEach(function (k) { if (obj && obj[k] !== undefined) out[k] = obj[k]; });
    return out;
  },

  indexBy: function (rows, key) {
    var m = {};
    rows.forEach(function (r) { m[r[key]] = r; });
    return m;
  },

  groupBy: function (rows, key) {
    var m = {};
    rows.forEach(function (r) { (m[r[key]] = m[r[key]] || []).push(r); });
    return m;
  },

  csvList: function (s) {
    if (Array.isArray(s)) return s.map(function (x) { return String(x).trim().toLowerCase(); }).filter(String);
    return String(s || '').split(/[,\s;]+/).map(function (x) { return x.trim().toLowerCase(); }).filter(String);
  }
};

/**
 * ตัวสร้างไบต์สุ่ม
 * Apps Script ไม่มี crypto.getRandomValues จึงใช้ Utilities.getUuid() (Java UUID.randomUUID ซึ่งใช้ SecureRandom)
 * หลายค่ามารวมกันผ่าน SHA-256 เพื่อให้ได้ไบต์ที่กระจายสม่ำเสมอ
 */
var Rand = {
  _counter: 0,
  bytes: function (n) {
    var out = [];
    while (out.length < n) {
      Rand._counter++;
      var seed = Utilities.getUuid() + Utilities.getUuid() + ':' + Date.now() + ':' + Rand._counter;
      var digest = Crypto.sha256(Crypto.utf8(seed));
      for (var i = 0; i < digest.length && out.length < n; i++) out.push(digest[i]);
    }
    return out;
  },
  token: function (nBytes) {
    return Util.b64url(Rand.bytes(nBytes || 32));
  }
};
