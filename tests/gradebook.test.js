'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { call, ok } = require('./harness/load');
const { fixture } = require('./harness/fixture');

/** งานกลุ่มใหม่ที่ใช้กลุ่มประจำรายวิชา */
function workGroupAssessment(f, code, extra = {}) {
  return ok(f.g, 'teacher.saveAssessment', Object.assign({
    offeringId: f.offA, code, title: 'งานกลุ่ม ' + code, kind: 'group', maxScore: 20, weight: 10, countsTowardGrade: true,
    status: 'published', group: { minSize: 1, maxSize: 6, source: 'work_groups' }
  }, extra), f.t('demo_t001'));
}

function wgByName(f, name) {
  return f.g.Db.find('work_groups', { offering_id: f.offA }).find((w) => w.name === name && w.status === 'active');
}

function groupOf(f, assessmentId, workGroupId) {
  return f.g.Db.find('groups', { assessment_id: assessmentId }).find((g) => g.work_group_id === workGroupId);
}

function grade(f, assessmentId, code) {
  const enr = f.g.Db.one('enrollments', { offering_id: f.offA, student_id: f.studentId(code) });
  return f.g.Db.one('student_grades', { assessment_id: assessmentId, enrollment_id: enr.id });
}

test('A05 กลุ่ม 4 คนได้ 16/20 น้ำหนัก 10: คะแนนกลุ่มอยู่ที่กลุ่ม และทุกคนได้ 16/20 คิดน้ำหนัก 8.00 อัตโนมัติ', () => {
  const f = fixture();
  const t = f.t('demo_t001');
  const a = workGroupAssessment(f, 'GW1');
  const alpha = wgByName(f, 'ทีมอัลฟา');
  ok(f.g, 'wg.addMembers', { offeringId: f.offA, workGroupId: alpha.id, studentIds: [f.studentId('00127')] }, t);
  const grp = groupOf(f, a.id, alpha.id);
  assert.ok(grp, 'งานที่ใช้กลุ่มประจำรายวิชาได้กลุ่มของงานอัตโนมัติ');
  assert.equal(f.g.Db.find('group_memberships', { group_id: grp.id, status: 'active' }).length, 4);
  const r = ok(f.g, 'grades.saveGroup', { assessmentId: a.id, groupId: grp.id, status: 'scored', score: '16' }, t);
  assert.equal(r.applied, 4);
  const gg = f.g.Db.one('group_grades', { assessment_id: a.id, group_id: grp.id });
  assert.equal(gg.raw_score, '16', 'คะแนนกลุ่มเก็บที่กลุ่ม');
  for (const code of ['00121', '00122', '00123', '00127']) {
    const g = grade(f, a.id, code);
    assert.equal(g.raw_score, '16', 'ไม่หารด้วยจำนวนสมาชิก ' + code);
    assert.equal(g.source, 'group');
    assert.equal(g.group_grade_id, gg.id);
    assert.equal(f.g.Grading.weighted(g.raw_score, a.maxScore, a.weight), '8.00');
  }
  assert.equal(f.g.Db.get('groups', grp.id).frozen_reason, 'teacher', 'ให้คะแนนแล้วตรึงรายชื่อที่ได้คะแนน');
  const sheet = ok(f.g, 'grades.sheet', { offeringId: f.offA }, t);
  const row = sheet.students.find((s) => s.code === '00127');
  assert.equal(row.cells[a.id].score, '16');
  assert.equal(row.cells[a.id].groupName, 'ทีมอัลฟา');
});

