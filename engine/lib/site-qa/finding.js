'use strict';
// finding.js — the canonical Finding model (Phase 2 items 1 & 3).
//
// A check function only decides pass/fail + evidence (title = the lookup key). ALL rule metadata
// — ruleId, ruleSlug, suite, severity, deduction, method, manual, docs — is stamped here from the
// registry and NEVER reconstructed downstream. Score, report, export and history all read these.
const reg = require('./rules/registry');

// Enrich one assembled row with its registry rule. Returns a new object (row stays inspectable).
function enrichRow(row, suiteKey) {
  // Native identity: a finding resolves ONLY by its ruleId (WP-001). No title lookup. Rows without a
  // ruleId are pass/manual/operational states with no scored rule.
  const rule = row.ruleId ? reg.getById(row.ruleId) : null;
  const scored = rule && !rule.manual && row.status !== 'pass' && row.status !== 'manual';
  return {
    ...row,
    status: row.status,                            // status is set at row build (from severity); presentation preserved
    ruleId: rule ? rule.id : null,
    ruleSlug: rule ? rule.slug : null,
    suite: rule ? rule.suite : suiteKey,           // authoritative suite comes from the registry
    severity: rule ? rule.severity : (row.severity || null),
    tier: rule ? rule.tier : null,                 // launch-readiness tier (1 blocker / 2 major / 3 polish)
    deduction: scored ? rule.deduction : 0,
    method: rule ? rule.method : null,
    manual: rule ? rule.manual : (row.status === 'manual'),
    docs: rule ? rule.docs : null,
  };
}

// Enrich every suite's rows. Optionally fire finding.created for each scored finding.
function enrichSuites(suitesOut, bus) {
  return suitesOut.map(s => ({
    ...s,
    checks: s.checks.map(row => {
      const f = enrichRow(row, s.key);
      // a finding is an actual problem (fail/warn). pass = clean, manual = unknown — neither is a "finding".
      if (bus && f.ruleId && (f.status === 'fail' || f.status === 'warn')) bus.fire('finding.created', { ruleId: f.ruleId, suite: f.suite, status: f.status, deduction: f.deduction });
      return f;
    }),
  }));
}

// Consistency audit: every scored row's registry rule (by ruleId) must live in its containing suite.
// Returns a list of mismatches (empty = clean). Used by the test suite + a dev assertion.
function suiteConsistency(suitesOut) {
  const bad = [];
  for (const s of suitesOut) for (const row of s.checks) {
    if (row.status === 'pass' || row.status === 'manual') continue;
    const rule = row.ruleId ? reg.getById(row.ruleId) : null;
    if (rule && rule.suite !== s.key) bad.push({ title: row.name, inSuite: s.key, ruleSuite: rule.suite, ruleId: rule.id });
  }
  return bad;
}

module.exports = { enrichRow, enrichSuites, suiteConsistency };
