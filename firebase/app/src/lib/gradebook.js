/**
 * สร้างตารางคะแนนในแอป (หน้าสมุดคะแนนและรายงานใช้ชุดเดียวกัน)
 * ตัวคำนวณคะแนนรวมคือโมดูลเดียวกับ Cloud Functions (@shared/gradebook.js → Grading.compute)
 * หน้าจอ, PDF, Excel และคะแนนที่นักเรียนเห็นจึงได้ค่าเดียวกัน
 */
import { policyOf, sortAssessments, totalFromGrades } from '@shared/gradebook.js';
import { compareStudents } from '@shared/config.js';

export { policyOf, sortAssessments };

/**
 * offering, assessments[], enrollments[] (id = studentId), students{ id → นักเรียน }, grades[]
 * → { policy, assessments, rows: [{ studentId, code, name, roomLabel, rollNo, enrollmentStatus, cells{aid → {status, score, g}}, total }] }
 */
export function buildGradebook({ offering, assessments, enrollments, students, grades }) {
  const policy = policyOf(offering);
  const as = sortAssessments(assessments);
  const byStudent = {};
  grades.forEach((g) => { (byStudent[g.studentId] = byStudent[g.studentId] || {})[g.assessmentId] = g; });
  const rows = enrollments.map((e) => {
    const s = students[e.id] || {};
    const gs = byStudent[e.id] || {};
    const cells = {};
    as.forEach((a) => {
      const g = gs[a.id];
      cells[a.id] = g ? { status: g.status, score: g.status === 'scored' ? g.rawScore : '', g } : null;
    });
    return {
      studentId: e.id, code: s.code || '', name: s.name || e.name || e.id, roomLabel: s.roomLabel || '', classLevel: s.classLevel || '', room: s.room || '',
      rollNo: s.rollNo === undefined ? null : s.rollNo, enrollmentStatus: e.status, cells, total: totalFromGrades(policy, as, gs)
    };
  }).sort(compareStudents);
  return { policy, assessments: as, rows };
}

export const SHORT = { not_assessed: '-', missing: 'ขส', excused: 'ยว', needs_revision: 'รอแก้' };

export function totalText(t) {
  if (!t) return '';
  if (t.status === 'complete') return t.final + (t.grade ? ' (เกรด ' + t.grade.label + ')' : '');
  if (t.status === 'incomplete') return t.provisional + ' (ยังไม่ครบ ' + t.assessedWeightPct + '%)';
  return t.label;
}
