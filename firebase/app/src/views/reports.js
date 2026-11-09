/**
 * รายงาน (แยกตามห้อง / แยกตามกลุ่ม / สรุปรายห้องทุกรายวิชา) ส่งออก Excel (.xlsx) และ PDF
 *
 * ทุกรูปแบบสร้างจาก "เอกสารรายงาน" ชุดเดียวกัน (โครงสร้างเดียวกับรุ่น Apps Script) คำนวณด้วยโมดูลเดียวกับเซิร์ฟเวอร์
 * หน้าจอ PDF และ Excel จึงแสดงคะแนน เกรด สถานะ รหัส และรายชื่อตรงกัน
 *   เอกสาร: { kind, title, meta: [[หัวข้อ, ค่า]], provisional, sections: [{ title, sheetName, columns, rows }], legend, notes }
 *   cell = 'ข้อความ' | { v: '16.5', t: 'n' }
 * - Excel: สร้างไฟล์ในเครื่องด้วย @shared/xlsx.js (ไม่มีสูตร รหัส 00123 ไม่หาย)
 * - PDF: แปลงหน้ารายงานเป็นภาพความละเอียดสูงแล้วจัดหน้า A4 (ภาษาไทยแสดงถูกต้องทุกเครื่อง ใช้ได้ในแอป iOS/Android)
 * สิทธิ์: Security Rules ให้ครูอ่านเฉพาะรายวิชาของตน ผู้ดูแลอ่านได้ทั้งโรงเรียน
 */
import { collection, doc, query, where } from 'firebase/firestore';
import { views, go } from '../lib/router.js';
import { db, fetchAll, fetchOne } from '../lib/fb.js';
import { h, q, qa, on, esc, toast, errBox, backBtn, bindBack, fmtDate } from '../lib/ui.js';
import { saveFile, isNative } from '../lib/save.js';
import { session, hasRole, schoolId } from '../lib/session.js';
import { offeringHeader, bindOfferingHeader, loadStudents } from './teacher.js';
import { buildGradebook, sortAssessments, policyOf } from '../lib/gradebook.js';
import Xlsx from '@shared/xlsx.js';

const SHORT = { not_assessed: '-', missing: 'ขส', excused: 'ยว', needs_revision: 'รอแก้' };
const LEGEND = ['ขส = ยังไม่ส่งงาน/ขาดสอบ', 'ยว = ได้รับการยกเว้น (ตัดออกจากฐานคะแนนของคนนั้น)', 'รอแก้ = รอแก้ไขงาน', '- = ยังไม่ประเมิน (ไม่ใช่ศูนย์)'];
const KIND = { individual: 'งานเดี่ยว', group: 'งานกลุ่ม', exam: 'สอบ', score_only: 'รับคะแนนอย่างเดียว' };
const num = (v) => v === null || v === undefined || v === '' ? '' : { v: String(v), t: 'n' };
const scoreCell = (c) => !c ? '-' : c.status === 'scored' ? num(c.score) : SHORT[c.status] || '-';
const totalCells = (t) => t.status === 'complete' ? [num(t.final), 'ครบ', t.grade ? t.grade.label : ''] : t.status === 'incomplete' ? [num(t.provisional), 'ยังไม่ครบ (ตรวจแล้ว ' + t.assessedWeightPct + '%)', ''] : ['', t.label, ''];
const thSort = (a, b) => String(a).localeCompare(String(b), 'th', { numeric: true });

function base(kind, title) {
  const now = new Date().toISOString();
  const s = session.school || {};
  return {
    kind, title, school: s.nameTh || '', appName: (s.settings && s.settings.appName) || s.appName || 'CWK Learning Hub', issuedAt: now, issuedAtText: fmtDate(now),
    issuedBy: session.profile ? session.profile.displayName : '', meta: [['โรงเรียน', s.nameTh || '']], sections: [], legend: LEGEND.slice(), notes: []
  };
}

async function offeringBundle(oid, withGroups) {
  const b = (name) => collection(db, 'offerings', oid, name);
  const [off, as, enrs, grades, staff, extra] = await Promise.all([
    fetchOne(doc(db, 'offerings', oid)), fetchAll(b('assessments')), fetchAll(b('enrollments')), fetchAll(b('grades')), fetchAll(b('staff')).catch(() => []),
    withGroups ? Promise.all([fetchAll(b('groups')), fetchAll(b('groupGrades')), fetchAll(b('workGroups')), fetchAll(b('roster'))]) : Promise.resolve(null)
  ]);
  if (!off) throw new Error('ไม่พบรายวิชา');
  const students = await loadStudents(enrs.map((e) => e.id));
  return { off, as, enrs, grades, staff, students, groups: extra && extra[0], ggs: extra && extra[1], wgs: extra && extra[2], roster: extra && extra[3] };
}

