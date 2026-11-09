/**
 * หน้าผู้ดูแลระบบ: นักเรียน (เพิ่ม/นำเข้า/บัญชี) ครูและบทบาท ปีการศึกษา/รายวิชา คำขอสมัคร การตั้งค่า
 * รายการทั้งหมดอัปเดตแบบเรียลไทม์ — ผู้ดูแลหลายคนทำงานพร้อมกันได้
 */
import { collection, doc, query, where, getCountFromServer } from 'firebase/firestore';
import { views, go, back } from '../lib/router.js';
import { db, api, live, fetchOne } from '../lib/fb.js';
import { h, q, on, esc, toast, errBox, backBtn, bindBack, fmtDate, openModal, closeModal, download, csv } from '../lib/ui.js';
import { session, hasRole, schoolId } from '../lib/session.js';

const ST_STATUS = { active: 'กำลังศึกษา', graduated: 'จบการศึกษา', transferred: 'ย้ายออก', withdrawn: 'ลาออก', inactive: 'ไม่ใช้งาน' };
const PREFIXES = ['เด็กชาย', 'เด็กหญิง', 'นาย', 'นางสาว', 'นาง'];
const after = async (pr, okMsg) => { try { const r = await pr; toast(okMsg || 'บันทึกแล้ว'); return r; } catch (err) { toast(err.message); return null; } };
const byRoom = (a, b) => String(a.classLevel || '').localeCompare(String(b.classLevel || ''), 'th', { numeric: true }) || String(a.room || '').localeCompare(String(b.room || ''), 'th', { numeric: true }) ||
  (Number(a.rollNo || 0) - Number(b.rollNo || 0)) || String(a.code).localeCompare(String(b.code), 'th', { numeric: true });

/** แสดงรหัสผ่านชั่วคราวครั้งเดียว (ระบบไม่เก็บรหัสผ่านแบบอ่านได้) */
function showAccount(acc, name) {
  openModal('<h2 id="modal-title" style="margin-top:0">บัญชีเข้าระบบ</h2><p>' + esc(name || '') + '</p><dl class="kv"><dt>ชื่อผู้ใช้</dt><dd class="temp-pw">' + esc(acc.username) + '</dd><dt>รหัสผ่านชั่วคราว</dt><dd class="temp-pw">' + esc(acc.tempPassword) + '</dd>' +
    '<dt>รหัสโรงเรียน</dt><dd class="temp-pw">' + esc(session.school ? session.school.code : '') + '</dd></dl>' +
    '<div class="notice warn small">แสดงครั้งเดียว กรุณาจดหรือส่งให้ผู้ใช้ทันที ผู้ใช้ต้องตั้งรหัสผ่านใหม่เมื่อเข้าสู่ระบบครั้งแรก</div>' +
    '<p><button class="btn ghost" id="acc-copy">คัดลอก</button> <button class="btn" data-close>ปิด</button></p>');
  q('#acc-copy').addEventListener('click', () => {
    const text = 'ชื่อผู้ใช้: ' + acc.username + '\nรหัสผ่านชั่วคราว: ' + acc.tempPassword + '\nรหัสโรงเรียน: ' + (session.school ? session.school.code : '');
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(() => toast('คัดลอกแล้ว'), () => toast('คัดลอกไม่ได้ กรุณาจดเอง'));
  });
}

// ---------------------------------------------------------------- หน้าหลักผู้ดูแล
views.adminHome = () => {
  const tiles = [
    ['adminStudents', '👩‍🎓', 'นักเรียน', 'เพิ่ม แก้ไข บัญชีเข้าระบบ', 'n-students'], ['adminImport', '📥', 'นำเข้านักเรียน', 'วางจาก Excel/CSV ทีละหลายร้อยคน', ''],
    ['adminTeachers', '🧑‍🏫', 'ครูและบทบาท', 'บัญชีครู ผู้ดูแล ผู้ดูแลคะแนน', 'n-teachers'], ['adminCourses', '📚', 'ปีการศึกษาและรายวิชา', 'ภาคเรียน รายวิชาในหลักสูตร รายวิชาที่เปิดสอน', 'n-offerings'],
    ['teacherHome', '🗂️', 'เปิดดูรายวิชา', 'งาน กลุ่ม คะแนน ของทุกรายวิชา', ''], ['adminRegistrations', '📝', 'คำขอสมัครใช้งาน', 'อนุมัติบัญชีที่นักเรียนสมัครเอง', 'n-reg'],
    ['adminReports', '📊', 'รายงาน PDF / Excel', 'แยกตามห้อง แยกตามกลุ่ม', ''], ['adminSettings', '⚙️', 'ตั้งค่าระบบ', 'ไฟล์ที่รับ การสมัครเอง', '']
  ];
  h('<h1>ผู้ดูแลระบบ</h1><p class="muted">' + esc(session.school ? session.school.nameTh : '') + '</p><div class="grid">' + tiles.map((t) =>
    '<div class="card clickable" tabindex="0" role="button" data-go="' + t[0] + '"><div style="font-size:1.8rem" aria-hidden="true">' + t[1] + '</div><h3>' + t[2] + (t[4] ? ' <span class="chip neutral" id="' + t[4] + '">…</span>' : '') + '</h3><div class="small muted">' + t[3] + '</div></div>').join('') + '</div>');
  on('[data-go]', 'click', (e) => go(e.currentTarget.getAttribute('data-go'), {}));
  on('[data-go]', 'keydown', (e) => { if (e.key === 'Enter') go(e.currentTarget.getAttribute('data-go'), {}); });
  const sch = schoolId();
  const count = async (id, qy) => { try { const n = (await getCountFromServer(qy)).data().count; if (q('#' + id)) q('#' + id).textContent = n; } catch (e) { if (q('#' + id)) q('#' + id).textContent = '–'; } };
  count('n-students', query(collection(db, 'students'), where('schoolId', '==', sch), where('status', '==', 'active')));
  count('n-teachers', query(collection(db, 'teachers'), where('schoolId', '==', sch)));
  count('n-offerings', query(collection(db, 'offerings'), where('schoolId', '==', sch)));
  live(query(collection(db, 'registrationRequests'), where('schoolId', '==', sch), where('status', '==', 'pending')), (l) => {
    const el = q('#n-reg'); if (!el) return;
    el.textContent = l.length; el.className = 'chip ' + (l.length ? 'warn' : 'neutral');
  });
};

