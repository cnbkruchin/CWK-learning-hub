/**
 * ทะเบียนนักเรียน ครู และบัญชีผู้ใช้ (ผู้ดูแลระบบ) + การสมัครใช้งานของนักเรียน
 *
 * - ผู้ดูแลเพิ่มนักเรียนทีละคนหรือเป็นชุด (วางข้อความจาก Excel/CSV/TSV) พร้อมสร้างบัญชีให้อัตโนมัติ
 *   ชื่อผู้ใช้ = รหัสนักเรียน รหัสผ่านชั่วคราวแสดงครั้งเดียวและต้องเปลี่ยนเมื่อเข้าใช้ครั้งแรก
 * - รหัสนักเรียนเก็บเป็นข้อความเสมอ (00123 ไม่หาย) นำเข้าซ้ำไม่สร้างซ้ำ ค่าว่างในไฟล์ไม่ลบข้อมูลเดิม
 * - นักเรียนสมัครใช้งานเองได้เมื่อผู้ดูแลเปิด (และใส่รหัสลงทะเบียนถ้าตั้งไว้) คำขอต้องรอผู้ดูแลอนุมัติก่อนสร้างบัญชี
 * - ครูดูรายชื่อนักเรียนได้เฉพาะข้อมูลที่จำเป็น (รหัส ชื่อ ชั้น ห้อง) เพื่อเลือกเข้ารายวิชาหรือกลุ่ม
 */
