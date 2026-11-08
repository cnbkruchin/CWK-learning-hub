/**
 * การส่งงาน (ตรรกะเดียวกับ gas/Submission.js) บน Cloud Storage for Firebase
 *
 * 1) แอปอัปโหลดไฟล์ไปที่ uploads/{uid}/... (Storage Rules จำกัดขนาด/เจ้าของ) แบบ resumable พร้อมแถบความคืบหน้า
 * 2) attachUpload: เซิร์ฟเวอร์ตรวจชนิดจริง (magic bytes/โครงสร้าง ZIP/มาโคร) ขนาด จำนวน แล้วย้ายไป files/{offeringId}/...
 *    ไฟล์ที่ไม่ผ่านถูกลบทิ้ง (ไม่ถูกนำไปใช้) — ไฟล์อัปโหลดเสร็จยังไม่ถือว่าส่งงาน
 * 3) submit: สร้างรุ่นการส่ง + ใบยืนยัน (รหัส เวลาเซิร์ฟเวอร์ รายการไฟล์) ส่งซ้ำ = รุ่นใหม่ รุ่นเดิมเก็บไว้
 *    idempotencyKey ป้องกันกดซ้ำ, baseVersionNo ป้องกันสมาชิกกลุ่มส่งทับกัน, ส่งครั้งแรกตรึงรายชื่อกลุ่ม
 */
import crypto from 'node:crypto';
import { db, bucket, nowIso, newId, str, getDoc, getMany, queryDocs, audit, notify, shortCode, requireStudent } from './core.js';
import { raise } from './errors.js';
import { requireOffering, requireEnrollment } from './perms.js';
import { getSchool } from './accounts.js';
import { settingsOf } from './registry.js';
import FileCheck from '../shared/filecheck.js';

export function limitsOf(settings, a) {
  const school = settings.allowedFileTypes || [];
  const wanted = a.allowedTypes && a.allowedTypes.length ? a.allowedTypes : school;
  const types = wanted.filter((x) => school.indexOf(x) >= 0 && FileCheck.TYPES[x]);
  if (types.indexOf('jpg') >= 0 && types.indexOf('jpeg') < 0) types.push('jpeg');
  const maxMb = Math.min(Number(settings.maxFileMb), Number(a.maxFileMb || settings.maxFileMb));
  const maxFiles = Math.min(Number(settings.maxFilesPerSubmission), Number(a.maxFiles || settings.maxFilesPerSubmission));
  return { allowedTypes: types, maxFileMb: maxMb, maxFileBytes: maxMb * 1024 * 1024, maxFiles, allowLinks: !!a.allowLinks && a.submissionMode === 'file_or_link' };
}

export function windowOf(a, ext) {
  const due = (ext && ext.dueAt) || a.dueAt || '';
  const close = (ext && ext.closeAt) || a.closeAt || '';
  const hard = a.allowLate ? (close || '') : (due || close || '');
  return { openAt: a.openAt || '', dueAt: due, closeAt: close, hardCloseAt: hard, allowLate: !!a.allowLate, extended: !!ext };
}

/** บริบทการส่งงานของนักเรียน (อ่านอย่างเดียว ใช้ได้ใน transaction ก่อนเขียน) */
async function resolve(t, ctx, offeringId, assessmentId, forWrite) {
  requireStudent(ctx);
  const { offering, enrollment } = await requireEnrollment(ctx, offeringId, forWrite, t);
  const b = 'offerings/' + offering.id;
  const a = await getDoc(t, db.doc(b + '/assessments/' + String(assessmentId || '')));
  if (!a || a.status !== 'published') raise('NOT_FOUND');
  let group = null;
  if (a.kind === 'group') {
    const gs = await queryDocs(t, db.collection(b + '/groups').where('assessmentId', '==', a.id).where('memberIds', 'array-contains', ctx.studentId));
    group = gs.find((g) => g.status !== 'disbanded') || null;
  }
  const ownerType = a.kind === 'group' ? 'group' : 'student';
  const ownerId = a.kind === 'group' ? (group ? group.id : '') : ctx.studentId;
  const subId = ownerId ? a.id + '_' + ownerId : '';
  const exts = await getMany(t, [db.doc(b + '/extensions/' + a.id + '_' + ctx.studentId)].concat(group ? [db.doc(b + '/extensions/' + a.id + '_' + group.id)] : []));
  const ext = exts.get(a.id + '_' + ctx.studentId) || (group ? exts.get(a.id + '_' + group.id) : null) || null;
  return { offering, enrollment, a, group, ownerType, ownerId, subId, window: windowOf(a, ext), b };
}

