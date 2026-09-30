# API ฝั่งเซิร์ฟเวอร์

หน้าเว็บเรียกผ่านฟังก์ชันเดียว:

```js
google.script.run
  .withSuccessHandler(res => ...)   // { ok: true, data } | { ok: false, error: { code, message, details } }
  .apiCall({ action: 'submission.submit', token: '<session token>', payload: { ... } });
```

- ทุก action ยกเว้น `auth.login` / `auth.logout` ต้องมี `token` ที่ยังไม่หมดอายุ
- บัญชีที่ต้องเปลี่ยนรหัสผ่านเรียกได้เฉพาะ `auth.me`, `auth.changePassword` จนกว่าจะเปลี่ยน (`PASSWORD_CHANGE_REQUIRED`)
- สิทธิ์ตรวจภายในบริการทุกครั้ง (ตารางด้านล่างคือสิทธิ์ขั้นต่ำ)
- เวลาทั้งหมดเป็น ISO 8601 UTC; ช่องที่ลงท้าย `Text` เป็นข้อความเวลาไทย ปี พ.ศ.

## บัญชีและแจ้งเตือน

| action | ผู้เรียก | payload | ผลลัพธ์ | ข้อผิดพลาดหลัก |
| --- | --- | --- | --- | --- |
| `auth.login` | ทุกคน | `username, password, userAgent?, schoolCode?` | `token, mustChangePassword` | `AUTH_INVALID` `AUTH_LOCKED` `AUTH_DISABLED` |
| `auth.logout` | ทุกคน | – | `true` | |
| `auth.me` | ผู้ใช้ | – | โปรไฟล์ บทบาท โรงเรียน (ไม่มีข้อมูลลับ) | `SESSION_EXPIRED` |
| `auth.changePassword` | ผู้ใช้ | `oldPassword, newPassword` | `token` ใหม่ (session เดิมทั้งหมดถูกเพิกถอน) | `AUTH_INVALID` `VALIDATION` |
| `notify.list` | ผู้ใช้ | – | แจ้งเตือน 50 รายการล่าสุดของตน | |
| `notify.markRead` | ผู้ใช้ | `ids[]` | `true` | |

## นักเรียน: รายวิชา งาน และการส่ง

| action | payload | ผลลัพธ์ | ข้อผิดพลาดหลัก |
| --- | --- | --- | --- |
| `student.courses` | – | รายวิชาที่ลงทะเบียน | `FORBIDDEN` (ไม่ใช่นักเรียน) |
| `student.assessments` | `offeringId` | งานที่เผยแพร่ + สถานะของตน + คะแนนที่ประกาศเท่านั้น | `NOT_ENROLLED` |
| `student.assessment` | `assessmentId` | คำชี้แจง ช่วงเวลา (รวมขยายเวลา) เพดานไฟล์ กลุ่ม ฉบับร่าง รุ่นที่ส่ง | `NOT_FOUND` `NOT_ENROLLED` |
| `student.folder` | `offeringId` | แฟ้มเสมือนของตน | |
| `upload.begin` | `assessmentId, fileName, size, mimeType` | `uploadId, chunkSize, fileAssetId` | `SUBMISSION_NOT_OPEN` `SUBMISSION_CLOSED` `FILE_TYPE_NOT_ALLOWED` `FILE_TOO_LARGE` `FILE_COUNT_EXCEEDED` `QUOTA_EXCEEDED` `GROUP_REQUIRED` |
| `upload.chunk` | `uploadId, offset, data(base64)` | `received, done, duplicate?` | `UPLOAD_OUT_OF_ORDER` (details.received) `FILE_SIGNATURE_MISMATCH` `FILE_REJECTED` `UPLOAD_EXPIRED` |
| `upload.finalize` | `uploadId` | `{accepted:true, file}` หรือ `{accepted:false, code, message}` | `FILE_NOT_READY` |
| `submission.removeDraft` | `assessmentId, refId` | `true` | `NOT_FOUND` `GROUP_FROZEN` |
| `submission.copyToDraft` | `assessmentId, versionId` | `added` | `FILE_COUNT_EXCEEDED` |
| `submission.submit` | `assessmentId, baseVersionNo, idempotencyKey, fileAssetIds?, comment?, links?` | ใบยืนยัน `receiptCode, versionNo, submittedAt(+Text), isLate, files[], links[], replayed?` | `CONFLICT` (details.currentVersionNo) `ATTEMPTS_EXCEEDED` `NOTHING_TO_SUBMIT` `FILE_NOT_READY` `GROUP_SIZE_INVALID` `GROUP_NOT_APPROVED` `GROUP_LEADER_ONLY` `SUBMISSION_CLOSED` |
| `submission.detail` | `submissionId` | รุ่นที่ตนมีสิทธิ์เห็น | `FORBIDDEN` |

## นักเรียน: กลุ่ม

| action | payload | หมายเหตุ |
| --- | --- | --- |
| `group.forStudent` | `assessmentId` | กลุ่มของฉัน คำเชิญ กลุ่มที่ขอเข้าได้ เพื่อนที่ยังไม่มีกลุ่ม (เฉพาะชื่อ/ห้อง) |
| `group.create` | `assessmentId, name` | `GROUP_ALREADY_MEMBER` `GROUP_FORMATION_CLOSED` |
| `group.invite` | `assessmentId, studentId` | เพื่อนต้องลงทะเบียนและยังไม่มีกลุ่ม |
| `group.respond` | `membershipId, accept` | `GROUP_FULL` `GROUP_FROZEN` |
| `group.requestJoin` | `assessmentId, groupId` | `GROUP_FULL` |
| `group.decideRequest` | `membershipId, approve` | สมาชิกกลุ่มนั้นเท่านั้น |
| `group.leave` | `assessmentId` | `GROUP_FROZEN`; หัวหน้าออก → เลือกหัวหน้าใหม่; ไม่มีสมาชิก → ยุบกลุ่ม |

