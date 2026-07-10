'use strict';
// digest.js — deterministic canonical serialization + sha256. Same value → same bytes → same digest,
// on any machine, forever. The basis for content-addressing, fingerprints and tamper-evidence.
const crypto = require('crypto');

// canonical JSON: object keys sorted recursively; no whitespace. Stable across runs/machines.
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
