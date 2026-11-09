/** หน้านักเรียน: รายวิชา งาน ส่งงาน กลุ่มของฉัน คะแนนของฉัน (อัปเดตเรียลไทม์) */
import { collection, collectionGroup, doc, query, where } from 'firebase/firestore';
import { ref as sref, uploadBytesResumable } from 'firebase/storage';
import { views, go, swap, render } from '../lib/router.js';
import { db, storage, api, live, fetchOne } from '../lib/fb.js';
import { h, q, qa, on, esc, toast, errBox, backBtn, bindBack, fmtDate, fmtBytes, chip, KIND, uuid, openModal, pickList, bindPickAll, picked } from '../lib/ui.js';
import { fileRows, bindFileButtons } from '../lib/files.js';
import { session } from '../lib/session.js';

const STATUS_LABELS = {
  not_open: 'ยังไม่ถึงเวลา', not_submitted: 'ยังไม่ส่ง', draft: 'ฉบับร่าง', submitted: 'ส่งแล้ว รอตรวจ', late: 'ส่งช้า รอตรวจ',
  resubmitted: 'ส่งใหม่ รอพิจารณา', returned: 'ส่งคืนแก้ไข', accepted: 'ตรวจแล้ว', graded: 'ประกาศคะแนนแล้ว', closed: 'ปิดรับแล้ว (ไม่ได้ส่ง)', score_only: 'รับคะแนนอย่างเดียว'
};
const GRADE_LABEL = { scored: 'มีคะแนน', missing: 'ยังไม่ส่ง/ขาดสอบ', excused: 'ยกเว้น', needs_revision: 'รอแก้ไข' };
const sid = () => session.profile.studentId;
const needsFiles = (a) => (a.kind === 'individual' || a.kind === 'group') && a.submissionMode !== 'none';

function windowOf(a, ext) {
  const due = (ext && ext.dueAt) || a.dueAt || '';
  const close = (ext && ext.closeAt) || a.closeAt || '';
  return { openAt: a.openAt || '', dueAt: due, hardCloseAt: a.allowLate ? close : (due || close), allowLate: !!a.allowLate, extended: !!ext };
}

function statusOf(a, sub, pub, hasDraft, win) {
  const now = new Date().toISOString();
  if (!needsFiles(a)) return pub ? 'graded' : 'score_only';
  if (win.openAt && now < win.openAt) return 'not_open';
  if (pub) return 'graded';
  if (!sub || !sub.currentVersionNo) {
    if (hasDraft) return 'draft';
    if (win.hardCloseAt && now > win.hardCloseAt) return 'closed';
    return 'not_submitted';
  }
  if (['returned', 'resubmitted', 'accepted'].includes(sub.status)) return sub.status;
  return sub.latest && sub.latest.isLate ? 'late' : 'submitted';
}

export function studentTabs(p, active) {
  const tabs = [['studentCourse', 'งาน'], ['studentGroups', 'กลุ่มของฉัน'], ['studentGrades', 'คะแนนของฉัน']];
  return '<nav class="tabs" aria-label="เมนูรายวิชา">' + tabs.map((t) => '<button class="tab' + (t[0] === active ? ' active' : '') + '" data-tab="' + t[0] + '"' + (t[0] === active ? ' aria-current="page"' : '') + '>' + t[1] + '</button>').join('') + '</nav>';
}
const bindTabs = (p) => on('[data-tab]', 'click', (e) => swap(e.currentTarget.getAttribute('data-tab'), p));

// ---------------------------------------------------------------- รายวิชาของฉัน
views.studentHome = () => {
  h('<h1>รายวิชาของฉัน</h1>' +
    '<form class="card" id="join-form"><label for="join-code" style="margin-top:0">ลงทะเบียนเรียนด้วยรหัสเข้าร่วมรายวิชา (ขอรหัสจากครู)</label>' +
    '<div class="row"><input id="join-code" type="text" maxlength="20" autocapitalize="characters" placeholder="เช่น AB3K9Q"><button class="btn" type="submit" style="flex:0 0 auto">ลงทะเบียน</button></div><div id="join-msg"></div></form>' +
    '<div id="courses"><div class="loading">กำลังโหลด…</div></div>');
  q('#join-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const r = await api('student.join', { code: q('#join-code').value });
      toast(r.already ? 'คุณลงทะเบียนรายวิชานี้อยู่แล้ว' : 'ลงทะเบียนรายวิชา ' + r.courseName + ' แล้ว');
      q('#join-code').value = ''; q('#join-msg').innerHTML = '';
    } catch (err) { q('#join-msg').innerHTML = errBox(err); }
  });
  live(query(collectionGroup(db, 'enrollments'), where('uid', '==', session.user.uid)), async (enrs, snap) => {
    const rows = await Promise.all(snap.docs.map(async (d) => {
      const off = await fetchOne(doc(db, 'offerings', d.ref.parent.parent.id)).catch(() => null);
      return off && off.status !== 'draft' ? { e: d.data(), off } : null;
    }));
    const list = rows.filter(Boolean).sort((a, b) => (b.off.yearBe - a.off.yearBe) || (b.off.termNo - a.off.termNo) || String(a.off.courseCode).localeCompare(String(b.off.courseCode), 'th'));
    const box = q('#courses');
    if (!box) return;
    box.innerHTML = list.length ? '<div class="grid">' + list.map(({ e, off }) =>
      '<div class="card clickable" data-off="' + esc(off.id) + '" data-title="' + esc(off.courseCode + ' ' + off.courseName) + '" tabindex="0" role="button">' +
      '<div class="small muted">ปี ' + esc(off.yearBe) + ' ภาค ' + esc(off.termNo) + '</div><h3>' + esc(off.courseCode) + ' ' + esc(off.courseName) + '</h3>' +
      '<div class="small">กลุ่มเรียน ' + esc(off.section) + ' · ' + esc(off.ownerName) + '</div>' + (e.status !== 'active' ? '<div class="chip neutral">สิ้นสุดการลงทะเบียน</div>' : '') + '</div>').join('') + '</div>'
      : '<div class="card empty">ยังไม่มีรายวิชา</div>';
    qa('[data-off]', box).forEach((el) => {
      const open = () => go('studentCourse', { offeringId: el.getAttribute('data-off'), title: el.getAttribute('data-title') });
      el.addEventListener('click', open);
      el.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(); } });
    });
  });
};

