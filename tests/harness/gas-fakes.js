'use strict';
/**
 * บริการจำลองของ Google Apps Script สำหรับทดสอบบน Node.js
 *
 * จำลองพฤติกรรมที่สำคัญต่อความถูกต้อง:
 * - Sheets: เซลล์รูปแบบ Automatic แปลง "00123" เป็นตัวเลข, "TRUE" เป็น boolean, "=..." เป็นสูตร
 *   เว้นแต่ขึ้นต้นด้วย ' (quote prefix) — ใช้จับบั๊กการเขียนข้อความที่ไม่ป้องกัน
 * - getRange นอกขนาดชีตโยน error เหมือนของจริง
 * - Drive resumable upload (POST/PUT Content-Range/308), Range GET และ metadata sha256Checksum
 * ไม่ได้จำลอง: โควตา เวลาเรียกบริการ การทำงานพร้อมกันจริงหลาย execution
 */
const nodeCrypto = require('crypto');

function toSigned(buf) {
  const out = new Array(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = buf[i] > 127 ? buf[i] - 256 : buf[i];
  return out;
}
function toBuf(bytes) {
  if (typeof bytes === 'string') return Buffer.from(bytes, 'utf8');
  return Buffer.from(Array.from(bytes, (b) => b & 0xff));
}

function createFakes(opts = {}) {
  let idSeq = 0;
  const nextId = (p) => `${p}_${(++idSeq).toString(36)}_${nodeCrypto.randomBytes(4).toString('hex')}`;
  const stats = { formulaWrites: [], coercions: 0, sheetCalls: 0 };

  // ---------------- Sheets ----------------
  function storeValue(v) {
    if (typeof v === 'string') {
      if (v.startsWith("'")) return v.slice(1);
      if (v.startsWith('=')) { stats.formulaWrites.push(v); return { formula: v }; }
      if (/^[+-]?\d+(\.\d+)?$/.test(v)) { stats.coercions++; return Number(v); }
      if (/^(true|false)$/i.test(v)) { stats.coercions++; return v.toLowerCase() === 'true'; }
      if (/^\d{4}-\d{2}-\d{2}(T|$)/.test(v)) { stats.coercions++; return new Date(v); }
      return v;
    }
    if (v === null || v === undefined) return '';
    return v;
  }
  function display(v) {
    if (v === '' || v === null || v === undefined) return '';
    if (v instanceof Date) return v.toISOString();
    if (typeof v === 'object' && v.formula) return v.formula;
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    return String(v);
  }

  class FakeRange {
    constructor(sheet, row, col, nr, nc) {
      if (row < 1 || col < 1 || nr < 1 || nc < 1) throw new Error('Invalid range dimensions');
      if (row + nr - 1 > sheet.maxRows || col + nc - 1 > sheet.maxCols) {
        throw new Error('The coordinates of the range are outside the dimensions of the sheet.');
      }
      Object.assign(this, { sheet, row, col, nr, nc });
    }
    getRow() { return this.row; }
    getColumn() { return this.col; }
    getNumRows() { return this.nr; }
    getValues() {
      stats.sheetCalls++;
      const out = [];
      for (let r = 0; r < this.nr; r++) {
        const src = this.sheet.data[this.row - 1 + r] || [];
        const row = [];
        for (let c = 0; c < this.nc; c++) {
          const v = src[this.col - 1 + c];
          row.push(v === undefined ? '' : (typeof v === 'object' && v && v.formula ? v.formula : v));
        }
        out.push(row);
      }
      return out;
    }
    setValues(vals) {
      stats.sheetCalls++;
      if (this.sheet.failNextWrite) {
        const f = this.sheet.failNextWrite; this.sheet.failNextWrite = null;
        throw new Error(f === true ? 'Simulated write failure' : f);
      }
      if (vals.length !== this.nr || vals.some((r) => r.length !== this.nc)) {
        throw new Error(`The number of rows/columns in the data does not match the range (${vals.length}x${vals[0] && vals[0].length} vs ${this.nr}x${this.nc})`);
      }
      for (let r = 0; r < this.nr; r++) {
        const idx = this.row - 1 + r;
        this.sheet.data[idx] = this.sheet.data[idx] || [];
        for (let c = 0; c < this.nc; c++) this.sheet.data[idx][this.col - 1 + c] = storeValue(vals[r][c]);
      }
      return this;
    }
    setValue(v) { return this.setValues([[v]]); }
    getValue() { return this.getValues()[0][0]; }
    clearContent() {
      for (let r = 0; r < this.nr; r++) {
        const row = this.sheet.data[this.row - 1 + r];
        if (!row) continue;
        for (let c = 0; c < this.nc; c++) row[this.col - 1 + c] = '';
      }
      return this;
    }
    createTextFinder(text) {
      const range = this;
      const tf = {
        _case: false, _entire: false,
        matchCase(b) { this._case = b; return this; },
        matchEntireCell(b) { this._entire = b; return this; },
        findAll() {
          stats.sheetCalls++;
          const out = [];
          for (let r = 0; r < range.nr; r++) {
            for (let c = 0; c < range.nc; c++) {
              const row = range.sheet.data[range.row - 1 + r] || [];
              let d = display(row[range.col - 1 + c]);
              let t = String(text);
              if (!this._case) { d = d.toLowerCase(); t = t.toLowerCase(); }
              if (this._entire ? d === t : d.includes(t)) {
                out.push(new FakeRange(range.sheet, range.row + r, range.col + c, 1, 1));
              }
            }
          }
          return out;
        }
      };
      return tf;
    }
    setNumberFormat() { return this; }
    setFontWeight() { return this; }
    setBackground() { return this; }
    setWrap() { return this; }
    protect() { return { setWarningOnly() { return this; }, setDescription() { return this; } }; }
  }

  class FakeSheet {
    constructor(ss, name) {
      Object.assign(this, { ss, name, data: [], maxRows: 1000, maxCols: 26, frozen: 0, failNextWrite: null });
    }
    getName() { return this.name; }
    setName(n) { this.name = n; return this; }
    getParent() { return this.ss; }
    getMaxRows() { return this.maxRows; }
    getMaxColumns() { return this.maxCols; }
    insertRowsAfter(after, n) { this.maxRows += n; return this; }
    insertColumnsAfter(after, n) { this.maxCols += n; return this; }
    getLastRow() {
      for (let r = this.data.length - 1; r >= 0; r--) {
        const row = this.data[r];
        if (row && row.some((v) => v !== '' && v !== null && v !== undefined)) return r + 1;
      }
      return 0;
    }
    getLastColumn() {
      let max = 0;
      this.data.forEach((row) => {
        if (!row) return;
        for (let c = row.length - 1; c >= 0; c--) {
          if (row[c] !== '' && row[c] !== undefined && row[c] !== null) { max = Math.max(max, c + 1); break; }
        }
      });
      return max;
    }
    getRange(row, col, nr = 1, nc = 1) { return new FakeRange(this, row, col, nr, nc); }
    getDataRange() { return new FakeRange(this, 1, 1, Math.max(1, this.getLastRow()), Math.max(1, this.getLastColumn())); }
    appendRow(values) {
      stats.sheetCalls++;
      const r = this.getLastRow() + 1;
      if (r > this.maxRows) this.maxRows = r;
      if (values.length > this.maxCols) this.maxCols = values.length;
      this.data[r - 1] = values.map(storeValue);
      return this;
    }
    deleteRow(n) { this.data.splice(n - 1, 1); this.maxRows--; return this; }
    setFrozenRows(n) { this.frozen = n; return this; }
    setTabColor() { return this; }
    protect() { return { setWarningOnly() { return this; }, setDescription() { return this; } }; }
    autoResizeColumns() { return this; }
  }

  const spreadsheets = {};
  class FakeSpreadsheet {
    constructor(name) {
      this.id = nextId('ss');
      this.name = name;
      this.sheets = [new FakeSheet(this, 'Sheet1')];
      spreadsheets[this.id] = this;
      drive.registerFile({ id: this.id, name, mime: 'application/vnd.google-apps.spreadsheet', bytes: Buffer.alloc(0), spreadsheet: this });
    }
    getId() { return this.id; }
    getName() { return this.name; }
    getUrl() { return `https://docs.google.com/spreadsheets/d/${this.id}`; }
    getSheetByName(n) { return this.sheets.find((s) => s.name === n) || null; }
    getSheets() { return this.sheets.slice(); }
    insertSheet(n) {
      if (this.getSheetByName(n)) throw new Error('Sheet exists: ' + n);
      const s = new FakeSheet(this, n); this.sheets.push(s); return s;
    }
    deleteSheet(s) { this.sheets = this.sheets.filter((x) => x !== s); }
    setSpreadsheetTimeZone() { return this; }
  }

  const SpreadsheetApp = {
    create: (name) => new FakeSpreadsheet(name),
    openById: (id) => {
      const ss = spreadsheets[id];
      if (!ss) throw new Error('Spreadsheet not found: ' + id);
      return ss;
    },
    flush: () => {},
    _all: spreadsheets
  };

  // ---------------- Drive ----------------
  const drive = {
    files: {},
    folders: {},
    storageUsed: 0,
    registerFile(f) {
      const file = new FakeFile(f);
      this.files[file.id] = file;
      if (!file.parent) file.parent = rootFolder;
      return file;
    }
  };
  class FakeIterator {
    constructor(items) { this.items = items; this.i = 0; }
    hasNext() { return this.i < this.items.length; }
    next() { if (!this.hasNext()) throw new Error('No more items'); return this.items[this.i++]; }
  }
  class FakeFolder {
    constructor(name, parent) {
      this.id = nextId('fld'); this.name = name; this.parent = parent || null; this.trashed = false;
      drive.folders[this.id] = this;
    }
    getId() { return this.id; }
    getName() { return this.name; }
    setName(n) { this.name = n; return this; }
    createFolder(name) { return new FakeFolder(name, this); }
    getFoldersByName(name) {
      return new FakeIterator(Object.values(drive.folders).filter((f) => f.parent === this && f.name === name && !f.trashed));
    }
    getFolders() { return new FakeIterator(Object.values(drive.folders).filter((f) => f.parent === this && !f.trashed)); }
    getFiles() { return new FakeIterator(Object.values(drive.files).filter((f) => f.parent === this && !f.trashed)); }
    getFilesByName(name) { return new FakeIterator(Object.values(drive.files).filter((f) => f.parent === this && f.name === name && !f.trashed)); }
    createFile(blob) {
      return drive.registerFile({ id: nextId('file'), name: blob.getName() || 'untitled', mime: blob.getContentType(), bytes: toBuf(blob.getBytes()), parent: this });
    }
    setTrashed(b) { this.trashed = b; return this; }
    isTrashed() { return this.trashed; }
    getParents() { return new FakeIterator(this.parent ? [this.parent] : []); }
    moveTo(folder) { this.parent = folder; return this; }
    setSharing() { throw new Error('Sharing must not be changed by the app'); }
  }
  class FakeFile {
    constructor({ id, name, mime, bytes, parent, spreadsheet }) {
      Object.assign(this, { id: id || nextId('file'), name, mime, bytes: bytes || Buffer.alloc(0), parent, spreadsheet, trashed: false, description: '' });
      this.createdAt = new Date();
    }
    getId() { return this.id; }
    getName() { return this.name; }
    setName(n) { this.name = n; return this; }
    getSize() { return this.bytes.length; }
    getMimeType() { return this.mime; }
    getDateCreated() { return this.createdAt; }
    getParents() { return new FakeIterator(this.parent ? [this.parent] : []); }
    moveTo(folder) {
      if (drive.failNextMove) { drive.failNextMove = false; throw new Error('Simulated Drive move failure'); }
      this.parent = folder; return this;
    }
    setTrashed(b) { this.trashed = b; return this; }
    isTrashed() { return this.trashed; }
    setDescription(d) { this.description = d; return this; }
    getBlob() { return Utilities.newBlob(toSigned(this.bytes), this.mime, this.name); }
    makeCopy(name, folder) {
      const copy = drive.registerFile({ name, mime: this.mime, bytes: Buffer.from(this.bytes), parent: folder || this.parent });
      if (this.spreadsheet) {
        const ss = new FakeSpreadsheet(name);
        ss.sheets = this.spreadsheet.sheets.map((s) => { const n = new FakeSheet(ss, s.name); n.data = JSON.parse(JSON.stringify(s.data)); n.maxRows = s.maxRows; return n; });
        delete drive.files[ss.id];
        copy.spreadsheet = ss;
        delete spreadsheets[ss.id];
        ss.id = copy.id;
        spreadsheets[copy.id] = ss;
      }
      return copy;
    }
    setSharing() { throw new Error('Sharing must not be changed by the app'); }
  }
  const rootFolder = new FakeFolder('My Drive', null);
  const DriveApp = {
    getRootFolder: () => rootFolder,
    createFolder: (name) => new FakeFolder(name, rootFolder),
    getFolderById: (id) => { const f = drive.folders[id]; if (!f) throw new Error('Folder not found'); return f; },
    getFileById: (id) => { const f = drive.files[id]; if (!f) throw new Error('File not found: ' + id); return f; },
    getStorageUsed: () => Object.values(drive.files).reduce((s, f) => s + f.bytes.length, 0),
    getStorageLimit: () => opts.storageLimit || 15 * 1024 * 1024 * 1024,
    Access: { ANYONE: 'ANYONE', PRIVATE: 'PRIVATE' },
    Permission: { VIEW: 'VIEW', NONE: 'NONE' },
    _drive: drive
  };

  // ---------------- UrlFetch (Drive REST API) ----------------
  const uploads = {};
  function response(code, body, headers = {}) {
    const content = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body || {}));
    return {
      getResponseCode: () => code,
      getHeaders: () => headers,
      getAllHeaders: () => headers,
      getContentText: () => content.toString('utf8'),
      getContent: () => toSigned(content),
      getBlob: () => Utilities.newBlob(toSigned(content))
    };
  }
  function fileMeta(f) {
    const meta = {
      id: f.id, name: f.name, mimeType: f.mime, size: String(f.bytes.length),
      md5Checksum: nodeCrypto.createHash('md5').update(f.bytes).digest('hex')
    };
    if (!opts.omitSha256) meta.sha256Checksum = nodeCrypto.createHash('sha256').update(f.bytes).digest('hex');
    return meta;
  }
  const fetchLog = [];
  const UrlFetchApp = {
    _log: fetchLog,
    _failNext: null,
    fetch(url, params = {}) {
      const method = (params.method || 'get').toUpperCase();
      const headers = params.headers || {};
      fetchLog.push({ method, url, headers });
      if (!headers.Authorization || !/^Bearer /.test(headers.Authorization)) return response(401, { error: 'unauthorized' });
      if (UrlFetchApp._failNext) {
        const f = UrlFetchApp._failNext; UrlFetchApp._failNext = null;
        if (f === 'throw') throw new Error('Simulated network error');
        return response(f, { error: 'simulated' });
      }
      let m;
      if (method === 'POST' && /\/upload\/drive\/v3\/files\?uploadType=resumable/.test(url)) {
        const meta = JSON.parse(params.payload);
        const sid = nextId('up');
        uploads[sid] = { meta, total: Number(headers['X-Upload-Content-Length']), bytes: Buffer.alloc(0), done: null };
        return response(200, '', { Location: `https://fake-upload.local/session/${sid}` });
      }
      if (method === 'PUT' && (m = url.match(/fake-upload\.local\/session\/(\w+)/))) {
        const u = uploads[m[1]];
        if (!u) return response(404, { error: 'session not found' });
        const cr = headers['Content-Range'];
        if (/^bytes \*\//.test(cr)) {
          if (u.done) return response(200, fileMeta(u.done));
          return response(308, '', u.bytes.length ? { Range: `bytes=0-${u.bytes.length - 1}` } : {});
        }
        const mm = cr.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
        if (!mm) return response(400, { error: 'bad content-range' });
        const start = Number(mm[1]); const end = Number(mm[2]);
        const chunk = toBuf(params.payload);
        if (chunk.length !== end - start + 1) return response(400, { error: 'length mismatch' });
        if (start !== u.bytes.length) return response(400, { error: 'out of order' });
        if (end + 1 < u.total && (chunk.length % (256 * 1024)) !== 0) return response(400, { error: 'chunk not multiple of 256KiB' });
        u.bytes = Buffer.concat([u.bytes, chunk]);
        if (u.bytes.length === u.total) {
          const parent = drive.folders[u.meta.parents[0]];
          const f = drive.registerFile({ name: u.meta.name, mime: u.meta.mimeType, bytes: u.bytes, parent });
          f.description = u.meta.description || '';
          u.done = f;
          return response(200, fileMeta(f));
        }
        return response(308, '', { Range: `bytes=0-${u.bytes.length - 1}` });
      }
      if (method === 'GET' && (m = url.match(/\/drive\/v3\/files\/([\w-]+)\?(.*)$/))) {
        const f = drive.files[m[1]];
        if (!f) return response(404, { error: 'not found' });
        if (/alt=media/.test(m[2])) {
          const rg = (headers.Range || '').match(/^bytes=(\d+)-(\d+)$/);
          if (!rg) return response(200, f.bytes);
          const s = Number(rg[1]); const e = Math.min(Number(rg[2]), f.bytes.length - 1);
          return response(206, f.bytes.subarray(s, e + 1));
        }
        return response(200, fileMeta(f));
      }
      return response(404, { error: 'unknown endpoint ' + method + ' ' + url });
    }
  };

  // ---------------- Lock / Cache / Properties ----------------
  const lockState = { held: false, busy: false, acquired: 0 };
  const LockService = {
    _state: lockState,
    getScriptLock() {
      return {
        tryLock() { if (lockState.busy || lockState.held) return false; lockState.held = true; lockState.acquired++; return true; },
        waitLock() { if (!this.tryLock()) throw new Error('Lock timeout'); },
        releaseLock() { lockState.held = false; },
        hasLock() { return lockState.held; }
      };
    }
  };
  function makeCache() {
    const m = new Map();
    return {
      _map: m,
      get: (k) => (m.has(k) ? m.get(k) : null),
      put: (k, v) => { if (String(v).length > 100 * 1024) throw new Error('Cache value too large'); m.set(k, String(v)); },
      remove: (k) => m.delete(k),
      getAll: (keys) => { const o = {}; keys.forEach((k) => { if (m.has(k)) o[k] = m.get(k); }); return o; },
      putAll: (o) => Object.keys(o).forEach((k) => m.set(k, String(o[k]))),
      removeAll: (keys) => keys.forEach((k) => m.delete(k))
    };
  }
  const scriptCache = makeCache();
  const CacheService = { getScriptCache: () => scriptCache, getUserCache: () => scriptCache, getDocumentCache: () => null };
  const propStore = {};
  const scriptProps = {
    getProperty: (k) => (k in propStore ? propStore[k] : null),
    setProperty: (k, v) => { propStore[k] = String(v); return scriptProps; },
    deleteProperty: (k) => { delete propStore[k]; return scriptProps; },
    getProperties: () => Object.assign({}, propStore),
    setProperties: (o) => { Object.keys(o).forEach((k) => { propStore[k] = String(o[k]); }); return scriptProps; }
  };
  const PropertiesService = { getScriptProperties: () => scriptProps, getUserProperties: () => scriptProps };

  // ---------------- Utilities ----------------
  class FakeBlob {
    constructor(data, type, name) {
      this.buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : toBuf(data || []);
      this.type = type || 'application/octet-stream';
      this.name = name || '';
    }
    getBytes() { return toSigned(this.buf); }
    getDataAsString() { return this.buf.toString('utf8'); }
    getContentType() { return this.type; }
    setContentType(t) { this.type = t; return this; }
    getName() { return this.name; }
    setName(n) { this.name = n; return this; }
  }
  const Utilities = {
    DigestAlgorithm: { SHA_256: 'sha256', MD5: 'md5', SHA_1: 'sha1' },
    Charset: { UTF_8: 'utf8' },
    getUuid: () => nodeCrypto.randomUUID(),
    base64Encode: (b) => toBuf(b).toString('base64'),
    base64EncodeWebSafe: (b) => toBuf(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
    base64Decode: (s) => toSigned(Buffer.from(s, 'base64')),
    base64DecodeWebSafe: (s) => toSigned(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')),
    computeDigest: (alg, data) => toSigned(nodeCrypto.createHash(alg).update(toBuf(data)).digest()),
    newBlob: (data, type, name) => new FakeBlob(data, type, name),
    sleep: () => {},
    formatDate(date, tz, fmt) {
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
      }).formatToParts(date).reduce((o, p) => { o[p.type] = p.value; return o; }, {});
      return fmt.replace('yyyy', parts.year).replace('MM', parts.month).replace('dd', parts.day)
        .replace('HH', parts.hour).replace('mm', parts.minute).replace('ss', parts.second);
    }
  };
  // Utilities.newBlob(string) ต้องได้ bytes UTF-8
  const Session = {
    _active: opts.activeUser === undefined ? 'owner@example.com' : opts.activeUser,
    _effective: 'owner@example.com',
    getActiveUser: () => ({ getEmail: () => Session._active }),
    getEffectiveUser: () => ({ getEmail: () => Session._effective }),
    getScriptTimeZone: () => 'Asia/Bangkok',
    getTemporaryActiveUserKey: () => 'tmpkey'
  };
  const triggers = [];
  const ScriptApp = {
    getOAuthToken: () => 'fake-oauth-token',
    getScriptId: () => 'script_1',
    getProjectTriggers: () => triggers.slice(),
    deleteTrigger: (t) => { const i = triggers.indexOf(t); if (i >= 0) triggers.splice(i, 1); },
    newTrigger(fn) {
      const t = { fn, uid: String(100000 + triggers.length), getHandlerFunction: () => fn, getUniqueId() { return this.uid; } };
      const b = {
        timeBased: () => b, everyHours: () => b, everyDays: () => b, atHour: () => b, nearMinute: () => b, inTimezone: () => b,
        create: () => { triggers.push(t); return t; }
      };
      return b;
    },
    WeekDay: {}
  };
  const HtmlService = {
    XFrameOptionsMode: { DEFAULT: 'DEFAULT', ALLOWALL: 'ALLOWALL' },
    SandboxMode: { IFRAME: 'IFRAME' },
    createTemplateFromFile: (name) => {
      const out = { title: '', setTitle(t) { this.title = t; return this; }, addMetaTag() { return this; }, setXFrameOptionsMode() { return this; }, setFaviconUrl() { return this; }, getContent: () => '<html></html>' };
      return { evaluate: () => out, name };
    },
    createHtmlOutputFromFile: (name) => ({ getContent: () => `<!-- ${name} -->` }),
    createHtmlOutput: (s) => ({ getContent: () => s })
  };
  const Logger = { log: () => {} };

  return {
    SpreadsheetApp, DriveApp, UrlFetchApp, LockService, CacheService, PropertiesService,
    Utilities, Session, ScriptApp, HtmlService, Logger,
    _stats: stats, _drive: drive, _spreadsheets: spreadsheets, _uploads: uploads, _triggers: triggers
  };
}

module.exports = { createFakes, toSigned, toBuf };
