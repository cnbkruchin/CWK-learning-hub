#!/usr/bin/env node
'use strict';
/**
 * เซิร์ฟเวอร์ทดลองหน้าเว็บบนเครื่อง (ไม่ต้อง deploy)
 * - รันโค้ดฝั่งเซิร์ฟเวอร์ใน gas/ จริง กับบริการ Google จำลอง (ข้อมูลอยู่ในหน่วยความจำ หายเมื่อปิด)
 * - ใส่ข้อมูลสาธิตอัตโนมัติ และพิมพ์บัญชีทดสอบ
 * - แทน google.script.run ด้วย fetch('/api')
 *
 * ใช้: node tools/dev-server.js [port]   แล้วเปิด http://localhost:8080
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { bootDemo } = require('../tests/harness/load');

const UI = path.join(__dirname, '..', 'gas', 'ui');

const SHIM = `<script>
(function () {
  function runner(ok, fail) {
    return {
      withSuccessHandler: function (fn) { return runner(fn, fail); },
      withFailureHandler: function (fn) { return runner(ok, fn); },
      apiCall: function (req) {
        fetch('/api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req) })
          .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
          .then(function (res) { ok && ok(res); }, function (e) { fail && fail(e); });
      }
    };
  }
  window.google = { script: { run: runner(null, null) } };
})();
</script>`;

function page() {
  let html = fs.readFileSync(path.join(UI, 'Index.html'), 'utf8');
  html = html.replace(/<\?!=\s*include\('ui\/(\w+)'\);?\s*\?>/g, (m, name) => {
    const body = fs.readFileSync(path.join(UI, name + '.html'), 'utf8');
    return name === 'App' ? SHIM + body : body;
  });
  return html;
}

/** เริ่มเซิร์ฟเวอร์ คืน { server, accounts, g } (ใช้ในสคริปต์ทดสอบ UI ได้) */
function start(port) {
  const { g, accounts } = bootDemo();
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(page());
      return;
    }
    if (req.method === 'POST' && req.url === '/api') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 50 * 1024 * 1024) req.destroy(); });
      req.on('end', () => {
        let out;
        try { out = g.apiCall(JSON.parse(body)); } catch (e) { out = { ok: false, error: { code: 'INTERNAL', message: String(e) } }; }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(out));
      });
      return;
    }
    res.writeHead(404); res.end('not found');
  });
  return new Promise((resolve) => server.listen(port, () => resolve({ server, accounts, g })));
}

if (require.main === module) {
  const port = Number(process.argv[2] || process.env.PORT || 8080);
  start(port).then(({ accounts }) => {
    console.log(`CWK Learning Hub (โหมดทดลองบนเครื่อง) http://localhost:${port}`);
    console.log('บัญชีทดสอบ (ข้อมูลสมมติ รหัสผ่านสุ่มใหม่ทุกครั้งที่เปิดเซิร์ฟเวอร์):');
    Object.keys(accounts).forEach((u) => console.log(`  ${u.padEnd(12)} ${accounts[u]}`));
    if (process.env.ACCOUNTS_FILE) fs.writeFileSync(process.env.ACCOUNTS_FILE, JSON.stringify(accounts));
  });
}

module.exports = { start };
