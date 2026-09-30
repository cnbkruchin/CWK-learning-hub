/**
 * ชั้นเข้าถึงข้อมูลบน Google Sheets
 *
 * หลักการ
 * 1. อ่าน: ตารางเล็กอ่านทั้งตารางครั้งเดียวต่อคำขอ ตารางใหญ่ค้นด้วย TextFinder ตามคอลัมน์ idx
 * 2. เขียน: ทำใน Db.tx() เท่านั้น ใช้ LockService (script lock) ให้เขียนทีละธุรกรรม
 *    - ตรวจความถูกต้องทุกแถวก่อนเขียนจริง
 *    - ตรวจ version ของแถว (optimistic locking) เมื่อผู้เรียกส่ง expectedVersion
 *    - ธุรกรรมที่เขียนหลายช่วงจะบันทึก journal (ภาพก่อนแก้) ก่อนเขียน หากเขียนล้มเหลวจะคืนค่าทันที
 *      หากสคริปต์ถูกตัดกลางคัน ธุรกรรมถัดไปจะกู้คืนจาก journal ก่อนเริ่มทำงาน
 * 3. ทุกค่าเขียนเป็นข้อความโดยเติม ' นำหน้า (quote prefix) เพื่อให้ Sheets เก็บเป็นข้อความเสมอ
 *    รักษาเลขศูนย์นำหน้า และไม่ตีความข้อความที่ขึ้นต้นด้วย = + - @ เป็นสูตร
 * 4. ตารางที่ lockFree (append-only เช่น audit_log) เขียนด้วย appendRow ซึ่งเป็น atomic
 *    โดยไม่ต้องรอล็อก และห้ามเขียนตารางเหล่านี้ในธุรกรรม
 */
