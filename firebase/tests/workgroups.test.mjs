import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { doc, getDoc, getDocs, collection, query, where, onSnapshot } from 'firebase/firestore';
import { freshSeed, login, rejects, until, cleanup, adminDb } from './helpers.mjs';

let S;
beforeEach(async () => { S = await freshSeed(); });
after(cleanup);

const wgByName = async (name) => (await (await adminDb()).collection('offerings/' + S.offerings.A + '/workGroups').where('name', '==', name).where('status', '==', 'active').get()).docs[0];

test('นักเรียนสร้างกลุ่ม หัวหน้าเลือกสมาชิก เพื่อนเห็นคำเชิญแบบเรียลไทม์แล้วตอบรับ → ซิงก์ไปงานกลุ่ม G1', async () => {
  const A = S.offerings.A;
  const s7 = await login('00127'), s8 = await login('00128');
  // 00128 ฟังกลุ่มที่เชิญตนเองแบบเรียลไทม์
  const seen = [];
  const unsub = onSnapshot(query(collection(s8.db, 'offerings', A, 'workGroups'), where('invitedIds', 'array-contains', S.students['00128'])), (snap) => seen.push(snap.docs.map((d) => d.data().name)));
  const { id } = await s7.api('wg.create', { offeringId: A, name: 'ทีมแกมมา' });
  await rejects(s7.api('wg.invite', { offeringId: A, studentIds: [S.students['00121']] }), 'VALIDATION'); // อยู่กลุ่มอื่นแล้ว
  await rejects(s7.api('wg.invite', { offeringId: A, studentIds: [S.students['00129']] }), 'VALIDATION'); // ไม่ได้ลงทะเบียน
  assert.equal((await s7.api('wg.invite', { offeringId: A, studentIds: [S.students['00128']] })).mode, 'invited');
  await until(() => seen.some((names) => names.includes('ทีมแกมมา')));
  unsub();
  const s2 = await login('00122');
  await rejects(s2.api('wg.invite', { offeringId: A, studentIds: [S.students['00128']] }), 'FORBIDDEN'); // สมาชิกที่ไม่ใช่หัวหน้า
  await s8.api('wg.respond', { offeringId: A, workGroupId: id, accept: true });
  const g = (await getDoc(doc(s8.db, 'offerings', A, 'groups', S.assessments.G1 + '_' + id))).data();
  assert.deepEqual([...g.memberIds].sort(), [S.students['00127'], S.students['00128']].sort());
  assert.equal((await getDoc(doc(s8.db, 'offerings', A, 'roster', S.students['00128']))).data().workGroupId, id);
  // ครูล็อกกลุ่ม → นักเรียนเปลี่ยนไม่ได้ / เปิดให้หัวหน้าเพิ่มทันที
  const t = await login('demo_t001');
  await t.api('wg.settings', { offeringId: A, locked: true });
  await rejects(s8.api('wg.leave', { offeringId: A }), 'GROUPS_LOCKED');
  await t.api('wg.settings', { offeringId: A, locked: false, leaderDirectAdd: true, maxSize: 3 });
  await s8.api('wg.leave', { offeringId: A });
  assert.equal((await s7.api('wg.invite', { offeringId: A, studentIds: [S.students['00128']] })).mode, 'added');
});

