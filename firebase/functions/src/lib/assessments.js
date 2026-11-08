/**
 * ภาระงาน/รายการประเมิน (งานเดี่ยว งานกลุ่ม สอบ รับคะแนนอย่างเดียว) และการปรับสมาชิกกลุ่มของงานที่ตรึงแล้ว
 * ตรรกะเดียวกับ gas/Teaching.saveAssessment — งานกลุ่มในรุ่น Firebase ใช้กลุ่มประจำรายวิชาเสมอ (กลุ่มเดิมทำได้หลายงาน)
 */
import { db, nowIso, newId, str, requireStr, decimal, isoOrEmpty, getDoc, queryDocs, audit } from './core.js';
import { raise } from './errors.js';
import { requireOffering, openForChanges } from './perms.js';
import { getSchool } from './accounts.js';
import { settingsOf } from './registry.js';
import { loadState, commit, syncAllForAssessment } from './workgroups.js';
import { recomputePublished } from './grades.js';
import Dec from '../shared/dec.js';

const KINDS = ['individual', 'group', 'exam', 'score_only'];

export async function saveAssessment(ctx, d) {
  const school = await getSchool(ctx.schoolId);
  const settings = settingsOf(school);
  const kind = d.kind;
  if (KINDS.indexOf(kind) < 0) raise('VALIDATION', 'ประเภทงานไม่ถูกต้อง');
  const mode = kind === 'exam' || kind === 'score_only' ? 'none' : (d.allowLinks ? 'file_or_link' : 'file');
  const counts = d.countsTowardGrade !== false;
  const maxScore = Dec.isValid(d.maxScore) ? Dec.normalize(d.maxScore) : '';
  let weight = d.weight === '' || d.weight === undefined || d.weight === null ? '0' : d.weight;
  if (!Dec.isValid(weight) || Number(weight) < 0) raise('VALIDATION', 'น้ำหนักต้องเป็นตัวเลขไม่ติดลบ');
  weight = Dec.normalize(weight);
  if (counts && (!maxScore || Number(maxScore) <= 0)) raise('VALIDATION', 'รายการที่นับคะแนนต้องมีคะแนนเต็มมากกว่า 0');
  if (!counts) weight = '0';
  const open = isoOrEmpty(d.openAt, 'เปิดรับ'), due = isoOrEmpty(d.dueAt, 'กำหนดส่ง'), close = isoOrEmpty(d.closeAt, 'ปิดรับ');
  if (open && due && open > due) raise('VALIDATION', 'วันเปิดรับต้องไม่หลังกำหนดส่ง');
  if (due && close && close < due) raise('VALIDATION', 'วันปิดรับต้องไม่ก่อนกำหนดส่ง');
  const school_types = settings.allowedFileTypes;
  const types = (Array.isArray(d.allowedTypes) ? d.allowedTypes : String(d.allowedTypes || '').split(/[,\s;]+/)).map((x) => String(x).trim().toLowerCase()).filter(Boolean);
  types.forEach((x) => { if (school_types.indexOf(x) < 0) raise('VALIDATION', 'ชนิดไฟล์ .' + x + ' ไม่อยู่ในรายการที่โรงเรียนอนุญาต'); });
  const maxFiles = d.maxFiles ? Number(d.maxFiles) : null;
  if (maxFiles !== null && (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > settings.maxFilesPerSubmission)) raise('VALIDATION', 'จำนวนไฟล์ต้องอยู่ระหว่าง 1–' + settings.maxFilesPerSubmission);
  const maxMb = d.maxFileMb ? Number(d.maxFileMb) : null;
  if (maxMb !== null && (!Number.isInteger(maxMb) || maxMb < 1 || maxMb > settings.maxFileMb)) raise('VALIDATION', 'ขนาดไฟล์ต้องไม่เกิน ' + settings.maxFileMb + ' MB (เพดานของโรงเรียน)');
  const attempts = Number(d.maxAttempts || 0);
  if (!Number.isInteger(attempts) || attempts < 0) raise('VALIDATION', 'จำนวนครั้งที่ส่งได้ไม่ถูกต้อง');
  let group = null;
  if (kind === 'group') {
    const g = d.group || {};
    const min = Number(g.minSize || 1), max = Number(g.maxSize || 10);
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max < min || max > 50) raise('VALIDATION', 'จำนวนสมาชิกกลุ่มไม่ถูกต้อง');
    group = { minSize: min, maxSize: max, submitPolicy: g.submitPolicy === 'leader_only' ? 'leader_only' : 'any_member' };
  }
  const code = requireStr(d.code, 'รหัสงาน', 30);
  const data = {
    code, title: requireStr(d.title, 'ชื่องาน', 200), description: str(d.description, 10000), kind, submissionMode: mode,
    maxScore, weight, countsTowardGrade: counts, categoryId: str(d.categoryId, 64), openAt: open, dueAt: due, closeAt: close,
    allowLate: !!d.allowLate, allowedTypes: types, maxFiles, maxFileMb: maxMb, maxAttempts: attempts, allowLinks: mode === 'file_or_link', group
  };
  if (d.status !== undefined) data.status = d.status === 'published' ? 'published' : (d.status === 'archived' ? 'archived' : 'draft');
  const id = d.id || newId();
  let weightsChanged = false;
  const saved = await db.runTransaction(async (t) => {
    const { offering } = await requireOffering(ctx, d.offeringId, 'can_manage', t);
    openForChanges(offering);
    if (counts && offering.calcMethod === 'per_item' && Number(weight) <= 0) raise('VALIDATION', 'รายการที่นับคะแนนต้องมีน้ำหนักเป็นบวก (งานฝึกให้เลือก "ไม่นับคะแนน")');
    const b = 'offerings/' + offering.id;
    const cur = d.id ? await getDoc(t, db.doc(b + '/assessments/' + id)) : null;
    if (d.id && !cur) raise('NOT_FOUND');
    if (cur && d.version !== undefined && d.version !== null && Number(d.version) !== Number(cur.version)) raise('CONFLICT');
    const sameCode = await queryDocs(t, db.collection(b + '/assessments').where('code', '==', code));
    if (sameCode.some((x) => x.id !== id)) raise('DUPLICATE', 'รหัสงาน ' + code + ' ซ้ำในรายวิชานี้');
    if (cur) {
      const subs = await t.get(db.collection(b + '/submissions').where('assessmentId', '==', id).where('currentVersionNo', '>', 0).limit(1));
      if (!subs.empty && cur.kind !== kind) raise('VALIDATION', 'มีการส่งงานแล้ว เปลี่ยนประเภทงานไม่ได้');
      const scored = await t.get(db.collection(b + '/grades').where('assessmentId', '==', id).where('status', '==', 'scored').limit(1));
      if (!scored.empty && (Dec.normalize(cur.maxScore || '0') !== Dec.normalize(maxScore || '0') || Dec.normalize(cur.weight || '0') !== weight || !!cur.countsTowardGrade !== counts)) {
        raise('VALIDATION', 'มีคะแนนแล้ว การเปลี่ยนคะแนนเต็ม/น้ำหนักต้องทำผ่านการสร้างรุ่นนโยบายคะแนนใหม่พร้อมเหตุผล');
      }
    }
    const st = kind === 'group' ? await loadState(t, offering) : null;
    const doc = Object.assign({}, cur || {}, data, { updatedAt: nowIso(), updatedBy: ctx.uid, version: (cur ? cur.version || 0 : 0) + 1 });
    delete doc.id;
    if (!cur) {
      doc.status = data.status || 'draft';
      doc.createdAt = nowIso();
      const all = await t.get(db.collection(b + '/assessments').select());
      doc.sort = all.size + 1;
    }
    weightsChanged = !cur || cur.weight !== doc.weight || cur.countsTowardGrade !== doc.countsTowardGrade || (cur.status === 'archived') !== (doc.status === 'archived');
    t.set(db.doc(b + '/assessments/' + id), doc);
    if (st) { syncAllForAssessment(st, Object.assign({ id }, doc)); commit(t, st); }
    return Object.assign({ id }, doc);
  });
  if (weightsChanged) await recomputePublished(d.offeringId);
  await audit(ctx, d.id ? 'assessment.update' : 'assessment.create', 'assessments', id, { code, status: saved.status }, '', d.offeringId);
  return { id, version: saved.version, status: saved.status };
}

