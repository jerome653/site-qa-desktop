'use strict';
// record.js — build an IMMUTABLE scan record from a runAudit() result.
// A record is content-addressed: its identity derives from its content, never assigned externally.
//
//   fingerprint  = sha256 of the *scored content* (findings + score + versions + target), EXCLUDING
//                  timestamp/scanId — so two scans with identical outcomes share a fingerprint
//                  (identical-scan detection), regardless of when they ran.
//   scanId       = sha256(fingerprint | timestamp) — unique per execution; deterministic given the
//                  scan's own generated timestamp (no Date.now/random — reproducible).
//   digest       = sha256 of the whole record minus the digest field — tamper-evidence.
//
// The record NEVER embeds live objects; only plain JSON derived from the frozen report-summary shape.
const { sha256 } = require('./digest');

const RECORD_SCHEMA_VERSION = '1.0';

// Flatten scored/manual findings out of the enriched suites. Pass rows are not findings.
function findingsFrom(result) {
  const out = [];
  for (const suite of result.suites || []) {
    for (const row of suite.checks || []) {
      if (!row || row.status === 'pass') continue;
      out.push({
        ruleId: row.ruleId || null,
        ruleSlug: row.ruleSlug || null,
        suite: row.suite || suite.key || null,
        severity: row.severity || null,
        status: row.status,
        deduction: row.deduction || 0,
        page: row.target || '',
        evidenceRaw: typeof row.detail === 'string' ? row.detail : '',
        evidenceNormalized: (row.items || []).map(it => ({
          page: it.page != null ? String(it.page) : '',
          section: it.section != null ? String(it.section) : '',
          id: it.id != null ? String(it.id) : '',
          value: it.value != null ? String(it.value) : '',
        })),
      });
    }
  }
  // Deterministic order: by ruleId then page then evidence — so the fingerprint is stable
  // regardless of suite iteration order.
  out.sort((a, b) =>
    (a.ruleId || '').localeCompare(b.ruleId || '') ||
    (a.page || '').localeCompare(b.page || '') ||
    (a.evidenceRaw || '').localeCompare(b.evidenceRaw || ''));
  return out;
}

function buildRecord(result, opts = {}) {
  const { environment = 'production', project = 'default', parentScanId = null } = opts;
  const timestamp = result.generated || result.timestamp || '';
  const versions = result.versions || {};
  const findings = findingsFrom(result);
  const quality = result.quality || null;

  // Fingerprint content — everything that defines the OUTCOME, nothing that defines the OCCASION.
  const content = {
    target: result.target || '',
    environment,
    engine: versions.engine || null,
    registry: versions.registry || null,
    report: versions.report || null,
    verdict: result.verdict || null,
    quality: quality ? { overall: quality.overall, suites: quality.suites } : null,
    findings: findings.map(f => ({
      ruleId: f.ruleId, suite: f.suite, status: f.status,
      severity: f.severity, deduction: f.deduction, page: f.page,
      evidenceNormalized: f.evidenceNormalized,
    })),
  };
  const fingerprint = sha256(content);
  const scanId = sha256(fingerprint + '|' + timestamp).slice(0, 32);

  const record = {
    schemaVersion: RECORD_SCHEMA_VERSION,
    scanId,
    fingerprint,
    timestamp,
    versions: {
      engine: versions.engine || null,
      registry: versions.registry || null,
      report: versions.report || null,
      recordSchema: RECORD_SCHEMA_VERSION,
    },
    configDigest: sha256({ maxPages: (result.crawl || {}).maxPages || null, environment }),
    targetDigest: sha256(String(result.target || '')),
    environmentDigest: sha256(String(environment)),
    target: result.target || '',
    host: result.host || '',
    environment,
    project,
    verdict: result.verdict || null,
    ready: result.ready != null ? result.ready : null,
    quality,
    tally: result.tally || null,
    findings,
    parentScanId: parentScanId || null,
  };
  record.digest = sha256(recordForDigest(record));
  return record;
}

// The digest covers every field EXCEPT digest itself (can't hash a value into itself).
function recordForDigest(record) {
  const clone = {};
  for (const k of Object.keys(record)) if (k !== 'digest') clone[k] = record[k];
  return clone;
}

module.exports = { buildRecord, findingsFrom, recordForDigest, RECORD_SCHEMA_VERSION };