test('A06 ปรับคนหนึ่งเป็น 12 แล้วแก้กลุ่มเป็น 18: คนที่ปรับยังได้ 12 คนอื่นได้ 18 พร้อมประวัติ และยกเลิกการปรับได้', () => {
  const f = fixture();
  const t = f.t('demo_t001');
  const a = workGroupAssessment(f, 'GW1');
  const grp = groupOf(f, a.id, wgByName(f, 'ทีมอัลฟา').id);
  ok(f.g, 'grades.saveGroup', { assessmentId: a.id, groupId: grp.id, score: '16' }, t);
  assert.equal(call(f.g, 'grades.override', { assessmentId: a.id, studentId: f.studentId('00122'), score: '12' }, t).error.code, 'VALIDATION', 'ต้องมีเหตุผล');
  ok(f.g, 'grades.override', { assessmentId: a.id, studentId: f.studentId('00122'), score: '12', reason: 'มีส่วนร่วมน้อย ตามบันทึกการทำงาน' }, t);
  assert.equal(grade(f, a.id, '00122').raw_score, '12');
  const preview = ok(f.g, 'grades.saveGroup', { assessmentId: a.id, groupId: grp.id, score: '18', preview: true }, t);
  assert.equal(preview.preview, true);
  assert.equal(preview.overrides, 1);
  assert.equal(preview.members.find((m) => m.studentCode === '00122').action, 'keep_override');
  assert.equal(grade(f, a.id, '00121').raw_score, '16', 'หน้าตัวอย่างไม่บันทึก');
  const r = ok(f.g, 'grades.saveGroup', { assessmentId: a.id, groupId: grp.id, score: '18' }, t);
  assert.equal(r.kept, 1);
  assert.equal(grade(f, a.id, '00121').raw_score, '18');
  assert.equal(grade(f, a.id, '00123').raw_score, '18');
  const ov = grade(f, a.id, '00122');
  assert.equal(ov.raw_score, '12');
  assert.equal(ov.is_override, true);
  assert.match(ov.override_reason, /มีส่วนร่วมน้อย/);
  const hist = ok(f.g, 'grades.history', { studentGradeId: ov.id }, t);
  assert.deepEqual(hist.map((h) => [h.fromScore, h.toScore, h.source]), [['', '16', 'group'], ['16', '12', 'teacher']]);
  assert.ok(hist.every((h) => h.by && h.at));
  // ยกเลิกการปรับอย่างชัดเจน → กลับไปใช้คะแนนกลุ่มล่าสุด
  ok(f.g, 'grades.override', { assessmentId: a.id, studentId: f.studentId('00122'), clear: true, reason: 'ครูตรวจหลักฐานเพิ่มเติมแล้ว' }, t);
  assert.equal(grade(f, a.id, '00122').raw_score, '18');
  assert.equal(grade(f, a.id, '00122').is_override, false);
});

test('กลุ่มเดียวกันทำได้หลายงาน: คะแนนกลุ่มแต่ละงานแยกกันอยู่ที่กลุ่มของงานนั้น และรวมเป็นคะแนนรายคน', () => {
  const f = fixture();
  const t = f.t('demo_t001');
  const a1 = workGroupAssessment(f, 'GW1');
  const a2 = workGroupAssessment(f, 'GW2', { maxScore: 10, weight: 5 });
  const beta = wgByName(f, 'ทีมเบต้า');
  const g1 = groupOf(f, a1.id, beta.id), g2 = groupOf(f, a2.id, beta.id);
  assert.notEqual(g1.id, g2.id);
  ok(f.g, 'grades.saveGroup', { assessmentId: a1.id, groupId: g1.id, score: '15' }, t);
  ok(f.g, 'grades.saveGroup', { assessmentId: a2.id, groupId: g2.id, score: '9.5' }, t);
  assert.equal(f.g.Db.one('group_grades', { assessment_id: a1.id, group_id: g1.id }).raw_score, '15');
  assert.equal(f.g.Db.one('group_grades', { assessment_id: a2.id, group_id: g2.id }).raw_score, '9.5');
  for (const code of ['00124', '00125', '00126']) {
    assert.equal(grade(f, a1.id, code).raw_score, '15');
    assert.equal(grade(f, a2.id, code).raw_score, '9.5');
  }
  const rep = ok(f.g, 'report.data', { kind: 'groups', offeringId: f.offA }, t);
  const summary = rep.sections[0];
  const betaRow = summary.rows.find((r) => r[0] === 'ทีมเบต้า');
  const col1 = summary.columns.findIndex((c) => c.label.startsWith('GW1'));
  const col2 = summary.columns.findIndex((c) => c.label.startsWith('GW2'));
  assert.equal(betaRow[col1].v, '15');
  assert.equal(betaRow[col2].v, '9.5');
});

test('A16 บันทึกคะแนนกลุ่มล้มเหลวกลางทาง: ย้อนกลับทั้งหมด ไม่มีคะแนนสมาชิกค้างบางส่วน', () => {
  const f = fixture();
  const t = f.t('demo_t001');
  const a = workGroupAssessment(f, 'GW1');
  const grp = groupOf(f, a.id, wgByName(f, 'ทีมอัลฟา').id);
  let armed = true;
  f.g.Db._testHooks.beforeWrite = (name) => { if (armed && name === 'student_grades') { armed = false; throw new Error('simulated sheet failure'); } };
  const r = call(f.g, 'grades.saveGroup', { assessmentId: a.id, groupId: grp.id, score: '16' }, t);
  f.g.Db._testHooks.beforeWrite = null;
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'INTERNAL');
  f.g.Db.reset();
  assert.equal(f.g.Db.find('group_grades', { assessment_id: a.id }).length, 0);
  assert.equal(f.g.Db.find('student_grades', { assessment_id: a.id }).length, 0);
  assert.equal(f.g.Db.find('grade_revisions', {}).length, 0);
  assert.ok(!f.g.Db.get('groups', grp.id).frozen_at, 'การตรึงในธุรกรรมเดียวกันถูกย้อนกลับด้วย');
  assert.equal(ok(f.g, 'grades.saveGroup', { assessmentId: a.id, groupId: grp.id, score: '16' }, t).applied, 3);
});

