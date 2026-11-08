/**
 * ค่าที่ใช้ร่วมกันระหว่าง Cloud Functions และแอป (แก้ที่นี่ที่เดียว)
 */
// นักเรียนไม่ต้องมีอีเมล: ระบบแปลงชื่อผู้ใช้ (เช่น รหัสนักเรียน) เป็นอีเมลภายในสำหรับ Firebase Auth
// ไม่มีการส่งอีเมลไปยังที่อยู่นี้ (ปิดการรีเซ็ตรหัสผ่านทางอีเมล ผู้ดูแลเป็นผู้รีเซ็ต)
export const LOGIN_DOMAIN = 'login.cwk-hub.example.com';
export const REGION = 'asia-southeast1';

export function authEmail(username, schoolCode) {
  const u = String(username || '').trim().toLowerCase();
  if (u.includes('@')) return u; // ครู/ผู้ดูแลที่ใช้อีเมลจริง
  return u + '@' + String(schoolCode || 'cwk').toLowerCase() + '.' + LOGIN_DOMAIN;
}

export const DEFAULT_SETTINGS = {
  appName: 'CWK Learning Hub',
  maxFileMb: 25,
  maxFilesPerSubmission: 10,
  allowedFileTypes: ['pdf', 'jpg', 'jpeg', 'png', 'webp', 'docx', 'xlsx', 'pptx', 'txt'],
  selfRegistrationEnabled: false
};

export const OFFERING_PERMISSIONS = ['can_view', 'can_grade', 'can_edit_scores', 'can_import', 'can_export', 'can_publish', 'can_close', 'can_manage'];

export const KIND_LABELS = { individual: 'งานเดี่ยว', group: 'งานกลุ่ม', exam: 'สอบ', score_only: 'รับคะแนนอย่างเดียว' };
export const GRADE_STATUSES = ['not_assessed', 'scored', 'missing', 'excused', 'needs_revision'];
export const GRADE_STATUS_LABELS = { not_assessed: 'ยังไม่ประเมิน', scored: 'มีคะแนน', missing: 'ยังไม่ส่ง/ขาดสอบ', excused: 'ยกเว้น', needs_revision: 'รอแก้ไข' };

export function personName(p) {
  return p ? [p.prefix, p.firstName, p.lastName].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim() : '';
}
export function roomLabel(classLevel, room) {
  if (!classLevel && !room) return 'ไม่ระบุห้อง';
  return (classLevel || '') + (room ? '/' + room : '');
}
export function compareStudents(a, b) {
  const o = { numeric: true };
  return String(a.classLevel || '').localeCompare(String(b.classLevel || ''), 'th', o) ||
    String(a.room || '').localeCompare(String(b.room || ''), 'th', o) ||
    (Number(a.rollNo || 0) - Number(b.rollNo || 0)) ||
    String(a.code || '').localeCompare(String(b.code || ''), 'th', o);
}
