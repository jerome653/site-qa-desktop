'use strict';
// diff.js — deterministic finding-level diff between two scans, keyed on ruleId-based finding
// identity (WP-001). No title/display-text matching. Classifies each finding as new / unchanged /
// modified (evidence or severity changed) / resolved, and — when a store is supplied — reopened
// (a finding that was RESOLVED before this scan and is present again).
const { sha256 } = require('./digest');
const { findingIdentity, normalizeEvidence } = require('./record');

// Map a scan record's findings → { findingId: {ruleId, severity, evidenceDigest, page} }.
function indexScan(scanRecord) {
  const m = new Map();
  for (const f of scanRecord.findings || []) {
    if (!f.ruleId) continue; // only ruleId-bearing findings have a stable identity (WP-001)
    const evidence = { page: f.page, items: f.evidenceNormalized || [] };
    const id = findingIdentity({ ruleId: f.ruleId, targetDigest: scanRecord.targetDigest, evidence });
    m.set(id, { findingId: id, ruleId: f.ruleId, severity: f.severity, page: f.page, evidenceDigest: sha256(normalizeEvidence(evidence)) });
  }
  return m;
}

function diffScans(scanA, scanB, opts = {}) {
  const store = opts.store || null;
  const am = indexScan(scanA), bm = indexScan(scanB);
  const created = [], unchanged = [], modified = [], resolved = [], reopened = [], severityChanges = [], evidenceChanges = [];

  for (const [id, b] of bm) {
    if (!am.has(id)) {
      // Present now, absent in A. Reopened if the store shows it was previously RESOLVED.
      const wasResolved = store ? store.currentState(id) === 'RESOLVED' : false;
      (wasResolved ? reopened : created).push(b);
      continue;
    }
    const a = am.get(id);
    const sevChanged = a.severity !== b.severity;
    const evChanged = a.evidenceDigest !== b.evidenceDigest;
    if (sevChanged) severityChanges.push({ findingId: id, ruleId: b.ruleId, from: a.severity, to: b.severity });
    if (evChanged) evidenceChanges.push({ findingId: id, ruleId: b.ruleId, from: a.evidenceDigest, to: b.evidenceDigest });
    if (sevChanged || evChanged) modified.push({ findingId: id, ruleId: b.ruleId, severityChanged: sevChanged, evidenceChanged: evChanged, from: { severity: a.severity, evidenceDigest: a.evidenceDigest }, to: { severity: b.severity, evidenceDigest: b.evidenceDigest } });
    else unchanged.push(b);
  }
  for (const [id, a] of am) if (!bm.has(id)) resolved.push(a);

  const sort = arr => arr.sort((x, y) => (x.findingId || '').localeCompare(y.findingId || ''));
  [created, unchanged, resolved, reopened].forEach(sort);
  modified.sort((x, y) => x.findingId.localeCompare(y.findingId));
  severityChanges.sort((x, y) => x.findingId.localeCompare(y.findingId));
  evidenceChanges.sort((x, y) => x.findingId.localeCompare(y.findingId));

  return {
    from: { scanId: scanA.scanId, fingerprint: scanA.fingerprint },
    to: { scanId: scanB.scanId, fingerprint: scanB.fingerprint },
    created, unchanged, modified, resolved, reopened, severityChanges, evidenceChanges,
    counts: { created: created.length, unchanged: unchanged.length, modified: modified.length, resolved: resolved.length, reopened: reopened.length, severityChanges: severityChanges.length, evidenceChanges: evidenceChanges.length },
  };
}

module.exports = { diffScans, indexScan };
