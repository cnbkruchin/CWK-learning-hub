# API ฝั่งเซิร์ฟเวอร์

หน้าเว็บเรียกผ่านฟังก์ชันเดียว:

```js
google.script.run
  .withSuccessHandler(res => ...)   // { ok: true, data } | { ok: false, error: { code, message, details } }
  .apiCall({ action: 'submission.submit', token: '<session token>', payload: { ... } });
```

- ทุก action ยกเว้น `auth.login` / `auth.logout` / `auth.registrationInfo` / `auth.register` ต้องมี `token` ที่ยังไม่หมดอายุ
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
| `auth.registrationInfo` | ทุกคน | `schoolCode?` | `enabled, needsCode, schoolName` | |
| `auth.register` | ทุกคน | `studentCode, prefix, firstName, lastName, classLevel, room, rollNo, password, registrationCode?` | `status: 'pending'` (ต้องรอผู้ดูแลอนุมัติ) | `REGISTRATION_CLOSED` `VALIDATION` (รหัสลงทะเบียน/รหัสผ่าน) `DUPLICATE` (มีบัญชีหรือคำขอค้าง) `BUSY` (จำกัดความถี่) |

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
| `student.join` | `code` | ลงทะเบียนเรียนเองด้วยรหัสเข้าร่วม → `offeringId, already, courseName` | `JOIN_CODE_INVALID` `FORBIDDEN` (ครูเคยถอนออก) |
| `student.grades` | `offeringId` | คะแนนของฉัน (เฉพาะค่าที่ประกาศ) + คะแนนสะสม/ผลรวม + เกรดเมื่อครบ | `NOT_ENROLLED` |

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

`group.*` ใช้กับงานที่ "ให้นักเรียนจัดกลุ่มเฉพาะงานนี้" เท่านั้น งานที่ใช้กลุ่มประจำรายวิชาตอบ `VALIDATION` และให้จัดการที่ `wg.*`

## นักเรียน: กลุ่มประจำรายวิชา (กลุ่มเดิมทำงานได้หลายงาน)

| action | payload | หมายเหตุ |
| --- | --- | --- |
| `wg.mine` | `offeringId` | กลุ่มของฉัน (ชื่อ/ห้องของสมาชิก) คำเชิญ เพื่อนที่ยังไม่มีกลุ่ม กลุ่มอื่น (ชื่อ/จำนวน) งานกลุ่มที่ใช้กลุ่มนี้ |
| `wg.create` | `offeringId, name` | ผู้สร้างเป็นหัวหน้ากลุ่ม; `GROUP_ALREADY_MEMBER` `GROUPS_LOCKED` `DUPLICATE` |
| `wg.invite` | `offeringId, studentIds[]` | หัวหน้ากลุ่มเท่านั้น; ค่าเริ่มต้นส่งคำเชิญ (เพื่อนต้องตอบรับ) หรือเพิ่มทันทีเมื่อครูเปิด `leaderDirectAdd`; `GROUP_FULL` |
| `wg.respond` | `memberId, accept` | ตอบรับ/ปฏิเสธคำเชิญ; `GROUP_FULL` `GROUP_ALREADY_MEMBER` |
| `wg.leave` | `offeringId` | หัวหน้าออก → ตั้งหัวหน้าใหม่; ไม่มีสมาชิก → ยุบกลุ่ม |
| `wg.leaderRemove` | `offeringId, studentId` | หัวหน้านำสมาชิกออกหรือยกเลิกคำเชิญ |

ทุกการเปลี่ยนกลุ่มประจำรายวิชาซิงก์ไปยังกลุ่มของงานที่ใช้กลุ่มประจำรายวิชาและยังไม่ตรึงรายชื่อ ในธุรกรรมเดียวกัน

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

`teacher.saveAssessment` สำหรับงานกลุ่มรับ `group.source`: `work_groups` (ใช้กลุ่มประจำรายวิชา) หรือ `self` (นักเรียนจัดกลุ่มเฉพาะงาน)

## รายวิชา ทะเบียนผู้เรียน และกลุ่มประจำรายวิชา (ครูและผู้ดูแล)