## ครู

| action | สิทธิ์ในรายวิชา | payload | หมายเหตุ |
| --- | --- | --- | --- |
| `teacher.offerings` | ครู/ผู้ดูแล | – | รายวิชาที่มีสิทธิ์ดู พร้อมธงสิทธิ์ |
| `teacher.assessments` | `can_view` | `offeringId` | ภาระงานทั้งหมด (รวมฉบับร่าง) เพดานไฟล์ของโรงเรียน |
| `teacher.saveAssessment` | `can_manage` | ข้อมูลงาน (+`id, version` เมื่อแก้) | ตรวจคะแนนเต็ม น้ำหนัก วันที่ ชนิดไฟล์ เพดาน กลุ่ม; มีคะแนนแล้วแก้คะแนนเต็ม/น้ำหนักไม่ได้; รุ่นไม่ตรง → `CONFLICT` |
| `teacher.grantExtension` | `can_manage` | `assessmentId, targetType(student/group), targetId, dueAt?, closeAt?, reason` | ต้องมีเหตุผล |
| `teacher.submissions` | `can_view` | `assessmentId` | คิวตรวจงาน + ตัวนับ |
| `teacher.review` | `can_grade` | `versionId, action(accept/return), note, expectedVersion?` | ส่งคืนต้องมีข้อความ |
| `teacher.groups` | `can_view` | `assessmentId` | กลุ่ม สมาชิก กลุ่มไม่ครบ นักเรียนที่ยังไม่มีกลุ่ม |
| `teacher.groupApprove` | `can_manage` | `groupId, sizeException?, reason?, expectedVersion?` | ข้อยกเว้นจำนวนต้องมีเหตุผล |
| `teacher.groupAssign` | `can_manage` | `assessmentId, studentId, groupId? / newGroupName?, reason?, confirm?` | กลุ่มถูกตรึงหรือเกินจำนวน → ได้ `needsConfirm` + `impact` ก่อน |
| `teacher.groupCopy` | `can_manage` | `fromAssessmentId, toAssessmentId` | คัดลอกเฉพาะนักเรียนที่ยังเรียนและยังไม่มีกลุ่ม |

## ไฟล์

| action | payload | หมายเหตุ |
| --- | --- | --- |
| `files.open` | `fileAssetId` | ตรวจสิทธิ์ → ตั๋ว 10 นาที + ชื่อ ขนาด ชนิดที่ปลอดภัย จำนวนช่วง |
| `files.chunk` | `ticket, index` | ข้อมูลช่วงละ 3 MB (base64); ตั๋วต้องเป็นของผู้เรียก |
| `files.studentFolder` | `offeringId, studentId` | ครู `can_view` หรือนักเรียนเจ้าของ |
| `files.groupFolder` | `assessmentId` | ครู `can_view` |

## ผู้ดูแล

| action | payload | หมายเหตุ |
| --- | --- | --- |
| `admin.status` | – | พื้นที่ Drive ไฟล์แยกสถานะ จำนวนข้อมูล งานตั้งเวลา ธุรกรรมค้าง ค่าตั้ง |
| `admin.updateSettings` | `changes{}` | แก้ได้เฉพาะค่าที่กำหนด พร้อมช่วงที่อนุญาต |
| `admin.resetPassword` | `userId` | คืนรหัสชั่วคราว (แสดงครั้งเดียว) บังคับเปลี่ยน เพิกถอน session |
| `admin.setUserStatus` | `userId, status(active/disabled), reason` | ข้อมูลงาน/คะแนนเดิมไม่ถูกลบ |

## รหัสข้อผิดพลาด

| รหัส | ความหมาย |
| --- | --- |
| `AUTH_REQUIRED` `SESSION_EXPIRED` | ต้องเข้าสู่ระบบ / หมดเวลา |
| `AUTH_INVALID` `AUTH_LOCKED` `AUTH_DISABLED` `PASSWORD_CHANGE_REQUIRED` | ปัญหาบัญชี |
| `FORBIDDEN` `NOT_FOUND` `NOT_ENROLLED` | ไม่มีสิทธิ์ / ไม่พบ (ข้อมูลของผู้อื่นตอบ `NOT_FOUND` หรือ `FORBIDDEN` โดยไม่เปิดเผยรายละเอียด) |
| `VALIDATION` `DUPLICATE` | ข้อมูลไม่ถูกต้อง / ซ้ำ (details.field) |
| `CONFLICT` | มีผู้แก้/ส่งรุ่นใหม่ก่อน ต้องโหลดข้อมูลล่าสุด |
| `BUSY` | ระบบกำลังบันทึกรายการอื่น ลองใหม่ (หน้าเว็บลองให้อัตโนมัติสำหรับคำสั่งที่ทำซ้ำได้) |
| `SUBMISSION_*` `ATTEMPTS_EXCEEDED` `NOTHING_TO_SUBMIT` | เงื่อนไขการส่ง |
| `FILE_*` `UPLOAD_*` `QUOTA_EXCEEDED` | ไฟล์และการอัปโหลด |
| `GROUP_*` | การจัดกลุ่ม |
| `SETUP_REQUIRED` `DB_SCHEMA_MISMATCH` | ยังไม่ติดตั้ง / โครงสร้างตารางไม่ตรง (รัน `setup`) |
| `INTERNAL` | ข้อผิดพลาดภายใน แสดงรหัสอ้างอิงให้แจ้งผู้ดูแล (รายละเอียดอยู่ใน log ของ Apps Script) |