/** ข้อมูลเรียลไทม์ที่หลายหน้าของนักเรียนใช้ร่วมกัน */
function courseFeeds(oid, onChange) {
  const st = { assessments: null, subs: [], drafts: [], groups: [], exts: [], pub: null };
  const done = () => { if (st.assessments) onChange(st); };
  live(query(collection(db, 'offerings', oid, 'assessments'), where('status', '==', 'published')), (l) => { st.assessments = l; done(); });
  live(query(collection(db, 'offerings', oid, 'submissions'), where('memberIds', 'array-contains', sid())), (l) => { st.subs = l; done(); });
  live(query(collection(db, 'offerings', oid, 'drafts'), where('memberIds', 'array-contains', sid())), (l) => { st.drafts = l; done(); });
  live(query(collection(db, 'offerings', oid, 'groups'), where('memberIds', 'array-contains', sid())), (l) => { st.groups = l; done(); });
  live(query(collection(db, 'offerings', oid, 'extensions'), where('targetId', '==', sid())), (l) => { st.exts = l; done(); });
  live(doc(db, 'offerings', oid, 'published', sid()), (d) => { st.pub = d; done(); });
  return st;
}
function ownerOf(st, a) {
  if (a.kind !== 'group') return { ownerId: sid(), group: null };
  const g = st.groups.find((x) => x.assessmentId === a.id && x.status !== 'disbanded') || null;
  return { ownerId: g ? g.id : '', group: g };
}

views.studentCourse = (p) => {
  h(backBtn() + '<h1>' + esc(p.title || 'รายวิชา') + '</h1>' + studentTabs(p, 'studentCourse') + '<div class="card" id="alist"><div class="loading">กำลังโหลด…</div></div>');
  bindBack(); bindTabs(p);
  courseFeeds(p.offeringId, (st) => {
    const now = new Date().toISOString();
    const items = st.assessments.slice().sort((a, b) => (a.dueAt || '9') < (b.dueAt || '9') ? -1 : 1).map((a) => {
      const { ownerId, group } = ownerOf(st, a);
      const subId = ownerId ? a.id + '_' + ownerId : '';
      const sub = st.subs.find((s) => s.id === subId) || null;
      const draft = st.drafts.find((d) => d.id === subId);
      const win = windowOf(a, st.exts.find((x) => x.assessmentId === a.id));
      const pub = st.pub && st.pub.items ? st.pub.items[a.id] : null;
      const status = statusOf(a, sub, pub, !!(draft && draft.files && draft.files.length), win);
      return { a, group, win, pub, status, overdue: !!(win.dueAt && now > win.dueAt && (!sub || !sub.currentVersionNo)) };
    });
    const box = q('#alist');
    if (!box) return;
    box.innerHTML = items.length ? '<ul class="list">' + items.map((x) =>
      '<li class="clickable" data-a="' + esc(x.a.id) + '" tabindex="0" role="button"><div><strong>' + esc(x.a.code) + ' ' + esc(x.a.title) + '</strong>' +
      '<div class="small muted">' + KIND[x.a.kind] + (x.group ? ' · กลุ่ม ' + esc(x.group.name) : '') + ' · คะแนนเต็ม ' + esc(x.a.maxScore) + (x.a.countsTowardGrade ? ' · น้ำหนักในรายวิชา ' + esc(x.a.weight) : '') + '</div>' +
      (x.win.dueAt ? '<div class="small">กำหนดส่ง ' + fmtDate(x.win.dueAt) + (x.win.extended ? ' (ขยายเวลาแล้ว)' : '') + '</div>' : '') + '</div>' +
      '<div>' + chip(x.status, STATUS_LABELS[x.status] + (x.overdue && x.status === 'not_submitted' ? ' (เลยกำหนด)' : ''), x.overdue && x.status === 'not_submitted' ? 'bad' : '') +
      (x.pub && x.pub.status === 'scored' ? '<div class="small">คะแนน ' + esc(x.pub.score) + '/' + esc(x.a.maxScore) + '</div>' : '') + '</div></li>').join('') + '</ul>'
      : '<div class="empty">ยังไม่มีงานที่ครูประกาศ</div>';
    qa('[data-a]', box).forEach((el) => {
      const open = () => go('studentAssessment', { offeringId: p.offeringId, assessmentId: el.getAttribute('data-a') });
      el.addEventListener('click', open);
      el.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') open(); });
    });
  });
};