// ---------------------------------------------------------------- นักเรียน
views.adminStudents = () => {
  h(backBtn() + '<h1>นักเรียน</h1><p class="no-print"><button class="btn" id="st-new">+ เพิ่มนักเรียน</button> <button class="btn ghost" id="st-import">นำเข้าจาก Excel/CSV</button> <button class="btn ghost" id="st-export">ส่งออกรายชื่อ (CSV)</button></p>' +
    '<div class="card"><div class="row"><div><label for="f-room">ห้อง</label><select id="f-room"><option value="">ทุกห้อง</option></select></div>' +
    '<div><label for="f-status">สถานะ</label><select id="f-status"><option value="active">กำลังศึกษา</option><option value="">ทั้งหมด</option>' + Object.keys(ST_STATUS).filter((k) => k !== 'active').map((k) => '<option value="' + k + '">' + ST_STATUS[k] + '</option>').join('') + '</select></div>' +
    '<div><label for="f-q">ค้นหา</label><input id="f-q" type="search" placeholder="ชื่อหรือรหัส"></div></div></div><div id="st-list" class="card"><div class="loading">กำลังโหลด…</div></div>');
  bindBack();
  on('#st-new', 'click', () => go('studentForm', {}));
  on('#st-import', 'click', () => go('adminImport', {}));
  let all = null;
  const filtered = () => {
    const room = q('#f-room').value, status = q('#f-status').value, kw = q('#f-q').value.trim().toLowerCase();
    return all.filter((s) => (!room || s.roomLabel === room) && (!status || s.status === status) && (!kw || (s.code + ' ' + s.name).toLowerCase().includes(kw))).sort(byRoom);
  };
  const paint = () => {
    if (!all || !q('#st-list')) return;
    const rooms = [...new Set(all.map((s) => s.roomLabel))].sort((a, b) => a.localeCompare(b, 'th', { numeric: true }));
    const sel = q('#f-room'), cur = sel.value;
    sel.innerHTML = '<option value="">ทุกห้อง</option>' + rooms.map((r) => '<option' + (r === cur ? ' selected' : '') + '>' + esc(r) + '</option>').join('');
    const rows = filtered();
    q('#st-list').innerHTML = '<p class="small muted">' + rows.length + ' คน' + (rows.length > 300 ? ' (แสดง 300 คนแรก ใช้ตัวกรองเพื่อหาเพิ่ม)' : '') + '</p>' + (rows.length ? '<div class="table-wrap"><table><thead><tr><th>รหัส</th><th>ชื่อ - สกุล</th><th>ห้อง</th><th class="hide-sm">เลขที่</th><th>บัญชี</th><th class="hide-sm">สถานะ</th></tr></thead><tbody>' +
      rows.slice(0, 300).map((s) => '<tr class="clickable" tabindex="0" data-st="' + esc(s.id) + '"><td>' + esc(s.code) + '</td><td>' + esc(s.name) + '</td><td>' + esc(s.roomLabel) + '</td><td class="hide-sm">' + esc(s.rollNo ?? '') + '</td>' +
        '<td>' + (s.uid ? '<span class="chip ok">มีบัญชี</span>' : '<span class="chip neutral">ยังไม่มี</span>') + '</td><td class="hide-sm small">' + esc(ST_STATUS[s.status] || s.status) + '</td></tr>').join('') + '</tbody></table></div>' : '<div class="empty">ไม่พบนักเรียน</div>');
    on('[data-st]', 'click', (e) => go('studentForm', { id: e.currentTarget.getAttribute('data-st') }), q('#st-list'));
    on('[data-st]', 'keydown', (e) => { if (e.key === 'Enter') go('studentForm', { id: e.currentTarget.getAttribute('data-st') }); }, q('#st-list'));
  };
  ['#f-room', '#f-status'].forEach((s) => q(s).addEventListener('change', paint));
  q('#f-q').addEventListener('input', paint);
  on('#st-export', 'click', () => {
    if (!all) return;
    const rows = filtered();
    download('รายชื่อนักเรียน.csv', 'text/csv', csv([['รหัสนักเรียน', 'คำนำหน้า', 'ชื่อ', 'นามสกุล', 'ชั้น', 'ห้อง', 'เลขที่', 'สถานะ', 'ชื่อผู้ใช้']].concat(rows.map((s) => [s.code, s.prefix, s.firstName, s.lastName, s.classLevel, s.room, s.rollNo ?? '', ST_STATUS[s.status] || s.status, s.username || '']))));
  });
  live(query(collection(db, 'students'), where('schoolId', '==', schoolId())), (l) => { all = l; paint(); }, (err) => { q('#st-list').innerHTML = errBox(err); });
};