function offeringMeta(d, o, staff, policy) {
  const teachers = staff.filter((s) => s.active).sort((a, b) => (a.role === 'owner' ? -1 : 1) - (b.role === 'owner' ? -1 : 1)).map((s) => s.name + (s.role === 'owner' ? '' : ' (ร่วมสอน)'));
  d.meta.push(['รายวิชา', o.courseCode + ' ' + o.courseName], ['ปีการศึกษา / ภาคเรียน', o.yearBe + ' / ' + o.termNo], ['กลุ่มเรียน', o.section], ['ครูผู้สอน', (teachers.length ? teachers : [o.ownerName]).join(', ')]);
  if (policy) d.meta.push(['วิธีคำนวณ', policy.method === 'per_category' ? 'น้ำหนักรายหมวด' : 'น้ำหนักรายรายการ'], ['การปัดเศษ', 'ปัดครั้งเดียวตอนสรุป ' + policy.digits + ' ตำแหน่ง (half up)'], ['รุ่นนโยบายคะแนน', String(policy.versionNo || 1)]);
  d.provisional = o.status !== 'closed';
  d.meta.push(['สถานะรายงาน', d.provisional ? 'รายงานชั่วคราว (ยังไม่ปิดผลรายวิชา)' : 'ผลหลังปิดรายวิชา'], ['วันที่ออกรายงาน', d.issuedAtText]);
  d.fileBase = [o.courseCode, o.section, o.yearBe + '-' + o.termNo].join('_');
  d.courseLine = o.courseCode + ' ' + o.courseName + ' · กลุ่มเรียน ' + o.section + ' · ปี ' + o.yearBe + ' ภาค ' + o.termNo;
}
const aHeader = (a) => a.code + ' (เต็ม ' + a.maxScore + (a.countsTowardGrade ? ' / น้ำหนัก ' + a.weight : ' / ไม่นับคะแนน') + ')';

// ---------------------------------------------------------------- สมุดคะแนนรายวิชา (แยกตามห้อง หรือรวม)
export async function offeringReport(oid, groupBy) {
  const x = await offeringBundle(oid, false);
  const gb = buildGradebook({ offering: x.off, assessments: x.as, enrollments: x.enrs, students: x.students, grades: x.grades });
  const d = base('offering', groupBy === 'all' ? 'สมุดคะแนนรายวิชา' : 'สมุดคะแนนรายวิชา แยกตามห้อง');
  offeringMeta(d, x.off, x.staff, gb.policy);
  d.fileBase = 'สมุดคะแนน_' + d.fileBase;
  const columns = [{ label: 'ที่' }, { label: 'รหัสนักเรียน' }, { label: 'ชื่อ - สกุล' }, { label: 'ห้อง' }, { label: 'เลขที่' }]
    .concat(gb.assessments.map((a) => ({ label: aHeader(a), kind: 'num' })))
    .concat([{ label: 'คะแนนรวม (100)', kind: 'num' }, { label: 'สถานะ' }, { label: 'เกรด' }]);
  const rowOf = (r, i) => [String(i + 1), r.code, r.name, r.roomLabel, r.rollNo === null || r.rollNo === '' ? '' : String(r.rollNo)]
    .concat(gb.assessments.map((a) => scoreCell(r.cells[a.id]))).concat(totalCells(r.total));
  const active = gb.rows.filter((r) => r.enrollmentStatus === 'active');
  const left = gb.rows.filter((r) => r.enrollmentStatus !== 'active');
  const buckets = [];
  if (groupBy === 'all') buckets.push({ title: 'นักเรียนทั้งหมด (' + active.length + ' คน)', sheetName: 'คะแนน', rows: active });
  else {
    const byRoom = {};
    active.forEach((r) => { (byRoom[r.roomLabel] = byRoom[r.roomLabel] || []).push(r); });
    Object.keys(byRoom).sort(thSort).forEach((k) => buckets.push({ title: 'ห้อง ' + k + ' (' + byRoom[k].length + ' คน)', sheetName: 'ห้อง ' + k, rows: byRoom[k] }));
  }
  if (left.length) buckets.push({ title: 'ถอน/ย้ายออกจากรายวิชา (' + left.length + ' คน)', sheetName: 'ถอน-ย้ายออก', rows: left });
  buckets.forEach((bk) => d.sections.push({ title: bk.title, sheetName: bk.sheetName, columns, rows: bk.rows.map(rowOf) }));
  if (!buckets.length) d.sections.push({ title: 'ยังไม่มีนักเรียนในรายวิชา', sheetName: 'คะแนน', columns, rows: [] });
  d.sections.push({
    title: 'รายการประเมิน', sheetName: 'รายการประเมิน',
    columns: [{ label: 'รหัส' }, { label: 'ชื่อรายการ' }, { label: 'ประเภท' }, { label: 'คะแนนเต็ม', kind: 'num' }, { label: 'น้ำหนักในรายวิชา', kind: 'num' }, { label: 'นับคะแนน' }],
    rows: gb.assessments.map((a) => [a.code, a.title, KIND[a.kind], num(a.maxScore), num(a.weight), a.countsTowardGrade ? 'นับ' : 'ไม่นับ'])
  });
  d.notes.push('คะแนนรวมคำนวณ: Σ(น้ำหนัก × คะแนน/คะแนนเต็ม) ÷ Σ(น้ำหนักที่นับ) × 100',
    'คะแนนเต็มกับน้ำหนักเป็นคนละค่า งานที่ได้รับการยกเว้นถูกตัดออกจากฐานคะแนนของคนนั้น',
    '"ยังไม่ครบ" = มีรายการที่ยังไม่ประเมิน คะแนนรวมเป็นคะแนนสะสมบนฐาน 100 ยังไม่ใช่ผลสุดท้ายและไม่ออกเกรด',
    'เกณฑ์เกรด: ' + gb.policy.bands.map((b) => b.label + ' = ' + b.min + '–' + b.max).join(', ') + ' (ตัวอย่างค่าเริ่มต้น ไม่ใช่ระเบียบของโรงเรียนจนกว่าจะยืนยัน)',
    'งานกลุ่ม: คะแนนกลุ่มของแต่ละงานเก็บที่กลุ่ม และบันทึกเป็นคะแนนรายบุคคลของสมาชิกโดยอัตโนมัติ (ไม่หารด้วยจำนวนสมาชิก)',
    'รายงานรวมคะแนนที่บันทึกแล้วทั้งหมด รวมถึงคะแนนที่ยังไม่ประกาศให้นักเรียนเห็น');
  d.orientation = columns.length > 9 ? 'landscape' : 'portrait';
  return d;
}