function checkWritable(rc, nowIso2, forSubmit) {
  const a = rc.a;
  if (!((a.kind === 'individual' || a.kind === 'group') && a.submissionMode !== 'none')) raise('SUBMISSION_NOT_REQUIRED');
  if (rc.window.openAt && nowIso2 < rc.window.openAt) raise('SUBMISSION_NOT_OPEN');
  if (rc.window.hardCloseAt && nowIso2 > rc.window.hardCloseAt) raise('SUBMISSION_CLOSED');
  if (a.kind !== 'group') return;
  if (!rc.group) raise('GROUP_REQUIRED');
  const pol = a.group || {};
  if (pol.submitPolicy === 'leader_only' && rc.group.leaderStudentId !== rc.enrollment.studentId) raise('GROUP_LEADER_ONLY');
  if (forSubmit) {
    const n = (rc.group.memberIds || []).length;
    if (n < (pol.minSize || 1) || n > (pol.maxSize || 50)) {
      raise('GROUP_SIZE_INVALID', 'กลุ่มมีสมาชิก ' + n + ' คน แต่งานนี้กำหนด ' + (pol.minSize === pol.maxSize ? pol.minSize : pol.minSize + '–' + pol.maxSize) + ' คน กรุณาติดต่อครู');
    }
  }
}

const currentMembers = (rc) => (rc.group ? rc.group.memberIds || [] : [rc.enrollment.studentId]);

async function quarantine(file) {
  try { await file.delete(); } catch (e) { console.warn('delete rejected upload failed', e.message); }
}

/** ตรวจไฟล์ที่อัปโหลดแล้วนำเข้าฉบับร่าง */
export async function attachUpload(ctx, d) {
  const rc0 = await resolve(null, ctx, d.offeringId, d.assessmentId, true);
  checkWritable(rc0, nowIso(), false);
  const settings = settingsOf(await getSchool(ctx.schoolId));
  const limits = limitsOf(settings, rc0.a);
  const path = String(d.uploadPath || '');
  if (!path.startsWith('uploads/' + ctx.uid + '/') || path.includes('..')) raise('VALIDATION', 'ตำแหน่งไฟล์ไม่ถูกต้อง');
  const file = bucket().file(path);
  const [exists] = await file.exists();
  if (!exists) raise('FILE_NOT_READY', 'ไม่พบไฟล์ที่อัปโหลด กรุณาอัปโหลดใหม่');
  const [meta] = await file.getMetadata();
  const size = Number(meta.size || 0);
  const nm = FileCheck.sanitizeName(d.fileName || path.split('/').pop());
  const reject = async (code, message) => { await quarantine(file); await audit(ctx, 'file.rejected', 'uploads', path, { name: nm.name, code }); return { accepted: false, code, message }; };
  if (limits.allowedTypes.indexOf(nm.ext) < 0) return reject('FILE_TYPE_NOT_ALLOWED', 'ชนิดไฟล์ .' + nm.ext + ' ไม่อนุญาตสำหรับงานนี้ (รับ: ' + limits.allowedTypes.join(', ') + ')');
  if (size > limits.maxFileBytes) return reject('FILE_TOO_LARGE', 'ไฟล์ใหญ่เกิน ' + limits.maxFileMb + ' MB');
  const [buf] = await file.download();
  const bytes = Array.prototype.slice.call(buf.subarray(0, 65536));
  const zipFamily = ['ooxml', 'odf', 'zip'].indexOf(FileCheck.TYPES[nm.ext].family) >= 0;
  const res = FileCheck.check({ ext: nm.ext, size, head: bytes, tail: zipFamily ? Array.prototype.slice.call(buf) : null, tailOffset: 0, limits: { maxBytes: limits.maxFileBytes } });
  if (!res.ok) return reject(res.code, ({ FILE_SIGNATURE_MISMATCH: 'เนื้อหาไฟล์ไม่ตรงกับนามสกุลไฟล์', FILE_REJECTED: 'ไฟล์ไม่ผ่านการตรวจความปลอดภัย' }[res.code] || 'ไฟล์ไม่ผ่านการตรวจ') + ': ' + res.reason);
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  const fileId = newId();
  const dest = 'files/' + rc0.offering.id + '/' + fileId + '.' + nm.ext;
  await file.move(dest);
  await bucket().file(dest).setMetadata({ contentType: FileCheck.safeMime(nm.ext), contentDisposition: 'attachment', metadata: { originalName: encodeURIComponent(nm.name) } });
  const fileDoc = { id: fileId, name: nm.name, ext: nm.ext, size, sha256, preview: FileCheck.previewKind(nm.ext) || '' };
  try {
    await db.runTransaction(async (t) => {
      const rc = await resolve(t, ctx, d.offeringId, d.assessmentId, true);
      checkWritable(rc, nowIso(), false);
      const draftRef = db.doc(rc.b + '/drafts/' + rc.subId);
      const draft = await getDoc(t, draftRef);
      const files = draft ? draft.files || [] : [];
      if (files.length + 1 > limits.maxFiles) raise('FILE_COUNT_EXCEEDED');
      const members = currentMembers(rc);
      t.set(draftRef, { assessmentId: rc.a.id, ownerType: rc.ownerType, ownerId: rc.ownerId, memberIds: members, files: files.concat([Object.assign({ addedBy: ctx.uid, addedByName: ctx.name, at: nowIso() }, fileDoc)]), updatedAt: nowIso() });
      t.set(db.doc(rc.b + '/files/' + fileId), Object.assign({}, fileDoc, {
        path: dest, assessmentId: rc.a.id, ownerType: rc.ownerType, ownerId: rc.ownerId, readerIds: members, uploadedByUid: ctx.uid,
        detectedType: res.detected, state: 'draft', createdAt: nowIso()
      }));
    });
  } catch (e) {
    await bucket().file(dest).delete().catch(() => {});
    throw e;
  }
  return { accepted: true, file: fileDoc };
}

