/**
 * รหัสข้อผิดพลาดมาตรฐาน — ส่งกลับให้หน้าเว็บเป็น { code, message, details }
 * ข้อความภาษาไทยอธิบายสาเหตุและแนวทางแก้ ไม่เปิดเผยรายละเอียดภายในของระบบ
 */
var ERR = {
  AUTH_REQUIRED: 'กรุณาเข้าสู่ระบบ',
  AUTH_INVALID: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง',
  AUTH_LOCKED: 'บัญชีถูกล็อกชั่วคราวเนื่องจากใส่รหัสผ่านผิดหลายครั้ง กรุณารอแล้วลองใหม่',
  AUTH_DISABLED: 'บัญชีนี้ถูกปิดใช้งาน กรุณาติดต่อผู้ดูแลระบบ',
  SESSION_EXPIRED: 'หมดเวลาการใช้งาน กรุณาเข้าสู่ระบบใหม่',
  PASSWORD_CHANGE_REQUIRED: 'กรุณาเปลี่ยนรหัสผ่านก่อนใช้งาน',
  FORBIDDEN: 'คุณไม่มีสิทธิ์ทำรายการนี้',
  NOT_FOUND: 'ไม่พบข้อมูลที่ต้องการ',
  VALIDATION: 'ข้อมูลไม่ถูกต้อง',
  CONFLICT: 'ข้อมูลถูกแก้ไขโดยผู้อื่นแล้ว กรุณาโหลดข้อมูลล่าสุดก่อนทำรายการอีกครั้ง',
  DUPLICATE: 'มีข้อมูลนี้อยู่แล้ว',
  BUSY: 'ระบบกำลังบันทึกรายการอื่นอยู่ กรุณาลองใหม่อีกครั้ง',
  SETUP_REQUIRED: 'ระบบยังไม่ได้ติดตั้งฐานข้อมูล กรุณาให้ผู้ดูแลรันฟังก์ชัน setup',
  DB_SCHEMA_MISMATCH: 'โครงสร้างตารางไม่ตรงกับที่ระบบคาดไว้ กรุณาให้ผู้ดูแลรัน setup เพื่อปรับโครงสร้าง',
  SUBMISSION_NOT_OPEN: 'ยังไม่ถึงเวลาเปิดรับงาน',
  SUBMISSION_CLOSED: 'ปิดรับงานนี้แล้ว',
  SUBMISSION_NOT_REQUIRED: 'รายการประเมินนี้ไม่ต้องส่งไฟล์',
  ATTEMPTS_EXCEEDED: 'ส่งงานครบจำนวนครั้งที่ครูกำหนดแล้ว',
  NOTHING_TO_SUBMIT: 'ยังไม่มีไฟล์หรือลิงก์สำหรับส่งงาน',
  FILE_TOO_LARGE: 'ไฟล์มีขนาดเกินที่กำหนด',
  FILE_TYPE_NOT_ALLOWED: 'ชนิดไฟล์นี้ไม่อนุญาตสำหรับงานนี้',
  FILE_SIGNATURE_MISMATCH: 'เนื้อหาไฟล์ไม่ตรงกับนามสกุลไฟล์ ไฟล์ถูกกักไว้และไม่ถูกนำไปใช้',
  FILE_REJECTED: 'ไฟล์ไม่ผ่านการตรวจความปลอดภัย ไฟล์ถูกกักไว้และไม่ถูกนำไปใช้',
  FILE_NAME_INVALID: 'ชื่อไฟล์ไม่ถูกต้อง',
  FILE_COUNT_EXCEEDED: 'จำนวนไฟล์เกินที่กำหนดต่อการส่งหนึ่งครั้ง',
  FILE_NOT_READY: 'ไฟล์ยังอัปโหลดไม่ครบหรือยังไม่ผ่านการตรวจ',
  UPLOAD_EXPIRED: 'รอบการอัปโหลดหมดอายุ กรุณาเลือกไฟล์แล้วอัปโหลดใหม่',
  UPLOAD_OUT_OF_ORDER: 'ข้อมูลไฟล์มาไม่ครบลำดับ ระบบจะส่งส่วนที่ขาดใหม่',
  UPLOAD_FAILED: 'อัปโหลดไม่สำเร็จ กรุณาลองใหม่',
  QUOTA_EXCEEDED: 'พื้นที่จัดเก็บเต็มตามโควตาที่ตั้งไว้ กรุณาติดต่อผู้ดูแลระบบ',
  GROUP_REQUIRED: 'งานนี้เป็นงานกลุ่ม กรุณาเข้าร่วมหรือสร้างกลุ่มก่อน',
  GROUP_FULL: 'กลุ่มนี้มีสมาชิกครบแล้ว',
  GROUP_ALREADY_MEMBER: 'คุณอยู่ในกลุ่มของงานนี้แล้ว (หนึ่งคนอยู่ได้หนึ่งกลุ่มต่องาน)',
  GROUP_FROZEN: 'รายชื่อกลุ่มถูกตรึงแล้ว การเปลี่ยนสมาชิกทำได้โดยครูเท่านั้น',
  GROUP_FORMATION_CLOSED: 'หมดเวลาจัดกลุ่มแล้ว',
  GROUP_SIZE_INVALID: 'จำนวนสมาชิกกลุ่มไม่ตรงตามที่ครูกำหนด',
  GROUP_NOT_APPROVED: 'กลุ่มยังไม่ได้รับการอนุมัติจากครู',
  GROUP_LEADER_ONLY: 'งานนี้ให้หัวหน้ากลุ่มเป็นผู้ส่งเท่านั้น',
  NOT_ENROLLED: 'คุณไม่ได้ลงทะเบียนในรายวิชานี้',
  CONFIRM_REQUIRED: 'รายการนี้มีผลกระทบ กรุณาตรวจตัวอย่างแล้วยืนยัน',
  INTERNAL: 'เกิดข้อผิดพลาดภายในระบบ กรุณาลองใหม่ หากยังพบปัญหาให้แจ้งผู้ดูแลพร้อมรหัสอ้างอิง'
};

/**
 * ข้อผิดพลาดที่ตั้งใจส่งให้ผู้ใช้เห็น
 * @param {string} code รหัสใน ERR
 * @param {string=} message ข้อความเพิ่มเติม (ถ้าไม่ระบุใช้ข้อความมาตรฐาน)
 * @param {Object=} details ข้อมูลประกอบ เช่น รายการช่องที่ผิด
 */
function AppError(code, message, details) {
  this.name = 'AppError';
  this.code = ERR[code] ? code : 'INTERNAL';
  this.message = message || ERR[this.code];
  this.details = details || null;
  this.stack = (new Error(this.message)).stack;
}
AppError.prototype = Object.create(Error.prototype);
AppError.prototype.constructor = AppError;

var Errors = {
  raise: function (code, message, details) {
    throw new AppError(code, message, details);
  },
  isApp: function (e) {
    return e instanceof AppError || (e && e.name === 'AppError' && e.code);
  },
  check: function (cond, code, message, details) {
    if (!cond) throw new AppError(code, message, details);
  }
};