/** ขยายเวลารายบุคคลหรือรายกลุ่ม (ต้องมีเหตุผล) */
export async function grantExtension(ctx, d) {
  const reason = requireStr(d.reason, 'เหตุผล', 500);
  if (['student', 'group'].indexOf(d.targetType) < 0) raise('VALIDATION');
  const due = isoOrEmpty(d.dueAt, 'กำหนดส่ง'), close = isoOrEmpty(d.closeAt, 'ปิดรับ');
  if (!due && !close) raise('VALIDATION', 'กรุณาระบุวันที่ขยาย');
  if (due && close && close < due) raise('VALIDATION', 'วันปิดรับต้องไม่ก่อนกำหนดส่ง');
  await db.runTransaction(async (t) => {
    const { offering } = await requireOffering(ctx, d.offeringId, 'can_manage', t);
    const b = 'offerings/' + offering.id;
    const a = await getDoc(t, db.doc(b + '/assessments/' + String(d.assessmentId || '')));
    if (!a) raise('NOT_FOUND');
    const target = d.targetType === 'student' ? await getDoc(t, db.doc(b + '/enrollments/' + d.targetId)) : await getDoc(t, db.doc(b + '/groups/' + d.targetId));
    if (!target || (d.targetType === 'group' && target.assessmentId !== a.id)) raise('NOT_FOUND');
    t.set(db.doc(b + '/extensions/' + a.id + '_' + d.targetId), { assessmentId: a.id, targetType: d.targetType, targetId: d.targetId, dueAt: due, closeAt: close, reason, by: ctx.uid, at: nowIso() });
  });
  await audit(ctx, 'assessment.extend', 'extensions', d.assessmentId + '_' + d.targetId, { due, close }, reason, d.offeringId);
  return { ok: true };
}

