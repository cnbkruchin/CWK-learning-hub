/**
 * ตรวจไฟล์ที่อัปโหลด (อ้างอิง OWASP File Upload Cheat Sheet)
 *
 * - ไม่เชื่อนามสกุลหรือ Content-Type: ตรวจ magic bytes และโครงสร้างไฟล์จริง
 * - DOCX/XLSX/PPTX/ODF/SB3/ZIP: อ่านเฉพาะ central directory ของ ZIP (ไม่แตกไฟล์)
 *   ตรวจจำนวนรายการ ขนาดหลังแตก อัตราส่วนการบีบอัด (zip bomb) การเข้ารหัส และมาโคร (vbaProject.bin)
 * - ปฏิเสธไฟล์ปฏิบัติการ (EXE/ELF/Mach-O) และเอกสาร Office รุ่นเก่า (OLE2) ที่อาจมีมาโคร
 * - ไฟล์ข้อความ/โค้ดเก็บเป็นเอกสารดาวน์โหลดเท่านั้น ไม่ประมวลผลหรือรันบนเซิร์ฟเวอร์
 * ข้อจำกัด: Apps Script ไม่มีตัวสแกนไวรัส ผลตรวจนี้คือการตรวจโครงสร้าง ไม่ใช่การสแกนมัลแวร์
 */