// ---------------------------------------------------------------- รายละเอียดงานและส่งงาน
const submitKeys = {};

views.studentAssessment = async (p) => {
  const oid = p.offeringId;
  const settings = Object.assign({ maxFileMb: 25, maxFilesPerSubmission: 10, allowedFileTypes: [] }, session.school && session.school.settings || {});
  h(backBtn() + '<div id="adetail"><div class="loading">กำลังโหลด…</div></div>');
  bindBack();
  let a = null, st = null, versions = [], firstRender = true, lastSubId = '';
  const paint = () => {
    if (!a || !st) return;
    const { ownerId, group } = ownerOf(st, a);
    const subId = ownerId ? a.id + '_' + ownerId : '';
    if (subId && subId !== lastSubId) {
      lastSubId = subId;
      live(query(collection(db, 'offerings', oid, 'submissions', subId, 'versions'), where('memberIds', 'array-contains', sid())), (l) => { versions = l.sort((x, y) => y.versionNo - x.versionNo); paint(); });
    }
    const sub = st.subs.find((s) => s.id === subId) || null;
    const draft = st.drafts.find((d) => d.id === subId);
    const drafts = draft ? draft.files || [] : [];
    const win = windowOf(a, st.exts.find((x) => x.assessmentId === a.id));
    const pub = st.pub && st.pub.items ? st.pub.items[a.id] : null;
    const status = statusOf(a, sub, pub, drafts.length > 0, win);
    const school = settings.allowedFileTypes || [];
    const types = (a.allowedTypes && a.allowedTypes.length ? a.allowedTypes : school).filter((x) => !school.length || school.includes(x));
    const lim = { types, maxMb: Math.min(settings.maxFileMb, a.maxFileMb || settings.maxFileMb), maxFiles: Math.min(settings.maxFilesPerSubmission, a.maxFiles || settings.maxFilesPerSubmission), links: !!a.allowLinks };
    const now = new Date().toISOString();
    let block = '';
    if (win.openAt && now < win.openAt) block = 'ยังไม่ถึงเวลาเปิดรับงาน';
    else if (win.hardCloseAt && now > win.hardCloseAt) block = 'ปิดรับงานนี้แล้ว';
    else if (a.kind === 'group' && !group) block = 'งานนี้เป็นงานกลุ่ม กรุณาเข้ากลุ่มก่อน (แท็บ "กลุ่มของฉัน")';
    else if (a.kind === 'group' && a.group && a.group.submitPolicy === 'leader_only' && group.leaderStudentId !== sid()) block = 'งานนี้ให้หัวหน้ากลุ่มเป็นผู้ส่งเท่านั้น';
    const canSubmit = !block && needsFiles(a);
    const box = q('#adetail');
    if (!box) return;
    // อย่าวาดฟอร์มทับขณะผู้ใช้กำลังพิมพ์/อัปโหลด: อัปเดตเฉพาะส่วนที่เปลี่ยน
    if (!firstRender && q('#comment')) {
      q('#status-chip').innerHTML = chip(status, STATUS_LABELS[status]);
      q('#drafts').innerHTML = fileRows(drafts, { removable: canSubmit });
      q('#versions').innerHTML = versionsHtml(versions, a.kind === 'group');
      q('#pub-box').innerHTML = pub && pub.status === 'scored' ? '<div class="notice ok"><strong>คะแนนที่ประกาศ:</strong> ' + esc(pub.score) + ' / ' + esc(a.maxScore) + '</div>' : '';
      q('#btn-submit').dataset.base = String(sub ? sub.currentVersionNo || 0 : 0);
      q('#btn-submit').dataset.files = String(drafts.length);
      bindFileButtons(box, oid); bindRemove(drafts);
      return;
    }
    firstRender = false;
    box.innerHTML = '<div class="breadcrumb">' + KIND[a.kind] + '</div><h1>' + esc(a.code) + ' ' + esc(a.title) + '</h1>' +
      '<p id="status-chip">' + chip(status, STATUS_LABELS[status]) + '</p>' +
      '<div class="card"><dl class="kv"><dt>คะแนนเต็ม</dt><dd>' + esc(a.maxScore) + '</dd>' +
      (a.countsTowardGrade ? '<dt>น้ำหนักในรายวิชา</dt><dd>' + esc(a.weight) + '</dd>' : '') +
      (win.openAt ? '<dt>เปิดรับ</dt><dd>' + fmtDate(win.openAt) + '</dd>' : '') +
      (win.dueAt ? '<dt>กำหนดส่ง</dt><dd>' + fmtDate(win.dueAt) + (win.extended ? ' (ขยายเวลาให้คุณแล้ว)' : '') + '</dd>' : '') +
      (win.hardCloseAt ? '<dt>ปิดรับ</dt><dd>' + fmtDate(win.hardCloseAt) + (win.allowLate ? ' (ส่งหลังกำหนดส่งบันทึกว่าส่งช้า)' : '') + '</dd>' : '') +
      (a.maxAttempts ? '<dt>ส่งได้</dt><dd>' + a.maxAttempts + ' ครั้ง</dd>' : '') + '</dl>' +
      (a.description ? '<h3>คำชี้แจง</h3><p style="white-space:pre-wrap">' + esc(a.description) + '</p>' : '') + '</div>' +
      '<div id="pub-box">' + (pub && pub.status === 'scored' ? '<div class="notice ok"><strong>คะแนนที่ประกาศ:</strong> ' + esc(pub.score) + ' / ' + esc(a.maxScore) + '</div>' : '') + '</div>' +
      (a.kind === 'group' ? '<div class="card"><h2 style="margin-top:0">กลุ่ม</h2>' + (group ? '<p><strong>' + esc(group.name) + '</strong> ' + (group.frozen ? '<span class="chip ok">ตรึงรายชื่อแล้ว</span>' : '<span class="chip neutral">ยังไม่ตรึงรายชื่อ</span>') + '</p><p class="small muted">ใช้กลุ่มประจำรายวิชา สมาชิก ' + (group.memberIds || []).length + ' คน · ดู/จัดการกลุ่มที่แท็บ "กลุ่มของฉัน"</p>'
        : '<div class="notice warn">คุณยังไม่มีกลุ่ม ต้องเข้ากลุ่มก่อนส่งงาน</div>') + '</div>' : '') +
      (needsFiles(a) ? '<div class="card"><h2 style="margin-top:0">ส่งงาน</h2>' + (block ? '<div class="notice warn">' + esc(block) + '</div>' : '') +
        '<div class="notice info small">รับไฟล์: ' + esc(lim.types.join(', ')) + ' · ไฟล์ละไม่เกิน ' + lim.maxMb + ' MB · ไม่เกิน ' + lim.maxFiles + ' ไฟล์ต่อการส่ง<br>อัปโหลดเสร็จยังไม่ถือว่าส่ง ต้องกด "ส่งงาน" และได้รับรหัสยืนยัน</div>' +
        '<h3>ฉบับร่าง</h3><div id="drafts">' + fileRows(drafts, { removable: canSubmit }) + '</div><div id="uploads"></div>' +
        (canSubmit ? '<div class="drop" id="drop"><p>ลากไฟล์มาวาง หรือ</p><label class="btn ghost" for="file-input" style="display:inline-flex">เลือกไฟล์</label> <label class="btn ghost" for="camera-input" style="display:inline-flex">📷 ถ่ายภาพ</label>' +
          '<input id="file-input" type="file" multiple accept="' + esc(lim.types.map((t) => '.' + t).join(',')) + '" hidden><input id="camera-input" type="file" accept="image/*" capture="environment" hidden></div>' +
          '<label for="comment">คำอธิบาย (ถ้ามี)</label><textarea id="comment" maxlength="5000"></textarea>' +
          (lim.links ? '<label for="links">ลิงก์ (บรรทัดละหนึ่งลิงก์ ขึ้นต้นด้วย https://)</label><textarea id="links"></textarea>' : '') +
          '<div id="submit-msg"></div><p><button class="btn" id="btn-submit" data-base="' + (sub ? sub.currentVersionNo || 0 : 0) + '" data-files="' + drafts.length + '">ส่งงาน</button></p>' : '') + '</div>' : '') +
      '<h2>ประวัติการส่ง</h2><div id="versions">' + versionsHtml(versions, a.kind === 'group') + '</div>';
    bindFileButtons(box, oid);
    bindRemove(drafts);
    if (!canSubmit) return;
    const start = (files) => startUploads(oid, a, files, lim);
    [q('#file-input'), q('#camera-input')].forEach((inp) => inp.addEventListener('change', () => { start(Array.from(inp.files)); inp.value = ''; }));
    const drop = q('#drop');
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); start(Array.from(e.dataTransfer.files)); });
    q('#btn-submit').addEventListener('click', () => doSubmit(oid, a));
  };
  function bindRemove(drafts) {
    on('[data-remove]', 'click', async (e) => {
      e.currentTarget.disabled = true;
      try { await api('submission.removeDraft', { offeringId: oid, assessmentId: a.id, fileId: e.currentTarget.getAttribute('data-remove') }); toast('ลบออกจากฉบับร่างแล้ว'); } catch (err) { toast(err.message); }
    }, q('#drafts'));
    void drafts;
  }
  live(doc(db, 'offerings', oid, 'assessments', p.assessmentId), (d) => { a = d; if (!d) q('#adetail').innerHTML = errBox({ message: 'ไม่พบงานนี้' }); else paint(); });
  st = courseFeeds(oid, () => paint());
};

