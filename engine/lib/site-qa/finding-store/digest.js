'use strict';
// digest.js — deterministic canonical serialization + sha256 for the Finding Store. Same value →
// same bytes → same digest, on any machine, forever. Content-addressing + tamper-evidence basis.
// (Byte-identical to scan-store/digest.js by contract — the two stores must hash the same way so a
//  finding's evidence digest can be cross-checked against its source scan.)
const crypto = require('crypto');

function canonical(v) {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
}

function sha256(input) {
  const s = typeof input === 'string' ? input : canonical(input);
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

module.exports = { canonical, sha256 };
