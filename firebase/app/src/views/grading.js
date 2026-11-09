/**
 * การให้คะแนน: สมุดคะแนน (เรียลไทม์) ให้คะแนนรายบุคคล ให้คะแนนกลุ่ม (บันทึกเป็นคะแนนของสมาชิกอัตโนมัติ) และประกาศคะแนน
 * - ครูสองคนเปิดหน้าเดียวกัน: ค่าที่อีกคนบันทึกปรากฏทันที ช่องที่กำลังแก้ไม่ถูกเขียนทับ และเซิร์ฟเวอร์กันบันทึกทับด้วยเลขรุ่น
 * - คะแนนกลุ่มของแต่ละงานเก็บที่กลุ่ม (groupGrades) และคัดลอกเป็นคะแนนรายบุคคลของสมาชิกที่ตรึงไว้ใน transaction เดียว
 */
import { collection, doc, query, where } from 'firebase/firestore';
import { views, go } from '../lib/router.js';
import { db, api, live, fetchAll } from '../lib/fb.js';
import { h, q, qa, on, esc, toast, errBox, backBtn, bindBack, fmtDate, KIND, openModal, closeModal } from '../lib/ui.js';
import { offeringHeader, bindOfferingHeader, livePerms, loadStudents } from './teacher.js';
import { buildGradebook, SHORT, totalText } from '../lib/gradebook.js';
import { GRADE_STATUS_LABELS } from '@shared/config.js';

const STATUS_OPTS = ['scored', 'missing', 'excused', 'needs_revision', 'not_assessed'];
const statusSelect = (id, cur, label) => '<select class="compact" id="' + id + '" aria-label="' + esc(label) + '">' + STATUS_OPTS.map((s) => '<option value="' + s + '"' + (s === cur ? ' selected' : '') + '>' + GRADE_STATUS_LABELS[s] + '</option>').join('') + '</select>';
const gradeText = (g) => !g ? '-' : g.status === 'scored' ? esc(g.rawScore) : (SHORT[g.status] || '-');
const isDraft = (g) => g && ((g.status !== 'not_assessed' && (g.publication !== 'published' || g.publishedStatus !== g.status || String(g.publishedScore || '') !== String(g.status === 'scored' ? g.rawScore : ''))) || (g.status === 'not_assessed' && g.publishedAt));

// ---------------------------------------------------------------- แถบประกาศคะแนน
function publishBar(box, oid, a, grades, perms) {
  if (!box) return;
  const draft = grades.filter(isDraft).length;
  const published = grades.filter((g) => g.publishedAt).length;
  box.innerHTML = '<div class="notice ' + (draft ? 'warn' : 'ok') + ' no-print"><strong>' + (draft ? 'มีคะแนนที่ยังไม่ประกาศ ' + draft + ' รายการ' : 'ประกาศคะแนนล่าสุดครบแล้ว') + '</strong>' +
    ' <span class="small">(นักเรียนเห็นแล้ว ' + published + ' คน — นักเรียนเห็นเฉพาะค่าที่ประกาศ และหน้าคะแนนของนักเรียนอัปเดตทันที)</span>' +
    (perms.can_publish ? '<div style="margin-top:6px">' + (draft ? '<button class="btn small" id="pub-go">ประกาศคะแนนงานนี้</button> ' : '') + (published ? '<button class="btn ghost small" id="pub-undo">เรียกคืนการประกาศ</button>' : '') + '</div>' : '') + '</div>';
  on('#pub-go', 'click', async () => {
    if (!confirm('ประกาศคะแนน "' + a.title + '" ให้นักเรียนเห็น?')) return;
    try { const r = await api('grades.publish', { offeringId: oid, assessmentId: a.id, action: 'publish' }); toast('ประกาศแล้ว ' + r.changed + ' รายการ'); } catch (err) { toast(err.message); }
  }, box);
  on('#pub-undo', 'click', async () => {
    const reason = prompt('เหตุผลการเรียกคืนการประกาศ (นักเรียนจะไม่เห็นคะแนนงานนี้จนกว่าจะประกาศใหม่)');
    if (!reason) return;
    try { await api('grades.publish', { offeringId: oid, assessmentId: a.id, action: 'unpublish', reason }); toast('เรียกคืนแล้ว'); } catch (err) { toast(err.message); }
  }, box);
}

