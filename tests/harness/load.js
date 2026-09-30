'use strict';
/**
 * โหลดไฟล์ทั้งหมดใน gas/ เข้า vm context เดียว (เหมือน global scope ของ Apps Script)
 * พร้อมบริการจำลองจาก gas-fakes.js และตัวช่วยสำหรับทดสอบ
 */
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const { createFakes } = require('./gas-fakes');

const GAS_DIR = path.join(__dirname, '..', '..', 'gas');

function loadGas(opts = {}) {
  const fakes = createFakes(opts);
  const logs = [];
  const quiet = {
    log: (...a) => logs.push(['log', a.join(' ')]),
    info: (...a) => logs.push(['info', a.join(' ')]),
    warn: (...a) => logs.push(['warn', a.join(' ')]),
    error: (...a) => logs.push(['error', a.join(' ')])
  };
  const context = Object.assign({ console: opts.verbose ? console : quiet }, fakes);
  vm.createContext(context);
  const files = fs.readdirSync(GAS_DIR).filter((f) => f.endsWith('.js')).sort();
  for (const f of files) {
    vm.runInContext(fs.readFileSync(path.join(GAS_DIR, f), 'utf8'), context, { filename: 'gas/' + f });
  }
  // เร่งการทดสอบ: ลดรอบ PBKDF2 (ค่าจริงทดสอบแยกใน crypto.test.js)
  vm.runInContext('APP.PBKDF2_ITERATIONS = 1000;', context);
  context._logs = logs;
  return context;
}

const plain = (v) => JSON.parse(JSON.stringify(v));

/** ติดตั้งระบบสาธิตพร้อมข้อมูลสมมติ คืน context และบัญชีทดสอบ */
function bootDemo(opts = {}) {
  const g = loadGas(opts);
  g.PropertiesService.getScriptProperties().setProperty('ENV', 'demo');
  const setup = g.Setup.run({ schoolCode: 'DEMO', schoolName: 'โรงเรียนสาธิต (ข้อมูลสมมติ)', isDemo: true, adminUsername: 'demo_admin' });
  const seeded = g.Seed.run();
  const accounts = {};
  seeded.accounts.forEach((a) => { accounts[a.username] = a.password; });
  accounts.demo_admin = setup.admin.tempPassword;
  return { g, accounts, setup };
}

function call(g, action, payload, token) {
  return plain(g.apiCall({ action, payload: payload || {}, token }));
}

function ok(g, action, payload, token) {
  const r = call(g, action, payload, token);
  if (!r.ok) {
    const err = new Error(`${action} failed: ${r.error.code} ${r.error.message}`);
    err.response = r;
    throw err;
  }
  return r.data;
}

function login(g, accounts, username) {
  return ok(g, 'auth.login', { username, password: accounts[username] }).token;
}

/** อัปโหลดไฟล์ผ่าน begin/chunk/finalize เหมือนหน้าเว็บ */
function upload(g, token, assessmentId, name, buf, opts = {}) {
  const b = call(g, 'upload.begin', { assessmentId, fileName: name, size: buf.length, mimeType: opts.mime || '' }, token);
  if (!b.ok) return b;
  const chunkSize = b.data.chunkSize;
  let offset = 0;
  let guard = 0;
  while (offset < buf.length) {
    if (++guard > 1000) throw new Error('upload loop');
    const piece = buf.subarray(offset, offset + chunkSize);
    const r = call(g, 'upload.chunk', { uploadId: b.data.uploadId, offset, data: piece.toString('base64') }, token);
    if (!r.ok) return r;
    offset = r.data.received;
    if (opts.stopAfterFirstChunk) return { ok: true, data: { uploadId: b.data.uploadId, partial: true } };
  }
  return call(g, 'upload.finalize', { uploadId: b.data.uploadId }, token);
}

module.exports = { loadGas, bootDemo, call, ok, login, upload, plain };
