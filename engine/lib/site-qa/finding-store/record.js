'use strict';
// record.js — build an IMMUTABLE finding-lifecycle record. Each record is ONE lifecycle event for
// ONE finding identity; findings are never mutated, only appended to.
//
//   findingId    = sha256(ruleId | targetDigest | locationKey)  — STABLE identity across scans.
//                  locationKey excludes evidence VALUES (page/section/element only) so the same
//                  problem in the same place keeps one identity even as its value changes.
//   evidenceDigest = sha256(normalized evidence incl. values) — changes when the evidence changes.
//   fingerprint  = sha256 of the semantic content (findingId, newState, ruleId, severity,
//                  evidenceDigest, scanId) — identical finding content → identical fingerprint;
//                  title/display text are NOT in it (WP-001).
//   recordId     = sha256(findingId | seq | newState | evidenceDigest | timestamp) — unique per event.
//   digest       = sha256(record minus digest) — tamper-evidence.
const { sha256 } = require('./digest');

const RECORD_SCHEMA_VERSION = '1.0';

function normalizeEvidence(evidence = {}) {
  const items = (evidence.items || []).map(it => ({
    page: it.page != null ? String(it.page) : '',
    section: it.section != null ? String(it.section) : '',
    id: it.id != null ? String(it.id) : '',
    value: it.value != null ? String(it.value) : '',
  }));
  // Deterministic order so evidence identity is order-independent.
  items.sort((a, b) => (a.page + a.section + a.id + a.value).localeCompare(b.page + b.section + b.id + b.value));
  return items;
}

// Location key = WHERE the finding is, independent of its VALUE. Identity anchor.
function locationKey(evidence = {}) {
  const items = normalizeEvidence(evidence);
  if (!items.length) return String(evidence.page || '');
  return items.map(it => `${it.page}#${it.section}#${it.id}`).join('|');
}

// Stable, ruleId-based finding identity. No title, no display text.
function findingIdentity({ ruleId, targetDigest, evidence }) {
  if (!ruleId) throw new Error('findingIdentity requires a ruleId (WP-001: rule IDs are the sole identity)');
  return sha256(`${ruleId}|${targetDigest || ''}|${locationKey(evidence)}`).slice(0, 32);
}

function buildRecord(fields) {
  const {
    findingId, ruleId, target, targetDigest, severity,
    previousState = null, newState,
    scanId, scanFingerprint, engineVersion,
    evidence = {}, actor = 'engine', timestamp = '', seq = 0, parentRecordId = null,
    kind = 'transition',
  } = fields;

  const evidenceNormalized = normalizeEvidence(evidence);
  const evidenceDigest = sha256(evidenceNormalized);

  // Evidence REFERENCE — the authoritative payload lives in the WP-003 scan record; here we keep a
  // digest + a normalized snapshot for diffing, tied to the source scan so there is one truth source.
  const evidenceRef = {
    scanId: scanId || null,
    scanFingerprint: scanFingerprint || null,
    evidenceDigest,
    normalized: evidenceNormalized,
    raw: typeof evidence.raw === 'string' ? evidence.raw : '',
  };

  const content = {
    findingId, ruleId, severity: severity || null,
    newState, evidenceDigest, scanId: scanId || null,
  };
  const fingerprint = sha256(content);
  const recordId = sha256(`${findingId}|${seq}|${newState}|${evidenceDigest}|${timestamp}`).slice(0, 32);

  const record = {
    schemaVersion: RECORD_SCHEMA_VERSION,
    recordId,
    findingId,
    fingerprint,
    seq,
    kind,
    ruleId,
    target: target || '',
    targetDigest: targetDigest || '',
    severity: severity || null,
    previousState,
    newState,
    scanRef: { scanId: scanId || null, scanFingerprint: scanFingerprint || null },
    engineVersion: engineVersion || null,
    evidenceRef,
    actor,
    timestamp,
    parentRecordId: parentRecordId || null,
  };
  record.digest = sha256(recordForDigest(record));
  return record;
}

function recordForDigest(record) {
  const clone = {};
  for (const k of Object.keys(record)) if (k !== 'digest') clone[k] = record[k];
  return clone;
}

module.exports = {
  buildRecord, recordForDigest, findingIdentity, locationKey, normalizeEvidence, RECORD_SCHEMA_VERSION,
};
