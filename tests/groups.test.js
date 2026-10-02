'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { call, ok, upload } = require('./harness/load');
const { fixture, idemKey } = require('./harness/fixture');
const S = require('./harness/samples');

/** สร้างกลุ่มโดย leader แล้วเชิญ/ตอบรับสมาชิก คืน groupId */
function makeGroup(f, leader, members, name) {
  const gid = ok(f.g, 'group.create', { assessmentId: f.G1, name: name || 'กลุ่มของ ' + leader }, f.t(leader)).groupId;
  for (const m of members) {
    const inv = ok(f.g, 'group.invite', { assessmentId: f.G1, studentId: f.studentId(m) }, f.t(leader));
    ok(f.g, 'group.respond', { membershipId: inv.membershipId, accept: true }, f.t(m));
  }
  return gid;
}

function submitGroup(f, user, extra = {}) {
  const d = ok(f.g, 'student.assessment', { assessmentId: f.G1 }, f.t(user));
  return call(f.g, 'submission.submit', Object.assign({ assessmentId: f.G1, baseVersionNo: d.currentVersionNo, idempotencyKey: idemKey() }, extra), f.t(user));
}

test('สร้างกลุ่ม เชิญ และตอบรับ; หนึ่งคนอยู่ได้หนึ่งกลุ่มต่องาน; เชิญคนที่ไม่ได้ลงทะเบียนไม่ได้', () => {
  const f = fixture();
  const gid = makeGroup(f, '00121', ['00122']);
  const view = ok(f.g, 'group.forStudent', { assessmentId: f.G1 }, f.t('00122'));
  assert.equal(view.myGroup.id, gid);
  assert.equal(view.myGroup.members.length, 2);
  assert.ok(view.myGroup.members.every((m) => Object.keys(m).sort().join() === 'isLeader,name,room,studentId'), 'เห็นเฉพาะชื่อและห้อง');
  assert.equal(call(f.g, 'group.create', { assessmentId: f.G1, name: 'อีกกลุ่ม' }, f.t('00122')).error.code, 'GROUP_ALREADY_MEMBER');
  assert.equal(call(f.g, 'group.invite', { assessmentId: f.G1, studentId: f.studentId('00129') }, f.t('00121')).error.code, 'VALIDATION');
  // 00123 อยู่กลุ่มอื่นแล้ว → รับคำเชิญซ้อนไม่ได้
  makeGroup(f, '00123', []);
  assert.equal(call(f.g, 'group.invite', { assessmentId: f.G1, studentId: f.studentId('00123') }, f.t('00121')).error.code, 'VALIDATION');
});

test('A08 สองคนเข้ากลุ่มที่เหลือหนึ่งที่: รับได้เพียงหนึ่งคน ไม่มีสมาชิกเกินหรืออยู่สองกลุ่ม', () => {
  const f = fixture();
  const gid = makeGroup(f, '00121', ['00122']); // 2/3
  const invA = ok(f.g, 'group.invite', { assessmentId: f.G1, studentId: f.studentId('00123') }, f.t('00121'));
  const invB = ok(f.g, 'group.invite', { assessmentId: f.G1, studentId: f.studentId('00124') }, f.t('00121'));
  // ทั้งสองคนเปิดหน้าเห็นที่ว่าง 1 ที่ แล้วกดตอบรับ "พร้อมกัน" — คำขอถูกทำทีละรายการภายใต้ script lock
  const r1 = call(f.g, 'group.respond', { membershipId: invA.membershipId, accept: true }, f.t('00123'));
  const r2 = call(f.g, 'group.respond', { membershipId: invB.membershipId, accept: true }, f.t('00124'));
  assert.equal(r1.ok, true);
  assert.equal(r2.error.code, 'GROUP_FULL');
  const active = f.g.Db.find('group_memberships', { group_id: gid, status: 'active' });
  assert.equal(active.length, 3);
  assert.equal(f.g.Db.get('groups', gid).active_count, 3);
  // ขอเข้าร่วมกลุ่มที่เต็มแล้ว
  assert.equal(call(f.g, 'group.requestJoin', { assessmentId: f.G1, groupId: gid }, f.t('00125')).error.code, 'GROUP_FULL');
  const sets = f.g.Db.find('group_memberships', { status: 'active' });
  const perStudent = {};
  sets.forEach((m) => { const k = m.group_set_id + '|' + m.student_id; perStudent[k] = (perStudent[k] || 0) + 1; });
  assert.ok(Object.values(perStudent).every((n) => n === 1));
});

