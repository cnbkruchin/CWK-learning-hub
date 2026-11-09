/**
 * Vite: สร้างแอปเว็บ (PWA) ใน app/dist — Capacitor ใช้โฟลเดอร์เดียวกันทำแอป iOS/Android
 * @shared → โมดูลคำนวณคะแนน/Excel ที่ใช้ร่วมกับ Cloud Functions (functions/src/shared)
 */
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

/** สร้าง sw.js พร้อมรายการไฟล์ทั้งหมดของ build นี้ (เปิดแอปออฟไลน์ได้) */
function serviceWorker() {
  return {
    name: 'cwk-service-worker',
    apply: 'build',
    generateBundle(_, bundle) {
      // ไม่ precache: .woff (ใช้ .woff2) และส่วนเสริมของ jsPDF ที่แอปไม่ได้ใช้ (html2canvas, purify, canvg)
      const skip = (f) => f.endsWith('.map') || f.endsWith('.woff') || /^assets\/(html2canvas|purify|index\.es)/.test(f);
      const files = Object.keys(bundle).filter((f) => !skip(f)).sort();
      const statics = ['manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'];
      const version = createHash('sha256').update(files.join('|')).digest('hex').slice(0, 12);
      const list = ['/'].concat(files.filter((f) => f !== 'index.html').map((f) => '/' + f), statics.map((f) => '/' + f));
      const source = readFileSync(here('sw-template.js'), 'utf8').replace('__VERSION__', version).replace('__PRECACHE__', JSON.stringify(list));
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    }
  };
}

export default defineConfig({
  root: here('.'),
  envDir: here('.'),
  publicDir: here('public'),
  plugins: [serviceWorker()],
  resolve: { alias: { '@shared': here('../functions/src/shared') } },
  server: { host: '127.0.0.1', port: 5173, fs: { allow: [here('..')] } },
  preview: { host: '127.0.0.1', port: 4173 },
  build: {
    outDir: here('dist'),
    emptyOutDir: true,
    target: ['es2020', 'safari14', 'chrome90'],
    chunkSizeWarningLimit: 1200,
    sourcemap: false
  }
});
