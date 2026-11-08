/**
 * ปีการศึกษา/ภาคเรียน รายวิชาในหลักสูตร รายวิชาที่เปิดสอน ครูร่วมสอน การลงทะเบียนเรียน และรหัสเข้าร่วมรายวิชา
 * (ตรรกะเดียวกับ gas/Courses.js)
 *
 * เอกสารของรายวิชาที่เปิดสอน offerings/{id}
 *   staff/{uid}         ครูผู้สอนและสิทธิ์ (กฎความปลอดภัยใช้ตรวจการอ่าน)
 *   enrollments/{sid}   การลงทะเบียน + ประวัติ (นักเรียนเห็นของตนเอง)
 *   roster/{sid}        ชื่อและห้องที่เพื่อนร่วมรายวิชาเห็น (ไม่มีรหัส/ข้อมูลอื่น)
 */
import { FieldValue } from 'firebase-admin/firestore';
import { db, nowIso, newId, str, requireStr, optInt, decimal, getDoc, getMany, queryDocs, writeInChunks, audit, notify, requireAdmin, requireStaff, requireStudent, shortCode, uniqueIds } from './core.js';
import { raise } from './errors.js';
import { requireOffering, computePerms } from './perms.js';
import { OFFERING_PERMISSIONS, personName, roomLabel } from '../shared/config.js';
import Grading from '../shared/grading.js';
import { removeFromWorkGroups } from './workgroups.js';

// คีย์ไม่ซ้ำ (เข้ารหัสเพราะกลุ่มเรียนอย่าง "ม.5/1" มีเครื่องหมาย / ซึ่งใช้ใน path ของเอกสารไม่ได้)
const uniqRef = (schoolId, key) => db.doc('uniq/' + encodeURIComponent(schoolId + '~' + key));

// ---------------------------------------------------------------- ภาคเรียน
export async function saveTerm(ctx, d) {
  requireAdmin(ctx);
  const yearBe = Number(d.yearBe), termNo = Number(d.termNo);
  if (!Number.isInteger(yearBe) || yearBe < 2500 || yearBe > 2700) raise('VALIDATION', 'ปีการศึกษาต้องเป็นปี พ.ศ. เช่น 2569');
  if ([1, 2, 3].indexOf(termNo) < 0) raise('VALIDATION', 'ภาคเรียนต้องเป็น 1, 2 หรือ 3 (ฤดูร้อน)');
  const status = ['planning', 'active', 'closed'].indexOf(d.status) >= 0 ? d.status : 'active';
  const id = d.id || newId();
  await db.runTransaction(async (t) => {
    const cur = d.id ? await getDoc(t, db.doc('terms/' + id)) : null;
    if (d.id && (!cur || cur.schoolId !== ctx.schoolId)) raise('NOT_FOUND');
    const key = 'term~' + yearBe + '-' + termNo;
    const uq = await getDoc(t, uniqRef(ctx.schoolId, key));
    if (uq && uq.refId !== id) raise('DUPLICATE', 'มีปี ' + yearBe + ' ภาค ' + termNo + ' แล้ว');
    if (cur && (cur.yearBe !== yearBe || cur.termNo !== termNo)) t.delete(uniqRef(ctx.schoolId, 'term~' + cur.yearBe + '-' + cur.termNo));
    t.set(uniqRef(ctx.schoolId, key), { refId: id });
    t.set(db.doc('terms/' + id), {
      schoolId: ctx.schoolId, yearBe, termNo, name: str(d.name, 50) || (termNo === 3 ? 'ภาคฤดูร้อน' : 'ภาคเรียนที่ ' + termNo),
      label: 'ปี ' + yearBe + ' ภาค ' + termNo, status, updatedAt: nowIso()
    }, { merge: true });
  });
  await audit(ctx, 'term.save', 'terms', id, { yearBe, termNo });
  return { id };
}

