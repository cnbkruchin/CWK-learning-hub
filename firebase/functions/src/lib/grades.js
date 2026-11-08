/**
 * การให้คะแนน คะแนนกลุ่ม การปรับรายคน การประกาศ (ตรรกะเดียวกับ gas/Gradebook.js)
 *
 * offerings/{oid}/grades/{aid}_{sid}        คะแนนปัจจุบันของนักเรียนต่อรายการ (ครูเห็น)
 * offerings/{oid}/groupGrades/{aid}_{gid}   คะแนนกลุ่มของแต่ละงาน — "คะแนนกลุ่มอยู่ที่กลุ่ม"
 * offerings/{oid}/revisions/{id}            ประวัติทุกครั้ง (ค่าก่อน/หลัง ที่มา เหตุผล ผู้แก้ เวลา)
 * offerings/{oid}/published/{sid}           เฉพาะค่าที่ประกาศ + คะแนนรวม (นักเรียนเห็นแบบเรียลไทม์)
 *
 * ให้คะแนนกลุ่มครั้งเดียว → บันทึกคะแนนกลุ่ม + คะแนนรายบุคคลของสมาชิกทุกคนที่ตรึงไว้ใน transaction เดียว
 * (ไม่หารด้วยจำนวนสมาชิก) สมาชิกที่ครูปรับรายคนไว้คงคะแนนเดิมจนกว่าครูเลือกยกเลิกการปรับ
 */
import { FieldValue } from 'firebase-admin/firestore';
import { db, nowIso, str, requireStr, getDoc, getMany, queryDocs, audit, notify, writeInChunks } from './core.js';
import { raise } from './errors.js';
import { requireOffering, openForChanges } from './perms.js';
import { GRADE_STATUSES } from '../shared/config.js';
import { policyOf, sortAssessments, computeTotal, itemsOf } from '../shared/gradebook.js';
import Dec from '../shared/dec.js';

const gradeId = (aid, sid) => aid + '_' + sid;

function checkValue(a, status, score) {
  if (GRADE_STATUSES.indexOf(status) < 0) raise('VALIDATION', 'สถานะคะแนนไม่ถูกต้อง');
  if (status !== 'scored') return '';
  if (!Dec.isValid(score)) raise('VALIDATION', 'คะแนนต้องเป็นตัวเลข (ช่องว่างไม่ถือเป็นศูนย์)');
  const v = Dec.normalize(score);
  const R = Dec.R;
  if (R.cmp(R.of(v), R.zero()) < 0) raise('VALIDATION', 'คะแนนติดลบไม่ได้');
  if (R.cmp(R.of(v), R.of(a.maxScore || '0')) > 0) raise('VALIDATION', 'คะแนน ' + v + ' เกินคะแนนเต็ม ' + a.maxScore);
  return v;
}

function expectVersion(cur, expected, details) {
  if (expected === undefined || expected === null || expected === '') return;
  if (Number(cur ? cur.version || 0 : 0) !== Number(expected)) raise('CONFLICT', 'คะแนนนี้ถูกแก้ไขโดยผู้อื่นแล้ว กรุณาโหลดข้อมูลล่าสุด', details || null);
}

/** เขียนคะแนนรายบุคคล + ประวัติ (ใน transaction หลังอ่านครบแล้ว) */
function writeGrade(t, ctx, oid, a, sid, cur, next) {
  const score = next.status === 'scored' ? next.score : '';
  const prev = cur ? { status: cur.status, score: cur.rawScore || '' } : { status: 'not_assessed', score: '' };
  const same = cur && cur.status === next.status && String(cur.rawScore || '') === String(score || '') &&
    (next.isOverride === undefined || !!cur.isOverride === !!next.isOverride) &&
    (next.groupGradeId === undefined || String(cur.groupGradeId || '') === String(next.groupGradeId || '')) &&
    (next.excuseReason === undefined || String(cur.excuseReason || '') === String(next.excuseReason || ''));
  if (same) return { changed: false, doc: cur };
  const version = (cur ? cur.version || 0 : 0) + 1;
  const doc = Object.assign({
    assessmentId: a.id, studentId: sid, publication: 'draft', publishedStatus: '', publishedScore: '', publishedAt: '',
    isOverride: false, overrideReason: '', excuseReason: '', groupGradeId: ''
  }, cur || {}, {
    status: next.status, rawScore: score, source: next.source || 'teacher', sourceRef: next.sourceRef || '', publication: 'draft',
    version, updatedAt: nowIso(), updatedBy: ctx.uid, updatedByName: ctx.name
  });
  if (next.groupGradeId !== undefined) doc.groupGradeId = next.groupGradeId || '';
  if (next.isOverride !== undefined) { doc.isOverride = !!next.isOverride; doc.overrideReason = next.isOverride ? next.overrideReason || '' : ''; }
  if (next.excuseReason !== undefined) doc.excuseReason = next.status === 'excused' ? next.excuseReason || '' : '';
  delete doc.id;
  const b = 'offerings/' + oid;
  t.set(db.doc(b + '/grades/' + gradeId(a.id, sid)), doc);
  t.set(db.collection(b + '/revisions').doc(), {
    gradeId: gradeId(a.id, sid), assessmentId: a.id, studentId: sid, revisionNo: version, fromStatus: prev.status, fromScore: prev.score,
    toStatus: doc.status, toScore: doc.rawScore, source: doc.source, sourceRef: doc.sourceRef, reason: next.reason || '',
    byUid: ctx.uid, byName: ctx.name, at: nowIso()
  });
  return { changed: true, doc };
}

