/**
 * กลุ่มประจำรายวิชา (กลุ่มเดิมทำงานกลุ่มได้หลายงาน) — ตรรกะเดียวกับ gas/WorkGroups.js
 *
 * offerings/{oid}/workGroups/{wgId}  { name, leaderStudentId, memberIds[], invitedIds[], status }
 * offerings/{oid}/roster/{sid}.workGroupId  ตัวกำกับ "หนึ่งคนอยู่ได้หนึ่งกลุ่มต่อรายวิชา"
 * offerings/{oid}/groups/{aid}_{wgId}  กลุ่มของงานกลุ่มแต่ละงาน (สมาชิกซิงก์จากกลุ่มประจำรายวิชาจนกว่าจะตรึง)
 *
 * ทุกการเปลี่ยนแปลงอ่านสถานะกลุ่มทั้งหมดของรายวิชาใน transaction เดียว แล้วเขียนกลับพร้อมกัน
 * → สองคนกดเข้ากลุ่มที่เหลือที่ว่างเดียวพร้อมกัน สำเร็จคนเดียว ไม่มีใครอยู่สองกลุ่ม
 * กลุ่มของงานที่ตรึงแล้ว (ส่งงานครั้งแรก/ครูให้คะแนน) ไม่ถูกแก้ย้อนหลัง คะแนนกลุ่มของงานนั้นจึงอยู่กับกลุ่มเดิมเสมอ
 */
import { db, nowIso, newId, str, requireStr, getDoc, queryDocs, audit, notify, uniqueIds } from './core.js';
import { raise } from './errors.js';
import { requireOffering, requireEnrollment } from './perms.js';

const base = (oid) => 'offerings/' + oid;

// ---------------------------------------------------------------- สถานะในหน่วยความจำ
export async function loadState(t, offering) {
  const b = base(offering.id);
  const [wgs, roster, assessments, groups] = await Promise.all([
    queryDocs(t, db.collection(b + '/workGroups')),
    queryDocs(t, db.collection(b + '/roster')),
    queryDocs(t, db.collection(b + '/assessments').where('kind', '==', 'group')),
    queryDocs(t, db.collection(b + '/groups'))
  ]);
  return {
    offering, wgs: new Map(wgs.map((w) => [w.id, w])), roster: new Map(roster.map((r) => [r.id, r])),
    groupAssessments: assessments.filter((a) => a.status !== 'archived'), groups: new Map(groups.map((g) => [g.id, g])),
    dirtyWg: new Set(), dirtyRoster: new Set(), extraSync: new Set(), history: [], notify: []
  };
}

function hist(st, ctx, wgId, studentId, action, reason, detail) {
  st.history.push({ workGroupId: wgId, studentId: studentId || '', action, reason: reason || '', detail: detail || null, by: ctx ? ctx.uid : '', at: nowIso() });
}

function activeWg(st, wgId) {
  const wg = st.wgs.get(wgId);
  if (!wg || wg.status !== 'active') raise('NOT_FOUND', 'ไม่พบกลุ่ม');
  return wg;
}

function rosterOf(st, sid) {
  const r = st.roster.get(sid);
  if (!r || !r.active) raise('VALIDATION', 'มีนักเรียนที่ไม่ได้ลงทะเบียนในรายวิชานี้');
  return r;
}

/** นำนักเรียนออกจากกลุ่มเดิม (ถ้ามี) — หัวหน้าออกแล้วตั้งหัวหน้าใหม่ ไม่มีสมาชิกแล้วยุบกลุ่ม */
function detach(st, ctx, sid, action, reason) {
  const r = st.roster.get(sid);
  const wgId = r && r.workGroupId;
  if (!wgId) return null;
  const wg = st.wgs.get(wgId);
  if (wg) {
    wg.memberIds = (wg.memberIds || []).filter((x) => x !== sid);
    if (!wg.memberIds.length) {
      wg.status = 'disbanded'; wg.invitedIds = [];
      hist(st, ctx, wg.id, '', 'disband', 'ไม่มีสมาชิก');
    } else if (wg.leaderStudentId === sid) wg.leaderStudentId = wg.memberIds[0];
    st.dirtyWg.add(wg.id);
    hist(st, ctx, wg.id, sid, action, reason);
  }
  r.workGroupId = '';
  st.dirtyRoster.add(sid);
  return wgId;
}

function cancelInvites(st, sid) {
  st.wgs.forEach((w) => {
    if ((w.invitedIds || []).includes(sid)) { w.invitedIds = w.invitedIds.filter((x) => x !== sid); st.dirtyWg.add(w.id); }
  });
}