/** เพิ่มปีการศึกษา = สร้างภาคเรียนที่ 1 และ 2 */
export async function saveYear(ctx, d) {
  requireAdmin(ctx);
  const ids = [];
  for (const termNo of [1, 2]) {
    try { ids.push((await saveTerm(ctx, { yearBe: d.yearBe, termNo })).id); } catch (e) { if (e.code !== 'DUPLICATE') throw e; }
  }
  if (!ids.length) raise('DUPLICATE', 'มีปีการศึกษานี้แล้ว');
  return { termIds: ids };
}

// ---------------------------------------------------------------- รายวิชาในหลักสูตร
export async function saveCourse(ctx, d) {
  requireStaff(ctx);
  const code = requireStr(d.code, 'รหัสวิชา', 30);
  const credits = decimal(d.credits, 'หน่วยกิต');
  const data = {
    code, nameTh: requireStr(d.nameTh, 'ชื่อวิชา', 200), nameEn: str(d.nameEn, 200), learningArea: str(d.learningArea, 100),
    gradeLevel: str(d.gradeLevel, 20), description: str(d.description, 5000), credits, hours: optInt(d.hours, 'ชั่วโมงเรียน', 0, 2000),
    status: d.status === 'inactive' ? 'inactive' : 'active'
  };
  const id = d.id || newId();
  await db.runTransaction(async (t) => {
    const cur = d.id ? await getDoc(t, db.doc('courses/' + id)) : null;
    if (d.id && (!cur || cur.schoolId !== ctx.schoolId)) raise('NOT_FOUND');
    if (cur && !ctx.roles.admin && cur.createdBy !== ctx.uid) raise('FORBIDDEN', 'แก้ได้เฉพาะรายวิชาที่คุณสร้าง หรือให้ผู้ดูแลแก้');
    if (cur && d.version !== undefined && d.version !== null && Number(d.version) !== Number(cur.version)) raise('CONFLICT');
    const key = 'course~' + code.toLowerCase();
    const uq = await getDoc(t, uniqRef(ctx.schoolId, key));
    if (uq && uq.refId !== id) raise('DUPLICATE', 'รหัสวิชา ' + code + ' มีแล้ว');
    if (cur && cur.code.toLowerCase() !== code.toLowerCase()) t.delete(uniqRef(ctx.schoolId, 'course~' + cur.code.toLowerCase()));
    t.set(uniqRef(ctx.schoolId, key), { refId: id });
    const doc = Object.assign({}, data, { schoolId: ctx.schoolId, updatedAt: nowIso(), version: (cur ? cur.version || 0 : 0) + 1 });
    if (!cur) { doc.createdBy = ctx.uid; doc.createdAt = nowIso(); }
    t.set(db.doc('courses/' + id), doc, { merge: true });
  });
  await audit(ctx, d.id ? 'course.update' : 'course.create', 'courses', id, { code });
  return { id, code, nameTh: data.nameTh };
}

// ---------------------------------------------------------------- รายวิชาที่เปิดสอน
function ownerStaff(teacher) {
  const perms = {};
  OFFERING_PERMISSIONS.forEach((k) => { perms[k] = true; });
  return { uid: teacher.uid, teacherId: teacher.id, name: teacher.name, role: 'owner', perms, active: true, at: nowIso() };
}

