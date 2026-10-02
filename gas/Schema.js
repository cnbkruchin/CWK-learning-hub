/**
 * โครงสร้างฐานข้อมูล (แหล่งความจริงเดียว)
 *
 * - แต่ละตาราง = หนึ่งชีต (แท็บ) ในไฟล์ Google Sheets ตามกลุ่ม db
 * - แถวที่ 1 เป็นชื่อคอลัมน์ภาษาอังกฤษ snake_case; ระบบอ่านตำแหน่งคอลัมน์จากแถวหัวตาราง
 *   จึงเพิ่มคอลัมน์ใหม่ต่อท้ายได้โดยไม่ทำให้ข้อมูลเดิมเสีย (ห้ามลบหรือสลับคอลัมน์)
 * - ทุกเซลล์เก็บเป็นข้อความ (plain text) เพื่อรักษาเลขศูนย์นำหน้า ป้องกันการแปลงวันที่อัตโนมัติ
 *   และป้องกันข้อความที่ขึ้นต้นด้วย = + - @ ถูกตีความเป็นสูตร
 * - ไม่ลบแถวจริง (ยกเว้นตารางเทคนิค tx_journal) ใช้สถานะ/เวลาเพิกถอนแทน เพื่อเก็บหลักฐานย้อนหลัง
 * - เอกสาร docs/02-data-model.md สร้างจากไฟล์นี้ด้วย tools/gen-schema-doc.js
 *
 * ชนิดข้อมูล: id, ref, text, code, int, dec, bool, dt (ISO UTC), date (YYYY-MM-DD), json, enum
 * size: small = อ่านทั้งตารางครั้งเดียวต่อคำขอ, large = ค้นทีละคอลัมน์ด้วย TextFinder (ต้องระบุ idx)
 */
