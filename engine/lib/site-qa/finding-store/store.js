'use strict';
// store.js — append-only, immutable, content-addressed Finding Store. Same durability contract as
// the Scan Store (WP-003): temp→fsync→rename record write; manifest append = the crash-safe commit
// marker; nothing is ever overwritten. State is DERIVED from the append-only chain — never stored
// mutably (no hidden state). Findings ingested from immutable WP-003 scan records.
const fs = require('fs');
const path = require('path');
const { sha256 } = require('./digest');
const { buildRecord, findingIdentity, normalizeEvidence, recordForDigest } = require('./record');
const { assertTransition } = require('./lifecycle');

const INDEX_NAMES = ['by-finding', 'by-rule', 'by-target', 'by-severity', 'by-status', 'by-scan', 'by-fingerprint', 'by-digest', 'by-date'];
const REOPENABLE = new Set(['OPEN', 'CONFIRMED', 'ACTIVE', 'UPDATED', 'REOPENED']);

class FindingStore {
  constructor(root) {
    this.root = root;
    this.storageDir = path.join(root, 'storage');
    this.manifestDir = path.join(root, 'manifest');
    this.indexDir = path.join(root, 'index');
    this.manifestPath = path.join(this.manifestDir, 'manifest.jsonl');
    for (const d of [this.storageDir, this.manifestDir, this.indexDir]) fs.mkdirSync(d, { recursive: true });
  }

  recordPath(id) { return path.join(this.storageDir, id + '.json'); }
  indexPath(name) { return path.join(this.indexDir, name + '.jsonl'); }
  has(id) { return fs.existsSync(this.recordPath(id)); }

  // ---- low-level append (one lifecycle event) ------------------------------
  _write(rec) {
    const p = this.recordPath(rec.recordId);
    const tmp = p + '.tmp';
    const fd = fs.openSync(tmp, 'w');
    try { fs.writeSync(fd, JSON.stringify(rec, null, 2)); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(tmp, p);
    fs.appendFileSync(this.manifestPath, JSON.stringify({
      recordId: rec.recordId, findingId: rec.findingId, seq: rec.seq, fingerprint: rec.fingerprint,
      digest: rec.digest, ruleId: rec.ruleId, target: rec.target, targetDigest: rec.targetDigest,
      severity: rec.severity, state: rec.newState, prev: rec.previousState,
      scanId: rec.scanRef.scanId, ts: rec.timestamp, parent: rec.parentRecordId,
    }) + '\n');
    this._appendIndexes(rec);
    return rec;
  }

  // Append a lifecycle event to a finding's chain. Derives previousState/seq/parent from the chain,
  // validates the transition (fails closed), then writes an immutable record.
  append(fields) {
    const prior = this.currentRecord(fields.findingId);
    const previousState = prior ? prior.newState : null;
    const seq = prior ? prior.seq + 1 : 0;
    const parentRecordId = prior ? prior.recordId : null;
    assertTransition(previousState, fields.newState); // throws → nothing written
    // Inherit stable identity fields from the chain when the caller omits them.
    const rec = buildRecord({
      ...fields,
      ruleId: fields.ruleId || (prior && prior.ruleId),
      target: fields.target != null ? fields.target : (prior && prior.target),
      targetDigest: fields.targetDigest != null ? fields.targetDigest : (prior && prior.targetDigest),
      severity: fields.severity != null ? fields.severity : (prior && prior.severity),
      previousState, seq, parentRecordId,
    });
    if (this.has(rec.recordId)) return { recordId: rec.recordId, duplicate: true, findingId: rec.findingId, state: rec.newState };
    this._write(rec);
    return { recordId: rec.recordId, duplicate: false, findingId: rec.findingId, state: rec.newState, previousState, seq };
  }

  // ---- reads / derived state ----------------------------------------------
  get(id) { return this.has(id) ? JSON.parse(fs.readFileSync(this.recordPath(id), 'utf8')) : null; }

  manifest() {
    if (!fs.existsSync(this.manifestPath)) return [];
    return fs.readFileSync(this.manifestPath, 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch (_) { return { __torn: true, raw: l }; } });
  }

  storedIds() {
    return fs.readdirSync(this.storageDir).filter(f => f.endsWith('.json') && !f.endsWith('.tmp')).map(f => f.slice(0, -5));
  }

  count() { return this.manifest().filter(m => !m.__torn).length; }