// ---------------------------------------------------------------- ผลประเมินงานกลุ่ม แยกตามกลุ่ม
export async function groupsReport(oid) {
  const x = await offeringBundle(oid, true);
  const d = base('groups', 'ผลประเมินงานกลุ่ม แยกตามกลุ่ม');
  offeringMeta(d, x.off, x.staff, policyOf(x.off));
  d.fileBase = 'คะแนนกลุ่ม_' + d.fileBase;
  const names = Object.fromEntries(x.roster.map((r) => [r.id, r]));
  const gradeMap = Object.fromEntries(x.grades.map((g) => [g.assessmentId + '_' + g.studentId, g]));
  const groupAs = sortAssessments(x.as).filter((a) => a.kind === 'group');
  const ggOf = (aid, gid) => x.ggs.find((g) => g.assessmentId === aid && g.groupId === gid) || null;
  const ggCell = (gg) => !gg ? '' : gg.status === 'scored' ? num(gg.rawScore) : SHORT[gg.status] || '-';
  const nameOf = (sid) => (names[sid] || {}).name || (x.students[sid] || {}).name || sid;
  const sheets = groupAs.map((a) => ({ a, groups: x.groups.filter((g) => g.assessmentId === a.id && (g.status !== 'disbanded' || g.frozen)).sort((p, q2) => thSort(p.name, q2.name)) }));
  const wgs = x.wgs.filter((w) => w.status === 'active').sort((p, q2) => thSort(p.name, q2.name));
  const summary = wgs.map((w) => [w.name, 'กลุ่มประจำรายวิชา', (w.memberIds || []).map((sid) => nameOf(sid) + (sid === w.leaderStudentId ? ' (หัวหน้า)' : '')).join(', ')]
    .concat(sheets.map((s) => { const g = s.groups.find((y) => y.workGroupId === w.id); return g ? ggCell(ggOf(s.a.id, g.id)) : ''; })));
  sheets.forEach((s, idx) => s.groups.filter((g) => !wgs.some((w) => w.id === g.workGroupId)).forEach((g) => {
    summary.push([g.name, 'กลุ่มเดิมของงาน ' + s.a.code, (g.memberIds || []).map((sid) => nameOf(sid) + (sid === g.leaderStudentId ? ' (หัวหน้า)' : '')).join(', ')].concat(sheets.map((y, j) => j === idx ? ggCell(ggOf(s.a.id, g.id)) : '')));
  }));
  d.sections.push({ title: 'สรุปคะแนนกลุ่มทุกงาน', sheetName: 'สรุปคะแนนกลุ่ม', columns: [{ label: 'กลุ่ม' }, { label: 'ประเภทกลุ่ม' }, { label: 'สมาชิก' }].concat(sheets.map((s) => ({ label: s.a.code + ' (เต็ม ' + s.a.maxScore + ')', kind: 'num' }))), rows: summary });
  sheets.forEach((s) => {
    const rows = [];
    const inGroup = new Set();
    s.groups.forEach((g) => {
      const gg = ggOf(s.a.id, g.id);
      (g.memberIds || []).forEach((sid, i) => {
        inGroup.add(sid);
        const gr = gradeMap[s.a.id + '_' + sid];
        const st = names[sid] && !names[sid].active ? 'ไม่ได้ลงทะเบียนแล้ว' : gr && gr.isOverride ? 'ปรับรายคน: ' + (gr.overrideReason || '') : gg && (!gr || gr.groupGradeId !== gg.id) ? 'ยังไม่ได้รับคะแนนกลุ่มล่าสุด' : '';
        rows.push([i === 0 ? g.name : '', i === 0 ? ggCell(gg) : '', (x.students[sid] || {}).code || '', nameOf(sid) + (sid === g.leaderStudentId ? ' (หัวหน้า)' : ''), (names[sid] || {}).roomLabel || '', scoreCell(gr ? { status: gr.status, score: gr.rawScore } : null), st]);
      });
      if (!(g.memberIds || []).length) rows.push([g.name, ggCell(gg), '', '(ไม่มีสมาชิก)', '', '', '']);
    });
    x.roster.filter((r) => r.active && !inGroup.has(r.id)).forEach((r) => {
      const gr = gradeMap[s.a.id + '_' + r.id];
      rows.push(['(ไม่มีกลุ่ม)', '', (x.students[r.id] || {}).code || '', r.name, r.roomLabel, scoreCell(gr ? { status: gr.status, score: gr.rawScore } : null), 'ยังไม่มีกลุ่มในงานนี้']);
    });
    d.sections.push({
      title: s.a.code + ' ' + s.a.title + ' — คะแนนเต็ม ' + s.a.maxScore + ' น้ำหนัก ' + (s.a.weight || 0), sheetName: s.a.code + ' สมาชิก',
      columns: [{ label: 'กลุ่ม' }, { label: 'คะแนนกลุ่ม', kind: 'num' }, { label: 'รหัสนักเรียน' }, { label: 'ชื่อ - สกุล' }, { label: 'ห้อง' }, { label: 'คะแนนรายบุคคล', kind: 'num' }, { label: 'หมายเหตุ' }], rows
    });
  });
  if (!groupAs.length) d.notes.push('รายวิชานี้ยังไม่มีงานกลุ่ม');
  d.notes.push('คะแนนกลุ่มของแต่ละงานเก็บที่กลุ่มของงานนั้น ระบบบันทึกเป็นคะแนนรายบุคคลของสมาชิกที่ตรึงรายชื่อไว้ทุกคน (ไม่หารด้วยจำนวนสมาชิก)',
    'สมาชิกที่ครูปรับคะแนนรายคนจะคงคะแนนที่ปรับไว้ แม้แก้คะแนนกลุ่มภายหลัง จนกว่าครูจะยกเลิกการปรับ');
  d.orientation = 'landscape';
  return d;
}

