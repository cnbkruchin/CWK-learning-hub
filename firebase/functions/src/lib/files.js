/**
 * เปิด/ดาวน์โหลดไฟล์งาน: ตรวจสิทธิ์ที่เซิร์ฟเวอร์ทุกครั้ง แล้วส่งข้อมูลเป็นช่วง (base64) ผ่าน Cloud Function
 * (ตรรกะเดียวกับ gas/Files.js + Authz.canReadFile) — ไม่มีลิงก์สาธารณะ ไม่ต้องตั้งค่า CORS ของ bucket
 * อ่านได้: ครูที่มีสิทธิ์ดูรายวิชา ผู้ดูแล ผู้อัปโหลด หรือนักเรียนที่อยู่ใน readerIds (สมาชิกกลุ่มตาม snapshot ของรุ่นที่ส่ง)
 */
import { db, bucket, getDoc, audit } from './core.js';
import { raise } from './errors.js';
import { computePerms } from './perms.js';
import FileCheck from '../shared/filecheck.js';

export const CHUNK_BYTES = 3 * 1024 * 1024;

async function readable(ctx, offeringId, fileId) {
  const o = await getDoc(null, db.doc('offerings/' + String(offeringId || '')));
  const f = o ? await getDoc(null, db.doc('offerings/' + o.id + '/files/' + String(fileId || ''))) : null;
  if (!o || !f || o.schoolId !== ctx.schoolId || f.state === 'removed') raise('NOT_FOUND');
  if (f.uploadedByUid === ctx.uid) return f;
  if (ctx.studentId && (f.readerIds || []).includes(ctx.studentId)) {
    const enr = await getDoc(null, db.doc('offerings/' + o.id + '/enrollments/' + ctx.studentId));
    if (enr) return f;
  }
  const perms = await computePerms(ctx, o, null);
  if (perms.can_view) return f;
  raise('NOT_FOUND'); // ไม่บอกว่ามีไฟล์อยู่หรือไม่
  return null;
}

export async function open(ctx, d) {
  const f = await readable(ctx, d.offeringId, d.fileId);
  await audit(ctx, 'file.open', 'files', f.id, { name: f.name }, '', d.offeringId);
  return {
    fileId: f.id, name: f.name, size: f.size, ext: f.ext, sha256: f.sha256, mime: FileCheck.safeMime(f.ext),
    preview: FileCheck.previewKind(f.ext) || '', chunkSize: CHUNK_BYTES, chunks: Math.max(1, Math.ceil(f.size / CHUNK_BYTES))
  };
}

export async function chunk(ctx, d) {
  const f = await readable(ctx, d.offeringId, d.fileId);
  const index = Number(d.index);
  const start = index * CHUNK_BYTES;
  if (!Number.isInteger(index) || index < 0 || start >= f.size) raise('VALIDATION');
  const end = Math.min(f.size, start + CHUNK_BYTES) - 1;
  const [buf] = await bucket().file(f.path).download({ start, end });
  return { index, data: buf.toString('base64') };
}
