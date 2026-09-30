'use strict';
const { bootDemo, ok, login } = require('./load');

/**
 * ข้อมูลสาธิต: รายวิชา A = ว32201 ม.5/1 (ครู T001 เจ้าของ, T002 ร่วมสอน) นักเรียน 00121–00128
 *              รายวิชา B = ว32281 ม.5/2 (T002) นักเรียน 00125–00132
 *              รายวิชา C = ค32101 ม.5/1 (T003) นักเรียนทุกคน
 * งานในรายวิชา A: W1 งานเดี่ยว, G1 งานกลุ่ม 2–3 คน, EX1 สอบ (รับคะแนนอย่างเดียว)
 */
function fixture(opts) {
  const env = bootDemo(opts);
  const { g, accounts } = env;
  const tok = {};
  const t = (u) => (tok[u] = tok[u] || login(g, accounts, u));
  const courses = ok(g, 'student.courses', {}, t('00121'));
  const offA = courses.find((c) => c.courseCode === 'ว32201').offeringId;
  const items = ok(g, 'student.assessments', { offeringId: offA }, t('00121'));
  const id = (code) => items.find((a) => a.code === code).id;
  const studentId = (code) => g.Db.one('students', { student_code: code }).id;
  /** แก้ข้อมูลภาระงานโดยตรง (ใช้จำลองเวลา) */
  const patchAssessment = (code, patch) => g.Db.tx('fixture', (tx) => tx.update('assessments', id(code), patch));
  const iso = (days) => new Date(Date.now() + days * 86400000).toISOString();
  return Object.assign(env, { t, offA, W1: id('W1'), G1: id('G1'), EX1: id('EX1'), studentId, patchAssessment, iso });
}

let keySeq = 0;
const idemKey = () => 'test-key-' + Date.now() + '-' + (++keySeq) + '-abcdef';

module.exports = { fixture, idemKey };
