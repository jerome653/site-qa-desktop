'use strict';
// timeline.js — deterministic health/quality timeline for one target, computed PURELY from the two
// immutable stores (WP-003 scans + WP-004 findings). It is a read/compute layer: it owns no state,
// mutates nothing, and given the same store content always produces byte-identical output.
//
// Per scan point it reports: overall + per-suite score, finding counts (total + by severity),
// the scan-to-scan delta (score + introduced/resolved/changed + classification), the finding
// lifecycle activity attributed to that scan, and the number of findings still OPEN at that point.
const SS = require('../scan-store');

const OPEN_STATES = new Set(['OPEN', 'CONFIRMED', 'ACTIVE', 'UPDATED', 'REOPENED']);

function countBy(arr, key) {
  const out = {};
  for (const x of arr) { const k = x[key] || 'none'; out[k] = (out[k] || 0) + 1; }
  return out;
}

function buildTimeline(scanStore, target, opts = {}) {
  const findingStore = opts.findingStore || null;
  const scans = SS.chronology(scanStore, target, false); // oldest → newest, deterministic
  const points = [];
  const openState = new Map(); // findingId → current lifecycle state (running, per scan order)

  for (let i = 0; i < scans.length; i++) {
    const s = scans[i];
    const prev = i > 0 ? scans[i - 1] : null;
    const scanDiff = prev ? SS.diffRecords(prev, s) : null;

    let lifecycle = null, openCount = null;
    if (findingStore) {
      const evts = findingStore.byScan(s.scanId).slice().sort((a, b) => a.seq - b.seq || a.recordId.localeCompare(b.recordId));
      lifecycle = countBy(evts.map(e => ({ st: e.newState })), 'st');
      for (const e of evts) openState.set(e.findingId, e.newState);
      openCount = 0;
      for (const st of openState.values()) if (OPEN_STATES.has(st)) openCount++;
    }

    points.push({
      index: i,
      scanId: s.scanId,
      timestamp: s.timestamp,
      fingerprint: s.fingerprint,
      overall: s.quality ? s.quality.overall : null,
      suites: s.quality ? s.quality.suites : null,
      findingCount: (s.findings || []).length,
      bySeverity: countBy(s.findings || [], 'severity'),
      verdict: s.verdict,
      ready: s.ready,
      delta: scanDiff ? {
        overall: scanDiff.scoreDiff.delta,
        introduced: scanDiff.counts.introduced,
        resolved: scanDiff.counts.resolved,
        changed: scanDiff.counts.changed,
        classification: scanDiff.classification,
      } : null,
      lifecycle,
      openFindings: openCount,
    });
  }

  return {
    target,
    targetDigest: scans.length ? scans[0].targetDigest : SS.sha256(String(target)),
    scanCount: scans.length,
    span: scans.length ? { first: scans[0].timestamp, last: scans[scans.length - 1].timestamp } : null,
    versions: scans.length ? scans[scans.length - 1].versions : null,
    points,
  };
}

module.exports = { buildTimeline, OPEN_STATES, countBy };
