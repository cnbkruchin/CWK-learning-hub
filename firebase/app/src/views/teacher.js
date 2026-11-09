/**
 * หน้าครู: รายวิชาที่สอน เปิดรายวิชา เพิ่มงาน (งานเดี่ยว/งานกลุ่ม/สอบ) นักเรียนในรายวิชา กลุ่มประจำรายวิชา ตรวจงาน
 * ทุกหน้าอ่านข้อมูลแบบเรียลไทม์ (onSnapshot) — ครูหลายคนเปิดพร้อมกันเห็นการเปลี่ยนแปลงทันที
 */
import { collection, doc, query, where } from 'firebase/firestore';
import { views, go, swap, back } from '../lib/router.js';
import { db, api, live, fetchAll, fetchOne } from '../lib/fb.js';
import {
  h, q, qa, on, esc, toast, errBox, backBtn, bindBack, fmtDate, chip, KIND, openModal, closeModal,
  isoToLocalInput, localInputToIso, pickList, bindPickAll, picked
} from '../lib/ui.js';
import { fileRows, bindFileButtons } from '../lib/files.js';
import { session, hasRole, schoolId } from '../lib/session.js';
import { OFFERING_PERMISSIONS } from '@shared/config.js';

const OFF_STATUS = { draft: ['neutral', 'ฉบับร่าง'], open: ['ok', 'เปิดสอน'], closed: ['bad', 'ปิดผลแล้ว'], archived: ['neutral', 'เก็บถาวร'] };
const A_STATUS = { draft: ['neutral', 'ยังไม่ประกาศ'], published: ['ok', 'ประกาศแล้ว'], archived: ['neutral', 'เก็บถาวร'] };
const PERM_LABELS = {
  can_view: 'ดูข้อมูล', can_grade: 'ให้คะแนน', can_edit_scores: 'แก้คะแนนที่บันทึกแล้ว', can_import: 'นำเข้าคะแนน', can_export: 'ส่งออกรายงาน',
  can_publish: 'ประกาศคะแนน', can_close: 'ปิดผลรายวิชา', can_manage: 'จัดการงาน/นักเรียน/กลุ่ม'
};
const stChip = (map, s) => '<span class="chip ' + (map[s] || ['neutral'])[0] + '">' + esc((map[s] || [0, s])[1]) + '</span>';
const after = async (pr, okMsg) => { try { const r = await pr; toast(okMsg || 'บันทึกแล้ว'); return r; } catch (err) { toast(err.message); return null; } };
const clickRows = (root, sel, fn) => qa(sel, root).forEach((el) => {
  el.addEventListener('click', (e) => { if (e.target.closest('button,a,input,select,label')) return; fn(el); });
  el.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') fn(el); });
});

/** สิทธิ์ของผู้ใช้ในรายวิชา (ฝั่งแอปใช้ซ่อน/แสดงปุ่ม — เซิร์ฟเวอร์ตรวจซ้ำทุกคำสั่ง) */
export function livePerms(oid, cb) {
  const p = {};
  OFFERING_PERMISSIONS.forEach((k) => { p[k] = false; });
  if (hasRole('admin')) Object.assign(p, { can_view: true, can_export: true, can_manage: true, can_close: true });
  if (hasRole('grade_admin')) Object.assign(p, { can_view: true, can_grade: true, can_edit_scores: true, can_publish: true });
  const base = Object.assign({}, p);
  if (!hasRole('teacher')) { cb(Object.assign({ owner: false }, base)); return; }
  live(doc(db, 'offerings', oid, 'staff', session.user.uid), (s) => {
    const out = Object.assign({ owner: false }, base);
    if (s && s.active) {
      if (s.role === 'owner') { OFFERING_PERMISSIONS.forEach((k) => { out[k] = true; }); out.owner = true; }
      else OFFERING_PERMISSIONS.forEach((k) => { if (s.perms && s.perms[k]) out[k] = true; });
    }
    cb(out);
  }, () => cb(Object.assign({ owner: false }, base)));
}

/** ข้อมูลนักเรียน (รหัส เลขที่) สำหรับครู — แคชไว้ในหน่วยความจำ */
const studentCache = new Map();
export async function loadStudents(ids) {
  const missing = ids.filter((id) => !studentCache.has(id));
  await Promise.all(missing.map(async (id) => { studentCache.set(id, await fetchOne(doc(db, 'students', id)).catch(() => null)); }));
  const out = {};
  ids.forEach((id) => { if (studentCache.get(id)) out[id] = studentCache.get(id); });
  return out;
}

// ---------------------------------------------------------------- แท็บรายวิชา
const OFF_TABS = [['teacherOffering', 'งาน'], ['offeringRoster', 'นักเรียน'], ['workGroups', 'กลุ่ม'], ['teacherQueue', 'ตรวจงาน'], ['gradebook', 'สมุดคะแนน'], ['offeringReports', 'รายงาน'], ['offeringSettings', 'ตั้งค่า']];
export function offeringHeader(p, active) {
  return backBtn() + '<h1 id="off-title">' + esc(p.title || 'รายวิชา') + '</h1>' +
    '<nav class="tabs no-print" aria-label="เมนูรายวิชา">' + OFF_TABS.map((t) => '<button class="tab' + (t[0] === active ? ' active' : '') + '" data-otab="' + t[0] + '"' + (t[0] === active ? ' aria-current="page"' : '') + '>' + t[1] + '</button>').join('') + '</nav>';
}
export function bindOfferingHeader(p) {
  bindBack();
  on('[data-otab]', 'click', (e) => swap(e.currentTarget.getAttribute('data-otab'), { offeringId: p.offeringId, title: p.title }));
  if (!p.title) fetchOne(doc(db, 'offerings', p.offeringId)).then((o) => { if (o && q('#off-title')) { p.title = o.courseCode + ' ' + o.courseName + ' (' + o.section + ')'; q('#off-title').textContent = p.title; } }).catch(() => {});
}
const offTitle = (o) => o.courseCode + ' ' + o.courseName + ' (' + o.section + ')';

// ---------------------------------------------------------------- รายวิชาที่สอน
views.teacherHome = () => {
  const wide = hasRole('admin') || hasRole('grade_admin');
  h('<h1>' + (wide ? 'รายวิชาทั้งหมดในโรงเรียน' : 'รายวิชาที่สอน') + '</h1>' +
    '<p class="no-print">' + (hasRole('teacher') || hasRole('admin') ? '<button class="btn" id="new-off">+ เปิดรายวิชา</button> <button class="btn ghost" id="new-course">+ รายวิชาในหลักสูตร</button> ' : '') +
    '<button class="btn ghost" id="rep-room">รายงาน PDF / Excel</button> <label class="check" style="display:inline-flex"><input type="checkbox" id="show-arch"> แสดงรายวิชาที่เก็บถาวร</label></p>' +
    '<div id="offs"><div class="loading">กำลังโหลด…</div></div>');
  on('#new-off', 'click', () => go('offeringForm', {}));
  on('#new-course', 'click', () => go('courseForm', {}));
  on('#rep-room', 'click', () => go('adminReports', {}));
  let list = null;
  const paint = () => {
    const box = q('#offs');
    if (!box || !list) return;
    const arch = q('#show-arch').checked;
    const rows = list.filter((o) => arch || o.status !== 'archived')
      .sort((a, b) => (b.yearBe - a.yearBe) || (b.termNo - a.termNo) || String(a.courseCode).localeCompare(String(b.courseCode), 'th', { numeric: true }) || String(a.section).localeCompare(String(b.section), 'th', { numeric: true }));
    if (!rows.length) { box.innerHTML = '<div class="card empty">ยังไม่มีรายวิชา กด "เปิดรายวิชา" เพื่อเริ่มต้น</div>'; return; }
    const byTerm = {};
    rows.forEach((o) => { const k = 'ปี ' + o.yearBe + ' ภาค ' + o.termNo; (byTerm[k] = byTerm[k] || []).push(o); });
    box.innerHTML = Object.keys(byTerm).map((k) => '<h2>' + esc(k) + '</h2><div class="grid">' + byTerm[k].map((o) =>
      '<div class="card clickable" tabindex="0" role="button" data-off="' + esc(o.id) + '" data-title="' + esc(offTitle(o)) + '">' +
      '<div class="small muted">' + esc(o.courseCode) + ' · กลุ่มเรียน ' + esc(o.section) + '</div><h3>' + esc(o.displayName || o.courseName) + '</h3>' +
      '<div class="small">' + esc(o.ownerName) + ' · นักเรียน ' + (o.activeCount || 0) + ' คน</div><p>' + stChip(OFF_STATUS, o.status) + '</p></div>').join('') + '</div>').join('');
    clickRows(box, '[data-off]', (el) => go('teacherOffering', { offeringId: el.getAttribute('data-off'), title: el.getAttribute('data-title') }));
  };
  q('#show-arch').addEventListener('change', paint);
  const base = collection(db, 'offerings');
  live(wide ? query(base, where('schoolId', '==', schoolId())) : query(base, where('schoolId', '==', schoolId()), where('staffUids', 'array-contains', session.user.uid)), (l) => { list = l; paint(); },
    (err) => { if (q('#offs')) q('#offs').innerHTML = errBox(err); });
};