/**
 * ครูย้ายนักเรียนระหว่างกลุ่มของงานที่ตรึงรายชื่อแล้ว (เช่น หลังส่งงาน) — ต้องดูผลกระทบและยืนยันพร้อมเหตุผล
 * สร้างรายชื่อชุดใหม่ (snapshot) รุ่นการส่งเดิมยังผูกกับรายชื่อชุดเดิม คะแนนเดิมไม่ถูกย้ายอัตโนมัติ
 */
export async function moveFrozenMember(ctx, d) {
  const reason = str(d.reason, 500);
  const out = await db.runTransaction(async (t) => {
    const { offering } = await requireOffering(ctx, d.offeringId, 'can_manage', t);
    const b = 'offerings/' + offering.id;
    const groups = await queryDocs(t, db.collection(b + '/groups').where('assessmentId', '==', String(d.assessmentId || '')));
    const from = groups.find((g) => g.status !== 'disbanded' && (g.memberIds || []).includes(d.studentId));
    const to = groups.find((g) => g.id === d.toGroupId && g.status !== 'disbanded');
    if (!to) raise('NOT_FOUND', 'ไม่พบกลุ่มปลายทาง');
    if (from && from.id === to.id) return { unchanged: true };
    if (from && !from.frozen) raise('VALIDATION', 'กลุ่มนี้ยังไม่ตรึงรายชื่อ ให้ย้ายสมาชิกที่หน้า "กลุ่มประจำรายวิชา"');
    const roster = await getDoc(t, db.doc(b + '/roster/' + d.studentId));
    if (!roster || !roster.active) raise('VALIDATION', 'นักเรียนไม่ได้ลงทะเบียนในรายวิชานี้');
    const subs = await getManySubs(t, b, d.assessmentId, [from, to].filter(Boolean));
    const ggs = await queryDocs(t, db.collection(b + '/groupGrades').where('assessmentId', '==', d.assessmentId));
    if (!d.confirm) {
      return {
        needsConfirm: true,
        impact: [from, to].filter(Boolean).map((g) => ({
          groupId: g.id, groupName: g.name, frozen: !!g.frozen, snapshotNo: g.snapshotNo || 0,
          submittedVersions: subs[g.id] ? subs[g.id].currentVersionNo || 0 : 0, hasGroupGrade: ggs.some((x) => x.groupId === g.id),
          note: 'รุ่นการส่งเดิมยังผูกกับรายชื่อชุดเดิม คะแนนเดิมไม่ถูกย้ายอัตโนมัติ ระบบจะสร้างรายชื่อชุดใหม่'
        }))
      };
    }
    if (!reason) raise('VALIDATION', 'กรุณาระบุเหตุผล');
    const now = nowIso();
    const snap = (g, members, trigger) => {
      const no = (g.snapshotNo || 0) + 1;
      const snapshots = Object.assign({}, g.snapshots || {});
      snapshots[String(no)] = members;
      return { memberIds: members, frozen: true, frozenAt: g.frozenAt || now, frozenReason: g.frozenReason || trigger, snapshotNo: no, snapshots, updatedAt: now };
    };
    if (from) {
      const members = from.memberIds.filter((x) => x !== d.studentId);
      t.update(db.doc(b + '/groups/' + from.id), Object.assign(snap(from, members, 'teacher'), { leaderStudentId: from.leaderStudentId === d.studentId ? (members[0] || '') : from.leaderStudentId }));
    }
    t.update(db.doc(b + '/groups/' + to.id), snap(to, (to.memberIds || []).concat([d.studentId]), 'teacher'));
    if (subs[to.id]) t.update(db.doc(b + '/submissions/' + subs[to.id].id), { memberIds: [...new Set((subs[to.id].memberIds || []).concat([d.studentId]))] });
    t.set(db.collection(b + '/wgHistory').doc(), { workGroupId: to.workGroupId || '', studentId: d.studentId, action: 'move_frozen', reason, detail: { assessmentId: d.assessmentId, from: from ? from.id : '', to: to.id }, by: ctx.uid, at: now });
    return { ok: true };
  });
  if (out.ok) await audit(ctx, 'group.teacherMove', 'groups', d.toGroupId, { student: d.studentId, assessment: d.assessmentId }, reason, d.offeringId);
  return out;
}

async function getManySubs(t, b, assessmentId, groups) {
  const out = {};
  for (const g of groups) {
    const s = await getDoc(t, db.doc(b + '/submissions/' + assessmentId + '_' + g.id));
    if (s) out[g.id] = s;
  }
  return out;
}
