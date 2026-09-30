#!/usr/bin/env node
'use strict';
/**
 * สร้าง docs/02-data-model.md จาก gas/Schema.js (แหล่งความจริงเดียว)
 * ใช้: npm run docs:schema
 */
const fs = require('fs');
const path = require('path');
const { loadGas } = require('../tests/harness/load');

const g = loadGas();
const Schema = g.Schema;
const APP = g.APP;

const TYPE = {
  id: 'รหัส (UUID)', ref: 'อ้างอิง', text: 'ข้อความ', code: 'รหัส (ข้อความ)', int: 'จำนวนเต็ม', dec: 'ทศนิยม (ข้อความ)',
  bool: 'จริง/เท็จ', dt: 'วันเวลา ISO UTC', date: 'วันที่ YYYY-MM-DD', json: 'JSON', enum: 'ตัวเลือก'
};

function typeCell(f) {
  if (f.type === 'ref' && f.ref) return `อ้างอิง → \`${f.ref}\``;
  if (f.type === 'enum') return 'ตัวเลือก: ' + f.values.filter(Boolean).map((v) => `\`${v}\``).join(' ');
  return TYPE[f.type] || f.type;
}

const BASE_NAMES = ['id', 'version', 'created_at', 'created_by', 'updated_at', 'updated_by'];

let out = `# แบบข้อมูล (Data Model) บน Google Sheets

> ไฟล์นี้สร้างอัตโนมัติจาก \`gas/Schema.js\` ด้วยคำสั่ง \`npm run docs:schema\` — แก้ที่ Schema.js แล้วสร้างใหม่ อย่าแก้ไฟล์นี้ด้วยมือ

## หลักการ

- **หนึ่งตาราง = หนึ่งชีต** แถวแรกเป็นชื่อคอลัมน์ ระบบอ่านตำแหน่งคอลัมน์จากหัวตาราง จึงเพิ่มคอลัมน์ใหม่ต่อท้ายได้ (ห้ามลบหรือสลับคอลัมน์)
- **แยกเป็น ${Object.keys(APP.DB_GROUPS).length} ไฟล์ Google Sheets** ตามกลุ่มข้อมูล เพื่อไม่ชนเพดาน 10 ล้านเซลล์ต่อไฟล์ และสำรอง/กู้คืนเป็นส่วนได้
- **ทุกเซลล์เป็นข้อความ** (เขียนด้วย quote prefix \`'\`) รักษาเลขศูนย์นำหน้า เช่น \`00123\` ไม่ให้ Sheets แปลงวันที่/ตัวเลขเอง และข้อความที่ขึ้นต้นด้วย \`= + - @\` ไม่ถูกตีความเป็นสูตร
- **กุญแจหลักคือ \`id\` (UUID) ที่ไม่เปลี่ยน** ไม่ใช้ชื่อ ห้อง หรือรหัสนักเรียนเป็นตัวเชื่อม รหัสนักเรียนเป็นข้อมูลที่ตรวจไม่ซ้ำภายในโรงเรียน
- **ไม่ลบแถวจริง** ใช้สถานะหรือเวลาเพิกถอน (\`revoked_at\`, \`status\`) เพื่อเก็บหลักฐานย้อนหลัง (ยกเว้นตารางเทคนิค \`tx_journal\`)
- **\`version\`** เพิ่มทุกครั้งที่แก้แถว ใช้ตรวจการแก้ไขพร้อมกัน (optimistic locking) — ส่ง \`expectedVersion\` แล้วรุ่นไม่ตรงได้ \`CONFLICT\`
- **เวลา** เก็บเป็น ISO 8601 UTC แสดงผลเป็น Asia/Bangkok และปี พ.ศ.
- **คะแนน/น้ำหนัก** เก็บเป็นข้อความทศนิยม (\`dec\`) คำนวณด้วยเศษส่วนแม่นยำ ไม่ใช้ float
- **ค่าว่าง ≠ ศูนย์** คะแนนที่ยังไม่ประเมินเป็นค่าว่าง + สถานะ \`not_assessed\`

### คอลัมน์มาตรฐาน

| คอลัมน์ | ความหมาย |
| --- | --- |
| \`id\` | รหัสภายในที่ไม่เปลี่ยน (UUID) |
| \`version\` | เลขรุ่นของแถว เพิ่มทุกครั้งที่แก้ |
| \`created_at\`, \`created_by\` | เวลาเซิร์ฟเวอร์และผู้สร้าง |
| \`updated_at\`, \`updated_by\` | เวลาและผู้แก้ล่าสุด |

ตารางแบบ *append-only* (ประวัติ/บันทึก) มีเฉพาะ \`id\`, \`created_at\`, \`created_by\` และไม่แก้ไขหลังบันทึก

### ขนาดตารางและการค้นหา

- **small** — อ่านทั้งตารางครั้งเดียวต่อคำขอ (เช่น รายวิชา ครู การตั้งค่า)
- **large** — ค้นทีละคอลัมน์ที่มีดัชนีด้วย \`TextFinder\` แล้วอ่านเฉพาะแถวที่พบ (เช่น คะแนน การส่งงาน ไฟล์)
- **lock-free** — เพิ่มแถวด้วย \`appendRow\` ซึ่งเป็น atomic ไม่ต้องรอล็อก (บันทึกตรวจสอบ ประวัติ)

## แผนภาพความสัมพันธ์หลัก

\`\`\`mermaid
erDiagram
  schools ||--o{ users : "มีบัญชี"
  users ||--o{ role_assignments : "มีบทบาท"
  users ||--o| students : "เป็น"
  users ||--o| teachers : "เป็น"
  academic_years ||--o{ terms : ""
  courses ||--o{ course_offerings : "เปิดสอน"
  terms ||--o{ course_offerings : ""
  course_offerings ||--o{ teaching_assignments : "ครูสอน"
  teachers ||--o{ teaching_assignments : ""
  course_offerings ||--o{ enrollments : "ลงทะเบียน"
  students ||--o{ enrollments : ""
  course_offerings ||--o{ grading_policy_versions : "รุ่นนโยบาย"
  grading_policy_versions ||--o{ grade_bands : ""
  course_offerings ||--o{ score_categories : ""
  course_offerings ||--o{ assessments : "ภาระงาน"
  assessments ||--o| assignment_group_sets : "กติกากลุ่ม"
  assignment_group_sets ||--o{ groups : ""
  groups ||--o{ group_memberships : "สมาชิก"
  groups ||--o{ assignment_member_snapshots : "รายชื่อที่ตรึง"
  assessments ||--o{ submissions : "การส่ง (คน/กลุ่ม)"
  submissions ||--o{ submission_versions : "รุ่น"
  submissions ||--o{ submission_files : "ฉบับร่าง/ไฟล์ในรุ่น"
  submission_versions ||--o{ submission_files : ""
  file_assets ||--o{ submission_files : "อ้างอิงไฟล์"
  enrollments ||--o{ student_grades : "คะแนนต่อรายการ"
  assessments ||--o{ student_grades : ""
  student_grades ||--o{ grade_revisions : "ประวัติ"
  groups ||--o{ group_grades : "คะแนนกลุ่ม"
  course_offerings ||--o{ final_result_snapshots : "ผลปิดรายวิชา"
\`\`\`

## การจับคู่กับ Entity ในข้อกำหนด (ข้อ 15)

| กลุ่มข้อมูลในข้อกำหนด | ตารางในระบบ |
| --- | --- |
| School, User, RoleAssignment, Teacher, Student | \`schools\` \`users\` \`role_assignments\` \`teachers\` \`students\` (+ \`settings\`) |
| AcademicYear, Term, Course, CourseOffering, TeachingAssignment, Enrollment | \`academic_years\` \`terms\` \`courses\` \`course_offerings\` \`teaching_assignments\` \`enrollments\` (+ \`enrollment_history\`) |
| GradingPolicyVersion, GradeBand, ScoreCategory, Assessment, Rubric, RubricCriterion | \`grading_policy_versions\` \`grade_bands\` \`score_categories\` \`assessments\` \`rubrics\` \`rubric_criteria\` (+ \`assessment_extensions\`) |
| AssignmentGroupSet, Group, GroupMembershipHistory, AssignmentMemberSnapshot | \`assignment_group_sets\` \`groups\` \`group_memberships\` \`group_membership_history\` \`assignment_member_snapshots\` |
| Submission, SubmissionVersion, FileAsset, SubmissionFile | \`submissions\` \`submission_versions\` \`file_assets\` \`submission_files\` |
| GroupGrade, StudentGrade, GradeRevision, Feedback, GradePublication | \`group_grades\` \`student_grades\` \`grade_revisions\` \`feedback\` \`grade_publications\` |
| ImportJob, ImportRowResult, FinalResultSnapshot, ExportJob, Notification, AuditLog | \`import_jobs\` \`import_row_results\` \`final_result_snapshots\` \`export_jobs\` \`notifications\` \`audit_log\` (+ \`idempotency_keys\` \`tx_journal\`) |

`;

