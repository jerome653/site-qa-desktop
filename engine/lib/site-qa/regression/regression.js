'use strict';
// regression.js — deterministic regression detection + gate verdict. Compares a candidate scan
// against a baseline scan using the immutable stores (WP-003 scans + WP-004 finding identity/state)
// and the WP-005-style diff, then applies an explicit policy to produce a PASS/WARN/FAIL verdict.
// Pure function of (stores, baselineScanId, candidateScanId, policy). No title matching.
const { sha256 } = require('./digest');
const { evaluate, resolvePolicy } = require('./policy');
const FDS = require('../finding-store');

function recordForDigest(record) {
  const clone = {};
  for (const k of Object.keys(record)) if (k !== 'digest') clone[k] = record[k];
  return clone;
}

// Build a regression verdict record (content-addressed; reproducible).
function buildRegression(scanStore, findingStore, params = {}) {
  const { baselineScanId, candidateScanId, policy, generatedAt = '' } = params;
  const baseRec = scanStore.get(baselineScanId);
  const candRec = scanStore.get(candidateScanId);
  if (!baseRec) throw new Error('baseline scan not found: ' + baselineScanId);
  if (!candRec) throw new Error('candidate scan not found: ' + candidateScanId);

  const fdiff = FDS.diffScans(baseRec, candRec, { store: findingStore || null });
  const scoreDelta = (candRec.quality ? candRec.quality.overall : null) != null && (baseRec.quality ? baseRec.quality.overall : null) != null
    ? +(candRec.quality.overall - baseRec.quality.overall).toFixed(2) : null;

  // Resolve the FULL policy and store it in the record, so the verdict reproduces exactly even for a
  // custom policy (not just the default). Reproducibility depends on the complete thresholds.
  const fullPolicy = resolvePolicy(policy);
  const ev = evaluate({ created: fdiff.created, reopened: fdiff.reopened, severityChanges: fdiff.severityChanges, scoreDelta }, fullPolicy);

  const content = {
    target: candRec.target,
    baselineScanId, candidateScanId,
    baselineFingerprint: baseRec.fingerprint, candidateFingerprint: candRec.fingerprint,
    scoreDelta,
    diff: {
      created: fdiff.created, resolved: fdiff.resolved, modified: fdiff.modified,
      reopened: fdiff.reopened, severityChanges: fdiff.severityChanges, evidenceChanges: fdiff.evidenceChanges,
      counts: fdiff.counts,
    },
    policy: fullPolicy,
    verdict: ev.verdict,
    violations: ev.violations,
  };
  const fingerprint = sha256(content);
  const recordId = sha256(fingerprint + '|' + generatedAt).slice(0, 32);

  const record = {
    schemaVersion: '1.0',
    recordId, fingerprint, generatedAt,
    target: candRec.target,
    targetDigest: candRec.targetDigest,
    baselineScanId, candidateScanId,
    baselineFingerprint: baseRec.fingerprint, candidateFingerprint: candRec.fingerprint,
    versions: candRec.versions,
    scoreDelta,
    diff: content.diff,
    policy: fullPolicy,
    verdict: ev.verdict,
    violations: ev.violations,
  };
  record.digest = sha256(recordForDigest(record));
  return record;
}

module.exports = { buildRegression, recordForDigest };
