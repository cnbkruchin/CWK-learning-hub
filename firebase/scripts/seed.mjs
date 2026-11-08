#!/usr/bin/env node
/**
 * ใส่ข้อมูลสาธิตลง Firebase Emulator (หรือโปรเจกต์ที่ชื่อขึ้นต้นด้วย demo- เท่านั้น)
 * ใช้: npx firebase emulators:exec --project demo-cwk "node scripts/seed.mjs"
 * พิมพ์บัญชีทดสอบ (รหัสผ่านสุ่ม หรือกำหนดด้วย SEED_PASSWORD) — ห้ามใช้กับระบบจริง
 */
const project = process.env.GCLOUD_PROJECT || '';
if (!process.env.FIRESTORE_EMULATOR_HOST && !project.startsWith('demo-')) {
  console.error('seed ใช้ได้กับ Firebase Emulator หรือโปรเจกต์ demo-* เท่านั้น');
  process.exit(1);
}
const { seedDemo } = await import('./seed-lib.mjs');
const out = await seedDemo({ password: process.env.SEED_PASSWORD });
console.log('สร้างข้อมูลสาธิตแล้ว — บัญชีทดสอบ (รหัสผ่านเดียวกันทุกบัญชี):');
Object.keys(out.accounts).forEach((u) => console.log('  ' + u.padEnd(12) + ' ' + out.accounts[u]));
if (process.env.SEED_OUT) (await import('node:fs')).writeFileSync(process.env.SEED_OUT, JSON.stringify(out, null, 2));
process.exit(0);