/** วางนักเรียนเข้ากลุ่ม (ย้ายออกจากกลุ่มเดิมให้อัตโนมัติ) */
function place(st, ctx, wgId, sid, action) {
  const wg = activeWg(st, wgId);
  const r = rosterOf(st, sid);
  if (r.workGroupId === wgId) return false;
  if (r.workGroupId) detach(st, ctx, sid, 'remove', 'ย้ายไปกลุ่ม ' + wg.name);
  cancelInvites(st, sid);
  wg.memberIds = (wg.memberIds || []).concat([sid]);
  if (!wg.leaderStudentId || wg.memberIds.indexOf(wg.leaderStudentId) < 0) wg.leaderStudentId = sid;
  r.workGroupId = wgId;
  st.dirtyWg.add(wgId); st.dirtyRoster.add(sid);
  hist(st, ctx, wgId, sid, action || 'add', '');
  return true;
}

function newGroup(st, ctx, name, note) {
  const nm = requireStr(name, 'ชื่อกลุ่ม', 100);
  st.wgs.forEach((w) => { if (w.status === 'active' && w.name === nm) raise('DUPLICATE', 'มีกลุ่มชื่อนี้แล้ว'); });
  const wg = { id: newId(), name: nm, leaderStudentId: '', memberIds: [], invitedIds: [], status: 'active', note: str(note, 500), createdAt: nowIso(), version: 0 };
  st.wgs.set(wg.id, wg);
  st.dirtyWg.add(wg.id);
  hist(st, ctx, wg.id, '', 'create', '');
  return wg;
}

/** คำนวณกลุ่มของงานกลุ่มทุกงานจากกลุ่มประจำรายวิชาที่เปลี่ยน (เฉพาะกลุ่มของงานที่ยังไม่ตรึง) */
function syncGroups(st) {
  const writes = [];
  st.groupAssessments.forEach((a) => {
    const frozenMembers = new Set();
    st.groups.forEach((g) => {
      if (g.assessmentId === a.id && g.frozen && g.status !== 'disbanded') (g.memberIds || []).forEach((x) => frozenMembers.add(x));
    });
    new Set([...st.dirtyWg, ...(st.extraSyncFor === a.id ? st.extraSync : [])]).forEach((wgId) => {
      const wg = st.wgs.get(wgId);
      const gid = a.id + '_' + wgId;
      const g = st.groups.get(gid);
      if (g && g.frozen) return;
      if (wg.status !== 'active') {
        if (g && g.status !== 'disbanded') writes.push({ id: gid, data: Object.assign({}, g, { memberIds: [], status: 'disbanded', updatedAt: nowIso() }) });
        return;
      }
      const want = (wg.memberIds || []).filter((x) => !frozenMembers.has(x));
      const leader = want.indexOf(wg.leaderStudentId) >= 0 ? wg.leaderStudentId : (want[0] || '');
      const next = Object.assign({ assessmentId: a.id, workGroupId: wgId, frozen: false, snapshotNo: 0, snapshots: {}, createdAt: nowIso() }, g || {},
        { name: wg.name, leaderStudentId: leader, memberIds: want, status: 'active', updatedAt: nowIso() });
      delete next.id;
      writes.push({ id: gid, data: next });
      st.groups.set(gid, Object.assign({ id: gid }, next));
    });
  });
  return writes;
}

export function commit(t, st) {
  const b = base(st.offering.id);
  st.dirtyWg.forEach((id) => {
    const w = Object.assign({}, st.wgs.get(id));
    delete w.id;
    w.updatedAt = nowIso(); w.version = (w.version || 0) + 1;
    t.set(db.doc(b + '/workGroups/' + id), w);
  });
  st.dirtyRoster.forEach((sid) => t.update(db.doc(b + '/roster/' + sid), { workGroupId: st.roster.get(sid).workGroupId || '' }));
  syncGroups(st).forEach((w) => t.set(db.doc(b + '/groups/' + w.id), w.data));
  st.history.forEach((h) => t.set(db.collection(b + '/wgHistory').doc(), h));
}

/** ใช้จากการถอนรายวิชา: อ่านสถานะก่อน แล้วนำนักเรียนออกจากกลุ่มและยกเลิกคำเชิญ */
export const removeFromWorkGroups = {
  read: (t, offering) => loadState(t, offering),
  write: (t, ctx, offering, sid, st, reason) => {
    const r = st.roster.get(sid);
    if (r && r.workGroupId) detach(st, ctx, sid, 'remove', reason);
    cancelInvites(st, sid);
    if (r) { r.active = false; }
    commit(t, st);
  }
};