export async function saveOffering(ctx, d) {
  requireStaff(ctx);
  const section = requireStr(d.sectionCode, 'กลุ่มเรียน', 30);
  const calc = d.calcMethod === 'per_category' ? 'per_category' : 'per_item';
  const status = ['draft', 'open', 'archived'].indexOf(d.status) >= 0 ? d.status : 'open';
  const displayName = str(d.displayName, 200);
  const id = d.id || newId();
  await db.runTransaction(async (t) => {
    if (d.id) {
      // อ่านทั้งหมดก่อน (ข้อกำหนดของ transaction) แล้วจึงเขียน
      const { offering: cur, perms } = await requireOffering(ctx, id, 'can_view', t);
      if (!ctx.roles.admin && !perms.owner) raise('FORBIDDEN');
      if (cur.status === 'closed') raise('OFFERING_CLOSED');
      if (d.version !== undefined && d.version !== null && Number(d.version) !== Number(cur.version)) raise('CONFLICT');
      let newOwner = null, oldOwners = [];
      if (d.ownerTeacherId && d.ownerTeacherId !== cur.ownerTeacherId) {
        if (!ctx.roles.admin) raise('FORBIDDEN', 'เปลี่ยนครูเจ้าของรายวิชาได้เฉพาะผู้ดูแล');
        newOwner = await getDoc(t, db.doc('teachers/' + d.ownerTeacherId));
        if (!newOwner || newOwner.schoolId !== ctx.schoolId) raise('NOT_FOUND', 'ไม่พบครู');
        if (!newOwner.uid) raise('VALIDATION', 'ครูคนนี้ยังไม่มีบัญชีเข้าระบบ');
        oldOwners = await queryDocs(t, db.collection('offerings/' + id + '/staff').where('role', '==', 'owner'));
      }
      if (calc !== cur.calcMethod) {
        const scored = await t.get(db.collection('offerings/' + id + '/grades').where('status', '==', 'scored').limit(1));
        if (!scored.empty) raise('VALIDATION', 'มีคะแนนแล้ว เปลี่ยนวิธีคำนวณไม่ได้ (ต้องสร้างรุ่นนโยบายคะแนนใหม่พร้อมเหตุผล)');
      }
      const newKey = 'offering~' + cur.termId + '-' + cur.courseId + '-' + section.toLowerCase();
      if (cur.section.toLowerCase() !== section.toLowerCase()) {
        const uq = await getDoc(t, uniqRef(ctx.schoolId, newKey));
        if (uq && uq.refId !== id) raise('DUPLICATE', 'มีกลุ่มเรียนนี้ในภาคเรียนนี้แล้ว');
      }
      const patch = { section, displayName: displayName || cur.displayName, status, calcMethod: calc, updatedAt: nowIso(), version: (cur.version || 0) + 1 };
      if (cur.section.toLowerCase() !== section.toLowerCase()) {
        t.delete(uniqRef(ctx.schoolId, 'offering~' + cur.termId + '-' + cur.courseId + '-' + cur.section.toLowerCase()));
        t.set(uniqRef(ctx.schoolId, newKey), { refId: id });
      }
      if (newOwner) {
        const oldIds = oldOwners.map((s) => s.id).filter((u) => u !== newOwner.uid);
        oldIds.forEach((u) => t.update(db.doc('offerings/' + id + '/staff/' + u), { active: false, role: 'former_owner' }));
        t.set(db.doc('offerings/' + id + '/staff/' + newOwner.uid), ownerStaff(newOwner));
        patch.ownerTeacherId = newOwner.id; patch.ownerName = newOwner.name;
        patch.staffUids = (cur.staffUids || []).filter((u) => oldIds.indexOf(u) < 0 && u !== newOwner.uid).concat([newOwner.uid]);
      }
      t.update(db.doc('offerings/' + id), patch);
      return;
    }
    const course = await getDoc(t, db.doc('courses/' + String(d.courseId || '')));
    if (!course || course.schoolId !== ctx.schoolId) raise('NOT_FOUND', 'ไม่พบรายวิชาในหลักสูตร');
    const term = await getDoc(t, db.doc('terms/' + String(d.termId || '')));
    if (!term || term.schoolId !== ctx.schoolId) raise('NOT_FOUND', 'ไม่พบภาคเรียน');
    if (term.status === 'closed') raise('VALIDATION', 'ภาคเรียนนี้ปิดแล้ว');
    let ownerId;
    if (ctx.roles.admin && d.ownerTeacherId) ownerId = d.ownerTeacherId;
    else if (ctx.teacherId) ownerId = ctx.teacherId;
    else raise('VALIDATION', 'กรุณาเลือกครูเจ้าของรายวิชา');
    const owner = await getDoc(t, db.doc('teachers/' + ownerId));
    if (!owner || owner.schoolId !== ctx.schoolId) raise('NOT_FOUND', 'ไม่พบครู');
    if (!owner.uid) raise('VALIDATION', 'ครูคนนี้ยังไม่มีบัญชีเข้าระบบ');
    const key = 'offering~' + term.id + '-' + course.id + '-' + section.toLowerCase();
    if (await getDoc(t, uniqRef(ctx.schoolId, key))) raise('DUPLICATE', 'มีกลุ่มเรียนนี้ในภาคเรียนนี้แล้ว');
    t.set(uniqRef(ctx.schoolId, key), { refId: id });
    t.set(db.doc('offerings/' + id), {
      schoolId: ctx.schoolId, courseId: course.id, courseCode: course.code, courseName: course.nameTh, termId: term.id, yearBe: term.yearBe, termNo: term.termNo,
      section, displayName: displayName || course.nameTh + ' ' + section, ownerTeacherId: owner.id, ownerName: owner.name, status, calcMethod: calc,
      policy: { versionNo: 1, digits: 2, bands: Grading.DEFAULT_BANDS, activatedAt: nowIso() }, categories: [],
      joinEnabled: false, joinCode: '', groupSettings: { maxSize: 0, leaderDirectAdd: false, locked: false },
      staffUids: [owner.uid], activeCount: 0, createdAt: nowIso(), createdBy: ctx.uid, updatedAt: nowIso(), version: 1
    });
    t.set(db.doc('offerings/' + id + '/staff/' + owner.uid), ownerStaff(owner));
  });
  await audit(ctx, d.id ? 'offering.update' : 'offering.create', 'offerings', id, { section }, '', id);
  return { offeringId: id };
}

