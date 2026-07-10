'use strict';
// snapshot.js — optional content-addressed, append-only materialization of a timeline, so a timeline
// shown to a customer can be certified + reproduced later. Same durability contract as WP-003/004:
// temp→fsync→rename write; manifest append = commit marker; nothing is ever overwritten.
//
//   fingerprint = sha256(target + points + aggregate)  — reproducible; EXCLUDES generatedAt.
//   snapshotId  = sha256(fingerprint | generatedAt)     — unique per materialization (time supplied).
//   digest      = sha256(record minus digest)           — tamper-evidence.
const fs = require('fs');
const path = require('path');
const { sha256 } = require('./digest');
const { buildTimeline } = require('./timeline');
const { aggregate } = require('./aggregate');

function buildSnapshot(scanStore, findingStore, target, opts = {}) {
  const generatedAt = opts.generatedAt || '';
  const timeline = buildTimeline(scanStore, target, { findingStore });
  const agg = aggregate(timeline, findingStore);
  const content = { target, targetDigest: timeline.targetDigest, scanCount: timeline.scanCount, span: timeline.span, points: timeline.points, aggregate: agg };
  const fingerprint = sha256(content);
  const snapshotId = sha256(fingerprint + '|' + generatedAt).slice(0, 32);
  const record = {
    schemaVersion: '1.0',
    snapshotId, fingerprint, generatedAt,
    target, targetDigest: timeline.targetDigest,
    versions: timeline.versions,
    scanCount: timeline.scanCount, span: timeline.span,
    points: timeline.points, aggregate: agg,
  };
  record.digest = sha256(recordForDigest(record));
  return record;
}

function recordForDigest(record) {
  const clone = {};
  for (const k of Object.keys(record)) if (k !== 'digest') clone[k] = record[k];
  return clone;
}

class TimelineStore {
  constructor(root) {
    this.root = root;
    this.storageDir = path.join(root, 'storage');
    this.manifestDir = path.join(root, 'manifest');
    this.manifestPath = path.join(this.manifestDir, 'manifest.jsonl');
    for (const d of [this.storageDir, this.manifestDir]) fs.mkdirSync(d, { recursive: true });
  }
  recordPath(id) { return path.join(this.storageDir, id + '.json'); }
  has(id) { return fs.existsSync(this.recordPath(id)); }

  save(scanStore, findingStore, target, opts = {}) {
    const rec = buildSnapshot(scanStore, findingStore, target, opts);
    if (this.has(rec.snapshotId)) return { snapshotId: rec.snapshotId, fingerprint: rec.fingerprint, duplicate: true };
    const p = this.recordPath(rec.snapshotId), tmp = p + '.tmp';
    const fd = fs.openSync(tmp, 'w');
    try { fs.writeSync(fd, JSON.stringify(rec, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, p);
    fs.appendFileSync(this.manifestPath, JSON.stringify({ snapshotId: rec.snapshotId, fingerprint: rec.fingerprint, digest: rec.digest, target: rec.target, targetDigest: rec.targetDigest, generatedAt: rec.generatedAt, scanCount: rec.scanCount }) + '\n');
    return { snapshotId: rec.snapshotId, fingerprint: rec.fingerprint, digest: rec.digest, duplicate: false };
  }
  get(id) { return this.has(id) ? JSON.parse(fs.readFileSync(this.recordPath(id), 'utf8')) : null; }
  manifest() { return fs.existsSync(this.manifestPath) ? fs.readFileSync(this.manifestPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []; }
  storedIds() { return fs.readdirSync(this.storageDir).filter(f => f.endsWith('.json') && !f.endsWith('.tmp')).map(f => f.slice(0, -5)); }
  count() { return this.manifest().length; }
  latestFor(target) {
    const td = sha256(String(target));
    const mine = this.manifest().filter(m => m.targetDigest === td).map(m => this.get(m.snapshotId)).filter(Boolean);
    mine.sort((a, b) => (a.generatedAt || '').localeCompare(b.generatedAt || '') || a.snapshotId.localeCompare(b.snapshotId));
    return mine[mine.length - 1] || null;
  }
}

module.exports = { TimelineStore, buildSnapshot, recordForDigest };