async function loadAssessment(t, oid, aid) {
  const a = await getDoc(t, db.doc('offerings/' + oid + '/assessments/' + String(aid || '')));
  if (!a) raise('NOT_FOUND');
  return a;
}

// ---------------------------------------------------------------- คะแนนรายบุคคล
export async function saveScores(ctx, d) {
  const entries = d.entries || [];
  if (!entries.length) raise('VALIDATION', 'ไม่มีคะแนนที่จะบันทึก');
  if (entries.length > 300) raise('VALIDATION', 'บันทึกได้ครั้งละไม่เกิน 300 รายการ');
  const out = await db.runTransaction(async (t) => {
    const { offering, perms } = await requireOffering(ctx, d.offeringId, 'can_grade', t);
    openForChanges(offering);
    const a = await loadAssessment(t, offering.id, d.assessmentId);
    if (a.kind === 'group') raise('VALIDATION', 'งานกลุ่มให้คะแนนที่กลุ่ม หรือปรับรายคนพร้อมเหตุผล');
    const clean = entries.map((e) => {
      const status = e.status || 'scored';
      const reason = str(e.reason, 1000, 'เหตุผล');
      if (status === 'excused' && !reason) raise('VALIDATION', 'การยกเว้นต้องระบุเหตุผล');
      return { studentId: String(e.studentId || ''), status, score: checkValue(a, status, e.score), reason, expectedVersion: e.expectedVersion };
    });
    const b = 'offerings/' + offering.id;
    const enrs = await getMany(t, clean.map((e) => db.doc(b + '/enrollments/' + e.studentId)));
    const grades = await getMany(t, clean.map((e) => db.doc(b + '/grades/' + gradeId(a.id, e.studentId))));
    const res = { saved: 0, unchanged: 0, grades: [] };
    clean.forEach((e) => {
      const enr = enrs.get(e.studentId);
      if (!enr) raise('NOT_FOUND', 'นักเรียนไม่ได้ลงทะเบียนในรายวิชานี้');
      const cur = grades.get(gradeId(a.id, e.studentId)) || null;
      if (!cur && enr.status !== 'active') raise('VALIDATION', 'นักเรียนถอน/ย้ายออกจากรายวิชาแล้ว');
      expectVersion(cur, e.expectedVersion, { studentId: e.studentId });
      if (cur && cur.status === 'scored' && !perms.can_edit_scores && (e.status !== 'scored' || e.score !== cur.rawScore)) raise('FORBIDDEN', 'แก้คะแนนที่บันทึกแล้วต้องมีสิทธิ์ "แก้คะแนน"');
      const w = writeGrade(t, ctx, offering.id, a, e.studentId, cur, { status: e.status, score: e.score, source: 'teacher', isOverride: false, excuseReason: e.status === 'excused' ? e.reason : '', reason: e.reason });
      if (w.changed) res.saved++; else res.unchanged++;
      res.grades.push({ studentId: e.studentId, version: w.doc.version, status: w.doc.status, score: w.doc.rawScore });
    });
    return res;
  });
  await audit(ctx, 'grade.save', 'assessments', d.assessmentId, { saved: out.saved }, '', d.offeringId);
  return out;
}

