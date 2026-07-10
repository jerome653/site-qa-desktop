'use strict';
// timeline — public entry. The health/quality Timeline Engine for the SGEN Site Auditor: a
// deterministic analytics layer over the two immutable stores (WP-003 scans + WP-004 findings).
// Additive to the frozen architecture (ADR-0001 §4): it reads immutable records only — owns no state,
// mutates nothing, changes no rule/schema/event/score. Materialized snapshots are content-addressed
// and reproducible so a timeline can be certified.
//
//   const { buildTimeline, aggregate, TimelineStore, verify } = require('./timeline');
//   const t = buildTimeline(scanStore, target, { findingStore });
//   const a = aggregate(t, findingStore);
//   const store = new TimelineStore('.timeline'); store.save(scanStore, findingStore, target, { generatedAt });
const timeline = require('./timeline');
const agg = require('./aggregate');
const snapshot = require('./snapshot');
const integrity = require('./integrity');
const { canonical, sha256 } = require('./digest');

const STORE_VERSION = '1.0.0';

module.exports = {
  STORE_VERSION,
  buildTimeline: timeline.buildTimeline, OPEN_STATES: timeline.OPEN_STATES,
  aggregate: agg.aggregate, milestones: agg.milestones, streaks: agg.streaks, trajectory: agg.trajectory, findingRollups: agg.findingRollups,
  TimelineStore: snapshot.TimelineStore, buildSnapshot: snapshot.buildSnapshot, recordForDigest: snapshot.recordForDigest,
  verify: integrity.verify, reproduces: integrity.reproduces, recover: integrity.recover,
  canonical, sha256,
};
