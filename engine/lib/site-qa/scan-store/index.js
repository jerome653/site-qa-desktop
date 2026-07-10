'use strict';
// scan-store — public entry. The immutable, append-only, content-addressed history layer for the
// SGEN Site Auditor. Additive to the frozen architecture (ADR-0001): it CONSUMES the frozen
// report-summary shape + the lifecycle event bus; it changes no rule, schema, event or scoring.
//
//   const { ScanStore, persist, attach } = require('./scan-store');
//   const store = new ScanStore('.scan-store');
//   const { scanId } = store.save(runAuditResult, { environment:'production', parentScanId });
//
// Store integration rule (ADR-0001 §4): only subscribers write history. Checks never touch it.
const { ScanStore, INDEX_NAMES } = require('./store');
const record = require('./record');
const history = require('./history');
const diff = require('./diff');
const integrity = require('./integrity');
const { canonical, sha256 } = require('./digest');

const STORE_VERSION = '1.0.0';

// Persist one completed audit result. `resolveParent(result)` may return the parent scanId to link
// lineage (default: latest scan for the same target).
function persist(store, result, opts = {}) {
  if (!(store instanceof ScanStore)) store = new ScanStore(store);
  let parentScanId = opts.parentScanId || null;
  if (parentScanId == null && opts.linkParent !== false) {
    const prev = history.latestForTarget(store, result.target);
    if (prev) parentScanId = prev.scanId;
  }
  return store.save(result, { environment: opts.environment || 'production', project: opts.project || 'default', parentScanId });
}

// Subscribe the store to a lifecycle bus WITHOUT changing the frozen event model. The engine already
// returns the full result from runAudit(); this helper lets a caller register a persistence callback
// that fires after a scan completes. It never mutates events or emits new event types.
function attach(bus, store, opts = {}) {
  if (!(store instanceof ScanStore)) store = new ScanStore(store);
  // The frozen scan.completed payload is a summary; the caller supplies the full result via the
  // returned persist() closure, keeping checks fully decoupled from history (ADR-0001 §4).
  return function onScanComplete(fullResult) {
    return persist(store, fullResult, opts);
  };
}

module.exports = {
  ScanStore, INDEX_NAMES, STORE_VERSION,
  buildRecord: record.buildRecord,
  persist, attach,
  // history
  chronology: history.chronology, ancestors: history.ancestors, children: history.children,
  lineage: history.lineage, latestForTarget: history.latestForTarget,
  // diff
  diff: diff.diff, diffRecords: diff.diffRecords,
  // integrity
  verify: integrity.verify, recover: integrity.recover,
  // primitives
  canonical, sha256,
};