var Registry = {
  CODE_RE: /^[0-9A-Za-z._-]{1,30}$/,
  PREFIXES: ['เด็กชาย', 'เด็กหญิง', 'นางสาว', 'นาย', 'นาง', 'ด.ช.', 'ด.ญ.', 'น.ส.'],
  STUDENT_STATUS: ['active', 'graduated', 'transferred', 'withdrawn', 'inactive'],

  personName: function (p) {
    return p ? [p.prefix, p.first_name, p.last_name].join(' ').replace(/\s+/g, ' ').trim() : '';
  },

  requireStaff: function (ctx) {
    if (!ctx || (!ctx.roles.admin && !ctx.teacher)) Errors.raise('FORBIDDEN');
  },

  /** เรียงตามชั้น ห้อง เลขที่ รหัส (ตัวเลขเรียงแบบตัวเลข) */
  compareStudents: function (a, b) {
    var opt = { numeric: true };
    return String(a.class_level || '').localeCompare(String(b.class_level || ''), 'th', opt) ||
      String(a.room || '').localeCompare(String(b.room || ''), 'th', opt) ||
      (Number(a.roll_no || 0) - Number(b.roll_no || 0)) ||
      String(a.student_code).localeCompare(String(b.student_code), 'th', opt);
  },

  roomLabel: function (classLevel, room) {
    if (!classLevel && !room) return 'ไม่ระบุห้อง';
    return (classLevel || '') + (room ? '/' + room : '');
  },

  studentDto: function (s, withAccount) {
    var dto = {
      id: s.id, code: s.student_code, prefix: s.prefix, firstName: s.first_name, lastName: s.last_name,
      name: Registry.personName(s), classLevel: s.class_level, room: s.room, rollNo: s.roll_no,
      roomLabel: Registry.roomLabel(s.class_level, s.room), status: s.status, version: s.version
    };
    if (withAccount) {
      var u = s.user_id ? Db.get('users', s.user_id) : null;
      dto.userId = u ? u.id : '';
      dto.username = u ? u.username : '';
      dto.accountStatus = u ? u.status : '';
      dto.mustChangePassword = u ? !!u.must_change_password : false;
    }
    return dto;
  },

  /** ห้องเรียนที่มีในทะเบียน (สำหรับตัวกรองและรายงานรายห้อง) */
  rooms: function (students) {
    var m = {};
    students.forEach(function (s) {
      if (s.status !== 'active') return;
      var key = (s.class_level || '') + '|' + (s.room || '');
      m[key] = m[key] || { classLevel: s.class_level || '', room: s.room || '', label: Registry.roomLabel(s.class_level, s.room), count: 0 };
      m[key].count++;
    });
    return Object.keys(m).map(function (k) { return m[k]; }).sort(function (a, b) {
      return a.classLevel.localeCompare(b.classLevel, 'th', { numeric: true }) || a.room.localeCompare(b.room, 'th', { numeric: true });
    });
  },

  listStudents: function (ctx, req) {
    Registry.requireStaff(ctx);
    req = req || {};
    var q = Util.str(req.q, 100).toLowerCase();
    var all = Db.all('students').filter(function (s) { return s.school_id === ctx.schoolId; });
    var list = all.filter(function (s) {
      if (req.classLevel && String(s.class_level) !== String(req.classLevel)) return false;
      if (req.room && String(s.room) !== String(req.room)) return false;
      if (req.status && s.status !== req.status) return false;
      if (q && (String(s.student_code).toLowerCase().indexOf(q) < 0 && Registry.personName(s).toLowerCase().indexOf(q) < 0)) return false;
      return true;
    }).sort(Registry.compareStudents);
    var admin = !!ctx.roles.admin;
    return {
      students: list.map(function (s) {
        var d = Registry.studentDto(s, admin);
        if (!admin) return Util.pick(d, ['id', 'code', 'name', 'classLevel', 'room', 'rollNo', 'roomLabel', 'status']);
        return d;
      }),
      rooms: Registry.rooms(all),
      total: all.length
    };
  },

  _cleanStudent: function (req) {
    var code = Util.requireStr(req.studentCode, 'รหัสนักเรียน', 30);
    if (!Registry.CODE_RE.test(code)) Errors.raise('VALIDATION', 'รหัสนักเรียนใช้ได้เฉพาะตัวเลข ตัวอักษรอังกฤษ . _ - (ไม่เกิน 30 ตัว)');
    var roll = req.rollNo === undefined || req.rollNo === null || String(req.rollNo).trim() === '' ? '' : Number(req.rollNo);
    if (roll !== '' && (!(roll >= 0) || roll > 9999 || Math.floor(roll) !== roll)) Errors.raise('VALIDATION', 'เลขที่ต้องเป็นจำนวนเต็ม');
    var status = req.status || 'active';
    if (Registry.STUDENT_STATUS.indexOf(status) < 0) Errors.raise('VALIDATION', 'สถานะนักเรียนไม่ถูกต้อง');
    return {
      student_code: code,
      prefix: Util.str(req.prefix, 30, 'คำนำหน้า'),
      first_name: Util.requireStr(req.firstName, 'ชื่อ', 100),
      last_name: Util.str(req.lastName, 100, 'นามสกุล'),
      class_level: Util.str(req.classLevel, 20, 'ชั้น'),
      room: Util.str(req.room, 20, 'ห้อง'),
      roll_no: roll,
      status: status
    };
  },

  /** เตรียมรหัสผ่านชั่วคราว (hash นอกธุรกรรมเพื่อไม่ถือล็อกนาน) */
  _tempCredential: function () {
    var pw = Setup.tempPassword();
    return { password: pw, hash: Auth.hashPassword(pw, APP.TEMP_PASSWORD_ITERATIONS) };
  },

  /** สร้างบัญชีผู้ใช้ภายในธุรกรรม */
  _insertUser: function (tx, schoolId, username, displayName, role, cred, mustChange) {
    username = Auth.normalizeUsername(username);
    if (tx.find('users', { username: username }).some(function (u) { return u.school_id === schoolId; })) {
      Errors.raise('DUPLICATE', 'ชื่อผู้ใช้ ' + username + ' มีในระบบแล้ว');
    }
    var u = tx.insert('users', {
      school_id: schoolId, username: username, display_name: displayName, password_hash: cred.hash,
      must_change_password: mustChange !== false, status: 'active', session_epoch: 0
    });
    tx.insert('role_assignments', { school_id: schoolId, user_id: u.id, role: role });
    return u;
  },

  saveStudent: function (ctx, req) {
    Authz.requireAdmin(ctx);
    var data = Registry._cleanStudent(req);
    var wantAccount = !req.id && req.createAccount !== false;
    var cred = wantAccount ? Registry._tempCredential() : null;
    var touchedUser = '';
    var out = Db.tx('registry.saveStudent', function (tx) {
      var s, account = null;
      if (req.id) {
        var cur = tx.get('students', req.id);
        if (!cur || cur.school_id !== ctx.schoolId) Errors.raise('NOT_FOUND');
        var oldCode = cur.student_code;
        s = tx.update('students', cur.id, data, { expectedVersion: req.version });
        if (s.user_id) {
          var u = tx.get('users', s.user_id);
          var patch = { display_name: Registry.personName(s) };
          if (oldCode !== data.student_code && u.username === Auth.normalizeUsername(oldCode)) {
            var uname = Auth.normalizeUsername(data.student_code);
            if (tx.find('users', { username: uname }).some(function (x) { return x.school_id === ctx.schoolId && x.id !== u.id; })) {
              Errors.raise('DUPLICATE', 'ชื่อผู้ใช้ ' + uname + ' มีในระบบแล้ว');
            }
            patch.username = uname;
          }
          tx.update('users', u.id, patch);
          touchedUser = u.id;
        }
      } else {
        data.school_id = ctx.schoolId;
        s = tx.insert('students', data);
        if (wantAccount) {
          var nu = Registry._insertUser(tx, ctx.schoolId, data.student_code, Registry.personName(s), 'student', cred);
          tx.update('students', s.id, { user_id: nu.id });
          account = { username: nu.username, tempPassword: cred.password };
        }
      }
      tx.afterCommit(function () {
        if (touchedUser) Auth.invalidateUser(touchedUser);
        Audit.log(ctx, req.id ? 'student.update' : 'student.create', 'students', s.id, { code: s.student_code, account: !!account });
      });
      return { student: Registry.studentDto(s, true), account: account };
    }, { actorId: ctx.user.id });
    return out;
  },

  /** สร้างบัญชีให้นักเรียนที่มีในทะเบียนแต่ยังไม่มีบัญชี */
  createStudentAccount: function (ctx, req) {
    Authz.requireAdmin(ctx);
    var cred = Registry._tempCredential();
    return Db.tx('registry.createAccount', function (tx) {
      var s = tx.get('students', req.studentId);
      if (!s || s.school_id !== ctx.schoolId) Errors.raise('NOT_FOUND');
      if (s.user_id) Errors.raise('DUPLICATE', 'นักเรียนคนนี้มีบัญชีแล้ว ใช้ "รีเซ็ตรหัสผ่าน" แทน');
      var u = Registry._insertUser(tx, ctx.schoolId, s.student_code, Registry.personName(s), 'student', cred);
      tx.update('students', s.id, { user_id: u.id });
      tx.afterCommit(function () { Audit.log(ctx, 'student.account', 'students', s.id, { username: u.username }); });
      return { username: u.username, tempPassword: cred.password };
    }, { actorId: ctx.user.id });
  },

  // ---------------------------------------------------------------- นำเข้าเป็นชุด
  HEADER_ALIASES: {
    student_code: ['student_code', 'code', 'id', 'student_id', 'รหัสนักเรียน', 'รหัส', 'เลขประจำตัว', 'เลขประจำตัวนักเรียน'],
    prefix: ['prefix', 'title', 'คำนำหน้า', 'คำนำหน้าชื่อ'],
    first_name: ['first_name', 'firstname', 'ชื่อ'],
    last_name: ['last_name', 'lastname', 'surname', 'นามสกุล', 'สกุล'],
    full_name: ['full_name', 'name', 'ชื่อ-สกุล', 'ชื่อ-นามสกุล', 'ชื่อ - นามสกุล', 'ชื่อสกุล', 'ชื่อ นามสกุล'],
    class_level: ['class_level', 'class', 'grade', 'ชั้น', 'ระดับชั้น', 'ชั้นเรียน'],
    room: ['room', 'ห้อง'],
    roll_no: ['roll_no', 'no', 'number', 'เลขที่']
  },

  /** แยกตาราง CSV/TSV (รองรับเครื่องหมายคำพูด, CRLF, UTF-8 BOM) */
  parseTable: function (text) {
    text = String(text || '').replace(/^﻿/, '');
    var first = text.split(/\r?\n/)[0] || '';
    var delim = first.indexOf('\t') >= 0 ? '\t' : (first.split(';').length > first.split(',').length ? ';' : ',');
    var rows = [], row = [], field = '', inQ = false;
    for (var i = 0; i < text.length; i++) {
      var c = text.charAt(i);
      if (inQ) {
        if (c === '"') {
          if (text.charAt(i + 1) === '"') { field += '"'; i++; } else inQ = false;
        } else field += c;
      } else if (c === '"' && field === '') {
        inQ = true;
      } else if (c === delim) {
        row.push(field); field = '';
      } else if (c === '\n' || c === '\r') {
        if (c === '\r' && text.charAt(i + 1) === '\n') i++;
        row.push(field); rows.push(row); row = []; field = '';
      } else field += c;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    rows = rows.filter(function (r) { return r.some(function (v) { return String(v).trim() !== ''; }); });
    return { delimiter: delim, rows: rows };
  },

  _mapHeader: function (header) {
    var map = {};
    header.forEach(function (h, i) {
      var key = String(h || '').trim().toLowerCase().replace(/\s+/g, ' ');
      Object.keys(Registry.HEADER_ALIASES).forEach(function (f) {
        if (map[f] === undefined && Registry.HEADER_ALIASES[f].indexOf(key) >= 0) map[f] = i;
      });
    });
    return map;
  },

  _splitName: function (full) {
    var s = String(full || '').trim().replace(/\s+/g, ' ');
    var prefix = '';
    Registry.PREFIXES.some(function (p) {
      if (s.indexOf(p) === 0) { prefix = p; s = s.slice(p.length).trim(); return true; }
      return false;
    });
    var i = s.indexOf(' ');
    return { prefix: prefix, first: i < 0 ? s : s.slice(0, i), last: i < 0 ? '' : s.slice(i + 1) };
  },

  /** แปลงแถวจากไฟล์เป็นข้อมูลนักเรียน (ค่าว่าง = ไม่เปลี่ยนข้อมูลเดิม) */
  _rowToStudent: function (map, r) {
    var get = function (f) { return map[f] === undefined ? '' : String(r[map[f]] === undefined ? '' : r[map[f]]).trim(); };
    var out = {
      studentCode: get('student_code'), prefix: get('prefix'), firstName: get('first_name'), lastName: get('last_name'),
      classLevel: get('class_level'), room: get('room'), rollNo: get('roll_no')
    };
    if (!out.firstName && get('full_name')) {
      var n = Registry._splitName(get('full_name'));
      out.firstName = n.first; out.lastName = out.lastName || n.last; out.prefix = out.prefix || n.prefix;
    }
    // "ม.5/1" ในคอลัมน์ชั้นเดียว → ชั้น ม.5 ห้อง 1
    if (out.classLevel.indexOf('/') > 0 && !out.room) {
      var parts = out.classLevel.split('/');
      out.classLevel = parts[0].trim(); out.room = parts.slice(1).join('/').trim();
    }
    return out;
  },

  importStudents: function (ctx, req) {
    Authz.requireAdmin(ctx);
    var parsed = Registry.parseTable(req.text);
    if (parsed.rows.length < 2) Errors.raise('VALIDATION', 'ไม่พบข้อมูล (แถวแรกต้องเป็นหัวตาราง เช่น รหัสนักเรียน, คำนำหน้า, ชื่อ, นามสกุล, ชั้น, ห้อง, เลขที่)');
    var map = Registry._mapHeader(parsed.rows[0]);
    if (map.student_code === undefined) Errors.raise('VALIDATION', 'ไม่พบคอลัมน์รหัสนักเรียน (student_code หรือ รหัสนักเรียน)');
    if (map.first_name === undefined && map.full_name === undefined) Errors.raise('VALIDATION', 'ไม่พบคอลัมน์ชื่อ (first_name หรือ ชื่อ หรือ ชื่อ-นามสกุล)');
    var body = parsed.rows.slice(1);
    if (body.length > APP.IMPORT_MAX_ROWS) Errors.raise('VALIDATION', 'นำเข้าได้ครั้งละไม่เกิน ' + APP.IMPORT_MAX_ROWS + ' แถว กรุณาแบ่งไฟล์');
    var existing = Util.indexBy(Db.all('students').filter(function (s) { return s.school_id === ctx.schoolId; }), 'student_code');
    var seen = {};
    var fields = ['prefix', 'first_name', 'last_name', 'class_level', 'room', 'roll_no'];
    var rows = body.map(function (r, i) {
      var rowNo = i + 2;
      var src = Registry._rowToStudent(map, r);
      var res = { rowNo: rowNo, code: src.studentCode, name: [src.prefix, src.firstName, src.lastName].join(' ').trim(), room: Registry.roomLabel(src.classLevel, src.room) };
      try {
        if (!src.studentCode) Errors.raise('VALIDATION', 'ไม่มีรหัสนักเรียน');
        if (seen[src.studentCode]) Errors.raise('VALIDATION', 'รหัสซ้ำกับแถวที่ ' + seen[src.studentCode]);
        seen[src.studentCode] = rowNo;
        var cur = existing[src.studentCode];
        if (cur) {
          // ค่าว่างในไฟล์ไม่ลบข้อมูลเดิม
          var merged = Registry._cleanStudent({
            studentCode: src.studentCode, prefix: src.prefix || cur.prefix, firstName: src.firstName || cur.first_name,
            lastName: src.lastName || cur.last_name, classLevel: src.classLevel || cur.class_level, room: src.room || cur.room,
            rollNo: src.rollNo !== '' ? src.rollNo : cur.roll_no, status: cur.status
          });
          var changed = fields.filter(function (f) { return String(merged[f] === null ? '' : merged[f]) !== String(cur[f] === null ? '' : cur[f]); });
          res.result = changed.length ? 'update' : 'skip';
          res.message = changed.length ? 'แก้ไข: ' + changed.join(', ') : 'มีอยู่แล้ว ข้อมูลเหมือนเดิม';
          res.data = merged; res.id = cur.id; res.changed = changed;
        } else {
          res.data = Registry._cleanStudent(src);
          res.result = 'insert';
          res.message = 'เพิ่มใหม่';
        }
      } catch (e) {
        if (!Errors.isApp(e)) throw e;
        res.result = 'error'; res.message = e.message;
      }
      return res;
    });
    var counts = { insert: 0, update: 0, skip: 0, error: 0 };
    rows.forEach(function (r) { counts[r.result]++; });
    var warnings = [];
    var codes = rows.filter(function (r) { return r.result !== 'error'; }).map(function (r) { return r.code; });
    if (codes.length && codes.every(function (c) { return /^\d+$/.test(c); })) {
      var lens = codes.map(function (c) { return c.length; }).filter(function (v, i, a) { return a.indexOf(v) === i; });
      if (lens.length > 1) warnings.push('รหัสนักเรียนยาวไม่เท่ากัน (' + lens.sort().join(', ') + ' หลัก) อาจมีเลขศูนย์นำหน้าหายไปจาก Excel ระบบไม่เติมศูนย์ให้เอง กรุณาตรวจก่อนยืนยัน');
    }
    var mapping = {};
    Object.keys(map).forEach(function (k) { mapping[k] = parsed.rows[0][map[k]]; });
    var preview = {
      counts: counts, warnings: warnings, mapping: mapping, delimiter: parsed.delimiter === '\t' ? 'tab' : parsed.delimiter,
      rows: rows.map(function (r) { return Util.pick(r, ['rowNo', 'code', 'name', 'room', 'result', 'message']); })
    };
    if (!req.commit) return preview;
    if (counts.error && !req.skipErrors) Errors.raise('VALIDATION', 'มีแถวที่ผิด ' + counts.error + ' แถว กรุณาแก้ไขก่อน หรือเลือกนำเข้าเฉพาะแถวที่ถูกต้อง', { counts: counts });
    var createAccounts = req.createAccounts !== false;
    var creds = {};
    if (createAccounts) rows.forEach(function (r) { if (r.result === 'insert') creds[r.code] = Registry._tempCredential(); });
    var userIds = [];
    var result = Db.tx('registry.import', function (tx) {
      var accounts = [];
      rows.forEach(function (r) {
        if (r.result === 'insert') {
          var d = r.data; d.school_id = ctx.schoolId;
          var s = tx.insert('students', d);
          if (createAccounts) {
            var u = Registry._insertUser(tx, ctx.schoolId, s.student_code, Registry.personName(s), 'student', creds[r.code]);
            tx.update('students', s.id, { user_id: u.id });
            accounts.push({ code: s.student_code, name: Registry.personName(s), room: Registry.roomLabel(s.class_level, s.room), username: u.username, tempPassword: creds[r.code].password });
          }
        } else if (r.result === 'update') {
          var cur = tx.get('students', r.id);
          var patch = {};
          r.changed.forEach(function (f) { patch[f] = r.data[f]; });
          var st = tx.update('students', cur.id, patch);
          if (st.user_id) { tx.update('users', st.user_id, { display_name: Registry.personName(st) }); userIds.push(st.user_id); }
        }
      });
      var job = tx.insert('import_jobs', {
        school_id: ctx.schoolId, kind: 'students', status: 'committed', committed_at: tx.now,
        mapping_json: mapping, counts_json: { counts: counts, skippedErrorRows: rows.filter(function (r) { return r.result === 'error'; }).map(function (r) { return r.rowNo; }) }
      });
      tx.afterCommit(function () {
        userIds.forEach(Auth.invalidateUser);
        Audit.log(ctx, 'student.import', 'import_jobs', job.id, { counts: counts, accounts: accounts.length });
      });
      return { importJobId: job.id, counts: counts, accounts: accounts, skippedRows: rows.filter(function (r) { return r.result === 'error'; }).map(function (r) { return Util.pick(r, ['rowNo', 'code', 'message']); }) };
    }, { actorId: ctx.user.id });
    return result;
  },

  // ---------------------------------------------------------------- ครูและบทบาท
  teacherDto: function (t, withAccount) {
    var d = { id: t.id, code: t.teacher_code, prefix: t.prefix, firstName: t.first_name, lastName: t.last_name, name: Registry.personName(t), department: t.department, status: t.status, version: t.version };
    if (withAccount) {
      var u = t.user_id ? Db.get('users', t.user_id) : null;
      d.userId = u ? u.id : ''; d.username = u ? u.username : ''; d.accountStatus = u ? u.status : '';
      d.roles = u ? Db.find('role_assignments', { user_id: u.id }).filter(function (r) { return !r.revoked_at; }).map(function (r) { return r.role; }) : [];
    }
    return d;
  },

  listTeachers: function (ctx) {
    Registry.requireStaff(ctx);
    var admin = !!ctx.roles.admin;
    return Db.all('teachers').filter(function (t) { return t.school_id === ctx.schoolId; })
      .sort(function (a, b) { return String(a.teacher_code).localeCompare(String(b.teacher_code), 'th', { numeric: true }); })
      .map(function (t) { var d = Registry.teacherDto(t, admin); return admin ? d : Util.pick(d, ['id', 'code', 'name', 'department', 'status']); });
  },

  saveTeacher: function (ctx, req) {
    Authz.requireAdmin(ctx);
    var code = Util.requireStr(req.teacherCode, 'รหัสครู', 30);
    if (!Registry.CODE_RE.test(code)) Errors.raise('VALIDATION', 'รหัสครูใช้ได้เฉพาะตัวเลข ตัวอักษรอังกฤษ . _ -');
    var data = {
      teacher_code: code, prefix: Util.str(req.prefix, 30), first_name: Util.requireStr(req.firstName, 'ชื่อ', 100),
      last_name: Util.str(req.lastName, 100), department: Util.str(req.department, 100, 'กลุ่มสาระ'),
      status: req.status === 'inactive' ? 'inactive' : 'active'
    };
    var username = req.id ? '' : Auth.normalizeUsername(req.username || code);
    if (!req.id && !/^[a-z0-9._-]{3,100}$/.test(username)) Errors.raise('VALIDATION', 'ชื่อผู้ใช้ใช้ได้เฉพาะ a-z 0-9 . _ - อย่างน้อย 3 ตัว');
    var cred = !req.id && req.createAccount !== false ? Registry._tempCredential() : null;
    var touched = '';
    return Db.tx('registry.saveTeacher', function (tx) {
      var t, account = null;
      if (req.id) {
        var cur = tx.get('teachers', req.id);
        if (!cur || cur.school_id !== ctx.schoolId) Errors.raise('NOT_FOUND');
        t = tx.update('teachers', cur.id, data, { expectedVersion: req.version });
        if (t.user_id) { tx.update('users', t.user_id, { display_name: Registry.personName(t) }); touched = t.user_id; }
      } else {
        data.school_id = ctx.schoolId;
        t = tx.insert('teachers', data);
        if (cred) {
          var u = Registry._insertUser(tx, ctx.schoolId, username, Registry.personName(t), 'teacher', cred);
          tx.update('teachers', t.id, { user_id: u.id });
          account = { username: u.username, tempPassword: cred.password };
        }
      }
      tx.afterCommit(function () {
        if (touched) Auth.invalidateUser(touched);
        Audit.log(ctx, req.id ? 'teacher.update' : 'teacher.create', 'teachers', t.id, { code: t.teacher_code });
      });
      return { teacher: Registry.teacherDto(t, true), account: account };
    }, { actorId: ctx.user.id });
  },

  /** ให้/เพิกถอนบทบาทพิเศษ: admin หรือ grade_admin (สิทธิ์แก้คะแนนของผู้ดูแล ต้องมีบันทึก) */
  setRole: function (ctx, req) {
    Authz.requireAdmin(ctx);
    var role = req.role;
    if (['admin', 'grade_admin'].indexOf(role) < 0) Errors.raise('VALIDATION', 'กำหนดได้เฉพาะบทบาทผู้ดูแลระบบหรือผู้ดูแลคะแนน');
    if (req.userId === ctx.user.id && role === 'admin' && !req.grant) Errors.raise('VALIDATION', 'เพิกถอนสิทธิ์ผู้ดูแลของตนเองไม่ได้');
    var reason = Util.str(req.reason, 500);
    Db.tx('registry.setRole', function (tx) {
      var u = tx.get('users', req.userId);
      if (!u || u.school_id !== ctx.schoolId) Errors.raise('NOT_FOUND');
      var current = tx.find('role_assignments', { user_id: u.id }).filter(function (r) { return r.role === role && !r.revoked_at; });
      if (req.grant && !current.length) tx.insert('role_assignments', { school_id: ctx.schoolId, user_id: u.id, role: role, reason: reason });
      if (!req.grant) current.forEach(function (r) { tx.update('role_assignments', r.id, { revoked_at: tx.now, revoked_by: ctx.user.id, reason: reason }); });
    }, { actorId: ctx.user.id });
    Auth.invalidateUser(req.userId);
    Audit.log(ctx, req.grant ? 'role.grant' : 'role.revoke', 'users', req.userId, { role: role }, reason);
    return true;
  },

  /** ผู้ใช้ที่ไม่ใช่ครู/นักเรียน (เช่น ผู้ดูแล) สำหรับหน้าจัดการบทบาท */
  listStaffUsers: function (ctx) {
    Authz.requireAdmin(ctx);
    var roles = Util.groupBy(Db.all('role_assignments').filter(function (r) { return r.school_id === ctx.schoolId && !r.revoked_at; }), 'user_id');
    return Db.all('users').filter(function (u) {
      return u.school_id === ctx.schoolId && (roles[u.id] || []).some(function (r) { return r.role === 'admin' || r.role === 'grade_admin'; });
    }).map(function (u) {
      return { userId: u.id, username: u.username, displayName: u.display_name, status: u.status, roles: (roles[u.id] || []).map(function (r) { return r.role; }) };
    });
  },

  // ---------------------------------------------------------------- นักเรียนสมัครใช้งานเอง
  _school: function (schoolCode) {
    var schools = Db.all('schools');
    if (schoolCode) return schools.filter(function (s) { return s.code === schoolCode; })[0] || null;
    return schools[0] || null;
  },

  registrationInfo: function (p) {
    var school = Registry._school(p && p.schoolCode);
    if (!school) return { enabled: false };
    var st = Settings.get(school.id);
    return { enabled: !!st.self_registration_enabled, needsCode: !!st.self_registration_code, schoolName: school.name_th };
  },

  register: function (p) {
    var school = Registry._school(p.schoolCode);
    if (!school) Errors.raise('REGISTRATION_CLOSED');
    var st = Settings.get(school.id);
    if (!st.self_registration_enabled) Errors.raise('REGISTRATION_CLOSED');
    if (st.self_registration_code && !Crypto.safeEqual(String(p.registrationCode || '').trim(), String(st.self_registration_code))) {
      Errors.raise('VALIDATION', 'รหัสลงทะเบียนไม่ถูกต้อง (ขอรหัสจากครูหรือผู้ดูแลระบบ)');
    }
    var data = Registry._cleanStudent(p);
    Auth.checkStrength(p.password, data.student_code);
    var cache = CacheService.getScriptCache();
    var hourKey = 'reg:' + Math.floor(Date.now() / 3600000);
    var perCode = 'regc:' + data.student_code;
    if (Number(cache.get(hourKey) || 0) >= 200 || Number(cache.get(perCode) || 0) >= 5) Errors.raise('BUSY', 'มีคำขอลงทะเบียนจำนวนมาก กรุณาลองใหม่ภายหลัง');
    cache.put(hourKey, String(Number(cache.get(hourKey) || 0) + 1), 3600);
    cache.put(perCode, String(Number(cache.get(perCode) || 0) + 1), 3600);
    var hash = Auth.hashPassword(p.password);
    var req = Db.tx('registry.register', function (tx) {
      var s = tx.find('students', { student_code: data.student_code }).filter(function (x) { return x.school_id === school.id; })[0];
      if (s && s.user_id) Errors.raise('DUPLICATE', 'รหัสนักเรียนนี้มีบัญชีอยู่แล้ว หากลืมรหัสผ่านกรุณาติดต่อครูหรือผู้ดูแลระบบ');
      var pending = tx.find('registration_requests', { student_code: data.student_code }).filter(function (r) { return r.school_id === school.id && r.status === 'pending'; });
      if (pending.length) Errors.raise('DUPLICATE', 'มีคำขอลงทะเบียนของรหัสนี้รอการอนุมัติอยู่แล้ว');
      return tx.insert('registration_requests', Object.assign({ school_id: school.id, password_hash: hash, status: 'pending' }, Util.pick(data, ['student_code', 'prefix', 'first_name', 'last_name', 'class_level', 'room', 'roll_no'])));
    });
    Audit.log({ primaryRole: 'anonymous' }, 'registration.request', 'registration_requests', req.id, { code: data.student_code });
    var admins = Db.all('role_assignments').filter(function (r) { return r.school_id === school.id && r.role === 'admin' && !r.revoked_at; }).map(function (r) { return r.user_id; });
    Notify.sendMany(admins, 'registration', 'มีคำขอลงทะเบียนนักเรียนใหม่', 'รหัส ' + data.student_code + ' รอการอนุมัติ', 'registrations');
    return { status: 'pending', message: 'ส่งคำขอแล้ว กรุณารอผู้ดูแลอนุมัติ จากนั้นเข้าสู่ระบบด้วยรหัสนักเรียนและรหัสผ่านที่ตั้งไว้' };
  },

  listRegistrations: function (ctx, req) {
    Authz.requireAdmin(ctx);
    var status = (req && req.status) || 'pending';
    var students = Util.indexBy(Db.all('students').filter(function (s) { return s.school_id === ctx.schoolId; }), 'student_code');
    return Db.all('registration_requests').filter(function (r) { return r.school_id === ctx.schoolId && (status === 'all' || r.status === status); })
      .sort(function (a, b) { return a.created_at < b.created_at ? 1 : -1; })
      .map(function (r) {
        var ex = students[r.student_code];
        return {
          id: r.id, version: r.version, code: r.student_code, name: Registry.personName(r), classLevel: r.class_level, room: r.room, rollNo: r.roll_no,
          roomLabel: Registry.roomLabel(r.class_level, r.room), status: r.status, createdAt: r.created_at, reason: r.reason,
          existing: ex ? { name: Registry.personName(ex), roomLabel: Registry.roomLabel(ex.class_level, ex.room), hasAccount: !!ex.user_id } : null
        };
      });
  },

  /**
   * อนุมัติ/ปฏิเสธคำขอ
   * อนุมัติ: ถ้ามีทะเบียนรหัสนี้อยู่แล้ว (ผู้ดูแลเพิ่มไว้แต่ยังไม่มีบัญชี) จะผูกบัญชีกับทะเบียนเดิม มิฉะนั้นสร้างทะเบียนใหม่
   */
  decideRegistration: function (ctx, req) {
    Authz.requireAdmin(ctx);
    var reason = Util.str(req.reason, 500);
    var userId = '';
    var out = Db.tx('registry.decide', function (tx) {
      var r = tx.get('registration_requests', req.id);
      if (!r || r.school_id !== ctx.schoolId) Errors.raise('NOT_FOUND');
      if (r.status !== 'pending') Errors.raise('CONFLICT', 'คำขอนี้ถูกพิจารณาแล้ว');
      if (!req.approve) {
        tx.update('registration_requests', r.id, { status: 'rejected', decided_by: ctx.user.id, decided_at: tx.now, reason: reason, password_hash: '' });
        return { status: 'rejected' };
      }
      var s = tx.find('students', { student_code: r.student_code }).filter(function (x) { return x.school_id === ctx.schoolId; })[0];
      if (s && s.user_id) Errors.raise('DUPLICATE', 'รหัสนักเรียนนี้มีบัญชีแล้ว ให้ปฏิเสธคำขอนี้');
      if (!s) {
        s = tx.insert('students', Object.assign({ school_id: ctx.schoolId, status: 'active' }, Util.pick(r, ['student_code', 'prefix', 'first_name', 'last_name', 'class_level', 'room', 'roll_no'])));
      }
      var u = Registry._insertUser(tx, ctx.schoolId, s.student_code, Registry.personName(s), 'student', { hash: r.password_hash }, false);
      tx.update('students', s.id, { user_id: u.id });
      tx.update('registration_requests', r.id, { status: 'approved', student_id: s.id, decided_by: ctx.user.id, decided_at: tx.now, reason: reason, password_hash: '' });
      userId = u.id;
      return { status: 'approved', studentId: s.id, username: u.username };
    }, { actorId: ctx.user.id });
    Audit.log(ctx, 'registration.' + out.status, 'registration_requests', req.id, {}, reason);
    if (userId) Notify.sendMany([userId], 'registration', 'บัญชีของคุณได้รับการอนุมัติแล้ว', 'เข้าสู่ระบบด้วยรหัสนักเรียนและรหัสผ่านที่ตั้งไว้', '');
    return out;
  }
};