export async function removeDraft(ctx, d) {
  await db.runTransaction(async (t) => {
    const rc = await resolve(t, ctx, d.offeringId, d.assessmentId, true);
    if (!rc.subId) raise('NOT_FOUND');
    const draftRef = db.doc(rc.b + '/drafts/' + rc.subId);
    const draft = await getDoc(t, draftRef);
    if (!draft || !(draft.files || []).some((f) => f.id === d.fileId)) raise('NOT_FOUND');
    if (rc.group && rc.group.frozen && !(rc.group.memberIds || []).includes(ctx.studentId)) raise('GROUP_FROZEN');
    t.update(draftRef, { files: draft.files.filter((f) => f.id !== d.fileId), updatedAt: nowIso() });
    t.update(db.doc(rc.b + '/files/' + d.fileId), { state: 'removed' });
  });
  return { ok: true };
}

/** ส่งงาน: { offeringId, assessmentId, baseVersionNo, idempotencyKey, fileIds?, comment?, links? } */
export async function submit(ctx, d) {
  const key = str(d.idempotencyKey, 100);
  if (!/^[A-Za-z0-9_-]{16,100}$/.test(key)) raise('VALIDATION', 'idempotencyKey ไม่ถูกต้อง');
  const comment = str(d.comment, 5000, 'คำอธิบาย');
  const links = (d.links || []).map((l) => str(l, 2000)).filter(Boolean);
  links.forEach((l) => { if (!/^https?:\/\/[^\s<>"']+$/i.test(l)) raise('VALIDATION', 'ลิงก์ต้องขึ้นต้นด้วย http:// หรือ https://'); });
  if (links.length > 10) raise('VALIDATION', 'แนบลิงก์ได้ไม่เกิน 10 รายการ');
  const settings = settingsOf(await getSchool(ctx.schoolId));
  const idemRef = db.doc('offerings/' + String(d.offeringId || 'x') + '/idempotency/' + ctx.uid + '_' + key);
  const out = await db.runTransaction(async (t) => {
    const prev = await getDoc(t, idemRef);
    if (prev) return Object.assign({}, prev.result, { replayed: true });
    const rc = await resolve(t, ctx, d.offeringId, d.assessmentId, true);
    const now = nowIso();
    checkWritable(rc, now, true);
    const a = rc.a;
    const subRef = db.doc(rc.b + '/submissions/' + rc.subId);
    const sub = await getDoc(t, subRef);
    const draft = await getDoc(t, db.doc(rc.b + '/drafts/' + rc.subId));
    const currentNo = sub ? Number(sub.currentVersionNo || 0) : 0;
    if (Number(d.baseVersionNo || 0) !== currentNo) {
      const lv = sub && sub.latest ? sub.latest : null;
      raise('CONFLICT', 'มีการส่งรุ่นที่ ' + currentNo + ' แล้ว' + (lv ? ' โดย ' + lv.submittedByName + ' เวลา ' + lv.submittedAt : '') + ' กรุณาตรวจสอบก่อนส่งรุ่นใหม่', { currentVersionNo: currentNo });
    }
    if (Number(a.maxAttempts || 0) > 0 && currentNo >= Number(a.maxAttempts) && (!sub || sub.status !== 'returned')) raise('ATTEMPTS_EXCEEDED');
    const limits = limitsOf(settings, a);
    const drafts = draft ? draft.files || [] : [];
    const wanted = d.fileIds ? d.fileIds.map(String) : null;
    const chosen = wanted ? drafts.filter((f) => wanted.includes(f.id)) : drafts;
    if (wanted && chosen.length !== wanted.length) raise('FILE_NOT_READY', 'บางไฟล์ไม่อยู่ในฉบับร่าง กรุณาโหลดหน้าใหม่');
    if (!limits.allowLinks && links.length) raise('VALIDATION', 'งานนี้ไม่อนุญาตให้ส่งเป็นลิงก์');
    if (!chosen.length && !links.length) raise('NOTHING_TO_SUBMIT');
    if (chosen.length > limits.maxFiles) raise('FILE_COUNT_EXCEEDED');
    chosen.forEach((f) => { if (limits.allowedTypes.indexOf(f.ext) < 0) raise('FILE_TYPE_NOT_ALLOWED', 'ไฟล์ ' + f.name + ' เป็นชนิดที่งานนี้ไม่รับ'); });
    // ---- เขียน
    let members = currentMembers(rc);
    let snapshotNo = 0;
    if (rc.group) {
      snapshotNo = rc.group.snapshotNo || 0;
      if (!rc.group.frozen) {
        snapshotNo += 1;
        const snapshots = Object.assign({}, rc.group.snapshots || {}, { [String(snapshotNo)]: members });
        t.update(db.doc(rc.b + '/groups/' + rc.group.id), { frozen: true, frozenAt: now, frozenReason: 'first_submission', snapshotNo, snapshots, updatedAt: now });
      }
    }
    const dueMs = rc.window.dueAt ? Date.parse(rc.window.dueAt) : 0;
    const lateSec = dueMs && now > rc.window.dueAt ? Math.round((Date.parse(now) - dueMs) / 1000) : 0;
    const receipt = 'CWK-' + shortCode(4) + '-' + shortCode(4);
    const versionNo = currentNo + 1;
    const files = chosen.map((f) => ({ id: f.id, name: f.name, ext: f.ext, size: f.size, sha256: f.sha256, preview: f.preview || '' }));
    const version = {
      versionNo, submittedByUid: ctx.uid, submittedByStudentId: ctx.studentId, submittedByName: ctx.name, submittedAt: now,
      dueAtEffective: rc.window.dueAt, isLate: lateSec > 0, lateSeconds: lateSec, comment, links, files, receiptCode: receipt,
      memberIds: members, memberSnapshotNo: snapshotNo, reviewStatus: 'pending', reviewNote: ''
    };
    t.set(subRef.collection('versions').doc(String(versionNo)), version);
    const reviewed = !!sub && (sub.status === 'accepted' || sub.status === 'returned' || !!sub.acceptedVersionNo);
    t.set(subRef, {
      assessmentId: a.id, ownerType: rc.ownerType, ownerId: rc.ownerId, ownerName: rc.group ? rc.group.name : ctx.name,
      memberIds: [...new Set(((sub && sub.memberIds) || []).concat(members))], currentMemberIds: members,
      status: reviewed ? 'resubmitted' : 'submitted', currentVersionNo: versionNo, acceptedVersionNo: sub ? sub.acceptedVersionNo || 0 : 0,
      latest: { versionNo, submittedAt: now, submittedByName: ctx.name, isLate: lateSec > 0, fileCount: files.length, receiptCode: receipt, reviewStatus: 'pending' },
      firstSubmittedAt: sub && sub.firstSubmittedAt || now, lastSubmittedAt: now, updatedAt: now
    });
    if (sub && sub.latest && sub.latest.reviewStatus === 'pending') t.update(subRef.collection('versions').doc(String(currentNo)), { reviewStatus: 'superseded' });
    t.set(db.doc(rc.b + '/drafts/' + rc.subId), { assessmentId: a.id, ownerType: rc.ownerType, ownerId: rc.ownerId, memberIds: members, files: drafts.filter((f) => !chosen.some((c) => c.id === f.id)), updatedAt: now });
    chosen.forEach((f) => t.update(db.doc(rc.b + '/files/' + f.id), { state: 'submitted', readerIds: members, submissionId: rc.subId, versionNo }));
    const result = {
      receiptCode: receipt, submissionId: rc.subId, versionNo, submittedAt: now, isLate: lateSec > 0, lateSeconds: lateSec,
      assessmentTitle: a.title, files: files.map((f) => ({ name: f.name, size: f.size, sha256: f.sha256 })), links, resubmitted: reviewed
    };
    t.set(idemRef, { result, uid: ctx.uid, at: now });
    return Object.assign({ _members: members }, result);
  });
  const members = out._members || [];
  delete out._members;
  if (!out.replayed) {
    await audit(ctx, 'submission.submit', 'submissions', out.submissionId, { receipt: out.receiptCode, versionNo: out.versionNo, files: out.files.length, late: out.isLate }, '', d.offeringId);
    if (members.length) {
      const snaps = await db.getAll(...members.map((sid) => db.doc('students/' + sid)));
      await notify(snaps.filter((s) => s.exists).map((s) => s.get('uid')), 'submission', 'ส่งงานสำเร็จ: ' + out.assessmentTitle, 'รุ่นที่ ' + out.versionNo + ' รหัสยืนยัน ' + out.receiptCode, 'offering:' + d.offeringId);
    }
  }
  return out;
}

/** ครูรับรุ่นเพื่อประเมิน หรือส่งคืนแก้ไข (ไม่แตะคะแนน) */
export async function review(ctx, d) {
  const action = d.action;
  if (['accept', 'return'].indexOf(action) < 0) raise('VALIDATION');
  const note = str(d.note, 5000, 'ข้อความถึงนักเรียน');
  if (action === 'return' && !note) raise('VALIDATION', 'กรุณาระบุสิ่งที่ต้องแก้ไข');
  const out = await db.runTransaction(async (t) => {
    const { offering } = await requireOffering(ctx, d.offeringId, 'can_grade', t);
    const subRef = db.doc('offerings/' + offering.id + '/submissions/' + String(d.submissionId || ''));
    const sub = await getDoc(t, subRef);
    if (!sub) raise('NOT_FOUND');
    const vRef = subRef.collection('versions').doc(String(d.versionNo));
    const v = await getDoc(t, vRef);
    if (!v) raise('NOT_FOUND');
    if (d.expectedVersionNo !== undefined && Number(d.expectedVersionNo) !== Number(sub.currentVersionNo)) raise('CONFLICT', 'มีการส่งรุ่นใหม่แล้ว กรุณาตรวจรุ่นล่าสุด');
    const now = nowIso();
    t.update(vRef, { reviewStatus: action === 'accept' ? 'accepted' : 'returned', reviewNote: note, reviewedBy: ctx.uid, reviewedByName: ctx.name, reviewedAt: now });
    const patch = { status: action === 'accept' ? 'accepted' : 'returned', updatedAt: now };
    if (action === 'accept') patch.acceptedVersionNo = v.versionNo;
    if (sub.latest && sub.latest.versionNo === v.versionNo) patch.latest = Object.assign({}, sub.latest, { reviewStatus: action === 'accept' ? 'accepted' : 'returned' });
    t.update(subRef, patch);
    return { status: patch.status, memberIds: sub.currentMemberIds || sub.memberIds || [], assessmentId: sub.assessmentId };
  });
  await audit(ctx, 'submission.' + action, 'submissions', d.submissionId, { versionNo: d.versionNo }, note, d.offeringId);
  if (action === 'return' && out.memberIds.length) {
    const snaps = await db.getAll(...out.memberIds.map((sid) => db.doc('students/' + sid)));
    const a = await getDoc(null, db.doc('offerings/' + d.offeringId + '/assessments/' + out.assessmentId));
    await notify(snaps.filter((s) => s.exists).map((s) => s.get('uid')), 'returned', 'งานถูกส่งคืนแก้ไข: ' + (a ? a.title : ''), 'กรุณาเปิดงานเพื่ออ่านสิ่งที่ครูให้แก้ไข', 'offering:' + d.offeringId);
  }
  return { ok: true, status: out.status };
}