/** เพิ่ม/แก้/เพิกถอนครูร่วมสอนพร้อมสิทธิ์แยกรายการ (ผู้ดูแลหรือครูเจ้าของ) */
export async function setCoTeacher(ctx, d) {
  await db.runTransaction(async (t) => {
    const { offering, perms } = await requireOffering(ctx, d.offeringId, 'can_view', t);
    if (!ctx.roles.admin && !perms.owner) raise('FORBIDDEN');
    const teacher = await getDoc(t, db.doc('teachers/' + String(d.teacherId || '')));
    if (!teacher || teacher.schoolId !== ctx.schoolId) raise('NOT_FOUND');
    if (!teacher.uid) raise('VALIDATION', 'ครูคนนี้ยังไม่มีบัญชีเข้าระบบ');
    if (teacher.id === offering.ownerTeacherId) raise('VALIDATION', 'ครูคนนี้เป็นครูเจ้าของรายวิชาอยู่แล้ว');
    const ref = db.doc('offerings/' + offering.id + '/staff/' + teacher.uid);
    if (d.revoke) {
      t.set(ref, { active: false, revokedAt: nowIso(), revokedBy: ctx.uid }, { merge: true });
      t.update(db.doc('offerings/' + offering.id), { staffUids: FieldValue.arrayRemove(teacher.uid) });
      return;
    }
    const p = { can_view: true };
    OFFERING_PERMISSIONS.forEach((k) => { if (k !== 'can_view') p[k] = !!(d.perms && d.perms[k]); });
    t.set(ref, { uid: teacher.uid, teacherId: teacher.id, name: teacher.name, role: 'co_teacher', perms: p, active: true, at: nowIso() });
    t.update(db.doc('offerings/' + offering.id), { staffUids: FieldValue.arrayUnion(teacher.uid) });
  });
  await audit(ctx, d.revoke ? 'offering.coTeacher.revoke' : 'offering.coTeacher', 'teachers', d.teacherId, d.perms || {}, '', d.offeringId);
  return { ok: true };
}

// ---------------------------------------------------------------- ลงทะเบียนเรียน
function historyEntry(ctx, action, from, to, reason) {
  return { action, from: from || '', to, at: nowIso(), by: ctx.uid, reason: reason || '' };
}

