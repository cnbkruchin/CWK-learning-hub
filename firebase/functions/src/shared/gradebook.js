/**
 * การคำนวณสมุดคะแนนที่ใช้ร่วมกันระหว่าง Cloud Functions และแอป (หน้าจอ/PDF/XLSX ได้ค่าเดียวกัน)
 * ตัวคำนวณจริงคือ Grading.compute (สร้างจาก gas/Grading.js)
 */
import Grading from './grading.js';

export function policyOf(offering) {
  const p = offering && offering.policy || {};
  return {
    method: offering && offering.calcMethod || 'per_item',
    digits: p.digits === undefined || p.digits === null ? 2 : Number(p.digits),
    bands: p.bands && p.bands.length ? p.bands : Grading.DEFAULT_BANDS,
    categories: (offering && offering.categories || []).map((c) => ({ id: c.id, name: c.name, weight: c.weight, innerMode: c.innerMode || 'equal' })),
    versionNo: p.versionNo || 1
  };
}

export function sortAssessments(list) {
  return list.filter((a) => a.status !== 'archived')
    .sort((a, b) => (a.sort || 0) - (b.sort || 0) || String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
}

export function itemsOf(assessments) {
  return assessments.map((a) => ({
    id: a.id, categoryId: a.categoryId || '', max: a.maxScore || '0', weight: a.weight || '0', innerWeight: a.innerWeight || '', counts: !!a.countsTowardGrade
  }));
}

export function computeTotal(policy, items, gradeMap) {
  return Grading.compute({ method: policy.method, digits: policy.digits, bands: policy.bands, categories: policy.categories, items, grades: gradeMap });
}

/** คะแนนรวมจากเอกสารคะแนน (ครู) — grades: Map/obj ของ { status, rawScore } ต่อ assessmentId */
export function totalFromGrades(policy, assessments, gradesByAssessment) {
  const map = {};
  assessments.forEach((a) => {
    const g = gradesByAssessment[a.id];
    map[a.id] = g ? { status: g.status, score: g.status === 'scored' ? g.rawScore : '' } : { status: 'not_assessed' };
  });
  return computeTotal(policy, itemsOf(assessments), map);
}

export const weighted = Grading.weighted;
export const LABELS = Grading.LABELS;