views.studentForm = (p) => {
  h(backBtn() + '<div id="sf"><div class="loading">กำลังโหลด…</div></div>');
  bindBack();
  let built = false, s = null, user;
  const paintAccount = () => {
    const box = q('#sf-acc');
    if (!box || !s) return;
    if (!s.uid) { box.innerHTML = '<p class="muted">ยังไม่มีบัญชีเข้าระบบ</p><p><button class="btn ghost" id="acc-create">สร้างบัญชี (รหัสผ่านชั่วคราว)</button></p>'; }
    else {
      box.innerHTML = '<dl class="kv"><dt>ชื่อผู้ใช้</dt><dd>' + esc(s.username) + '</dd><dt>สถานะบัญชี</dt><dd>' + (user ? (user.status === 'active' ? '<span class="chip ok">ใช้งานได้</span>' : '<span class="chip bad">ปิดใช้งาน</span>') : '…') + '</dd>' +
        (user && user.mustChangePassword ? '<dt></dt><dd class="small muted">ยังไม่ได้ตั้งรหัสผ่านใหม่</dd>' : '') + '</dl>' +
        '<p><button class="btn ghost" id="acc-reset">รีเซ็ตรหัสผ่าน</button> ' + (user ? '<button class="btn ghost" id="acc-status">' + (user.status === 'active' ? 'ปิดใช้งานบัญชี' : 'เปิดใช้งานบัญชี') + '</button>' : '') + '</p>';
    }
    on('#acc-create', 'click', async () => { const r = await after(api('admin.createStudentAccount', { studentId: s.id }), 'สร้างบัญชีแล้ว'); if (r) showAccount(r, s.name); });
    on('#acc-reset', 'click', async () => { if (!confirm('รีเซ็ตรหัสผ่านของ ' + s.name + '? ผู้ใช้จะถูกออกจากระบบทุกอุปกรณ์')) return; const r = await after(api('admin.resetPassword', { userId: s.uid }), 'รีเซ็ตแล้ว'); if (r) showAccount(r, s.name); });
    on('#acc-status', 'click', () => after(api('admin.setUserStatus', { userId: s.uid, status: user.status === 'active' ? 'disabled' : 'active' })));
  };
  const build = () => {
    built = true;
    const v = s || { status: 'active' };
    q('#sf').innerHTML = '<h1>' + (s ? esc(s.name) : 'เพิ่มนักเรียน') + '</h1><form class="card" id="sf-form" novalidate>' +
      '<div class="row"><div><label for="s-code">รหัสนักเรียน *</label><input id="s-code" required maxlength="30" inputmode="numeric" value="' + esc(v.code || '') + '"></div>' +
      '<div><label for="s-prefix">คำนำหน้า</label><input id="s-prefix" list="prefixes" maxlength="30" value="' + esc(v.prefix || '') + '"><datalist id="prefixes">' + PREFIXES.map((x) => '<option value="' + x + '">').join('') + '</datalist></div></div>' +
      '<div class="row"><div><label for="s-first">ชื่อ *</label><input id="s-first" required maxlength="100" value="' + esc(v.firstName || '') + '"></div><div><label for="s-last">นามสกุล</label><input id="s-last" maxlength="100" value="' + esc(v.lastName || '') + '"></div></div>' +
      '<div class="row"><div><label for="s-class">ชั้น</label><input id="s-class" maxlength="20" value="' + esc(v.classLevel || '') + '" placeholder="เช่น ม.5"></div><div><label for="s-room">ห้อง</label><input id="s-room" maxlength="20" value="' + esc(v.room || '') + '"></div>' +
      '<div><label for="s-roll">เลขที่</label><input id="s-roll" inputmode="numeric" value="' + esc(v.rollNo ?? '') + '"></div></div>' +
      '<label for="s-status">สถานะ</label><select id="s-status">' + Object.keys(ST_STATUS).map((k) => '<option value="' + k + '"' + (v.status === k ? ' selected' : '') + '>' + ST_STATUS[k] + '</option>').join('') + '</select>' +
      (s ? '' : '<label class="check"><input type="checkbox" id="s-acc" checked> สร้างบัญชีเข้าระบบ (ชื่อผู้ใช้ = รหัสนักเรียน)</label>') +
      '<div id="sf-msg"></div><p><button class="btn" type="submit">บันทึก</button></p></form>' +
      (s ? '<div class="card"><h2 style="margin-top:0">บัญชีเข้าระบบ</h2><div id="sf-acc"></div></div>' : '');
    q('#sf-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = q('button[type=submit]', e.currentTarget); btn.disabled = true;
      try {
        const r = await api('admin.saveStudent', {
          id: s ? s.id : '', version: s ? s.version : undefined, studentCode: q('#s-code').value, prefix: q('#s-prefix').value, firstName: q('#s-first').value, lastName: q('#s-last').value,
          classLevel: q('#s-class').value, room: q('#s-room').value, rollNo: q('#s-roll').value, status: q('#s-status').value, createAccount: s ? undefined : q('#s-acc').checked
        });
        toast('บันทึกแล้ว');
        if (r.account) showAccount(r.account, r.student.name);
        if (!s) back();
      } catch (err) { q('#sf-msg').innerHTML = errBox(err); } finally { btn.disabled = false; }
    });
    paintAccount();
  };
  if (!p.id) { build(); return; }
  let userUnsub = null, lastUid = '';
  live(doc(db, 'students', p.id), (d) => {
    const first = !s;
    s = d;
    if (!d) { q('#sf').innerHTML = errBox({ message: 'ไม่พบนักเรียน' }); return; }
    if (first || !built) build(); else paintAccount();
    if (d.uid && d.uid !== lastUid) { lastUid = d.uid; if (userUnsub) userUnsub(); userUnsub = live(doc(db, 'users', d.uid), (u) => { user = u; paintAccount(); }); }
  });
};