// ---------------------------------------------------------------- รายวิชาในหลักสูตร
views.courseForm = async (p) => {
  const c = p.id ? await fetchOne(doc(db, 'courses', p.id)) : {};
  h(backBtn() + '<h1>' + (p.id ? 'แก้ไขรายวิชาในหลักสูตร' : 'เพิ่มรายวิชาในหลักสูตร') + '</h1><form class="card" id="cf" novalidate>' +
    '<div class="row"><div><label for="c-code">รหัสวิชา *</label><input id="c-code" required maxlength="30" value="' + esc(c.code) + '" placeholder="เช่น ว32102"></div>' +
    '<div><label for="c-credits">หน่วยกิต</label><input id="c-credits" inputmode="decimal" value="' + esc(c.credits || '') + '"></div>' +
    '<div><label for="c-hours">ชั่วโมงเรียน</label><input id="c-hours" inputmode="numeric" value="' + esc(c.hours ?? '') + '"></div></div>' +
    '<label for="c-name">ชื่อวิชา (ไทย) *</label><input id="c-name" required maxlength="200" value="' + esc(c.nameTh) + '">' +
    '<label for="c-en">ชื่อวิชา (อังกฤษ)</label><input id="c-en" maxlength="200" value="' + esc(c.nameEn) + '">' +
    '<div class="row"><div><label for="c-area">กลุ่มสาระการเรียนรู้</label><input id="c-area" maxlength="100" value="' + esc(c.learningArea) + '"></div>' +
    '<div><label for="c-level">ระดับชั้น</label><input id="c-level" maxlength="20" value="' + esc(c.gradeLevel) + '" placeholder="เช่น ม.5"></div></div>' +
    '<label for="c-desc">คำอธิบายรายวิชา</label><textarea id="c-desc" maxlength="5000">' + esc(c.description) + '</textarea>' +
    '<div id="cf-msg"></div><p><button class="btn" type="submit">บันทึก</button></p></form>');
  bindBack();
  q('#cf').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('course.save', {
        id: p.id || '', version: c.version, code: q('#c-code').value, nameTh: q('#c-name').value, nameEn: q('#c-en').value, credits: q('#c-credits').value,
        hours: q('#c-hours').value, learningArea: q('#c-area').value, gradeLevel: q('#c-level').value, description: q('#c-desc').value
      });
      toast('บันทึกรายวิชาแล้ว');
      back();
    } catch (err) { q('#cf-msg').innerHTML = errBox(err); }
  });
};

// ---------------------------------------------------------------- เปิดรายวิชา / แก้ไขรายวิชาที่เปิดสอน
views.offeringForm = async (p) => {
  const sch = schoolId();
  const isAdmin = hasRole('admin');
  const [terms, courses, teachers, o] = await Promise.all([
    fetchAll(query(collection(db, 'terms'), where('schoolId', '==', sch))),
    fetchAll(query(collection(db, 'courses'), where('schoolId', '==', sch))),
    isAdmin ? fetchAll(query(collection(db, 'teachers'), where('schoolId', '==', sch))) : Promise.resolve([]),
    p.offeringId ? fetchOne(doc(db, 'offerings', p.offeringId)) : Promise.resolve(null)
  ]);
  terms.sort((a, b) => (b.yearBe - a.yearBe) || (b.termNo - a.termNo));
  courses.sort((a, b) => String(a.code).localeCompare(String(b.code), 'th', { numeric: true }));
  const tOpts = teachers.filter((t) => t.status === 'active' && t.uid).sort((a, b) => String(a.name).localeCompare(String(b.name), 'th'));
  const editing = !!o;
  h(backBtn() + '<h1>' + (editing ? 'แก้ไขรายวิชาที่เปิดสอน' : 'เปิดรายวิชา') + '</h1><form class="card" id="of" novalidate>' +
    (editing ? '<p><strong>' + esc(o.courseCode + ' ' + o.courseName) + '</strong> · ปี ' + esc(o.yearBe) + ' ภาค ' + esc(o.termNo) + '</p>' :
      '<label for="o-term">ภาคเรียน *</label><select id="o-term" required>' + (terms.filter((t) => t.status !== 'closed').map((t) => '<option value="' + esc(t.id) + '">' + esc(t.label) + (t.status === 'planning' ? ' (วางแผน)' : '') + '</option>').join('') || '<option value="">— ยังไม่มีภาคเรียน ให้ผู้ดูแลเพิ่มปีการศึกษา —</option>') + '</select>' +
      '<label for="o-course">รายวิชาในหลักสูตร *</label><select id="o-course" required>' + (courses.filter((c) => c.status !== 'inactive').map((c) => '<option value="' + esc(c.id) + '">' + esc(c.code + ' ' + c.nameTh) + '</option>').join('') || '<option value="">— ยังไม่มีรายวิชา —</option>') + '</select>' +
      '<p class="small"><button type="button" class="btn ghost small" id="o-newcourse">+ เพิ่มรายวิชาในหลักสูตร</button></p>') +
    '<div class="row"><div><label for="o-section">กลุ่มเรียน / ห้อง *</label><input id="o-section" required maxlength="30" value="' + esc(o ? o.section : '') + '" placeholder="เช่น ม.5/1"></div>' +
    '<div><label for="o-status">สถานะ</label><select id="o-status">' + ['open', 'draft', 'archived'].map((s) => '<option value="' + s + '"' + ((o ? o.status : 'open') === s ? ' selected' : '') + '>' + OFF_STATUS[s][1] + '</option>').join('') + '</select></div></div>' +
    '<label for="o-display">ชื่อที่แสดง</label><input id="o-display" maxlength="200" value="' + esc(o ? o.displayName : '') + '" placeholder="เว้นว่างเพื่อใช้ชื่อวิชา + กลุ่มเรียน">' +
    (isAdmin ? '<label for="o-owner">ครูเจ้าของรายวิชา</label><select id="o-owner">' + (editing ? '' : '<option value="">— ตัวฉันเอง —</option>') + tOpts.map((t) => '<option value="' + esc(t.id) + '"' + (o && o.ownerTeacherId === t.id ? ' selected' : '') + '>' + esc(t.name) + '</option>').join('') + '</select>' : '') +
    '<p class="small muted">วิธีคำนวณคะแนนรวม: น้ำหนักรายรายการ Σ(น้ำหนัก × คะแนน/คะแนนเต็ม) ÷ Σน้ำหนัก × 100</p>' +
    '<div id="of-msg"></div><p><button class="btn" type="submit">' + (editing ? 'บันทึก' : 'เปิดรายวิชา') + '</button></p></form>');
  bindBack();
  on('#o-newcourse', 'click', () => go('courseForm', {}));
  q('#of').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = q('button[type=submit]', e.currentTarget); btn.disabled = true;
    try {
      const payload = { sectionCode: q('#o-section').value, displayName: q('#o-display').value, status: q('#o-status').value, calcMethod: 'per_item' };
      if (q('#o-owner') && q('#o-owner').value) payload.ownerTeacherId = q('#o-owner').value;
      if (editing) Object.assign(payload, { id: o.id, version: o.version });
      else Object.assign(payload, { termId: q('#o-term').value, courseId: q('#o-course').value });
      const r = await api('offering.save', payload);
      toast(editing ? 'บันทึกแล้ว' : 'เปิดรายวิชาแล้ว');
      if (editing) back();
      else swap('teacherOffering', { offeringId: r.offeringId });
    } catch (err) { q('#of-msg').innerHTML = errBox(err); btn.disabled = false; }
  });
};

// ---------------------------------------------------------------- แท็บงาน
views.teacherOffering = (p) => {
  const oid = p.offeringId;
  h(offeringHeader(p, 'teacherOffering') + '<div id="ta-actions" class="no-print"></div><div id="ta-sum"></div><div class="card" id="ta-list"><div class="loading">กำลังโหลด…</div></div>');
  bindOfferingHeader(p);
  let list = null, perms = null, off = null;
  const paint = () => {
    if (!list || !perms || !off) return;
    q('#ta-actions').innerHTML = perms.can_manage && off.status !== 'closed' && off.status !== 'archived' ? '<p><button class="btn" id="ta-new">+ เพิ่มงาน / รายการประเมิน</button></p>' : '';
    on('#ta-new', 'click', () => go('assessmentForm', { offeringId: oid }));
    const rows = list.slice().sort((a, b) => (a.sort || 0) - (b.sort || 0));
    const active = rows.filter((a) => a.status !== 'archived' && a.countsTowardGrade);
    const totalW = active.reduce((s, a) => s + Number(a.weight || 0), 0);
    q('#ta-sum').innerHTML = '<div class="stat"><span class="small muted">งานทั้งหมด</span><b>' + rows.filter((a) => a.status !== 'archived').length + '</b></div>' +
      '<div class="stat"><span class="small muted">งานกลุ่ม</span><b>' + rows.filter((a) => a.kind === 'group' && a.status !== 'archived').length + '</b></div>' +
      '<div class="stat"><span class="small muted">รวมน้ำหนักที่นับ</span><b>' + Math.round(totalW * 100) / 100 + '</b></div>' +
      '<div class="stat"><span class="small muted">นักเรียน</span><b>' + (off.activeCount || 0) + '</b></div>';
    q('#ta-list').innerHTML = rows.length ? '<ul class="list">' + rows.map((a) =>
      '<li class="clickable" tabindex="0" role="button" data-a="' + esc(a.id) + '"><div><strong>' + esc(a.code) + ' ' + esc(a.title) + '</strong>' +
      '<div class="small muted">' + KIND[a.kind] + ' · เต็ม ' + esc(a.maxScore) + (a.countsTowardGrade ? ' · น้ำหนัก ' + esc(a.weight) : ' · ไม่นับคะแนน') + (a.dueAt ? ' · ส่ง ' + fmtDate(a.dueAt) : '') + '</div></div>' +
      '<div>' + stChip(A_STATUS, a.status) + '</div></li>').join('') + '</ul>' : '<div class="empty">ยังไม่มีงาน</div>';
    clickRows(q('#ta-list'), '[data-a]', (el) => go('teacherAssessment', { offeringId: oid, assessmentId: el.getAttribute('data-a'), title: p.title }));
  };
  livePerms(oid, (x) => { perms = x; paint(); });
  live(doc(db, 'offerings', oid), (o) => { off = o; if (o && !p.title) { p.title = offTitle(o); q('#off-title').textContent = p.title; } paint(); });
  live(collection(db, 'offerings', oid, 'assessments'), (l) => { list = l; paint(); }, (err) => { q('#ta-list').innerHTML = errBox(err); });
};