async function historyModal(oid, aid, sid, name, title) {
  openModal('<h2 id="modal-title" style="margin-top:0">ประวัติคะแนน</h2><p>' + esc(name) + ' · ' + esc(title) + '</p><div id="hist"><div class="loading">กำลังโหลด…</div></div><p><button class="btn ghost" data-close>ปิด</button></p>');
  try {
    const revs = (await fetchAll(query(collection(db, 'offerings', oid, 'revisions'), where('gradeId', '==', aid + '_' + sid)))).sort((x, y) => y.revisionNo - x.revisionNo);
    const fmt = (st, sc) => st === 'scored' ? esc(sc) : esc(GRADE_STATUS_LABELS[st] || st);
    const SRC = { teacher: 'ครูกรอก', group: 'จากคะแนนกลุ่ม', import: 'นำเข้า' };
    q('#hist').innerHTML = revs.length ? '<div class="table-wrap"><table><thead><tr><th>ครั้งที่</th><th>จาก → เป็น</th><th>ที่มา</th><th>โดย</th></tr></thead><tbody>' + revs.map((r) =>
      '<tr><td>' + r.revisionNo + '</td><td>' + fmt(r.fromStatus, r.fromScore) + ' → <strong>' + fmt(r.toStatus, r.toScore) + '</strong>' + (r.reason ? '<div class="small muted">' + esc(r.reason) + '</div>' : '') + '</td>' +
      '<td class="small">' + esc(SRC[r.source] || r.source) + '</td><td class="small">' + esc(r.byName) + '<br>' + fmtDate(r.at) + '</td></tr>').join('') + '</tbody></table></div>' : '<p class="muted">ยังไม่มีประวัติ</p>';
  } catch (err) { if (q('#hist')) q('#hist').innerHTML = errBox(err); }
}

// ---------------------------------------------------------------- สมุดคะแนน
views.gradebook = (p) => {
  const oid = p.offeringId;
  h(offeringHeader(p, 'gradebook') + '<p class="small muted no-print"><span class="live-dot"></span>อัปเดตทันทีเมื่อครูคนใดบันทึกคะแนน · • = ยังไม่ประกาศ · กรอบประ = ปรับรายคนจากคะแนนกลุ่ม · แตะคะแนนเพื่อดูประวัติ</p><div id="gb"><div class="loading">กำลังโหลด…</div></div>');
  bindOfferingHeader(p);
  const st = { off: null, as: null, enrs: null, grades: null, students: {} };
  let prevSig = {}, seq = 0;
  const paint = async () => {
    if (!st.off || !st.as || !st.enrs || !st.grades) return;
    const mine = ++seq;
    st.students = await loadStudents(st.enrs.map((e) => e.id));
    if (mine !== seq || !q('#gb')) return;
    const gb = buildGradebook({ offering: st.off, assessments: st.as, enrollments: st.enrs.filter((e) => e.status === 'active'), students: st.students, grades: st.grades });
    const sig = {};
    q('#gb').innerHTML = gb.assessments.length ? '<div class="card table-scroll"><table class="grade-table"><thead><tr><th class="sticky">นักเรียน</th>' +
      gb.assessments.map((a) => '<th class="num"><button class="btn ghost small" data-ga="' + esc(a.id) + '" data-kind="' + a.kind + '" title="' + esc(a.title) + '">' + esc(a.code) + '</button><div class="small muted">เต็ม ' + esc(a.maxScore) + (a.countsTowardGrade ? ' · น้ำหนัก ' + esc(a.weight) : ' · ไม่นับ') + (a.kind === 'group' ? ' · กลุ่ม' : '') + '</div></th>').join('') +
      '<th class="num">รวม (100)</th><th>เกรด</th></tr></thead><tbody>' +
      gb.rows.map((r) => '<tr><td class="sticky"><span class="small muted">' + esc(r.code) + '</span> ' + esc(r.name) + ' <span class="small muted">' + esc(r.roomLabel) + '</span></td>' +
        gb.assessments.map((a) => {
          const c = r.cells[a.id]; const g = c && c.g;
          const key = a.id + '_' + r.studentId;
          sig[key] = g ? g.status + ':' + g.rawScore + ':' + g.version : '';
          const changed = prevSig[key] !== undefined && prevSig[key] !== sig[key];
          return '<td class="num"><span class="cell' + (g && g.isOverride ? ' override' : '') + (isDraft(g) ? ' dirty' : '') + (changed ? ' flash' : '') + '" role="button" tabindex="0" data-h="' + esc(a.id) + '|' + esc(r.studentId) + '">' + gradeText(g) + '</span></td>';
        }).join('') +
        '<td class="num"><strong>' + esc(r.total.status === 'complete' ? r.total.final : r.total.status === 'incomplete' ? r.total.provisional : '') + '</strong>' + (r.total.status === 'incomplete' ? '<div class="small muted">ยังไม่ครบ ' + esc(r.total.assessedWeightPct) + '%</div>' : '') + '</td>' +
        '<td>' + esc(r.total.grade ? r.total.grade.label : r.total.status === 'no_base' ? '' : '') + '</td></tr>').join('') +
      '</tbody></table></div><p class="small muted">ขส = ยังไม่ส่ง/ขาดสอบ · ยว = ยกเว้น · รอแก้ = รอแก้ไข · - = ยังไม่ประเมิน (ไม่ใช่ศูนย์) · คะแนนรวมคิดจากค่าที่บันทึก (รวมที่ยังไม่ประกาศ)</p>'
      : '<div class="card empty">ยังไม่มีงานในรายวิชา</div>';
    prevSig = sig;
    on('[data-ga]', 'click', (e) => go(e.currentTarget.getAttribute('data-kind') === 'group' ? 'groupGrading' : 'gradeEntry', { offeringId: oid, assessmentId: e.currentTarget.getAttribute('data-ga'), title: p.title }));
    qa('[data-h]').forEach((el) => {
      const open = () => {
        const [aid, sid] = el.getAttribute('data-h').split('|');
        const r = gb.rows.find((x) => x.studentId === sid); const a = gb.assessments.find((x) => x.id === aid);
        historyModal(oid, aid, sid, r ? r.name : sid, a ? a.code + ' ' + a.title : '');
      };
      el.addEventListener('click', open);
      el.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') open(); });
    });
  };
  live(doc(db, 'offerings', oid), (o) => { st.off = o; paint(); });
  live(collection(db, 'offerings', oid, 'assessments'), (l) => { st.as = l; paint(); });
  live(collection(db, 'offerings', oid, 'enrollments'), (l) => { st.enrs = l; paint(); });
  live(collection(db, 'offerings', oid, 'grades'), (l) => { st.grades = l; paint(); }, (err) => { q('#gb').innerHTML = errBox(err); });
};