function versionsHtml(versions, showMembers) {
  if (!versions.length) return '<div class="muted">ยังไม่มีการส่ง</div>';
  const RV = { pending: ['neutral', 'รอตรวจ'], returned: ['bad', 'ส่งคืนแก้ไข'], accepted: ['ok', 'รับประเมิน'], superseded: ['neutral', 'มีรุ่นใหม่กว่า'] };
  return versions.map((v) => {
    const rv = RV[v.reviewStatus] || ['neutral', v.reviewStatus];
    return '<div class="card"><div class="row"><div><strong>รุ่นที่ ' + v.versionNo + '</strong> ' + (v.isLate ? '<span class="chip warn">⏰ ส่งช้า</span>' : '') + ' <span class="chip ' + rv[0] + '">' + rv[1] + '</span></div>' +
      '<div class="small muted" style="text-align:right">รหัสยืนยัน ' + esc(v.receiptCode) + '<br>' + fmtDate(v.submittedAt) + ' โดย ' + esc(v.submittedByName) + '</div></div>' +
      (v.comment ? '<p>' + esc(v.comment) + '</p>' : '') +
      (v.links && v.links.length ? '<div>' + v.links.map((l) => '<div><a href="' + esc(l) + '" target="_blank" rel="noopener noreferrer">' + esc(l) + '</a></div>').join('') + '</div>' : '') +
      fileRows(v.files) + (showMembers && v.memberIds ? '<div class="small muted">สมาชิก ณ เวลาส่ง ' + v.memberIds.length + ' คน</div>' : '') +
      (v.reviewNote ? '<div class="notice warn"><strong>ข้อความจากครู:</strong> ' + esc(v.reviewNote) + '</div>' : '') + '</div>';
  }).join('');
}

