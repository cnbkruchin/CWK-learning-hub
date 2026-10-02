/**
 * สร้างไฟล์ Excel (.xlsx) ด้วย JavaScript ล้วน (ใช้ได้ทั้งบน Apps Script และ Node.js)
 *
 * - ไฟล์ .xlsx คือ ZIP ของไฟล์ XML (Office Open XML) — เขียนแบบไม่บีบอัด (STORE) พร้อม CRC-32
 * - ข้อความเขียนเป็น inline string เสมอ: รหัส 00123 ไม่หาย และข้อความที่ขึ้นต้นด้วย = + - @ ไม่ถูกตีความเป็นสูตร
 * - ตัวเลข (คะแนน) เขียนเป็นค่าตัวเลขที่เซิร์ฟเวอร์คำนวณแล้ว ไม่มีสูตร จึงเปิดแล้วเห็นค่าเดียวกับหน้าจอ/PDF
 *
 * ใช้: Xlsx.build([{ name, rows: [[cell...]], widths: [..], freezeRows: n }]) → ไบต์ (array 0..255)
 *   cell = 'ข้อความ' | 123 | { v, t: 's'|'n', s: 'header'|'title'|'num2'|'bold' }
 */
var Xlsx = (function () {
  var crcTable = null;
  function crc32(bytes) {
    if (!crcTable) {
      crcTable = [];
      for (var n = 0; n < 256; n++) {
        var c = n;
        for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        crcTable[n] = c >>> 0;
      }
    }
    var crc = 0xffffffff;
    for (var i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  function u16(arr, v) { arr.push(v & 0xff, (v >>> 8) & 0xff); }
  function u32(arr, v) { arr.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff); }
  function append(dst, src) { for (var i = 0; i < src.length; i++) dst.push(src[i]); }

  /** ZIP แบบ STORE (ไม่บีบอัด) ชื่อไฟล์ UTF-8 */
  function zip(files) {
    var out = [], central = [];
    var DOS_TIME = 0, DOS_DATE = (2026 - 1980) << 9 | 1 << 5 | 1; // วันที่คงที่ ให้ไฟล์เหมือนเดิมเมื่อข้อมูลเหมือนเดิม
    files.forEach(function (f) {
      var name = Crypto.utf8(f.name);
      var data = f.data;
      var crc = crc32(data);
      var offset = out.length;
      u32(out, 0x04034b50); u16(out, 20); u16(out, 0x0800); u16(out, 0); u16(out, DOS_TIME); u16(out, DOS_DATE);
      u32(out, crc); u32(out, data.length); u32(out, data.length); u16(out, name.length); u16(out, 0);
      append(out, name); append(out, data);
      u32(central, 0x02014b50); u16(central, 20); u16(central, 20); u16(central, 0x0800); u16(central, 0); u16(central, DOS_TIME); u16(central, DOS_DATE);
      u32(central, crc); u32(central, data.length); u32(central, data.length); u16(central, name.length); u16(central, 0); u16(central, 0);
      u16(central, 0); u16(central, 0); u32(central, 0); u32(central, offset);
      append(central, name);
    });
    var cdOffset = out.length;
    append(out, central);
    u32(out, 0x06054b50); u16(out, 0); u16(out, 0); u16(out, files.length); u16(out, files.length);
    u32(out, central.length); u32(out, cdOffset); u16(out, 0);
    return out;
  }

  function esc(s) {
    return String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function col(i) {
    var s = '';
    i++;
    while (i > 0) { var m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); }
    return s;
  }

  var STYLE = { text: 1, num: 2, header: 3, title: 4, num2: 5, bold: 6 };
  var NUM_RE = /^-?\d+(\.\d+)?$/;

  function cellXml(ref, c) {
    if (c === null || c === undefined || c === '') return '';
    var v = c, t = null, s = null;
    if (typeof c === 'object') { v = c.v; t = c.t || null; s = c.s || null; }
    if (v === null || v === undefined || v === '') {
      return s ? '<c r="' + ref + '" s="' + STYLE[s] + '"/>' : '';
    }
    var isNum = t === 'n' || (t === null && typeof v === 'number');
    if (isNum && NUM_RE.test(String(v))) {
      return '<c r="' + ref + '" s="' + (STYLE[s] || STYLE.num) + '"><v>' + String(v) + '</v></c>';
    }
    return '<c r="' + ref + '" t="inlineStr" s="' + (STYLE[s] || STYLE.text) + '"><is><t xml:space="preserve">' + esc(v) + '</t></is></c>';
  }

  function sheetXml(sh) {
    var rows = sh.rows || [];
    var maxCols = rows.reduce(function (m, r) { return Math.max(m, r.length); }, 1);
    var x = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'];
    x.push('<dimension ref="A1:' + col(maxCols - 1) + Math.max(rows.length, 1) + '"/>');
    if (sh.freezeRows) {
      x.push('<sheetViews><sheetView workbookViewId="0"><pane ySplit="' + sh.freezeRows + '" topLeftCell="A' + (sh.freezeRows + 1) + '" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>');
    }
    x.push('<sheetFormatPr defaultRowHeight="18"/>');
    if (sh.widths && sh.widths.length) {
      x.push('<cols>' + sh.widths.map(function (w, i) { return '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + Number(w || 10) + '" customWidth="1"/>'; }).join('') + '</cols>');
    }
    x.push('<sheetData>');
    rows.forEach(function (r, ri) {
      var cells = r.map(function (c, ci) { return cellXml(col(ci) + (ri + 1), c); }).join('');
      x.push('<row r="' + (ri + 1) + '">' + cells + '</row>');
    });
    x.push('</sheetData>');
    x.push('<pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/>');
    x.push('<pageSetup paperSize="9" orientation="' + (maxCols > 9 ? 'landscape' : 'portrait') + '"/>');
    x.push('</worksheet>');
    return x.join('');
  }

  var STYLES_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<numFmts count="0"/>' +
    '<fonts count="3"><font><sz val="11"/><name val="Tahoma"/></font><font><b/><sz val="11"/><name val="Tahoma"/></font><font><b/><sz val="14"/><name val="Tahoma"/></font></fonts>' +
    '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="FFE8EEF7"/><bgColor indexed="64"/></patternFill></fill></fills>' +
    '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>' +
    '<border><left style="thin"><color rgb="FFB7C0CE"/></left><right style="thin"><color rgb="FFB7C0CE"/></right><top style="thin"><color rgb="FFB7C0CE"/></top><bottom style="thin"><color rgb="FFB7C0CE"/></bottom><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="7">' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    '<xf numFmtId="49" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"/>' +
    '<xf numFmtId="49" fontId="1" fillId="2" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"><alignment wrapText="1" vertical="center"/></xf>' +
    '<xf numFmtId="49" fontId="2" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>' +
    '<xf numFmtId="2" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>' +
    '<xf numFmtId="49" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>' +
    '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';

  /** ชื่อชีต: ไม่เกิน 31 ตัว ห้าม [ ] : * ? / \ และไม่ซ้ำ */
  function sheetNames(sheets) {
    var used = {};
    return sheets.map(function (s, i) {
      var base = String(s.name || ('Sheet' + (i + 1))).replace(/[\[\]:*?\/\\]/g, '-').replace(/^'+|'+$/g, '').slice(0, 31) || ('Sheet' + (i + 1));
      var name = base, n = 2;
      while (used[name.toLowerCase()]) { var suf = ' (' + n++ + ')'; name = base.slice(0, 31 - suf.length) + suf; }
      used[name.toLowerCase()] = true;
      return name;
    });
  }

  function build(sheets, meta) {
    if (!sheets || !sheets.length) throw new Error('No sheets');
    meta = meta || {};
    var names = sheetNames(sheets);
    var u = function (s) { return Crypto.utf8(s); };
    var files = [];
    files.push({ name: '[Content_Types].xml', data: u('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      sheets.map(function (s, i) { return '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'; }).join('') +
      '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
      '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
      '</Types>') });
    files.push({ name: '_rels/.rels', data: u('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
      '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
      '</Relationships>') });
    files.push({ name: 'docProps/core.xml', data: u('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
      '<dc:title>' + esc(meta.title || '') + '</dc:title><dc:creator>' + esc(meta.creator || 'CWK Learning Hub') + '</dc:creator>' +
      (meta.created ? '<dcterms:created xsi:type="dcterms:W3CDTF">' + esc(meta.created) + '</dcterms:created>' : '') +
      '</cp:coreProperties>') });
    files.push({ name: 'docProps/app.xml', data: u('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>CWK Learning Hub</Application></Properties>') });
    files.push({ name: 'xl/workbook.xml', data: u('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheets>' + names.map(function (n, i) { return '<sheet name="' + esc(n) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>'; }).join('') + '</sheets></workbook>') });
    files.push({ name: 'xl/_rels/workbook.xml.rels', data: u('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      sheets.map(function (s, i) { return '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>'; }).join('') +
      '<Relationship Id="rId' + (sheets.length + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      '</Relationships>') });
    files.push({ name: 'xl/styles.xml', data: u(STYLES_XML) });
    sheets.forEach(function (s, i) { files.push({ name: 'xl/worksheets/sheet' + (i + 1) + '.xml', data: u(sheetXml(s)) }); });
    return zip(files);
  }

  return { build: build, zip: zip, crc32: crc32, sheetNames: sheetNames, col: col, MIME: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
})();