// ---------------------------------------------------------------- ให้คะแนนรายบุคคล
views.gradeEntry = (p) => {
  const oid = p.offeringId, aid = p.assessmentId;
  h(backBtn() + '<div id="ge-head"><div class="loading">กำลังโหลด…</div></div><div id="ge-pub"></div><div class="card table-wrap" id="ge-box"></div>' +
    '<div class="no-print" style="position:sticky;bottom:0;background:var(--bg);padding:8px 0"><div id="ge-msg"></div><button class="btn" id="ge-save" disabled>บันทึกคะแนน</button> <span class="small muted" id="ge-count"></span></div>');
  bindBack();
  const st = { a: null, enrs: null, grades: null, perms: null, students: {}, roster: null };
  const base = {};   // ค่าบนเซิร์ฟเวอร์ ณ ตอนเริ่มแก้ (ใช้เลขรุ่นกันบันทึกทับ)
  const dirty = new Set();
  let built = false;
  const gradeOf = (sid) => (st.grades || []).find((g) => g.studentId === sid) || null;
  const rowVal = (sid) => ({ status: q('#st-' + sid).value, score: q('#sc-' + sid).value.trim(), reason: q('#rs-' + sid).value.trim() });
  const setCount = () => { q('#ge-count').textContent = dirty.size ? 'แก้ไขแล้ว ' + dirty.size + ' รายการ (ยังไม่บันทึก)' : ''; q('#ge-save').disabled = !dirty.size; };
  const fill = (sid, g) => {
    q('#st-' + sid).value = g ? g.status : 'not_assessed';
    q('#sc-' + sid).value = g && g.status === 'scored' ? g.rawScore : '';
    q('#rs-' + sid).value = g ? g.excuseReason || '' : '';
    base[sid] = { version: g ? g.version || 0 : 0, sig: g ? g.status + ':' + g.rawScore : 'not_assessed:' };
    q('#pb-' + sid).innerHTML = g && g.publishedAt ? '<span class="chip ok small">ประกาศแล้ว' + (isDraft(g) ? ' (มีค่าใหม่)' : '') + '</span>' : '';
  };
  const build = async () => {
    const { a, enrs, perms } = st;
    if (!a || !enrs || !st.grades || !perms || !st.roster) return;
    if (!built) {
      built = true;
      const names = Object.fromEntries(st.roster.map((r) => [r.id, r]));
      st.students = await loadStudents(enrs.map((e) => e.id));
      const rows = enrs.filter((e) => e.status === 'active' || gradeOf(e.id)).map((e) => ({ id: e.id, s: st.students[e.id] || {}, r: names[e.id] || {}, e }))
        .sort((x, y) => String(x.r.roomLabel).localeCompare(String(y.r.roomLabel), 'th', { numeric: true }) || (Number(x.s.rollNo || 0) - Number(y.s.rollNo || 0)) || String(x.s.code).localeCompare(String(y.s.code), 'th', { numeric: true }));
      q('#ge-head').innerHTML = '<div class="breadcrumb">' + esc(p.title || '') + '</div><h1>ให้คะแนน: ' + esc(a.code) + ' ' + esc(a.title) + '</h1><p>' + KIND[a.kind] + ' · คะแนนเต็ม <strong>' + esc(a.maxScore) + '</strong>' + (a.countsTowardGrade ? ' · น้ำหนัก ' + esc(a.weight) : ' · ไม่นับคะแนน') + '</p>' +
        (perms.can_grade ? '<p class="no-print small"><button class="btn ghost small" id="ge-fillmax">ใส่คะแนนเต็มให้ทุกคนที่ยังว่าง</button> <button class="btn ghost small" id="ge-fillmiss">ทำเครื่องหมาย "ยังไม่ส่ง" ให้ทุกคนที่ยังว่าง</button></p>' : '');
      q('#ge-box').innerHTML = '<table><thead><tr><th>นักเรียน</th><th>สถานะ</th><th class="num">คะแนน / ' + esc(a.maxScore) + '</th><th class="hide-sm">เหตุผล/หมายเหตุ</th><th class="hide-sm"></th></tr></thead><tbody>' +
        rows.map((x) => '<tr id="row-' + esc(x.id) + '"><td><span class="small muted">' + esc(x.s.code || '') + '</span> ' + esc(x.r.name || x.s.name || x.id) + ' <span class="small muted">' + esc(x.r.roomLabel || '') + '</span>' + (x.e.status !== 'active' ? ' <span class="chip neutral">ถอนแล้ว</span>' : '') +
          '<div class="small" id="cf-' + esc(x.id) + '"></div></td><td>' + statusSelect('st-' + x.id, 'not_assessed', 'สถานะ ' + (x.r.name || '')) + '</td>' +
          '<td class="num"><input class="score" id="sc-' + esc(x.id) + '" inputmode="decimal" autocomplete="off" aria-label="คะแนน ' + esc(x.r.name || '') + '"></td>' +
          '<td class="hide-sm"><input class="compact" id="rs-' + esc(x.id) + '" maxlength="1000" placeholder="จำเป็นเมื่อยกเว้น" aria-label="เหตุผล"></td><td class="hide-sm" id="pb-' + esc(x.id) + '"></td></tr>').join('') + '</tbody></table>';
      rows.forEach((x) => fill(x.id, gradeOf(x.id)));
      const ids = rows.map((x) => x.id);
      const mark = (sid) => {
        const v = rowVal(sid);
        const now = v.status + ':' + (v.status === 'scored' ? v.score : '');
        if (now !== base[sid].sig || (v.status === 'excused' && v.reason !== ((gradeOf(sid) || {}).excuseReason || ''))) dirty.add(sid); else dirty.delete(sid);
        q('#row-' + sid).classList.toggle('changed', dirty.has(sid));
        setCount();
      };
      ids.forEach((sid, i) => {
        const sc = q('#sc-' + sid), sel = q('#st-' + sid);
        if (!perms.can_grade) { sc.disabled = sel.disabled = q('#rs-' + sid).disabled = true; return; }
        sc.addEventListener('input', () => { if (sc.value.trim() !== '') sel.value = 'scored'; else if (sel.value === 'scored') sel.value = 'not_assessed'; mark(sid); });
        sc.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); const nx = ids[i + 1]; if (nx) q('#sc-' + nx).focus(); } });
        sel.addEventListener('change', () => { if (sel.value !== 'scored') sc.value = ''; mark(sid); });
        q('#rs-' + sid).addEventListener('input', () => mark(sid));
      });
      on('#ge-fillmax', 'click', () => ids.forEach((sid) => { if (q('#st-' + sid).value === 'not_assessed') { q('#st-' + sid).value = 'scored'; q('#sc-' + sid).value = a.maxScore; mark(sid); } }));
      on('#ge-fillmiss', 'click', () => ids.forEach((sid) => { if (q('#st-' + sid).value === 'not_assessed') { q('#st-' + sid).value = 'missing'; q('#sc-' + sid).value = ''; mark(sid); } }));
      q('#ge-save').addEventListener('click', save);
    }
    // ข้อมูลจากเซิร์ฟเวอร์เปลี่ยน: แถวที่ไม่ได้แก้อัปเดตทันที แถวที่กำลังแก้แจ้งว่ามีผู้อื่นแก้ไว้
    (st.grades || []).forEach((g) => {
      const sid = g.studentId;
      if (!q('#row-' + sid) || !base[sid]) return;
      if ((g.version || 0) === base[sid].version) { q('#cf-' + sid).innerHTML = ''; return; }
      if (!dirty.has(sid)) { fill(sid, g); q('#row-' + sid).classList.add('flash'); setTimeout(() => q('#row-' + sid) && q('#row-' + sid).classList.remove('flash'), 1300); }
      else q('#cf-' + sid).innerHTML = '<span class="chip warn">มีผู้อื่นบันทึกเป็น ' + gradeText(g) + ' แล้ว</span> <button class="btn ghost small" data-take="' + esc(sid) + '">ใช้ค่าล่าสุด</button>';
    });
    on('[data-take]', 'click', (e) => { const sid = e.currentTarget.getAttribute('data-take'); fill(sid, gradeOf(sid)); dirty.delete(sid); q('#row-' + sid).classList.remove('changed'); q('#cf-' + sid).innerHTML = ''; setCount(); }, q('#ge-box'));
    publishBar(q('#ge-pub'), oid, st.a, st.grades, st.perms);
  };
  async function save() {
    const entries = [...dirty].map((sid) => { const v = rowVal(sid); return { studentId: sid, status: v.status, score: v.status === 'scored' ? v.score : '', reason: v.reason, expectedVersion: base[sid].version }; });
    const btn = q('#ge-save'); btn.disabled = true; q('#ge-msg').innerHTML = '';
    try {
      const r = await api('grades.save', { offeringId: oid, assessmentId: aid, entries });
      r.grades.forEach((g) => { base[g.studentId] = { version: g.version, sig: g.status + ':' + (g.status === 'scored' ? g.score : '') }; dirty.delete(g.studentId); const row = q('#row-' + g.studentId); if (row) { row.classList.remove('changed'); row.classList.add('saved'); setTimeout(() => row.classList.remove('saved'), 1500); } });
      toast('บันทึกแล้ว ' + r.saved + ' รายการ (ยังไม่ประกาศ)');
    } catch (err) {
      q('#ge-msg').innerHTML = errBox(err);
      if (err.code === 'CONFLICT' && err.details && err.details.studentId) q('#row-' + err.details.studentId).scrollIntoView({ block: 'center' });
    } finally { setCount(); }
  }
  window.addEventListener('beforeunload', guard);
  function guard(e) { if (dirty.size && q('#ge-save')) { e.preventDefault(); e.returnValue = ''; } else if (!q('#ge-save')) window.removeEventListener('beforeunload', guard); }
  livePerms(oid, (x) => { st.perms = x; build(); });
  live(doc(db, 'offerings', oid, 'assessments', aid), (a) => { st.a = a; if (a && a.kind === 'group') { q('#ge-head').innerHTML = errBox({ message: 'งานกลุ่มให้คะแนนที่หน้าคะแนนกลุ่ม' }); return; } build(); });
  live(collection(db, 'offerings', oid, 'enrollments'), (l) => { st.enrs = st.enrs || l; if (!built) st.enrs = l; build(); });
  live(collection(db, 'offerings', oid, 'roster'), (l) => { st.roster = st.roster || l; build(); });
  live(query(collection(db, 'offerings', oid, 'grades'), where('assessmentId', '==', aid)), (l) => { st.grades = l; build(); }, (err) => { q('#ge-box').innerHTML = errBox(err); });
};