test('A08 สองคนตอบรับเข้ากลุ่มที่เหลือที่ว่างเดียวพร้อมกัน: สำเร็จคนเดียว ไม่มีใครอยู่สองกลุ่ม', async () => {
  const A = S.offerings.A;
  const t = await login('demo_t001');
  await t.api('wg.settings', { offeringId: A, maxSize: 3 });
  const s7 = await login('00127'), s8 = await login('00128'), s1 = await login('00121');
  const { id } = await s7.api('wg.create', { offeringId: A, name: 'ทีมพร้อมกัน' });
  await t.api('wg.addMembers', { offeringId: A, workGroupId: id, studentIds: [S.students['00126']] }); // 2/3
  await t.api('wg.removeMember', { offeringId: A, workGroupId: (await wgByName('ทีมอัลฟา')).id, studentId: S.students['00121'] });
  await s7.api('wg.invite', { offeringId: A, studentIds: [S.students['00128'], S.students['00121']] });
  const results = await Promise.allSettled([
    s8.api('wg.respond', { offeringId: A, workGroupId: id, accept: true }),
    s1.api('wg.respond', { offeringId: A, workGroupId: id, accept: true })
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const failed = results.find((r) => r.status === 'rejected').reason;
  assert.equal(failed.details.code, 'GROUP_FULL');
  const db = await adminDb();
  const wg = (await db.doc('offerings/' + A + '/workGroups/' + id).get()).data();
  assert.equal(wg.memberIds.length, 3);
  const roster = (await db.collection('offerings/' + A + '/roster').get()).docs.map((d) => d.data().workGroupId).filter(Boolean);
  const counts = {};
  (await db.collection('offerings/' + A + '/workGroups').where('status', '==', 'active').get()).docs.forEach((d) => d.data().memberIds.forEach((m) => { counts[m] = (counts[m] || 0) + 1; }));
  assert.ok(Object.values(counts).every((n) => n === 1), 'ไม่มีใครอยู่สองกลุ่ม');
  assert.equal(roster.length, Object.keys(counts).length);
});

test('A07 ครู/ผู้ดูแลย้ายสมาชิกหลังกลุ่มส่งงาน: รายชื่อที่ตรึงของงานเดิมไม่เปลี่ยน งานใหม่ใช้รายชื่อปัจจุบัน; ย้ายในงานที่ตรึงต้องยืนยัน+เหตุผล', async () => {
  const A = S.offerings.A, G1 = S.assessments.G1;
  const db = await adminDb();
  const alpha = await wgByName('ทีมอัลฟา'), beta = await wgByName('ทีมเบต้า');
  // ครูให้คะแนนกลุ่มอัลฟา → ตรึงรายชื่อของงาน G1
  const t = await login('demo_t001');
  await t.api('grades.saveGroup', { offeringId: A, assessmentId: G1, groupId: G1 + '_' + alpha.id, status: 'scored', score: '15' });
  const admin = await login('demo_admin');
  const r = await admin.api('wg.addMembers', { offeringId: A, workGroupId: beta.id, studentIds: [S.students['00123']] });
  assert.equal(r.moved, 1);
  const gA = (await db.doc('offerings/' + A + '/groups/' + G1 + '_' + alpha.id).get()).data();
  assert.ok(gA.frozen);
  assert.ok(gA.memberIds.includes(S.students['00123']), 'รายชื่อที่ตรึงของงานเดิมไม่เปลี่ยน');
  const gB = (await db.doc('offerings/' + A + '/groups/' + G1 + '_' + beta.id).get()).data();
  assert.ok(!gB.memberIds.includes(S.students['00123']), 'ไม่ถูกเพิ่มซ้ำอีกกลุ่มในงานเดียวกัน');
  const a2 = await t.api('assessment.save', { offeringId: A, code: 'G2', title: 'งานกลุ่มที่ 2', kind: 'group', maxScore: 10, weight: 0, countsTowardGrade: false, status: 'published', group: { minSize: 1, maxSize: 5 } });
  const gB2 = (await db.doc('offerings/' + A + '/groups/' + a2.id + '_' + beta.id).get()).data();
  assert.equal(gB2.memberIds.length, 4, 'งานใหม่ใช้รายชื่อปัจจุบัน');
  // ปรับสมาชิกของงานที่ตรึงแล้ว: ตัวอย่างผลกระทบก่อน
  const pv = await t.api('group.moveFrozen', { offeringId: A, assessmentId: G1, studentId: S.students['00122'], toGroupId: G1 + '_' + beta.id });
  assert.equal(pv.needsConfirm, true);
  assert.equal(pv.impact.find((x) => x.groupName === 'ทีมอัลฟา').hasGroupGrade, true);
  await rejects(t.api('group.moveFrozen', { offeringId: A, assessmentId: G1, studentId: S.students['00122'], toGroupId: G1 + '_' + beta.id, confirm: true }), 'VALIDATION');
  await t.api('group.moveFrozen', { offeringId: A, assessmentId: G1, studentId: S.students['00122'], toGroupId: G1 + '_' + beta.id, confirm: true, reason: 'ตามคำขอครูประจำชั้น' });
  const gA2 = (await db.doc('offerings/' + A + '/groups/' + G1 + '_' + alpha.id).get()).data();
  assert.equal(gA2.snapshotNo, 2);
  assert.ok(gA2.snapshots['1'].includes(S.students['00122']), 'รายชื่อชุดเดิมยังอยู่');
  assert.ok(!gA2.memberIds.includes(S.students['00122']));
  // ครูนอกรายวิชาจัดกลุ่มไม่ได้; ถอนรายวิชาแล้วออกจากกลุ่ม
  const t3 = await login('demo_t003');
  await rejects(t3.api('wg.addMembers', { offeringId: A, workGroupId: beta.id, studentIds: [S.students['00127']] }), 'FORBIDDEN');
  await t.api('offering.withdraw', { offeringId: A, studentId: S.students['00124'], reason: 'ย้ายห้อง' });
  assert.ok(!(await db.doc('offerings/' + A + '/workGroups/' + beta.id).get()).data().memberIds.includes(S.students['00124']));
  // สุ่มจัดกลุ่มคนที่เหลือ
  const auto = await t.api('wg.auto', { offeringId: A, size: 2 });
  assert.equal(auto.students, 2);
  void getDocs;
});
