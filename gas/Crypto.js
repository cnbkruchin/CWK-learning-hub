/**
 * SHA-256, HMAC-SHA256 และ PBKDF2-HMAC-SHA256 แบบ JavaScript ล้วน
 *
 * เหตุผล: Apps Script ไม่มี bcrypt/scrypt/argon2 และการเรียก Utilities ซ้ำหลายหมื่นครั้งช้า
 * โมดูลนี้ทดสอบเทียบกับ Node.js crypto ใน tests/crypto.test.js
 *
 * รูปแบบรหัสผ่านที่เก็บ: pbkdf2_sha256$<รอบ>$<salt base64>$<hash base64>
 * โดย hash = HMAC-SHA256(pepper, PBKDF2(password, salt, รอบ, 32))
 * pepper เก็บใน Script Properties เท่านั้น หากตารางผู้ใช้หลุดออกไปจะเดารหัสผ่านไม่ได้หากไม่มี pepper
 */
var Crypto = (function () {
  var K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];
  var IV = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  var W = new Int32Array(64);

  /** บีบอัดหนึ่งบล็อก: state (8 คำ) ถูกแก้ไขในที่, W[0..15] ต้องเตรียมไว้แล้ว */
  function compress(state) {
    var i, t1, t2, s0, s1;
    for (i = 16; i < 64; i++) {
      var w15 = W[i - 15], w2 = W[i - 2];
      s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3);
      s1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
    }
    var a = state[0], b = state[1], c = state[2], d = state[3];
    var e = state[4], f = state[5], g = state[6], h = state[7];
    for (i = 0; i < 64; i++) {
      s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      t1 = (h + s1 + ((e & f) ^ (~e & g)) + K[i] + W[i]) | 0;
      s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      t2 = (s0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0;
      d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    state[0] = (state[0] + a) | 0; state[1] = (state[1] + b) | 0;
    state[2] = (state[2] + c) | 0; state[3] = (state[3] + d) | 0;
    state[4] = (state[4] + e) | 0; state[5] = (state[5] + f) | 0;
    state[6] = (state[6] + g) | 0; state[7] = (state[7] + h) | 0;
  }

  /** ตัวคำนวณ SHA-256 แบบทยอยป้อนข้อมูล (ใช้กับไฟล์ขนาดใหญ่ทีละส่วน) */
  function Hasher() {
    this.state = IV.slice();
    this.buf = new Array(64);
    this.bufLen = 0;
    this.total = 0;
  }
  Hasher.prototype.update = function (bytes) {
    for (var i = 0; i < bytes.length; i++) {
      this.buf[this.bufLen++] = bytes[i] & 0xff;
      if (this.bufLen === 64) {
        for (var j = 0; j < 16; j++) {
          W[j] = (this.buf[j * 4] << 24) | (this.buf[j * 4 + 1] << 16) | (this.buf[j * 4 + 2] << 8) | this.buf[j * 4 + 3];
        }
        compress(this.state);
        this.bufLen = 0;
      }
    }
    this.total += bytes.length;
    return this;
  };
  Hasher.prototype.digest = function () {
    var bitLenHi = Math.floor(this.total / 0x20000000);
    var bitLenLo = (this.total * 8) >>> 0;
    var pad = [0x80];
    var padLen = (this.bufLen < 56 ? 56 : 120) - this.bufLen;
    for (var i = 1; i < padLen; i++) pad.push(0);
    pad.push((bitLenHi >>> 24) & 0xff, (bitLenHi >>> 16) & 0xff, (bitLenHi >>> 8) & 0xff, bitLenHi & 0xff,
      (bitLenLo >>> 24) & 0xff, (bitLenLo >>> 16) & 0xff, (bitLenLo >>> 8) & 0xff, bitLenLo & 0xff);
    var total = this.total;
    this.update(pad);
    this.total = total;
    return wordsToBytes(this.state);
  };

  function wordsToBytes(words) {
    var out = new Array(words.length * 4);
    for (var i = 0; i < words.length; i++) {
      out[i * 4] = (words[i] >>> 24) & 0xff;
      out[i * 4 + 1] = (words[i] >>> 16) & 0xff;
      out[i * 4 + 2] = (words[i] >>> 8) & 0xff;
      out[i * 4 + 3] = words[i] & 0xff;
    }
    return out;
  }

  function sha256(bytes) {
    return new Hasher().update(bytes).digest();
  }

  /** เข้ารหัส UTF-8 แบบ JavaScript ล้วน (รองรับอักษรไทยและ surrogate pair) */
  function utf8(str) {
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
        var c2 = str.charCodeAt(i + 1);
        if (c2 >= 0xdc00 && c2 <= 0xdfff) {
          c = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
          i++;
        }
      }
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return out;
  }

  function hmac(keyBytes, msgBytes) {
    var key = keyBytes.length > 64 ? sha256(keyBytes) : keyBytes.slice();
    var ipad = new Array(64), opad = new Array(64);
    for (var i = 0; i < 64; i++) {
      var k = i < key.length ? key[i] & 0xff : 0;
      ipad[i] = k ^ 0x36;
      opad[i] = k ^ 0x5c;
    }
    var inner = new Hasher().update(ipad).update(msgBytes).digest();
    return new Hasher().update(opad).update(inner).digest();
  }

  /** สถานะหลังบีบอัดบล็อก pad (ใช้เร่งความเร็ว PBKDF2) */
  function padState(key, byteVal) {
    var st = IV.slice();
    for (var j = 0; j < 16; j++) {
      var w = 0;
      for (var b = 0; b < 4; b++) {
        var idx = j * 4 + b;
        w = (w << 8) | (((idx < key.length ? key[idx] & 0xff : 0) ^ byteVal) & 0xff);
      }
      W[j] = w;
    }
    compress(st);
    return st;
  }

  /** บีบอัดข้อความยาว 32 ไบต์ (8 คำ) ต่อจากสถานะ pad ความยาวรวม 96 ไบต์ */
  function finish32(fromState, words, out) {
    for (var i = 0; i < 8; i++) { out[i] = fromState[i]; W[i] = words[i]; }
    W[8] = 0x80000000;
    for (i = 9; i < 15; i++) W[i] = 0;
    W[15] = 768; // (64 + 32) * 8 บิต
    compress(out);
  }

  function pbkdf2(passwordBytes, saltBytes, iterations, dkLen) {
    var key = passwordBytes.length > 64 ? sha256(passwordBytes) : passwordBytes;
    var iState = padState(key, 0x36);
    var oState = padState(key, 0x5c);
    var out = [];
    var blocks = Math.ceil(dkLen / 32);
    var inner = new Array(8), u = new Array(8), t = new Array(8);
    for (var blk = 1; blk <= blocks; blk++) {
      var first = hmac(key, saltBytes.concat([(blk >>> 24) & 0xff, (blk >>> 16) & 0xff, (blk >>> 8) & 0xff, blk & 0xff]));
      for (var i = 0; i < 8; i++) {
        u[i] = (first[i * 4] << 24) | (first[i * 4 + 1] << 16) | (first[i * 4 + 2] << 8) | first[i * 4 + 3];
        t[i] = u[i];
      }
      for (var it = 1; it < iterations; it++) {
        finish32(iState, u, inner);
        finish32(oState, inner, u);
        for (i = 0; i < 8; i++) t[i] ^= u[i];
      }
      out = out.concat(wordsToBytes(t));
    }
    return out.slice(0, dkLen);
  }

  /** เปรียบเทียบแบบเวลาคงที่ */
  function safeEqual(a, b) {
    if (a.length !== b.length) return false;
    var diff = 0;
    for (var i = 0; i < a.length; i++) diff |= (a.charCodeAt(i) ^ b.charCodeAt(i));
    return diff === 0;
  }

  return {
    Hasher: Hasher,
    sha256: sha256,
    utf8: utf8,
    hmac: hmac,
    pbkdf2: pbkdf2,
    safeEqual: safeEqual,
    hex: function (bytes) {
      var s = '';
      for (var i = 0; i < bytes.length; i++) s += ((bytes[i] & 0xff) < 16 ? '0' : '') + (bytes[i] & 0xff).toString(16);
      return s;
    }
  };
})();
