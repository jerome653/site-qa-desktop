'use strict';
// history.js — lineage reconstruction over the immutable finding chain. Pure reads; never mutates.
const { FindingStore } = require('./store');

function asStore(s) { return s instanceof FindingStore ? s : new FindingStore(s); }

// Full lifecycle history for one finding identity, oldest→newest.
function lineage(store, findingId) {
  store = asStore(store);
  const recs = store.recordsFor(findingId);
  if (!recs.length) return null;
  const timeline = recs.map(r => ({ seq: r.seq, recordId: r.recordId, from: r.previousState, to: r.newState, kind: r.kind, scanId: r.scanRef.scanId, timestamp: r.timestamp, evidenceDigest: r.evidenceRef.evidenceDigest }));
  return {
    findingId,
    ruleId: recs[0].ruleId,
    target: recs[0].target,
    firstSeen: recs[0].timestamp,
    lastSeen: recs[recs.length - 1].timestamp,
    firstRecord: recs[0],
    currentRecord: recs[recs.length - 1],
    currentState: recs[recs.length - 1].newState,
    observations: recs.length,
    timeline,
    records: recs,
  };
}

// Parent/child link for a single record (chain is linear per finding: parentRecordId).
function relations(store, recordId) {
  store = asStore(store);
  const rec = store.get(recordId);
  if (!rec) return null;
  const parent = rec.parentRecordId ? store.get(rec.parentRecordId) : null;
  const child = store.recordsFor(rec.findingId).find(r => r.parentRecordId === recordId) || null;
  return { record: rec, parent, child };
}

// Chronology of all findings for a target (by firstSeen, then findingId).
function chronology(store, target) {
  store = asStore(store);
  const ids = store.byTarget(target);
  return ids.map(id => lineage(store, id)).filter(Boolean)
    .sort((a, b) => (a.firstSeen || '').localeCompare(b.firstSeen || '') || a.findingId.localeCompare(b.findingId));
}

module.exports = { lineage, relations, chronology };
