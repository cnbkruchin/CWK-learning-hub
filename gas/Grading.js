/**
 * โมดูลคำนวณคะแนน (แหล่งเดียวที่หน้าจอ รายงาน PDF และ XLSX ต้องเรียกใช้)
 *
 * ชื่อย่อ: score = คะแนนที่ยืนยันแล้ว, max = คะแนนเต็ม, weight = น้ำหนัก, ratio = score / max
 * - คำนวณด้วยเศษส่วนแม่นยำ (Dec.R) ไม่ปัดระหว่างทาง ปัด half up ครั้งเดียวตอนสรุป (ค่าเริ่มต้น 2 ตำแหน่ง)
 * - วิธีรายรายการ: Σ(weight × ratio) / Σ(weight ที่นับ) × 100
 * - วิธีรายหมวด: ratio หมวด = Σ(น้ำหนักภายใน × ratio) / Σ(น้ำหนักภายในที่นับ) แล้วถ่วงน้ำหนักหมวดและปรับเป็น 100
 * - ยกเว้น (excused) ตัดออกจากตัวหารของคนนั้น; หมวดที่ถูกยกเว้นทั้งหมดถูกตัดและปรับน้ำหนักหมวดที่เหลือ
 * - ไม่มีรายการที่นับเหลือเลย → "ไม่มีฐานคะแนนสำหรับสรุปผล" (ไม่หารศูนย์ ไม่ออกเกรด)
 * - ยังประเมินไม่ครบ → คะแนนสะสมบนฐาน 100 (ส่วนที่ยังไม่ประเมินยังอยู่ในฐาน แต่ไม่บันทึกเป็นศูนย์) + ป้าย "ยังไม่ครบ"
 */
