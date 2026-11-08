#!/usr/bin/env node
/**
 * สร้างโมดูล ES (functions/src/shared/*.js) จากโมดูล JavaScript ล้วนของรุ่น Apps Script (gas/*.js)
 * เพื่อให้รุ่น Firebase (Cloud Functions + แอป) ใช้โค้ดคำนวณคะแนน/ตรวจไฟล์/สร้าง XLSX ชุดเดียวกับรุ่นเดิม
 * แก้ที่ gas/*.js แล้วรัน `npm run shared` — ห้ามแก้ไฟล์ที่สร้างด้วยมือ (มีทดสอบตรวจว่าตรงกัน)
 *
 * ใช้: node tools/sync-shared.mjs [--check]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const GAS = path.join(here, '..', '..', 'gas');
const OUT = path.join(here, '..', 'functions', 'src', 'shared');

const MODULES = [
  { file: 'Dec.js', name: 'Dec', out: 'dec.js' },
  { file: 'Grading.js', name: 'Grading', out: 'grading.js', prelude: "import Dec from './dec.js';" },
  { file: 'FileCheck.js', name: 'FileCheck', out: 'filecheck.js' },
  {
    file: 'Xlsx.js', name: 'Xlsx', out: 'xlsx.js',
    // Xlsx ใช้ Crypto.utf8 ของรุ่น Apps Script — แทนด้วย TextEncoder (มีทั้งใน Node.js และเบราว์เซอร์)
    prelude: 'const Crypto = { utf8: (s) => Array.from(new TextEncoder().encode(String(s))) };'
  }
];

function generate(m) {
  const src = fs.readFileSync(path.join(GAS, m.file), 'utf8');
  return '// ไฟล์นี้สร้างอัตโนมัติจาก gas/' + m.file + ' ด้วย tools/sync-shared.mjs — ห้ามแก้ด้วยมือ\n' +
    '/* eslint-disable */\n' + (m.prelude ? m.prelude + '\n' : '') + src.trimEnd() + '\n\nexport default ' + m.name + ';\n';
}

const check = process.argv.includes('--check');
fs.mkdirSync(OUT, { recursive: true });
let stale = [];
for (const m of MODULES) {
  const target = path.join(OUT, m.out);
  const content = generate(m);
  if (check) {
    if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== content) stale.push(m.out);
  } else {
    fs.writeFileSync(target, content);
    console.log('wrote functions/src/shared/' + m.out);
  }
}
if (check && stale.length) {
  console.error('โมดูลที่ไม่ตรงกับ gas/: ' + stale.join(', ') + ' — รัน npm run shared');
  process.exit(1);
}