// ---------------------------------------------------------------- นำเข้านักเรียน
views.adminImport = () => {
  h(backBtn() + '<h1>นำเข้านักเรียน</h1><div class="card"><p>คัดลอกตารางจาก Excel/Google Sheets มาวาง หรือเลือกไฟล์ CSV · แถวแรกเป็นหัวตาราง เช่น <code>รหัสนักเรียน, คำนำหน้า, ชื่อ, นามสกุล, ชั้น, ห้อง, เลขที่</code></p>' +
    '<p><label class="btn ghost" for="imp-file" style="display:inline-flex">เลือกไฟล์ CSV / TXT</label><input id="imp-file" type="file" accept=".csv,.txt,.tsv,text/csv,text/plain" hidden></p>' +
    '<label for="imp-text">ข้อมูล</label><textarea id="imp-text" rows="10" placeholder="รหัสนักเรียน&#9;คำนำหน้า&#9;ชื่อ&#9;นามสกุล&#9;ชั้น&#9;ห้อง&#9;เลขที่"></textarea>' +
    '<label class="check"><input type="checkbox" id="imp-acc" checked> สร้างบัญชีเข้าระบบให้นักเรียนใหม่ (รหัสผ่านชั่วคราว)</label>' +
    '<div id="imp-msg"></div><p><button class="btn" id="imp-check">ตรวจข้อมูล</button></p></div><div id="imp-result"></div>');
  bindBack();
  q('#imp-file').addEventListener('change', async () => { const f = q('#imp-file').files[0]; if (f) q('#imp-text').value = await f.text(); });
  const LABEL = { insert: ['ok', 'เพิ่มใหม่'], update: ['info', 'แก้ไข'], skip: ['neutral', 'ไม่เปลี่ยน'], error: ['bad', 'ผิดพลาด'] };
  q('#imp-check').addEventListener('click', async () => {
    q('#imp-msg').innerHTML = '';
    try {
      const r = await api('admin.importStudents', { text: q('#imp-text').value, commit: false });
      q('#imp-result').innerHTML = '<div class="card"><h2 style="margin-top:0">ผลการตรวจ</h2>' + Object.keys(LABEL).map((k) => '<div class="stat"><span class="small muted">' + LABEL[k][1] + '</span><b>' + r.counts[k] + '</b></div>').join('') +
        r.warnings.map((w) => '<div class="notice warn">' + esc(w) + '</div>').join('') +
        '<p class="small muted">คอลัมน์ที่จับคู่ได้: ' + Object.keys(r.mapping).map((k) => esc(k) + ' ← "' + esc(r.mapping[k]) + '"').join(', ') + '</p>' +
        '<div class="table-wrap"><table><thead><tr><th>แถว</th><th>รหัส</th><th>ชื่อ</th><th>ห้อง</th><th>ผล</th></tr></thead><tbody>' + r.rows.slice(0, 500).map((x) => '<tr><td>' + x.rowNo + '</td><td>' + esc(x.code) + '</td><td>' + esc(x.name) + '</td><td>' + esc(x.room) + '</td><td><span class="chip ' + LABEL[x.result][0] + '">' + LABEL[x.result][1] + '</span> <span class="small">' + esc(x.message) + '</span></td></tr>').join('') + '</tbody></table></div>' +
        (r.counts.insert + r.counts.update ? '<p><button class="btn" id="imp-commit">ยืนยันนำเข้า ' + (r.counts.insert + r.counts.update) + ' รายการ' + (r.counts.error ? ' (ข้ามแถวที่ผิด)' : '') + '</button></p>' : '') + '</div>';
      on('#imp-commit', 'click', async (e) => {
        e.currentTarget.disabled = true;
        try {
          const c = await api('admin.importStudents', { text: q('#imp-text').value, commit: true, skipErrors: true, createAccounts: q('#imp-acc').checked });
          q('#imp-result').innerHTML = '<div class="card"><h2 style="margin-top:0">นำเข้าแล้ว</h2>' + Object.keys(LABEL).map((k) => '<div class="stat"><span class="small muted">' + LABEL[k][1] + '</span><b>' + c.counts[k] + '</b></div>').join('') +
            (c.accounts.length ? '<div class="notice warn">บัญชีใหม่ ' + c.accounts.length + ' บัญชี — รหัสผ่านชั่วคราวแสดงครั้งเดียว กรุณาดาวน์โหลดเก็บไว้แจกนักเรียน</div><p><button class="btn" id="imp-dl">ดาวน์โหลดบัญชี (CSV)</button></p>' +
              '<div class="table-wrap"><table><thead><tr><th>รหัส</th><th>ชื่อ</th><th>ห้อง</th><th>ชื่อผู้ใช้</th><th>รหัสผ่านชั่วคราว</th></tr></thead><tbody>' + c.accounts.map((a) => '<tr><td>' + esc(a.code) + '</td><td>' + esc(a.name) + '</td><td>' + esc(a.room) + '</td><td class="temp-pw">' + esc(a.username) + '</td><td class="temp-pw">' + esc(a.tempPassword) + '</td></tr>').join('') + '</tbody></table></div>' : '') +
            (c.skippedRows.length ? '<h3>แถวที่ไม่ได้นำเข้า</h3><ul>' + c.skippedRows.map((x) => '<li>แถว ' + x.rowNo + ' ' + esc(x.code) + ': ' + esc(x.message) + '</li>').join('') + '</ul>' : '') + '</div>';
          on('#imp-dl', 'click', () => download('บัญชีนักเรียนใหม่.csv', 'text/csv', csv([['รหัสนักเรียน', 'ชื่อ', 'ห้อง', 'รหัสโรงเรียน', 'ชื่อผู้ใช้', 'รหัสผ่านชั่วคราว']].concat(c.accounts.map((a) => [a.code, a.name, a.room, session.school ? session.school.code : '', a.username, a.tempPassword])))));
          q('#imp-text').value = '';
        } catch (err) { q('#imp-msg').innerHTML = errBox(err); }
      });
    } catch (err) { q('#imp-msg').innerHTML = errBox(err); }
  });
};

