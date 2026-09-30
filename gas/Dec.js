/**
 * เลขทศนิยมแบบแม่นยำ (เศษส่วนด้วย BigInt) สำหรับคะแนนและน้ำหนัก
 * คะแนนเก็บในฐานข้อมูลเป็นข้อความทศนิยม เช่น "16.5" ไม่ใช้ float ในการคำนวณ
 */
var Dec = (function () {
  var RE = /^-?\d+(\.\d+)?$/;
  // ใช้ BigInt() แทน literal (เช่น 10n) เพื่อความเข้ากันได้กับตัวแยกวิเคราะห์ของ Apps Script
  var B0 = BigInt(0), B1 = BigInt(1), B2 = BigInt(2), B10 = BigInt(10);

  function gcd(a, b) {
    if (a < B0) a = -a;
    if (b < B0) b = -b;
    while (b) { var t = a % b; a = b; b = t; }
    return a;
  }

  function make(n, d) {
    if (d === B0) throw new Error('Division by zero');
    if (d < B0) { n = -n; d = -d; }
    var g = gcd(n, d);
    if (g > B1) { n = n / g; d = d / g; }
    return { n: n, d: d };
  }

  /** แปลงค่าเป็นข้อความทศนิยมมาตรฐาน หรือคืน '' เมื่อว่าง; โยน error เมื่อรูปแบบผิด */
  function normalize(v) {
    if (v === null || v === undefined || v === '') return '';
    var s;
    if (typeof v === 'number') {
      if (!isFinite(v)) throw new Error('Invalid decimal');
      s = v.toFixed(10);
    } else {
      s = String(v).trim().replace(/,/g, '');
    }
    if (!RE.test(s)) throw new Error('Invalid decimal: ' + v);
    var neg = s.charAt(0) === '-';
    if (neg) s = s.slice(1);
    var parts = s.split('.');
    var intPart = parts[0].replace(/^0+(?=\d)/, '');
    var frac = (parts[1] || '').replace(/0+$/, '');
    var out = intPart + (frac ? '.' + frac : '');
    if (out === '0') neg = false;
    return (neg ? '-' : '') + out;
  }

  function parse(v) {
    var s = normalize(v);
    if (s === '') throw new Error('Empty decimal');
    var neg = s.charAt(0) === '-';
    if (neg) s = s.slice(1);
    var parts = s.split('.');
    var frac = parts[1] || '';
    var n = BigInt(parts[0] + frac);
    var d = B10 ** BigInt(frac.length);
    return make(neg ? -n : n, d);
  }

  var R = {
    of: function (v) { return typeof v === 'object' && v && typeof v.n === 'bigint' ? v : parse(v); },
    int: function (i) { return make(BigInt(i), B1); },
    zero: function () { return make(B0, B1); },
    add: function (a, b) { return make(a.n * b.d + b.n * a.d, a.d * b.d); },
    sub: function (a, b) { return make(a.n * b.d - b.n * a.d, a.d * b.d); },
    mul: function (a, b) { return make(a.n * b.n, a.d * b.d); },
    div: function (a, b) { return make(a.n * b.d, a.d * b.n); },
    cmp: function (a, b) {
      var l = a.n * b.d, r = b.n * a.d;
      return l < r ? -1 : (l > r ? 1 : 0);
    },
    isZero: function (a) { return a.n === B0; },
    /** ปัดแบบ half up (ปัดครึ่งขึ้นออกจากศูนย์) ครั้งเดียว คืนข้อความ เช่น "80.00" */
    toFixed: function (a, digits) {
      var scale = B10 ** BigInt(digits);
      var neg = a.n < B0;
      var n = neg ? -a.n : a.n;
      var q = (n * scale * B2 + a.d) / (B2 * a.d);
      var s = q.toString();
      if (digits > 0) {
        while (s.length <= digits) s = '0' + s;
        s = s.slice(0, s.length - digits) + '.' + s.slice(s.length - digits);
      }
      return (neg && q !== B0 ? '-' : '') + s;
    }
  };

  return {
    isValid: function (v) {
      try { return normalize(v) !== ''; } catch (e) { return false; }
    },
    normalize: normalize,
    parse: parse,
    R: R
  };
})();
