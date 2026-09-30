/**
 * การยืนยันตัวตน
 *
 * - บัญชีของระบบเอง: ชื่อผู้ใช้ (เช่น รหัสนักเรียน) + รหัสผ่าน ไม่บังคับมีอีเมล
 * - รหัสผ่านเก็บเป็น PBKDF2-HMAC-SHA256 + salt + pepper (ดู Crypto.js)
 * - session เก็บใน CacheService ด้วยคีย์ที่เป็น HMAC ของโทเคน (ไม่เก็บโทเคนจริง)
 *   หมดอายุเมื่อไม่ใช้งาน (idle) และอายุสูงสุด (absolute); เพิกถอนทั้งหมดของผู้ใช้ได้ด้วย session_epoch
 *   ข้อจำกัด: CacheService อาจล้างข้อมูลก่อนกำหนด ผู้ใช้จะต้องเข้าสู่ระบบใหม่ (ไม่มีข้อมูลสูญหาย)
 * - จำกัดการเดารหัสผ่าน: ผิดครบ N ครั้งล็อกชั่วคราว
 */
var Auth = {
  pepper: function () {
    var p = Props.get('PEPPER');
    if (!p) Errors.raise('SETUP_REQUIRED');
    return p;
  },

  hashPassword: function (password, iterations) {
    var it = iterations || APP.PBKDF2_ITERATIONS;
    var salt = Rand.bytes(16);
    var dk = Crypto.pbkdf2(Crypto.utf8(String(password)), salt, it, 32);
    var h = Crypto.hmac(Crypto.utf8(Auth.pepper()), dk);
    return 'pbkdf2_sha256$' + it + '$' + Util.b64(salt) + '$' + Util.b64(h);
  },

  verifyPassword: function (password, stored) {
    var parts = String(stored || '').split('$');
    if (parts.length !== 4 || parts[0] !== 'pbkdf2_sha256') return false;
    var it = Number(parts[1]);
    if (!(it >= 1000 && it <= 5000000)) return false;
    var salt = Util.toUnsigned(Utilities.base64Decode(parts[2]));
    var dk = Crypto.pbkdf2(Crypto.utf8(String(password)), salt, it, 32);
    var h = Util.b64(Crypto.hmac(Crypto.utf8(Auth.pepper()), dk));
    return Crypto.safeEqual(h, parts[3]);
  },

  checkStrength: function (password, username) {
    var pw = String(password || '');
    if (pw.length < 8) Errors.raise('VALIDATION', 'รหัสผ่านต้องยาวอย่างน้อย 8 ตัวอักษร');
    if (pw.length > 128) Errors.raise('VALIDATION', 'รหัสผ่านยาวเกินไป');
    if (/^(.)\1+$/.test(pw)) Errors.raise('VALIDATION', 'รหัสผ่านต้องไม่เป็นตัวอักษรซ้ำกันทั้งหมด');
    if (username && pw.toLowerCase().indexOf(String(username).toLowerCase()) >= 0) {
      Errors.raise('VALIDATION', 'รหัสผ่านต้องไม่มีชื่อผู้ใช้อยู่ในนั้น');
    }
  },

  tokenKey: function (token) {
    return 'sess:' + Crypto.hex(Crypto.hmac(Crypto.utf8(Auth.pepper()), Crypto.utf8(String(token))));
  },

  normalizeUsername: function (u) {
    return Util.str(u, 100).toLowerCase();
  },

  login: function (username, password, meta) {
    username = Auth.normalizeUsername(username);
    if (!username || !password) Errors.raise('AUTH_INVALID');
    var cache = CacheService.getScriptCache();
    var failKey = 'lf:' + username;
    var fails = Number(cache.get(failKey) || 0);
    var users = Db.find('users', { username: username });
    if (meta && meta.schoolCode) {
      var school = Db.one('schools', { code: meta.schoolCode });
      users = users.filter(function (u) { return school && u.school_id === school.id; });
    }
    var user = users.length === 1 ? users[0] : null;
    var settings = Settings.get(user ? user.school_id : null);
    var now = Util.now();

    if (fails >= settings.login_max_failures * 2) Errors.raise('AUTH_LOCKED');
    if (user && user.locked_until && Util.ms(user.locked_until) > now.getTime()) Errors.raise('AUTH_LOCKED');

    var ok = user && user.password_hash ? Auth.verifyPassword(password, user.password_hash)
      : (Auth.verifyPassword(password, 'pbkdf2_sha256$' + APP.PBKDF2_ITERATIONS + '$AAAAAAAAAAAAAAAAAAAAAA==$x'), false);

    if (!ok) {
      cache.put(failKey, String(fails + 1), settings.login_lock_minutes * 60);
      if (user) Auth._recordFailure(user.id, settings);
      Audit.log({ primaryRole: 'anonymous' }, 'login.failed', 'users', user ? user.id : '', { username: username });
      Errors.raise('AUTH_INVALID');
    }
    if (user.status !== 'active') Errors.raise('AUTH_DISABLED');
    cache.remove(failKey);
    if (user.failed_login_count > 0 || user.locked_until) {
      Db.tx('login.reset', function (tx) {
        tx.update('users', user.id, { failed_login_count: 0, locked_until: '' });
      }, { actorId: user.id });
    }
    var token = Rand.token(32);
    Auth._saveSession(token, {
      uid: user.id,
      epoch: Number(user.session_epoch || 0),
      created: now.getTime(),
      last: now.getTime(),
      abs: now.getTime() + settings.session_absolute_hours * 3600000,
      idle: settings.session_idle_minutes * 60000
    });
    Audit.log({ primaryRole: 'user', user: user }, 'login', 'users', user.id, { ua: meta && meta.userAgent ? String(meta.userAgent).slice(0, 200) : '' });
    return { token: token, mustChangePassword: !!user.must_change_password };
  },

  _recordFailure: function (userId, settings) {
    try {
      Db.tx('login.failed', function (tx) {
        var u = tx.get('users', userId);
        var count = Number(u.failed_login_count || 0) + 1;
        var patch = { failed_login_count: count };
        if (count >= settings.login_max_failures) {
          patch.locked_until = Util.addMinutes(Util.now(), settings.login_lock_minutes).toISOString();
          patch.failed_login_count = 0;
        }
        tx.update('users', userId, patch);
      }, { actorId: userId });
    } catch (e) {
      console.warn('record failure: ' + e);
    }
  },

  _saveSession: function (token, s) {
    var ttl = Math.max(60, Math.min(21600, Math.floor((s.abs - Date.now()) / 1000)));
    CacheService.getScriptCache().put(Auth.tokenKey(token), JSON.stringify(s), ttl);
  },

  /** ตรวจโทเคนและสร้างบริบทผู้ใช้ (ctx) สำหรับตรวจสิทธิ์ */
  authenticate: function (token) {
    if (!token) Errors.raise('AUTH_REQUIRED');
    var cache = CacheService.getScriptCache();
    var key = Auth.tokenKey(token);
    var raw = cache.get(key);
    if (!raw) Errors.raise('SESSION_EXPIRED');
    var s = JSON.parse(raw);
    var now = Date.now();
    if (now > s.abs || now - s.last > s.idle) {
      cache.remove(key);
      Errors.raise('SESSION_EXPIRED');
    }
    var c = Auth._contextData(s.uid);
    if (!c || c.user.status !== 'active') { cache.remove(key); Errors.raise('AUTH_DISABLED'); }
    if (Number(c.user.session_epoch || 0) !== Number(s.epoch)) { cache.remove(key); Errors.raise('SESSION_EXPIRED'); }
    if (now - s.last > 60000) {
      s.last = now;
      Auth._saveSession(token, s);
    }
    return {
      user: c.user, token: token, schoolId: c.user.school_id, roles: c.roles, primaryRole: c.primaryRole,
      teacher: c.teacher, student: c.student, requestId: Util.uuid().slice(0, 8)
    };
  },

  /**
   * ข้อมูลบริบทผู้ใช้ (บทบาท ครู/นักเรียน) แคชไว้ 10 นาทีเพื่อลดการอ่านชีตทุกคำขอ
   * ไม่เก็บ password_hash ในแคช; ล้างทันทีเมื่อมีการแก้บัญชี (Auth.invalidateUser)
   */
  _contextData: function (userId) {
    var cache = CacheService.getScriptCache();
    var hit = cache.get('uctx:' + userId);
    if (hit) return JSON.parse(hit);
    var user = Db.get('users', userId);
    if (!user) return null;
    var roles = {};
    Db.find('role_assignments', { user_id: user.id }).forEach(function (r) {
      if (!r.revoked_at && r.school_id === user.school_id) roles[r.role] = true;
    });
    var teacher = Db.one('teachers', { user_id: user.id, school_id: user.school_id, status: 'active' });
    var student = Db.one('students', { user_id: user.id, school_id: user.school_id });
    var c = {
      user: Util.pick(user, ['id', 'school_id', 'username', 'display_name', 'status', 'session_epoch', 'must_change_password']),
      roles: roles,
      primaryRole: roles.admin ? 'admin' : (roles.teacher ? 'teacher' : (roles.student ? 'student' : 'none')),
      teacher: roles.teacher && teacher ? JSON.parse(JSON.stringify(teacher)) : null,
      student: roles.student && student ? JSON.parse(JSON.stringify(student)) : null
    };
    cache.put('uctx:' + userId, JSON.stringify(c), 600);
    return c;
  },

  invalidateUser: function (userId) {
    CacheService.getScriptCache().remove('uctx:' + userId);
  },

  logout: function (token) {
    if (token) CacheService.getScriptCache().remove(Auth.tokenKey(token));
    return true;
  },

  changePassword: function (ctx, oldPassword, newPassword) {
    var current = Db.get('users', ctx.user.id);
    if (!Auth.verifyPassword(oldPassword, current.password_hash)) Errors.raise('AUTH_INVALID', 'รหัสผ่านเดิมไม่ถูกต้อง');
    Auth.checkStrength(newPassword, ctx.user.username);
    if (oldPassword === newPassword) Errors.raise('VALIDATION', 'รหัสผ่านใหม่ต้องไม่ซ้ำรหัสผ่านเดิม');
    var hash = Auth.hashPassword(newPassword);
    var user = Db.tx('auth.changePassword', function (tx) {
      var u = tx.get('users', ctx.user.id);
      return tx.update('users', u.id, {
        password_hash: hash,
        must_change_password: false,
        password_updated_at: tx.now,
        session_epoch: Number(u.session_epoch || 0) + 1
      });
    }, { actorId: ctx.user.id });
    Auth.invalidateUser(ctx.user.id);
    Auth.logout(ctx.token);
    Audit.log(ctx, 'password.change', 'users', ctx.user.id, {});
    var settings = Settings.get(user.school_id);
    var token = Rand.token(32);
    var now = Date.now();
    Auth._saveSession(token, {
      uid: user.id, epoch: Number(user.session_epoch), created: now, last: now,
      abs: now + settings.session_absolute_hours * 3600000, idle: settings.session_idle_minutes * 60000
    });
    return { token: token };
  },

  /** ผู้ดูแลรีเซ็ตรหัสผ่าน: สร้างรหัสชั่วคราว เพิกถอน session เดิม บังคับเปลี่ยนเมื่อเข้าใช้ */
  adminResetPassword: function (ctx, userId) {
    Authz.requireAdmin(ctx);
    var temp = Setup.tempPassword();
    var hash = Auth.hashPassword(temp);
    Db.tx('auth.adminReset', function (tx) {
      var u = tx.get('users', userId);
      if (!u || u.school_id !== ctx.schoolId) Errors.raise('NOT_FOUND');
      tx.update('users', u.id, {
        password_hash: hash, must_change_password: true, failed_login_count: 0, locked_until: '',
        session_epoch: Number(u.session_epoch || 0) + 1
      });
    }, { actorId: ctx.user.id });
    Auth.invalidateUser(userId);
    Audit.log(ctx, 'password.reset', 'users', userId, {});
    return { tempPassword: temp };
  },

  /** ผู้ดูแลเปิด/ปิดใช้งานบัญชี (ข้อมูลงานและคะแนนเดิมยังอยู่ครบ) */
  adminSetStatus: function (ctx, userId, status, reason) {
    Authz.requireAdmin(ctx);
    if (['active', 'disabled'].indexOf(status) < 0) Errors.raise('VALIDATION');
    if (userId === ctx.user.id) Errors.raise('VALIDATION', 'ปิดบัญชีตนเองไม่ได้');
    Db.tx('auth.setStatus', function (tx) {
      var u = tx.get('users', userId);
      if (!u || u.school_id !== ctx.schoolId) Errors.raise('NOT_FOUND');
      tx.update('users', u.id, { status: status, session_epoch: Number(u.session_epoch || 0) + 1 });
    }, { actorId: ctx.user.id });
    Auth.invalidateUser(userId);
    Audit.log(ctx, 'user.status', 'users', userId, { status: status }, reason);
    return true;
  },

  profile: function (ctx) {
    var school = Db.get('schools', ctx.schoolId);
    var settings = Settings.get(ctx.schoolId);
    var s = ctx.student, t = ctx.teacher;
    return {
      userId: ctx.user.id,
      username: ctx.user.username,
      displayName: ctx.user.display_name ||
        (s ? [s.prefix, s.first_name, s.last_name].join(' ').trim() : (t ? [t.prefix, t.first_name, t.last_name].join(' ').trim() : ctx.user.username)),
      roles: Object.keys(ctx.roles),
      primaryRole: ctx.primaryRole,
      mustChangePassword: !!ctx.user.must_change_password,
      student: s ? { id: s.id, code: s.student_code, classLevel: s.class_level, room: s.room, rollNo: s.roll_no } : null,
      teacher: t ? { id: t.id, code: t.teacher_code } : null,
      school: school ? { name: school.name_th, appName: school.app_name || settings.app_name, color: school.primary_color, isDemo: !!school.is_demo } : null
    };
  }
};