  recordsFor(findingId) {
    return this.query('by-finding', findingId).map(id => this.get(id)).filter(Boolean)
      .sort((a, b) => a.seq - b.seq || a.recordId.localeCompare(b.recordId));
  }
  currentRecord(findingId) { const c = this.recordsFor(findingId); return c.length ? c[c.length - 1] : null; }
  currentState(findingId) { const r = this.currentRecord(findingId); return r ? r.newState : null; }

  // Distinct finding identities in the store, with their current state.
  findings() {
    const ids = new Set(this.manifest().filter(m => !m.__torn).map(m => m.findingId));
    return [...ids].map(id => { const r = this.currentRecord(id); return r ? { findingId: id, ruleId: r.ruleId, target: r.target, severity: r.severity, state: r.newState, seq: r.seq } : null; }).filter(Boolean);
  }

  // ---- indexes -------------------------------------------------------------
  _indexRows(rec) {
    const rows = [
      ['by-finding', rec.findingId], ['by-rule', rec.ruleId], ['by-target', rec.targetDigest],
      ['by-severity', rec.severity || 'none'], ['by-status', rec.newState],
      ['by-scan', rec.scanRef.scanId || 'none'], ['by-fingerprint', rec.fingerprint],
      ['by-digest', rec.digest], ['by-date', (rec.timestamp || '').slice(0, 10)],
    ];
    return rows.map(([name, key]) => [name, key, rec.recordId]);
  }
  _appendIndexes(rec) {
    const buckets = {};
    for (const [name, key, id] of this._indexRows(rec)) (buckets[name] || (buckets[name] = [])).push(JSON.stringify({ key, recordId: id }));
    for (const name of Object.keys(buckets)) fs.appendFileSync(this.indexPath(name), buckets[name].join('\n') + '\n');
  }
  rebuildIndexes() {
    for (const n of INDEX_NAMES) { const p = this.indexPath(n); if (fs.existsSync(p)) fs.unlinkSync(p); }
    let n = 0;
    for (const m of this.manifest()) { if (m.__torn) continue; const rec = this.get(m.recordId); if (rec) { this._appendIndexes(rec); n++; } }
    return { rebuilt: n };
  }
  _readIndex(name) {
    const p = this.indexPath(name);
    if (!fs.existsSync(p)) return [];
    return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  }
  query(indexName, key) {
    if (!INDEX_NAMES.includes(indexName)) throw new Error('unknown index: ' + indexName);
    return this._readIndex(indexName).filter(r => r.key === key).map(r => r.recordId);
  }
  byRule(ruleId) { return distinctFindings(this, this.query('by-rule', ruleId)); }
  byTarget(target) { return distinctFindings(this, this.query('by-target', sha256(String(target)))); }
  bySeverity(sev) { return distinctFindings(this, this.query('by-severity', sev)); }
  byStatus(state) { return this.findings().filter(f => f.state === state); } // current status
  byScan(scanId) { return this.query('by-scan', scanId).map(id => this.get(id)).filter(Boolean); }

  // firstSeen / lastSeen views — derived from the immutable chain (append-only, so monotonic).
  seen(findingId) {
    const recs = this.recordsFor(findingId);
    if (!recs.length) return null;
    return { firstSeen: recs[0].timestamp, lastSeen: recs[recs.length - 1].timestamp, observations: recs.length };
  }