// ---------------------------------------------------------------- คะแนนกลุ่ม
/**
 * req: { offeringId, assessmentId, groupId, status, score, note, expectedVersion, preview, clearOverrides: [sid] | true }
 * preview:true คืนตัวอย่างก่อน/หลังโดยไม่บันทึก
 */
export async function saveGroup(ctx, d) {
  const out = await db.runTransaction(async (t) => {
    const { offering, perms } = await requireOffering(ctx, d.offeringId, 'can_grade', t);
    openForChanges(offering);
    const a = await loadAssessment(t, offering.id, d.assessmentId);
    if (a.kind !== 'group') raise('NOT_FOUND');
    const status = d.status || 'scored';
    const score = checkValue(a, status, d.score);
    const note = str(d.note, 2000, 'หมายเหตุ');
    const b = 'offerings/' + offering.id;
    const g = await getDoc(t, db.doc(b + '/groups/' + String(d.groupId || '')));
    if (!g || g.assessmentId !== a.id || (g.status === 'disbanded' && !g.frozen)) raise('NOT_FOUND');
    const members = g.memberIds || [];
    if (!members.length) raise('VALIDATION', 'กลุ่มนี้ยังไม่มีสมาชิก');
    const ggRef = db.doc(b + '/groupGrades/' + a.id + '_' + g.id);
    const gg = await getDoc(t, ggRef);
    const enrs = await getMany(t, members.map((sid) => db.doc(b + '/enrollments/' + sid)));
    const grades = await getMany(t, members.map((sid) => db.doc(b + '/grades/' + gradeId(a.id, sid))));
    const roster = await getMany(t, members.map((sid) => db.doc(b + '/roster/' + sid)));
    const sub = await getDoc(t, db.doc(b + '/submissions/' + a.id + '_' + g.id));
    const clearAll = d.clearOverrides === true;
    const clearIds = Array.isArray(d.clearOverrides) ? d.clearOverrides.map(String) : [];
    const plan = members.map((sid) => {
      const cur = grades.get(gradeId(a.id, sid)) || null;
      const before = cur ? { status: cur.status, score: cur.status === 'scored' ? cur.rawScore : '', isOverride: !!cur.isOverride, reason: cur.overrideReason || '' } : { status: 'not_assessed', score: '' };
      const action = !enrs.get(sid) ? 'skip_not_enrolled' : (cur && cur.isOverride && !(clearAll || clearIds.includes(sid))) ? 'keep_override' : 'apply';
      const r = roster.get(sid);
      return { studentId: sid, name: r ? r.name : sid, action, before, after: action === 'apply' ? { status, score } : before, cur };
    });
    const pub = plan.map((p) => ({ studentId: p.studentId, name: p.name, action: p.action, before: p.before, after: p.after }));
    if (d.preview) {
      return {
        preview: true, groupName: g.name, willFreeze: !g.frozen, before: gg ? { status: gg.status, score: gg.rawScore } : null,
        after: { status, score }, members: pub, overrides: plan.filter((p) => p.cur && p.cur.isOverride).length
      };
    }
    expectVersion(gg, d.expectedVersion, { groupId: g.id });
    if (gg && gg.status === 'scored' && !perms.can_edit_scores && (status !== 'scored' || score !== gg.rawScore)) raise('FORBIDDEN', 'แก้คะแนนที่บันทึกแล้วต้องมีสิทธิ์ "แก้คะแนน"');
    const now = nowIso();
    let snapshotNo = g.snapshotNo || 0;
    if (!g.frozen) {
      snapshotNo += 1;
      const snapshots = Object.assign({}, g.snapshots || {}, { [String(snapshotNo)]: members });
      t.update(db.doc(b + '/groups/' + g.id), { frozen: true, frozenAt: now, frozenReason: 'teacher', snapshotNo, snapshots, updatedAt: now });
    }
    const ggDoc = {
      assessmentId: a.id, groupId: g.id, groupName: g.name, workGroupId: g.workGroupId || '', status, rawScore: score, note, snapshotNo,
      submissionVersionNo: sub ? (sub.acceptedVersionNo || sub.currentVersionNo || 0) : 0, version: (gg ? gg.version || 0 : 0) + 1,
      updatedAt: now, updatedBy: ctx.uid, updatedByName: ctx.name
    };
    t.set(ggRef, ggDoc);
    const res = { applied: 0, kept: 0, skipped: 0, unchanged: 0 };
    plan.forEach((p) => {
      if (p.action === 'skip_not_enrolled') { res.skipped++; return; }
      if (p.action === 'keep_override') { res.kept++; return; }
      const w = writeGrade(t, ctx, offering.id, a, p.studentId, p.cur, {
        status, score, source: 'group', sourceRef: ggRef.id, groupGradeId: ggRef.id, isOverride: false,
        excuseReason: status === 'excused' ? (note || 'ยกเว้นทั้งกลุ่ม') : '',
        reason: p.cur && p.cur.isOverride ? 'ยกเลิกการปรับรายคน ใช้คะแนนกลุ่ม' : (note || 'คะแนนกลุ่ม')
      });
      if (w.changed) res.applied++; else res.unchanged++;
    });
    return Object.assign(res, { groupGradeId: ggRef.id, version: ggDoc.version, members: pub });
  });
  if (!out.preview) await audit(ctx, 'grade.group', 'groupGrades', out.groupGradeId, { applied: out.applied, kept: out.kept, score: d.score, status: d.status }, str(d.note, 500), d.offeringId);
  return out;
}

