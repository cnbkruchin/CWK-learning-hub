'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { call, ok, upload } = require('./harness/load');
const { fixture, idemKey } = require('./harness/fixture');
const S = require('./harness/samples');

/** อ่านไฟล์ใน ZIP แบบ STORE (ไฟล์ .xlsx ที่ระบบสร้าง) */
function unzip(buf) {
  const out = {};
  let p = 0;
  while (buf.readUInt32LE(p) === 0x04034b50) {
    const method = buf.readUInt16LE(p + 8);
    const size = buf.readUInt32LE(p + 18);
    const nameLen = buf.readUInt16LE(p + 26);
    const extra = buf.readUInt16LE(p + 28);
    const name = buf.subarray(p + 30, p + 30 + nameLen).toString('utf8');
    assert.equal(method, 0);
    out[name] = buf.subarray(p + 30 + nameLen + extra, p + 30 + nameLen + extra + size).toString('utf8');
    p += 30 + nameLen + extra + size;
  }
  assert.equal(buf.readUInt32LE(p), 0x02014b50, 'มี central directory');
  return out;
}

function sheetValues(xml) {
  const rows = [];
  for (const m of xml.matchAll(/<row r="(\d+)">(.*?)<\/row>/g)) {
    const cells = [];
    for (const c of m[2].matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>(.*?)<\/c>)/g)) {
      const attrs = c[2];
      const inner = c[3] || '';
      let v = '';
      if (/t="inlineStr"/.test(attrs)) v = { s: (inner.match(/<t[^>]*>([\s\S]*?)<\/t>/) || [])[1] || '' };
      else if (/<v>/.test(inner)) v = { n: inner.match(/<v>(.*?)<\/v>/)[1] };
      let col = 0;
      for (const ch of c[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
      cells[col - 1] = v;
    }
    rows.push(cells);
  }
  return rows;
}
const unxml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

test('กลุ่มประจำรายวิชา: นักเรียนสร้างกลุ่ม หัวหน้าเลือกสมาชิก (เชิญ/ตอบรับ) ซิงก์ไปงานกลุ่มที่ใช้กลุ่มประจำรายวิชาอัตโนมัติ', () => {
  const f = fixture();
  const s7 = f.t('00127');
  const created = ok(f.g, 'wg.create', { offeringId: f.offA, name: 'ทีมแกมมา' }, s7);
  const view = ok(f.g, 'wg.mine', { offeringId: f.offA }, s7);
  assert.equal(view.myGroup.isLeader, true);
  assert.deepEqual(view.classmates.map((c) => c.name).length, 1, 'เพื่อนที่ยังไม่มีกลุ่ม (00128)');
  assert.ok(view.classmates.every((c) => Object.keys(c).sort().join() === 'isLeader,name,roomLabel,studentId'), 'เห็นเฉพาะชื่อและห้อง');
  assert.equal(call(f.g, 'wg.invite', { offeringId: f.offA, studentIds: [f.studentId('00121')] }, s7).error.code, 'VALIDATION', 'อยู่กลุ่มอื่นแล้ว');
  assert.equal(call(f.g, 'wg.invite', { offeringId: f.offA, studentIds: [f.studentId('00129')] }, s7).error.code, 'VALIDATION', 'ไม่ได้ลงทะเบียน');
  const inv = ok(f.g, 'wg.invite', { offeringId: f.offA, studentIds: [f.studentId('00128')] }, s7);
  assert.equal(inv.mode, 'invited');
  assert.equal(call(f.g, 'wg.invite', { offeringId: f.offA, studentIds: [f.studentId('00128')] }, f.t('00122')).error.code, 'FORBIDDEN', 'สมาชิกที่ไม่ใช่หัวหน้าเลือกสมาชิกไม่ได้');
  const s8 = f.t('00128');
  const mine8 = ok(f.g, 'wg.mine', { offeringId: f.offA }, s8);
  assert.equal(mine8.invitations.length, 1);
  ok(f.g, 'wg.respond', { memberId: mine8.invitations[0].memberId, accept: true }, s8);
  // ซิงก์ไปงาน GP1 (ใช้กลุ่มประจำรายวิชา)
  const gpGroup = f.g.Db.find('groups', { assessment_id: f.GP1 }).find((g) => g.work_group_id === created.id);
  assert.ok(gpGroup);
  assert.deepEqual([...f.g.Db.find('group_memberships', { group_id: gpGroup.id, status: 'active' }).map((m) => m.student_id)].sort(), [f.studentId('00127'), f.studentId('00128')].sort());
  const fs = ok(f.g, 'group.forStudent', { assessmentId: f.GP1 }, s8);
  assert.equal(fs.settings.source, 'work_groups');
  assert.equal(fs.myGroup.name, 'ทีมแกมมา');
  assert.equal(call(f.g, 'group.leave', { assessmentId: f.GP1 }, s8).error.code, 'VALIDATION', 'งานนี้จัดการกลุ่มที่หน้ากลุ่มประจำรายวิชา');
  // ครูล็อกกลุ่ม → นักเรียนเปลี่ยนไม่ได้ / ครูเปิดให้หัวหน้าเพิ่มสมาชิกทันที
  const t = f.t('demo_t001');
  ok(f.g, 'wg.settings', { offeringId: f.offA, locked: true }, t);
  assert.equal(call(f.g, 'wg.leave', { offeringId: f.offA }, s8).error.code, 'GROUPS_LOCKED');
  ok(f.g, 'wg.settings', { offeringId: f.offA, locked: false, leaderDirectAdd: true, maxSize: 3 }, t);
  ok(f.g, 'wg.leave', { offeringId: f.offA }, s8);
  assert.equal(ok(f.g, 'wg.invite', { offeringId: f.offA, studentIds: [f.studentId('00128')] }, s7).mode, 'added');
  assert.equal(ok(f.g, 'wg.mine', { offeringId: f.offA }, s8).myGroup.name, 'ทีมแกมมา');
});

