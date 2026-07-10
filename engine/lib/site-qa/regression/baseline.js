'use strict';
// baseline.js — append-only baseline pointers. A baseline names the "known good" scan a candidate is
// gated against. Pointers are immutable: re-baselining appends a new pointer (latest wins); nothing
// is ever edited. A pointer references an immutable WP-003 scan by scanId + fingerprint.
const fs = require('fs');
const path = require('path');
const { sha256 } = require('./digest');

class BaselineStore {
  constructor(root) {
    this.root = root;
    this.dir = path.join(root, 'baselines');
    this.path = path.join(this.dir, 'baselines.jsonl');
    fs.mkdirSync(this.dir, { recursive: true });
  }
  _all() { return fs.existsSync(this.path) ? fs.readFileSync(this.path, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []; }

  // Pin a scan record as the baseline for its target. Append-only.
  set(scanRecord, opts = {}) {
    const entry = {
      target: scanRecord.target,
      targetDigest: scanRecord.targetDigest || sha256(String(scanRecord.target)),
      scanId: scanRecord.scanId,
      fingerprint: scanRecord.fingerprint,
      setAt: opts.setAt || '',
      reason: opts.reason || '',
      actor: opts.actor || 'engine',
    };
    fs.appendFileSync(this.path, JSON.stringify(entry) + '\n');
    return entry;
  }
  history(target) {
    const td = sha256(String(target));
    return this._all().filter(e => e.targetDigest === td);
  }
  // Current baseline = last pointer appended for the target (append-only, latest wins).
  current(target) { const h = this.history(target); return h.length ? h[h.length - 1] : null; }
}

module.exports = { BaselineStore };