test('A03 ปลายทาง: งานเดี่ยว 16/20 (30) + งานกลุ่ม 18/20 (20) + สอบ 30/50 (50) = 72.00 เกรด 3 ผ่านบริการจริง', () => {
  const f = fixture();
  const t = f.t('demo_t001');
  const gid = ok(f.g, 'group.create', { assessmentId: f.G1, name: 'กลุ่มทดสอบ' }, f.t('00121')).groupId;
  const inv = ok(f.g, 'group.invite', { assessmentId: f.G1, studentId: f.studentId('00122') }, f.t('00121'));
  ok(f.g, 'group.respond', { membershipId: inv.membershipId, accept: true }, f.t('00122'));
  ok(f.g, 'grades.save', { assessmentId: f.W1, entries: [{ studentId: f.studentId('00121'), status: 'scored', score: '16' }] }, t);
  ok(f.g, 'grades.saveGroup', { assessmentId: f.G1, groupId: gid, score: '18' }, t);
  ok(f.g, 'grades.save', { assessmentId: f.EX1, entries: [{ studentId: f.studentId('00121'), status: 'scored', score: '30' }] }, t);
  const sheet = ok(f.g, 'grades.sheet', { offeringId: f.offA }, t);
  const row = sheet.students.find((s) => s.code === '00121');
  assert.equal(row.total.status, 'complete');
  assert.equal(row.total.final, '72.00');
  assert.equal(row.total.grade.label, '3');
  const row2 = sheet.students.find((s) => s.code === '00122');
  assert.equal(row2.total.status, 'incomplete');
  assert.equal(row2.total.provisional, '18.00', 'คะแนนสะสมบนฐาน 100 (ไม่นับที่ยังไม่ประเมินเป็นศูนย์)');
});

test('ให้คะแนนรายบุคคล: ตรวจช่วงคะแนน ค่าว่างไม่เป็นศูนย์ ยกเว้นต้องมีเหตุผล แก้ซ้อนได้ CONFLICT; สิทธิ์ครูร่วมสอน/ครูนอกรายวิชา (A14, A22)', () => {
  const f = fixture();
  const t = f.t('demo_t001');
  const sid = f.studentId('00123');
  const bad = (entry, code) => assert.equal(call(f.g, 'grades.save', { assessmentId: f.W1, entries: [Object.assign({ studentId: sid }, entry)] }, t).error.code, code, JSON.stringify(entry));
  bad({ status: 'scored', score: '21' }, 'VALIDATION');
  bad({ status: 'scored', score: '-1' }, 'VALIDATION');
  bad({ status: 'scored', score: '' }, 'VALIDATION');
  bad({ status: 'excused' }, 'VALIDATION');
  assert.equal(f.g.Db.find('student_grades', { assessment_id: f.W1 }).length, 0);
  const r = ok(f.g, 'grades.save', { assessmentId: f.W1, entries: [{ studentId: sid, status: 'scored', score: '15.5', expectedVersion: 0 }] }, t);
  assert.equal(r.saved, 1);
  const v1 = r.grades[0].version;
  assert.equal(ok(f.g, 'grades.save', { assessmentId: f.W1, entries: [{ studentId: sid, status: 'scored', score: '15.5' }] }, t).unchanged, 1);
  ok(f.g, 'grades.save', { assessmentId: f.W1, entries: [{ studentId: sid, status: 'scored', score: '17', expectedVersion: v1 }] }, t);
  // ครูอีกคนแก้จากหน้าที่เปิดค้างไว้ (รุ่นเก่า)
  assert.equal(call(f.g, 'grades.save', { assessmentId: f.W1, entries: [{ studentId: sid, status: 'scored', score: '10', expectedVersion: v1 }] }, t).error.code, 'CONFLICT');
  // ครูร่วมสอน T002: ให้คะแนนใหม่ได้ แก้คะแนนที่บันทึกแล้วไม่ได้ และประกาศไม่ได้
  const co = f.t('demo_t002');
  ok(f.g, 'grades.save', { assessmentId: f.W1, entries: [{ studentId: f.studentId('00124'), status: 'scored', score: '12' }] }, co);
  assert.equal(call(f.g, 'grades.save', { assessmentId: f.W1, entries: [{ studentId: sid, status: 'scored', score: '20' }] }, co).error.code, 'FORBIDDEN');
  assert.equal(call(f.g, 'grades.publish', { assessmentId: f.W1 }, co).error.code, 'FORBIDDEN');
  // ครูนอกรายวิชา
  const out = f.t('demo_t003');
  assert.equal(call(f.g, 'grades.save', { assessmentId: f.W1, entries: [{ studentId: sid, status: 'scored', score: '1' }] }, out).error.code, 'FORBIDDEN');
  assert.equal(call(f.g, 'grades.sheet', { offeringId: f.offA }, out).error.code, 'FORBIDDEN');
  // ยกเว้นพร้อมเหตุผล → ตัดออกจากฐาน
  ok(f.g, 'grades.save', { assessmentId: f.EX1, entries: [{ studentId: sid, status: 'excused', reason: 'ป่วย มีใบรับรองแพทย์' }] }, t);
  assert.equal(f.g.Db.find('student_grades', { assessment_id: f.EX1 })[0].excuse_reason, 'ป่วย มีใบรับรองแพทย์');
  // งานกลุ่มให้คะแนนรายคนตรงไม่ได้
  assert.equal(call(f.g, 'grades.save', { assessmentId: f.G1, entries: [{ studentId: sid, status: 'scored', score: '1' }] }, t).error.code, 'VALIDATION');
});