// ---------------------------------------------------------------- ฟอร์มงาน
function assessmentPayload(a, extra) {
  return Object.assign({
    id: a.id, version: a.version, code: a.code, title: a.title, description: a.description, kind: a.kind, maxScore: a.maxScore, weight: a.weight,
    countsTowardGrade: a.countsTowardGrade, categoryId: a.categoryId || '', openAt: a.openAt, dueAt: a.dueAt, closeAt: a.closeAt, allowLate: a.allowLate,
    allowedTypes: a.allowedTypes || [], maxFiles: a.maxFiles, maxFileMb: a.maxFileMb, maxAttempts: a.maxAttempts || 0, allowLinks: a.allowLinks, group: a.group, status: a.status
  }, extra || {});
}

views.assessmentForm = async (p) => {
  const oid = p.offeringId;
  const a = p.assessmentId ? await fetchOne(doc(db, 'offerings', oid, 'assessments', p.assessmentId)) : null;
  const settings = Object.assign({ maxFileMb: 25, maxFilesPerSubmission: 10, allowedFileTypes: [] }, session.school && session.school.settings || {});
  const v = a || { kind: p.kind || 'individual', countsTowardGrade: true, status: 'draft', maxScore: '10', weight: '10', allowedTypes: [], group: { minSize: 2, maxSize: 5, submitPolicy: 'any_member' } };
  const g = v.group || { minSize: 2, maxSize: 5, submitPolicy: 'any_member' };
  h(backBtn() + '<h1>' + (a ? 'แก้ไขงาน' : 'เพิ่มงาน / รายการประเมิน') + '</h1><form class="card" id="af" novalidate>' +
    '<fieldset><legend>ประเภทงาน</legend>' + ['individual', 'group', 'exam', 'score_only'].map((k) => '<label class="check"><input type="radio" name="kind" value="' + k + '"' + (v.kind === k ? ' checked' : '') + '> ' + KIND[k] +
      ' <span class="small muted">' + { individual: 'นักเรียนส่งงานและได้คะแนนรายบุคคล', group: 'ส่งงานเป็นกลุ่ม ให้คะแนนที่กลุ่ม ระบบบันทึกเป็นคะแนนของสมาชิกทุกคนอัตโนมัติ', exam: 'ไม่มีการส่งไฟล์ ครูกรอกคะแนน', score_only: 'บันทึกคะแนนอย่างเดียว' }[k] + '</span></label>').join('') + '</fieldset>' +
    '<div class="row"><div><label for="a-code">รหัสงาน *</label><input id="a-code" required maxlength="30" value="' + esc(v.code || '') + '" placeholder="เช่น W1"></div>' +
    '<div style="flex:3"><label for="a-title">ชื่องาน *</label><input id="a-title" required maxlength="200" value="' + esc(v.title || '') + '"></div></div>' +
    '<label for="a-desc">คำชี้แจง</label><textarea id="a-desc" maxlength="10000">' + esc(v.description || '') + '</textarea>' +
    '<div class="row"><div><label for="a-max">คะแนนเต็ม *</label><input id="a-max" inputmode="decimal" value="' + esc(v.maxScore || '') + '"></div>' +
    '<div><label for="a-weight">น้ำหนักในรายวิชา</label><input id="a-weight" inputmode="decimal" value="' + esc(v.weight || '0') + '"></div>' +
    '<div><label class="check" style="margin-top:32px"><input type="checkbox" id="a-counts"' + (v.countsTowardGrade !== false ? ' checked' : '') + '> นับคะแนน</label></div></div>' +
    '<p class="small muted">คะแนนเต็มกับน้ำหนักเป็นคนละค่า: งานเต็ม 20 น้ำหนัก 10 = ได้ 15/20 คิดเป็น 7.5 จาก 10</p>' +
    '<div id="a-files-box"><h3>ช่วงเวลาและการส่งงาน</h3><div class="row"><div><label for="a-open">เปิดรับ</label><input id="a-open" type="datetime-local" value="' + isoToLocalInput(v.openAt) + '"></div>' +
    '<div><label for="a-due">กำหนดส่ง</label><input id="a-due" type="datetime-local" value="' + isoToLocalInput(v.dueAt) + '"></div>' +
    '<div><label for="a-close">ปิดรับ</label><input id="a-close" type="datetime-local" value="' + isoToLocalInput(v.closeAt) + '"></div></div>' +
    '<label class="check"><input type="checkbox" id="a-late"' + (v.allowLate ? ' checked' : '') + '> รับงานหลังกำหนดส่งได้จนถึงเวลาปิดรับ (บันทึกว่าส่งช้า)</label>' +
    '<div class="row"><div><label for="a-types">ชนิดไฟล์ที่รับ (เว้นว่าง = ตามโรงเรียน)</label><input id="a-types" value="' + esc((v.allowedTypes || []).join(', ')) + '" placeholder="' + esc(settings.allowedFileTypes.join(', ')) + '"></div>' +
    '<div><label for="a-maxfiles">ไฟล์ต่อการส่ง (≤ ' + settings.maxFilesPerSubmission + ')</label><input id="a-maxfiles" inputmode="numeric" value="' + esc(v.maxFiles || '') + '"></div>' +
    '<div><label for="a-maxmb">MB ต่อไฟล์ (≤ ' + settings.maxFileMb + ')</label><input id="a-maxmb" inputmode="numeric" value="' + esc(v.maxFileMb || '') + '"></div>' +
    '<div><label for="a-attempts">ส่งได้กี่ครั้ง (0 = ไม่จำกัด)</label><input id="a-attempts" inputmode="numeric" value="' + esc(v.maxAttempts || 0) + '"></div></div>' +
    '<label class="check"><input type="checkbox" id="a-links"' + (v.allowLinks ? ' checked' : '') + '> รับลิงก์ (เช่น Google Drive, YouTube)</label></div>' +
    '<div id="a-group-box"><h3>งานกลุ่ม</h3><p class="small muted">งานกลุ่มใช้ "กลุ่มประจำรายวิชา" (แท็บกลุ่ม) — กลุ่มเดิมทำงานได้หลายงาน รายชื่อถูกตรึงเมื่อส่งงานครั้งแรกหรือครูให้คะแนน คะแนนกลุ่มของแต่ละงานยังอยู่ที่กลุ่มเสมอ</p>' +
    '<div class="row"><div><label for="g-min">สมาชิกขั้นต่ำ</label><input id="g-min" inputmode="numeric" value="' + esc(g.minSize) + '"></div><div><label for="g-max">สมาชิกสูงสุด</label><input id="g-max" inputmode="numeric" value="' + esc(g.maxSize) + '"></div>' +
    '<div><label for="g-policy">ผู้ส่งงาน</label><select id="g-policy"><option value="any_member"' + (g.submitPolicy !== 'leader_only' ? ' selected' : '') + '>สมาชิกคนใดก็ได้</option><option value="leader_only"' + (g.submitPolicy === 'leader_only' ? ' selected' : '') + '>หัวหน้ากลุ่มเท่านั้น</option></select></div></div></div>' +
    '<label for="a-status">สถานะ</label><select id="a-status">' + ['draft', 'published', 'archived'].map((s) => '<option value="' + s + '"' + (v.status === s ? ' selected' : '') + '>' + A_STATUS[s][1] + (s === 'published' ? ' (นักเรียนเห็น)' : '') + '</option>').join('') + '</select>' +
    '<div id="af-msg"></div><p><button class="btn" type="submit">บันทึก</button></p></form>');
  bindBack();
  const sync = () => {
    const kind = (q('[name=kind]:checked') || {}).value;
    q('#a-files-box').hidden = kind === 'exam' || kind === 'score_only';
    q('#a-group-box').hidden = kind !== 'group';
    q('#a-weight').disabled = !q('#a-counts').checked;
  };
  on('[name=kind]', 'change', sync); q('#a-counts').addEventListener('change', sync); sync();
  q('#af').addEventListener('submit', async (e) => {
    e.preventDefault();
    const kind = q('[name=kind]:checked').value;
    const btn = q('button[type=submit]', e.currentTarget); btn.disabled = true;
    try {
      const r = await api('assessment.save', {
        offeringId: oid, id: a ? a.id : '', version: a ? a.version : undefined, kind, code: q('#a-code').value, title: q('#a-title').value, description: q('#a-desc').value,
        maxScore: q('#a-max').value.trim(), weight: q('#a-counts').checked ? q('#a-weight').value.trim() : '0', countsTowardGrade: q('#a-counts').checked,
        openAt: localInputToIso(q('#a-open').value), dueAt: localInputToIso(q('#a-due').value), closeAt: localInputToIso(q('#a-close').value), allowLate: q('#a-late').checked,
        allowedTypes: q('#a-types').value, maxFiles: q('#a-maxfiles').value, maxFileMb: q('#a-maxmb').value, maxAttempts: q('#a-attempts').value || 0, allowLinks: q('#a-links').checked,
        group: kind === 'group' ? { minSize: q('#g-min').value, maxSize: q('#g-max').value, submitPolicy: q('#g-policy').value } : null, status: q('#a-status').value
      });
      toast('บันทึกงานแล้ว');
      if (a) back(); else swap('teacherAssessment', { offeringId: oid, assessmentId: r.id });
    } catch (err) { q('#af-msg').innerHTML = errBox(err); btn.disabled = false; }
  });
};

