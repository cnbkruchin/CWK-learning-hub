import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { doc, onSnapshot, getDocs, collection, query, where } from 'firebase/firestore';
import { freshSeed, login, rejects, until, cleanup, adminDb } from './helpers.mjs';
import { weighted } from '../functions/src/shared/gradebook.js';

let S;
beforeEach(async () => { S = await freshSeed(); });
after(cleanup);

async function wgId(name) {
  const db = await adminDb();
  return (await db.collection('offerings/' + S.offerings.A + '/workGroups').where('name', '==', name).get()).docs[0].id;
}
async function grade(aid, code) {
  const db = await adminDb();
  const s = await db.doc('offerings/' + S.offerings.A + '/grades/' + aid + '_' + S.students[code]).get();
  return s.exists ? s.data() : null;
}

test('A05 กลุ่ม 4 คนได้ 16/20 น้ำหนัก 10: คะแนนกลุ่มอยู่ที่กลุ่ม ทุกคนได้ 16/20 (8.00) อัตโนมัติ', async () => {
  const A = S.offerings.A;
  const t = await login('demo_t001');
  const a = await t.api('assessment.save', { offeringId: A, code: 'GW1', title: 'งานกลุ่ม GW1', kind: 'group', maxScore: 20, weight: 10, status: 'published', group: { minSize: 1, maxSize: 6 } });
  const alpha = await wgId('ทีมอัลฟา');
  await t.api('wg.addMembers', { offeringId: A, workGroupId: alpha, studentIds: [S.students['00127']] });
  const r = await t.api('grades.saveGroup', { offeringId: A, assessmentId: a.id, groupId: a.id + '_' + alpha, status: 'scored', score: '16' });
  assert.equal(r.applied, 4);
  const db = await adminDb();
  const gg = (await db.doc('offerings/' + A + '/groupGrades/' + a.id + '_' + a.id + '_' + alpha).get()).data();
  assert.equal(gg.rawScore, '16');
  for (const code of ['00121', '00122', '00123', '00127']) {
    const g = await grade(a.id, code);
    assert.equal(g.rawScore, '16');
    assert.equal(g.source, 'group');
    assert.equal(weighted(g.rawScore, '20', '10'), '8.00');
  }
});

test('A06 ปรับคนหนึ่งเป็น 12 แล้วแก้กลุ่มเป็น 18: คนที่ปรับยังได้ 12 คนอื่นได้ 18 มีหน้าตัวอย่างและประวัติ', async () => {
  const A = S.offerings.A, G1 = S.assessments.G1;
  const t = await login('demo_t001');
  const gid = G1 + '_' + await wgId('ทีมอัลฟา');
  await t.api('grades.saveGroup', { offeringId: A, assessmentId: G1, groupId: gid, score: '16' });
  await rejects(t.api('grades.override', { offeringId: A, assessmentId: G1, studentId: S.students['00122'], score: '12' }), 'VALIDATION');
  await t.api('grades.override', { offeringId: A, assessmentId: G1, studentId: S.students['00122'], score: '12', reason: 'มีส่วนร่วมน้อย' });
  const pv = await t.api('grades.saveGroup', { offeringId: A, assessmentId: G1, groupId: gid, score: '18', preview: true });
  assert.equal(pv.overrides, 1);
  assert.equal(pv.members.find((m) => m.studentId === S.students['00122']).action, 'keep_override');
  assert.equal((await grade(G1, '00121')).rawScore, '16', 'หน้าตัวอย่างไม่บันทึก');
  const r = await t.api('grades.saveGroup', { offeringId: A, assessmentId: G1, groupId: gid, score: '18' });
  assert.equal(r.kept, 1);
  assert.equal((await grade(G1, '00121')).rawScore, '18');
  const ov = await grade(G1, '00122');
  assert.equal(ov.rawScore, '12');
  assert.equal(ov.isOverride, true);
  const revs = await getDocs(query(collection(t.db, 'offerings', A, 'revisions'), where('gradeId', '==', G1 + '_' + S.students['00122'])));
  assert.deepEqual(revs.docs.map((d) => d.data()).sort((x, y) => x.revisionNo - y.revisionNo).map((x) => [x.fromScore, x.toScore, x.source]), [['', '16', 'group'], ['16', '12', 'teacher']]);
  await t.api('grades.override', { offeringId: A, assessmentId: G1, studentId: S.students['00122'], clear: true, reason: 'ตรวจหลักฐานเพิ่มแล้ว' });
  assert.equal((await grade(G1, '00122')).rawScore, '18');
});

