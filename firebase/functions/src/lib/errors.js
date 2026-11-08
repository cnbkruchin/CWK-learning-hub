import { HttpsError } from 'firebase-functions/v2/https';

/** รหัสข้อผิดพลาดของระบบ (ข้อความภาษาไทย) → รหัส HttpsError ของ Firebase */
export const ERR = {
  AUTH_REQUIRED: ['unauthenticated', 'กรุณาเข้าสู่ระบบ'],
  AUTH_DISABLED: ['permission-denied', 'บัญชีนี้ถูกปิดใช้งาน กรุณาติดต่อผู้ดูแลระบบ'],
  PASSWORD_CHANGE_REQUIRED: ['failed-precondition', 'กรุณาเปลี่ยนรหัสผ่านก่อนใช้งาน'],
  FORBIDDEN: ['permission-denied', 'คุณไม่มีสิทธิ์ทำรายการนี้'],
  NOT_FOUND: ['not-found', 'ไม่พบข้อมูลที่ต้องการ'],
  VALIDATION: ['invalid-argument', 'ข้อมูลไม่ถูกต้อง'],
  CONFLICT: ['aborted', 'ข้อมูลถูกแก้ไขโดยผู้อื่นแล้ว กรุณาโหลดข้อมูลล่าสุดก่อนทำรายการอีกครั้ง'],
  DUPLICATE: ['already-exists', 'มีข้อมูลนี้อยู่แล้ว'],
  BUSY: ['resource-exhausted', 'มีคำขอจำนวนมาก กรุณาลองใหม่ภายหลัง'],
  SETUP_REQUIRED: ['failed-precondition', 'ระบบยังไม่ได้ตั้งค่าโรงเรียน กรุณาให้ผู้ดูแลรันสคริปต์ bootstrap'],
  NOT_ENROLLED: ['permission-denied', 'คุณไม่ได้ลงทะเบียนในรายวิชานี้'],
  REGISTRATION_CLOSED: ['failed-precondition', 'ยังไม่เปิดให้นักเรียนลงทะเบียนด้วยตนเอง กรุณาติดต่อครูหรือผู้ดูแลระบบ'],
  JOIN_CODE_INVALID: ['not-found', 'รหัสเข้าร่วมรายวิชาไม่ถูกต้อง หรือรายวิชาปิดรับการลงทะเบียนแล้ว'],
  GROUPS_LOCKED: ['failed-precondition', 'ครูล็อกการจัดกลุ่มของรายวิชานี้แล้ว การเปลี่ยนสมาชิกทำได้โดยครูเท่านั้น'],
  GROUP_FULL: ['failed-precondition', 'กลุ่มนี้มีสมาชิกครบแล้ว'],
  GROUP_ALREADY_MEMBER: ['failed-precondition', 'คุณมีกลุ่มในรายวิชานี้แล้ว (หนึ่งคนอยู่ได้หนึ่งกลุ่มต่อรายวิชา)'],
  GROUP_REQUIRED: ['failed-precondition', 'งานนี้เป็นงานกลุ่ม กรุณาเข้ากลุ่มก่อน'],
  GROUP_FROZEN: ['failed-precondition', 'รายชื่อกลุ่มของงานนี้ถูกตรึงแล้ว การเปลี่ยนสมาชิกทำได้โดยครูเท่านั้น'],
  GROUP_SIZE_INVALID: ['failed-precondition', 'จำนวนสมาชิกกลุ่มไม่ตรงตามที่ครูกำหนด'],
  GROUP_LEADER_ONLY: ['failed-precondition', 'งานนี้ให้หัวหน้ากลุ่มเป็นผู้ส่งเท่านั้น'],
  OFFERING_CLOSED: ['failed-precondition', 'รายวิชาปิดผลแล้ว แก้ไขไม่ได้'],
  SUBMISSION_NOT_OPEN: ['failed-precondition', 'ยังไม่ถึงเวลาเปิดรับงาน'],
  SUBMISSION_CLOSED: ['failed-precondition', 'ปิดรับงานนี้แล้ว'],
  SUBMISSION_NOT_REQUIRED: ['failed-precondition', 'รายการประเมินนี้ไม่ต้องส่งไฟล์'],
  ATTEMPTS_EXCEEDED: ['failed-precondition', 'ส่งงานครบจำนวนครั้งที่ครูกำหนดแล้ว'],
  NOTHING_TO_SUBMIT: ['failed-precondition', 'ยังไม่มีไฟล์หรือลิงก์สำหรับส่งงาน'],
  FILE_TOO_LARGE: ['invalid-argument', 'ไฟล์มีขนาดเกินที่กำหนด'],
  FILE_TYPE_NOT_ALLOWED: ['invalid-argument', 'ชนิดไฟล์นี้ไม่อนุญาตสำหรับงานนี้'],
  FILE_COUNT_EXCEEDED: ['invalid-argument', 'จำนวนไฟล์เกินที่กำหนดต่อการส่งหนึ่งครั้ง'],
  FILE_NOT_READY: ['failed-precondition', 'ไฟล์ยังอัปโหลดไม่ครบหรือยังไม่ผ่านการตรวจ'],
  INTERNAL: ['internal', 'เกิดข้อผิดพลาดภายในระบบ กรุณาลองใหม่ หากยังพบปัญหาให้แจ้งผู้ดูแลพร้อมรหัสอ้างอิง']
};

export class AppError extends Error {
  constructor(code, message, details) {
    super(message || (ERR[code] || ERR.INTERNAL)[1]);
    this.code = ERR[code] ? code : 'INTERNAL';
    this.details = details || null;
  }
}

export function raise(code, message, details) { throw new AppError(code, message, details); }
export function check(cond, code, message, details) { if (!cond) throw new AppError(code, message, details); }

export function toHttps(e) {
  if (e instanceof HttpsError) return e;
  if (e instanceof AppError) {
    return new HttpsError(ERR[e.code][0], e.message, Object.assign({ code: e.code }, e.details || {}));
  }
  const ref = Math.random().toString(36).slice(2, 10);
  console.error('[' + ref + ']', e && e.stack || e);
  return new HttpsError('internal', ERR.INTERNAL[1] + ' (รหัสอ้างอิง ' + ref + ')', { code: 'INTERNAL', ref });
}