// ---------------------------------------------------------------- รายละเอียดงาน (ครู)
views.teacherAssessment = (p) => {
  const oid = p.offeringId, aid = p.assessmentId;
  h(backBtn() + '<div id="tad"><div class="loading">กำลังโหลด…</div></div>');
  bindBack();
  const st = { a: null, subs: null, groups: [], roster: null, exts: [], perms: null };
  const paint = () => {
    const { a, subs, roster, perms } = st;
    if (!a || !subs || !roster || !perms) return;
    const names = Object.fromEntries(roster.map((r) => [r.id, r]));
    const activeRoster = roster.filter((r) => r.active);
    const isGroup = a.kind === 'group';
    const owners = isGroup ? st.groups.filter((g) => g.status !== 'disbanded' || g.frozen) : activeRoster;
    const submitted = subs.filter((s) => s.currentVersionNo > 0);
    const pending = submitted.filter((s) => s.status === 'submitted' || s.status === 'resubmitted');
    const files = a.submissionMode !== 'none';
    q('#tad').innerHTML = '<div class="breadcrumb">' + esc(p.title || '') + '</div><h1>' + esc(a.code) + ' ' + esc(a.title) + '</h1><p>' + stChip(A_STATUS, a.status) + ' <span class="chip info">' + KIND[a.kind] + '</span></p>' +
      '<div class="card"><dl class="kv"><dt>คะแนนเต็ม</dt><dd>' + esc(a.maxScore) + '</dd><dt>น้ำหนัก</dt><dd>' + (a.countsTowardGrade ? esc(a.weight) : 'ไม่นับคะแนน') + '</dd>' +
      (a.openAt ? '<dt>เปิดรับ</dt><dd>' + fmtDate(a.openAt) + '</dd>' : '') + (a.dueAt ? '<dt>กำหนดส่ง</dt><dd>' + fmtDate(a.dueAt) + '</dd>' : '') + (a.closeAt ? '<dt>ปิดรับ</dt><dd>' + fmtDate(a.closeAt) + '</dd>' : '') +
      (isGroup && a.group ? '<dt>กลุ่ม</dt><dd>' + a.group.minSize + '–' + a.group.maxSize + ' คน · ' + (a.group.submitPolicy === 'leader_only' ? 'หัวหน้าส่ง' : 'สมาชิกคนใดก็ส่งได้') + '</dd>' : '') + '</dl>' +
      (a.description ? '<p style="white-space:pre-wrap">' + esc(a.description) + '</p>' : '') + '</div>' +
      '<p class="no-print">' + (perms.can_grade ? '<button class="btn" id="go-grade">' + (isGroup ? 'ให้คะแนนกลุ่ม' : 'ให้คะแนน') + '</button> ' : '') +
      (perms.can_manage ? '<button class="btn ghost" id="go-edit">แก้ไขงาน</button> <button class="btn ghost" id="go-pub">' + (a.status === 'published' ? 'ซ่อนจากนักเรียน' : 'ประกาศงานให้นักเรียนเห็น') + '</button>' : '') + '</p>' +
      (files ? '<div class="card"><h2 style="margin-top:0">การส่งงาน</h2><div class="stat"><span class="small muted">ส่งแล้ว</span><b>' + submitted.length + ' / ' + owners.length + '</b></div>' +
        '<div class="stat"><span class="small muted">รอตรวจ</span><b>' + pending.length + '</b></div><div class="stat"><span class="small muted">ส่งช้า</span><b>' + submitted.filter((s) => s.latest && s.latest.isLate).length + '</b></div>' +
        '<div class="table-wrap"><table><thead><tr><th>' + (isGroup ? 'กลุ่ม' : 'นักเรียน') + '</th><th>สถานะ</th><th class="hide-sm">ส่งล่าสุด</th><th></th></tr></thead><tbody>' +
        owners.map((o) => {
          const s = subs.find((x) => x.ownerId === o.id);
          const label = isGroup ? esc(o.name) + ' <span class="small muted">(' + (o.memberIds || []).length + ' คน)</span>' : esc(o.name) + ' <span class="small muted">' + esc(o.roomLabel) + '</span>';
          const status = !s || !s.currentVersionNo ? '<span class="chip warn">ยังไม่ส่ง</span>' : chip(s.status === 'accepted' ? 'accepted' : s.status === 'returned' ? 'returned' : s.latest && s.latest.isLate ? 'late' : s.status === 'resubmitted' ? 'resubmitted' : 'submitted',
            { accepted: 'รับประเมินแล้ว', returned: 'ส่งคืนแก้ไข', submitted: 'รอตรวจ', resubmitted: 'ส่งใหม่ รอตรวจ' }[s.status] + (s.latest && s.latest.isLate ? ' (ช้า)' : ''));
          return '<tr><td>' + label + '</td><td>' + status + '</td><td class="hide-sm small">' + (s && s.lastSubmittedAt ? fmtDate(s.lastSubmittedAt) + ' · รุ่น ' + s.currentVersionNo : '') + '</td>' +
            '<td>' + (s && s.currentVersionNo ? '<button class="btn ghost small" data-sub="' + esc(s.id) + '">ดูงาน</button>' : '') + '</td></tr>';
        }).join('') + '</tbody></table></div></div>' : '') +
      (isGroup ? groupSection(st, names) : '') +
      (files && perms.can_manage ? '<div class="card no-print"><h2 style="margin-top:0">ขยายเวลา</h2>' +
        (st.exts.length ? '<ul>' + st.exts.map((x) => '<li>' + esc(x.targetType === 'group' ? (st.groups.find((g) => g.id === x.targetId) || {}).name || x.targetId : (names[x.targetId] || {}).name || x.targetId) + ' → ส่ง ' + fmtDate(x.dueAt) + (x.closeAt ? ' ปิด ' + fmtDate(x.closeAt) : '') + ' <span class="small muted">' + esc(x.reason) + '</span></li>').join('') + '</ul>' : '') +
        '<div class="row"><div><label for="ex-target">' + (isGroup ? 'กลุ่ม' : 'นักเรียน') + '</label><select id="ex-target">' + owners.map((o) => '<option value="' + esc(o.id) + '">' + esc(o.name) + '</option>').join('') + '</select></div>' +
        '<div><label for="ex-due">กำหนดส่งใหม่</label><input id="ex-due" type="datetime-local"></div><div><label for="ex-close">ปิดรับใหม่</label><input id="ex-close" type="datetime-local"></div></div>' +
        '<label for="ex-reason">เหตุผล *</label><input id="ex-reason" maxlength="500"><div id="ex-msg"></div><p><button class="btn ghost" id="ex-save">บันทึกการขยายเวลา</button></p></div>' : '');
    on('#go-grade', 'click', () => go(isGroup ? 'groupGrading' : 'gradeEntry', { offeringId: oid, assessmentId: aid, title: p.title }));
    on('#go-edit', 'click', () => go('assessmentForm', { offeringId: oid, assessmentId: aid }));
    on('#go-pub', 'click', () => after(api('assessment.save', assessmentPayload(a, { offeringId: oid, status: a.status === 'published' ? 'draft' : 'published' })), a.status === 'published' ? 'ซ่อนงานแล้ว' : 'ประกาศงานแล้ว นักเรียนเห็นทันที'));
    on('[data-sub]', 'click', (e) => go('submissionDetail', { offeringId: oid, submissionId: e.currentTarget.getAttribute('data-sub') }));
    on('#ex-save', 'click', async () => {
      try {
        await api('assessment.extend', { offeringId: oid, assessmentId: aid, targetType: isGroup ? 'group' : 'student', targetId: q('#ex-target').value, dueAt: localInputToIso(q('#ex-due').value), closeAt: localInputToIso(q('#ex-close').value), reason: q('#ex-reason').value });
        toast('ขยายเวลาแล้ว');
      } catch (err) { q('#ex-msg').innerHTML = errBox(err); }
    });
    on('[data-move]', 'click', (e) => moveFrozen(oid, aid, e.currentTarget.getAttribute('data-move'), st, names));
  };
  livePerms(oid, (x) => { st.perms = x; paint(); });
  live(doc(db, 'offerings', oid, 'assessments', aid), (a) => { st.a = a; if (!a) q('#tad').innerHTML = errBox({ message: 'ไม่พบงานนี้' }); else paint(); });
  live(query(collection(db, 'offerings', oid, 'submissions'), where('assessmentId', '==', aid)), (l) => { st.subs = l; paint(); });
  live(query(collection(db, 'offerings', oid, 'groups'), where('assessmentId', '==', aid)), (l) => { st.groups = l.sort((x, y) => String(x.name).localeCompare(String(y.name), 'th', { numeric: true })); paint(); });
  live(collection(db, 'offerings', oid, 'roster'), (l) => { st.roster = l; paint(); });
  live(query(collection(db, 'offerings', oid, 'extensions'), where('assessmentId', '==', aid)), (l) => { st.exts = l; paint(); });
};