test('กลุ่มเดียวกันทำได้หลายงาน คะแนนแต่ละงานแยกกันที่กลุ่มของงานนั้น; A03 ปลายทาง 72.00', async () => {
  const A = S.offerings.A;
  const t = await login('demo_t001');
  const beta = await wgId('ทีมเบต้า');
  const a2 = await t.api('assessment.save', { offeringId: A, code: 'GX', title: 'งานกลุ่มเพิ่ม', kind: 'group', maxScore: 10, weight: 0, countsTowardGrade: false, status: 'published', group: { minSize: 1, maxSize: 6 } });
  await t.api('grades.saveGroup', { offeringId: A, assessmentId: S.assessments.G1, groupId: S.assessments.G1 + '_' + beta, score: '15' });
  await t.api('grades.saveGroup', { offeringId: A, assessmentId: a2.id, groupId: a2.id + '_' + beta, score: '9.5' });
  for (const code of ['00124', '00125', '00126']) {
    assert.equal((await grade(S.assessments.G1, code)).rawScore, '15');
    assert.equal((await grade(a2.id, code)).rawScore, '9.5');
  }
  // A03: 00121 W1 16/20 (30) + G1 18/20 (20) + EX1 30/50 (50) = 72.00
  await t.api('grades.save', { offeringId: A, assessmentId: S.assessments.W1, entries: [{ studentId: S.students['00121'], status: 'scored', score: '16' }] });
  await t.api('grades.saveGroup', { offeringId: A, assessmentId: S.assessments.G1, groupId: S.assessments.G1 + '_' + await wgId('ทีมอัลฟา'), score: '18' });
  await t.api('grades.save', { offeringId: A, assessmentId: S.assessments.EX1, entries: [{ studentId: S.students['00121'], status: 'scored', score: '30' }] });
  for (const aid of [S.assessments.W1, S.assessments.G1, S.assessments.EX1, a2.id]) await t.api('grades.publish', { offeringId: A, assessmentId: aid });
  const db = await adminDb();
  const pub = (await db.doc('offerings/' + A + '/published/' + S.students['00121']).get()).data();
  assert.equal(pub.total.status, 'complete');
  assert.equal(pub.total.final, '72.00');
  assert.equal(pub.total.grade.label, '3');
});

test('ให้คะแนนรายบุคคล: ช่วงคะแนน ค่าว่างไม่เป็นศูนย์ ยกเว้นต้องมีเหตุผล แก้ซ้อน CONFLICT; ครูร่วมสอนแก้คะแนนเดิม/ประกาศไม่ได้', async () => {
  const A = S.offerings.A, W1 = S.assessments.W1, sid = S.students['00123'];
  const t = await login('demo_t001');
  const bad = (e, code) => rejects(t.api('grades.save', { offeringId: A, assessmentId: W1, entries: [Object.assign({ studentId: sid }, e)] }), code);
  await bad({ status: 'scored', score: '21' }, 'VALIDATION');
  await bad({ status: 'scored', score: '-1' }, 'VALIDATION');
  await bad({ status: 'scored', score: '' }, 'VALIDATION');
  await bad({ status: 'excused' }, 'VALIDATION');
  const r = await t.api('grades.save', { offeringId: A, assessmentId: W1, entries: [{ studentId: sid, status: 'scored', score: '15.5', expectedVersion: 0 }] });
  const v1 = r.grades[0].version;
  await t.api('grades.save', { offeringId: A, assessmentId: W1, entries: [{ studentId: sid, status: 'scored', score: '17', expectedVersion: v1 }] });
  await bad({ status: 'scored', score: '10', expectedVersion: v1 }, 'CONFLICT');
  const co = await login('demo_t002');
  await co.api('grades.save', { offeringId: A, assessmentId: W1, entries: [{ studentId: S.students['00124'], status: 'scored', score: '12' }] });
  await rejects(co.api('grades.save', { offeringId: A, assessmentId: W1, entries: [{ studentId: sid, status: 'scored', score: '20' }] }), 'FORBIDDEN');
  await rejects(co.api('grades.publish', { offeringId: A, assessmentId: W1 }), 'FORBIDDEN');
  await rejects(t.api('grades.save', { offeringId: A, assessmentId: S.assessments.G1, entries: [{ studentId: sid, status: 'scored', score: '1' }] }), 'VALIDATION');
});

test('A17 เรียลไทม์: นักเรียนเห็นคะแนนทันทีเมื่อครูประกาศ แก้แล้วยังเห็นค่าเดิมจนประกาศใหม่; ผู้ดูแลคะแนนให้คะแนนแทนครูได้', async () => {
  const A = S.offerings.A, W1 = S.assessments.W1, me = S.students['00121'];
  const st = await login('00121');
  const t = await login('demo_t001');
  const seen = [];
  const unsub = onSnapshot(doc(st.db, 'offerings', A, 'published', me), (s) => seen.push(s.exists() ? (s.data().items[W1] || {}).score : null));
  await t.api('grades.save', { offeringId: A, assessmentId: W1, entries: [{ studentId: me, status: 'scored', score: '16' }] });
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(!seen.includes('16'), 'ยังไม่ประกาศ นักเรียนยังไม่เห็น');
  await t.api('grades.publish', { offeringId: A, assessmentId: W1 });
  await until(() => seen.includes('16'));
  await t.api('grades.save', { offeringId: A, assessmentId: W1, entries: [{ studentId: me, status: 'scored', score: '19' }] });
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(!seen.includes('19'), 'คะแนนร่างใหม่ยังไม่เปิดเผย');
  await rejects(t.api('grades.publish', { offeringId: A, assessmentId: W1, action: 'unpublish' }), 'VALIDATION');
  await t.api('grades.publish', { offeringId: A, assessmentId: W1 });
  await until(() => seen.includes('19'));
  unsub();
  const admin = await login('demo_admin');
  const beta = await wgId('ทีมเบต้า');
  assert.equal((await admin.api('grades.saveGroup', { offeringId: A, assessmentId: S.assessments.G1, groupId: S.assessments.G1 + '_' + beta, score: '14' })).applied, 3);
});