var Grading = (function () {
  var R = Dec.R;
  var HUNDRED = R.int(100);
  var PENDING = ['not_assessed', 'missing', 'needs_revision'];
  var LABELS = {
    complete: 'ครบ', incomplete: 'ยังไม่ครบ', no_base: 'ไม่มีฐานคะแนนสำหรับสรุปผล'
  };

  function d(v) { return R.of(v); }

  function innerWeight(cat, item) {
    var mode = cat.innerMode || 'equal';
    if (mode === 'by_max') return d(item.max);
    if (mode === 'custom') return d(item.innerWeight);
    return R.int(1);
  }

  function statusOf(grades, id) {
    var g = grades[id];
    return g ? g : { status: 'not_assessed' };
  }

  function bandFor(bands, value) {
    if (!bands || !bands.length) return null;
    var v = d(value);
    var sorted = bands.slice().sort(function (a, b) { return R.cmp(d(b.min), d(a.min)); });
    for (var i = 0; i < sorted.length; i++) {
      var b = sorted[i];
      var isTop = i === 0;
      var geMin = R.cmp(v, d(b.min)) >= 0;
      var ltMax = isTop ? R.cmp(v, d(b.max)) <= 0 : R.cmp(v, d(b.max)) < 0;
      if (geMin && ltMax) return { label: b.label, point: b.point };
    }
    return null;
  }

  /**
   * @param {{method:string, digits:?number, bands:?Array, categories:?Array, items:Array, grades:Object}} input
   *   items: [{id, categoryId, max, weight, innerWeight, counts}]
   *   grades: { itemId: {status:'scored'|'not_assessed'|'missing'|'excused'|'needs_revision', score:'16'} }
   */
  function compute(input) {
    var digits = input.digits === undefined || input.digits === null ? 2 : input.digits;
    var grades = input.grades || {};
    var items = (input.items || []).filter(function (it) { return it.counts !== false; });
    var blockers = [];
    var num = R.zero(), den = R.zero(), assessed = R.zero();

    if (input.method === 'per_category') {
      (input.categories || []).forEach(function (cat) {
        var catItems = items.filter(function (it) { return it.categoryId === cat.id; });
        var cNum = R.zero(), cDen = R.zero(), cAssessed = R.zero();
        catItems.forEach(function (it) {
          var g = statusOf(grades, it.id);
          if (g.status === 'excused') return;
          var w = innerWeight(cat, it);
          if (R.isZero(w)) return;
          cDen = R.add(cDen, w);
          if (g.status === 'scored') {
            cNum = R.add(cNum, R.mul(w, R.div(d(g.score), d(it.max))));
            cAssessed = R.add(cAssessed, w);
          } else {
            blockers.push({ itemId: it.id, status: g.status });
          }
        });
        if (R.isZero(cDen)) return; // หมวดไม่มีรายการที่นับ → ตัดหมวด
        var cw = d(cat.weight);
        if (R.isZero(cw)) return;
        num = R.add(num, R.mul(cw, R.div(cNum, cDen)));
        assessed = R.add(assessed, R.mul(cw, R.div(cAssessed, cDen)));
        den = R.add(den, cw);
      });
    } else {
      items.forEach(function (it) {
        var w = d(it.weight || 0);
        if (R.isZero(w)) return;
        var g = statusOf(grades, it.id);
        if (g.status === 'excused') return;
        den = R.add(den, w);
        if (g.status === 'scored') {
          num = R.add(num, R.mul(w, R.div(d(g.score), d(it.max))));
          assessed = R.add(assessed, w);
        } else {
          blockers.push({ itemId: it.id, status: g.status });
        }
      });
    }

    if (R.isZero(den)) {
      return { status: 'no_base', label: LABELS.no_base, final: null, provisional: null, assessedWeightPct: null, grade: null, blockers: [] };
    }
    var total = R.mul(R.div(num, den), HUNDRED);
    var rounded = R.toFixed(total, digits);
    var pct = R.toFixed(R.mul(R.div(assessed, den), HUNDRED), 2);
    if (blockers.length) {
      return { status: 'incomplete', label: LABELS.incomplete, final: null, provisional: rounded, assessedWeightPct: pct, grade: null, blockers: blockers };
    }
    return { status: 'complete', label: LABELS.complete, final: rounded, provisional: null, assessedWeightPct: pct, grade: bandFor(input.bands, rounded), blockers: [] };
  }

  /** คะแนนคิดน้ำหนักของรายการเดียว เช่น 16/20 น้ำหนัก 10 → "8.00" */
  function weighted(score, max, weight, digits) {
    return R.toFixed(R.mul(R.div(d(score), d(max)), d(weight)), digits === undefined ? 2 : digits);
  }

  /** ตรวจแผนคะแนนก่อนเปิดใช้/ปิดผล คืนรายการจุดที่ต้องแก้ (ไม่ปรับน้ำหนักให้เงียบ ๆ) */
  function validatePlan(method, categories, items) {
    var errors = [];
    var counted = items.filter(function (it) { return it.counts !== false; });
    counted.forEach(function (it) {
      if (!Dec.isValid(it.max) || R.cmp(d(it.max), R.zero()) <= 0) errors.push({ itemId: it.id, message: 'รายการที่นับคะแนนต้องมีคะแนนเต็มมากกว่า 0' });
    });
    if (method === 'per_category') {
      var sum = R.zero();
      (categories || []).forEach(function (c) {
        if (!Dec.isValid(c.weight) || R.cmp(d(c.weight), R.zero()) <= 0) errors.push({ categoryId: c.id, message: 'น้ำหนักหมวดต้องเป็นบวก' });
        else sum = R.add(sum, d(c.weight));
        if (c.innerMode === 'custom') {
          counted.filter(function (it) { return it.categoryId === c.id; }).forEach(function (it) {
            if (!Dec.isValid(it.innerWeight) || R.cmp(d(it.innerWeight), R.zero()) <= 0) errors.push({ itemId: it.id, message: 'น้ำหนักภายในหมวดต้องเป็นบวก' });
          });
        }
      });
      counted.forEach(function (it) {
        if (!(categories || []).some(function (c) { return c.id === it.categoryId; })) errors.push({ itemId: it.id, message: 'ยังไม่ได้เลือกหมวด' });
      });
      if (R.cmp(sum, HUNDRED) !== 0) errors.push({ message: 'น้ำหนักหมวดรวม ' + R.toFixed(sum, 2) + ' ต้องเท่ากับ 100' });
    } else {
      var s = R.zero();
      counted.forEach(function (it) {
        if (!Dec.isValid(it.weight) || R.cmp(d(it.weight), R.zero()) <= 0) errors.push({ itemId: it.id, message: 'รายการที่นับคะแนนต้องมีน้ำหนักเป็นบวก' });
        else s = R.add(s, d(it.weight));
      });
      if (R.cmp(s, HUNDRED) !== 0) errors.push({ message: 'น้ำหนักรายการรวม ' + R.toFixed(s, 2) + ' ต้องเท่ากับ 100' });
    }
    return errors;
  }

  function validateBands(bands) {
    var errors = [];
    var sorted = (bands || []).slice().sort(function (a, b) { return R.cmp(d(a.min), d(b.min)); });
    if (!sorted.length) return [{ message: 'ยังไม่ได้กำหนดเกณฑ์เกรด' }];
    if (R.cmp(d(sorted[0].min), R.zero()) !== 0) errors.push({ message: 'ช่วงเกรดต้องเริ่มที่ 0' });
    if (R.cmp(d(sorted[sorted.length - 1].max), HUNDRED) !== 0) errors.push({ message: 'ช่วงเกรดสูงสุดต้องจบที่ 100' });
    for (var i = 1; i < sorted.length; i++) {
      if (R.cmp(d(sorted[i].min), d(sorted[i - 1].max)) !== 0) errors.push({ message: 'ช่วงเกรดไม่ต่อเนื่องที่ ' + sorted[i].min });
    }
    return errors;
  }

  var DEFAULT_BANDS = [
    { min: '80', max: '100', label: '4', point: '4' },
    { min: '75', max: '80', label: '3.5', point: '3.5' },
    { min: '70', max: '75', label: '3', point: '3' },
    { min: '65', max: '70', label: '2.5', point: '2.5' },
    { min: '60', max: '65', label: '2', point: '2' },
    { min: '55', max: '60', label: '1.5', point: '1.5' },
    { min: '50', max: '55', label: '1', point: '1' },
    { min: '0', max: '50', label: '0', point: '0' }
  ];

  return {
    compute: compute,
    weighted: weighted,
    bandFor: bandFor,
    validatePlan: validatePlan,
    validateBands: validateBands,
    DEFAULT_BANDS: DEFAULT_BANDS,
    LABELS: LABELS,
    PENDING: PENDING
  };
})();