var FileCheck = (function () {
  var OOXML = 'application/vnd.openxmlformats-officedocument.';
  var TYPES = {
    pdf: { mime: 'application/pdf', family: 'pdf', preview: 'pdf' },
    jpg: { mime: 'image/jpeg', family: 'jpeg', preview: 'image' },
    jpeg: { mime: 'image/jpeg', family: 'jpeg', preview: 'image' },
    png: { mime: 'image/png', family: 'png', preview: 'image' },
    webp: { mime: 'image/webp', family: 'webp', preview: 'image' },
    gif: { mime: 'image/gif', family: 'gif', preview: 'image' },
    docx: { mime: OOXML + 'wordprocessingml.document', family: 'ooxml', marker: 'word/' },
    xlsx: { mime: OOXML + 'spreadsheetml.sheet', family: 'ooxml', marker: 'xl/' },
    pptx: { mime: OOXML + 'presentationml.presentation', family: 'ooxml', marker: 'ppt/' },
    odt: { mime: 'application/vnd.oasis.opendocument.text', family: 'odf' },
    ods: { mime: 'application/vnd.oasis.opendocument.spreadsheet', family: 'odf' },
    odp: { mime: 'application/vnd.oasis.opendocument.presentation', family: 'odf' },
    zip: { mime: 'application/zip', family: 'zip' },
    sb3: { mime: 'application/octet-stream', family: 'zip', marker: 'project.json' },
    txt: { mime: 'text/plain', family: 'text' },
    csv: { mime: 'text/plain', family: 'text' },
    md: { mime: 'text/plain', family: 'text' },
    py: { mime: 'text/plain', family: 'text' },
    js: { mime: 'text/plain', family: 'text' },
    html: { mime: 'text/plain', family: 'text' },
    css: { mime: 'text/plain', family: 'text' },
    java: { mime: 'text/plain', family: 'text' },
    c: { mime: 'text/plain', family: 'text' },
    cpp: { mime: 'text/plain', family: 'text' }
  };
  var LABELS = {
    pdf: 'PDF', jpeg: 'รูป JPEG', png: 'รูป PNG', webp: 'รูป WEBP', gif: 'รูป GIF', zip: 'ZIP/เอกสาร Office',
    ole2: 'เอกสาร Office รุ่นเก่า', exe: 'โปรแกรม Windows', elf: 'โปรแกรม Linux', macho: 'โปรแกรม macOS',
    text: 'ข้อความ', unknown: 'ไม่ทราบชนิด', empty: 'ไฟล์ว่าง'
  };

  function startsWith(b, sig, offset) {
    offset = offset || 0;
    if (b.length < offset + sig.length) return false;
    for (var i = 0; i < sig.length; i++) if ((b[offset + i] & 0xff) !== sig[i]) return false;
    return true;
  }
  function ascii(s) { return s.split('').map(function (c) { return c.charCodeAt(0); }); }

  function isUtf8(b) {
    var i = 0, n = b.length;
    while (i < n) {
      var c = b[i] & 0xff;
      var need = c < 0x80 ? 0 : (c >= 0xc2 && c <= 0xdf ? 1 : (c >= 0xe0 && c <= 0xef ? 2 : (c >= 0xf0 && c <= 0xf4 ? 3 : -1)));
      if (need < 0) return false;
      if (i + need >= n && need > 0) return true; // ตัดท้ายกลางอักขระในตัวอย่าง
      for (var k = 1; k <= need; k++) if (((b[i + k] & 0xff) & 0xc0) !== 0x80) return false;
      i += need + 1;
    }
    return true;
  }

  function looksText(b) {
    if (!b.length) return false;
    var ctrl = 0;
    for (var i = 0; i < b.length; i++) {
      var c = b[i] & 0xff;
      if (c === 0) return false;
      if (c < 0x20 && c !== 9 && c !== 10 && c !== 13 && c !== 12) ctrl++;
    }
    return ctrl / b.length < 0.01;
  }

  /** ระบุชนิดจริงจากไบต์ต้นไฟล์ */
  function sniff(head) {
    if (!head || !head.length) return 'empty';
    if (startsWith(head, [0xff, 0xd8, 0xff])) return 'jpeg';
    if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
    if (startsWith(head, ascii('GIF87a')) || startsWith(head, ascii('GIF89a'))) return 'gif';
    if (startsWith(head, ascii('RIFF')) && startsWith(head, ascii('WEBP'), 8)) return 'webp';
    if (startsWith(head, [0x50, 0x4b, 0x03, 0x04]) || startsWith(head, [0x50, 0x4b, 0x05, 0x06])) return 'zip';
    if (startsWith(head, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return 'ole2';
    if (startsWith(head, ascii('MZ'))) return 'exe';
    if (startsWith(head, [0x7f, 0x45, 0x4c, 0x46])) return 'elf';
    if (startsWith(head, [0xca, 0xfe, 0xba, 0xbe]) || startsWith(head, [0xfe, 0xed, 0xfa, 0xce]) ||
      startsWith(head, [0xfe, 0xed, 0xfa, 0xcf]) || startsWith(head, [0xcf, 0xfa, 0xed, 0xfe])) return 'macho';
    var pdfSig = ascii('%PDF-');
    for (var i = 0; i <= Math.min(1024, head.length - pdfSig.length); i++) {
      if (startsWith(head, pdfSig, i)) return 'pdf';
    }
    if (looksText(head)) return 'text';
    return 'unknown';
  }

  function u16(b, o) { return (b[o] & 0xff) | ((b[o + 1] & 0xff) << 8); }
  function u32(b, o) { return ((b[o] & 0xff) | ((b[o + 1] & 0xff) << 8) | ((b[o + 2] & 0xff) << 16)) + (b[o + 3] & 0xff) * 16777216; }

  function decodeName(bytes, utf8) {
    var s = '';
    if (utf8) {
      try {
        var i = 0;
        while (i < bytes.length) {
          var c = bytes[i++];
          if (c < 0x80) s += String.fromCharCode(c);
          else if (c < 0xe0) s += String.fromCharCode(((c & 31) << 6) | (bytes[i++] & 63));
          else if (c < 0xf0) s += String.fromCharCode(((c & 15) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63));
          else { i += 3; s += '?'; }
        }
        return s;
      } catch (e) { /* fallthrough */ }
    }
    for (var k = 0; k < bytes.length; k++) s += String.fromCharCode(bytes[k]);
    return s;
  }

  /**
   * อ่านรายการใน ZIP จาก central directory
   * @param {number[]} tail ไบต์ท้ายไฟล์ (unsigned)
   * @param {number} tailOffset ตำแหน่งเริ่มของ tail ในไฟล์
   * @param {function(number,number):number[]=} fetchRange อ่านช่วงไบต์เพิ่มเมื่อ central directory ไม่อยู่ใน tail
   */
  function zipEntries(tail, tailOffset, fetchRange) {
    var eocd = -1;
    for (var i = tail.length - 22; i >= Math.max(0, tail.length - 65557); i--) {
      if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) { eocd = i; break; }
    }
    if (eocd < 0) return { error: 'ไม่พบโครงสร้าง ZIP ที่สมบูรณ์ (ไฟล์อาจเสียหรือถูกตัด)' };
    var total = u16(tail, eocd + 10);
    var cdSize = u32(tail, eocd + 12);
    var cdOffset = u32(tail, eocd + 16);
    if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) return { error: 'ไม่รองรับ ZIP64' };
    var cd;
    if (cdOffset >= tailOffset && cdOffset + cdSize <= tailOffset + tail.length) {
      cd = tail.slice(cdOffset - tailOffset, cdOffset - tailOffset + cdSize);
    } else if (fetchRange && cdSize <= 4 * 1024 * 1024) {
      cd = fetchRange(cdOffset, cdSize);
    } else {
      return { error: 'central directory ใหญ่เกินกำหนด' };
    }
    var entries = [];
    var p = 0;
    for (var n = 0; n < total; n++) {
      if (p + 46 > cd.length || u32(cd, p) !== 0x02014b50) return { error: 'โครงสร้าง ZIP ไม่ถูกต้อง' };
      var flags = u16(cd, p + 8);
      var method = u16(cd, p + 10);
      var comp = u32(cd, p + 20);
      var uncomp = u32(cd, p + 24);
      var nameLen = u16(cd, p + 28), extraLen = u16(cd, p + 30), commentLen = u16(cd, p + 32);
      var name = decodeName(cd.slice(p + 46, p + 46 + nameLen), (flags & 0x800) !== 0);
      entries.push({ name: name, compressed: comp, size: uncomp, encrypted: (flags & 1) === 1, method: method });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return { entries: entries };
  }

  function checkZip(z, t, limits) {
    if (z.error) return z.error;
    var e = z.entries;
    if (e.length > limits.zipMaxEntries) return 'จำนวนไฟล์ภายในเกิน ' + limits.zipMaxEntries + ' รายการ';
    var sum = 0;
    for (var i = 0; i < e.length; i++) {
      var x = e[i];
      if (x.encrypted) return 'ไฟล์ถูกเข้ารหัส/ตั้งรหัสผ่าน ตรวจไม่ได้';
      if (x.compressed === 0xffffffff || x.size === 0xffffffff) return 'ไม่รองรับ ZIP64';
      sum += x.size;
      if (x.size > 10 * 1024 * 1024 && x.compressed > 0 && x.size / x.compressed > 100) return 'อัตราการบีบอัดผิดปกติ (สงสัย zip bomb)';
      if (/(^|\/)\.\.(\/|$)/.test(x.name) || /^\//.test(x.name) || /^[A-Za-z]:/.test(x.name)) return 'มีเส้นทางไฟล์ภายในที่ไม่ปลอดภัย';
      if (/(^|\/)vbaProject\.bin$/i.test(x.name)) return 'เอกสารมีมาโคร (VBA) ไม่อนุญาต';
    }
    if (sum > limits.zipMaxUncompressedBytes) return 'ขนาดหลังแตกไฟล์เกินกำหนด';
    var names = e.map(function (x) { return x.name; });
    if (t.family === 'ooxml') {
      if (names.indexOf('[Content_Types].xml') < 0) return 'ไม่ใช่เอกสาร Office ที่ถูกต้อง';
      if (!names.some(function (n) { return n.indexOf(t.marker) === 0; })) return 'เนื้อหาไม่ตรงกับชนิดเอกสาร';
    }
    if (t.family === 'odf' && names.indexOf('mimetype') < 0) return 'ไม่ใช่เอกสาร OpenDocument ที่ถูกต้อง';
    if (t.marker && t.family === 'zip' && names.indexOf(t.marker) < 0) return 'โครงสร้างไฟล์ไม่ถูกต้อง';
    return null;
  }

  /**
   * ตรวจไฟล์
   * @param {{ext:string,size:number,head:number[],tail:?number[],tailOffset:?number,fetchRange:?function,limits:Object}} a
   * @return {{ok:boolean, detected:string, code:?string, reason:?string}}
   */
  function check(a) {
    var t = TYPES[a.ext];
    var limits = a.limits || {};
    if (!t) return { ok: false, detected: '', code: 'FILE_TYPE_NOT_ALLOWED', reason: 'ไม่รองรับนามสกุล .' + a.ext };
    if (!a.size) return { ok: false, detected: 'empty', code: 'FILE_REJECTED', reason: 'ไฟล์ว่าง' };
    if (limits.maxBytes && a.size > limits.maxBytes) return { ok: false, detected: '', code: 'FILE_TOO_LARGE', reason: 'ขนาดเกินกำหนด' };
    var sig = sniff(a.head);
    var fail = function (code, reason) { return { ok: false, detected: sig, code: code, reason: reason }; };
    if (['exe', 'elf', 'macho'].indexOf(sig) >= 0) return fail('FILE_REJECTED', 'ไฟล์เป็นโปรแกรมปฏิบัติการ (' + LABELS[sig] + ')');
    if (sig === 'ole2') return fail('FILE_SIGNATURE_MISMATCH', 'เป็นเอกสาร Office รุ่นเก่า กรุณาบันทึกเป็น .docx .xlsx .pptx หรือ PDF');
    var expected = { pdf: 'pdf', jpeg: 'jpeg', png: 'png', webp: 'webp', gif: 'gif', ooxml: 'zip', odf: 'zip', zip: 'zip', text: 'text' }[t.family];
    if (sig !== expected) {
      return fail('FILE_SIGNATURE_MISMATCH', 'นามสกุล .' + a.ext + ' แต่เนื้อหาเป็น ' + (LABELS[sig] || sig));
    }
    if (expected === 'zip') {
      if (!a.tail) return fail('FILE_REJECTED', 'อ่านโครงสร้างไฟล์ไม่ได้');
      var z = zipEntries(a.tail, a.tailOffset || 0, a.fetchRange);
      var err = checkZip(z, t, {
        zipMaxEntries: limits.zipMaxEntries || 2000,
        zipMaxUncompressedBytes: limits.zipMaxUncompressedBytes || 200 * 1024 * 1024
      });
      if (err) return fail('FILE_REJECTED', err);
    }
    return { ok: true, detected: t.family === 'ooxml' || t.family === 'odf' ? a.ext : sig, code: null, reason: null, utf8: expected === 'text' ? isUtf8(a.head) : null };
  }

  /** กรองชื่อไฟล์: ตัดเส้นทาง อักขระควบคุม อักขระต้องห้าม และจำกัดความยาว */
  function sanitizeName(name) {
    var s = String(name || '');
    s = s.replace(/^.*[\\/]/, '');
    if (s.normalize) s = s.normalize('NFC');
    s = s.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, '')
      .replace(/[<>:"|?*]/g, '_')
      .replace(/\s+/g, ' ')
      .replace(/^[.\s]+|[.\s]+$/g, '');
    if (!s) s = 'file';
    var dot = s.lastIndexOf('.');
    var ext = dot > 0 ? s.slice(dot + 1).toLowerCase() : '';
    var base = dot > 0 ? s.slice(0, dot) : s;
    if (base.length > 150) base = base.slice(0, 150);
    return { name: ext ? base + '.' + ext : base, ext: ext };
  }

  return {
    TYPES: TYPES,
    sniff: sniff,
    check: check,
    zipEntries: zipEntries,
    sanitizeName: sanitizeName,
    isUtf8: isUtf8,
    previewKind: function (ext) { return TYPES[ext] && TYPES[ext].preview || null; },
    safeMime: function (ext) {
      var t = TYPES[ext];
      if (!t) return 'application/octet-stream';
      return t.preview ? t.mime : (t.family === 'text' ? 'text/plain' : 'application/octet-stream');
    }
  };
})();
