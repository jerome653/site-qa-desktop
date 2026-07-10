'use strict';
// regression — public entry. The deterministic Regression Engine + release gate for the SGEN Site
// Auditor. Additive to the frozen architecture (ADR-0001 §4): reads the immutable stores (WP-003
// scans + WP-004 findings) and applies an explicit policy to a WP-005-style diff to produce a
// PASS/WARN/FAIL verdict. Owns no engine state; changes no rule/schema/event/score. Verdicts are
// content-addressed + reproducible so a gate decision is certifiable.
//
//   const { BaselineStore, RegressionStore, buildRegression, DEFAULT_POLICY } = require('./regression');
//   base.set(scanStore.get(goodScanId), { setAt });
//   const { verdict } = rstore.save(scanStore, findingStore, { baselineScanId, candidateScanId, generatedAt });
const { buildRegression, recordForDigest } = require('./regression');
const { RegressionStore } = require('./store');
const { BaselineStore } = require('./baseline');
const policy = require('./policy');
const integrity = require('./integrity');
const { canonical, sha256 } = require('./digest');

const STORE_VERSION = '1.0.0';

// Convenience: gate a candidate against the target's CURRENT baseline.
function gateAgainstBaseline(scanStore, findingStore, baselineStore, target, candidateScanId, params = {}) {
  const base = baselineStore.current(target);
  if (!base) throw new Error('no baseline set for target: ' + target);
  return buildRegression(scanStore, findingStore, { baselineScanId: base.scanId, candidateScanId, policy: params.policy, generatedAt: params.generatedAt || '' });
}

module.exports = {
  STORE_VERSION,
  buildRegression, recordForDigest, gateAgainstBaseline,
  RegressionStore, BaselineStore,
  DEFAULT_POLICY: policy.DEFAULT_POLICY, resolvePolicy: policy.resolvePolicy, evaluate: policy.evaluate,
  verify: integrity.verify, reproduces: integrity.reproduces, recover: integrity.recover,
  canonical, sha256,
};