/** อัปโหลดแบบ resumable ไปที่ uploads/{uid}/ พร้อมแถบความคืบหน้า แล้วให้เซิร์ฟเวอร์ตรวจไฟล์และนำเข้าฉบับร่าง */
function startUploads(oid, a, files, lim) {
  const box = q('#uploads');
  let seq = Promise.resolve();
  files.forEach((file) => {
    const id = 'u' + uuid().slice(0, 8);
    box.insertAdjacentHTML('beforeend', '<div class="file-row" id="' + id + '"><div style="flex:1"><span class="file-name">' + esc(file.name) + '</span> <span class="small muted">' + fmtBytes(file.size) + '</span>' +
      '<div class="progress" role="progressbar" aria-label="ความคืบหน้าอัปโหลด ' + esc(file.name) + '" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div></div></div><div class="small status">รอคิว…</div></div></div>');
    const el = q('#' + id);
    const status = (html) => { q('.status', el).innerHTML = html; };
    const fail = (m) => status('<span class="chip bad">✕ ' + esc(m) + '</span>');
    seq = seq.then(() => new Promise((resolve) => {
      const ext = (file.name.split('.').pop() || '').toLowerCase();
      if (lim.types.length && !lim.types.includes(ext)) { fail('ชนิดไฟล์นี้ไม่อนุญาต (รับ: ' + lim.types.join(', ') + ')'); return resolve(); }
      if (file.size > lim.maxMb * 1048576) { fail('ไฟล์ใหญ่เกิน ' + lim.maxMb + ' MB'); return resolve(); }
      if (!file.size) { fail('ไฟล์ว่าง'); return resolve(); }
      const path = 'uploads/' + session.user.uid + '/' + Date.now() + '-' + uuid().slice(0, 12);
      const task = uploadBytesResumable(sref(storage, path), file, { contentType: file.type || 'application/octet-stream' });
      task.on('state_changed', (s) => {
        const pct = s.totalBytes ? s.bytesTransferred / s.totalBytes : 0;
        q('.progress > div', el).style.width = Math.round(pct * 100) + '%';
        q('.progress', el).setAttribute('aria-valuenow', String(Math.round(pct * 100)));
        status('อัปโหลดแล้ว ' + Math.round(pct * 100) + '%');
      }, () => { fail('อัปโหลดไม่สำเร็จ ลองใหม่อีกครั้ง'); resolve(); }, async () => {
        status('กำลังตรวจไฟล์…');
        try {
          const r = await api('submission.attach', { offeringId: oid, assessmentId: a.id, uploadPath: path, fileName: file.name }, { retry: 2 });
          if (r.accepted) status('<span class="chip ok">✓ อยู่ในฉบับร่าง (ยังไม่ได้ส่ง)</span>');
          else fail(r.message);
        } catch (err) { fail(err.message); }
        resolve();
      });
    }));
  });
}

