/**
 * สร้างไอคอนแอปทุกขนาดจาก app/public/icons/icon.svg ด้วย Chromium (Playwright)
 * - PWA: icon-192/512, maskable-512, apple-touch-icon (180)
 * - Capacitor: resources/icon.png (1024) และ resources/splash.png (2732) สำหรับ `npx @capacitor/assets generate`
 * ใช้: node tools/make-icons.mjs
 */
import { createRequire } from 'node:module';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Playwright ติดตั้งแบบ global (หรือ npm i -D playwright)
const { chromium } = createRequire(import.meta.url)('playwright');
const root = fileURLToPath(new URL('..', import.meta.url));
const svg = readFileSync(root + 'app/public/icons/icon.svg', 'utf8');
const uri = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
const jobs = [
  { out: 'app/public/icons/icon-192.png', size: 192 },
  { out: 'app/public/icons/icon-512.png', size: 512 },
  { out: 'app/public/icons/apple-touch-icon.png', size: 180, pad: 0, bg: '#1f5fbf', square: true },
  { out: 'app/public/icons/maskable-512.png', size: 512, pad: 0.12, bg: '#1f5fbf', square: true },
  { out: 'resources/icon.png', size: 1024, pad: 0, bg: '#1f5fbf', square: true },
  { out: 'resources/icon-foreground.png', size: 1024, pad: 0.2, bg: 'transparent', square: true },
  { out: 'resources/icon-background.png', size: 1024, pad: 0, bg: '#1f5fbf', square: true, empty: true },
  { out: 'resources/splash.png', size: 2732, pad: 0.38, bg: '#f5f7fb', square: true },
  { out: 'resources/splash-dark.png', size: 2732, pad: 0.38, bg: '#11151c', square: true }
];
mkdirSync(root + 'resources', { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
for (const j of jobs) {
  await page.setViewportSize({ width: j.size, height: j.size });
  const inner = Math.round(j.size * (1 - 2 * (j.pad || 0)));
  const img = j.empty ? '' : '<img src="' + uri + '" style="width:' + inner + 'px;height:' + inner + 'px;' + (j.square ? 'border-radius:0' : '') + '">';
  await page.setContent('<html><body style="margin:0;width:' + j.size + 'px;height:' + j.size + 'px;display:flex;align-items:center;justify-content:center;background:' + (j.bg || 'transparent') + '">' + img + '</body></html>');
  await page.waitForTimeout(50);
  await page.screenshot({ path: root + j.out, omitBackground: !j.bg || j.bg === 'transparent' });
  console.log('wrote', j.out);
}
await browser.close();
