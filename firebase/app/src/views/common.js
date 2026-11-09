/** หน้าเข้าสู่ระบบ ตั้งรหัสผ่านใหม่ สมัครใช้งาน และแจ้งเตือน */
import { collection, query, orderBy, limit, doc, updateDoc } from 'firebase/firestore';
import { views, go } from '../lib/router.js';
import { db, api, live } from '../lib/fb.js';
import { h, q, on, esc, toast, errBox, backBtn, bindBack, fmtDate } from '../lib/ui.js';
import { session, login, logout, changePassword, schoolCode } from '../lib/session.js';

views.login = () => {
  h('<div class="card" style="max-width:420px;margin:32px auto">' +
    '<h1>เข้าสู่ระบบ</h1>' +
    '<form id="login-form" novalidate>' +
    '<label for="u">ชื่อผู้ใช้ / รหัสนักเรียน</label><input id="u" type="text" autocomplete="username" autocapitalize="off" inputmode="text" required>' +
    '<label for="p">รหัสผ่าน</label><input id="p" type="password" autocomplete="current-password" required>' +
    '<details class="small" style="margin-top:8px"><summary>รหัสโรงเรียน: <span id="sc-label">' + esc(schoolCode()) + '</span></summary>' +
    '<label for="sc">รหัสโรงเรียน</label><input id="sc" type="text" autocapitalize="characters" value="' + esc(schoolCode()) + '"></details>' +
    '<div id="login-msg"></div>' +
    '<p><button class="btn" type="submit" style="width:100%">เข้าสู่ระบบ</button></p>' +
    '<p class="muted small">ลืมรหัสผ่าน กรุณาติดต่อครูหรือผู้ดูแลระบบของโรงเรียน</p>' +
    '<p id="reg-link" class="small" hidden>นักเรียนยังไม่มีบัญชี? <button class="btn ghost small" type="button" id="btn-register">สมัครใช้งาน</button></p>' +
    '</form></div>');
  const form = q('#login-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = q('button[type=submit]', form); btn.disabled = true;
    try {
      await login(q('#u').value, q('#p').value, q('#sc').value);
    } catch (err) {
      const msg = /user-disabled/.test(err.code) ? 'บัญชีนี้ถูกปิดใช้งานหรือยังรอผู้ดูแลอนุมัติ' : (/network/.test(err.code) ? 'ไม่มีการเชื่อมต่ออินเทอร์เน็ต' : 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
      q('#login-msg').innerHTML = errBox({ message: msg });
      btn.disabled = false; q('#p').value = ''; q('#p').focus();
    }
  });
  api('auth.registrationInfo', { schoolCode: schoolCode() }).then((info) => {
    if (!info || !info.enabled || !q('#reg-link')) return;
    q('#reg-link').hidden = false;
    on('#btn-register', 'click', () => go('register', { needsCode: info.needsCode, schoolCode: info.schoolCode }));
  }).catch(() => {});
  q('#u').focus();
};

views.changePassword = () => {
  h('<div class="card" style="max-width:420px;margin:32px auto"><h1>ตั้งรหัสผ่านใหม่</h1>' +
    '<p class="muted">รหัสผ่านอย่างน้อย 8 ตัวอักษร และไม่มีชื่อผู้ใช้อยู่ในรหัส</p>' +
    '<form id="pw-form"><label for="o">รหัสผ่านปัจจุบัน/ชั่วคราว</label><input id="o" type="password" autocomplete="current-password">' +
    '<label for="n1">รหัสผ่านใหม่</label><input id="n1" type="password" autocomplete="new-password">' +
    '<label for="n2">ยืนยันรหัสผ่านใหม่</label><input id="n2" type="password" autocomplete="new-password">' +
    '<div id="pw-msg"></div><p><button class="btn" type="submit">บันทึก</button> <button class="btn ghost" type="button" id="pw-cancel">ออกจากระบบ</button></p></form></div>');
  on('#pw-cancel', 'click', logout);
  q('#pw-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (q('#n1').value !== q('#n2').value) { q('#pw-msg').innerHTML = errBox({ message: 'รหัสผ่านใหม่ทั้งสองช่องไม่ตรงกัน' }); return; }
    const btn = q('#pw-form button[type=submit]'); btn.disabled = true;
    try {
      await changePassword(q('#o').value, q('#n1').value);
      toast('เปลี่ยนรหัสผ่านแล้ว');
    } catch (err) {
      q('#pw-msg').innerHTML = errBox(/wrong-password|invalid-credential/.test(err.code || '') ? { message: 'รหัสผ่านปัจจุบันไม่ถูกต้อง' } : err);
      btn.disabled = false;
    }
  });
};

