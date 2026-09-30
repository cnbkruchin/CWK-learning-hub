'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGas, plain } = require('./harness/load');

const g = loadGas();
const G = g.Grading;
const compute = (input) => plain(G.compute(input));

test('A03 น้ำหนักรายรายการ: 16/20 w30 + 18/20 w20 + 30/50 w50 = 72.00', () => {
  const r = compute({
    method: 'per_item',
    items: [
      { id: 'a', max: '20', weight: '30' },
      { id: 'b', max: '20', weight: '20' },
      { id: 'c', max: '50', weight: '50' }
    ],
    grades: { a: { status: 'scored', score: '16' }, b: { status: 'scored', score: '18' }, c: { status: 'scored', score: '30' } },
    bands: G.DEFAULT_BANDS
  });
  assert.equal(r.status, 'complete');
  assert.equal(r.final, '72.00');
  assert.equal(r.grade.label, '3');
});

test('A04 น้ำหนักรายหมวด: หมวดงาน 60 (A 10/10 w1, B 0/20 w3) + หมวดสอบ 40 (40/50) = 47.00', () => {
  const r = compute({
    method: 'per_category',
    categories: [{ id: 'work', weight: '60', innerMode: 'custom' }, { id: 'exam', weight: '40', innerMode: 'equal' }],
    items: [
      { id: 'A', categoryId: 'work', max: '10', innerWeight: '1' },
      { id: 'B', categoryId: 'work', max: '20', innerWeight: '3' },
      { id: 'X', categoryId: 'exam', max: '50' }
    ],
    grades: { A: { status: 'scored', score: '10' }, B: { status: 'scored', score: '0' }, X: { status: 'scored', score: '40' } }
  });
  assert.equal(r.final, '47.00');
});

test('A05 คะแนนกลุ่ม 16/20 น้ำหนัก 10 คิดน้ำหนักได้ 8.00 ต่อคน (ไม่หารจำนวนสมาชิก)', () => {
  assert.equal(G.weighted('16', '20', '10'), '8.00');
  assert.equal(G.weighted('12', '20', '10'), '6.00');
});

test('ยกเว้นหนึ่งงาน: สองงานน้ำหนัก 50 งานแรกได้ครึ่ง งานสองยกเว้น → 50.00 ไม่ใช่ 25.00', () => {
  const r = compute({
    method: 'per_item',
    items: [{ id: 'a', max: '10', weight: '50' }, { id: 'b', max: '10', weight: '50' }],
    grades: { a: { status: 'scored', score: '5' }, b: { status: 'excused' } }
  });
  assert.equal(r.status, 'complete');
  assert.equal(r.final, '50.00');
});

test('A10 ยกเว้นทั้งหมวด: ตัดหมวดแล้วปรับน้ำหนักหมวดที่เหลือ', () => {
  const r = compute({
    method: 'per_category',
    categories: [{ id: 'w', weight: '60', innerMode: 'equal' }, { id: 'e', weight: '40', innerMode: 'equal' }],
    items: [{ id: 'w1', categoryId: 'w', max: '10' }, { id: 'e1', categoryId: 'e', max: '50' }],
    grades: { w1: { status: 'excused' }, e1: { status: 'scored', score: '40' } }
  });
  assert.equal(r.final, '80.00');
});

test('A10 ยกเว้นทุกงาน: ไม่หารศูนย์ ไม่ออกเกรด แสดง "ไม่มีฐานคะแนนสำหรับสรุปผล"', () => {
  const r = compute({
    method: 'per_item',
    items: [{ id: 'a', max: '10', weight: '50' }, { id: 'b', max: '10', weight: '50' }],
    grades: { a: { status: 'excused' }, b: { status: 'excused' } },
    bands: G.DEFAULT_BANDS
  });
  assert.equal(r.status, 'no_base');
  assert.equal(r.final, null);
  assert.equal(r.grade, null);
  assert.equal(r.label, 'ไม่มีฐานคะแนนสำหรับสรุปผล');
});

test('A18 ผลสุดท้าย 79.995 ปัด half up ครั้งเดียวเป็น 80.00 และใช้ค่านี้ตัดเกรด 4', () => {
  const r = compute({
    method: 'per_item',
    items: [{ id: 'a', max: '100', weight: '100' }],
    grades: { a: { status: 'scored', score: '79.995' } },
    bands: G.DEFAULT_BANDS
  });
  assert.equal(r.final, '80.00');
  assert.equal(r.grade.label, '4');
  const r2 = compute({ method: 'per_item', items: [{ id: 'a', max: '100', weight: '100' }], grades: { a: { status: 'scored', score: '79.994' } }, bands: G.DEFAULT_BANDS });
  assert.equal(r2.final, '79.99');
  assert.equal(r2.grade.label, '3.5');
});