/** ลงทะเบียนนักเรียนที่เลือก (ไม่สร้างคะแนนย้อนหลัง) */
export async function enroll(ctx, d) {
  const ids = uniqueIds(d.studentIds, 300);
  if (!ids.length) raise('VALIDATION', 'กรุณาเลือกนักเรียน');
  const out = await db.runTransaction(async (t) => {
    const { offering } = await requireOffering(ctx, d.offeringId, 'can_manage', t);
    if (['closed', 'archived'].indexOf(offering.status) >= 0) raise('OFFERING_CLOSED', 'รายวิชาปิดแล้ว เพิ่มนักเรียนไม่ได้');
    const students = await getMany(t, ids.map((id) => db.doc('students/' + id)));
    const enrs = await getMany(t, ids.map((id) => db.doc('offerings/' + offering.id + '/enrollments/' + id)));
    const res = { added: 0, reactivated: 0, skipped: 0 };
    ids.forEach((sid) => {
      const s = students.get(sid);
      if (!s || s.schoolId !== ctx.schoolId) raise('NOT_FOUND', 'ไม่พบนักเรียน');
      if (s.status !== 'active') raise('VALIDATION', 'นักเรียน ' + s.code + ' ไม่อยู่ในสถานะกำลังศึกษา');
      const e = enrs.get(sid);
      const ref = db.doc('offerings/' + offering.id + '/enrollments/' + sid);
      if (e && e.status === 'active') { res.skipped++; return; }
      if (e) {
        t.update(ref, { status: 'active', effectiveFrom: nowIso(), effectiveTo: '', uid: s.uid || '', history: FieldValue.arrayUnion(historyEntry(ctx, 'reactivate', e.status, 'active', d.reason)) });
        res.reactivated++;
      } else {
        t.set(ref, { studentId: sid, uid: s.uid || '', schoolId: ctx.schoolId, status: 'active', effectiveFrom: nowIso(), effectiveTo: '', source: 'manual', history: [historyEntry(ctx, 'enroll', '', 'active', d.reason)] });
        res.added++;
      }
      t.set(db.doc('offerings/' + offering.id + '/roster/' + sid), { name: s.name, roomLabel: s.roomLabel, active: true, workGroupId: '' }, { merge: true });
    });
    if (res.added + res.reactivated) t.update(db.doc('offerings/' + offering.id), { activeCount: FieldValue.increment(res.added + res.reactivated) });
    return res;
  });
  await audit(ctx, 'enrollment.add', 'offerings', d.offeringId, out, '', d.offeringId);
  return out;
}

export async function withdraw(ctx, d) {
  const reason = requireStr(d.reason, 'เหตุผล', 500);
  const status = d.status === 'transferred_out' ? 'transferred_out' : 'withdrawn';
  const res = await db.runTransaction(async (t) => {
    const { offering } = await requireOffering(ctx, d.offeringId, 'can_manage', t);
    const ref = db.doc('offerings/' + offering.id + '/enrollments/' + String(d.studentId || ''));
    const e = await getDoc(t, ref);
    if (!e) raise('NOT_FOUND');
    if (e.status !== 'active') return { unchanged: true };
    const wg = await removeFromWorkGroups.read(t, offering, d.studentId);
    t.update(ref, { status, effectiveTo: nowIso(), reason, history: FieldValue.arrayUnion(historyEntry(ctx, status === 'withdrawn' ? 'withdraw' : 'transfer_out', 'active', status, reason)) });
    t.set(db.doc('offerings/' + offering.id + '/roster/' + d.studentId), { active: false, workGroupId: '' }, { merge: true });
    t.update(db.doc('offerings/' + offering.id), { activeCount: FieldValue.increment(-1) });
    removeFromWorkGroups.write(t, ctx, offering, d.studentId, wg, 'ถอนรายวิชา');
    return { ok: true };
  });
  await audit(ctx, 'enrollment.' + status, 'enrollments', d.studentId, {}, reason, d.offeringId);
  return res;
}