test('A17 ประกาศคะแนน: นักเรียนเห็นเฉพาะค่าที่ประกาศ แก้แล้วยังเห็นค่าเดิมจนประกาศใหม่ เรียกคืนต้องมีเหตุผล', () => {
  const f = fixture();
  const t = f.t('demo_t001');
  const st = f.t('00121');
  ok(f.g, 'grades.save', { assessmentId: f.W1, entries: [{ studentId: f.studentId('00121'), status: 'scored', score: '16' }] }, t);
  let mine = ok(f.g, 'student.grades', { offeringId: f.offA }, st);
  assert.equal(mine.items.find((i) => i.code === 'W1').status, 'not_published');
  assert.equal(mine.items.find((i) => i.code === 'W1').score, null);
  assert.equal(mine.total.provisional, '0.00');
  ok(f.g, 'grades.publish', { assessmentId: f.W1 }, t);
  mine = ok(f.g, 'student.grades', { offeringId: f.offA }, st);
  assert.equal(mine.items.find((i) => i.code === 'W1').score, '16');
  assert.equal(mine.items.find((i) => i.code === 'W1').weighted, '24.00');
  assert.equal(mine.total.provisional, '24.00');
  assert.equal(ok(f.g, 'student.assessments', { offeringId: f.offA }, st).find((a) => a.code === 'W1').publishedScore, '16');
  const notes = ok(f.g, 'notify.list', {}, st);
  assert.ok(notes.some((n) => n.type === 'grade' && !/16/.test(n.title + n.body)), 'แจ้งเตือนไม่มีคะแนน');
  ok(f.g, 'grades.save', { assessmentId: f.W1, entries: [{ studentId: f.studentId('00121'), status: 'scored', score: '19' }] }, t);
  assert.equal(ok(f.g, 'student.grades', { offeringId: f.offA }, st).items.find((i) => i.code === 'W1').score, '16', 'ร่างใหม่ยังไม่เปิดเผย');
  const sheet = ok(f.g, 'grades.sheet', { offeringId: f.offA }, t);
  assert.equal(sheet.assessments.find((a) => a.code === 'W1').stats.unpublished, 1);
  assert.equal(call(f.g, 'grades.publish', { assessmentId: f.W1, action: 'unpublish' }, t).error.code, 'VALIDATION');
  ok(f.g, 'grades.publish', { assessmentId: f.W1, action: 'unpublish', reason: 'พบคะแนนผิด' }, t);
  assert.equal(ok(f.g, 'student.grades', { offeringId: f.offA }, st).items.find((i) => i.code === 'W1').score, null);
  // นักเรียนคนอื่นไม่เห็นคะแนนของเพื่อน
  assert.equal(call(f.g, 'grades.sheet', { offeringId: f.offA }, f.t('00122')).error.code, 'FORBIDDEN');
});

test('ผู้ดูแล (มีสิทธิ์ผู้ดูแลคะแนน) ให้คะแนนกลุ่มแทนครูได้ เพิกถอนสิทธิ์แล้วให้คะแนนไม่ได้', () => {
  const f = fixture();
  const adm = f.admin();
  const a = workGroupAssessment(f, 'GW1');
  const grp = groupOf(f, a.id, wgByName(f, 'ทีมอัลฟา').id);
  assert.equal(ok(f.g, 'grades.saveGroup', { assessmentId: a.id, groupId: grp.id, score: '14' }, adm).applied, 3);
  const me = ok(f.g, 'auth.me', {}, adm);
  ok(f.g, 'admin.setRole', { userId: me.userId, role: 'grade_admin', grant: false, reason: 'ทดสอบ' }, adm);
  assert.equal(call(f.g, 'grades.saveGroup', { assessmentId: a.id, groupId: grp.id, score: '15' }, adm).error.code, 'FORBIDDEN');
  const audit = f.g.Db.all('audit_log').filter((x) => x.action === 'grade.group');
  assert.equal(audit.length, 1);
});