/** ปรับคะแนนรายคนจากคะแนนกลุ่ม (ต้องมีเหตุผล) หรือยกเลิกการปรับ (clear) เพื่อกลับไปใช้คะแนนกลุ่ม */
export async function override(ctx, d) {
  const reason = requireStr(d.reason, 'เหตุผลหรือหลักฐานการมีส่วนร่วม', 1000);
  const out = await db.runTransaction(async (t) => {
    const { offering, perms } = await requireOffering(ctx, d.offeringId, 'can_grade', t);
    openForChanges(offering);
    const a = await loadAssessment(t, offering.id, d.assessmentId);
    if (a.kind !== 'group') raise('NOT_FOUND');
    const b = 'offerings/' + offering.id;
    const sid = String(d.studentId || '');
    const enr = await getDoc(t, db.doc(b + '/enrollments/' + sid));
    if (!enr) raise('NOT_FOUND', 'นักเรียนไม่ได้ลงทะเบียนในรายวิชานี้');
    const cur = await getDoc(t, db.doc(b + '/grades/' + gradeId(a.id, sid)));
    expectVersion(cur, d.expectedVersion, { studentId: sid });
    if (cur && cur.status === 'scored' && !perms.can_edit_scores) raise('FORBIDDEN', 'แก้คะแนนที่บันทึกแล้วต้องมีสิทธิ์ "แก้คะแนน"');
    const groups = await queryDocs(t, db.collection(b + '/groups').where('assessmentId', '==', a.id).where('memberIds', 'array-contains', sid));
    const g = groups.find((x) => x.status !== 'disbanded') || null;
    const gg = g ? await getDoc(t, db.doc(b + '/groupGrades/' + a.id + '_' + g.id)) : null;
    let w;
    if (d.clear) {
      if (!gg) raise('VALIDATION', 'กลุ่มของนักเรียนยังไม่มีคะแนนกลุ่ม');
      w = writeGrade(t, ctx, offering.id, a, sid, cur, { status: gg.status, score: gg.status === 'scored' ? gg.rawScore : '', source: 'group', sourceRef: gg.id, groupGradeId: gg.id, isOverride: false, reason: 'ยกเลิกการปรับรายคน: ' + reason });
    } else {
      const status = d.status || 'scored';
      const score = checkValue(a, status, d.score);
      w = writeGrade(t, ctx, offering.id, a, sid, cur, {
        status, score, source: 'teacher', sourceRef: gg ? gg.id : '', groupGradeId: gg ? gg.id : '', isOverride: true, overrideReason: reason,
        excuseReason: status === 'excused' ? reason : '', reason
      });
    }
    return { changed: w.changed, version: w.doc.version, status: w.doc.status, score: w.doc.rawScore };
  });
  await audit(ctx, d.clear ? 'grade.override.clear' : 'grade.override', 'grades', gradeId(d.assessmentId, d.studentId), { status: out.status, score: out.score }, reason, d.offeringId);
  return out;
}

// ---------------------------------------------------------------- ประกาศคะแนน
function totalForPublished(policy, assessments, items) {
  const map = {};
  assessments.forEach((a) => {
    const p = items && items[a.id];
    map[a.id] = p ? { status: p.status, score: p.score } : { status: 'not_assessed' };
  });
  const tot = computeTotal(policy, itemsOf(assessments), map);
  return { status: tot.status, label: tot.label, final: tot.final, provisional: tot.provisional, assessedWeightPct: tot.assessedWeightPct, grade: tot.grade, pending: tot.blockers.length };
}