test('ส่งงานกลุ่มครั้งแรกตรึงรายชื่อ (snapshot); ไฟล์จริงชุดเดียวแต่ปรากฏในแฟ้มสมาชิกทุกคน', () => {
  const f = fixture();
  const gid = makeGroup(f, '00121', ['00122', '00123']);
  const up = upload(f.g, f.t('00122'), f.G1, 'โครงงาน.pdf', S.pdf());
  assert.equal(up.data.accepted, true);
  // สมาชิกคนอื่นเห็นฉบับร่างเดียวกัน
  assert.equal(ok(f.g, 'student.assessment', { assessmentId: f.G1 }, f.t('00121')).draftFiles.length, 1);
  const r = submitGroup(f, '00121', { links: ['https://example.com/slides'] });
  assert.equal(r.ok, true, JSON.stringify(r));
  const g = f.g.Db.get('groups', gid);
  assert.equal(g.status, 'frozen');
  assert.equal(g.frozen_reason, 'first_submission');
  assert.equal(f.g.Db.find('assignment_member_snapshots', { group_id: gid, snapshot_no: 1 }).length, 3);
  assert.equal(call(f.g, 'group.leave', { assessmentId: f.G1 }, f.t('00123')).error.code, 'GROUP_FROZEN');
  assert.equal(f.g.Db.all('file_assets').length, 1, 'ไม่ทำสำเนาต่อสมาชิก');
  for (const u of ['00121', '00122', '00123']) {
    const folder = ok(f.g, 'student.folder', { offeringId: f.offA }, f.t(u));
    const g1 = folder.items.find((i) => i.code === 'G1');
    assert.equal(g1.versions.length, 1, 'ปรากฏในแฟ้มของ ' + u);
    assert.equal(g1.versions[0].viaGroup, true);
    assert.equal(g1.versions[0].files[0].fileAssetId, up.data.file.fileAssetId);
    assert.ok(ok(f.g, 'files.open', { fileAssetId: up.data.file.fileAssetId }, f.t(u)).ticket);
  }
  // คนนอกกลุ่มเปิดไฟล์กลุ่มไม่ได้
  makeGroup(f, '00124', ['00125']);
  assert.equal(call(f.g, 'files.open', { fileAssetId: up.data.file.fileAssetId }, f.t('00124')).error.code, 'NOT_FOUND');
  const notes = ok(f.g, 'notify.list', {}, f.t('00123'));
  assert.ok(notes.some((n) => n.type === 'submission'), 'สมาชิกทุกคนได้รับแจ้งส่งงานสำเร็จ');
});

test('สมาชิกสองคนส่งทับกัน: คนที่สองได้ CONFLICT พร้อมชื่อผู้ส่งก่อน ไม่เขียนทับเงียบ ๆ', () => {
  const f = fixture();
  makeGroup(f, '00121', ['00122']);
  upload(f.g, f.t('00121'), f.G1, 'a.pdf', S.pdf());
  const base = ok(f.g, 'student.assessment', { assessmentId: f.G1 }, f.t('00122')).currentVersionNo;
  ok(f.g, 'submission.submit', { assessmentId: f.G1, baseVersionNo: base, idempotencyKey: idemKey() }, f.t('00121'));
  upload(f.g, f.t('00122'), f.G1, 'b.pdf', S.pdf());
  const second = call(f.g, 'submission.submit', { assessmentId: f.G1, baseVersionNo: base, idempotencyKey: idemKey() }, f.t('00122'));
  assert.equal(second.error.code, 'CONFLICT');
  assert.match(second.error.message, /กิตติ/);
  assert.equal(f.g.Db.all('submission_versions').length, 1);
});

test('จำนวนสมาชิกไม่ครบส่งไม่ได้ จนครูอนุมัติข้อยกเว้นพร้อมเหตุผล; หัวหน้าส่งแทนเท่านั้นเมื่อครูกำหนด', () => {
  const f = fixture();
  const gid = makeGroup(f, '00121', []);
  upload(f.g, f.t('00121'), f.G1, 'a.pdf', S.pdf());
  assert.equal(submitGroup(f, '00121').error.code, 'GROUP_SIZE_INVALID');
  const t = f.t('demo_t001');
  const overview = ok(f.g, 'teacher.groups', { assessmentId: f.G1 }, t);
  assert.equal(overview.incomplete.length, 1);
  assert.ok(overview.ungrouped.length >= 7);
  assert.equal(call(f.g, 'teacher.groupApprove', { groupId: gid, sizeException: true, reason: '' }, t).error.code, 'VALIDATION');
  ok(f.g, 'teacher.groupApprove', { groupId: gid, sizeException: true, reason: 'จำนวนนักเรียนในห้องไม่ลงตัว' }, t);
  assert.equal(submitGroup(f, '00121').ok, true);

  const f2 = fixture();
  f2.patchAssessment('G1', { group_submit_policy: 'leader_only' });
  makeGroup(f2, '00121', ['00122']);
  upload(f2.g, f2.t('00121'), f2.G1, 'a.pdf', S.pdf());
  assert.equal(submitGroup(f2, '00122').error.code, 'GROUP_LEADER_ONLY');
  assert.equal(submitGroup(f2, '00121').ok, true);
});

