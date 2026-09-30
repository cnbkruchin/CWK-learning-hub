'use strict';
/**
 * ไฟล์ตัวอย่างที่มีโครงสร้างจริง (สร้างด้วยโค้ด ไม่ต้องเก็บไฟล์ไบนารีใน repo)
 */
const zlib = require('zlib');

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** สร้าง ZIP แบบ stored/deflate จากรายการ { name, data } */
function makeZip(entries, opts = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data || '');
    const comp = opts.deflate ? zlib.deflateRawSync(raw) : raw;
    const method = opts.deflate ? 8 : 0;
    const crc = crc32(raw);
    const flags = (opts.encrypted ? 1 : 0) | 0x800;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(flags, 6); lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(e.fakeSize || raw.length, 22);
    lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(flags, 8); ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(e.fakeSize || raw.length, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const docx = (extra = []) => makeZip([
  { name: '[Content_Types].xml', data: '<Types/>' },
  { name: '_rels/.rels', data: '<Relationships/>' },
  { name: 'word/document.xml', data: '<w:document>สวัสดี</w:document>' },
  ...extra
], { deflate: true });

const xlsx = () => makeZip([
  { name: '[Content_Types].xml', data: '<Types/>' },
  { name: 'xl/workbook.xml', data: '<workbook/>' }
], { deflate: true });

function pdf(sizeBytes = 2000) {
  const head = Buffer.from('%PDF-1.7\n%âãÏÓ\n1 0 obj << /Type /Catalog >> endobj\n');
  const tail = Buffer.from('\ntrailer << /Root 1 0 R >>\n%%EOF\n');
  const pad = Buffer.alloc(Math.max(0, sizeBytes - head.length - tail.length), 0x20);
  return Buffer.concat([head, pad, tail]);
}

function png(sizeBytes = 1000) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([sig, Buffer.alloc(Math.max(0, sizeBytes - 8), 7)]);
}

function jpg(sizeBytes = 1000) {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(Math.max(0, sizeBytes - 4), 1)]);
}

const exe = () => Buffer.concat([Buffer.from('MZ'), Buffer.alloc(500, 0x90)]);
const txt = (s = 'บันทึกการทดลอง\nบรรทัดที่สอง\n') => Buffer.from(s, 'utf8');

module.exports = { makeZip, docx, xlsx, pdf, png, jpg, exe, txt };