| action | สิทธิ์ | payload | หมายเหตุ |
| --- | --- | --- | --- |
| `course.terms` | ครู/ผู้ดูแล | – | ปีการศึกษาและภาคเรียน |
| `course.catalog` | ครู/ผู้ดูแล | – | รายวิชาในหลักสูตร |
| `course.save` | ครู/ผู้ดูแล | `id?, version?, code, nameTh, learningArea?, gradeLevel?, credits?, hours?, description?` | ครูแก้ได้เฉพาะวิชาที่ตนสร้าง; `DUPLICATE` |
| `offering.list` | ครู/ผู้ดูแล | `termId?, includeArchived?` | รายวิชาที่เปิดสอนที่มีสิทธิ์ดู |
| `offering.save` | ครู (เป็นเจ้าของอัตโนมัติ) / ผู้ดูแล (เลือกครูเจ้าของ) | `id?, version?, courseId, termId, sectionCode, calcMethod, status?, ownerTeacherId?` | สร้างรุ่นนโยบายคะแนน + เกณฑ์เกรดเริ่มต้น; มีคะแนนแล้วเปลี่ยนวิธีคำนวณไม่ได้ |
| `offering.coTeachers` / `offering.setCoTeacher` | ผู้ดูแลหรือครูเจ้าของ | `offeringId, teacherId, perms{can_*}, revoke?` | สิทธิ์ครูร่วมสอนแยกรายการ |
| `offering.roster` | `can_view` | `offeringId` | นักเรียนในรายวิชา สถานะลงทะเบียน กลุ่มประจำรายวิชา |
| `offering.candidates` | `can_manage` | `offeringId, classLevel?, room?, q?` | นักเรียนในทะเบียนที่ยังไม่ได้ลงทะเบียน (รหัส ชื่อ ห้อง) |
| `offering.enroll` | `can_manage` | `offeringId, studentIds[]` | `added, reactivated, skipped` ไม่สร้างคะแนนย้อนหลัง |
| `offering.withdraw` | `can_manage` | `offeringId, studentId, reason, status?` | เก็บวันมีผล/ประวัติ และนำออกจากกลุ่มประจำรายวิชา |
| `offering.setJoin` | `can_manage` | `offeringId, enabled, regenerate?` | รหัสเข้าร่วม 6 ตัว |
| `registry.students` | ครู/ผู้ดูแล | `classLevel?, room?, status?, q?` | ครูเห็นเฉพาะรหัส ชื่อ ชั้น ห้อง เลขที่; ผู้ดูแลเห็นข้อมูลบัญชีด้วย |
| `registry.teachers` | ครู/ผู้ดูแล | – | |
| `wg.overview` | `can_view` | `offeringId` | กลุ่มทั้งหมด สมาชิก คำเชิญ นักเรียนที่ยังไม่มีกลุ่ม งานที่ใช้กลุ่ม |
| `wg.save` | `can_manage` | `offeringId, id?, name, leaderStudentId?, studentIds?, version?` | สร้าง/เปลี่ยนชื่อ/ตั้งหัวหน้า + ใส่สมาชิก |
| `wg.addMembers` | `can_manage` | `offeringId, workGroupId, studentIds[]` | ย้ายจากกลุ่มเดิมให้อัตโนมัติ คืน `moved, overMax` |
| `wg.removeMember` / `wg.disband` | `can_manage` | `offeringId, workGroupId, studentId?` | |
| `wg.auto` | `can_manage` | `offeringId, size, byRoom?` | สุ่มจัดนักเรียนที่ยังไม่มีกลุ่ม |
| `wg.settings` | `can_manage` | `offeringId, maxSize, leaderDirectAdd, locked` | |

## สมุดคะแนนและการให้คะแนน

| action | สิทธิ์ | payload | หมายเหตุ |
| --- | --- | --- | --- |
| `grades.sheet` | `can_view` | `offeringId` | ตารางนักเรียน × รายการประเมิน + ผลรวม/เกรดจาก `Grading.compute` + สถิติการประกาศ |
| `grades.save` | `can_grade` (แก้คะแนนที่มีแล้วต้อง `can_edit_scores`) | `assessmentId, entries[{studentId, status, score, reason, expectedVersion}]` | งานเดี่ยว/สอบ/รับคะแนนอย่างเดียว; ทั้งชุดหรือไม่บันทึกเลย; `VALIDATION` (เกิน/ติดลบ/ว่าง/ยกเว้นไม่มีเหตุผล) `CONFLICT` `OFFERING_CLOSED` |
| `grades.groupSheet` | `can_view` | `assessmentId` | กลุ่ม คะแนนกลุ่ม สมาชิกพร้อมคะแนนรายบุคคลและสถานะ (ได้คะแนนกลุ่ม/ปรับรายคน/ยังไม่ได้รับ) |
| `grades.saveGroup` | `can_grade` | `assessmentId, groupId, status, score, note?, expectedVersion?, preview?, clearOverrides?: studentId[] \| true` | `preview:true` คืนตัวอย่างก่อน/หลังโดยไม่บันทึก; บันทึกจริง = ตรึงรายชื่อ (ถ้ายัง) + `group_grades` + คะแนนรายบุคคลของสมาชิกทุกคนในธุรกรรมเดียว คนที่ปรับรายคนไว้คงเดิม |
| `grades.override` | `can_grade` (+`can_edit_scores` เมื่อมีคะแนนแล้ว) | `assessmentId, studentId, status, score, reason, clear?, expectedVersion?` | ปรับรายคนต้องมีเหตุผล; `clear` = กลับไปใช้คะแนนกลุ่ม |
| `grades.publish` | `can_publish` | `assessmentId, action?(publish/unpublish), reason?` | เรียกคืนต้องมีเหตุผล; แจ้งเตือนไม่มีคะแนนในข้อความ |
| `grades.history` | `can_view` | `studentGradeId` | ประวัติทุกครั้ง: ค่าก่อน/หลัง ที่มา ผู้แก้ เวลา เหตุผล |