test('ครู/ผู้ดูแลจัดนักเรียนเข้ากลุ่มประจำรายวิชา: ย้ายกลุ่มได้ งานที่ส่งแล้ว (ตรึง) ไม่ถูกเปลี่ยนย้อนหลัง; สุ่มจัดกลุ่ม', () => {
  const f = fixture();
  const adm = f.admin();
  const alpha = f.g.Db.find('work_groups', { offering_id: f.offA }).find((w) => w.name === 'ทีมอัลฟา');
  const beta = f.g.Db.find('work_groups', { offering_id: f.offA }).find((w) => w.name === 'ทีมเบต้า');
  // ทีมอัลฟาส่งงาน GP1 → ตรึงรายชื่อ
  const up = upload(f.g, f.t('00121'), f.GP1, 'รายงาน.pdf', S.pdf());
  assert.equal(up.data.accepted, true);
  ok(f.g, 'submission.submit', { assessmentId: f.GP1, baseVersionNo: 0, idempotencyKey: idemKey() }, f.t('00121'));
  const gpAlpha = f.g.Db.find('groups', { assessment_id: f.GP1 }).find((g) => g.work_group_id === alpha.id);
  assert.equal(gpAlpha.frozen_reason, 'first_submission');
  // ผู้ดูแลย้าย 00123 ไปทีมเบต้า
  const r = ok(f.g, 'wg.addMembers', { offeringId: f.offA, workGroupId: beta.id, studentIds: [f.studentId('00123')] }, adm);
  assert.equal(r.moved, 1);
  assert.equal(f.g.Db.find('work_group_members', { work_group_id: alpha.id, status: 'active' }).length, 2);
  const snap = f.g.Db.find('assignment_member_snapshots', { group_id: gpAlpha.id, snapshot_no: 1 }).map((m) => m.student_id);
  assert.ok(snap.includes(f.studentId('00123')), 'รายชื่อที่ตรึงของงานเดิมไม่เปลี่ยน');
  const gpBeta = f.g.Db.find('groups', { assessment_id: f.GP1 }).find((g) => g.work_group_id === beta.id);
  assert.ok(!f.g.Db.find('group_memberships', { group_id: gpBeta.id, status: 'active' }).some((m) => m.student_id === f.studentId('00123')), 'คนที่อยู่ในกลุ่มที่ตรึงแล้วไม่ถูกเพิ่มซ้ำอีกกลุ่มในงานเดียวกัน');
  // งานใหม่ที่สร้างภายหลังได้รายชื่อปัจจุบัน
  const a2 = ok(f.g, 'teacher.saveAssessment', { offeringId: f.offA, code: 'GP2', title: 'งานกลุ่มที่ 2', kind: 'group', maxScore: 10, weight: 0, countsTowardGrade: false, status: 'published', group: { minSize: 1, maxSize: 5, source: 'work_groups' } }, f.t('demo_t001'));
  const g2beta = f.g.Db.find('groups', { assessment_id: a2.id }).find((g) => g.work_group_id === beta.id);
  assert.equal(f.g.Db.find('group_memberships', { group_id: g2beta.id, status: 'active' }).length, 4);
  // ภาพรวมของครู
  const ov = ok(f.g, 'wg.overview', { offeringId: f.offA }, f.t('demo_t001'));
  assert.equal(ov.groups.length, 2);
  assert.deepEqual(ov.ungrouped.map((u) => u.code), ['00127', '00128']);
  assert.ok(ov.groupAssessments.some((a) => a.code === 'GP2'));
  // สุ่มจัดกลุ่มคนที่เหลือ
  const auto = ok(f.g, 'wg.auto', { offeringId: f.offA, size: 2 }, f.t('demo_t001'));
  assert.deepEqual(auto, { created: 1, students: 2 });
  assert.equal(ok(f.g, 'wg.overview', { offeringId: f.offA }, f.t('demo_t001')).ungrouped.length, 0);
  // ครูนอกรายวิชาจัดกลุ่มไม่ได้
  assert.equal(call(f.g, 'wg.addMembers', { offeringId: f.offA, workGroupId: beta.id, studentIds: [f.studentId('00127')] }, f.t('demo_t003')).error.code, 'FORBIDDEN');
  // ถอนรายวิชา → ออกจากกลุ่มประจำรายวิชาอัตโนมัติ
  ok(f.g, 'offering.withdraw', { offeringId: f.offA, studentId: f.studentId('00124'), reason: 'ย้ายห้อง' }, f.t('demo_t001'));
  assert.ok(!f.g.Db.find('work_group_members', { work_group_id: beta.id, status: 'active' }).some((m) => m.student_id === f.studentId('00124')));
});

