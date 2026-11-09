/**
 * บันทึกไฟล์ (รายงาน Excel/PDF, ไฟล์งาน) ให้ใช้ได้ทุกแพลตฟอร์ม
 * - เว็บ/PWA: ดาวน์โหลดผ่านลิงก์ชั่วคราว (blob URL)
 * - แอป iOS/Android (Capacitor): WebView ดาวน์โหลดเองไม่ได้ จึงเขียนไฟล์ลงแคชของแอปแล้วเปิดหน้าแชร์ของระบบ
 *   ผู้ใช้เลือก "บันทึกลงไฟล์", เปิดด้วย Excel/ตัวอ่าน PDF หรือส่งต่อได้
 */
import { Capacitor } from '@capacitor/core';

export const isNative = () => Capacitor.isNativePlatform();

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

export function safeName(name) {
  return String(name || 'file').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/\s+/g, '_').slice(0, 150);
}

export async function saveFile(name, mime, data) {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
  const file = safeName(name);
  if (isNative()) {
    const [{ Filesystem, Directory }, { Share }] = await Promise.all([import('@capacitor/filesystem'), import('@capacitor/share')]);
    const written = await Filesystem.writeFile({ path: file, data: await blobToBase64(blob), directory: Directory.Cache });
    await Share.share({ title: file, url: written.uri, dialogTitle: 'บันทึกหรือแชร์ไฟล์' });
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = file; a.rel = 'noopener';
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 2000);
}