// ---------------------------------------------------------------- ให้คะแนนกลุ่ม
views.groupGrading = (p) => {
  const oid = p.offeringId, aid = p.assessmentId;
  h(backBtn() + '<div id="gg-head"><div class="loading">กำลังโหลด…</div></div><div id="gg-pub"></div><div id="gg-box"></div>');
  bindBack();
  const st = { a: null, groups: null, ggs: null, grades: null, roster: null, perms: null };
  const drafts = {}; // ค่าที่ครูกำลังพิมพ์ในฟอร์มของแต่ละกลุ่ม (ไม่ถูกล้างเมื่อข้อมูลเรียลไทม์เข้ามา)
  const paint = () => {
    const { a, groups, ggs, grades, roster, perms } = st;
    if (!a || !groups || !ggs || !grades || !roster || !perms) return;
    qa('[data-gform]').forEach((f) => { const gid = f.getAttribute('data-gform'); drafts[gid] = { status: q('.g-st', f).value, score: q('.g-sc', f).value, note: q('.g-note', f).value, touched: f.dataset.touched === '1' }; });
    const names = Object.fromEntries(roster.map((r) => [r.id, r]));
    const gradeOf = (sid) => grades.find((g) => g.studentId === sid) || null;
    const list = groups.filter((g) => g.status !== 'disbanded' || g.frozen).sort((x, y) => String(x.name).localeCompare(String(y.name), 'th', { numeric: true }));
    const inGroup = new Set(list.flatMap((g) => g.memberIds || []));
    const loose = roster.filter((r) => r.active && !inGroup.has(r.id));
    q('#gg-head').innerHTML = '<div class="breadcrumb">' + esc(p.title || '') + '</div><h1>คะแนนกลุ่ม: ' + esc(a.code) + ' ' + esc(a.title) + '</h1><p>คะแนนเต็ม <strong>' + esc(a.maxScore) + '</strong>' + (a.countsTowardGrade ? ' · น้ำหนัก ' + esc(a.weight) : ' · ไม่นับคะแนน') + '</p>' +
      '<div class="notice info small">ให้คะแนนครั้งเดียวที่กลุ่ม → ระบบบันทึกคะแนนกลุ่มไว้ที่กลุ่มของงานนี้ และบันทึกเป็นคะแนนรายบุคคลของสมาชิกทุกคนให้อัตโนมัติ (ไม่หารด้วยจำนวนสมาชิก) · สมาชิกที่ครูปรับรายคนไว้จะคงคะแนนเดิมจนกว่าจะยกเลิกการปรับ</div>';
    q('#gg-box').innerHTML = (list.length ? list.map((g) => {
      const gg = ggs.find((x) => x.groupId === g.id) || null;
      const d = drafts[g.id] && drafts[g.id].touched ? drafts[g.id] : { status: gg ? gg.status : 'scored', score: gg && gg.status === 'scored' ? gg.rawScore : '', note: gg ? gg.note || '' : '' };
      return '<div class="card"><div class="row"><h2 style="margin:0">' + esc(g.name) + '</h2><div>' + (g.frozen ? '<span class="chip ok">ตรึงรายชื่อแล้ว</span>' : '<span class="chip neutral">ยังไม่ตรึง (ตรึงเมื่อบันทึกคะแนน)</span>') + '</div></div>' +
        '<p>คะแนนกลุ่ม: ' + (gg ? '<strong style="font-size:1.3rem">' + gradeText(gg) + '</strong> / ' + esc(a.maxScore) + ' <span class="small muted">โดย ' + esc(gg.updatedByName) + ' ' + fmtDate(gg.updatedAt) + (gg.note ? ' · ' + esc(gg.note) : '') + '</span>' : '<span class="chip warn">ยังไม่ให้คะแนน</span>') + '</p>' +
        '<table><thead><tr><th>สมาชิก</th><th class="num">คะแนนรายบุคคล</th><th></th></tr></thead><tbody>' + (g.memberIds || []).map((sid) => {
          const ig = gradeOf(sid);
          return '<tr><td>' + (sid === g.leaderStudentId ? '★ ' : '') + esc((names[sid] || {}).name || sid) + ' <span class="small muted">' + esc((names[sid] || {}).roomLabel || '') + '</span>' + (names[sid] && !names[sid].active ? ' <span class="chip neutral">ถอนแล้ว</span>' : '') + '</td>' +
            '<td class="num"><strong>' + gradeText(ig) + '</strong>' + (ig && ig.isOverride ? ' <span class="chip warn" title="' + esc(ig.overrideReason) + '">ปรับรายคน</span>' : ig && ig.source === 'group' ? ' <span class="small muted">จากกลุ่ม</span>' : '') + '</td>' +
            '<td class="no-print">' + (perms.can_grade ? '<button class="btn ghost small" data-ov="' + esc(sid) + '" data-g="' + esc(g.id) + '">ปรับรายคน</button>' + (ig && ig.isOverride && gg ? ' <button class="btn ghost small" data-clr="' + esc(sid) + '">ใช้คะแนนกลุ่ม</button>' : '') : '') + '</td></tr>';
        }).join('') + '</tbody></table>' +
        (perms.can_grade ? '<div class="no-print" data-gform="' + esc(g.id) + '"' + (drafts[g.id] && drafts[g.id].touched ? ' data-touched="1"' : '') + '><div class="row"><div><label>สถานะ</label>' + statusSelect('gst-' + g.id, d.status, 'สถานะคะแนนกลุ่ม ' + g.name).replace('class="compact"', 'class="compact g-st"') + '</div>' +
          '<div><label for="gsc-' + esc(g.id) + '">คะแนนกลุ่ม / ' + esc(a.maxScore) + '</label><input class="score g-sc" id="gsc-' + esc(g.id) + '" inputmode="decimal" value="' + esc(d.score) + '"></div>' +
          '<div style="flex:3"><label for="gnt-' + esc(g.id) + '">หมายเหตุ</label><input class="g-note" id="gnt-' + esc(g.id) + '" maxlength="2000" value="' + esc(d.note) + '"></div></div>' +
          '<p><button class="btn" data-gsave="' + esc(g.id) + '">' + (gg ? 'แก้คะแนนกลุ่ม' : 'บันทึกคะแนนกลุ่ม') + '</button></p></div>' : '') + '</div>';
    }).join('') : '<div class="card empty">ยังไม่มีกลุ่มในงานนี้ — จัดกลุ่มที่แท็บ "กลุ่ม" ของรายวิชา</div>') +
      (loose.length ? '<div class="card"><h3 style="margin-top:0">ยังไม่มีกลุ่มในงานนี้ (' + loose.length + ')</h3><p class="small">' + loose.map((r) => esc(r.name) + (perms.can_grade ? ' <button class="btn ghost small" data-ov="' + esc(r.id) + '" data-g="">ให้คะแนนรายคน</button>' : '')).join(', ') + '</p></div>' : '');
    qa('[data-gform]').forEach((f) => f.addEventListener('input', () => { f.dataset.touched = '1'; const sc = q('.g-sc', f); if (sc.value.trim()) q('.g-st', f).value = 'scored'; }));
    on('[data-gsave]', 'click', (e) => previewGroup(e.currentTarget.getAttribute('data-gsave')));
    on('[data-ov]', 'click', (e) => overrideModal(e.currentTarget.getAttribute('data-ov'), names));
    on('[data-clr]', 'click', async (e) => {
      const reason = prompt('เหตุผลการยกเลิกการปรับรายคน (กลับไปใช้คะแนนกลุ่ม)');
      if (!reason) return;
      const sid = e.currentTarget.getAttribute('data-clr');
      try { await api('grades.override', { offeringId: oid, assessmentId: aid, studentId: sid, clear: true, reason, expectedVersion: (gradeOf(sid) || {}).version || 0 }); toast('กลับไปใช้คะแนนกลุ่มแล้ว'); } catch (err) { toast(err.message); }
    });
    publishBar(q('#gg-pub'), oid, a, grades, perms);
  };
  async function previewGroup(gid) {
    const f = q('[data-gform="' + gid + '"]');
    const req = { offeringId: oid, assessmentId: aid, groupId: gid, status: q('.g-st', f).value, score: q('.g-sc', f).value.trim(), note: q('.g-note', f).value };
    if (req.status !== 'scored') req.score = '';
    try {
      const pv = await api('grades.saveGroup', Object.assign({ preview: true }, req));
      const ACT = { apply: ['ok', 'บันทึกตามคะแนนกลุ่ม'], keep_override: ['warn', 'คงคะแนนที่ปรับรายคน'], skip_not_enrolled: ['neutral', 'ข้าม (ไม่ได้ลงทะเบียน)'] };
      const fmt = (x) => !x ? '-' : x.status === 'scored' ? esc(x.score) : esc(GRADE_STATUS_LABELS[x.status] || x.status);
      openModal('<h2 id="modal-title" style="margin-top:0">ตรวจก่อนบันทึก: ' + esc(pv.groupName) + '</h2>' +
        '<p>คะแนนกลุ่ม ' + (pv.before ? fmt({ status: pv.before.status, score: pv.before.score }) : 'ยังไม่มี') + ' → <strong>' + fmt(pv.after) + '</strong></p>' +
        (pv.willFreeze ? '<div class="notice warn small">การบันทึกครั้งนี้จะตรึงรายชื่อสมาชิกของกลุ่มในงานนี้ (การย้ายสมาชิกภายหลังต้องระบุเหตุผล)</div>' : '') +
        '<div class="table-wrap"><table><thead><tr><th>สมาชิก</th><th>ก่อน</th><th>หลัง</th><th>การดำเนินการ</th></tr></thead><tbody>' + pv.members.map((m) =>
          '<tr><td>' + esc(m.name) + '</td><td>' + fmt(m.before) + (m.before && m.before.isOverride ? ' <span class="small muted">(ปรับรายคน: ' + esc(m.before.reason) + ')</span>' : '') + '</td><td><strong>' + fmt(m.after) + '</strong></td>' +
          '<td><span class="chip ' + ACT[m.action][0] + '">' + ACT[m.action][1] + '</span>' + (m.action === 'keep_override' ? '<label class="check small"><input type="checkbox" name="clr" value="' + esc(m.studentId) + '"> ใช้คะแนนกลุ่มแทน</label>' : '') + '</td></tr>').join('') + '</tbody></table></div>' +
        '<div id="pv-msg"></div><p><button class="btn" id="pv-ok">ยืนยันบันทึก</button> <button class="btn ghost" data-close>ยกเลิก</button></p>');
      q('#pv-ok').addEventListener('click', async () => {
        const gg = st.ggs.find((x) => x.groupId === gid);
        const clearOverrides = qa('[name=clr]:checked', q('#modal')).map((x) => x.value);
        try {
          const r = await api('grades.saveGroup', Object.assign({}, req, { clearOverrides, expectedVersion: gg ? gg.version || 0 : 0 }));
          toast('บันทึกคะแนนกลุ่มแล้ว · บันทึกให้สมาชิก ' + (r.applied + r.unchanged) + ' คน' + (r.kept ? ' · คงคะแนนปรับรายคน ' + r.kept + ' คน' : ''));
          delete drafts[gid];
          closeModal();
        } catch (err) { q('#pv-msg').innerHTML = errBox(err); }
      });
    } catch (err) { toast(err.message); }
  }
  function overrideModal(sid, names) {
    const ig = st.grades.find((g) => g.studentId === sid) || null;
    openModal('<h2 id="modal-title" style="margin-top:0">ปรับคะแนนรายคน: ' + esc((names[sid] || {}).name || sid) + '</h2><p class="small muted">ใช้เมื่อสมาชิกมีส่วนร่วมต่างจากกลุ่ม คะแนนนี้จะคงอยู่แม้ครูแก้คะแนนกลุ่มภายหลัง</p>' +
      '<div class="row"><div><label>สถานะ</label>' + statusSelect('ov-st', ig ? ig.status : 'scored', 'สถานะ') + '</div><div><label for="ov-sc">คะแนน / ' + esc(st.a.maxScore) + '</label><input class="score" id="ov-sc" inputmode="decimal" value="' + esc(ig && ig.status === 'scored' ? ig.rawScore : '') + '"></div></div>' +
      '<label for="ov-rs">เหตุผลหรือหลักฐานการมีส่วนร่วม *</label><textarea id="ov-rs" maxlength="1000">' + esc(ig && ig.isOverride ? ig.overrideReason : '') + '</textarea><div id="ov-msg"></div>' +
      '<p><button class="btn" id="ov-ok">บันทึก</button> <button class="btn ghost" data-close>ยกเลิก</button></p>');
    q('#ov-sc').addEventListener('input', () => { if (q('#ov-sc').value.trim()) q('#ov-st').value = 'scored'; });
    q('#ov-ok').addEventListener('click', async () => {
      const status = q('#ov-st').value;
      try {
        await api('grades.override', { offeringId: oid, assessmentId: aid, studentId: sid, status, score: status === 'scored' ? q('#ov-sc').value.trim() : '', reason: q('#ov-rs').value, expectedVersion: ig ? ig.version || 0 : 0 });
        toast('ปรับคะแนนรายคนแล้ว'); closeModal();
      } catch (err) { q('#ov-msg').innerHTML = errBox(err); }
    });
  }
  livePerms(oid, (x) => { st.perms = x; paint(); });
  live(doc(db, 'offerings', oid, 'assessments', aid), (a) => { st.a = a; paint(); });
  live(query(collection(db, 'offerings', oid, 'groups'), where('assessmentId', '==', aid)), (l) => { st.groups = l; paint(); });
  live(query(collection(db, 'offerings', oid, 'groupGrades'), where('assessmentId', '==', aid)), (l) => { st.ggs = l; paint(); });
  live(query(collection(db, 'offerings', oid, 'grades'), where('assessmentId', '==', aid)), (l) => { st.grades = l; paint(); }, (err) => { q('#gg-box').innerHTML = errBox(err); });
  live(collection(db, 'offerings', oid, 'roster'), (l) => { st.roster = l; paint(); });
};

export { totalText };
