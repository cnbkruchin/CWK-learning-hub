/**
 * ข้อมูลสมมติสำหรับระบบสาธิต (ไม่ใช่นักเรียนจริง)
 * รันได้เฉพาะโปรเจกต์ที่ตั้ง ENV=demo เพื่อแยกจากระบบใช้งานจริงอย่างชัดเจน
 * รหัสผ่านบัญชีทดสอบสุ่มใหม่ทุกครั้งและแสดงใน log ของ editor เท่านั้น
 */
var Seed = {
  run: function () {
    var p = PropertiesService.getScriptProperties();
    if (p.getProperty('ENV') !== 'demo') throw new Error('seedDemo ใช้ได้เฉพาะโปรเจกต์สาธิต (ENV=demo)');
    var school = Db.all('schools')[0];
    if (!school || !school.is_demo) throw new Error('ไม่พบโรงเรียนสาธิต');
    if (Db.all('students').length) throw new Error('มีข้อมูลสาธิตแล้ว');
    var accounts = [];
    function account(tx, username, display, role) {
      var pw = Setup.tempPassword();
      var u = tx.insert('users', {
        school_id: school.id, username: username, display_name: display,
        password_hash: Auth.hashPassword(pw), must_change_password: false, status: 'active', session_epoch: 0
      });
      tx.insert('role_assignments', { school_id: school.id, user_id: u.id, role: role });
      accounts.push({ role: role, username: username, password: pw });
      return u;
    }
    var now = Util.now();
    var day = 86400000;
    var iso = function (offsetDays) { return new Date(now.getTime() + offsetDays * day).toISOString(); };

    Db.tx('seed.demo', function (tx) {
      var year = tx.insert('academic_years', { school_id: school.id, year_be: 2569, start_date: '2026-05-16', end_date: '2027-03-31', status: 'active' });
      var term = tx.insert('terms', { school_id: school.id, academic_year_id: year.id, term_no: 1, name: 'ภาคเรียนที่ 1', start_date: '2026-05-16', end_date: '2026-10-10', status: 'active' });

      var teachers = [
        ['T001', 'นาง', 'สมศรี', 'ใจดี', 'วิทยาศาสตร์และเทคโนโลยี'],
        ['T002', 'นาย', 'ประเสริฐ', 'ตั้งใจสอน', 'วิทยาศาสตร์และเทคโนโลยี'],
        ['T003', 'นางสาว', 'วิภา', 'รักเรียน', 'คณิตศาสตร์']
      ].map(function (t) {
        var u = account(tx, 'demo_' + t[0].toLowerCase(), t[1] + t[2] + ' ' + t[3], 'teacher');
        return tx.insert('teachers', { school_id: school.id, user_id: u.id, teacher_code: t[0], prefix: t[1], first_name: t[2], last_name: t[3], department: t[4], status: 'active' });
      });

      var courses = [
        ['ว32201', 'วิทยาการคำนวณ', 'วิทยาศาสตร์และเทคโนโลยี'],
        ['ว32281', 'การออกแบบและเทคโนโลยี', 'วิทยาศาสตร์และเทคโนโลยี'],
        ['ค32101', 'คณิตศาสตร์พื้นฐาน', 'คณิตศาสตร์']
      ].map(function (c) {
        return tx.insert('courses', { school_id: school.id, course_code: c[0], name_th: c[1], learning_area: c[2], grade_level: 'ม.5', credits: '1', hours: 40, status: 'active' });
      });

      var offerings = [
        [courses[0], 'ม.5/1', teachers[0]],
        [courses[1], 'ม.5/2', teachers[1]],
        [courses[2], 'ม.5/1', teachers[2]]
      ].map(function (o) {
        var off = tx.insert('course_offerings', {
          school_id: school.id, course_id: o[0].id, term_id: term.id, section_code: o[1],
          display_name: o[0].name_th + ' ' + o[1], owner_teacher_id: o[2].id, status: 'open', calc_method: 'per_item'
        });
        tx.insert('teaching_assignments', {
          school_id: school.id, offering_id: off.id, teacher_id: o[2].id, role: 'owner',
          can_view: true, can_grade: true, can_edit_scores: true, can_import: true, can_export: true, can_publish: true, can_close: true, can_manage: true
        });
        var pol = tx.insert('grading_policy_versions', { offering_id: off.id, version_no: 1, calc_method: 'per_item', rounding_digits: 2, rounding_mode: 'half_up', status: 'active', activated_at: tx.now });
        Grading.DEFAULT_BANDS.forEach(function (b, i) {
          tx.insert('grade_bands', { policy_version_id: pol.id, min_score: b.min, max_score: b.max, grade_label: b.label, grade_point: b.point, sort: i + 1 });
        });
        tx.update('course_offerings', off.id, { active_policy_version_id: pol.id });
        return off;
      });
      // ครูร่วมสอนที่ตรวจงานได้แต่แก้คะแนน/ปิดผลไม่ได้
      tx.insert('teaching_assignments', {
        school_id: school.id, offering_id: offerings[0].id, teacher_id: teachers[1].id, role: 'co_teacher',
        can_view: true, can_grade: true, can_edit_scores: false, can_import: false, can_export: true, can_publish: false, can_close: false, can_manage: false
      });

      var first = ['กิตติ', 'ขวัญใจ', 'คณิน', 'จิราพร', 'ชยพล', 'ณัฐธิดา', 'ธนกร', 'นภัสสร', 'ปภาวิน', 'พิมพ์ชนก', 'ภูมิพัฒน์', 'วรรณวิสา'];
      var students = first.map(function (name, i) {
        var code = ('00' + (121 + i)).slice(-5);
        var room = i < 6 ? '1' : '2';
        var male = i % 2 === 0;
        var u = account(tx, code, name + ' ทดสอบ', 'student');
        return tx.insert('students', {
          school_id: school.id, user_id: u.id, student_code: code, prefix: male ? 'นาย' : 'นางสาว', first_name: name,
          last_name: 'ทดสอบ' + (i + 1), class_level: 'ม.5', room: room, roll_no: (i % 6) + 1, status: 'active'
        });
      });
      function enroll(off, list) {
        list.forEach(function (s) {
          tx.insert('enrollments', { school_id: school.id, offering_id: off.id, student_id: s.id, status: 'active', effective_from: tx.now, source: 'seed' });
        });
      }
      enroll(offerings[0], students.slice(0, 8));
      enroll(offerings[1], students.slice(4, 12));
      enroll(offerings[2], students);

      var off = offerings[0];
      tx.insert('assessments', {
        offering_id: off.id, code: 'W1', title: 'ใบงานที่ 1 ผังงานและรหัสเทียม', description: 'เขียนผังงานของโจทย์ในใบงาน ส่งเป็น PDF หรือรูปถ่ายที่ชัดเจน',
        kind: 'individual', submission_mode: 'file', max_score: '20', weight: '30', counts_toward_grade: true,
        open_at: iso(-3), due_at: iso(7), close_at: iso(10), allow_late: true, allowed_types: 'pdf,jpg,jpeg,png,docx',
        max_files: 5, max_file_mb: 25, max_attempts: 0, group_submit_policy: 'any_member', status: 'published', sort: 1
      });
      var g1 = tx.insert('assessments', {
        offering_id: off.id, code: 'G1', title: 'โครงงานกลุ่ม: แอปพลิเคชันช่วยเรียน', description: 'กลุ่มละ 2–3 คน ส่งเอกสารโครงงานและสไลด์นำเสนอ',
        kind: 'group', submission_mode: 'file_or_link', allow_links: true, max_score: '20', weight: '20', counts_toward_grade: true,
        open_at: iso(-3), due_at: iso(14), close_at: iso(14), allow_late: false, allowed_types: 'pdf,pptx,docx,jpg,png',
        max_files: 10, max_file_mb: 25, max_attempts: 0, group_submit_policy: 'any_member', status: 'published', sort: 2
      });
      tx.insert('assignment_group_sets', { offering_id: off.id, assessment_id: g1.id, min_size: 2, max_size: 3, formation_close_at: iso(7), require_approval: false, section_restricted: true });
      tx.insert('assessments', {
        offering_id: off.id, code: 'EX1', title: 'สอบกลางภาค', kind: 'exam', submission_mode: 'none', max_score: '50', weight: '50',
        counts_toward_grade: true, due_at: iso(20), status: 'published', sort: 3
      });

      // กลุ่มประจำรายวิชา (กลุ่มเดิมทำงานกลุ่มได้หลายงาน) และงานกลุ่มที่ใช้กลุ่มประจำรายวิชา (ไม่นับคะแนน เป็นตัวอย่าง)
      [['ทีมอัลฟา', students.slice(0, 3)], ['ทีมเบต้า', students.slice(3, 6)]].forEach(function (w) {
        var wg = tx.insert('work_groups', { offering_id: off.id, name: w[0], leader_student_id: w[1][0].id, status: 'active', active_count: w[1].length });
        w[1].forEach(function (st) {
          tx.insert('work_group_members', { work_group_id: wg.id, offering_id: off.id, student_id: st.id, status: 'active', responded_at: tx.now });
        });
      });
      var gp = tx.insert('assessments', {
        offering_id: off.id, code: 'GP1', title: 'รายงานกลุ่ม: สำรวจการใช้เทคโนโลยีในชุมชน', description: 'ใช้กลุ่มประจำรายวิชา ส่งรายงานกลุ่มละ 1 ฉบับ',
        kind: 'group', submission_mode: 'file', max_score: '10', weight: '0', counts_toward_grade: false,
        open_at: iso(-1), due_at: iso(21), close_at: iso(21), allow_late: false, allowed_types: 'pdf,docx',
        max_files: 5, max_file_mb: 25, max_attempts: 0, group_submit_policy: 'any_member', status: 'published', sort: 4
      });
      tx.insert('assignment_group_sets', { offering_id: off.id, assessment_id: gp.id, min_size: 1, max_size: 5, require_approval: false, section_restricted: true, source: 'work_groups' });
      WorkGroups.syncOffering(tx, off.id, null, null);
    });
    return { accounts: accounts };
  }
};