/** เปิด/ปิดรหัสเข้าร่วมรายวิชา (สร้างรหัสใหม่ได้) */
export async function setJoin(ctx, d) {
  const out = await db.runTransaction(async (t) => {
    const { offering } = await requireOffering(ctx, d.offeringId, 'can_manage', t);
    let code = offering.joinCode;
    let fresh = null;
    if (d.enabled && (!code || d.regenerate)) {
      for (let i = 0; i < 10 && !fresh; i++) {
        const c = shortCode(6);
        if (!(await getDoc(t, db.doc('joinCodes/' + c)))) fresh = c;
      }
      if (!fresh) raise('BUSY');
    }
    if (fresh) {
      if (code) t.delete(db.doc('joinCodes/' + code));
      t.set(db.doc('joinCodes/' + fresh), { offeringId: offering.id, schoolId: ctx.schoolId });
      code = fresh;
    }
    t.update(db.doc('offerings/' + offering.id), { joinEnabled: !!d.enabled, joinCode: code || '' });
    return { joinEnabled: !!d.enabled, joinCode: code || '' };
  });
  await audit(ctx, 'offering.join', 'offerings', d.offeringId, { enabled: out.joinEnabled }, '', d.offeringId);
  return out;
}

/** นักเรียนลงทะเบียนเรียนเองด้วยรหัสเข้าร่วม */
export async function joinByCode(ctx, d) {
  requireStudent(ctx);
  const code = str(d.code, 20).toUpperCase().replace(/\s+/g, '');
  if (!code) raise('JOIN_CODE_INVALID');
  const out = await db.runTransaction(async (t) => {
    const jc = await getDoc(t, db.doc('joinCodes/' + code));
    if (!jc || jc.schoolId !== ctx.schoolId) raise('JOIN_CODE_INVALID');
    const o = await getDoc(t, db.doc('offerings/' + jc.offeringId));
    if (!o || !o.joinEnabled || o.status !== 'open' || o.joinCode !== code) raise('JOIN_CODE_INVALID');
    const s = await getDoc(t, db.doc('students/' + ctx.studentId));
    if (!s || s.status !== 'active') raise('FORBIDDEN');
    const ref = db.doc('offerings/' + o.id + '/enrollments/' + s.id);
    const e = await getDoc(t, ref);
    const res = { offeringId: o.id, courseName: o.courseCode + ' ' + o.courseName, section: o.section };
    if (e && e.status === 'active') return Object.assign(res, { already: true });
    if (e) raise('FORBIDDEN', 'ครูถอนคุณออกจากรายวิชานี้แล้ว กรุณาติดต่อครูผู้สอน');
    t.set(ref, { studentId: s.id, uid: ctx.uid, schoolId: ctx.schoolId, status: 'active', effectiveFrom: nowIso(), effectiveTo: '', source: 'self', history: [historyEntry(ctx, 'enroll', '', 'active', 'ลงทะเบียนเองด้วยรหัสเข้าร่วม')] });
    t.set(db.doc('offerings/' + o.id + '/roster/' + s.id), { name: s.name, roomLabel: s.roomLabel, active: true, workGroupId: '' }, { merge: true });
    t.update(db.doc('offerings/' + o.id), { activeCount: FieldValue.increment(1) });
    return Object.assign(res, { already: false });
  });
  if (!out.already) await audit(ctx, 'enrollment.self', 'offerings', out.offeringId, {}, '', out.offeringId);
  return out;
}

/** เมื่อนักเรียนได้บัญชีภายหลัง: ผูก uid กับการลงทะเบียนเดิม (ให้นักเรียนเห็นรายวิชาของตน) */
export async function linkEnrollmentsUid(studentId, uid) {
  const snap = await db.collectionGroup('enrollments').where('studentId', '==', studentId).get();
  await writeInChunks(snap.docs.map((d) => (b) => b.update(d.ref, { uid })));
}