## รายงาน

| action | สิทธิ์ | payload | หมายเหตุ |
| --- | --- | --- | --- |
| `report.data` | `can_export` | `kind: offering \| groups \| room`, `offeringId` หรือ `classLevel, room, termId?`, `groupBy?: room \| all` | เอกสารรายงานชุดเดียวที่ใช้แสดงผล/พิมพ์เป็น PDF |
| `report.xlsx` | `can_export` | เหมือน `report.data` | `fileName, mime, size, base64` ไฟล์ .xlsx จากข้อมูลชุดเดียวกัน |

- `offering` = สมุดคะแนนรายวิชา แยกตามห้อง (หรือรวม) · `groups` = ผลประเมินงานกลุ่ม แยกตามกลุ่ม · `room` = สรุปคะแนนรายห้องทุกรายวิชา
- รายงานรายห้องรวมเฉพาะรายวิชาที่ผู้ขอมีสิทธิ์ส่งออก (ครูเห็นเฉพาะนักเรียนในรายวิชาของตน ผู้ดูแลเห็นทั้งห้อง)

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
| `admin.saveStudent` | `id?, version?, studentCode, prefix, firstName, lastName, classLevel, room, rollNo, status, createAccount?` | สร้างบัญชี (ชื่อผู้ใช้ = รหัสนักเรียน) คืนรหัสผ่านชั่วคราวครั้งเดียว |
| `admin.createStudentAccount` | `studentId` | สร้างบัญชีให้นักเรียนที่ยังไม่มี |
| `admin.importStudents` | `text, commit?, skipErrors?, createAccounts?` | CSV/TSV (หัวตารางไทย/อังกฤษ) ไม่ commit = หน้าตัวอย่าง (insert/update/skip/error รายแถว + คำเตือนศูนย์นำหน้า); commit ที่มีแถวผิดต้อง `skipErrors`; สูงสุด 500 แถว |
| `admin.saveTeacher` | `id?, version?, teacherCode, prefix, firstName, lastName, department, status?, username?` | สร้างบัญชีครูพร้อมรหัสชั่วคราว |
| `admin.setRole` | `userId, role(admin/grade_admin), grant, reason` | `grade_admin` = ผู้ดูแลที่ให้/แก้คะแนนได้ (มีบันทึก) |
| `admin.staffUsers` | – | ผู้ใช้ที่เป็นผู้ดูแล/ผู้ดูแลคะแนน |
| `admin.registrations` / `admin.decideRegistration` | `status?` / `id, approve, reason?` | อนุมัติแล้วสร้างบัญชี (ผูกกับทะเบียนเดิมถ้ามี) ไม่ส่ง hash รหัสผ่านให้หน้าเว็บ |
| `admin.saveYear` / `admin.saveTerm` | `yearBe` (สร้างภาค 1–2 ให้) / `academicYearId, termNo` | |

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
| `GROUP_*` `GROUPS_LOCKED` | การจัดกลุ่ม |
| `REGISTRATION_CLOSED` `JOIN_CODE_INVALID` | ยังไม่เปิดสมัครใช้งานเอง / รหัสเข้าร่วมรายวิชาไม่ถูกต้อง |
| `OFFERING_CLOSED` | รายวิชาปิดผลแล้ว แก้คะแนนไม่ได้ |
| `SETUP_REQUIRED` `DB_SCHEMA_MISMATCH` | ยังไม่ติดตั้ง / โครงสร้างตารางไม่ตรง (รัน `setup`) |
| `INTERNAL` | ข้อผิดพลาดภายใน แสดงรหัสอ้างอิงให้แจ้งผู้ดูแล (รายละเอียดอยู่ใน log ของ Apps Script) |