async function doSubmit(oid, a) {
  const btn = q('#btn-submit'), msg = q('#submit-msg');
  const links = q('#links') ? q('#links').value.split(/\n+/).map((s) => s.trim()).filter(Boolean) : [];
  const nFiles = Number(btn.dataset.files || 0), base = Number(btn.dataset.base || 0);
  if (!nFiles && !links.length) { msg.innerHTML = errBox({ message: 'ยังไม่มีไฟล์หรือลิงก์ในฉบับร่าง' }); return; }
  if (!confirm('ยืนยันส่งงาน ' + nFiles + ' ไฟล์' + (links.length ? ' และ ' + links.length + ' ลิงก์' : '') + (base ? ' เป็นรุ่นที่ ' + (base + 1) : '') + ' ?')) return;
  btn.disabled = true; btn.textContent = 'กำลังส่ง…';
  // ใช้คีย์เดิมจนกว่าจะสำเร็จ: กดซ้ำ/เน็ตหลุดแล้วส่งใหม่ได้ผลเดิม ไม่สร้างรายการซ้ำ
  const key = submitKeys[a.id] = submitKeys[a.id] || uuid() + uuid();
  try {
    const r = await api('submission.submit', { offeringId: oid, assessmentId: a.id, baseVersionNo: base, idempotencyKey: key, comment: q('#comment').value, links }, { retry: 3 });
    delete submitKeys[a.id];
    q('#comment').value = ''; if (q('#links')) q('#links').value = '';
    showReceipt(r);
  } catch (err) {
    if (err.code !== 'NETWORK' && err.code !== 'BUSY') delete submitKeys[a.id];
    msg.innerHTML = errBox(err) + (err.code === 'NETWORK' ? '<div class="small">ยังไม่ยืนยันว่าส่งสำเร็จ กด "ส่งงาน" อีกครั้งได้อย่างปลอดภัย ระบบจะไม่สร้างรายการซ้ำ</div>' : '');
  } finally { btn.disabled = false; btn.textContent = 'ส่งงาน'; }
}

function showReceipt(r) {
  openModal('<h2 id="modal-title" style="margin-top:0">✓ ส่งงานสำเร็จ</h2><div class="receipt"><p>รหัสยืนยันการส่ง<br><code>' + esc(r.receiptCode) + '</code></p>' +
    '<dl class="kv"><dt>งาน</dt><dd>' + esc(r.assessmentTitle) + '</dd><dt>รุ่นที่</dt><dd>' + r.versionNo + '</dd><dt>เวลาเซิร์ฟเวอร์</dt><dd>' + fmtDate(r.submittedAt) + '</dd>' +
    (r.isLate ? '<dt>สถานะ</dt><dd><span class="chip warn">⏰ ส่งช้า</span></dd>' : '') + '</dl><h3>ไฟล์ที่ส่ง</h3>' +
    (r.files.length ? '<ul>' + r.files.map((f) => '<li>' + esc(f.name) + ' (' + fmtBytes(f.size) + ')</li>').join('') + '</ul>' : '<p class="muted">ไม่มีไฟล์</p>') +
    (r.links && r.links.length ? '<h3>ลิงก์</h3><ul>' + r.links.map((l) => '<li>' + esc(l) + '</li>').join('') + '</ul>' : '') +
    (r.replayed ? '<p class="small muted">รายการนี้บันทึกไว้แล้วก่อนหน้า (ไม่ได้สร้างซ้ำ)</p>' : '') +
    '<p class="small muted">บันทึกภาพหน้าจอนี้ไว้เป็นหลักฐานได้</p></div><p><button class="btn" data-close>ปิด</button></p>');
}