// ---------------------------------------------------------------- ครูและบทบาท
views.adminTeachers = () => {
  h(backBtn() + '<h1>ครูและบทบาท</h1><p><button class="btn" id="t-new">+ เพิ่มครู</button></p><div class="card" id="t-list"><div class="loading">กำลังโหลด…</div></div>');
  bindBack();
  on('#t-new', 'click', () => go('teacherForm', {}));
  let teachers = null, users = null;
  const paint = () => {
    if (!teachers || !users || !q('#t-list')) return;
    const byUid = Object.fromEntries(users.map((u) => [u.id, u]));
    const rows = teachers.slice().sort((a, b) => String(a.name).localeCompare(String(b.name), 'th'));
    q('#t-list').innerHTML = rows.length ? '<div class="table-wrap"><table><thead><tr><th>ครู</th><th class="hide-sm">กลุ่มสาระ</th><th>บทบาท</th><th></th></tr></thead><tbody>' + rows.map((t) => {
      const u = byUid[t.uid] || null;
      const roles = u ? u.roles || [] : [];
      return '<tr><td>' + esc(t.name) + '<div class="small muted">' + esc(t.code) + (t.username ? ' · ' + esc(t.username) : '') + (u && u.status !== 'active' ? ' · <span class="chip bad">ปิดใช้งาน</span>' : '') + (t.status !== 'active' ? ' · ไม่ใช้งาน' : '') + '</div></td><td class="hide-sm">' + esc(t.department || '') + '</td>' +
        '<td>' + (u ? ['admin', 'grade_admin'].map((r) => '<label class="check small"><input type="checkbox" data-role="' + r + '" data-uid="' + esc(u.id) + '"' + (roles.includes(r) ? ' checked' : '') + (u.id === session.user.uid && r === 'admin' ? ' disabled' : '') + '> ' + (r === 'admin' ? 'ผู้ดูแลระบบ' : 'ผู้ดูแลคะแนน') + '</label>').join('') : '<span class="small muted">ยังไม่มีบัญชี</span>') + '</td>' +
        '<td><button class="btn ghost small" data-edit="' + esc(t.id) + '">แก้ไข</button>' + (u ? ' <button class="btn ghost small" data-reset="' + esc(u.id) + '" data-name="' + esc(t.name) + '">รีเซ็ตรหัสผ่าน</button>' + (u.id !== session.user.uid ? ' <button class="btn ghost small" data-status="' + esc(u.id) + '" data-to="' + (u.status === 'active' ? 'disabled' : 'active') + '">' + (u.status === 'active' ? 'ปิดบัญชี' : 'เปิดบัญชี') + '</button>' : '') : '') + '</td></tr>';
    }).join('') + '</tbody></table></div><p class="small muted">ผู้ดูแลคะแนน = ให้/แก้/ประกาศคะแนนได้ทุกรายวิชา (มีบันทึกการแก้ไขทุกครั้ง) · การเปลี่ยนบทบาทมีผลกับผู้ใช้ทันทีโดยไม่ต้องออกจากระบบ</p>' : '<div class="empty">ยังไม่มีครู</div>';
    on('[data-edit]', 'click', (e) => go('teacherForm', { id: e.currentTarget.getAttribute('data-edit') }), q('#t-list'));
    on('[data-role]', 'change', async (e) => {
      const el = e.currentTarget, grant = el.checked;
      const reason = prompt((grant ? 'ให้' : 'เพิกถอน') + 'บทบาท — เหตุผล (บันทึกในประวัติ)') || '';
      if (!reason) { el.checked = !grant; return; }
      const r = await after(api('admin.setRole', { userId: el.getAttribute('data-uid'), role: el.getAttribute('data-role'), grant, reason }), 'เปลี่ยนบทบาทแล้ว');
      if (!r) el.checked = !grant;
    }, q('#t-list'));
    on('[data-reset]', 'click', async (e) => { const el = e.currentTarget; if (!confirm('รีเซ็ตรหัสผ่าน ' + el.getAttribute('data-name') + '?')) return; const r = await after(api('admin.resetPassword', { userId: el.getAttribute('data-reset') }), 'รีเซ็ตแล้ว'); if (r) showAccount(r, el.getAttribute('data-name')); }, q('#t-list'));
    on('[data-status]', 'click', (e) => after(api('admin.setUserStatus', { userId: e.currentTarget.getAttribute('data-status'), status: e.currentTarget.getAttribute('data-to') })), q('#t-list'));
  };
  live(query(collection(db, 'teachers'), where('schoolId', '==', schoolId())), (l) => { teachers = l; paint(); }, (err) => { q('#t-list').innerHTML = errBox(err); });
  live(query(collection(db, 'users'), where('schoolId', '==', schoolId())), (l) => { users = l; paint(); });
};

