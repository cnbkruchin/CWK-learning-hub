#!/usr/bin/env node
/**
 * ระบบสาธิตบนเครื่อง: เปิด Firebase Emulator → ใส่ข้อมูลสาธิต → เปิดแอปที่ http://127.0.0.1:5173
 * ใช้: npm run dev:demo   (กด Ctrl+C เพื่อปิดทั้งหมด ข้อมูลใน Emulator จะหายเมื่อปิด)
 * รหัสผ่านทุกบัญชีสาธิต = SEED_PASSWORD (ค่าเริ่มต้นด้านล่าง ใช้ได้กับ Emulator เท่านั้น)
 * ทดสอบบนมือถือในวง LAN: VITE_EMULATOR_HOST=<IP เครื่องนี้> และตั้ง host ของ emulators ใน firebase.json เป็น 0.0.0.0
 */
import { spawn } from 'node:child_process';

const env = Object.assign({}, process.env, { SEED_PASSWORD: process.env.SEED_PASSWORD || 'Demo#Pass2569' });
const extra = process.argv.slice(2).join(' ');
const inner = 'node scripts/seed.mjs && npx vite --config app/vite.config.js --mode emulator ' + extra;
const child = spawn('npx', ['firebase', 'emulators:exec', '--project', 'demo-cwk', '--only', 'auth,firestore,functions,storage', inner], { stdio: 'inherit', env, shell: process.platform === 'win32' });
child.on('exit', (code) => process.exit(code ?? 0));
process.on('SIGINT', () => child.kill('SIGINT'));
