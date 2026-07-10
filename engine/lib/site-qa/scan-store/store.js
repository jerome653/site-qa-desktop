'use strict';
// store.js — the append-only, immutable, content-addressed Scan Store.
//
// Invariants:
//  - APPEND-ONLY: a record file is written once via temp+rename; an existing scanId is never
//    overwritten (a re-save of identical content is reported as a duplicate, not a mutation).
//  - IMMUTABLE: nothing edits storage/*.json after commit. History/index live in separate files.
//  - COMMIT MARKER: the manifest append is the commit point. A record on disk without a manifest
//    line is an un-committed partial write (recoverable); a manifest line without a record is a
//    missing record (integrity failure).
//  - CONTENT-ADDRESSED: scanId + fingerprint + digest all come from content (see record.js).
//  - REBUILDABLE: every index is a pure projection of the immutable records; rebuildIndexes()
//    regenerates them from scratch, proving they hold no independent authority.
const fs = require('fs');
const path = require('path');
const { buildRecord, recordForDigest } = require('./record');
const { sha256 } = require('./digest');

const INDEX_NAMES = ['by-target', 'by-date', 'by-rule', 'by-severity', 'by-project', 'by-engine', 'by-digest', 'by-fingerprint'];

class ScanStore {
  constructor(root) {
    this.root = root;
    this.storageDir = path.join(root, 'storage');
    this.manifestDir = path.join(root, 'manifest');
    this.indexDir = path.join(root, 'index');
    this.manifestPath = path.join(this.manifestDir, 'manifest.jsonl');
    for (const d of [this.storageDir, this.manifestDir, this.indexDir]) {
      fs.mkdirSync(d, { recursive: true });
    }
  }

  recordPath(scanId) { return path.join(this.storageDir, scanId + '.json'); }
  indexPath(name) { return path.join(this.indexDir, name + '.jsonl'); }
  has(scanId) { return fs.existsSync(this.recordPath(scanId)); }

  // Save a runAudit() result. Returns { scanId, fingerprint, digest, duplicate, parentScanId }.
  save(result, opts = {}) {
    const rec = buildRecord(result, opts);
    if (this.has(rec.scanId)) {
      return { scanId: rec.scanId, fingerprint: rec.fingerprint, digest: rec.digest, duplicate: true, parentScanId: rec.parentScanId };
    }
    // 1) Write the immutable record atomically (temp → fsync → rename). A crash before rename
    //    leaves only a .tmp file, never a half-written record.
    const p = this.recordPath(rec.scanId);
    const tmp = p + '.tmp';
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, JSON.stringify(rec, null, 2));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, p);
    // 2) Commit: append the manifest line (the durable "this scan exists" marker).
    const line = JSON.stringify({
      scanId: rec.scanId, fingerprint: rec.fingerprint, digest: rec.digest,
      ts: rec.timestamp, engine: rec.versions.engine, registry: rec.versions.registry,
      target: rec.target, host: rec.host, environment: rec.environment,
      project: rec.project, parent: rec.parentScanId,
    });
    fs.appendFileSync(this.manifestPath, line + '\n');
    // 3) Project into indexes (append-only; rebuildable).
    this._appendIndexes(rec);
    return { scanId: rec.scanId, fingerprint: rec.fingerprint, digest: rec.digest, duplicate: false, parentScanId: rec.parentScanId };
  }

  get(scanId) {
    if (!this.has(scanId)) return null;
    return JSON.parse(fs.readFileSync(this.recordPath(scanId), 'utf8'));
  }

  manifest() {
    if (!fs.existsSync(this.manifestPath)) return [];
    return fs.readFileSync(this.manifestPath, 'utf8')
      .split('\n').filter(Boolean).map(l => JSON.parse(l));
  }

  list() { return this.manifest().map(m => m.scanId); }
  count() { return this.list().length; }

  // Every scanId that actually has a record on disk (source of truth for rebuilds).
  storedIds() {
    return fs.readdirSync(this.storageDir)
      .filter(f => f.endsWith('.json') && !f.endsWith('.tmp'))
      .map(f => f.slice(0, -5));
  }

  // ---- indexes -------------------------------------------------------------
  _indexRows(rec) {
    const rows = [];
    rows.push(['by-target', rec.targetDigest, rec.scanId]);
    rows.push(['by-date', (rec.timestamp || '').slice(0, 10), rec.scanId]);
    rows.push(['by-project', rec.project, rec.scanId]);
    rows.push(['by-engine', rec.versions.engine || 'unknown', rec.scanId]);
    rows.push(['by-digest', rec.digest, rec.scanId]);
    rows.push(['by-fingerprint', rec.fingerprint, rec.scanId]);
    const rules = new Set(), sevs = new Set();
    for (const f of rec.findings || []) {
      if (f.ruleId) rules.add(f.ruleId);
      if (f.severity) sevs.add(f.severity);
    }
    for (const r of rules) rows.push(['by-rule', r, rec.scanId]);
    for (const s of sevs) rows.push(['by-severity', s, rec.scanId]);
    return rows;
  }

  _appendIndexes(rec) {
    const buckets = {};
    for (const [name, key, id] of this._indexRows(rec)) {
      (buckets[name] || (buckets[name] = [])).push(JSON.stringify({ key, scanId: id }));
    }
    for (const name of Object.keys(buckets)) {
      fs.appendFileSync(this.indexPath(name), buckets[name].join('\n') + '\n');
    }
  }

  // Rebuild ALL indexes from the immutable records — proves indexes carry no independent state.
  rebuildIndexes() {
    for (const name of INDEX_NAMES) {
      const p = this.indexPath(name);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
    let n = 0;
    // Rebuild in committed order (manifest) so index files are byte-identical run-to-run.
    for (const m of this.manifest()) {
      const rec = this.get(m.scanId);
      if (rec) { this._appendIndexes(rec); n++; }
    }
    return { rebuilt: n };
  }

  _readIndex(name) {
    const p = this.indexPath(name);
    if (!fs.existsSync(p)) return [];
    return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  }

  query(indexName, key) {
    if (!INDEX_NAMES.includes(indexName)) throw new Error('unknown index: ' + indexName);
    return this._readIndex(indexName).filter(r => r.key === key).map(r => r.scanId);
  }

  // Convenience queries.
  byTarget(target) { return this.query('by-target', sha256(String(target))); }
  byDate(day) { return this.query('by-date', day); }
  byRule(ruleId) { return this.query('by-rule', ruleId); }
  bySeverity(sev) { return this.query('by-severity', sev); }
  byProject(project) { return this.query('by-project', project); }
  byEngine(engine) { return this.query('by-engine', engine); }
  byFingerprint(fp) { return this.query('by-fingerprint', fp); }
}

module.exports = { ScanStore, INDEX_NAMES };