views.teacherForm = async (p) => {
  const t = p.id ? await fetchOne(doc(db, 'teachers', p.id)) : null;
  const v = t || { status: 'active' };
  h(backBtn() + '<h1>' + (t ? 'แก้ไขข้อมูลครู' : 'เพิ่มครู') + '</h1><form class="card" id="tf" novalidate>' +
    '<div class="row"><div><label for="t-code">รหัสครู *</label><input id="t-code" required maxlength="30" value="' + esc(v.code || '') + '"></div>' +
    (t ? '' : '<div><label for="t-user">ชื่อผู้ใช้ (เว้นว่าง = รหัสครู หรือใส่อีเมล)</label><input id="t-user" maxlength="100" autocapitalize="off"></div>') + '</div>' +
    '<div class="row"><div><label for="t-prefix">คำนำหน้า</label><input id="t-prefix" maxlength="30" value="' + esc(v.prefix || '') + '"></div><div><label for="t-first">ชื่อ *</label><input id="t-first" required maxlength="100" value="' + esc(v.firstName || '') + '"></div>' +
    '<div><label for="t-last">นามสกุล</label><input id="t-last" maxlength="100" value="' + esc(v.lastName || '') + '"></div></div>' +
    '<label for="t-dept">กลุ่มสาระ</label><input id="t-dept" maxlength="100" value="' + esc(v.department || '') + '">' +
    '<label for="t-status">สถานะ</label><select id="t-status"><option value="active"' + (v.status === 'active' ? ' selected' : '') + '>ใช้งาน</option><option value="inactive"' + (v.status === 'inactive' ? ' selected' : '') + '>ไม่ใช้งาน</option></select>' +
    (t ? '' : '<label class="check"><input type="checkbox" id="t-acc" checked> สร้างบัญชีเข้าระบบ</label>') +
    '<div id="tf-msg"></div><p><button class="btn" type="submit">บันทึก</button></p></form>');
  bindBack();
  q('#tf').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const r = await api('admin.saveTeacher', {
        id: t ? t.id : '', version: t ? t.version : undefined, teacherCode: q('#t-code').value, username: q('#t-user') ? q('#t-user').value : '', prefix: q('#t-prefix').value,
        firstName: q('#t-first').value, lastName: q('#t-last').value, department: q('#t-dept').value, status: q('#t-status').value, createAccount: t ? undefined : q('#t-acc').checked
      });
      toast('บันทึกแล้ว');
      back();
      if (r.account) showAccount(r.account, r.teacher.name);
    } catch (err) { q('#tf-msg').innerHTML = errBox(err); }
  });
};