// ---------------------------------------------------------------- สรุปคะแนนรายห้อง (ทุกรายวิชาที่มีสิทธิ์)
async function canExport(o) {
  if (hasRole('admin')) return true;
  if (!hasRole('teacher')) return false;
  const s = await fetchOne(doc(db, 'offerings', o.id, 'staff', session.user.uid)).catch(() => null);
  return !!(s && s.active && (s.role === 'owner' || (s.perms && s.perms.can_export)));
}

export async function roomReport(classLevel, room, termId) {
  const sch = schoolId();
  const all = await fetchAll(query(collection(db, 'students'), where('schoolId', '==', sch), where('status', '==', 'active')));
  let students = all.filter((s) => String(s.classLevel || '') === classLevel && String(s.room || '') === room).sort((a, b) => (Number(a.rollNo || 0) - Number(b.rollNo || 0)) || thSort(a.code, b.code));
  const ids = new Set(students.map((s) => s.id));
  const label = students[0] ? students[0].roomLabel : classLevel + (room ? '/' + room : '');
  const d = base('room', 'สรุปคะแนนรายห้อง ' + label);
  const wide = hasRole('admin') || hasRole('grade_admin');
  const offs = (await fetchAll(wide ? query(collection(db, 'offerings'), where('schoolId', '==', sch)) : query(collection(db, 'offerings'), where('schoolId', '==', sch), where('staffUids', 'array-contains', session.user.uid))))
    .filter((o) => o.status !== 'archived' && (!termId || o.termId === termId));
  const results = [];
  for (const o of offs) {
    if (!(await canExport(o))) continue;
    const enrs = (await fetchAll(collection(db, 'offerings', o.id, 'enrollments'))).filter((e) => e.status === 'active' && ids.has(e.id));
    if (!enrs.length) continue;
    const [as, grades] = await Promise.all([fetchAll(collection(db, 'offerings', o.id, 'assessments')), fetchAll(collection(db, 'offerings', o.id, 'grades'))]);
    const sMap = Object.fromEntries(students.map((s) => [s.id, s]));
    const gb = buildGradebook({ offering: o, assessments: as, enrollments: enrs, students: sMap, grades: grades.filter((g) => ids.has(g.studentId)) });
    results.push({ o, label: o.courseCode + ' ' + o.courseName + ' (' + o.section + ', ' + o.yearBe + '/' + o.termNo + ')', by: Object.fromEntries(gb.rows.map((r) => [r.studentId, r])) });
  }
  results.sort((a, b) => thSort(a.label, b.label));
  if (!hasRole('admin')) students = students.filter((s) => results.some((r) => r.by[s.id]));
  const term = termId ? await fetchOne(doc(db, 'terms', termId)).catch(() => null) : null;
  d.meta.push(['ห้องเรียน', label], ['ภาคเรียน', term ? term.label : 'ทุกภาคเรียนที่ยังไม่เก็บถาวร'], ['จำนวนนักเรียน', students.length + ' คน'], ['จำนวนรายวิชา', results.length + ' รายวิชา']);
  d.provisional = results.some((r) => r.o.status !== 'closed');
  d.meta.push(['สถานะรายงาน', d.provisional ? 'รายงานชั่วคราว (มีรายวิชาที่ยังไม่ปิดผล)' : 'ผลหลังปิดรายวิชา'], ['วันที่ออกรายงาน', d.issuedAtText]);
  const columns = [{ label: 'ที่' }, { label: 'รหัสนักเรียน' }, { label: 'ชื่อ - สกุล' }, { label: 'เลขที่' }];
  results.forEach((r) => columns.push({ label: r.label + ' คะแนน', kind: 'num' }, { label: 'เกรด' }));
  d.sections.push({
    title: 'ห้อง ' + label, sheetName: 'ห้อง ' + label, columns,
    rows: students.map((s, i) => {
      const row = [String(i + 1), s.code, s.name, s.rollNo === null || s.rollNo === undefined ? '' : String(s.rollNo)];
      results.forEach((r) => {
        const x = r.by[s.id];
        if (!x) { row.push('', 'ไม่ได้เรียน'); return; }
        const t = x.total;
        if (t.status === 'complete') row.push(num(t.final), t.grade ? t.grade.label : '');
        else if (t.status === 'incomplete') row.push(num(t.provisional), 'ยังไม่ครบ');
        else row.push('', 'ไม่มีฐานคะแนน');
      });
      return row;
    })
  });
  d.sections.push({ title: 'รายวิชาในรายงาน', sheetName: 'รายวิชา', columns: [{ label: 'รายวิชา' }, { label: 'ครูเจ้าของรายวิชา' }, { label: 'สถานะ' }], rows: results.map((r) => [r.label, r.o.ownerName, r.o.status === 'closed' ? 'ปิดผลแล้ว' : 'ยังไม่ปิดผล (ชั่วคราว)']) });
  d.legend = ['"ยังไม่ครบ" = คะแนนสะสมบนฐาน 100 จากรายการที่ประเมินแล้ว ยังไม่ออกเกรด', '"ไม่ได้เรียน" = ไม่ได้ลงทะเบียนในรายวิชานั้น'];
  d.notes.push('คะแนนแต่ละรายวิชาคำนวณด้วยแผนคะแนนของรายวิชานั้น (โมดูลคำนวณเดียวกับสมุดคะแนน)');
  if (!hasRole('admin')) d.notes.push('ครูเห็นเฉพาะรายวิชาที่ตนมีสิทธิ์ส่งออก และนักเรียนที่เรียนรายวิชาเหล่านั้น');
  d.fileBase = 'สรุปรายห้อง_' + label.replace(/\//g, '-') + (term ? '_' + term.yearBe + '-' + term.termNo : '');
  d.orientation = columns.length > 8 ? 'landscape' : 'portrait';
  return d;
}

// ---------------------------------------------------------------- แปลงเป็น Excel
export function toSheets(d) {
  const info = [[{ v: d.title, s: 'title' }], []];
  d.meta.forEach((m) => info.push([{ v: m[0], s: 'bold' }, m[1]]));
  info.push(['ออกโดย', d.issuedBy + ' (' + d.appName + ')']);
  if (d.legend && d.legend.length) { info.push([], [{ v: 'ความหมายสัญลักษณ์', s: 'bold' }]); d.legend.forEach((l) => info.push([l])); }
  if (d.notes && d.notes.length) { info.push([], [{ v: 'คำอธิบายเกณฑ์', s: 'bold' }]); d.notes.forEach((n) => info.push([n])); }
  const sheets = [{ name: 'ข้อมูลรายงาน', rows: info, widths: [26, 90] }];
  d.sections.forEach((sec) => {
    const header = sec.columns.map((c) => ({ v: c.label, s: 'header' }));
    const widths = sec.columns.map((c, i) => {
      let max = String(c.label).length;
      sec.rows.forEach((r) => { const v = r[i]; const s = v && typeof v === 'object' ? String(v.v) : String(v === undefined || v === null ? '' : v); max = Math.max(max, s.length); });
      return Math.min(Math.max(6, Math.round(max * 1.1) + 2), 48);
    });
    sheets.push({ name: sec.sheetName || sec.title, rows: [header].concat(sec.rows), widths, freezeRows: 1 });
  });
  return sheets;
}

export function xlsxBlob(d) {
  const bytes = Xlsx.build(toSheets(d), { title: d.title, created: d.issuedAt });
  return new Blob([new Uint8Array(bytes)], { type: Xlsx.MIME });
}

// ---------------------------------------------------------------- หน้ารายงาน (HTML) + PDF
const cellHtml = (c, col) => {
  const isNum = c && typeof c === 'object';
  return '<td class="' + (isNum || (col && col.kind === 'num') ? 'num' : '') + '">' + esc(isNum ? c.v : c) + '</td>';
};
const tableHtml = (sec, rows) => '<table><thead><tr>' + sec.columns.map((c) => '<th>' + esc(c.label) + '</th>').join('') + '</tr></thead><tbody>' +
  (rows.length ? rows.map((r) => '<tr>' + r.map((c, i) => cellHtml(c, sec.columns[i])).join('') + '</tr>').join('') : '<tr><td colspan="' + sec.columns.length + '" class="muted">ไม่มีข้อมูล</td></tr>') + '</tbody></table>';
const headHtml = (d) => '<div class="r-school">' + esc(d.school) + '</div><h1>' + esc(d.title) + '</h1>' + (d.courseLine ? '<div class="r-course">' + esc(d.courseLine) + '</div>' : '') +
  (d.provisional ? '<div class="r-provisional">รายงานชั่วคราว — ยังไม่ใช่ผลการเรียนสุดท้าย</div>' : '') +
  '<div class="r-meta">' + d.meta.map((m) => '<div><b>' + esc(m[0]) + ':</b> ' + esc(m[1]) + '</div>').join('') + '</div>';
const notesHtml = (d) => '<div class="r-notes">' + (d.legend && d.legend.length ? '<p><b>ความหมายสัญลักษณ์:</b> ' + d.legend.map(esc).join(' · ') + '</p>' : '') +
  (d.notes.length ? '<ul>' + d.notes.map((n) => '<li>' + esc(n) + '</li>').join('') + '</ul>' : '') + '<p class="small">ออกโดย ' + esc(d.issuedBy) + ' · ' + esc(d.appName) + ' · ' + esc(d.issuedAtText) + '</p></div>' +
  '<div class="r-sign"><div>ลงชื่อ ....................................<br>ครูผู้สอน</div><div>ลงชื่อ ....................................<br>หัวหน้ากลุ่มสาระ / ฝ่ายวิชาการ</div></div>';

export function reportHtml(d) {
  return '<div class="report-page" id="report">' + headHtml(d) + d.sections.map((sec) => '<h2>' + esc(sec.title) + '</h2><div class="table-wrap">' + tableHtml(sec, sec.rows) + '</div>').join('') + notesHtml(d) + '</div>';
}

/** PDF: แบ่งตารางเป็นช่วงละไม่เกิน ROWS แถว (มีหัวตารางทุกช่วง) แปลงเป็นภาพทีละช่วงแล้ววางบนหน้า A4 */
export async function pdfBlob(d, onProgress) {
  const [{ toCanvas, getFontEmbedCSS }, { jsPDF }] = await Promise.all([import('html-to-image'), import('jspdf')]);
  const land = d.orientation === 'landscape';
  const ROWS = land ? 22 : 30;
  const host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = 'position:absolute;left:-30000px;top:0;width:' + (land ? 1120 : 790) + 'px;background:#fff';
  const blocks = ['<div class="report-page" style="border:0;padding:0">' + headHtml(d) + '</div>'];
  d.sections.forEach((sec) => {
    const chunks = [];
    for (let i = 0; i < Math.max(sec.rows.length, 1); i += ROWS) chunks.push(sec.rows.slice(i, i + ROWS));
    chunks.forEach((rows, i) => blocks.push('<div class="report-page" style="border:0;padding:0">' + (i === 0 ? '<h2 style="margin-top:4px">' + esc(sec.title) + '</h2>' : '<h2 style="margin-top:4px;font-size:.9rem">' + esc(sec.title) + ' (ต่อ)</h2>') + tableHtml(sec, rows) + '</div>'));
  });
  blocks.push('<div class="report-page" style="border:0;padding:0">' + notesHtml(d) + '</div>');
  host.innerHTML = blocks.map((b) => '<div data-pdf-block style="background:#fff;padding:2px 0">' + b + '</div>').join('');
  document.body.appendChild(host);
  try {
    const pdf = new jsPDF({ orientation: land ? 'l' : 'p', unit: 'mm', format: 'a4', compress: true });
    const pw = pdf.internal.pageSize.getWidth(), ph = pdf.internal.pageSize.getHeight(), m = 10, wmm = pw - 2 * m;
    let fontEmbedCSS;
    try { fontEmbedCSS = await getFontEmbedCSS(host); } catch (e) { fontEmbedCSS = undefined; }
    const els = qa('[data-pdf-block]', host);
    let y = m;
    for (let i = 0; i < els.length; i++) {
      const el = els[i];
      const opts = { pixelRatio: 2, backgroundColor: '#ffffff', width: Math.max(el.scrollWidth, el.offsetWidth), height: el.scrollHeight, cacheBust: false };
      let canvas;
      try { canvas = await toCanvas(el, Object.assign({ fontEmbedCSS }, opts)); } catch (e) { canvas = await toCanvas(el, Object.assign({ skipFonts: true }, opts)); }
      const scale = wmm / canvas.width;
      const hmm = canvas.height * scale;
      if (y + hmm > ph - m && y > m) { pdf.addPage(); y = m; }
      if (hmm <= ph - 2 * m) {
        pdf.addImage(canvas.toDataURL('image/jpeg', 0.9), 'JPEG', m, y, wmm, hmm);
        y += hmm + 2;
      } else {
        // ภาพสูงกว่าหนึ่งหน้า (ตารางกว้างมาก): ตัดเป็นช่วง ๆ
        let sy = 0;
        while (sy < canvas.height) {
          const slice = Math.min(canvas.height - sy, Math.floor((ph - m - y) / scale));
          const c = document.createElement('canvas'); c.width = canvas.width; c.height = slice;
          c.getContext('2d').drawImage(canvas, 0, sy, canvas.width, slice, 0, 0, canvas.width, slice);
          pdf.addImage(c.toDataURL('image/jpeg', 0.9), 'JPEG', m, y, wmm, slice * scale);
          sy += slice; y += slice * scale + 2;
          if (sy < canvas.height) { pdf.addPage(); y = m; }
        }
      }
      if (onProgress) onProgress((i + 1) / els.length);
    }
    const n = pdf.getNumberOfPages();
    for (let i = 1; i <= n; i++) { pdf.setPage(i); pdf.setFontSize(8); pdf.setTextColor(120); pdf.text(i + ' / ' + n, pw - m, ph - 4, { align: 'right' }); }
    return pdf.output('blob');
  } finally { host.remove(); }
}

const fileName = (d, ext) => (d.fileBase || 'report').replace(/[\\/:*?"<>|\s]+/g, '_') + '.' + ext;

views.reportView = async (p) => {
  h(backBtn() + '<div class="no-print" id="rv-bar"></div><div id="rv"><div class="loading">กำลังสร้างรายงาน…</div></div>');
  bindBack();
  let d;
  try {
    d = p.kind === 'groups' ? await groupsReport(p.offeringId) : p.kind === 'room' ? await roomReport(p.classLevel || '', p.room || '', p.termId || '') : await offeringReport(p.offeringId, p.groupBy);
  } catch (err) { q('#rv').innerHTML = errBox(err); return; }
  if (!q('#rv')) return;
  q('#rv-bar').innerHTML = '<p><button class="btn" id="rv-xlsx">⬇ Excel (.xlsx)</button> <button class="btn" id="rv-pdf">⬇ PDF</button> ' + (isNative() ? '' : '<button class="btn ghost" id="rv-print">พิมพ์</button> ') +
    '<button class="btn ghost" id="rv-refresh">รีเฟรชข้อมูลล่าสุด</button></p><p class="small muted">' + (isNative() ? 'แอปจะเปิดหน้าแชร์ให้เลือกบันทึกลง "ไฟล์" หรือเปิดด้วยแอปอื่น' : 'PDF ใช้ได้ทุกเบราว์เซอร์และมือถือ · "พิมพ์" ใช้เครื่องพิมพ์หรือบันทึกเป็น PDF ของเบราว์เซอร์') + '</p>';
  q('#rv').innerHTML = reportHtml(d);
  q('#rv-xlsx').addEventListener('click', () => saveFile(fileName(d, 'xlsx'), Xlsx.MIME, xlsxBlob(d)).catch((e) => toast(e.message)));
  q('#rv-pdf').addEventListener('click', async (e) => {
    const btn = e.currentTarget; btn.disabled = true;
    try { const blob = await pdfBlob(d, (f) => { btn.textContent = 'กำลังสร้าง PDF… ' + Math.round(f * 100) + '%'; }); await saveFile(fileName(d, 'pdf'), 'application/pdf', blob); }
    catch (err) { toast('สร้าง PDF ไม่สำเร็จ: ' + (err && err.message || err)); }
    finally { btn.disabled = false; btn.textContent = '⬇ PDF'; }
  });
  on('#rv-print', 'click', () => window.print());
  q('#rv-refresh').addEventListener('click', () => views.reportView(p));
};

// ---------------------------------------------------------------- แท็บรายงานของรายวิชา
views.offeringReports = (p) => {
  h(offeringHeader(p, 'offeringReports') + '<div class="grid">' +
    [['offering', 'room', 'สมุดคะแนนแยกตามห้อง', 'คะแนนทุกงาน คะแนนรวม เกรด แยกแผ่นตามห้อง'], ['offering', 'all', 'สมุดคะแนนรวมทั้งรายวิชา', 'นักเรียนทุกห้องในตารางเดียว'], ['groups', '', 'ผลงานกลุ่มแยกตามกลุ่ม', 'คะแนนกลุ่มของทุกงาน สมาชิก และคะแนนรายบุคคล']]
      .map((r) => '<div class="card clickable" tabindex="0" role="button" data-k="' + r[0] + '" data-g="' + r[1] + '"><h3>' + r[2] + '</h3><div class="small muted">' + r[3] + '</div><p class="small">PDF · Excel</p></div>').join('') + '</div>');
  bindOfferingHeader(p);
  on('[data-k]', 'click', (e) => go('reportView', { kind: e.currentTarget.getAttribute('data-k'), groupBy: e.currentTarget.getAttribute('data-g'), offeringId: p.offeringId }));
  on('[data-k]', 'keydown', (e) => { if (e.key === 'Enter') e.currentTarget.click(); });
};

// ---------------------------------------------------------------- รายงานของผู้ดูแล / รายห้อง
const lastPick = {};
views.adminReports = async () => {
  h(backBtn() + '<h1>รายงาน PDF / Excel</h1><div id="ar"><div class="loading">กำลังโหลด…</div></div>');
  bindBack();
  const sch = schoolId();
  const wide = hasRole('admin') || hasRole('grade_admin');
  const [students, terms, offs] = await Promise.all([
    fetchAll(query(collection(db, 'students'), where('schoolId', '==', sch), where('status', '==', 'active'))),
    fetchAll(query(collection(db, 'terms'), where('schoolId', '==', sch))),
    fetchAll(wide ? query(collection(db, 'offerings'), where('schoolId', '==', sch)) : query(collection(db, 'offerings'), where('schoolId', '==', sch), where('staffUids', 'array-contains', session.user.uid)))
  ]);
  const rooms = {};
  students.forEach((s) => { rooms[(s.classLevel || '') + '|' + (s.room || '')] = s.roomLabel; });
  terms.sort((a, b) => (b.yearBe - a.yearBe) || (b.termNo - a.termNo));
  const live = offs.filter((o) => o.status !== 'archived').sort((a, b) => (b.yearBe - a.yearBe) || (b.termNo - a.termNo) || thSort(a.courseCode + a.section, b.courseCode + b.section));
  if (!q('#ar')) return;
  q('#ar').innerHTML = '<div class="card"><h2 style="margin-top:0">สรุปคะแนนรายห้อง (ทุกรายวิชา)</h2><div class="row"><div><label for="ar-room">ห้อง</label><select id="ar-room">' +
    Object.keys(rooms).sort((a, b) => thSort(rooms[a], rooms[b])).map((k) => '<option value="' + esc(k) + '">' + esc(rooms[k]) + '</option>').join('') + '</select></div>' +
    '<div><label for="ar-term">ภาคเรียน</label><select id="ar-term"><option value="">ทุกภาคที่ยังไม่เก็บถาวร</option>' + terms.map((t) => '<option value="' + esc(t.id) + '">' + esc(t.label) + '</option>').join('') + '</select></div></div>' +
    '<p><button class="btn" id="ar-go"' + (Object.keys(rooms).length ? '' : ' disabled') + '>ออกรายงานรายห้อง</button></p></div>' +
    '<div class="card"><h2 style="margin-top:0">รายงานของรายวิชา</h2><label for="ar-off">รายวิชา</label><select id="ar-off">' + live.map((o) => '<option value="' + esc(o.id) + '">' + esc('ปี ' + o.yearBe + '/' + o.termNo + ' · ' + o.courseCode + ' ' + o.courseName + ' (' + o.section + ')') + '</option>').join('') + '</select>' +
    '<p><button class="btn ghost" data-k="offering" data-g="room">สมุดคะแนนแยกตามห้อง</button> <button class="btn ghost" data-k="offering" data-g="all">สมุดคะแนนรวม</button> <button class="btn ghost" data-k="groups" data-g="">แยกตามกลุ่ม</button></p></div>';
  // จำตัวเลือกล่าสุดไว้ เมื่อกดย้อนกลับจากหน้ารายงานจะได้ไม่ต้องเลือกใหม่
  [['#ar-room', 'room'], ['#ar-term', 'term'], ['#ar-off', 'off']].forEach(([sel, k]) => {
    const el = q(sel);
    if (lastPick[k] && [...el.options].some((o) => o.value === lastPick[k])) el.value = lastPick[k];
    el.addEventListener('change', () => { lastPick[k] = el.value; });
  });
  on('#ar-go', 'click', () => { const [classLevel, room] = q('#ar-room').value.split('|'); go('reportView', { kind: 'room', classLevel, room, termId: q('#ar-term').value }); });
  on('[data-k]', 'click', (e) => { if (!q('#ar-off').value) return; go('reportView', { kind: e.currentTarget.getAttribute('data-k'), groupBy: e.currentTarget.getAttribute('data-g'), offeringId: q('#ar-off').value }); });
};