function groupSection(st, names) {
  const groups = st.groups.filter((g) => g.status !== 'disbanded' || g.frozen);
  const inGroup = new Set(groups.flatMap((g) => g.memberIds || []));
  const loose = st.roster.filter((r) => r.active && !inGroup.has(r.id));
  return '<div class="card"><h2 style="margin-top:0">กลุ่มของงานนี้</h2><p class="small muted">สมาชิกซิงก์จากกลุ่มประจำรายวิชาจนกว่าจะตรึงรายชื่อ (ส่งงานครั้งแรกหรือครูให้คะแนน) หลังตรึงแล้วการย้ายสมาชิกต้องระบุเหตุผล</p>' +
    (groups.length ? groups.map((g) => '<div class="file-row"><div><strong>' + esc(g.name) + '</strong> ' + (g.frozen ? '<span class="chip ok">ตรึงแล้ว (ชุดที่ ' + (g.snapshotNo || 1) + ')</span>' : '<span class="chip neutral">ยังไม่ตรึง</span>') +
      '<div class="small">' + (g.memberIds || []).map((id) => (id === g.leaderStudentId ? '★ ' : '') + esc((names[id] || {}).name || id) + (st.perms.can_manage && g.frozen ? ' <button class="btn ghost small" data-move="' + esc(id) + '" aria-label="ย้าย ' + esc((names[id] || {}).name || id) + '">ย้าย</button>' : '')).join(', ') + '</div></div></div>').join('')
      : '<p class="muted">ยังไม่มีกลุ่ม — จัดกลุ่มที่แท็บ "กลุ่ม" ของรายวิชา</p>') +
    (loose.length ? '<p class="small"><strong>ยังไม่มีกลุ่มในงานนี้:</strong> ' + loose.map((r) => esc(r.name) + (st.perms.can_manage && groups.some((g) => g.frozen) ? ' <button class="btn ghost small" data-move="' + esc(r.id) + '">ใส่กลุ่ม</button>' : '')).join(', ') + '</p>' : '') + '</div>';
}

/** ย้ายนักเรียนเข้ากลุ่มของงานที่ตรึงแล้ว: ดูผลกระทบก่อน → ยืนยันพร้อมเหตุผล */
async function moveFrozen(oid, aid, studentId, st, names) {
  const groups = st.groups.filter((g) => g.status !== 'disbanded' && !(g.memberIds || []).includes(studentId));
  openModal('<h2 id="modal-title" style="margin-top:0">ย้าย ' + esc((names[studentId] || {}).name || studentId) + '</h2><label for="mv-to">ไปกลุ่ม</label><select id="mv-to">' + groups.map((g) => '<option value="' + esc(g.id) + '">' + esc(g.name) + '</option>').join('') + '</select>' +
    '<div id="mv-impact"></div><label for="mv-reason">เหตุผล *</label><input id="mv-reason" maxlength="500"><div id="mv-msg"></div><p><button class="btn" id="mv-check">ตรวจผลกระทบ</button> <button class="btn" id="mv-ok" hidden>ยืนยันย้าย</button> <button class="btn ghost" data-close>ยกเลิก</button></p>');
  q('#mv-check').addEventListener('click', async () => {
    try {
      const r = await api('group.moveFrozen', { offeringId: oid, assessmentId: aid, studentId, toGroupId: q('#mv-to').value });
      if (r.unchanged) { closeModal(); return; }
      q('#mv-impact').innerHTML = '<div class="notice warn"><ul>' + (r.impact || []).map((x) => '<li><strong>' + esc(x.groupName) + '</strong>: ส่งแล้ว ' + x.submittedVersions + ' รุ่น' + (x.hasGroupGrade ? ' · มีคะแนนกลุ่มแล้ว' : '') + '</li>').join('') + '</ul><p class="small">' + esc(((r.impact || [])[0] || {}).note || '') + '</p></div>';
      q('#mv-ok').hidden = false;
    } catch (err) { q('#mv-msg').innerHTML = errBox(err); }
  });
  q('#mv-ok').addEventListener('click', async () => {
    try { await api('group.moveFrozen', { offeringId: oid, assessmentId: aid, studentId, toGroupId: q('#mv-to').value, confirm: true, reason: q('#mv-reason').value }); toast('ย้ายแล้ว'); closeModal(); } catch (err) { q('#mv-msg').innerHTML = errBox(err); }
  });
}

// ---------------------------------------------------------------- นักเรียนในรายวิชา
views.offeringRoster = (p) => {
  const oid = p.offeringId;
  h(offeringHeader(p, 'offeringRoster') + '<div id="join-box"></div><div id="enr-box" class="card"><div class="loading">กำลังโหลด…</div></div><div id="add-box"></div>');
  bindOfferingHeader(p);
  const st = { off: null, enrs: null, roster: null, perms: null, students: {} };
  let addOpen = false, seq = 0;
  const paint = async () => {
    const { off, enrs, roster, perms } = st;
    if (!off || !enrs || !roster || !perms) return;
    const mine = ++seq;
    const names = Object.fromEntries(roster.map((r) => [r.id, r]));
    st.students = await loadStudents(enrs.map((e) => e.id));
    if (mine !== seq || !q('#enr-box')) return; // มีข้อมูลใหม่กว่าเข้ามาระหว่างรอ
    const row = (e) => { const s = st.students[e.id] || {}; const r = names[e.id] || {}; return { id: e.id, code: s.code || '', name: r.name || s.name || e.id, room: r.roomLabel || s.roomLabel || '', rollNo: s.rollNo, e }; };
    const sortFn = (a, b) => String(a.room).localeCompare(String(b.room), 'th', { numeric: true }) || (Number(a.rollNo || 0) - Number(b.rollNo || 0)) || String(a.code).localeCompare(String(b.code), 'th', { numeric: true });
    const active = enrs.filter((e) => e.status === 'active').map(row).sort(sortFn);
    const left = enrs.filter((e) => e.status !== 'active').map(row).sort(sortFn);
    const manage = perms.can_manage && off.status !== 'closed' && off.status !== 'archived';
    q('#join-box').innerHTML = manage ? '<div class="card no-print"><h2 style="margin-top:0">ให้นักเรียนลงทะเบียนเอง</h2>' +
      (off.joinEnabled ? '<p>รหัสเข้าร่วมรายวิชา</p><div class="big-code">' + esc(off.joinCode) + '</div><p class="small muted">นักเรียนกรอกรหัสนี้ที่หน้า "รายวิชาของฉัน"</p><p><button class="btn ghost small" id="jc-new">สร้างรหัสใหม่</button> <button class="btn ghost small" id="jc-off">ปิดรหัส</button></p>'
        : '<p class="muted">ปิดอยู่ — เปิดเพื่อสร้างรหัสให้นักเรียนลงทะเบียนเอง</p><p><button class="btn ghost" id="jc-on">เปิดรหัสเข้าร่วม</button></p>') + '</div>' : '';
    q('#enr-box').innerHTML = '<h2 style="margin-top:0">นักเรียนที่ลงทะเบียน (' + active.length + ' คน)</h2>' +
      (manage ? '<p class="no-print"><button class="btn" id="add-toggle">' + (addOpen ? 'ปิดการเพิ่มนักเรียน' : '+ เพิ่มนักเรียนจากรายชื่อในระบบ') + '</button></p>' : '') +
      (active.length ? '<div class="table-wrap"><table><thead><tr><th>ที่</th><th>รหัส</th><th>ชื่อ - สกุล</th><th>ห้อง</th><th class="hide-sm">ที่มา</th><th></th></tr></thead><tbody>' +
        active.map((r, i) => '<tr><td>' + (i + 1) + '</td><td>' + esc(r.code) + '</td><td>' + esc(r.name) + '</td><td>' + esc(r.room) + '</td><td class="hide-sm small">' + (r.e.source === 'self' ? 'ลงทะเบียนเอง' : 'ครูเพิ่ม') + '</td>' +
          '<td>' + (manage ? '<button class="btn ghost small" data-wd="' + esc(r.id) + '" aria-label="ถอน ' + esc(r.name) + '">ถอน</button>' : '') + '</td></tr>').join('') + '</tbody></table></div>' : '<div class="empty">ยังไม่มีนักเรียน</div>') +
      (left.length ? '<h3>ถอน/ย้ายออก (' + left.length + ')</h3><ul>' + left.map((r) => '<li>' + esc(r.code) + ' ' + esc(r.name) + ' <span class="small muted">' + esc(r.e.status === 'withdrawn' ? 'ถอน' : 'ย้ายออก') + (r.e.reason ? ' — ' + esc(r.e.reason) : '') + '</span>' +
        (manage ? ' <button class="btn ghost small" data-re="' + esc(r.id) + '">ลงทะเบียนอีกครั้ง</button>' : '') + '</li>').join('') + '</ul>' : '');
    on('#jc-on', 'click', () => after(api('offering.setJoin', { offeringId: oid, enabled: true }), 'เปิดรหัสเข้าร่วมแล้ว'));
    on('#jc-new', 'click', () => { if (confirm('สร้างรหัสใหม่? รหัสเดิมจะใช้ไม่ได้')) after(api('offering.setJoin', { offeringId: oid, enabled: true, regenerate: true }), 'สร้างรหัสใหม่แล้ว'); });
    on('#jc-off', 'click', () => after(api('offering.setJoin', { offeringId: oid, enabled: false }), 'ปิดรหัสแล้ว'));
    on('#add-toggle', 'click', () => { addOpen = !addOpen; paint(); if (addOpen) addPanel(); else q('#add-box').innerHTML = ''; });
    on('[data-wd]', 'click', (e) => {
      const id = e.currentTarget.getAttribute('data-wd');
      const reason = prompt('เหตุผลการถอน ' + ((names[id] || {}).name || '') + ' (คะแนนเดิมยังเก็บไว้)');
      if (reason) after(api('offering.withdraw', { offeringId: oid, studentId: id, reason }), 'ถอนแล้ว');
    });
    on('[data-re]', 'click', (e) => after(api('offering.enroll', { offeringId: oid, studentIds: [e.currentTarget.getAttribute('data-re')], reason: 'ลงทะเบียนอีกครั้ง' }), 'ลงทะเบียนแล้ว'));
  };
  async function addPanel() {
    const box = q('#add-box');
    box.innerHTML = '<div class="card"><div class="loading">กำลังโหลดรายชื่อนักเรียน…</div></div>';
    const all = await fetchAll(query(collection(db, 'students'), where('schoolId', '==', schoolId()), where('status', '==', 'active')));
    const enrolled = new Set((st.enrs || []).filter((e) => e.status === 'active').map((e) => e.id));
    const pool = all.filter((s) => !enrolled.has(s.id));
    const rooms = [...new Set(pool.map((s) => s.roomLabel))].sort((a, b) => a.localeCompare(b, 'th', { numeric: true }));
    box.innerHTML = '<div class="card"><h2 style="margin-top:0">เพิ่มนักเรียน</h2><div class="row"><div><label for="ad-room">ห้อง</label><select id="ad-room"><option value="">ทุกห้อง</option>' + rooms.map((r) => '<option>' + esc(r) + '</option>').join('') + '</select></div>' +
      '<div><label for="ad-q">ค้นหา (ชื่อ/รหัส)</label><input id="ad-q" type="search"></div></div><div id="ad-list"></div><div id="ad-msg"></div><p><button class="btn" id="ad-save">ลงทะเบียนนักเรียนที่เลือก</button></p></div>';
    const list = () => {
      const room = q('#ad-room').value, kw = q('#ad-q').value.trim().toLowerCase();
      const rows = pool.filter((s) => (!room || s.roomLabel === room) && (!kw || (s.name + ' ' + s.code).toLowerCase().includes(kw)))
        .sort((a, b) => String(a.roomLabel).localeCompare(String(b.roomLabel), 'th', { numeric: true }) || (Number(a.rollNo || 0) - Number(b.rollNo || 0)));
      q('#ad-list').innerHTML = pickList('add', rows.slice(0, 500).map((s) => ({ id: s.id, code: s.code, name: s.name, roomLabel: s.roomLabel })), { empty: 'ไม่พบนักเรียนที่ยังไม่ได้ลงทะเบียน', label: 'นักเรียนที่เลือกได้' });
      bindPickAll(q('#ad-list'));
    };
    q('#ad-room').addEventListener('change', list); q('#ad-q').addEventListener('input', list); list();
    q('#ad-save').addEventListener('click', async () => {
      const ids = picked('add', box);
      if (!ids.length) { q('#ad-msg').innerHTML = errBox({ message: 'ยังไม่ได้เลือกนักเรียน' }); return; }
      try {
        const r = await api('offering.enroll', { offeringId: oid, studentIds: ids });
        toast('เพิ่ม ' + (r.added + r.reactivated) + ' คน' + (r.skipped ? ' (ข้าม ' + r.skipped + ' คนที่ลงทะเบียนอยู่แล้ว)' : ''));
        addOpen = false; box.innerHTML = ''; paint();
      } catch (err) { q('#ad-msg').innerHTML = errBox(err); }
    });
  }
  livePerms(oid, (x) => { st.perms = x; paint(); });
  live(doc(db, 'offerings', oid), (o) => { st.off = o; paint(); });
  live(collection(db, 'offerings', oid, 'enrollments'), (l) => { st.enrs = l; paint(); });
  live(collection(db, 'offerings', oid, 'roster'), (l) => { st.roster = l; paint(); });
};