async function staffMutation(ctx, d, fn) {
  return db.runTransaction(async (t) => {
    const { offering } = await requireOffering(ctx, d.offeringId, 'can_manage', t);
    const st = await loadState(t, offering);
    const out = await fn(st);
    commit(t, st);
    return out;
  });
}

async function studentMutation(ctx, d, fn) {
  const res = await db.runTransaction(async (t) => {
    const { offering } = await requireEnrollment(ctx, d.offeringId, true, t);
    if (offering.groupSettings && offering.groupSettings.locked) raise('GROUPS_LOCKED');
    const st = await loadState(t, offering);
    const me = st.roster.get(ctx.studentId);
    if (!me || !me.active) raise('NOT_ENROLLED');
    const out = await fn(st, me);
    commit(t, st);
    return { out, notify: st.notify };
  });
  for (const n of res.notify) await notify(n.uids, n.type, n.title, n.body, n.link);
  return res.out;
}

const maxSize = (st) => Number(st.offering.groupSettings && st.offering.groupSettings.maxSize || 0);

async function studentUids(ids) {
  if (!ids.length) return [];
  const snaps = await db.getAll(...ids.map((id) => db.doc('students/' + id)));
  return snaps.filter((s) => s.exists && s.get('uid')).map((s) => s.get('uid'));
}

// ---------------------------------------------------------------- ครู / ผู้ดูแล
export async function saveSettings(ctx, d) {
  const max = Number(d.maxSize || 0);
  if (!Number.isInteger(max) || max < 0 || max > 50) raise('VALIDATION', 'จำนวนสมาชิกสูงสุดต้องเป็น 0–50 (0 = ไม่จำกัด)');
  const gs = { maxSize: max, leaderDirectAdd: !!d.leaderDirectAdd, locked: !!d.locked };
  await db.runTransaction(async (t) => {
    const { offering } = await requireOffering(ctx, d.offeringId, 'can_manage', t);
    t.update(db.doc(base(offering.id)), { groupSettings: gs });
  });
  await audit(ctx, 'wg.settings', 'offerings', d.offeringId, gs, '', d.offeringId);
  return gs;
}

/** สร้าง/แก้กลุ่ม (ชื่อ หัวหน้า) และใส่สมาชิกเริ่มต้น */
export async function save(ctx, d) {
  const out = await staffMutation(ctx, d, (st) => {
    let wg;
    if (d.id) {
      wg = activeWg(st, d.id);
      if (d.version !== undefined && d.version !== null && Number(d.version) !== Number(wg.version || 0)) raise('CONFLICT');
      const name = requireStr(d.name, 'ชื่อกลุ่ม', 100);
      st.wgs.forEach((w) => { if (w.id !== wg.id && w.status === 'active' && w.name === name) raise('DUPLICATE', 'มีกลุ่มชื่อนี้แล้ว'); });
      if (name !== wg.name) { wg.name = name; hist(st, ctx, wg.id, '', 'rename', '', { name }); }
      if (d.note !== undefined) wg.note = str(d.note, 500);
      st.dirtyWg.add(wg.id);
    } else wg = newGroup(st, ctx, d.name, d.note);
    uniqueIds(d.studentIds, 100).forEach((sid) => place(st, ctx, wg.id, sid, 'add'));
    if (d.leaderStudentId) {
      if ((wg.memberIds || []).indexOf(d.leaderStudentId) < 0) raise('VALIDATION', 'หัวหน้ากลุ่มต้องเป็นสมาชิกของกลุ่ม');
      if (wg.leaderStudentId !== d.leaderStudentId) { wg.leaderStudentId = d.leaderStudentId; hist(st, ctx, wg.id, d.leaderStudentId, 'leader', ''); }
    }
    return { id: wg.id };
  });
  await audit(ctx, d.id ? 'wg.update' : 'wg.create', 'workGroups', out.id, { name: d.name }, '', d.offeringId);
  return out;
}

/** ครู/ผู้ดูแลเพิ่มนักเรียนเข้ากลุ่มโดยตรง (ย้ายออกจากกลุ่มเดิมให้อัตโนมัติ) */
export async function addMembers(ctx, d) {
  const ids = uniqueIds(d.studentIds, 100);
  if (!ids.length) raise('VALIDATION', 'กรุณาเลือกนักเรียน');
  const out = await staffMutation(ctx, d, (st) => {
    const wg = activeWg(st, d.workGroupId);
    let moved = 0;
    ids.forEach((sid) => {
      const r = rosterOf(st, sid);
      if (r.workGroupId && r.workGroupId !== wg.id) moved++;
      place(st, ctx, wg.id, sid, 'add');
    });
    const max = maxSize(st);
    return { count: wg.memberIds.length, moved, overMax: !!(max && wg.memberIds.length > max) };
  });
  await audit(ctx, 'wg.addMembers', 'workGroups', d.workGroupId, { students: ids, moved: out.moved }, '', d.offeringId);
  return out;
}

