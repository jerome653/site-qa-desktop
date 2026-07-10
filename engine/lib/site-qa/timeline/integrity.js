'use strict';
// integrity.js — verification + recovery for materialized timeline snapshots, plus a REPRODUCIBILITY
// check: rebuild the timeline from the live immutable stores and confirm the snapshot's fingerprint
// still matches. Drift (source changed) and tamper (content edited) are both surfaced, never hidden.
const fs = require('fs');
const path = require('path');
const { sha256 } = require('./digest');
const { TimelineStore, buildSnapshot, recordForDigest } = require('./snapshot');

function asStore(s) { return s instanceof TimelineStore ? s : new TimelineStore(s); }

function verify(store) {
  store = asStore(store);
  const issues = [];
  const manifest = store.manifest();
  const stored = new Set(store.storedIds());
  const committed = new Set(manifest.map(m => m.snapshotId));
  const seen = new Set();
  for (const m of manifest) {
    if (seen.has(m.snapshotId)) issues.push({ type: 'duplicate', snapshotId: m.snapshotId });
    seen.add(m.snapshotId);
    if (!stored.has(m.snapshotId)) issues.push({ type: 'missing', snapshotId: m.snapshotId, detail: 'manifest references a snapshot not on disk' });
  }
  for (const id of stored) if (!committed.has(id)) issues.push({ type: 'orphan', snapshotId: id, detail: 'snapshot on disk never committed' });
  for (const f of fs.readdirSync(store.storageDir)) if (f.endsWith('.tmp')) issues.push({ type: 'partial-write', file: f });
  for (const id of stored) {
    let rec; try { rec = store.get(id); } catch (e) { issues.push({ type: 'unreadable', snapshotId: id }); continue; }
    if (rec.digest !== sha256(recordForDigest(rec))) issues.push({ type: 'digest-mismatch', snapshotId: id, detail: 'snapshot content does not match digest (tampered)' });
    if (rec.snapshotId !== id) issues.push({ type: 'address-mismatch', snapshotId: id });
  }
  const byType = {}; for (const i of issues) byType[i.type] = (byType[i.type] || 0) + 1;
  return { ok: issues.length === 0, snapshots: stored.size, issues, summary: byType };
}

// Reproducibility: does snapshot `id` still match a fresh rebuild from the source stores?
function reproduces(store, id, scanStore, findingStore) {
  store = asStore(store);
  const snap = store.get(id);
  if (!snap) return { ok: false, reason: 'snapshot not found' };
  const fresh = buildSnapshot(scanStore, findingStore, snap.target, { generatedAt: snap.generatedAt });
  return { ok: fresh.fingerprint === snap.fingerprint, snapshotFingerprint: snap.fingerprint, rebuiltFingerprint: fresh.fingerprint, drift: fresh.fingerprint !== snap.fingerprint };
}

function recover(store) {
  store = asStore(store);
  const actions = [];
  for (const f of fs.readdirSync(store.storageDir)) if (f.endsWith('.tmp')) { fs.unlinkSync(path.join(store.storageDir, f)); actions.push({ action: 'removed-partial-write', file: f }); }
  const post = verify(store);
  const unrepairable = post.issues.filter(i => ['digest-mismatch', 'address-mismatch', 'missing'].includes(i.type));
  return { actions, verified: post.ok, remaining: unrepairable, summary: post.summary };
}

module.exports = { verify, reproduces, recover };
