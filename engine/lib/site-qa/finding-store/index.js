'use strict';
// finding-store — public entry. Immutable, append-only, content-addressed lifecycle/history layer
// for QA findings. Additive to the frozen architecture (ADR-0001 §4): it CONSUMES immutable WP-003
// scan records + the ruleId-only identity model (WP-001); it changes no rule, schema, event, score,
// or frozen store. Findings are evidence objects — recorded, never mutated.
//
//   const { FindingStore, ingest, verify, lineage, diffScans } = require('./finding-store');
//   const fstore = new FindingStore('.finding-store');
//   fstore.ingestScan(scanRecord, { prevScanRecord });   // engine → lifecycle, append-only
const { FindingStore, INDEX_NAMES, REOPENABLE } = require('./store');
const record = require('./record');
const lifecycle = require('./lifecycle');
const history = require('./history');
const diff = require('./diff');
const integrity = require('./integrity');
const { canonical, sha256 } = require('./digest');

const STORE_VERSION = '1.0.0';

// Convenience: ingest one scan (optionally against the target's previous scan for auto-resolve).
function ingest(store, scanRecord, opts = {}) {
  if (!(store instanceof FindingStore)) store = new FindingStore(store);
  return store.ingestScan(scanRecord, opts);
}

module.exports = {
  FindingStore, INDEX_NAMES, REOPENABLE, STORE_VERSION,
  ingest,
  // identity + record
  buildRecord: record.buildRecord, findingIdentity: record.findingIdentity,
  locationKey: record.locationKey, normalizeEvidence: record.normalizeEvidence, recordForDigest: record.recordForDigest,
  // lifecycle
  STATES: lifecycle.STATES, canTransition: lifecycle.canTransition, assertTransition: lifecycle.assertTransition, isTerminal: lifecycle.isTerminal,
  // history
  lineage: history.lineage, relations: history.relations, chronology: history.chronology,
  // diff
  diffScans: diff.diffScans, indexScan: diff.indexScan,
  // integrity
  verify: integrity.verify, recover: integrity.recover,
  // primitives
  canonical, sha256,
};