// ---------------------------------------------------------------- กลุ่มของฉัน (กลุ่มประจำรายวิชา)
views.studentGroups = (p) => {
  const oid = p.offeringId;
  h(backBtn() + '<h1>' + esc(p.title || 'รายวิชา') + '</h1>' + studentTabs(p, 'studentGroups') + '<div id="gbox"><div class="loading">กำลังโหลด…</div></div>');
  bindBack(); bindTabs(p);
  const st = { off: null, wgs: null, roster: null, assessments: [] };
  const paint = () => {
    if (!st.off || !st.wgs || !st.roster) return;
    const me = sid();
    const gs = st.off.groupSettings || {};
    const names = Object.fromEntries(st.roster.map((r) => [r.id, r]));
    const active = st.wgs.filter((w) => w.status === 'active');
    const my = active.find((w) => (w.memberIds || []).includes(me));
    const isLeader = my && my.leaderStudentId === me;
    const brief = (id) => (names[id] ? esc(names[id].name) + ' <span class="small muted">' + esc(names[id].roomLabel) + '</span>' : esc(id));
    const classmates = st.roster.filter((r) => r.active && !r.workGroupId && r.id !== me).map((r) => ({ id: r.id, name: r.name, roomLabel: r.roomLabel }));
    let html = (gs.locked ? '<div class="notice warn">ครูล็อกการจัดกลุ่มแล้ว หากต้องการเปลี่ยนสมาชิกกรุณาติดต่อครู</div>' : '') +
      '<p class="small muted">กลุ่มประจำรายวิชาใช้ทำงานกลุ่มได้หลายงาน หนึ่งคนอยู่ได้หนึ่งกลุ่มต่อรายวิชา' + (gs.maxSize ? ' · สมาชิกไม่เกิน ' + gs.maxSize + ' คน' : '') + '</p>';
    if (my) {
      html += '<div class="card"><h2 style="margin-top:0">' + esc(my.name) + (isLeader ? ' <span class="chip info">คุณเป็นหัวหน้ากลุ่ม</span>' : '') + '</h2><ul class="member-list">' +
        my.memberIds.map((id) => '<li><span>' + (id === my.leaderStudentId ? '★ ' : '') + brief(id) + (id === my.leaderStudentId ? ' — หัวหน้ากลุ่ม' : '') + '</span>' +
          (isLeader && id !== me && !gs.locked ? '<button class="btn ghost small" data-kick="' + esc(id) + '">นำออก</button>' : '') + '</li>').join('') + '</ul>' +
        ((my.invitedIds || []).length ? '<p class="small muted">รอตอบรับคำเชิญ: ' + my.invitedIds.map((id) => brief(id) + (isLeader && !gs.locked ? ' <button class="btn ghost small" data-kick="' + esc(id) + '">ยกเลิก</button>' : '')).join(', ') + '</p>' : '');
      if (isLeader && !gs.locked) {
        html += '<h3>เลือกสมาชิกเข้ากลุ่ม</h3><p class="small muted">' + (gs.leaderDirectAdd ? 'ครูอนุญาตให้หัวหน้าเพิ่มสมาชิกได้ทันที' : 'ระบบจะส่งคำเชิญ เพื่อนต้องกดตอบรับจึงเข้ากลุ่ม') + '</p>' +
          '<div id="inv-pick">' + pickList('inv', classmates, { empty: 'ไม่มีเพื่อนที่ยังไม่มีกลุ่ม', label: 'เพื่อนที่ยังไม่มีกลุ่ม' }) + '</div><div id="inv-msg"></div>' +
          '<p><button class="btn" id="btn-inv"' + (classmates.length ? '' : ' disabled') + '>' + (gs.leaderDirectAdd ? 'เพิ่มเข้ากลุ่ม' : 'ส่งคำเชิญ') + '</button></p>';
      }
      if (!gs.locked) html += '<p><button class="btn ghost small" id="btn-leave">ออกจากกลุ่ม</button></p>';
      html += '</div>';
    } else {
      const invites = active.filter((w) => (w.invitedIds || []).includes(me));
      html += '<div class="notice warn">คุณยังไม่มีกลุ่มในรายวิชานี้</div>';
      if (invites.length) html += '<div class="card"><h2 style="margin-top:0">คำเชิญถึงคุณ</h2>' + invites.map((w) => '<div class="file-row"><span><strong>' + esc(w.name) + '</strong> <span class="small muted">' + w.memberIds.map((id) => names[id] ? esc(names[id].name) : '').join(', ') + '</span></span>' +
        '<span><button class="btn small" data-respond="' + w.id + '" data-ok="1">ตอบรับ</button> <button class="btn ghost small" data-respond="' + w.id + '" data-ok="0">ปฏิเสธ</button></span></div>').join('') + '</div>';
      if (!gs.locked) html += '<div class="card"><h2 style="margin-top:0">สร้างกลุ่มใหม่ (คุณเป็นหัวหน้ากลุ่ม)</h2><div class="row"><input id="wg-name" type="text" maxlength="100" placeholder="ชื่อกลุ่ม" aria-label="ชื่อกลุ่ม"><button class="btn" id="btn-wg-create" style="flex:0 0 auto">สร้างกลุ่ม</button></div><div id="wg-msg"></div></div>';
    }
    const others = active.filter((w) => !my || w.id !== my.id);
    if (others.length) html += '<div class="card"><h3 style="margin-top:0">กลุ่มอื่นในรายวิชา</h3><p>' + others.map((w) => '<span class="chip neutral">' + esc(w.name) + ' (' + (w.memberIds || []).length + ')</span>').join(' ') + '</p></div>';
    const ga = st.assessments.filter((x) => x.kind === 'group');
    if (ga.length) html += '<div class="card"><h3 style="margin-top:0">งานกลุ่มที่ใช้กลุ่มนี้</h3><ul>' + ga.map((x) => '<li>' + esc(x.code) + ' ' + esc(x.title) + '</li>').join('') + '</ul></div>';
    const keepPick = picked('inv', q('#gbox'));
    q('#gbox').innerHTML = html;
    keepPick.forEach((v) => { const el = q('[name="inv"][value="' + v + '"]'); if (el) el.checked = true; });
    const after = async (pr, okMsg) => { try { await pr; toast(okMsg || 'บันทึกแล้ว'); } catch (err) { toast(err.message); } };
    bindPickAll(q('#gbox'));
    on('#btn-inv', 'click', () => {
      const ids = picked('inv', q('#gbox'));
      if (!ids.length) { q('#inv-msg').innerHTML = errBox({ message: 'ยังไม่ได้เลือกเพื่อน' }); return; }
      after(api('wg.invite', { offeringId: oid, studentIds: ids }), gs.leaderDirectAdd ? 'เพิ่มสมาชิกแล้ว' : 'ส่งคำเชิญแล้ว');
    });
    on('#btn-wg-create', 'click', () => api('wg.create', { offeringId: oid, name: q('#wg-name').value }).then(() => toast('สร้างกลุ่มแล้ว')).catch((err) => { q('#wg-msg').innerHTML = errBox(err); }));
    on('#btn-leave', 'click', () => { if (confirm('ออกจากกลุ่ม?')) after(api('wg.leave', { offeringId: oid })); });
    on('[data-kick]', 'click', (e) => after(api('wg.leaderRemove', { offeringId: oid, studentId: e.currentTarget.getAttribute('data-kick') })));
    on('[data-respond]', 'click', (e) => after(api('wg.respond', { offeringId: oid, workGroupId: e.currentTarget.getAttribute('data-respond'), accept: e.currentTarget.getAttribute('data-ok') === '1' })));
  };
  live(doc(db, 'offerings', oid), (o) => { st.off = o; paint(); });
  live(collection(db, 'offerings', oid, 'workGroups'), (l) => { st.wgs = l; paint(); });
  live(collection(db, 'offerings', oid, 'roster'), (l) => { st.roster = l; paint(); });
  live(query(collection(db, 'offerings', oid, 'assessments'), where('status', '==', 'published')), (l) => { st.assessments = l; paint(); });
};