// ---------------------------------------------------------------- ปีการศึกษา รายวิชา รายวิชาที่เปิดสอน
views.adminCourses = () => {
  h(backBtn() + '<h1>ปีการศึกษาและรายวิชา</h1>' +
    '<div class="card"><h2 style="margin-top:0">ปีการศึกษา / ภาคเรียน</h2><div class="row"><div><label for="y-be">เพิ่มปีการศึกษา (พ.ศ.)</label><input id="y-be" inputmode="numeric" placeholder="เช่น ' + (new Date().getFullYear() + 543) + '"></div>' +
    '<div><label for="y-term">ภาค</label><select id="y-term"><option value="">ภาค 1 และ 2</option><option value="1">1</option><option value="2">2</option><option value="3">ฤดูร้อน</option></select></div></div><p><button class="btn ghost" id="y-add">เพิ่ม</button></p><div id="terms"></div></div>' +
    '<div class="card"><h2 style="margin-top:0">รายวิชาในหลักสูตร</h2><p><button class="btn ghost" id="c-new">+ เพิ่มรายวิชา</button></p><div id="courses"></div></div>' +
    '<div class="card"><h2 style="margin-top:0">รายวิชาที่เปิดสอน</h2><p><button class="btn ghost" id="o-new">+ เปิดรายวิชา</button> <button class="btn ghost" id="o-all">ดูทั้งหมด</button></p><div id="offs-sum"></div></div>');
  bindBack();
  on('#c-new', 'click', () => go('courseForm', {}));
  on('#o-new', 'click', () => go('offeringForm', {}));
  on('#o-all', 'click', () => go('teacherHome', {}));
  q('#y-add').addEventListener('click', async () => {
    const yearBe = q('#y-be').value, termNo = q('#y-term').value;
    await after(termNo ? api('admin.saveTerm', { yearBe, termNo }) : api('admin.saveYear', { yearBe }), 'เพิ่มแล้ว');
  });
  const sch = schoolId();
  const TS = { planning: 'วางแผน', active: 'กำลังใช้', closed: 'ปิดแล้ว' };
  live(query(collection(db, 'terms'), where('schoolId', '==', sch)), (l) => {
    l.sort((a, b) => (b.yearBe - a.yearBe) || (b.termNo - a.termNo));
    q('#terms').innerHTML = l.length ? '<ul class="member-list">' + l.map((t) => '<li><span>' + esc(t.label) + ' <span class="small muted">' + esc(t.name) + '</span></span><select class="compact" data-term="' + esc(t.id) + '" data-y="' + t.yearBe + '" data-t="' + t.termNo + '" aria-label="สถานะ ' + esc(t.label) + '">' +
      Object.keys(TS).map((k) => '<option value="' + k + '"' + (t.status === k ? ' selected' : '') + '>' + TS[k] + '</option>').join('') + '</select></li>').join('') + '</ul>' : '<p class="muted">ยังไม่มีภาคเรียน</p>';
    on('[data-term]', 'change', (e) => { const el = e.currentTarget; after(api('admin.saveTerm', { id: el.getAttribute('data-term'), yearBe: el.getAttribute('data-y'), termNo: el.getAttribute('data-t'), status: el.value })); }, q('#terms'));
  });
  live(query(collection(db, 'courses'), where('schoolId', '==', sch)), (l) => {
    l.sort((a, b) => String(a.code).localeCompare(String(b.code), 'th', { numeric: true }));
    q('#courses').innerHTML = l.length ? '<ul class="member-list">' + l.map((c) => '<li><span><strong>' + esc(c.code) + '</strong> ' + esc(c.nameTh) + ' <span class="small muted">' + esc(c.gradeLevel || '') + (c.credits ? ' · ' + esc(c.credits) + ' หน่วยกิต' : '') + (c.status === 'inactive' ? ' · ไม่ใช้งาน' : '') + '</span></span><button class="btn ghost small" data-c="' + esc(c.id) + '">แก้ไข</button></li>').join('') + '</ul>' : '<p class="muted">ยังไม่มีรายวิชา</p>';
    on('[data-c]', 'click', (e) => go('courseForm', { id: e.currentTarget.getAttribute('data-c') }), q('#courses'));
  });
  live(query(collection(db, 'offerings'), where('schoolId', '==', sch)), (l) => {
    const open = l.filter((o) => o.status === 'open').length;
    q('#offs-sum').innerHTML = '<div class="stat"><span class="small muted">เปิดสอน</span><b>' + open + '</b></div><div class="stat"><span class="small muted">ทั้งหมด</span><b>' + l.length + '</b></div>';
  });
};