test('A20/A21 รายงานแยกตามห้องและตามกลุ่ม: ข้อมูลหน้าจอ = XLSX, รหัสเป็นข้อความ, ข้อความขึ้นต้น = ไม่เป็นสูตร', () => {
  const f = fixture();
  const t = f.t('demo_t001');
  const adm = f.admin();
  // ชื่อที่ขึ้นต้นเหมือนสูตร
  f.g.Db.tx('fixture', (tx) => tx.update('students', f.studentId('00122'), { last_name: '=HYPERLINK("http://x")' }));
  ok(f.g, 'grades.save', { assessmentId: f.W1, entries: [{ studentId: f.studentId('00121'), score: '16', status: 'scored' }, { studentId: f.studentId('00127'), status: 'missing' }] }, t);
  ok(f.g, 'grades.save', { assessmentId: f.EX1, entries: [{ studentId: f.studentId('00121'), score: '30', status: 'scored' }] }, t);
  const doc = ok(f.g, 'report.data', { kind: 'offering', offeringId: f.offA }, t);
  assert.deepEqual(doc.sections.map((s) => s.title.replace(/ \(\d+ คน\)/, '')), ['ห้อง ม.5/1', 'ห้อง ม.5/2', 'รายการประเมิน']);
  assert.equal(doc.provisional, true);
  assert.ok(doc.meta.some((m) => m[0] === 'ครูผู้สอน' && /สมศรี/.test(m[1]) && /ร่วมสอน/.test(m[1])));
  const room1 = doc.sections[0];
  const w1Col = room1.columns.findIndex((c) => c.label.startsWith('W1'));
  const r121 = room1.rows.find((r) => r[1] === '00121');
  assert.equal(r121[w1Col].v, '16');
  const totalCol = room1.columns.findIndex((c) => c.label.startsWith('คะแนนรวม'));
  assert.equal(r121[totalCol].v, '54.00', 'คะแนนสะสม 24 + 30');
  const r127 = doc.sections[1].rows.find((r) => r[1] === '00127');
  assert.equal(r127[w1Col], 'ขส');

  const x = ok(f.g, 'report.xlsx', { kind: 'offering', offeringId: f.offA }, t);
  assert.match(x.fileName, /\.xlsx$/);
  const files = unzip(Buffer.from(x.base64, 'base64'));
  assert.ok(files['[Content_Types].xml'] && files['xl/workbook.xml'] && files['xl/styles.xml']);
  const sheetNames = [...files['xl/workbook.xml'].matchAll(/<sheet name="([^"]+)"/g)].map((m) => unxml(m[1]));
  assert.deepEqual(sheetNames, ['ข้อมูลรายงาน', 'ห้อง ม.5-1', 'ห้อง ม.5-2', 'รายการประเมิน']);
  const s1 = sheetValues(files['xl/worksheets/sheet2.xml']);
  // ทุกแถวของหน้าจอ = ทุกแถวใน XLSX
  room1.rows.forEach((row, i) => {
    row.forEach((cell, j) => {
      const xc = s1[i + 1][j];
      if (cell === '' || cell === null) return;
      if (typeof cell === 'object') assert.equal(xc.n, cell.v, `แถว ${i} คอลัมน์ ${j}`);
      else assert.equal(unxml(xc.s), cell, `แถว ${i} คอลัมน์ ${j}`);
    });
  });
  assert.equal(s1.find((r) => r[1] && r[1].s === '00121')[1].s, '00121', 'รหัสศูนย์นำหน้าเป็นข้อความ');
  assert.ok(!/<f>/.test(files['xl/worksheets/sheet2.xml']), 'ไม่มีสูตรในไฟล์');
  assert.ok(files['xl/worksheets/sheet2.xml'].includes('t="inlineStr" s="1"><is><t xml:space="preserve">นางสาว ขวัญใจ =HYPERLINK(&quot;http://x&quot;)'));

  // รายงานกลุ่ม
  const gdoc = ok(f.g, 'report.data', { kind: 'groups', offeringId: f.offA }, t);
  assert.equal(gdoc.sections[0].title, 'สรุปคะแนนกลุ่มทุกงาน');
  assert.ok(gdoc.sections.some((s) => s.title.startsWith('GP1')));
  ok(f.g, 'report.xlsx', { kind: 'groups', offeringId: f.offA }, t);

  // รายงานรายห้อง (ผู้ดูแล): ทุกรายวิชาที่นักเรียนห้องนั้นเรียน
  const rdoc = ok(f.g, 'report.data', { kind: 'room', classLevel: 'ม.5', room: '1' }, adm);
  assert.equal(rdoc.sections[0].rows.length, 6);
  assert.equal(rdoc.sections[1].rows.length, 3, 'ห้อง ม.5/1 เรียน 3 รายวิชา');
  const rx = unzip(Buffer.from(ok(f.g, 'report.xlsx', { kind: 'room', classLevel: 'ม.5', room: '1' }, adm).base64, 'base64'));
  assert.ok(rx['xl/worksheets/sheet2.xml'].includes('00121'));
  // ครูเห็นเฉพาะรายวิชาที่ส่งออกได้
  const tdoc = ok(f.g, 'report.data', { kind: 'room', classLevel: 'ม.5', room: '1' }, f.t('demo_t003'));
  assert.equal(tdoc.sections[1].rows.length, 1);

  // A13/A14 สิทธิ์
  assert.equal(call(f.g, 'report.data', { kind: 'offering', offeringId: f.offA }, f.t('00121')).error.code, 'FORBIDDEN');
  assert.equal(call(f.g, 'report.xlsx', { kind: 'offering', offeringId: f.offA }, f.t('demo_t003')).error.code, 'FORBIDDEN');
  assert.equal(call(f.g, 'report.data', { kind: 'room', classLevel: 'ม.5', room: '1' }, f.t('00121')).error.code, 'FORBIDDEN');
  assert.ok(f.g.Db.all('audit_log').some((a) => a.action === 'report.export'));
});