test('A09 ยังไม่ประเมิน/ไม่ส่ง/รอแก้ไข: ไม่แปลงเป็นศูนย์ ขวางผลสุดท้าย แสดงคะแนนสะสม "ยังไม่ครบ"', () => {
  const r = compute({
    method: 'per_item',
    items: [
      { id: 'a', max: '20', weight: '30' },
      { id: 'b', max: '20', weight: '20' },
      { id: 'c', max: '50', weight: '50' },
      { id: 'd', max: '10', weight: '0', counts: false }
    ],
    grades: { a: { status: 'scored', score: '16' }, b: { status: 'missing' }, c: { status: 'not_assessed' }, d: { status: 'scored', score: '0' } }
  });
  assert.equal(r.status, 'incomplete');
  assert.equal(r.final, null);
  assert.equal(r.provisional, '24.00');
  assert.equal(r.assessedWeightPct, '30.00');
  assert.deepEqual(r.blockers.map((b) => b.status).sort(), ['missing', 'not_assessed']);
});

test('คะแนนศูนย์ที่ยืนยันแล้วนับเป็นศูนย์จริง (ต่างจากยังไม่ประเมิน)', () => {
  const r = compute({ method: 'per_item', items: [{ id: 'a', max: '10', weight: '100' }], grades: { a: { status: 'scored', score: '0' } } });
  assert.equal(r.status, 'complete');
  assert.equal(r.final, '0.00');
});

test('น้ำหนักภายในหมวดแบบตามคะแนนเต็ม (by_max)', () => {
  const r = compute({
    method: 'per_category',
    categories: [{ id: 'w', weight: '100', innerMode: 'by_max' }],
    items: [{ id: 'a', categoryId: 'w', max: '10' }, { id: 'b', categoryId: 'w', max: '30' }],
    grades: { a: { status: 'scored', score: '10' }, b: { status: 'scored', score: '15' } }
  });
  assert.equal(r.final, '62.50');
});

test('ตรวจแผนคะแนน: น้ำหนักไม่ครบ 100 และคะแนนเต็มศูนย์ต้องแจ้งตำแหน่ง ไม่ปรับเงียบ ๆ', () => {
  const errs = plain(G.validatePlan('per_item', [], [
    { id: 'a', max: '20', weight: '30' },
    { id: 'b', max: '0', weight: '20' },
    { id: 'c', max: '10', weight: '0', counts: false }
  ]));
  assert.ok(errs.some((e) => e.itemId === 'b'));
  assert.ok(errs.some((e) => /ต้องเท่ากับ 100/.test(e.message)));
  assert.deepEqual(plain(G.validatePlan('per_item', [], [{ id: 'a', max: '20', weight: '100' }])), []);
  const cat = plain(G.validatePlan('per_category', [{ id: 'x', weight: '60' }, { id: 'y', weight: '30' }], [{ id: 'a', categoryId: 'x', max: '10' }]));
  assert.ok(cat.some((e) => /หมวดรวม 90\.00/.test(e.message)));
});

test('ช่วงเกรดเริ่มต้นต่อเนื่อง 0–100', () => {
  assert.deepEqual(plain(G.validateBands(G.DEFAULT_BANDS)), []);
  assert.equal(G.bandFor(G.DEFAULT_BANDS, '100.00').label, '4');
  assert.equal(G.bandFor(G.DEFAULT_BANDS, '49.99').label, '0');
  assert.equal(G.bandFor(G.DEFAULT_BANDS, '50.00').label, '1');
});

test('Dec: เก็บทศนิยมเป็นข้อความ ไม่มีปัญหา float', () => {
  assert.equal(g.Dec.normalize('016.50'), '16.5');
  assert.equal(g.Dec.normalize(0.1 + 0.2), '0.3');
  const R = g.Dec.R;
  assert.equal(R.toFixed(R.add(R.of('0.1'), R.of('0.2')), 2), '0.30');
  assert.throws(() => g.Dec.normalize('1e5'));
  assert.throws(() => g.Dec.normalize('abc'));
});