const PREFIXES = ['เด็กชาย', 'เด็กหญิง', 'นาย', 'นางสาว', 'นาง'];
views.register = (p) => {
  h(backBtn() + '<div class="card" style="max-width:520px;margin:16px auto"><h1>สมัครใช้งาน (นักเรียน)</h1>' +
    '<p class="small muted">กรอกข้อมูลตามทะเบียนของโรงเรียน คำขอต้องได้รับการอนุมัติจากผู้ดูแลก่อนจึงเข้าสู่ระบบได้</p>' +
    '<form id="reg-form" novalidate>' +
    '<label for="r-code">รหัสนักเรียน</label><input id="r-code" type="text" inputmode="numeric" maxlength="30" autocomplete="username">' +
    '<div class="row"><div><label for="r-prefix">คำนำหน้า</label><select id="r-prefix">' + PREFIXES.map((x) => '<option>' + x + '</option>').join('') + '</select></div>' +
    '<div><label for="r-first">ชื่อ</label><input id="r-first" type="text" maxlength="100"></div>' +
    '<div><label for="r-last">นามสกุล</label><input id="r-last" type="text" maxlength="100"></div></div>' +
    '<div class="row"><div><label for="r-class">ชั้น</label><input id="r-class" type="text" maxlength="20" placeholder="เช่น ม.5"></div>' +
    '<div><label for="r-room">ห้อง</label><input id="r-room" type="text" maxlength="20" placeholder="เช่น 1"></div>' +
    '<div><label for="r-roll">เลขที่</label><input id="r-roll" type="number" min="0"></div></div>' +
    '<label for="r-pw">ตั้งรหัสผ่าน (อย่างน้อย 8 ตัว)</label><input id="r-pw" type="password" autocomplete="new-password">' +
    '<label for="r-pw2">ยืนยันรหัสผ่าน</label><input id="r-pw2" type="password" autocomplete="new-password">' +
    (p.needsCode ? '<label for="r-regcode">รหัสลงทะเบียน (ขอจากครูหรือผู้ดูแล)</label><input id="r-regcode" type="text" maxlength="50">' : '') +
    '<div id="reg-msg"></div><p><button class="btn" type="submit">ส่งคำขอ</button></p></form></div>');
  bindBack();
  q('#reg-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (q('#r-pw').value !== q('#r-pw2').value) { q('#reg-msg').innerHTML = errBox({ message: 'รหัสผ่านทั้งสองช่องไม่ตรงกัน' }); return; }
    const btn = q('#reg-form button[type=submit]'); btn.disabled = true;
    try {
      const r = await api('auth.register', {
        schoolCode: p.schoolCode, studentCode: q('#r-code').value, prefix: q('#r-prefix').value, firstName: q('#r-first').value, lastName: q('#r-last').value,
        classLevel: q('#r-class').value, room: q('#r-room').value, rollNo: q('#r-roll').value, password: q('#r-pw').value,
        registrationCode: q('#r-regcode') ? q('#r-regcode').value : ''
      });
      q('#reg-form').innerHTML = '<div class="notice ok" role="status">' + esc(r.message) + '</div><p><button class="btn" type="button" data-back>กลับไปหน้าเข้าสู่ระบบ</button></p>';
      bindBack();
    } catch (err) { q('#reg-msg').innerHTML = errBox(err); btn.disabled = false; }
  });
};

views.notifications = () => {
  h(backBtn() + '<h1>แจ้งเตือน</h1><div class="card" id="nlist"><div class="loading">กำลังโหลด…</div></div>');
  bindBack();
  live(query(collection(db, 'notifications', session.user.uid, 'items'), orderBy('at', 'desc'), limit(50)), (list) => {
    q('#nlist').innerHTML = list.length ? '<ul class="list">' + list.map((n) =>
      '<li><div><strong>' + (n.readAt ? '' : '● ') + esc(n.title) + '</strong><div class="small">' + esc(n.body) + '</div></div><div class="small muted">' + fmtDate(n.at) + '</div></li>').join('') + '</ul>'
      : '<div class="empty">ยังไม่มีแจ้งเตือน</div>';
    list.filter((n) => !n.readAt).forEach((n) => updateDoc(doc(db, 'notifications', session.user.uid, 'items', n.id), { readAt: new Date().toISOString() }).catch(() => {}));
  });
};