// ---------------------------------------------------------------- กลุ่มประจำรายวิชา (ครู)
views.workGroups = (p) => {
  const oid = p.offeringId;
  h(offeringHeader(p, 'workGroups') + '<div id="wg-box"><div class="loading">กำลังโหลด…</div></div>');
  bindOfferingHeader(p);
  const st = { off: null, wgs: null, roster: null, perms: null };
  const paint = () => {
    const { off, wgs, roster, perms } = st;
    if (!off || !wgs || !roster || !perms) return;
    const gs = off.groupSettings || {};
    const manage = perms.can_manage && off.status !== 'closed' && off.status !== 'archived';
    const names = Object.fromEntries(roster.map((r) => [r.id, r]));
    const active = wgs.filter((w) => w.status === 'active').sort((a, b) => String(a.name).localeCompare(String(b.name), 'th', { numeric: true }));
    const loose = roster.filter((r) => r.active && !r.workGroupId).sort((a, b) => String(a.roomLabel).localeCompare(String(b.roomLabel), 'th', { numeric: true }) || String(a.name).localeCompare(String(b.name), 'th'));
    const looseItems = loose.map((r) => ({ id: r.id, name: r.name, roomLabel: r.roomLabel }));
    const keep = { create: picked('wgnew', q('#wg-box')) };
    let html = '<p class="small muted">กลุ่มประจำรายวิชาใช้ทำงานกลุ่มได้หลายงาน · นักเรียนหนึ่งคนอยู่ได้หนึ่งกลุ่ม · หัวหน้ากลุ่มเลือกสมาชิกเองได้ · ครูเพิ่ม/ย้ายสมาชิกได้ทุกเมื่อ (ยกเว้นงานที่ตรึงรายชื่อแล้ว)</p>' +
      '<div class="stat"><span class="small muted">กลุ่ม</span><b>' + active.length + '</b></div><div class="stat"><span class="small muted">ยังไม่มีกลุ่ม</span><b>' + loose.length + '</b></div>' +
      (gs.locked ? '<div class="notice warn">ล็อกการจัดกลุ่มอยู่ — นักเรียนสร้าง/เชิญ/ออกจากกลุ่มเองไม่ได้</div>' : '');
    if (manage) {
      html += '<details class="card no-print"><summary><strong>ตั้งค่าการจัดกลุ่ม</strong></summary><div class="row"><div><label for="gs-max">สมาชิกสูงสุดต่อกลุ่ม (0 = ไม่จำกัด)</label><input id="gs-max" inputmode="numeric" value="' + esc(gs.maxSize || 0) + '"></div></div>' +
        '<label class="check"><input type="checkbox" id="gs-direct"' + (gs.leaderDirectAdd ? ' checked' : '') + '> หัวหน้ากลุ่มเพิ่มสมาชิกได้ทันที (ไม่ต้องรอตอบรับคำเชิญ)</label>' +
        '<label class="check"><input type="checkbox" id="gs-lock"' + (gs.locked ? ' checked' : '') + '> ล็อกการจัดกลุ่ม (นักเรียนเปลี่ยนเองไม่ได้)</label><p><button class="btn ghost" id="gs-save">บันทึกการตั้งค่า</button></p></details>' +
        '<details class="card no-print"><summary><strong>สร้างกลุ่มและเลือกสมาชิก</strong></summary><label for="wg-name">ชื่อกลุ่ม</label><input id="wg-name" maxlength="100" placeholder="เช่น กลุ่ม 1">' +
        '<label>เลือกสมาชิกจากนักเรียนที่ยังไม่มีกลุ่ม</label>' + pickList('wgnew', looseItems, { empty: 'นักเรียนทุกคนมีกลุ่มแล้ว', label: 'นักเรียนที่ยังไม่มีกลุ่ม' }) +
        '<label for="wg-leader">หัวหน้ากลุ่ม</label><select id="wg-leader"><option value="">— คนแรกที่เลือก —</option>' + looseItems.map((s) => '<option value="' + esc(s.id) + '">' + esc(s.name) + '</option>').join('') + '</select>' +
        '<div id="wg-msg"></div><p><button class="btn" id="wg-create">สร้างกลุ่ม</button></p></details>' +
        '<details class="card no-print"><summary><strong>จัดกลุ่มอัตโนมัติ</strong></summary><p class="small muted">สุ่มนักเรียนที่ยังไม่มีกลุ่มเป็นกลุ่มละ N คน</p><div class="row"><div><label for="au-size">คนต่อกลุ่ม</label><input id="au-size" inputmode="numeric" value="4"></div>' +
        '<div><label class="check" style="margin-top:32px"><input type="checkbox" id="au-room" checked> แยกตามห้อง</label></div></div><p><button class="btn ghost" id="au-go">จัดกลุ่ม</button></p></details>';
    }
    html += active.length ? '<div class="grid">' + active.map((w) => '<div class="card"><h3 style="margin-top:0">' + esc(w.name) + ' <span class="small muted">(' + (w.memberIds || []).length + (gs.maxSize ? '/' + gs.maxSize : '') + ' คน)</span></h3><ul class="member-list">' +
      (w.memberIds || []).map((id) => '<li><span>' + (id === w.leaderStudentId ? '★ ' : '') + esc((names[id] || {}).name || id) + ' <span class="small muted">' + esc((names[id] || {}).roomLabel || '') + '</span>' + (id === w.leaderStudentId ? ' <span class="chip info">หัวหน้า</span>' : '') + '</span>' +
        (manage ? '<span>' + (id !== w.leaderStudentId ? '<button class="btn ghost small" data-leader="' + esc(w.id) + '" data-sid="' + esc(id) + '">ตั้งเป็นหัวหน้า</button> ' : '') + '<button class="btn ghost small" data-rm="' + esc(w.id) + '" data-sid="' + esc(id) + '">นำออก</button></span>' : '') + '</li>').join('') + '</ul>' +
      ((w.invitedIds || []).length ? '<p class="small muted">รอตอบรับ: ' + w.invitedIds.map((id) => esc((names[id] || {}).name || id) + (manage ? ' <button class="btn ghost small" data-rm="' + esc(w.id) + '" data-sid="' + esc(id) + '">ยกเลิก</button>' : '')).join(', ') + '</p>' : '') +
      (manage ? '<p class="no-print"><button class="btn ghost small" data-add="' + esc(w.id) + '">+ เพิ่มสมาชิก</button> <button class="btn ghost small" data-ren="' + esc(w.id) + '">เปลี่ยนชื่อ</button> <button class="btn ghost small" data-dis="' + esc(w.id) + '">ยุบกลุ่ม</button></p>' : '') + '</div>').join('') + '</div>'
      : '<div class="card empty">ยังไม่มีกลุ่ม</div>';
    if (loose.length) html += '<div class="card"><h3 style="margin-top:0">ยังไม่มีกลุ่ม (' + loose.length + ')</h3><p>' + loose.map((r) => esc(r.name) + ' <span class="small muted">' + esc(r.roomLabel) + '</span>').join(', ') + '</p></div>';
    q('#wg-box').innerHTML = html;
    keep.create.forEach((v) => { const el = q('[name="wgnew"][value="' + v + '"]'); if (el) el.checked = true; });
    bindPickAll(q('#wg-box'));
    on('#gs-save', 'click', () => after(api('wg.settings', { offeringId: oid, maxSize: q('#gs-max').value, leaderDirectAdd: q('#gs-direct').checked, locked: q('#gs-lock').checked })));
    on('#wg-create', 'click', async () => {
      const ids = picked('wgnew', q('#wg-box'));
      try {
        await api('wg.save', { offeringId: oid, name: q('#wg-name').value, studentIds: ids, leaderStudentId: q('#wg-leader').value || ids[0] || '' });
        toast('สร้างกลุ่มแล้ว');
      } catch (err) { q('#wg-msg').innerHTML = errBox(err); }
    });
    on('#au-go', 'click', async () => {
      const r = await after(api('wg.auto', { offeringId: oid, size: q('#au-size').value, byRoom: q('#au-room').checked }), 'จัดกลุ่มแล้ว');
      if (r) toast('สร้าง ' + r.created + ' กลุ่ม จากนักเรียน ' + r.students + ' คน');
    });
    on('[data-leader]', 'click', (e) => {
      const w = active.find((x) => x.id === e.currentTarget.getAttribute('data-leader'));
      after(api('wg.save', { offeringId: oid, id: w.id, version: w.version, name: w.name, leaderStudentId: e.currentTarget.getAttribute('data-sid') }), 'เปลี่ยนหัวหน้ากลุ่มแล้ว');
    });
    on('[data-rm]', 'click', (e) => after(api('wg.removeMember', { offeringId: oid, workGroupId: e.currentTarget.getAttribute('data-rm'), studentId: e.currentTarget.getAttribute('data-sid') }), 'นำออกแล้ว'));
    on('[data-ren]', 'click', (e) => {
      const w = active.find((x) => x.id === e.currentTarget.getAttribute('data-ren'));
      const name = prompt('ชื่อกลุ่มใหม่', w.name);
      if (name) after(api('wg.save', { offeringId: oid, id: w.id, version: w.version, name }));
    });
    on('[data-dis]', 'click', (e) => { if (confirm('ยุบกลุ่มนี้? สมาชิกจะกลับเป็น "ยังไม่มีกลุ่ม" (งานที่ตรึงรายชื่อแล้วไม่เปลี่ยน)')) after(api('wg.disband', { offeringId: oid, workGroupId: e.currentTarget.getAttribute('data-dis') }), 'ยุบกลุ่มแล้ว'); });
    on('[data-add]', 'click', (e) => {
      const wid = e.currentTarget.getAttribute('data-add');
      const cands = roster.filter((r) => r.active && r.workGroupId !== wid).map((r) => ({ id: r.id, name: r.name + (r.workGroupId ? ' (ย้ายจาก ' + ((wgs.find((w) => w.id === r.workGroupId) || {}).name || 'กลุ่มอื่น') + ')' : ''), roomLabel: r.roomLabel }));
      openModal('<h2 id="modal-title" style="margin-top:0">เพิ่มสมาชิกเข้า ' + esc((active.find((w) => w.id === wid) || {}).name) + '</h2>' + pickList('addm', cands, { empty: 'ไม่มีนักเรียน' }) + '<div id="am-msg"></div><p><button class="btn" id="am-ok">เพิ่ม</button> <button class="btn ghost" data-close>ยกเลิก</button></p>');
      bindPickAll(q('#modal'));
      q('#am-ok').addEventListener('click', async () => {
        try {
          const r = await api('wg.addMembers', { offeringId: oid, workGroupId: wid, studentIds: picked('addm', q('#modal')) });
          toast('เพิ่มแล้ว' + (r.moved ? ' (ย้ายจากกลุ่มเดิม ' + r.moved + ' คน)' : '') + (r.overMax ? ' — เกินจำนวนสูงสุดที่ตั้งไว้' : ''));
          closeModal();
        } catch (err) { q('#am-msg').innerHTML = errBox(err); }
      });
    });
  };
  livePerms(oid, (x) => { st.perms = x; paint(); });
  live(doc(db, 'offerings', oid), (o) => { st.off = o; paint(); });
  live(collection(db, 'offerings', oid, 'workGroups'), (l) => { st.wgs = l; paint(); });
  live(collection(db, 'offerings', oid, 'roster'), (l) => { st.roster = l; paint(); });
};