test('A07 ครูย้ายสมาชิกหลังส่งงาน: ต้องยืนยันพร้อมเหตุผล snapshot และรุ่นการส่งเดิมไม่เปลี่ยน', () => {
  const f = fixture();
  const g1 = makeGroup(f, '00121', ['00122', '00123']);
  const g2 = makeGroup(f, '00124', ['00125']);
  upload(f.g, f.t('00121'), f.G1, 'a.pdf', S.pdf());
  const v = ok(f.g, 'submission.submit', { assessmentId: f.G1, baseVersionNo: 0, idempotencyKey: idemKey() }, f.t('00121'));
  const t = f.t('demo_t001');
  const preview = ok(f.g, 'teacher.groupAssign', { assessmentId: f.G1, studentId: f.studentId('00123'), groupId: g2 }, t);
  assert.equal(preview.needsConfirm, true);
  assert.equal(preview.impact[0].submittedVersions, 1);
  assert.equal(f.g.Db.find('group_memberships', { group_id: g1, status: 'active' }).length, 3, 'ตัวอย่างยังไม่เปลี่ยนข้อมูล');
  assert.equal(call(f.g, 'teacher.groupAssign', { assessmentId: f.G1, studentId: f.studentId('00123'), groupId: g2, confirm: true }, t).error.code, 'VALIDATION');
  ok(f.g, 'teacher.groupAssign', { assessmentId: f.G1, studentId: f.studentId('00123'), groupId: g2, confirm: true, reason: 'ย้ายตามคำขอของครูประจำชั้น' }, t);
  const version = f.g.Db.get('submission_versions', v.versionId);
  assert.equal(version.member_snapshot_no, 1, 'รุ่นการส่งเดิมยังชี้ snapshot เดิม');
  const snap1 = f.g.Db.find('assignment_member_snapshots', { group_id: g1, snapshot_no: 1 }).map((m) => m.student_id);
  assert.ok(snap1.includes(f.studentId('00123')), 'snapshot เดิมไม่ถูกแก้');
  const snap2 = f.g.Db.find('assignment_member_snapshots', { group_id: g1, snapshot_no: 2 }).map((m) => m.student_id);
  assert.equal(snap2.length, 2);
  assert.ok(!snap2.includes(f.studentId('00123')));
  assert.equal(f.g.Db.get('groups', g1).snapshot_no, 2);
  // 00123 ยังเห็นรุ่นที่ตนเคยร่วมส่ง แต่ส่งในนามกลุ่มเดิมไม่ได้แล้ว
  const folder = ok(f.g, 'student.folder', { offeringId: f.offA }, f.t('00123'));
  assert.equal(folder.items.find((i) => i.code === 'G1').versions.length, 1);
  const hist = f.g.Db.all('group_membership_history').map((h) => h.action);
  assert.ok(hist.includes('move_out') && hist.includes('move_in') && hist.includes('freeze'));
});

test('ถึงวันปิดจัดกลุ่ม: ตรึงทุกกลุ่มอัตโนมัติ และสร้าง/ออกจากกลุ่มไม่ได้', () => {
  const f = fixture();
  const gid = makeGroup(f, '00121', ['00122']);
  f.g.Db.tx('fixture', (tx) => {
    const gs = tx.one('assignment_group_sets', { assessment_id: f.G1 });
    tx.update('assignment_group_sets', gs.id, { formation_close_at: f.iso(-0.01) });
  });
  assert.equal(call(f.g, 'group.create', { assessmentId: f.G1, name: 'สาย' }, f.t('00123')).error.code, 'GROUP_FORMATION_CLOSED');
  const g = f.g.Db.get('groups', gid);
  assert.equal(g.frozen_reason, 'formation_closed');
  assert.equal(call(f.g, 'group.leave', { assessmentId: f.G1 }, f.t('00122')).error.code, 'GROUP_FORMATION_CLOSED');
  // สมาชิกที่ตรึงแล้วยังส่งงานได้ก่อนกำหนดส่ง
  upload(f.g, f.t('00122'), f.G1, 'a.pdf', S.pdf());
  assert.equal(submitGroup(f, '00122').ok, true);
  assert.equal(f.g.Db.find('assignment_member_snapshots', { group_id: gid }).length, 2, 'ไม่สร้าง snapshot ซ้ำตอนส่ง');
});

test('ครูคัดลอกกลุ่มจากงานก่อนไปงานใหม่ (ไม่ย้อนกลับไปแก้งานเก่า)', () => {
  const f = fixture();
  makeGroup(f, '00121', ['00122']);
  const t = f.t('demo_t001');
  const g2 = ok(f.g, 'teacher.saveAssessment', {
    offeringId: f.offA, code: 'G2', title: 'โครงงานกลุ่มที่ 2', kind: 'group', maxScore: 10, weight: 0, countsTowardGrade: false,
    status: 'published', group: { minSize: 2, maxSize: 3 }
  }, t);
  const r = ok(f.g, 'teacher.groupCopy', { fromAssessmentId: f.G1, toAssessmentId: g2.id }, t);
  assert.equal(r.created, 1);
  const newSet = f.g.Db.one('assignment_group_sets', { assessment_id: g2.id });
  assert.equal(f.g.Db.find('group_memberships', { group_set_id: newSet.id, status: 'active' }).length, 2);
  ok(f.g, 'group.leave', { assessmentId: g2.id }, f.t('00122'));
  const oldSet = f.g.Db.one('assignment_group_sets', { assessment_id: f.G1 });
  assert.equal(f.g.Db.find('group_memberships', { group_set_id: oldSet.id, status: 'active' }).length, 2, 'กลุ่มงานเก่าไม่เปลี่ยน');
});
