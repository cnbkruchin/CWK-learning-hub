/**
 * CWK Learning Hub — ค่าคงที่ของระบบ
 *
 * ค่าที่โรงเรียนปรับได้ให้เก็บในตาราง settings (ผ่านหน้าตั้งค่า) ไม่แก้ในไฟล์นี้
 * ค่าในไฟล์นี้เป็นค่าเริ่มต้นและเพดานทางเทคนิคของ Apps Script
 *
 * หมายเหตุ: ทุกฟังก์ชันระดับบนสุดใน Apps Script ถูกเรียกจากเบราว์เซอร์ผ่าน
 * google.script.run ได้ จึงเก็บตรรกะไว้ในอ็อบเจกต์ (ไม่ใช่ฟังก์ชันระดับบนสุด)
 * และฟังก์ชันภายในที่ต้องอยู่ระดับบนสุดให้ลงท้ายด้วย _
 */
var APP = {
  NAME_DEFAULT: 'CWK Learning Hub',
  SCHEMA_VERSION: 1,
  TIMEZONE: 'Asia/Bangkok',

  // กลุ่มฐานข้อมูล: แต่ละกลุ่มคือ Google Spreadsheet หนึ่งไฟล์
  // แยกไฟล์เพื่อไม่ให้ชนเพดาน 10 ล้านเซลล์ต่อไฟล์ และสำรอง/กู้คืนเป็นส่วนได้
  DB_GROUPS: {
    core: 'CWK_DB_core (บัญชี รายวิชา ทะเบียน)',
    plan: 'CWK_DB_plan (แผนคะแนนและภาระงาน)',
    work: 'CWK_DB_work (กลุ่ม การส่งงาน)',
    files: 'CWK_DB_files (metadata ไฟล์และการอ้างอิงไฟล์)',
    grades: 'CWK_DB_grades (คะแนนและการประกาศผล)',
    system: 'CWK_DB_system (นำเข้า ส่งออก แจ้งเตือน บันทึกตรวจสอบ)'
  },

  // โครงสร้างโฟลเดอร์บน Google Drive (ภายใต้โฟลเดอร์รากของระบบ)
  DRIVE_FOLDERS: {
    DB: '01_database',
    STAGING: '02_staging',
    QUARANTINE: '03_quarantine',
    FILES: '04_files',
    SNAPSHOTS: '05_result_snapshots',
    EXPORTS: '06_exports',
    IMPORTS: '07_imports',
    BACKUPS: '08_backups'
  },
  ROOT_FOLDER_NAME: 'CWK Learning Hub — ข้อมูลระบบ (ห้ามแชร์)',

  // ค่าเริ่มต้นที่ผู้ดูแลแก้ได้ในตาราง settings
  DEFAULT_SETTINGS: {
    app_name: 'CWK Learning Hub',
    max_file_mb: 25,
    max_files_per_submission: 10,
    // ชนิดไฟล์ที่โรงเรียนอนุญาต ครูเลือกชุดย่อยได้ต่อภาระงาน
    allowed_file_types: ['pdf', 'jpg', 'jpeg', 'png', 'webp', 'docx', 'xlsx', 'pptx', 'txt'],
    // ชนิดที่รองรับทางเทคนิคแต่ปิดไว้เป็นค่าเริ่มต้น
    optional_file_types: ['gif', 'csv', 'odt', 'ods', 'odp', 'zip', 'py', 'js', 'html', 'css', 'java', 'c', 'cpp', 'sb3'],
    staging_retention_hours: 72,
    quarantine_retention_days: 30,
    quota_total_mb: 0, // 0 = ไม่ตั้งเพดานเพิ่มเติม (ใช้พื้นที่จริงของบัญชี Drive)
    quota_warn_percent: 80,
    zip_max_uncompressed_mb: 200,
    zip_max_entries: 2000,
    session_idle_minutes: 120,
    session_absolute_hours: 12,
    login_max_failures: 5,
    login_lock_minutes: 15,
    backup_retention_days: 30,
    late_penalty_enabled: false
  },

  // เพดานทางเทคนิค
  UPLOAD_CHUNK_BYTES: 2 * 1024 * 1024, // ต้องเป็นพหุคูณของ 256 KiB ตามข้อกำหนด Drive resumable upload
  DOWNLOAD_CHUNK_BYTES: 3 * 1024 * 1024,
  UPLOAD_SESSION_TTL_SEC: 6 * 60 * 60,
  DOWNLOAD_TICKET_TTL_SEC: 10 * 60,
  LOCK_WAIT_MS: 25000,
  CELL_MAX_CHARS: 45000, // Google Sheets รับได้ 50,000 ตัวอักษรต่อเซลล์
  PBKDF2_ITERATIONS: 60000,
  IDEMPOTENCY_TTL_HOURS: 48,
  JOURNAL_KEEP_DAYS: 7,

  // สิทธิ์ของครูตามความสัมพันธ์กับรายวิชา
  OFFERING_PERMISSIONS: ['can_view', 'can_grade', 'can_edit_scores', 'can_import', 'can_export', 'can_publish', 'can_close', 'can_manage']
};

/**
 * Script Properties แบบอ่านครั้งเดียวต่อคำขอ (ลดการใช้โควตา Properties read ต่อวัน)
 * ค่าที่ต้องสดเสมอ (เช่น TX_PENDING) ให้อ่านจาก PropertiesService โดยตรง
 */
var Props = {
  _cache: null,
  all: function () {
    if (!Props._cache) Props._cache = PropertiesService.getScriptProperties().getProperties();
    return Props._cache;
  },
  get: function (key) {
    var v = Props.all()[key];
    return v === undefined || v === null ? null : v;
  },
  reset: function () { Props._cache = null; }
};
