/** ตัวช่วยหน้าจอ: escape ข้อความทุกจุด, toast, หน้าต่าง, รูปแบบวันเวลาไทย (พ.ศ.), ดาวน์โหลดไฟล์ */
import { back, depth } from './router.js';
import { saveFile } from './save.js';

export const $main = () => document.getElementById('main');
export function esc(s) {
  return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
export function h(html) { const m = $main(); m.innerHTML = html; m.focus({ preventScroll: true }); }
export const q = (sel, root) => (root || document).querySelector(sel);
export const qa = (sel, root) => Array.prototype.slice.call((root || document).querySelectorAll(sel));
export function on(sel, ev, fn, root) { qa(sel, root).forEach((el) => el.addEventListener(ev, fn)); }

let toastTimer;
export function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4000);
}
export function errBox(err) { return '<div class="notice bad" role="alert">' + esc(err && err.message || 'เกิดข้อผิดพลาด') + '</div>'; }
export function backBtn() { return depth() > 1 ? '<button class="btn ghost small back" data-back>← ย้อนกลับ</button>' : ''; }
export function bindBack(root) { on('[data-back]', 'click', back, root); }

const TZ = 'Asia/Bangkok';
export function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return esc(iso);
  try { return new Intl.DateTimeFormat('th-TH', { timeZone: TZ, dateStyle: 'medium', timeStyle: 'short' }).format(d); } catch (e) { return esc(iso); }
}
export function fmtBytes(n) {
  n = Number(n || 0);
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}
export function isoToLocalInput(iso) { if (!iso) return ''; return new Date(Date.parse(iso) + 7 * 3600000).toISOString().slice(0, 16); }
export function localInputToIso(v) {
  const m = (v || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 7, +m[5])).toISOString() : '';
}
export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID().replace(/-/g, '');
  const a = new Uint8Array(16); crypto.getRandomValues(a);
  return Array.from(a, (b) => ('0' + b.toString(16)).slice(-2)).join('');
}

export const KIND = { individual: 'งานเดี่ยว', group: 'งานกลุ่ม', exam: 'สอบ', score_only: 'รับคะแนนอย่างเดียว' };
const CHIP = {
  not_open: ['neutral', '◷'], not_submitted: ['warn', '!'], draft: ['info', '✎'], submitted: ['ok', '✓'], late: ['warn', '⏰'],
  resubmitted: ['info', '↻'], returned: ['bad', '↩'], accepted: ['ok', '✓✓'], graded: ['ok', '★'], closed: ['bad', '✕'], score_only: ['neutral', '—']
};
export function chip(code, label, cls) {
  const c = CHIP[code] || [cls || 'neutral', '•'];
  return '<span class="chip ' + (cls || c[0]) + '"><span aria-hidden="true">' + c[1] + '</span>' + esc(label) + '</span>';
}

let modalCleanup = null;
export function openModal(html, cleanup) {
  const d = document.getElementById('modal');
  q('#modal-body').innerHTML = html;
  modalCleanup = cleanup || null;
  on('[data-close]', 'click', () => d.close(), d);
  if (!d.open) d.showModal();
}
export function closeModal() { const d = document.getElementById('modal'); if (d.open) d.close(); }
export function initModal() {
  const d = document.getElementById('modal');
  d.addEventListener('close', () => {
    if (d.open) return;
    if (modalCleanup) { modalCleanup(); modalCleanup = null; }
    q('#modal-body').innerHTML = '';
  });
}

/** ดาวน์โหลด/บันทึกไฟล์ (เว็บ: ดาวน์โหลด, แอป iOS/Android: หน้าแชร์ของระบบ) */
export function download(name, mime, data) {
  return saveFile(name, mime, data).catch((e) => toast('บันทึกไฟล์ไม่สำเร็จ: ' + (e && e.message || e)));
}
/** CSV สำหรับ Excel: UTF-8 BOM + กันข้อความที่ขึ้นต้นด้วย = + - @ ถูกตีความเป็นสูตร */
export function csv(rows) {
  return '﻿' + rows.map((r) => r.map((v) => {
    let s = String(v === null || v === undefined ? '' : v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(',')).join('\r\n');
}

export function pickList(name, people, opts = {}) {
  if (!people.length) return '<div class="muted small">' + esc(opts.empty || 'ไม่มีรายชื่อ') + '</div>';
  return '<div class="small"><label class="check" style="margin:0"><input type="checkbox" data-all="' + name + '"> เลือกทั้งหมด (' + people.length + ' คน)</label></div>' +
    '<div class="pick-list" role="group" aria-label="' + esc(opts.label || 'รายชื่อ') + '">' + people.map((s) =>
      '<label><input type="checkbox" name="' + name + '" value="' + esc(s.id) + '"> ' + (s.code ? '<span class="muted">' + esc(s.code) + '</span> ' : '') +
      esc(s.name) + ' <span class="small muted">' + esc(s.roomLabel || '') + '</span></label>').join('') + '</div>';
}
export function bindPickAll(root) {
  on('[data-all]', 'change', (e) => {
    const name = e.currentTarget.getAttribute('data-all');
    qa('[name="' + name + '"]', root).forEach((x) => { x.checked = e.currentTarget.checked; });
  }, root);
}
export const picked = (name, root) => qa('[name="' + name + '"]:checked', root).map((x) => x.value);
void back;