Object.keys(APP.DB_GROUPS).forEach((db) => {
  const names = Schema.byDb(db);
  out += `## ไฟล์ \`${APP.DB_GROUPS[db]}\`\n\n`;
  out += `ตาราง: ${names.map((n) => '`' + n + '`').join(' ')}\n\n`;
  names.forEach((name) => {
    const t = Schema.get(name);
    const flags = [t.size === 'large' ? 'large' : 'small'];
    if (t.appendOnly) flags.push('append-only');
    if (t.lockFree) flags.push('lock-free');
    if (t.technical) flags.push('ตารางเทคนิค');
    out += `### \`${name}\`\n\n${t.d || ''}\n\n`;
    out += `- ประเภท: ${flags.join(', ')}\n`;
    const idx = t.idx.filter((x) => x !== 'id');
    if (idx.length) out += `- ดัชนีค้นหา: ${idx.map((x) => '`' + x + '`').join(', ')}\n`;
    if (t.unique.length) out += `- ห้ามซ้ำ: ${t.unique.map((u) => '(' + u.map((x) => '`' + x + '`').join(', ') + ')').join(' ')}\n`;
    out += '\n| คอลัมน์ | ชนิด | จำเป็น | คำอธิบาย |\n| --- | --- | --- | --- |\n';
    t.fields.filter((f) => BASE_NAMES.indexOf(f.name) < 0 || (t.technical && f.name !== 'id')).forEach((f) => {
      out += `| \`${f.name}\` | ${typeCell(f)} | ${f.req ? '✓' : ''} | ${(f.d || '').replace(/\|/g, '\\|')}${f.def !== undefined && f.def !== '' ? ` (ค่าเริ่มต้น \`${f.def}\`)` : ''}${f.secret ? ' **ข้อมูลลับ**' : ''} |\n`;
    });
    out += '\n';
  });
});

const target = path.join(__dirname, '..', 'docs', '02-data-model.md');
fs.writeFileSync(target, out);
console.log('wrote ' + path.relative(process.cwd(), target) + ' (' + Schema.names().length + ' tables)');