var Schema = (function () {
  function F(name, type, opts) {
    var f = { name: name, type: type };
    opts = opts || {};
    for (var k in opts) f[k] = opts[k];
    return f;
  }
  function E(name, values, opts) {
    var o = opts || {};
    o.values = values;
    return F(name, 'enum', o);
  }
  function R(name, table, opts) {
    var o = opts || {};
    o.ref = table;
    return F(name, 'ref', o);
  }
  var BASE = [
    F('id', 'id', { d: 'รหัสภายในที่ไม่เปลี่ยน (UUID) ใช้เชื่อมข้อมูลทุกตาราง' }),
    F('version', 'int', { d: 'เลขรุ่นของแถว ใช้ตรวจการแก้ไขพร้อมกัน (optimistic locking)' }),
    F('created_at', 'dt', { d: 'เวลาเซิร์ฟเวอร์ที่สร้าง (UTC)' }),
    F('created_by', 'ref', { ref: 'users', d: 'ผู้สร้าง' }),
    F('updated_at', 'dt', { d: 'เวลาแก้ไขล่าสุด (UTC)' }),
    F('updated_by', 'ref', { ref: 'users', d: 'ผู้แก้ไขล่าสุด' })
  ];
  var APPEND_BASE = [
    F('id', 'id', { d: 'รหัสภายใน (UUID)' }),
    F('created_at', 'dt', { d: 'เวลาเซิร์ฟเวอร์ที่บันทึก (UTC)' }),
    F('created_by', 'ref', { ref: 'users', d: 'ผู้ทำรายการ' })
  ];
  var PERM = function (name, d) { return F(name, 'bool', { d: d }); };

  var T = {};

  // ===================== core: โรงเรียน บัญชี รายวิชา ทะเบียน =====================
  T.schools = {
    db: 'core', size: 'small', d: 'โรงเรียน (ขอบเขตข้อมูลสูงสุด รองรับขยายหลายโรงเรียนภายหลัง)',
    unique: [['code']],
    fields: [
      F('code', 'code', { req: true, max: 30, d: 'รหัสโรงเรียน' }),
      F('name_th', 'text', { req: true, max: 200, d: 'ชื่อโรงเรียนภาษาไทย (แก้ได้ ไม่ฝังในโค้ด)' }),
      F('name_en', 'text', { max: 200 }),
      F('app_name', 'text', { max: 100, d: 'ชื่อระบบที่แสดง' }),
      R('logo_file_id', 'file_assets', { d: 'ไฟล์ตราโรงเรียน' }),
      F('primary_color', 'text', { max: 20 }),
      F('contact_json', 'json', { d: 'ข้อมูลติดต่อ' }),
      F('timezone', 'text', { max: 50, def: 'Asia/Bangkok' }),
      F('is_demo', 'bool', { d: 'TRUE = ข้อมูลสมมติสำหรับสาธิต' }),
      E('status', ['active', 'inactive'], { def: 'active' })
    ]
  };

  T.settings = {
    db: 'core', size: 'small', d: 'ค่าตั้งระดับโรงเรียน (โควตา ชนิดไฟล์ อายุการเก็บ ฯลฯ)',
    unique: [['school_id', 'key']],
    fields: [
      R('school_id', 'schools', { req: true }),
      F('key', 'text', { req: true, max: 100 }),
      F('value_json', 'json', { d: 'ค่าเป็น JSON' }),
      F('note', 'text', { max: 500 })
    ]
  };

  T.users = {
    db: 'core', size: 'small', d: 'บัญชีผู้ใช้ (ไม่บังคับมีอีเมล ใช้รหัสนักเรียนเป็นชื่อผู้ใช้ได้)',
    unique: [['school_id', 'username']],
    fields: [
      R('school_id', 'schools', { req: true }),
      F('username', 'code', { req: true, max: 100, d: 'ชื่อผู้ใช้ (ตัวพิมพ์เล็ก) เช่น รหัสนักเรียน' }),
      F('display_name', 'text', { max: 200 }),
      F('email', 'text', { max: 200, d: 'ไม่บังคับ (สำรองไว้เชื่อมบัญชี Google ของโรงเรียนในระยะถัดไป)' }),
      F('password_hash', 'text', { max: 300, secret: true, d: 'pbkdf2_sha256$รอบ$salt$hash (ห้ามเก็บรหัสผ่านจริง)' }),
      F('must_change_password', 'bool'),
      E('status', ['active', 'disabled'], { def: 'active' }),
      F('session_epoch', 'int', { def: 0, d: 'เพิ่มค่าเพื่อเพิกถอน session ทั้งหมดของผู้ใช้' }),
      F('failed_login_count', 'int', { def: 0 }),
      F('locked_until', 'dt'),
      F('password_updated_at', 'dt')
    ]
  };

  T.role_assignments = {
    db: 'core', size: 'small', d: 'บทบาทของผู้ใช้ (หนึ่งคนมีได้หลายบทบาท) เพิกถอนโดยใส่ revoked_at ไม่ลบแถว',
    fields: [
      R('school_id', 'schools', { req: true }),
      R('user_id', 'users', { req: true }),
      E('role', ['admin', 'teacher', 'student', 'grade_admin'], { req: true, d: 'grade_admin = ผู้ดูแลที่มีสิทธิ์แก้คะแนน (ต้องมีบันทึก)' }),
      F('revoked_at', 'dt'),
      R('revoked_by', 'users'),
      F('reason', 'text', { max: 500 })
    ]
  };

  T.teachers = {
    db: 'core', size: 'small', d: 'ข้อมูลครู',
    unique: [['school_id', 'teacher_code']],
    fields: [
      R('school_id', 'schools', { req: true }),
      R('user_id', 'users'),
      F('teacher_code', 'code', { req: true, max: 30 }),
      F('prefix', 'text', { max: 30 }),
      F('first_name', 'text', { req: true, max: 100 }),
      F('last_name', 'text', { max: 100 }),
      F('department', 'text', { max: 100, d: 'กลุ่มสาระ' }),
      E('status', ['active', 'inactive'], { def: 'active' })
    ]
  };

  T.students = {
    db: 'core', size: 'small', d: 'ทะเบียนนักเรียน (รหัสนักเรียนเก็บเป็นข้อความเสมอ เช่น 00123)',
    unique: [['school_id', 'student_code']],
    fields: [
      R('school_id', 'schools', { req: true }),
      R('user_id', 'users'),
      F('student_code', 'code', { req: true, max: 30, d: 'รหัสนักเรียน (ข้อความ รักษาศูนย์นำหน้า)' }),
      F('prefix', 'text', { max: 30 }),
      F('first_name', 'text', { req: true, max: 100 }),
      F('last_name', 'text', { max: 100 }),
      F('class_level', 'text', { max: 20, d: 'ชั้น เช่น ม.5' }),
      F('room', 'text', { max: 20, d: 'ห้อง เช่น 1' }),
      F('roll_no', 'int', { d: 'เลขที่' }),
      E('status', ['active', 'graduated', 'transferred', 'withdrawn', 'inactive'], { def: 'active' })
    ]
  };

  T.registration_requests = {
    db: 'core', size: 'small', d: 'คำขอลงทะเบียนใช้งานของนักเรียน (สมัครเอง) รอผู้ดูแลอนุมัติก่อนสร้างบัญชี',
    fields: [
      R('school_id', 'schools', { req: true }),
      F('student_code', 'code', { req: true, max: 30 }),
      F('prefix', 'text', { max: 30 }),
      F('first_name', 'text', { req: true, max: 100 }),
      F('last_name', 'text', { max: 100 }),
      F('class_level', 'text', { max: 20 }),
      F('room', 'text', { max: 20 }),
      F('roll_no', 'int'),
      F('password_hash', 'text', { max: 300, secret: true, d: 'รหัสผ่านที่นักเรียนตั้ง (hash) ย้ายไปบัญชีเมื่ออนุมัติ' }),
      E('status', ['pending', 'approved', 'rejected'], { def: 'pending' }),
      R('student_id', 'students', { d: 'ทะเบียนนักเรียนที่สร้าง/ผูกเมื่ออนุมัติ' }),
      R('decided_by', 'users'),
      F('decided_at', 'dt'),
      F('reason', 'text', { max: 500 })
    ]
  };

  T.academic_years = {
    db: 'core', size: 'small', d: 'ปีการศึกษา (พ.ศ.)',
    unique: [['school_id', 'year_be']],
    fields: [
      R('school_id', 'schools', { req: true }),
      F('year_be', 'int', { req: true, d: 'ปีการศึกษา พ.ศ. เช่น 2569' }),
      F('start_date', 'date'),
      F('end_date', 'date'),
      E('status', ['planning', 'active', 'closed'], { def: 'active' })
    ]
  };

  T.terms = {
    db: 'core', size: 'small', d: 'ภาคเรียน',
    unique: [['academic_year_id', 'term_no']],
    fields: [
      R('school_id', 'schools', { req: true }),
      R('academic_year_id', 'academic_years', { req: true }),
      F('term_no', 'int', { req: true, d: '1, 2 หรือ 3 (ภาคฤดูร้อน)' }),
      F('name', 'text', { max: 50 }),
      F('start_date', 'date'),
      F('end_date', 'date'),
      E('status', ['planning', 'active', 'closed'], { def: 'active' })
    ]
  };

  T.courses = {
    db: 'core', size: 'small', d: 'รายวิชาในหลักสูตร (ไม่ผูกปี/ภาค)',
    unique: [['school_id', 'course_code']],
    fields: [
      R('school_id', 'schools', { req: true }),
      F('course_code', 'code', { req: true, max: 30, d: 'รหัสวิชา เช่น ว32201' }),
      F('name_th', 'text', { req: true, max: 200 }),
      F('name_en', 'text', { max: 200 }),
      F('learning_area', 'text', { max: 100, d: 'กลุ่มสาระการเรียนรู้' }),
      F('grade_level', 'text', { max: 20 }),
      F('description', 'text', { max: 5000 }),
      F('credits', 'dec', { d: 'หน่วยกิต' }),
      F('hours', 'int', { d: 'ชั่วโมงเรียน' }),
      E('status', ['active', 'inactive'], { def: 'active' })
    ]
  };

  T.course_offerings = {
    db: 'core', size: 'small', d: 'รายวิชาที่เปิดสอน = วิชา + ปี + ภาค + กลุ่มเรียน (คะแนนไม่ข้ามภาคหรือปนห้อง)',
    unique: [['term_id', 'course_id', 'section_code']],
    fields: [
      R('school_id', 'schools', { req: true }),
      R('course_id', 'courses', { req: true }),
      R('term_id', 'terms', { req: true }),
      F('section_code', 'code', { req: true, max: 30, d: 'กลุ่มเรียน เช่น ม.5/1' }),
      F('display_name', 'text', { max: 200 }),
      R('owner_teacher_id', 'teachers', { req: true, d: 'ครูเจ้าของรายวิชา' }),
      E('status', ['draft', 'open', 'closed', 'archived'], { def: 'draft' }),
      E('calc_method', ['per_item', 'per_category'], { def: 'per_item', d: 'วิธีคำนวณ: น้ำหนักรายรายการ / รายหมวด' }),
      R('active_policy_version_id', 'grading_policy_versions'),
      R('copied_from_offering_id', 'course_offerings'),
      F('drive_folder_id', 'text', { max: 100, d: 'โฟลเดอร์ไฟล์จริงบน Drive (สร้างอัตโนมัติ)' }),
      F('quota_mb', 'int', { d: 'โควตาไฟล์ของรายวิชา (0 = ใช้ของโรงเรียน)' }),
      F('closed_at', 'dt'),
      R('closed_by', 'users'),
      F('join_code', 'code', { max: 20, d: 'รหัสเข้าร่วมรายวิชา ให้นักเรียนลงทะเบียนเรียนเอง (ว่าง = ไม่เปิด)' }),
      F('join_enabled', 'bool', { def: false, d: 'เปิดให้นักเรียนลงทะเบียนเรียนเองด้วยรหัสเข้าร่วม' }),
      F('group_max_size', 'int', { def: 0, d: 'จำนวนสมาชิกสูงสุดของกลุ่มประจำรายวิชา (0 = ไม่จำกัด)' }),
      F('leader_direct_add', 'bool', { def: false, d: 'หัวหน้ากลุ่มเพิ่มสมาชิกได้ทันที (ค่าเริ่มต้น: ส่งคำเชิญให้สมาชิกตอบรับ)' }),
      F('groups_locked', 'bool', { def: false, d: 'ครูล็อกกลุ่มประจำรายวิชา นักเรียนเปลี่ยนสมาชิกไม่ได้' })
    ]
  };

  T.teaching_assignments = {
    db: 'core', size: 'small', d: 'ครูที่สอนรายวิชาที่เปิดสอน พร้อมสิทธิ์แยกรายการ',
    fields: [
      R('school_id', 'schools', { req: true }),
      R('offering_id', 'course_offerings', { req: true }),
      R('teacher_id', 'teachers', { req: true }),
      E('role', ['owner', 'co_teacher'], { req: true }),
      PERM('can_view', 'ดูข้อมูลรายวิชาและงาน'),
      PERM('can_grade', 'ตรวจงาน/ให้คะแนน'),
      PERM('can_edit_scores', 'แก้คะแนนที่บันทึกแล้ว'),
      PERM('can_import', 'นำเข้าข้อมูล/คะแนน'),
      PERM('can_export', 'ส่งออกรายงาน'),
      PERM('can_publish', 'ประกาศ/เรียกคืนคะแนน'),
      PERM('can_close', 'ปิดผลรายวิชา'),
      PERM('can_manage', 'จัดการงาน กลุ่ม และนักเรียนในรายวิชา'),
      F('revoked_at', 'dt'),
      R('revoked_by', 'users')
    ]
  };

  T.enrollments = {
    db: 'core', size: 'large', idx: ['offering_id', 'student_id'],
    d: 'การลงทะเบียนเรียน (นักเรียน × รายวิชาที่เปิดสอน) พร้อมวันมีผล',
    unique: [['offering_id', 'student_id']],
    fields: [
      R('school_id', 'schools', { req: true }),
      R('offering_id', 'course_offerings', { req: true }),
      R('student_id', 'students', { req: true }),
      E('status', ['active', 'withdrawn', 'transferred_out', 'completed'], { def: 'active' }),
      F('effective_from', 'dt', { d: 'วันเวลามีผลของการลงทะเบียน' }),
      F('effective_to', 'dt', { d: 'วันเวลาสิ้นสุด (ถอน/ย้าย/จบ)' }),
      F('source', 'text', { max: 100, d: 'manual หรือ import:<import_job_id>' }),
      F('reason', 'text', { max: 500 })
    ]
  };

  T.enrollment_history = {
    db: 'core', size: 'large', idx: ['enrollment_id'], appendOnly: true, lockFree: true,
    d: 'ประวัติการเพิ่ม ย้าย ถอน จบ ของการลงทะเบียน',
    fields: [
      R('enrollment_id', 'enrollments', { req: true }),
      E('action', ['enroll', 'withdraw', 'transfer_out', 'complete', 'reactivate'], { req: true }),
      F('from_status', 'text', { max: 30 }),
      F('to_status', 'text', { max: 30 }),
      F('effective_at', 'dt'),
      F('reason', 'text', { max: 500 })
    ]
  };

  // ===================== plan: แผนคะแนนและภาระงาน =====================
  T.grading_policy_versions = {
    db: 'plan', size: 'small', d: 'รุ่นนโยบายคะแนนของรายวิชา (เปลี่ยนหลังเริ่มให้คะแนน = สร้างรุ่นใหม่)',
    unique: [['offering_id', 'version_no']],
    fields: [
      R('offering_id', 'course_offerings', { req: true }),
      F('version_no', 'int', { req: true }),
      E('calc_method', ['per_item', 'per_category'], { req: true }),
      F('rounding_digits', 'int', { def: 2 }),
      E('rounding_mode', ['half_up'], { def: 'half_up', d: 'ปัดครั้งเดียวตอนสรุป' }),
      F('pass_threshold', 'dec', { d: 'เกณฑ์ผ่าน (ร้อยละ)' }),
      F('late_penalty_json', 'json', { d: 'กฎหักคะแนนส่งช้า (ปิดเป็นค่าเริ่มต้น)' }),
      F('special_status_json', 'json', { d: 'สถานะพิเศษ เช่น ร มส มผ ที่โรงเรียนกำหนด' }),
      E('retake_rule', ['none', 'latest', 'highest', 'cap'], { def: 'none' }),
      E('status', ['draft', 'active', 'superseded'], { def: 'draft' }),
      F('change_reason', 'text', { max: 1000 }),
      F('activated_at', 'dt'),
      R('activated_by', 'users')
    ]
  };

  T.grade_bands = {
    db: 'plan', size: 'small', d: 'ช่วงเกรดของรุ่นนโยบาย (min รวม, max ไม่รวม ยกเว้นช่วงบนสุด)',
    fields: [
      R('policy_version_id', 'grading_policy_versions', { req: true }),
      F('min_score', 'dec', { req: true }),
      F('max_score', 'dec', { req: true }),
      F('grade_label', 'text', { req: true, max: 10 }),
      F('grade_point', 'dec'),
      F('sort', 'int')
    ]
  };

  T.score_categories = {
    db: 'plan', size: 'small', d: 'หมวดคะแนนที่ครูสร้างเอง',
    fields: [
      R('offering_id', 'course_offerings', { req: true }),
      R('policy_version_id', 'grading_policy_versions', { req: true }),
      F('name', 'text', { req: true, max: 100 }),
      F('weight', 'dec', { d: 'น้ำหนักหมวด (วิธีรายหมวด หมวดรวม 100)' }),
      E('inner_weight_mode', ['equal', 'by_max', 'custom'], { def: 'equal' }),
      F('sort', 'int')
    ]
  };

  T.assessments = {
    db: 'plan', size: 'small', d: 'รายการประเมิน/ภาระงาน (งานเดี่ยว งานกลุ่ม สอบ หรือรับคะแนนอย่างเดียว)',
    unique: [['offering_id', 'code']],
    fields: [
      R('offering_id', 'course_offerings', { req: true }),
      R('category_id', 'score_categories'),
      F('code', 'code', { req: true, max: 30, d: 'รหัสรายการ ใช้จับคู่ตอนนำเข้าคะแนน' }),
      F('title', 'text', { req: true, max: 200 }),
      F('description', 'text', { max: 10000 }),
      E('kind', ['individual', 'group', 'exam', 'score_only'], { req: true }),
      E('submission_mode', ['none', 'file', 'file_or_link'], { def: 'file' }),
      F('max_score', 'dec', { req: true, d: 'คะแนนเต็ม' }),
      F('weight', 'dec', { d: 'น้ำหนักในรายวิชา (วิธีรายรายการ)' }),
      F('inner_weight', 'dec', { d: 'น้ำหนักภายในหมวด (โหมด custom)' }),
      F('counts_toward_grade', 'bool', { def: true }),
      F('open_at', 'dt', { d: 'เปิดรับ' }),
      F('due_at', 'dt', { d: 'กำหนดส่ง' }),
      F('close_at', 'dt', { d: 'ปิดรับ (หลังกำหนดส่งได้ถ้าอนุญาตส่งช้า)' }),
      F('allow_late', 'bool', { def: false }),
      F('allowed_types', 'text', { max: 300, d: 'ชุดย่อยชนิดไฟล์ เช่น pdf,jpg,png (ว่าง = ตามโรงเรียน)' }),
      F('max_files', 'int', { d: 'จำนวนไฟล์ต่อการส่ง (ไม่เกินเพดานโรงเรียน)' }),
      F('max_file_mb', 'int', { d: 'ขนาดต่อไฟล์ MB (ไม่เกินเพดานโรงเรียน)' }),
      F('max_attempts', 'int', { def: 0, d: '0 = ไม่จำกัดจำนวนครั้ง' }),
      F('allow_links', 'bool', { def: false }),
      E('group_submit_policy', ['any_member', 'leader_only'], { def: 'any_member' }),
      F('attachments_json', 'json', { d: 'ไฟล์แนบของครู (file_asset_id)' }),
      E('status', ['draft', 'published', 'archived'], { def: 'draft' }),
      F('sort', 'int')
    ]
  };

  T.rubrics = {
    db: 'plan', size: 'small', d: 'รูบริกของรายการประเมิน',
    fields: [
      R('assessment_id', 'assessments', { req: true }),
      F('title', 'text', { max: 200 })
    ]
  };

  T.rubric_criteria = {
    db: 'plan', size: 'small', d: 'เกณฑ์ย่อยของรูบริก',
    fields: [
      R('rubric_id', 'rubrics', { req: true }),
      F('title', 'text', { req: true, max: 200 }),
      F('description', 'text', { max: 2000 }),
      F('max_points', 'dec', { req: true }),
      F('sort', 'int')
    ]
  };

  T.assessment_extensions = {
    db: 'plan', size: 'small', d: 'การขยายเวลารายบุคคลหรือรายกลุ่ม',
    fields: [
      R('assessment_id', 'assessments', { req: true }),
      E('target_type', ['student', 'group'], { req: true }),
      F('target_id', 'ref', { req: true, d: 'students.id หรือ groups.id' }),
      F('due_at', 'dt'),
      F('close_at', 'dt'),
      F('reason', 'text', { max: 500 }),
      F('revoked_at', 'dt')
    ]
  };

  // ===================== work: กลุ่มและการส่งงาน / files: ไฟล์ =====================
  T.assignment_group_sets = {
    db: 'work', size: 'small', d: 'กติกาการจัดกลุ่มของงานกลุ่ม (กลุ่มแยกตามงานเป็นค่าเริ่มต้น)',
    unique: [['assessment_id']],
    fields: [
      R('offering_id', 'course_offerings', { req: true }),
      R('assessment_id', 'assessments', { req: true }),
      F('min_size', 'int', { req: true }),
      F('max_size', 'int', { req: true }),
      F('formation_close_at', 'dt', { d: 'วันปิดจัดกลุ่ม (ตรึงรายชื่ออัตโนมัติ)' }),
      F('require_approval', 'bool', { def: false }),
      F('section_restricted', 'bool', { def: true, d: 'สมาชิกต้องอยู่กลุ่มเรียนเดียวกัน' }),
      R('copied_from_set_id', 'assignment_group_sets'),
      F('all_frozen_at', 'dt', { d: 'เวลาที่ตรึงทุกกลุ่มเมื่อถึงวันปิดจัดกลุ่ม' }),
      E('source', ['self', 'work_groups'], { def: 'self', d: 'self = จัดกลุ่มเฉพาะงานนี้, work_groups = ใช้กลุ่มประจำรายวิชา (กลุ่มเดิมทำได้หลายงาน)' })
    ]
  };

  T.work_groups = {
    db: 'work', size: 'large', idx: ['offering_id'],
    d: 'กลุ่มประจำรายวิชา (กลุ่มเดิมทำงานกลุ่มได้หลายงาน คะแนนแต่ละงานเก็บที่กลุ่มของงานนั้น)',
    fields: [
      R('offering_id', 'course_offerings', { req: true }),
      F('name', 'text', { req: true, max: 100 }),
      R('leader_student_id', 'students', { d: 'หัวหน้ากลุ่ม (เลือกสมาชิกเข้ากลุ่มได้)' }),
      E('status', ['active', 'disbanded'], { def: 'active' }),
      F('active_count', 'int', { def: 0 }),
      F('note', 'text', { max: 500 })
    ]
  };

  T.work_group_members = {
    db: 'work', size: 'large', idx: ['work_group_id', 'offering_id', 'student_id'],
    d: 'สมาชิกกลุ่มประจำรายวิชาและคำเชิญ (หนึ่งคน active ได้หนึ่งกลุ่มต่อรายวิชา)',
    fields: [
      R('work_group_id', 'work_groups', { req: true }),
      R('offering_id', 'course_offerings', { req: true }),
      R('student_id', 'students', { req: true }),
      E('status', ['invited', 'active', 'declined', 'left', 'removed', 'cancelled'], { req: true }),
      R('added_by_user_id', 'users'),
      F('responded_at', 'dt')
    ]
  };

  T.work_group_history = {
    db: 'work', size: 'large', idx: ['work_group_id'], appendOnly: true, lockFree: true,
    d: 'ประวัติการเปลี่ยนแปลงกลุ่มประจำรายวิชา',
    fields: [
      R('work_group_id', 'work_groups', { req: true }),
      R('student_id', 'students'),
      F('action', 'text', { req: true, max: 40, d: 'create rename invite accept decline add remove leave leader disband' }),
      F('reason', 'text', { max: 500 }),
      F('detail_json', 'json')
    ]
  };

  T.groups = {
    db: 'work', size: 'large', idx: ['group_set_id', 'assessment_id'], d: 'กลุ่มของงาน',
    fields: [
      R('group_set_id', 'assignment_group_sets', { req: true }),
      R('assessment_id', 'assessments', { req: true }),
      R('offering_id', 'course_offerings', { req: true }),
      F('name', 'text', { req: true, max: 100 }),
      R('leader_student_id', 'students'),
      E('status', ['forming', 'pending_approval', 'approved', 'frozen', 'disbanded'], { def: 'forming' }),
      F('active_count', 'int', { def: 0, d: 'จำนวนสมาชิกปัจจุบัน (ตรวจภายใต้ล็อก)' }),
      F('size_exception', 'bool', { def: false, d: 'ครูอนุมัติข้อยกเว้นจำนวนสมาชิก' }),
      F('size_exception_reason', 'text', { max: 500 }),
      F('frozen_at', 'dt'),
      E('frozen_reason', ['', 'first_submission', 'formation_closed', 'teacher'], { def: '' }),
      F('snapshot_no', 'int', { def: 0, d: 'รุ่น snapshot สมาชิกปัจจุบัน' }),
      R('work_group_id', 'work_groups', { d: 'กลุ่มประจำรายวิชาที่เป็นต้นทาง (เมื่องานใช้กลุ่มประจำรายวิชา)' })
    ]
  };

  T.group_memberships = {
    db: 'work', size: 'large', idx: ['group_set_id', 'group_id', 'student_id'],
    d: 'สมาชิกกลุ่มปัจจุบันและคำเชิญ (หนึ่งคน active ได้หนึ่งกลุ่มต่องาน)',
    fields: [
      R('group_set_id', 'assignment_group_sets', { req: true }),
      R('group_id', 'groups', { req: true }),
      R('student_id', 'students', { req: true }),
      E('status', ['invited', 'requested', 'active', 'declined', 'left', 'removed', 'cancelled'], { req: true }),
      R('invited_by_user_id', 'users'),
      F('responded_at', 'dt')
    ]
  };

  T.group_membership_history = {
    db: 'work', size: 'large', idx: ['group_id'], appendOnly: true, lockFree: true,
    d: 'ประวัติการเปลี่ยนสมาชิกกลุ่ม',
    fields: [
      R('group_set_id', 'assignment_group_sets'),
      R('group_id', 'groups', { req: true }),
      R('student_id', 'students'),
      F('action', 'text', { req: true, max: 40, d: 'create invite accept decline request approve leave remove move_in move_out freeze approve_group' }),
      F('reason', 'text', { max: 500 }),
      F('detail_json', 'json')
    ]
  };

  T.assignment_member_snapshots = {
    db: 'work', size: 'large', idx: ['assessment_id', 'group_id'],
    d: 'รายชื่อสมาชิกที่ตรึงของงานกลุ่ม (snapshot) ใช้กระจายคะแนนและสิทธิ์ดูไฟล์',
    fields: [
      R('assessment_id', 'assessments', { req: true }),
      R('group_id', 'groups', { req: true }),
      F('snapshot_no', 'int', { req: true }),
      R('student_id', 'students', { req: true }),
      R('enrollment_id', 'enrollments'),
      E('trigger', ['first_submission', 'formation_closed', 'teacher'], { req: true }),
      F('is_current', 'bool', { def: true }),
      F('reason', 'text', { max: 500 })
    ]
  };

  T.submissions = {
    db: 'work', size: 'large', idx: ['assessment_id', 'owner_id'],
    d: 'การส่งงาน (หนึ่งแถวต่อ งาน × เจ้าของ ซึ่งเป็นนักเรียนหรือกลุ่ม)',
    unique: [['assessment_id', 'owner_type', 'owner_id']],
    fields: [
      R('assessment_id', 'assessments', { req: true }),
      R('offering_id', 'course_offerings', { req: true }),
      E('owner_type', ['student', 'group'], { req: true }),
      F('owner_id', 'ref', { req: true, d: 'students.id หรือ groups.id' }),
      E('status', ['draft', 'submitted', 'resubmitted', 'returned', 'accepted'], { def: 'draft', d: 'สถานะการส่ง/ตรวจ (สถานะคะแนนแยกไว้ที่ student_grades)' }),
      F('current_version_no', 'int', { def: 0 }),
      R('latest_version_id', 'submission_versions'),
      R('accepted_version_id', 'submission_versions', { d: 'รุ่นที่ครูเลือกรับประเมิน' }),
      F('first_submitted_at', 'dt'),
      F('last_submitted_at', 'dt')
    ]
  };

  T.submission_versions = {
    db: 'work', size: 'large', idx: ['submission_id', 'assessment_id', 'receipt_code'],
    d: 'รุ่นการส่ง (ส่งซ้ำ = รุ่นใหม่ รุ่นเดิมไม่ถูกลบ)',
    unique: [['submission_id', 'version_no'], ['receipt_code']],
    fields: [
      R('submission_id', 'submissions', { req: true }),
      R('assessment_id', 'assessments', { req: true }),
      F('version_no', 'int', { req: true }),
      R('submitted_by_user_id', 'users', { req: true }),
      R('submitted_by_student_id', 'students'),
      F('submitted_at', 'dt', { req: true, d: 'เวลาเซิร์ฟเวอร์' }),
      F('due_at_effective', 'dt', { d: 'กำหนดส่งที่ใช้ (รวมการขยายเวลา)' }),
      F('is_late', 'bool'),
      F('late_seconds', 'int'),
      F('comment', 'text', { max: 5000 }),
      F('links_json', 'json'),
      F('file_count', 'int'),
      F('total_bytes', 'int'),
      F('receipt_code', 'code', { req: true, max: 40, d: 'รหัสใบยืนยันการส่ง' }),
      F('member_snapshot_no', 'int', { d: 'snapshot สมาชิกกลุ่ม ณ เวลาส่ง' }),
      E('review_status', ['pending', 'returned', 'accepted', 'superseded'], { def: 'pending' }),
      F('review_note', 'text', { max: 5000 }),
      R('reviewed_by', 'users'),
      F('reviewed_at', 'dt')
    ]
  };

  T.submission_files = {
    db: 'files', size: 'large', idx: ['submission_id', 'submission_version_id', 'file_asset_id'],
    d: 'ไฟล์ในฉบับร่างหรือในรุ่นที่ส่ง (อ้างอิง file_assets ไม่คัดลอกไฟล์ซ้ำ)',
    fields: [
      R('submission_id', 'submissions', { req: true }),
      R('submission_version_id', 'submission_versions', { d: 'ว่าง = อยู่ในฉบับร่าง' }),
      R('file_asset_id', 'file_assets', { req: true }),
      R('added_by_user_id', 'users'),
      E('state', ['draft', 'submitted', 'removed'], { req: true }),
      F('sort', 'int')
    ]
  };

  T.file_assets = {
    db: 'files', size: 'large', idx: ['drive_file_id', 'state'],
    d: 'metadata ของไฟล์ทุกไฟล์ (ไฟล์จริงอยู่ใน Google Drive โฟลเดอร์ส่วนตัวของระบบ)',
    fields: [
      R('school_id', 'schools', { req: true }),
      F('drive_file_id', 'text', { max: 100, d: 'รหัสไฟล์บน Drive (ตัวเชื่อมถาวร ไม่ขึ้นกับชื่อ/โฟลเดอร์)' }),
      F('storage_name', 'text', { max: 200, d: 'ชื่อไฟล์จริงที่เก็บ = <id>.<ext> (แยกจากชื่อที่นักเรียนตั้ง)' }),
      F('original_name', 'text', { max: 255, d: 'ชื่อเดิมจากผู้อัปโหลด (ผ่านการกรองอักขระ)' }),
      F('extension', 'text', { max: 20 }),
      F('declared_mime', 'text', { max: 100, d: 'Content-Type จากเบราว์เซอร์ (ไม่เชื่อถือ)' }),
      F('detected_type', 'text', { max: 30, d: 'ชนิดจริงจากการตรวจ magic bytes/โครงสร้างไฟล์' }),
      F('size_bytes', 'int'),
      F('sha256', 'text', { max: 64 }),
      F('md5', 'text', { max: 32 }),
      R('uploaded_by_user_id', 'users'),
      E('purpose', ['submission', 'feedback', 'attachment', 'import', 'export', 'logo', 'snapshot'], { req: true }),
      R('offering_id', 'course_offerings'),
      R('assessment_id', 'assessments'),
      E('state', ['staging', 'stored', 'quarantined', 'trashed', 'purged'], { req: true }),
      E('check_status', ['pending', 'passed', 'rejected'], { def: 'pending' }),
      F('check_detail', 'text', { max: 1000 }),
      F('retention_until', 'dt'),
      F('trashed_at', 'dt')
    ]
  };

  // ===================== grades: คะแนนและการประกาศ =====================
  T.student_grades = {
    db: 'grades', size: 'large', idx: ['offering_id', 'assessment_id', 'student_id'],
    d: 'คะแนนปัจจุบันหนึ่งผลต่อ (การลงทะเบียน × รายการประเมิน) ประวัติอยู่ที่ grade_revisions',
    unique: [['enrollment_id', 'assessment_id']],
    fields: [
      R('offering_id', 'course_offerings', { req: true }),
      R('assessment_id', 'assessments', { req: true }),
      R('enrollment_id', 'enrollments', { req: true }),
      R('student_id', 'students', { req: true }),
      E('status', ['not_assessed', 'scored', 'missing', 'excused', 'needs_revision'], { def: 'not_assessed' }),
      F('raw_score', 'dec', { d: 'คะแนนดิบ 0..คะแนนเต็ม (ว่าง ≠ ศูนย์)' }),
      F('late_penalty', 'dec'),
      F('final_score', 'dec', { d: 'คะแนนหลังหักส่งช้า (ถ้ามี)' }),
      E('source', ['', 'teacher', 'group', 'import', 'rubric'], { def: '' }),
      F('source_ref', 'text', { max: 100 }),
      R('group_grade_id', 'group_grades'),
      F('is_override', 'bool', { d: 'ครูปรับคะแนนรายคนจากคะแนนกลุ่ม' }),
      F('override_reason', 'text', { max: 1000 }),
      F('excuse_reason', 'text', { max: 1000 }),
      R('graded_version_id', 'submission_versions'),
      E('publication', ['draft', 'published'], { def: 'draft' }),
      F('published_status', 'text', { max: 30, d: 'สถานะที่นักเรียนเห็น (ค่าที่ประกาศล่าสุด)' }),
      F('published_score', 'dec', { d: 'คะแนนที่นักเรียนเห็น (ค่าที่ประกาศล่าสุด)' }),
      F('published_at', 'dt')
    ]
  };

  T.group_grades = {
    db: 'grades', size: 'large', idx: ['assessment_id', 'group_id'], d: 'คะแนนกลุ่มตั้งต้น (ไม่หารจำนวนสมาชิก)',
    unique: [['assessment_id', 'group_id']],
    fields: [
      R('assessment_id', 'assessments', { req: true }),
      R('group_id', 'groups', { req: true }),
      F('snapshot_no', 'int'),
      R('submission_version_id', 'submission_versions'),
      F('raw_score', 'dec'),
      E('status', ['not_assessed', 'scored', 'missing', 'excused', 'needs_revision'], { def: 'not_assessed' }),
      F('note', 'text', { max: 2000 })
    ]
  };

  T.grade_revisions = {
    db: 'grades', size: 'large', idx: ['student_grade_id'], appendOnly: true,
    d: 'ประวัติการเปลี่ยนคะแนนทุกครั้ง (ค่าก่อน/หลัง ที่มา เหตุผล ผู้แก้)',
    fields: [
      R('student_grade_id', 'student_grades', { req: true }),
      F('revision_no', 'int', { req: true }),
      F('from_status', 'text', { max: 30 }),
      F('from_score', 'dec'),
      F('to_status', 'text', { max: 30 }),
      F('to_score', 'dec'),
      F('source', 'text', { max: 30 }),
      F('source_ref', 'text', { max: 100, d: 'import_job_id / group_grade_id / submission_version_id' }),
      F('reason', 'text', { max: 1000 })
    ]
  };

  T.feedback = {
    db: 'grades', size: 'large', idx: ['submission_version_id', 'student_grade_id'], d: 'ข้อเสนอแนะรายคน/รายกลุ่ม',
    fields: [
      R('student_grade_id', 'student_grades'),
      R('submission_version_id', 'submission_versions'),
      R('author_user_id', 'users'),
      F('body', 'text', { max: 10000 }),
      F('rubric_scores_json', 'json'),
      F('file_asset_ids', 'json'),
      E('publication', ['draft', 'published'], { def: 'draft' })
    ]
  };

  T.grade_publications = {
    db: 'grades', size: 'large', idx: ['offering_id'], appendOnly: true, lockFree: true,
    d: 'ประวัติการประกาศและเรียกคืนคะแนน',
    fields: [
      R('offering_id', 'course_offerings', { req: true }),
      R('assessment_id', 'assessments'),
      E('action', ['publish', 'unpublish'], { req: true }),
      F('student_count', 'int'),
      F('reason', 'text', { max: 1000 })
    ]
  };

  T.final_result_snapshots = {
    db: 'grades', size: 'small', d: 'ผลปิดรายวิชาแต่ละรุ่น (ข้อมูลเต็มเก็บเป็นไฟล์ JSON ใน Drive พร้อม checksum)',
    unique: [['offering_id', 'snapshot_no']],
    fields: [
      R('offering_id', 'course_offerings', { req: true }),
      F('snapshot_no', 'int', { req: true }),
      R('policy_version_id', 'grading_policy_versions'),
      R('data_file_id', 'file_assets'),
      F('data_sha256', 'text', { max: 64 }),
      F('summary_json', 'json'),
      E('status', ['current', 'superseded'], { def: 'current' }),
      F('reopen_reason', 'text', { max: 1000 })
    ]
  };

  // ===================== system: งานเบื้องหลัง แจ้งเตือน บันทึก =====================
  T.import_jobs = {
    db: 'system', size: 'small', d: 'ชุดนำเข้าข้อมูล',
    fields: [
      R('school_id', 'schools', { req: true }),
      E('kind', ['students', 'teachers', 'courses', 'enrollments', 'scores'], { req: true }),
      R('offering_id', 'course_offerings'),
      R('source_file_id', 'file_assets'),
      F('source_sha256', 'text', { max: 64, d: 'ป้องกันนำเข้าไฟล์เดิมซ้ำ' }),
      F('mapping_json', 'json'),
      E('status', ['uploaded', 'validated', 'committed', 'failed', 'rolled_back'], { req: true }),
      F('counts_json', 'json'),
      F('committed_at', 'dt')
    ]
  };

  T.import_row_results = {
    db: 'system', size: 'large', idx: ['import_job_id'], appendOnly: true, lockFree: true,
    d: 'ผลตรวจรายแถวของการนำเข้า',
    fields: [
      R('import_job_id', 'import_jobs', { req: true }),
      F('row_no', 'int'),
      E('result', ['insert', 'update', 'skip', 'error'], { req: true }),
      F('message', 'text', { max: 1000 }),
      F('before_json', 'json'),
      F('after_json', 'json')
    ]
  };

  T.export_jobs = {
    db: 'system', size: 'small', d: 'งานส่งออกรายงาน (ไฟล์ผลลัพธ์หมดอายุตามเวลา)',
    fields: [
      R('school_id', 'schools', { req: true }),
      E('kind', ['gradebook_pdf', 'gradebook_xlsx', 'summary_pdf', 'student_pdf', 'pending_pdf', 'group_pdf', 'csv'], { req: true }),
      F('params_json', 'json'),
      E('status', ['queued', 'running', 'done', 'failed'], { req: true }),
      R('result_file_id', 'file_assets'),
      F('expires_at', 'dt'),
      F('error', 'text', { max: 1000 })
    ]
  };

  T.notifications = {
    db: 'system', size: 'large', idx: ['user_id'], d: 'แจ้งเตือนในระบบ (ไม่ใส่คะแนนในข้อความ)',
    fields: [
      R('user_id', 'users', { req: true }),
      F('type', 'text', { req: true, max: 40 }),
      F('title', 'text', { max: 200 }),
      F('body', 'text', { max: 1000 }),
      F('link', 'text', { max: 300 }),
      F('read_at', 'dt')
    ]
  };

  T.audit_log = {
    db: 'system', size: 'large', idx: ['entity_id'], appendOnly: true, lockFree: true,
    d: 'บันทึกตรวจสอบ (ห้ามใส่รหัสผ่าน โทเคน หรือลิงก์ที่มีสิทธิ์เข้าถึง)',
    fields: [
      F('actor_role', 'text', { max: 30 }),
      F('action', 'text', { req: true, max: 60 }),
      F('entity', 'text', { max: 60 }),
      F('entity_id', 'text', { max: 64 }),
      R('offering_id', 'course_offerings'),
      F('detail_json', 'json'),
      F('reason', 'text', { max: 1000 }),
      F('request_id', 'text', { max: 64 })
    ]
  };

  T.idempotency_keys = {
    db: 'system', size: 'large', idx: ['key'], appendOnly: true,
    d: 'ป้องกันคำสั่งซ้ำ (กดส่งซ้ำ/เน็ตหลุดแล้วส่งใหม่)',
    fields: [
      F('key', 'text', { req: true, max: 100 }),
      R('user_id', 'users'),
      F('action', 'text', { max: 60 }),
      F('result_json', 'json'),
      F('expires_at', 'dt')
    ]
  };

  T.tx_journal = {
    db: 'system', size: 'large', idx: ['tx_id'], technical: true,
    d: 'บันทึกธุรกรรม (ภาพก่อนแก้) สำหรับย้อนกลับเมื่อเขียนไม่ครบ — ตารางเทคนิค ลบแถวเก่าได้',
    fields: [
      F('tx_id', 'text', { req: true, max: 64 }),
      F('seq', 'int'),
      E('status', ['pending', 'committed', 'rolled_back'], { req: true }),
      F('name', 'text', { max: 100 }),
      F('payload', 'text', { max: 45000 }),
      F('created_at', 'dt')
    ]
  };

  // ประกอบฟิลด์มาตรฐาน
  Object.keys(T).forEach(function (name) {
    var t = T[name];
    t.name = name;
    if (t.technical) {
      t.fields = [F('id', 'id')].concat(t.fields);
    } else if (t.appendOnly) {
      t.fields = APPEND_BASE.concat(t.fields);
    } else {
      t.fields = BASE.concat(t.fields);
    }
    t.fieldMap = {};
    t.fields.forEach(function (f) { t.fieldMap[f.name] = f; });
    t.idx = t.idx || [];
    t.unique = t.unique || [];
    if (t.size === 'large' && t.idx.indexOf('id') < 0) t.idx = ['id'].concat(t.idx);
  });

  return {
    tables: T,
    get: function (name) {
      var t = T[name];
      if (!t) throw new Error('Unknown table: ' + name);
      return t;
    },
    names: function () { return Object.keys(T); },
    byDb: function (db) {
      return Object.keys(T).filter(function (n) { return T[n].db === db; });
    }
  };
})();