  // ---- scan ingestion (the only writer path from the engine) ---------------
  // Derive finding lifecycle from an immutable WP-003 scan record. Optionally auto-RESOLVE findings
  // that were present in prevScanRecord for the same target but are absent now.
  ingestScan(scanRecord, opts = {}) {
    const { prevScanRecord = null, actor = 'engine', resolveMissing = true } = opts;
    const events = [];
    const currentIds = new Set();
    const engineVersion = (scanRecord.versions && scanRecord.versions.engine) || null;

    for (const f of scanRecord.findings || []) {
      if (!f.ruleId) continue; // lifecycle needs a stable ruleId identity (WP-001); anonymous findings
                               // remain in the immutable scan record but are not lifecycle-tracked here
      const evidence = { page: f.page, items: f.evidenceNormalized || [], raw: f.evidenceRaw || '' };
      const ctx = { ruleId: f.ruleId, targetDigest: scanRecord.targetDigest, evidence };
      const findingId = findingIdentity(ctx);
      currentIds.add(findingId);
      const prior = this.currentRecord(findingId);
      const priorState = prior ? prior.newState : null;
      if (priorState === 'DUPLICATE' || priorState === 'SUPERSEDED') continue; // closed — do not reopen automatically

      const newEvidenceDigest = sha256(normalizeEvidence(evidence));
      let newState, kind = 'transition';
      if (priorState == null) newState = 'OPEN';
      else if (priorState === 'OPEN') newState = 'CONFIRMED';
      else if (priorState === 'CONFIRMED') newState = 'ACTIVE';
      else if (priorState === 'RESOLVED') newState = 'REOPENED';
      else if (priorState === 'REOPENED') newState = 'ACTIVE';
      else if (priorState === 'UPDATED') newState = 'ACTIVE'; // settle
      else { // ACTIVE
        const changed = prior && prior.evidenceRef.evidenceDigest !== newEvidenceDigest;
        newState = changed ? 'UPDATED' : 'ACTIVE';
        kind = changed ? 'transition' : 'observation';
      }
      events.push(this.append({
        findingId, ruleId: f.ruleId, target: scanRecord.target, targetDigest: scanRecord.targetDigest,
        severity: f.severity, newState, kind, evidence, engineVersion,
        scanId: scanRecord.scanId, scanFingerprint: scanRecord.fingerprint,
        actor, timestamp: scanRecord.timestamp,
      }));
    }

    if (resolveMissing && prevScanRecord) {
      const prevIds = new Set();
      for (const f of prevScanRecord.findings || []) {
        if (!f.ruleId) continue; // same rule: only ruleId-bearing findings are lifecycle-tracked
        prevIds.add(findingIdentity({ ruleId: f.ruleId, targetDigest: prevScanRecord.targetDigest, evidence: { page: f.page, items: f.evidenceNormalized || [] } }));
      }
      for (const id of prevIds) {
        if (currentIds.has(id)) continue;
        const state = this.currentState(id);
        if (!REOPENABLE.has(state)) continue; // already resolved/terminal
        const prior = this.currentRecord(id);
        // A finding mid-UPDATED must settle to ACTIVE before it can resolve (fail-closed lifecycle).
        if (state === 'UPDATED') {
          events.push(this.append({ findingId: id, newState: 'ACTIVE', kind: 'transition', evidence: reconstructEvidence(prior), scanId: scanRecord.scanId, scanFingerprint: scanRecord.fingerprint, engineVersion, actor, timestamp: scanRecord.timestamp }));
        } else if (state === 'OPEN') {
          // OPEN can't jump to RESOLVED; walk OPEN→CONFIRMED→ACTIVE→RESOLVED deterministically.
          events.push(this.append({ findingId: id, newState: 'CONFIRMED', evidence: reconstructEvidence(prior), scanId: scanRecord.scanId, scanFingerprint: scanRecord.fingerprint, engineVersion, actor, timestamp: scanRecord.timestamp }));
          events.push(this.append({ findingId: id, newState: 'ACTIVE', evidence: reconstructEvidence(prior), scanId: scanRecord.scanId, scanFingerprint: scanRecord.fingerprint, engineVersion, actor, timestamp: scanRecord.timestamp }));
        } else if (state === 'CONFIRMED') {
          events.push(this.append({ findingId: id, newState: 'ACTIVE', evidence: reconstructEvidence(prior), scanId: scanRecord.scanId, scanFingerprint: scanRecord.fingerprint, engineVersion, actor, timestamp: scanRecord.timestamp }));
        } else if (state === 'REOPENED') {
          events.push(this.append({ findingId: id, newState: 'ACTIVE', evidence: reconstructEvidence(prior), scanId: scanRecord.scanId, scanFingerprint: scanRecord.fingerprint, engineVersion, actor, timestamp: scanRecord.timestamp }));
        }
        events.push(this.append({ findingId: id, newState: 'RESOLVED', kind: 'transition', evidence: reconstructEvidence(this.currentRecord(id)), scanId: scanRecord.scanId, scanFingerprint: scanRecord.fingerprint, engineVersion, actor, timestamp: scanRecord.timestamp }));
      }
    }
    return { events: events.filter(Boolean), findings: currentIds.size };
  }
}

function distinctFindings(store, recordIds) {
  const ids = new Set(recordIds.map(id => { const r = store.get(id); return r && r.findingId; }).filter(Boolean));
  return [...ids];
}
function reconstructEvidence(rec) {
  if (!rec) return {};
  return { page: (rec.evidenceRef.normalized[0] || {}).page || '', items: rec.evidenceRef.normalized, raw: rec.evidenceRef.raw };
}

module.exports = { FindingStore, INDEX_NAMES, REOPENABLE };
