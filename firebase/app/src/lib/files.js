/** เปิด/ดาวน์โหลดไฟล์งานผ่าน Cloud Function (ตรวจสิทธิ์ทุกครั้ง) แสดงตัวอย่างรูป/PDF ในหน้า */
import { api } from './fb.js';
import { esc, openModal, toast, q, on, fmtBytes, download } from './ui.js';

export function fileRows(files, opts = {}) {
  if (!files || !files.length) return '<div class="muted small">ไม่มีไฟล์</div>';
  return files.map((f) => '<div class="file-row"><div><span class="file-name">' + esc(f.name) + '</span> <span class="small muted">' + fmtBytes(f.size) + '</span></div><div>' +
    '<button class="btn ghost small" data-open="' + esc(f.id) + '">' + (f.preview ? 'เปิดดู' : 'ดาวน์โหลด') + '</button>' +
    (opts.removable ? ' <button class="btn ghost small" data-remove="' + esc(f.id) + '" aria-label="ลบ ' + esc(f.name) + ' ออกจากฉบับร่าง">ลบ</button>' : '') + '</div></div>').join('');
}

export function bindFileButtons(root, offeringId) {
  on('[data-open]', 'click', (e) => openFile(offeringId, e.currentTarget.getAttribute('data-open'), e.currentTarget), root);
}

export async function openFile(offeringId, fileId, btn) {
  const label = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'กำลังเปิด…'; }
  try {
    const m = await api('files.open', { offeringId, fileId });
    const parts = [];
    for (let i = 0; i < m.chunks; i++) {
      const c = await api('files.chunk', { offeringId, fileId, index: i }, { retry: 3 });
      const bin = atob(c.data); const arr = new Uint8Array(bin.length);
      for (let k = 0; k < bin.length; k++) arr[k] = bin.charCodeAt(k);
      parts.push(arr);
      if (btn) btn.textContent = 'กำลังเปิด… ' + Math.round((i + 1) / m.chunks * 100) + '%';
    }
    const blob = new Blob(parts, { type: m.mime });
    const url = URL.createObjectURL(blob);
    let body = '<h2 id="modal-title" style="margin-top:0" class="file-name">' + esc(m.name) + '</h2>';
    if (m.preview === 'image') body += '<img class="preview-img" src="' + url + '" alt="' + esc(m.name) + '">';
    else if (m.preview === 'pdf') body += '<iframe class="preview-frame" src="' + url + '" title="' + esc(m.name) + '"></iframe>';
    else if (m.mime === 'text/plain' && m.size < 1048576) body += '<pre class="text-preview" id="text-preview"></pre>';
    else body += '<p class="muted">ไฟล์ชนิดนี้เปิดดูในแอปไม่ได้ กรุณาดาวน์โหลด</p>';
    body += '<p><button class="btn" id="file-save">ดาวน์โหลด</button> <button class="btn ghost" data-close>ปิด</button></p>';
    openModal(body, () => URL.revokeObjectURL(url));
    q('#file-save').addEventListener('click', () => download(m.name, m.mime, blob));
    if (q('#text-preview')) blob.text().then((t) => { q('#text-preview').textContent = t; });
  } catch (err) {
    toast(err.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = label; }
  }
}
