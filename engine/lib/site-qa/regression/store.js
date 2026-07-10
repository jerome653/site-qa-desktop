'use strict';
// store.js — append-only, content-addressed store of regression verdict records, so a gate decision
// is durable + certifiable. Same contract as WP-003/004/005: temp→fsync→rename write; manifest append
// = commit marker; nothing overwritten.
const fs = require('fs');
const path = require('path');
const { sha256 } = require('./digest');
const { buildRegression } = require('./regression');

class RegressionStore {
  constructor(root) {
    this.root = root;
    this.storageDir = path.join(root, 'storage');
    this.manifestDir = path.join(root, 'manifest');
    this.manifestPath = path.join(this.manifestDir, 'manifest.jsonl');
    for (const d of [this.storageDir, this.manifestDir]) fs.mkdirSync(d, { recursive: true });
  }
  recordPath(id) { return path.join(this.storageDir, id + '.json'); }
  has(id) { return fs.existsSync(this.recordPath(id)); }

  save(scanStore, findingStore, params = {}) {
    const rec = buildRegression(scanStore, findingStore, params);
    if (this.has(rec.recordId)) return { recordId: rec.recordId, verdict: rec.verdict, fingerprint: rec.fingerprint, duplicate: true };
    const p = this.recordPath(rec.recordId), tmp = p + '.tmp';
    const fd = fs.openSync(tmp, 'w');
    try { fs.writeSync(fd, JSON.stringify(rec, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, p);
    fs.appendFileSync(this.manifestPath, JSON.stringify({
      recordId: rec.recordId, fingerprint: rec.fingerprint, digest: rec.digest, target: rec.target, targetDigest: rec.targetDigest,
      baselineScanId: rec.baselineScanId, candidateScanId: rec.candidateScanId, verdict: rec.verdict, generatedAt: rec.generatedAt,
    }) + '\n');
    return { recordId: rec.recordId, verdict: rec.verdict, fingerprint: rec.fingerprint, duplicate: false };
  }
  get(id) { return this.has(id) ? JSON.parse(fs.readFileSync(this.recordPath(id), 'utf8')) : null; }
  manifest() { return fs.existsSync(this.manifestPath) ? fs.readFileSync(this.manifestPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []; }
  storedIds() { return fs.readdirSync(this.storageDir).filter(f => f.endsWith('.json') && !f.endsWith('.tmp')).map(f => f.slice(0, -5)); }
  count() { return this.manifest().length; }
  byTarget(target) { const td = sha256(String(target)); return this.manifest().filter(m => m.targetDigest === td).map(m => m.recordId); }
  byVerdict(v) { return this.manifest().filter(m => m.verdict === v).map(m => m.recordId); }
}

module.exports = { RegressionStore };