export async function publish(ctx, d) {
  const unpublish = d.action === 'unpublish';
  const reason = str(d.reason, 1000, 'เหตุผล');
  if (unpublish && !reason) raise('VALIDATION', 'การเรียกคืนการประกาศต้องระบุเหตุผล');
  const res = await db.runTransaction(async (t) => {
    const { offering } = await requireOffering(ctx, d.offeringId, 'can_publish', t);
    const b = 'offerings/' + offering.id;
    const a = await loadAssessment(t, offering.id, d.assessmentId);
    const grades = await queryDocs(t, db.collection(b + '/grades').where('assessmentId', '==', a.id));
    const assessments = sortAssessments(await queryDocs(t, db.collection(b + '/assessments')));
    const studentIds = [...new Set(grades.map((g) => g.studentId))];
    const pubs = await getMany(t, studentIds.map((sid) => db.doc(b + '/published/' + sid)));
    const now = nowIso();
    const changedStudents = [];
    grades.forEach((g) => {
      const ref = db.doc(b + '/grades/' + g.id);
      if (unpublish) {
        if (!g.publishedAt) return;
        t.update(ref, { publication: 'draft', publishedAt: '', publishedScore: '', publishedStatus: '' });
      } else if (g.status === 'not_assessed') {
        if (!g.publishedAt) return;
        t.update(ref, { publication: 'published', publishedAt: '', publishedScore: '', publishedStatus: '' });
      } else {
        const val = g.status === 'scored' ? g.rawScore : '';
        if (g.publication === 'published' && g.publishedStatus === g.status && String(g.publishedScore || '') === String(val) && g.publishedAt) return;
        t.update(ref, { publication: 'published', publishedAt: now, publishedStatus: g.status, publishedScore: val });
      }
      changedStudents.push(g);
    });
    const policy = policyOf(offering);
    const touched = new Set(changedStudents.map((g) => g.studentId));
    touched.forEach((sid) => {
      const p = pubs.get(sid) || { items: {} };
      const items = Object.assign({}, p.items || {});
      const g = changedStudents.find((x) => x.studentId === sid);
      if (unpublish || g.status === 'not_assessed') delete items[a.id];
      else items[a.id] = { status: g.status, score: g.status === 'scored' ? g.rawScore : '', publishedAt: now };
      t.set(db.doc(b + '/published/' + sid), { studentId: sid, items, total: totalForPublished(policy, assessments, items), updatedAt: now });
    });
    return { changed: changedStudents.length, studentIds: [...touched] };
  });
  await db.collection('offerings/' + d.offeringId + '/publications').add({ assessmentId: d.assessmentId, action: unpublish ? 'unpublish' : 'publish', count: res.changed, reason, by: ctx.uid, byName: ctx.name, at: nowIso() });
  await audit(ctx, unpublish ? 'grade.unpublish' : 'grade.publish', 'assessments', d.assessmentId, { count: res.changed }, reason, d.offeringId);
  if (!unpublish && res.studentIds.length) {
    const snaps = await db.getAll(...res.studentIds.map((sid) => db.doc('students/' + sid)));
    const a = await getDoc(null, db.doc('offerings/' + d.offeringId + '/assessments/' + d.assessmentId));
    await notify(snaps.filter((s) => s.exists).map((s) => s.get('uid')), 'grade', 'ประกาศคะแนนแล้ว: ' + (a ? a.title : ''), 'เปิดรายวิชาเพื่อดูคะแนนของคุณ', 'offering:' + d.offeringId);
  }
  return { changed: res.changed };
}

/** คำนวณคะแนนรวมที่นักเรียนเห็นใหม่ (เมื่อรายการประเมิน/น้ำหนักเปลี่ยน) */
export async function recomputePublished(offeringId) {
  const b = 'offerings/' + offeringId;
  const offering = await getDoc(null, db.doc(b));
  if (!offering) return 0;
  const assessments = sortAssessments(await queryDocs(null, db.collection(b + '/assessments')));
  const pubs = await queryDocs(null, db.collection(b + '/published'));
  const policy = policyOf(offering);
  const ops = [];
  pubs.forEach((p) => {
    const total = totalForPublished(policy, assessments, p.items || {});
    if (JSON.stringify(total) !== JSON.stringify(p.total || null)) ops.push((bt) => bt.update(db.doc(b + '/published/' + p.id), { total, updatedAt: nowIso() }));
  });
  await writeInChunks(ops);
  return ops.length;
}