export async function removeMember(ctx, d) {
  await staffMutation(ctx, d, (st) => {
    const wg = activeWg(st, d.workGroupId);
    if ((wg.invitedIds || []).includes(d.studentId)) { wg.invitedIds = wg.invitedIds.filter((x) => x !== d.studentId); st.dirtyWg.add(wg.id); return; }
    const r = st.roster.get(d.studentId);
    if (!r || r.workGroupId !== wg.id) raise('NOT_FOUND');
    detach(st, ctx, d.studentId, 'remove', str(d.reason, 500));
  });
  await audit(ctx, 'wg.removeMember', 'workGroups', d.workGroupId, { student: d.studentId }, str(d.reason, 500), d.offeringId);
  return { ok: true };
}

export async function disband(ctx, d) {
  await staffMutation(ctx, d, (st) => {
    const wg = activeWg(st, d.workGroupId);
    (wg.memberIds || []).slice().forEach((sid) => detach(st, ctx, sid, 'remove', 'ยุบกลุ่ม'));
    wg.status = 'disbanded'; wg.invitedIds = []; wg.memberIds = [];
    st.dirtyWg.add(wg.id);
    hist(st, ctx, wg.id, '', 'disband', str(d.reason, 500));
  });
  await audit(ctx, 'wg.disband', 'workGroups', d.workGroupId, {}, str(d.reason, 500), d.offeringId);
  return { ok: true };
}

/** สุ่มจัดนักเรียนที่ยังไม่มีกลุ่มเป็นกลุ่มละ size คน (แยกตามห้องได้) */
export async function autoGroup(ctx, d) {
  const size = Number(d.size);
  if (!Number.isInteger(size) || size < 1 || size > 50) raise('VALIDATION', 'จำนวนสมาชิกต่อกลุ่มต้องเป็น 1–50');
  const out = await staffMutation(ctx, d, (st) => {
    const pool = [...st.roster.values()].filter((r) => r.active && !r.workGroupId);
    const buckets = {};
    pool.forEach((r) => { const k = d.byRoom ? r.roomLabel || '' : '*'; (buckets[k] = buckets[k] || []).push(r.id); });
    const names = new Set([...st.wgs.values()].filter((w) => w.status === 'active').map((w) => w.name));
    let seq = names.size, created = 0;
    Object.keys(buckets).sort().forEach((k) => {
      const list = buckets[k];
      for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; }
      for (let s = 0; s < list.length; s += size) {
        let name;
        do { seq++; name = 'กลุ่ม ' + seq; } while (names.has(name));
        names.add(name);
        const wg = newGroup(st, ctx, name, '');
        list.slice(s, s + size).forEach((sid) => place(st, ctx, wg.id, sid, 'add'));
        created++;
      }
    });
    return { created, students: pool.length };
  });
  await audit(ctx, 'wg.auto', 'offerings', d.offeringId, out, '', d.offeringId);
  return out;
}

// ---------------------------------------------------------------- นักเรียน
export async function studentCreate(ctx, d) {
  return studentMutation(ctx, d, (st, me) => {
    if (me.workGroupId) raise('GROUP_ALREADY_MEMBER');
    const wg = newGroup(st, ctx, d.name, '');
    place(st, ctx, wg.id, ctx.studentId, 'accept');
    return { id: wg.id };
  });
}

