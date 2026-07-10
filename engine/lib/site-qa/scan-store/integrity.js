'use strict';
// integrity.js — verification + recovery for the immutable store.
// Verify answers "is the store internally consistent and untampered?" Recovery repairs the classes
// of damage that are safe to repair automatically (partial writes, stale indexes) and REPORTS the
// classes that are not (a record whose digest no longer matches its content = tampering, never
// silently "fixed").
const fs = require('fs');
const path = require('path');
const { ScanStore } = require('./store');
const { sha256 } = require('./digest');
const { recordForDigest } = require('./record');

function asStore(s) { return s instanceof ScanStore ? s : new ScanStore(s); }

function verify(store) {
  store = asStore(store);
  const issues = [];
  const manifest = store.manifest();
  const manifestIds = manifest.map(m => m.scanId);
  const storedIds = store.storedIds();
  const manifestSet = new Set(manifestIds);
  const storedSet = new Set(storedIds);

  // Duplicate manifest lines for one scanId.
  const seen = new Set();
  for (const id of manifestIds) {
    if (seen.has(id)) issues.push({ type: 'duplicate', scanId: id, detail: 'scanId appears more than once in manifest' });
    seen.add(id);
  }
  // Manifest entry with no record file = missing.
  for (const m of manifest) {
    if (!storedSet.has(m.scanId)) issues.push({ type: 'missing', scanId: m.scanId, detail: 'manifest references a record that is not on disk' });
  }
  // Record on disk with no manifest line = orphan (uncommitted).
  for (const id of storedIds) {
    if (!manifestSet.has(id)) issues.push({ type: 'orphan', scanId: id, detail: 'record on disk was never committed to the manifest' });
  }
  // .tmp files = interrupted (partial) writes.
  for (const f of fs.readdirSync(store.storageDir)) {
    if (f.endsWith('.tmp')) issues.push({ type: 'partial-write', file: f, detail: 'interrupted write (temp file never renamed)' });
  }
  // Per-record: digest match (tamper) + content-address match (scanId derived from content) + chain.
  for (const id of storedIds) {
    let rec;
    try { rec = store.get(id); } catch (e) { issues.push({ type: 'unreadable', scanId: id, detail: String(e.message || e) }); continue; }
    const recomputed = sha256(recordForDigest(rec));
    if (rec.digest !== recomputed) issues.push({ type: 'digest-mismatch', scanId: id, detail: 'record content does not match its stored digest (tampered)' });
    // Content-address invariant: the storage filename IS the scanId derived from content.
    if (rec.scanId !== id) issues.push({ type: 'address-mismatch', scanId: id, detail: 'record scanId does not match its storage filename' });
    if (rec.parentScanId && !storedSet.has(rec.parentScanId)) {
      issues.push({ type: 'broken-chain', scanId: id, detail: 'parentScanId points to a scan not in the store' });
    }
  }

  const byType = {};
  for (const i of issues) byType[i.type] = (byType[i.type] || 0) + 1;
  return {
    ok: issues.length === 0,
    records: storedIds.length,
    committed: manifestIds.length,
    issues,
    summary: byType,
  };
}

// Recovery: repair the auto-repairable, report the rest. Idempotent.
function recover(store) {
  store = asStore(store);
  const actions = [];
  // 1) Delete interrupted temp writes — they were never committed, so no data loss.
  for (const f of fs.readdirSync(store.storageDir)) {
    if (f.endsWith('.tmp')) {
      fs.unlinkSync(path.join(store.storageDir, f));
      actions.push({ action: 'removed-partial-write', file: f });
    }
  }
  // 2) Rebuild indexes from the immutable records (fixes stale/torn index files after a crash).
  const r = store.rebuildIndexes();
  actions.push({ action: 'rebuilt-indexes', count: r.rebuilt });
  // 3) Re-verify and surface anything that is NOT auto-repairable (tampering, missing records).
  const post = verify(store);
  const unrepairable = post.issues.filter(i => i.type === 'digest-mismatch' || i.type === 'missing' || i.type === 'broken-chain' || i.type === 'address-mismatch');
  return { actions, verified: post.ok, remaining: unrepairable, summary: post.summary };
}

module.exports = { verify, recover };