// ---------------------------------------------------------------- คำขอสมัครใช้งาน
views.adminRegistrations = () => {
  h(backBtn() + '<h1>คำขอสมัครใช้งาน</h1><p class="small muted"><span class="live-dot"></span>คำขอใหม่ปรากฏทันที · เปิด/ปิดการสมัครเองที่ "ตั้งค่าระบบ"</p><div id="reg" class="card"><div class="loading">กำลังโหลด…</div></div>');
  bindBack();
  live(query(collection(db, 'registrationRequests'), where('schoolId', '==', schoolId()), where('status', '==', 'pending')), (l) => {
    l.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    q('#reg').innerHTML = l.length ? '<div class="table-wrap"><table><thead><tr><th>รหัส</th><th>ชื่อ</th><th>ห้อง</th><th class="hide-sm">ส่งเมื่อ</th><th></th></tr></thead><tbody>' + l.map((r) =>
      '<tr><td>' + esc(r.code) + '</td><td>' + esc(r.name) + '</td><td>' + esc(r.roomLabel) + '</td><td class="hide-sm small">' + fmtDate(r.createdAt) + '</td>' +
      '<td><button class="btn small" data-ok="' + esc(r.id) + '">อนุมัติ</button> <button class="btn ghost small" data-no="' + esc(r.id) + '">ปฏิเสธ</button></td></tr>').join('') + '</tbody></table></div>' : '<div class="empty">ไม่มีคำขอที่รอพิจารณา</div>';
    on('[data-ok]', 'click', (e) => after(api('admin.decideRegistration', { id: e.currentTarget.getAttribute('data-ok'), approve: true }), 'อนุมัติแล้ว นักเรียนเข้าสู่ระบบได้ทันที'), q('#reg'));
    on('[data-no]', 'click', (e) => { const reason = prompt('เหตุผลที่ปฏิเสธ (ไม่บังคับ)'); if (reason === null) return; after(api('admin.decideRegistration', { id: e.currentTarget.getAttribute('data-no'), approve: false, reason }), 'ปฏิเสธแล้ว'); }, q('#reg'));
  }, (err) => { q('#reg').innerHTML = errBox(err); });
};

// ---------------------------------------------------------------- ตั้งค่าระบบ
views.adminSettings = async () => {
  if (!hasRole('admin')) { h(errBox({ message: 'เฉพาะผู้ดูแลระบบ' })); return; }
  const secret = await fetchOne(doc(db, 'schoolSecrets', schoolId())).catch(() => null);
  const s = Object.assign({ appName: 'CWK Learning Hub', maxFileMb: 25, maxFilesPerSubmission: 10, allowedFileTypes: [], selfRegistrationEnabled: false }, session.school && session.school.settings || {});
  h(backBtn() + '<h1>ตั้งค่าระบบ</h1><form class="card" id="set" novalidate>' +
    '<label for="s-app">ชื่อระบบ</label><input id="s-app" maxlength="100" value="' + esc(s.appName) + '">' +
    '<div class="row"><div><label for="s-mb">ขนาดไฟล์สูงสุด (MB)</label><input id="s-mb" inputmode="numeric" value="' + esc(s.maxFileMb) + '"></div><div><label for="s-nf">ไฟล์ต่อการส่ง</label><input id="s-nf" inputmode="numeric" value="' + esc(s.maxFilesPerSubmission) + '"></div></div>' +
    '<label for="s-types">ชนิดไฟล์ที่รับ</label><input id="s-types" value="' + esc(s.allowedFileTypes.join(', ')) + '">' +
    '<h3>การสมัครใช้งานเองของนักเรียน</h3><label class="check"><input type="checkbox" id="s-reg"' + (s.selfRegistrationEnabled ? ' checked' : '') + '> เปิดให้นักเรียนสมัครเอง (ผู้ดูแลต้องอนุมัติ)</label>' +
    '<label for="s-code">รหัสลงทะเบียนของโรงเรียน (แจ้งนักเรียนในห้องเรียน)</label><input id="s-code" maxlength="50" value="' + esc(secret ? secret.selfRegistrationCode || '' : '') + '" autocomplete="off">' +
    '<p class="small muted">รหัสโรงเรียนสำหรับเข้าสู่ระบบ: <strong>' + esc(session.school ? session.school.code : '') + '</strong></p>' +
    '<div id="set-msg"></div><p><button class="btn" type="submit">บันทึก</button></p></form>');
  bindBack();
  q('#set').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('admin.updateSettings', { changes: { appName: q('#s-app').value, maxFileMb: q('#s-mb').value, maxFilesPerSubmission: q('#s-nf').value, allowedFileTypes: q('#s-types').value, selfRegistrationEnabled: q('#s-reg').checked, selfRegistrationCode: q('#s-code').value } });
      toast('บันทึกการตั้งค่าแล้ว — มีผลกับผู้ใช้ทุกคนทันที');
    } catch (err) { q('#set-msg').innerHTML = errBox(err); }
  });
};

void closeModal;