// ---------------------------------------------------------------- คะแนนของฉัน (เฉพาะค่าที่ประกาศ)
views.studentGrades = (p) => {
  const oid = p.offeringId;
  h(backBtn() + '<h1>' + esc(p.title || 'รายวิชา') + '</h1>' + studentTabs(p, 'studentGrades') + '<div id="sgbox"><div class="loading">กำลังโหลด…</div></div>');
  bindBack(); bindTabs(p);
  let as = null, pub;
  const paint = () => {
    if (!as || pub === undefined) return;
    const items = pub && pub.items || {};
    const t = pub && pub.total;
    const big = !t ? '–' : t.status === 'complete' ? esc(t.final) : t.status === 'incomplete' ? esc(t.provisional) : '–';
    const rows = as.slice().sort((x, y) => (x.sort || 0) - (y.sort || 0)).map((a) => {
      const g = items[a.id];
      const w = g && g.status === 'scored' && a.countsTowardGrade && Number(a.weight) > 0 ? (Number(g.score) / Number(a.maxScore) * Number(a.weight)).toFixed(2) : '';
      return '<tr id="row-' + esc(a.id) + '"><td>' + esc(a.code) + ' ' + esc(a.title) + '</td><td class="hide-sm">' + KIND[a.kind] + '</td><td class="num">' + esc(a.maxScore) + '</td><td class="num hide-sm">' + (a.countsTowardGrade ? esc(a.weight) : 'ไม่นับ') + '</td>' +
        '<td>' + (g ? (g.status === 'scored' ? '<strong>' + esc(g.score) + '</strong>' : '<span class="chip warn">' + esc(GRADE_LABEL[g.status] || g.status) + '</span>') : '<span class="chip neutral">ยังไม่ประกาศ</span>') + '</td><td class="num hide-sm">' + w + '</td></tr>';
    }).join('');
    const prev = q('#sgbox').getAttribute('data-sig');
    const sig = JSON.stringify(items);
    q('#sgbox').innerHTML = '<div class="card"><div class="small muted">คะแนนรวม (เต็ม 100) <span class="live-dot"></span><span class="small">อัปเดตทันทีเมื่อครูประกาศ</span></div><div class="big-code" style="letter-spacing:0" id="total">' + big + '</div>' +
      '<p>' + (!t ? '<span class="chip neutral">ยังไม่มีคะแนนที่ประกาศ</span>' : t.status === 'complete' ? '<span class="chip ok">ครบทุกรายการ</span>' + (t.grade ? ' เกรด <strong>' + esc(t.grade.label) + '</strong>' : '') :
        t.status === 'incomplete' ? '<span class="chip warn">ยังไม่ครบ</span> ประเมินแล้ว ' + esc(t.assessedWeightPct) + '% ของน้ำหนัก' : '<span class="chip neutral">' + esc(t.label) + '</span>') + '</p>' +
      (t && t.status !== 'complete' ? '<p class="small muted">คะแนนสะสมจากรายการที่ครูประกาศแล้วบนฐานเต็ม 100 (ยังไม่ใช่ผลสุดท้าย)</p>' : '') + '</div>' +
      '<div class="card table-wrap"><table><thead><tr><th>งาน</th><th class="hide-sm">ประเภท</th><th class="num">คะแนนเต็ม</th><th class="num hide-sm">น้ำหนัก</th><th>คะแนนของฉัน</th><th class="num hide-sm">คิดน้ำหนัก</th></tr></thead><tbody>' +
      (rows || '<tr><td colspan="6" class="empty">ยังไม่มีงาน</td></tr>') + '</tbody></table></div>';
    q('#sgbox').setAttribute('data-sig', sig);
    if (prev && prev !== sig) q('#total').classList.add('flash');
  };
  live(query(collection(db, 'offerings', oid, 'assessments'), where('status', '==', 'published')), (l) => { as = l; paint(); });
  live(doc(db, 'offerings', oid, 'published', sid()), (d) => { pub = d; paint(); });
};

void render;