test('ไฟล์ XLSX โครงสร้างถูกต้อง: CRC-32 ตรง ชื่อชีตไม่ซ้ำและไม่มีอักขระต้องห้าม', () => {
  const f = fixture();
  const bytes = f.g.Xlsx.build([{ name: 'a/b:c*?[x]', rows: [['x']] }, { name: 'a-b-c---x-', rows: [[1]] }, { name: 'ชื่อยาวมาก'.repeat(5), rows: [[{ v: '=1+1', s: 'header' }]] }]);
  const buf = Buffer.from(bytes);
  const nodeZlib = require('zlib');
  let p = 0;
  while (buf.readUInt32LE(p) === 0x04034b50) {
    const crc = buf.readUInt32LE(p + 14);
    const size = buf.readUInt32LE(p + 18);
    const nameLen = buf.readUInt16LE(p + 26);
    const data = buf.subarray(p + 30 + nameLen, p + 30 + nameLen + size);
    assert.equal(nodeZlib.crc32 ? nodeZlib.crc32(data) : crc, crc);
    p += 30 + nameLen + size;
  }
  const names = f.g.Xlsx.sheetNames([{ name: 'a/b:c*?[x]' }, { name: 'a-b-c---x-' }, { name: 'ชื่อยาวมาก'.repeat(5) }]);
  assert.equal(names[0], 'a-b-c---x-');
  assert.equal(names[1], 'a-b-c---x- (2)');
  assert.ok(names[2].length <= 31);
});