// ---------------------------------------------------------------- คิวตรวจงาน
views.teacherQueue = (p) => {
  const oid = p.offeringId;
  h(offeringHeader(p, 'teacherQueue') + '<div class="card" id="tq"><div class="loading">กำลังโหลด…</div></div>');
  bindOfferingHeader(p);
  let subs = null, as = null;
  const paint = () => {
    if (!subs || !as) return;
    const byA = Object.fromEntries(as.map((a) => [a.id, a]));
    const rows = subs.slice().sort((x, y) => String(x.lastSubmittedAt).localeCompare(String(y.lastSubmittedAt)));
    q('#tq').innerHTML = '<h2 style="margin-top:0">งานรอตรวจ (' + rows.length + ')</h2><p class="small muted"><span class="live-dot"></span>รายการใหม่ปรากฏทันทีเมื่อนักเรียนกดส่ง</p>' +
      (rows.length ? '<ul class="list">' + rows.map((s) => '<li class="clickable" tabindex="0" role="button" data-sub="' + esc(s.id) + '"><div><strong>' + esc(s.ownerName) + '</strong> <span class="small muted">' + (s.ownerType === 'group' ? 'กลุ่ม' : '') + '</span>' +
        '<div class="small">' + esc((byA[s.assessmentId] || {}).code || '') + ' ' + esc((byA[s.assessmentId] || {}).title || '') + ' · รุ่น ' + s.currentVersionNo + ' · ' + fmtDate(s.lastSubmittedAt) + '</div></div>' +
        '<div>' + (s.latest && s.latest.isLate ? '<span class="chip warn">⏰ ช้า</span> ' : '') + (s.status === 'resubmitted' ? '<span class="chip info">ส่งใหม่</span>' : '<span class="chip ok">ใหม่</span>') + '</div></li>').join('') + '</ul>' : '<div class="empty">ไม่มีงานรอตรวจ 🎉</div>');
    clickRows(q('#tq'), '[data-sub]', (el) => go('submissionDetail', { offeringId: oid, submissionId: el.getAttribute('data-sub') }));
  };
  live(query(collection(db, 'offerings', oid, 'submissions'), where('status', 'in', ['submitted', 'resubmitted'])), (l) => { subs = l; paint(); }, (err) => { q('#tq').innerHTML = errBox(err); });
  live(collection(db, 'offerings', oid, 'assessments'), (l) => { as = l; paint(); });
};

