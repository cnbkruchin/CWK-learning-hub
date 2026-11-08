#!/usr/bin/env node
/**
 * ติดตั้งครั้งแรกบนโปรเจกต์ Firebase จริง: สร้างโรงเรียนและผู้ดูแลคนแรก (รหัสผ่านชั่วคราว ต้องเปลี่ยนเมื่อเข้าใช้)
 *
 * ใช้: GOOGLE_APPLICATION_CREDENTIALS=service-account.json GCLOUD_PROJECT=<project-id> \
 *      node scripts/bootstrap.mjs --code CWK --name "โรงเรียนจุนวิทยาคม" [--admin admin]
 * ไฟล์ service account ดาวน์โหลดจาก Firebase Console → Project settings → Service accounts (ห้าม commit)
 */
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--') ? acc.concat([[a.slice(2), arr[i + 1]]]) : acc), []));
if (!process.env.GCLOUD_PROJECT) { console.error('กรุณาตั้ง GCLOUD_PROJECT=<project-id>'); process.exit(1); }
const { bootstrapSchool } = await import('./seed-lib.mjs');
const r = await bootstrapSchool({ code: args.code || 'CWK', nameTh: args.name || 'โรงเรียนจุนวิทยาคม', adminUsername: args.admin || 'admin', mustChange: true });
console.log('สร้างโรงเรียนแล้ว schoolId=' + r.schoolId);
console.log('บัญชีผู้ดูแล: ' + r.username + '  รหัสผ่านชั่วคราว: ' + r.password + '  (ต้องเปลี่ยนเมื่อเข้าใช้ครั้งแรก — ห้ามบันทึกรหัสนี้ไว้ที่อื่น)');
process.exit(0);