/** หัวหน้ากลุ่มเลือกสมาชิก: ส่งคำเชิญ (ค่าเริ่มต้น) หรือเพิ่มทันทีเมื่อครูอนุญาต */
export async function invite(ctx, d) {
  const ids = uniqueIds(d.studentIds, 50);
  if (!ids.length) raise('VALIDATION', 'กรุณาเลือกเพื่อนอย่างน้อยหนึ่งคน');
  const uids = await studentUids(ids);
  return studentMutation(ctx, d, (st, me) => {
    if (!me.workGroupId) raise('GROUP_REQUIRED', 'กรุณาสร้างกลุ่มก่อน');
    const wg = activeWg(st, me.workGroupId);
    if (wg.leaderStudentId !== ctx.studentId) raise('FORBIDDEN', 'เฉพาะหัวหน้ากลุ่มเลือกสมาชิกได้');
    const direct = !!(st.offering.groupSettings && st.offering.groupSettings.leaderDirectAdd);
    const max = maxSize(st);
    ids.forEach((sid) => {
      const r = st.roster.get(sid);
      if (!r || !r.active || sid === ctx.studentId) raise('VALIDATION', 'เลือกได้เฉพาะเพื่อนที่ลงทะเบียนในรายวิชานี้');
      if (r.workGroupId) raise('VALIDATION', r.name + ' อยู่ในกลุ่มอื่นแล้ว');
      if (direct) {
        if (max && wg.memberIds.length + 1 > max) raise('GROUP_FULL', 'กลุ่มมีสมาชิกครบ ' + max + ' คนแล้ว');
        place(st, ctx, wg.id, sid, 'add');
      } else if (!(wg.invitedIds || []).includes(sid)) {
        wg.invitedIds = (wg.invitedIds || []).concat([sid]);
        st.dirtyWg.add(wg.id);
        hist(st, ctx, wg.id, sid, 'invite', '');
      }
    });
    st.notify.push({ uids, type: 'group_invite', title: (direct ? 'คุณถูกเพิ่มเข้ากลุ่ม "' : 'ได้รับคำเชิญเข้ากลุ่ม "') + wg.name + '"', body: 'เปิดรายวิชาเพื่อดูรายละเอียดกลุ่ม', link: 'offering:' + st.offering.id });
    return { mode: direct ? 'added' : 'invited', count: ids.length };
  });
}

export async function respond(ctx, d) {
  return studentMutation(ctx, d, (st, me) => {
    const wg = st.wgs.get(String(d.workGroupId || ''));
    if (!wg || !(wg.invitedIds || []).includes(ctx.studentId)) raise('NOT_FOUND', 'ไม่พบคำเชิญ');
    if (!d.accept) {
      wg.invitedIds = wg.invitedIds.filter((x) => x !== ctx.studentId);
      st.dirtyWg.add(wg.id);
      hist(st, ctx, wg.id, ctx.studentId, 'decline', '');
      return { ok: true };
    }
    if (wg.status !== 'active') raise('NOT_FOUND', 'กลุ่มนี้ถูกยุบแล้ว');
    if (me.workGroupId) raise('GROUP_ALREADY_MEMBER', 'คุณมีกลุ่มในรายวิชานี้แล้ว ต้องออกจากกลุ่มเดิมก่อน');
    const max = maxSize(st);
    if (max && (wg.memberIds || []).length >= max) raise('GROUP_FULL');
    place(st, ctx, wg.id, ctx.studentId, 'accept');
    return { ok: true, workGroupId: wg.id };
  });
}

export async function leave(ctx, d) {
  return studentMutation(ctx, d, (st, me) => {
    if (!me.workGroupId) raise('GROUP_REQUIRED');
    detach(st, ctx, ctx.studentId, 'leave', '');
    return { ok: true };
  });
}

/** หัวหน้ากลุ่มนำสมาชิกออก หรือยกเลิกคำเชิญ */
export async function leaderRemove(ctx, d) {
  return studentMutation(ctx, d, (st, me) => {
    if (!me.workGroupId) raise('FORBIDDEN', 'เฉพาะหัวหน้ากลุ่ม');
    const wg = activeWg(st, me.workGroupId);
    if (wg.leaderStudentId !== ctx.studentId) raise('FORBIDDEN', 'เฉพาะหัวหน้ากลุ่ม');
    if (d.studentId === ctx.studentId) raise('VALIDATION', 'ใช้ "ออกจากกลุ่ม" แทน');
    if ((wg.invitedIds || []).includes(d.studentId)) { wg.invitedIds = wg.invitedIds.filter((x) => x !== d.studentId); st.dirtyWg.add(wg.id); return { ok: true }; }
    const r = st.roster.get(d.studentId);
    if (!r || r.workGroupId !== wg.id) raise('NOT_FOUND');
    detach(st, ctx, d.studentId, 'remove', 'หัวหน้ากลุ่มนำออก');
    return { ok: true };
  });
}

/** สร้างกลุ่มของงานกลุ่มใหม่ตามกลุ่มประจำรายวิชาทั้งหมด (เรียกเมื่อบันทึกงานกลุ่ม ภายใน transaction ของงานนั้น) */
export function syncAllForAssessment(st, assessment) {
  st.groupAssessments = st.groupAssessments.filter((a) => a.id !== assessment.id).concat(assessment.status === 'archived' ? [] : [assessment]);
  st.extraSyncFor = assessment.id;
  st.wgs.forEach((w) => st.extraSync.add(w.id));
}