// ---------------------------------------------------------------- ตรวจงานที่ส่ง
views.submissionDetail = (p) => {
  const oid = p.offeringId, subId = p.submissionId;
  h(backBtn() + '<div id="sd"><div class="loading">กำลังโหลด…</div></div>');
  bindBack();
  const st = { sub: null, versions: null, a: null, roster: null, perms: null };
  let aLoaded = '';
  const paint = () => {
    const { sub, versions, a, roster, perms } = st;
    if (!sub || !versions || !a || !roster || !perms) return;
    const names = Object.fromEntries(roster.map((r) => [r.id, r]));
    const vs = versions.slice().sort((x, y) => y.versionNo - x.versionNo);
    const RV = { pending: ['neutral', 'รอตรวจ'], returned: ['bad', 'ส่งคืนแก้ไข'], accepted: ['ok', 'รับประเมิน'], superseded: ['neutral', 'มีรุ่นใหม่กว่า'] };
    const keepNote = q('#rv-note') ? q('#rv-note').value : '';
    q('#sd').innerHTML = '<div class="breadcrumb">' + esc(a.code + ' ' + a.title) + '</div><h1>' + esc(sub.ownerName) + '</h1>' +
      (sub.ownerType === 'group' ? '<p class="small">สมาชิก: ' + (sub.currentMemberIds || sub.memberIds || []).map((id) => esc((names[id] || {}).name || id)).join(', ') + '</p>' : '') +
      '<p class="no-print">' + (perms.can_grade ? '<button class="btn ghost" id="sd-grade">' + (a.kind === 'group' ? 'ให้คะแนนกลุ่ม' : 'ให้คะแนน') + '</button>' : '') + '</p>' +
      vs.map((v) => '<div class="card"><div class="row"><div><strong>รุ่นที่ ' + v.versionNo + '</strong> ' + (v.isLate ? '<span class="chip warn">⏰ ส่งช้า</span>' : '') + ' <span class="chip ' + (RV[v.reviewStatus] || ['neutral'])[0] + '">' + (RV[v.reviewStatus] || [0, v.reviewStatus])[1] + '</span></div>' +
        '<div class="small muted" style="text-align:right">' + fmtDate(v.submittedAt) + ' โดย ' + esc(v.submittedByName) + '<br>รหัสยืนยัน ' + esc(v.receiptCode) + '</div></div>' +
        (v.comment ? '<p style="white-space:pre-wrap">' + esc(v.comment) + '</p>' : '') +
        (v.links && v.links.length ? v.links.map((l) => '<div><a href="' + esc(l) + '" target="_blank" rel="noopener noreferrer">' + esc(l) + '</a></div>').join('') : '') + fileRows(v.files) +
        (v.reviewNote ? '<div class="notice warn"><strong>ข้อความถึงนักเรียน:</strong> ' + esc(v.reviewNote) + (v.reviewedByName ? ' <span class="small muted">— ' + esc(v.reviewedByName) + '</span>' : '') + '</div>' : '') +
        (perms.can_grade && v.versionNo === sub.currentVersionNo && v.reviewStatus === 'pending' ? '<div class="no-print"><label for="rv-note">ข้อความถึงนักเรียน (จำเป็นเมื่อส่งคืน)</label><textarea id="rv-note" maxlength="5000">' + esc(keepNote) + '</textarea><div id="rv-msg"></div>' +
          '<p><button class="btn" data-review="accept" data-v="' + v.versionNo + '">รับเพื่อประเมิน</button> <button class="btn ghost" data-review="return" data-v="' + v.versionNo + '">ส่งคืนให้แก้ไข</button></p></div>' : '') + '</div>').join('');
    bindFileButtons(q('#sd'), oid);
    on('#sd-grade', 'click', () => go(a.kind === 'group' ? 'groupGrading' : 'gradeEntry', { offeringId: oid, assessmentId: a.id }));
    on('[data-review]', 'click', async (e) => {
      const action = e.currentTarget.getAttribute('data-review');
      try {
        await api('submission.review', { offeringId: oid, submissionId: subId, versionNo: Number(e.currentTarget.getAttribute('data-v')), action, note: q('#rv-note').value, expectedVersionNo: sub.currentVersionNo });
        toast(action === 'accept' ? 'รับเพื่อประเมินแล้ว' : 'ส่งคืนแล้ว นักเรียนได้รับแจ้งเตือนทันที');
      } catch (err) { q('#rv-msg').innerHTML = errBox(err); }
    });
  };
  livePerms(oid, (x) => { st.perms = x; paint(); });
  live(doc(db, 'offerings', oid, 'submissions', subId), (s) => {
    st.sub = s;
    if (!s) { q('#sd').innerHTML = errBox({ message: 'ไม่พบงานที่ส่ง' }); return; }
    if (aLoaded !== s.assessmentId) { aLoaded = s.assessmentId; live(doc(db, 'offerings', oid, 'assessments', s.assessmentId), (a) => { st.a = a; paint(); }); }
    paint();
  });
  live(collection(db, 'offerings', oid, 'submissions', subId, 'versions'), (l) => { st.versions = l; paint(); });
  live(collection(db, 'offerings', oid, 'roster'), (l) => { st.roster = l; paint(); });
};

// ---------------------------------------------------------------- ตั้งค่ารายวิชา (ครูร่วมสอน)
views.offeringSettings = (p) => {
  const oid = p.offeringId;
  h(offeringHeader(p, 'offeringSettings') + '<div id="os"><div class="loading">กำลังโหลด…</div></div>');
  bindOfferingHeader(p);
  const st = { off: null, staff: null, perms: null, teachers: null };
  const paint = () => {
    const { off, staff, perms } = st;
    if (!off || !staff || !perms) return;
    const canStaff = hasRole('admin') || perms.owner;
    const act = staff.filter((s) => s.active).sort((a, b) => (a.role === 'owner' ? -1 : 1) - (b.role === 'owner' ? -1 : 1));
    q('#os').innerHTML = '<div class="card"><h2 style="margin-top:0">ข้อมูลรายวิชา</h2><dl class="kv"><dt>รายวิชา</dt><dd>' + esc(off.courseCode + ' ' + off.courseName) + '</dd><dt>กลุ่มเรียน</dt><dd>' + esc(off.section) + '</dd>' +
      '<dt>ปี/ภาค</dt><dd>' + esc(off.yearBe) + ' / ' + esc(off.termNo) + '</dd><dt>สถานะ</dt><dd>' + stChip(OFF_STATUS, off.status) + '</dd><dt>ครูเจ้าของ</dt><dd>' + esc(off.ownerName) + '</dd></dl>' +
      (canStaff && off.status !== 'closed' ? '<p><button class="btn ghost" id="os-edit">แก้ไขรายวิชา</button></p>' : '') + '</div>' +
      '<div class="card"><h2 style="margin-top:0">ครูผู้สอน</h2><ul class="member-list">' + act.map((s) => '<li><span>' + esc(s.name) + ' ' + (s.role === 'owner' ? '<span class="chip info">เจ้าของรายวิชา</span>' : '<span class="small muted">ร่วมสอน: ' + OFFERING_PERMISSIONS.filter((k) => s.perms && s.perms[k]).map((k) => PERM_LABELS[k]).join(', ') + '</span>') + '</span>' +
        (canStaff && s.role !== 'owner' ? '<span><button class="btn ghost small" data-co="' + esc(s.teacherId) + '">แก้สิทธิ์</button> <button class="btn ghost small" data-revoke="' + esc(s.teacherId) + '">เพิกถอน</button></span>' : '') + '</li>').join('') + '</ul>' +
      (canStaff ? '<p><button class="btn ghost" id="os-addco">+ เพิ่มครูร่วมสอน</button></p>' : '') + '</div>';
    on('#os-edit', 'click', () => go('offeringForm', { offeringId: oid }));
    on('#os-addco', 'click', () => coTeacherModal(oid, null, act));
    on('[data-co]', 'click', (e) => coTeacherModal(oid, act.find((s) => s.teacherId === e.currentTarget.getAttribute('data-co')), act));
    on('[data-revoke]', 'click', (e) => { if (confirm('เพิกถอนครูร่วมสอนคนนี้?')) after(api('offering.setCoTeacher', { offeringId: oid, teacherId: e.currentTarget.getAttribute('data-revoke'), revoke: true }), 'เพิกถอนแล้ว'); });
  };
  livePerms(oid, (x) => { st.perms = x; paint(); });
  live(doc(db, 'offerings', oid), (o) => { st.off = o; paint(); });
  live(collection(db, 'offerings', oid, 'staff'), (l) => { st.staff = l; paint(); });
};

async function coTeacherModal(oid, cur, staff) {
  const teachers = cur ? [] : (await fetchAll(query(collection(db, 'teachers'), where('schoolId', '==', schoolId())))).filter((t) => t.status === 'active' && t.uid && !staff.some((s) => s.teacherId === t.id));
  const defaults = cur ? cur.perms || {} : { can_grade: true, can_export: true };
  openModal('<h2 id="modal-title" style="margin-top:0">' + (cur ? 'สิทธิ์ของ ' + esc(cur.name) : 'เพิ่มครูร่วมสอน') + '</h2>' +
    (cur ? '' : '<label for="co-t">ครู</label><select id="co-t">' + teachers.map((t) => '<option value="' + esc(t.id) + '">' + esc(t.name) + (t.department ? ' (' + esc(t.department) + ')' : '') + '</option>').join('') + '</select>') +
    '<fieldset><legend>สิทธิ์</legend>' + OFFERING_PERMISSIONS.filter((k) => k !== 'can_view').map((k) => '<label class="check"><input type="checkbox" name="perm" value="' + k + '"' + (defaults[k] ? ' checked' : '') + '> ' + PERM_LABELS[k] + '</label>').join('') + '</fieldset>' +
    '<div id="co-msg"></div><p><button class="btn" id="co-ok">บันทึก</button> <button class="btn ghost" data-close>ยกเลิก</button></p>');
  q('#co-ok').addEventListener('click', async () => {
    const perms = {};
    qa('[name=perm]', q('#modal')).forEach((x) => { perms[x.value] = x.checked; });
    try { await api('offering.setCoTeacher', { offeringId: oid, teacherId: cur ? cur.teacherId : q('#co-t').value, perms }); toast('บันทึกแล้ว'); closeModal(); } catch (err) { q('#co-msg').innerHTML = errBox(err); }
  });
}
