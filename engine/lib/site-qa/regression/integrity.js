'use strict';
// integrity.js — verification + recovery for regression verdict records, plus a REPRODUCIBILITY check:
// rebuild the verdict from the live stores and confirm the fingerprint still matches. Tamper (edited
// verdict) and drift (source changed under a stored verdict) are both surfaced, never hidden.
const fs = require('fs');
const path = require('path');
const { sha256 } = require('./digest');
const { RegressionStore } = require('./store');
const { buildRegression, recordForDigest } = require('./regression');

function asStore(s) { return s instanceof RegressionStore ? s : new RegressionStore(s); }

function verify(store) {
  store = asStore(store);
  const issues = [];
  const manifest = store.manifest();
  const stored = new Set(store.storedIds());
  const committed = new Set(manifest.map(m => m.recordId));
  const seen = new Set();
  for (const m of manifest) {
    if (seen.has(m.recordId)) issues.push({ type: 'duplicate', recordId: m.recordId });
    seen.add(m.recordId);
    if (!stored.has(m.recordId)) issues.push({ type: 'missing', recordId: m.recordId });
  }
  for (const id of stored) if (!committed.has(id)) issues.push({ type: 'orphan', recordId: id });
  for (const f of fs.readdirSync(store.storageDir)) if (f.endsWith('.tmp')) issues.push({ type: 'partial-write', file: f });
  for (const id of stored) {
    let rec; try { rec = store.get(id); } catch (e) { issues.push({ type: 'unreadable', recordId: id }); continue; }
    if (rec.digest !== sha256(recordForDigest(rec))) issues.push({ type: 'digest-mismatch', recordId: id, detail: 'verdict content does not match digest (tampered)' });
    if (rec.recordId !== id) issues.push({ type: 'address-mismatch', recordId: id });
  }
  const byType = {}; for (const i of issues) byType[i.type] = (byType[i.type] || 0) + 1;
  return { ok: issues.length === 0, records: stored.size, issues, summary: byType };
}

// Does verdict `id` still reproduce from the live stores?
function reproduces(store, id, scanStore, findingStore) {
  store = asStore(store);
  const rec = store.get(id);
  if (!rec) return { ok: false, reason: 'not found' };
  const fresh = buildRegression(scanStore, findingStore, { baselineScanId: rec.baselineScanId, candidateScanId: rec.candidateScanId, policy: rec.policy, generatedAt: rec.generatedAt });
  return { ok: fresh.fingerprint === rec.fingerprint && fresh.verdict === rec.verdict, drift: fresh.fingerprint !== rec.fingerprint, storedVerdict: rec.verdict, rebuiltVerdict: fresh.verdict };
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