var Db = (function () {
  var ssMemo = {};
  var memo = {};
  var current = null;
  var testHooks = { beforeWrite: null };

  function props() {
    return PropertiesService.getScriptProperties();
  }

  function spreadsheet(db) {
    if (!ssMemo[db]) {
      var id = Props.get('DB_' + db.toUpperCase());
      if (!id) Errors.raise('SETUP_REQUIRED');
      ssMemo[db] = SpreadsheetApp.openById(id);
    }
    return ssMemo[db];
  }

  function info(name) {
    var m = memo[name];
    if (m && m.sheet) return m;
    var def = Schema.get(name);
    var sheet = spreadsheet(def.db).getSheetByName(name);
    if (!sheet) Errors.raise('SETUP_REQUIRED', 'ไม่พบตาราง ' + name + ' กรุณาให้ผู้ดูแลรัน setup');
    var lastCol = Math.max(sheet.getLastColumn(), 1);
    var header = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); });
    var col = {};
    header.forEach(function (h, i) { if (h && col[h] === undefined) col[h] = i; });
    def.fields.forEach(function (f) {
      if (col[f.name] === undefined) Errors.raise('DB_SCHEMA_MISMATCH', 'ตาราง ' + name + ' ไม่มีคอลัมน์ ' + f.name);
    });
    m = memo[name] = {
      name: name, def: def, sheet: sheet, header: header, col: col, ncol: header.length,
      all: null, byId: {}, staged: [], dirty: {}, q: {}
    };
    return m;
  }

  // ---------------- แปลงชนิดข้อมูล ----------------
  function serialize(f, v, tableName) {
    if (v === null || v === undefined || v === '') {
      if (f.type === 'bool') return 'FALSE';
      return '';
    }
    var s;
    switch (f.type) {
      case 'int':
        var n = Number(v);
        if (!isFinite(n) || Math.floor(n) !== n) Errors.raise('VALIDATION', f.name + ' ต้องเป็นจำนวนเต็ม', { field: f.name });
        s = String(n);
        break;
      case 'dec':
        try { s = Dec.normalize(v); } catch (e) { Errors.raise('VALIDATION', f.name + ' ต้องเป็นตัวเลข', { field: f.name }); }
        break;
      case 'bool':
        return (v === true || v === 'TRUE' || v === 'true' || v === 1 || v === '1') ? 'TRUE' : 'FALSE';
      case 'dt':
        s = Util.toIso(v);
        break;
      case 'date':
        s = String(v);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) Errors.raise('VALIDATION', f.name + ' ต้องเป็นวันที่รูปแบบ YYYY-MM-DD', { field: f.name });
        break;
      case 'json':
        s = typeof v === 'string' ? v : JSON.stringify(v);
        break;
      case 'enum':
        s = String(v);
        if (f.values.indexOf(s) < 0) Errors.raise('VALIDATION', f.name + ' มีค่าไม่ถูกต้อง: ' + s, { field: f.name });
        break;
      default:
        s = String(v);
    }
    var max = Math.min(f.max || APP.CELL_MAX_CHARS, APP.CELL_MAX_CHARS);
    if (s.length > max) Errors.raise('VALIDATION', (tableName || '') + '.' + f.name + ' ยาวเกิน ' + max + ' ตัวอักษร', { field: f.name });
    return s;
  }

  function parseCell(f, v) {
    var empty = v === '' || v === null || v === undefined;
    switch (f.type) {
      case 'int':
        if (empty) return f.def !== undefined ? f.def : null;
        return Number(v);
      case 'dec':
        if (empty) return '';
        try { return Dec.normalize(v); } catch (e) { return String(v); }
      case 'bool':
        if (empty) return f.def === true;
        return v === true || String(v).toUpperCase() === 'TRUE' || String(v) === '1';
      case 'dt':
        if (empty) return '';
        return v instanceof Date ? v.toISOString() : String(v);
      case 'json':
        if (empty) return null;
        try { return JSON.parse(String(v)); } catch (e) { return null; }
      default:
        if (empty) return '';
        if (v instanceof Date) return v.toISOString();
        return String(v);
    }
  }

  /** เติม ' นำหน้าข้อความทุกค่า เพื่อบังคับให้ Sheets เก็บเป็นข้อความ */
  function protect(v) {
    if (typeof v === 'string' && v !== '') return "'" + v;
    return v;
  }

  function makeObj(m, raw, rowNum) {
    var o = {};
    m.def.fields.forEach(function (f) { o[f.name] = parseCell(f, raw[m.col[f.name]]); });
    Object.defineProperty(o, '_row', { value: rowNum, enumerable: false, writable: true });
    Object.defineProperty(o, '_raw', { value: raw.slice(), enumerable: false, writable: true });
    return o;
  }

  function cacheRaw(m, raw, rowNum) {
    var id = String(raw[m.col.id]);
    if (m.byId[id]) return m.byId[id];
    var o = makeObj(m, raw, rowNum);
    m.byId[id] = o;
    return o;
  }

  // ---------------- อ่าน ----------------
  function loadAll(name) {
    var m = info(name);
    if (m.all) return m.all;
    var last = m.sheet.getLastRow();
    var rows = [];
    if (last >= 2) {
      var values = m.sheet.getRange(2, 1, last - 1, m.ncol).getValues();
      for (var i = 0; i < values.length; i++) {
        if (values[i][m.col.id] === '' || values[i][m.col.id] === null) continue;
        rows.push(cacheRaw(m, values[i], i + 2));
      }
    }
    m.staged.forEach(function (o) { if (rows.indexOf(o) < 0) rows.push(o); });
    m.all = rows;
    return rows;
  }

  function readRows(m, rowNums) {
    var nums = rowNums.slice().sort(function (a, b) { return a - b; })
      .filter(function (v, i, arr) { return i === 0 || arr[i - 1] !== v; });
    var out = [];
    var i = 0;
    while (i < nums.length) {
      var start = nums[i], end = start, j = i;
      while (j + 1 < nums.length && nums[j + 1] - end <= 20) { j++; end = nums[j]; }
      var values = m.sheet.getRange(start, 1, end - start + 1, m.ncol).getValues();
      for (var k = i; k <= j; k++) {
        var raw = values[nums[k] - start];
        if (raw[m.col.id] === '' || raw[m.col.id] === null) continue;
        out.push(cacheRaw(m, raw, nums[k]));
      }
      i = j + 1;
    }
    return out;
  }

  function sheetFind(m, field, value) {
    var key = field + '\u0000' + value;
    if (m.q[key]) return m.q[key];
    var last = m.sheet.getLastRow();
    if (last < 2) return (m.q[key] = []);
    var ranges = m.sheet.getRange(2, m.col[field] + 1, last - 1, 1)
      .createTextFinder(value).matchCase(true).matchEntireCell(true).findAll();
    var rows = readRows(m, ranges.map(function (r) { return r.getRow(); }));
    m.q[key] = rows;
    return rows;
  }

  function matches(row, where) {
    for (var k in where) {
      var exp = where[k];
      var val = row[k];
      if (typeof exp === 'function') { if (!exp(val, row)) return false; }
      else if (Array.isArray(exp)) {
        if (exp.map(String).indexOf(String(val)) < 0) return false;
      } else if (exp === null) {
        if (val !== '' && val !== null && val !== undefined) return false;
      } else if (String(val) !== String(exp)) return false;
    }
    return true;
  }

  function find(name, where) {
    var m = info(name);
    where = where || {};
    var candidates;
    if (m.all || m.def.size === 'small') {
      candidates = loadAll(name);
    } else {
      var key = null;
      for (var i = 0; i < m.def.idx.length; i++) {
        var k = m.def.idx[i];
        var v = where[k];
        if (v !== undefined && v !== null && v !== '' && typeof v !== 'function' && !Array.isArray(v)) { key = k; break; }
      }
      if (!key) {
        candidates = loadAll(name);
      } else {
        candidates = sheetFind(m, key, String(where[key])).slice();
        m.staged.forEach(function (o) { if (candidates.indexOf(o) < 0) candidates.push(o); });
        Object.keys(m.dirty).forEach(function (id) {
          var o = m.byId[id];
          if (o && candidates.indexOf(o) < 0) candidates.push(o);
        });
      }
    }
    return candidates.filter(function (r) { return matches(r, where); });
  }

  function get(name, id) {
    if (!id) return null;
    var m = info(name);
    if (m.byId[id]) return m.byId[id];
    if (m.all) return null;
    if (m.def.size === 'small') {
      loadAll(name);
      return m.byId[id] || null;
    }
    var rows = sheetFind(m, 'id', String(id));
    return rows[0] || null;
  }

  function reset(keepSheets) {
    if (!keepSheets) { memo = {}; ssMemo = {}; Props.reset(); return; }
    Object.keys(memo).forEach(function (n) {
      var m = memo[n];
      m.all = null; m.byId = {}; m.staged = []; m.dirty = {}; m.q = {};
    });
  }

  // ---------------- ธุรกรรม ----------------
  function Tx(name, actorId) {
    this.id = Util.uuid();
    this.name = name;
    this.actorId = actorId || '';
    this.now = Util.nowIso();
    this.ops = [];
    this.opIndex = {};
    this.after = [];
  }

  function validateRow(def, obj) {
    def.fields.forEach(function (f) {
      var v = obj[f.name];
      if (f.req && (v === '' || v === null || v === undefined)) {
        Errors.raise('VALIDATION', 'กรุณาระบุ ' + def.name + '.' + f.name, { field: f.name });
      }
      serialize(f, v, def.name);
    });
  }

  function checkUnique(txObj, def, obj) {
    def.unique.forEach(function (fields) {
      var where = {};
      var complete = true;
      fields.forEach(function (f) {
        if (obj[f] === '' || obj[f] === null || obj[f] === undefined) complete = false;
        where[f] = obj[f];
      });
      if (!complete) return;
      var dup = find(def.name, where).filter(function (r) { return r.id !== obj.id; });
      if (dup.length) {
        Errors.raise('DUPLICATE', 'ข้อมูลซ้ำ: ' + def.name + ' (' + fields.join(', ') + ')', { table: def.name, fields: fields });
      }
    });
  }

  Tx.prototype.get = function (name, id) { return get(name, id); };
  Tx.prototype.find = function (name, where) { return find(name, where); };
  Tx.prototype.one = function (name, where) { return find(name, where)[0] || null; };
  Tx.prototype.afterCommit = function (fn) { this.after.push(fn); };

  Tx.prototype.insert = function (name, data) {
    var m = info(name);
    if (m.def.lockFree) throw new Error('Table ' + name + ' is lock-free; use Db.append');
    var obj = {};
    m.def.fields.forEach(function (f) {
      var v = data[f.name];
      if ((v === undefined || v === '') && f.def !== undefined) v = f.def;
      obj[f.name] = v === undefined ? (f.type === 'bool' ? false : (f.type === 'int' ? null : '')) : v;
    });
    obj.id = data.id || Util.uuid();
    if (m.def.fieldMap.version) obj.version = 1;
    obj.created_at = this.now;
    obj.created_by = data.created_by || this.actorId;
    if (m.def.fieldMap.updated_at) { obj.updated_at = this.now; obj.updated_by = obj.created_by; }
    validateRow(m.def, obj);
    checkUnique(this, m.def, obj);
    Object.defineProperty(obj, '_row', { value: null, enumerable: false, writable: true });
    Object.defineProperty(obj, '_raw', { value: null, enumerable: false, writable: true });
    m.byId[obj.id] = obj;
    m.staged.push(obj);
    if (m.all) m.all.push(obj);
    this.ops.push({ type: 'insert', table: name, obj: obj });
    return obj;
  };

  /**
   * แก้ไขแถว
   * @param {Object=} opts { expectedVersion } ถ้ามีจะตรวจว่าแถวยังเป็นรุ่นเดิม มิฉะนั้นโยน CONFLICT
   */
  Tx.prototype.update = function (name, id, patch, opts) {
    var m = info(name);
    if (m.def.appendOnly || m.def.lockFree) throw new Error('Table ' + name + ' is append-only');
    var obj = get(name, id);
    if (!obj) Errors.raise('NOT_FOUND', 'ไม่พบข้อมูล ' + name);
    if (opts && opts.expectedVersion !== undefined && opts.expectedVersion !== null &&
      Number(obj.version) !== Number(opts.expectedVersion)) {
      Errors.raise('CONFLICT', null, { table: name, id: id, expected: opts.expectedVersion, actual: obj.version });
    }
    var key = name + ':' + obj.id;
    var isNew = m.staged.indexOf(obj) >= 0;
    if (!isNew && !this.opIndex[key]) {
      var before = {};
      m.def.fields.forEach(function (f) { before[f.name] = obj[f.name]; });
      var op = { type: 'update', table: name, obj: obj, before: before, raw: obj._raw };
      this.opIndex[key] = op;
      this.ops.push(op);
      m.dirty[obj.id] = true;
    }
    var uniqueTouched = false;
    Object.keys(patch).forEach(function (k) {
      if (!m.def.fieldMap[k] || k === 'id' || k === 'created_at' || k === 'created_by') return;
      obj[k] = patch[k];
      m.def.unique.forEach(function (u) { if (u.indexOf(k) >= 0) uniqueTouched = true; });
    });
    if (m.def.fieldMap.version && !isNew) obj.version = Number(obj.version || 0) + (this.opIndex[key].bumped ? 0 : 1);
    if (!isNew) this.opIndex[key].bumped = true;
    if (m.def.fieldMap.updated_at) { obj.updated_at = this.now; obj.updated_by = this.actorId || obj.updated_by; }
    validateRow(m.def, obj);
    if (uniqueTouched) checkUnique(this, m.def, obj);
    return obj;
  };

  function objToCells(m, obj, raw) {
    var cells = raw ? raw.slice() : new Array(m.ncol);
    for (var i = 0; i < m.ncol; i++) if (cells[i] === undefined || cells[i] === null) cells[i] = '';
    m.def.fields.forEach(function (f) { cells[m.col[f.name]] = serialize(f, obj[f.name], m.name); });
    return cells.map(protect);
  }

  function ensureRows(sheet, lastNeeded) {
    var max = sheet.getMaxRows();
    if (lastNeeded > max) sheet.insertRowsAfter(max, lastNeeded - max + 200);
  }

  function writeBlock(m, startRow, rows) {
    if (!rows.length) return;
    if (testHooks.beforeWrite) testHooks.beforeWrite(m.name, startRow, rows.length);
    ensureRows(m.sheet, startRow + rows.length - 1);
    m.sheet.getRange(startRow, 1, rows.length, m.ncol).setValues(rows);
  }

  function planWrites(t) {
    var plan = [];
    var byTable = {};
    t.ops.forEach(function (op) { (byTable[op.table] = byTable[op.table] || []).push(op); });
    Object.keys(byTable).forEach(function (name) {
      var m = info(name);
      var updates = byTable[name].filter(function (o) { return o.type === 'update'; })
        .sort(function (a, b) { return a.obj._row - b.obj._row; });
      var inserts = byTable[name].filter(function (o) { return o.type === 'insert'; });
      // รวมแถวที่ติดกันเป็นช่วงเดียว
      var i = 0;
      while (i < updates.length) {
        var j = i;
        while (j + 1 < updates.length && updates[j + 1].obj._row === updates[j].obj._row + 1) j++;
        plan.push({ m: m, start: updates[i].obj._row, ops: updates.slice(i, j + 1) });
        i = j + 1;
      }
      if (inserts.length) {
        var start = m.sheet.getLastRow() + 1;
        inserts.forEach(function (op, k) { op.obj._row = start + k; });
        plan.push({ m: m, start: start, ops: inserts, insert: true });
      }
    });
    return plan;
  }

  function writeJournal(t, plan) {
    var ops = [];
    plan.forEach(function (p) {
      p.ops.forEach(function (op) {
        if (op.type === 'insert') ops.push({ t: p.m.name, r: op.obj._row, id: op.obj.id });
        else ops.push({ t: p.m.name, r: op.obj._row, id: op.obj.id, b: objToCells(p.m, op.before, op.raw) });
      });
    });
    var payload = JSON.stringify(ops);
    var chunks = [];
    for (var i = 0; i < payload.length; i += 40000) chunks.push(payload.slice(i, i + 40000));
    var jm = info('tx_journal');
    var rows = chunks.map(function (c, seq) {
      return objToCells(jm, { id: Util.uuid(), tx_id: t.id, seq: seq, status: 'pending', name: t.name, payload: c, created_at: t.now });
    });
    var start = jm.sheet.getLastRow() + 1;
    ensureRows(jm.sheet, start + rows.length - 1);
    jm.sheet.getRange(start, 1, rows.length, jm.ncol).setValues(rows);
    props().setProperty('TX_PENDING', t.id);
    return { start: start, count: rows.length };
  }

  function markJournal(pos, status) {
    var jm = info('tx_journal');
    var col = jm.col.status + 1;
    var vals = [];
    for (var i = 0; i < pos.count; i++) vals.push([protect(status)]);
    jm.sheet.getRange(pos.start, col, pos.count, 1).setValues(vals);
  }

  function applyJournalOps(ops) {
    ops.slice().reverse().forEach(function (op) {
      var m = info(op.t);
      var range = m.sheet.getRange(op.r, 1, 1, m.ncol);
      var cur = range.getValues()[0];
      if (String(cur[m.col.id]) !== String(op.id) && cur[m.col.id] !== '') {
        console.warn('journal: row ' + op.t + '#' + op.r + ' has different id; skipped');
        return;
      }
      if (op.b) range.setValues([op.b]);
      else range.clearContent();
    });
  }

  function commit(t) {
    if (!t.ops.length) return;
    var plan = planWrites(t);
    var journal = null;
    // ช่วงเดียว = setValues ครั้งเดียว (atomic) ไม่ต้องใช้ journal
    if (plan.length > 1) journal = writeJournal(t, plan);
    var done = [];
    try {
      plan.forEach(function (p) {
        var rows = p.ops.map(function (op) { return objToCells(p.m, op.obj, op.obj._raw); });
        writeBlock(p.m, p.start, rows);
        done.push(p);
      });
    } catch (e) {
      // ย้อนกลับส่วนที่เขียนไปแล้ว
      try {
        done.reverse().forEach(function (p) {
          if (p.insert) {
            p.m.sheet.getRange(p.start, 1, p.ops.length, p.m.ncol).clearContent();
          } else {
            p.ops.forEach(function (op) {
              p.m.sheet.getRange(op.obj._row, 1, 1, p.m.ncol).setValues([objToCells(p.m, op.before, op.raw)]);
            });
          }
        });
        if (journal) { markJournal(journal, 'rolled_back'); props().deleteProperty('TX_PENDING'); }
      } catch (e2) {
        console.error('rollback failed; journal will recover on next transaction: ' + e2);
      }
      throw e;
    }
    if (journal) {
      markJournal(journal, 'committed');
      props().deleteProperty('TX_PENDING');
    }
    // อัปเดตภาพข้อมูลในหน่วยความจำให้ตรงกับที่เขียน
    t.ops.forEach(function (op) {
      var m = info(op.table);
      op.obj._raw = objToCells(m, op.obj, op.obj._raw).map(function (v) {
        return typeof v === 'string' && v.charAt(0) === "'" ? v.slice(1) : v;
      });
    });
    Object.keys(memo).forEach(function (n) { memo[n].staged = []; memo[n].dirty = {}; memo[n].q = {}; });
  }

  /** กู้คืนธุรกรรมที่ค้างจากการถูกตัดกลางคัน (เรียกภายใต้ล็อก) */
  function recoverPending() {
    var txId = props().getProperty('TX_PENDING');
    if (!txId) return null;
    var jm = info('tx_journal');
    var rows = sheetFind(jm, 'tx_id', txId).slice().sort(function (a, b) { return a.seq - b.seq; });
    if (rows.length && rows[0].status === 'pending') {
      var payload = rows.map(function (r) { return r.payload; }).join('');
      var ops = JSON.parse(payload);
      applyJournalOps(ops);
      var start = Math.min.apply(null, rows.map(function (r) { return r._row; }));
      markJournal({ start: start, count: rows.length }, 'rolled_back');
      console.warn('Recovered pending transaction ' + txId);
    }
    props().deleteProperty('TX_PENDING');
    SpreadsheetApp.flush();
    reset(true);
    return txId;
  }

  /**
   * รันฟังก์ชันภายใต้ธุรกรรม
   * @param {string} name ชื่อธุรกรรม (ใช้ในบันทึก)
   * @param {function(Tx):*} fn
   * @param {Object=} opts { actorId }
   */
  function tx(name, fn, opts) {
    if (current) return fn(current);
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(APP.LOCK_WAIT_MS)) Errors.raise('BUSY');
    var t, result, recovered;
    try {
      recovered = recoverPending();
      reset(true);
      t = new Tx(name, opts && opts.actorId);
      current = t;
      result = fn(t);
      commit(t);
      SpreadsheetApp.flush();
    } catch (e) {
      reset(true);
      throw e;
    } finally {
      current = null;
      lock.releaseLock();
    }
    if (recovered) {
      try { Audit.system('tx_recovered', 'tx_journal', recovered, {}); } catch (e) { console.error(e); }
    }
    t.after.forEach(function (fn2) {
      try { fn2(); } catch (e) { console.error('afterCommit failed: ' + (e && e.stack || e)); }
    });
    return result;
  }

  /** เพิ่มแถวในตาราง lockFree ด้วย appendRow (ไม่ต้องรอล็อก) */
  function append(name, data, actorId) {
    var m = info(name);
    if (!m.def.lockFree) throw new Error('Table ' + name + ' is not lock-free');
    var obj = {};
    m.def.fields.forEach(function (f) { obj[f.name] = data[f.name] !== undefined ? data[f.name] : ''; });
    obj.id = data.id || Util.uuid();
    obj.created_at = Util.nowIso();
    obj.created_by = data.created_by || actorId || '';
    validateRow(m.def, obj);
    m.sheet.appendRow(objToCells(m, obj, null));
    if (m.all) m.all = null;
    m.q = {};
    return obj;
  }

  return {
    get: get,
    find: find,
    one: function (name, where) { return find(name, where)[0] || null; },
    all: loadAll,
    tx: tx,
    append: append,
    reset: reset,
    info: info,
    inTx: function () { return !!current; },
    protect: protect,
    serialize: serialize,
    _testHooks: testHooks,
    /** ลบแถวเก่าของตารางเทคนิค (tx_journal) — ใช้โดยงานบำรุงรักษาเท่านั้น */
    _pruneTechnical: function (name, olderThanIso) {
      var m = info(name);
      if (!m.def.technical) throw new Error('Only technical tables can be pruned');
      var rows = loadAll(name).filter(function (r) { return r.created_at && r.created_at < olderThanIso && r.status !== 'pending'; });
      var nums = rows.map(function (r) { return r._row; }).sort(function (a, b) { return b - a; });
      nums.forEach(function (n) { m.sheet.deleteRow(n); });
      reset(true);
      return nums.length;
    }
  };
})();
