'use strict';
// digest.js — deterministic canonical serialization + sha256 for the Regression Engine. Byte-identical
// to the other stores' digest by contract, so a gate verdict can be reproduced + certified.
const crypto = require('crypto');

function canonical(v) {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
}
function sha256(input) {
  return crypto.createHash('sha256').update(typeof input === 'string' ? input : canonical(input), 'utf8').digest('hex');
}
module.exports = { canonical, sha256 };
