import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import Grading from '../functions/src/shared/grading.js';
import { policyOf, totalFromGrades, sortAssessments } from '../functions/src/shared/gradebook.js';

test('โมดูลที่ใช้ร่วม (functions/src/shared) ตรงกับต้นฉบับ gas/*.js', () => {
  execFileSync(process.execPath, ['tools/sync-shared.mjs', '--check'], { stdio: 'pipe' });
});

test('A03/A04 คำนวณผ่านโมดูลเดียวกับรุ่น Apps Script: 72.00 และ 47.00; A18 79.995 → 80.00', () => {
  const offering = { calcMethod: 'per_item', policy: { digits: 2, bands: Grading.DEFAULT_BANDS } };
  const as = sortAssessments([
    { id: 'w', maxScore: '20', weight: '30', countsTowardGrade: true, sort: 1 },
    { id: 'g', maxScore: '20', weight: '20', countsTowardGrade: true, sort: 2 },
    { id: 'x', maxScore: '50', weight: '50', countsTowardGrade: true, sort: 3 }
  ]);
  const t = totalFromGrades(policyOf(offering), as, { w: { status: 'scored', rawScore: '16' }, g: { status: 'scored', rawScore: '18' }, x: { status: 'scored', rawScore: '30' } });
  assert.equal(t.final, '72.00');
  assert.equal(t.grade.label, '3');
  const cat = Grading.compute({
    method: 'per_category',
    categories: [{ id: 'work', weight: '60', innerMode: 'custom' }, { id: 'exam', weight: '40' }],
    items: [{ id: 'a', categoryId: 'work', max: '10', innerWeight: '1' }, { id: 'b', categoryId: 'work', max: '20', innerWeight: '3' }, { id: 'c', categoryId: 'exam', max: '50' }],
    grades: { a: { status: 'scored', score: '10' }, b: { status: 'scored', score: '0' }, c: { status: 'scored', score: '40' } }
  });
  assert.equal(cat.final, '47.00');
  const r = Grading.compute({ method: 'per_item', items: [{ id: 'a', max: '100', weight: '100' }], grades: { a: { status: 'scored', score: '79.995' } }, bands: Grading.DEFAULT_BANDS });
  assert.equal(r.final, '80.00');
  assert.equal(r.grade.label, '4');
});
