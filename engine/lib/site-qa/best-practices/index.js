'use strict';
// best-practices — public entry. Runs the advisory Best-Practices suite (Suite 11) over a set of page
// contexts and returns a suite shaped exactly like the 10 scored suites, so it can be dropped into a
// report or scored by the existing registry-driven score.js. Because the suite's registry weight is 0,
// including it NEVER changes the SGEN Quality Score — it carries its own advisory sub-score only.
//
//   const { runBestPractices } = require('./best-practices');
//   const suite = runBestPractices([{ url, html }, ...]);   // → { key:'best-practices', checks:[...] }
const REG = require('../rules/registry');
const { DETECTORS } = require('./checks');

// Advisory rule IDs are exactly the best-practices suite in the registry — no separate list to drift.
function bpRuleIds() { return REG.bySuite('best-practices').map(r => r.id).sort(); }

// Status from registry severity (same mapping the engine uses): critical/high → fail, medium/low → warn.
function statusFor(ruleId) {
  const r = REG.getById(ruleId);
  if (!r) return 'warn';
  return (r.severity === 'critical' || r.severity === 'high') ? 'fail' : 'warn';
}

function runBestPractices(pageContexts = []) {
  const contexts = pageContexts.filter(Boolean);
  const checks = [];
  for (const ruleId of bpRuleIds()) {
    const rule = REG.getById(ruleId);
    const detect = DETECTORS[ruleId];
    const items = [];
    if (detect) for (const ctx of contexts) for (const it of detect(ctx)) items.push(it);
    // Deterministic item order (page, then id, then value).
    items.sort((a, b) => (a.page + a.id + a.value).localeCompare(b.page + b.id + b.value));
    checks.push({
      name: rule.title,
      ruleId,
      ruleSlug: rule.slug,
      suite: 'best-practices',
      severity: rule.severity,
      deduction: rule.deduction,
      status: items.length ? statusFor(ruleId) : 'pass',
      target: contexts.length === 1 ? contexts[0].url : '',
      detail: items.length ? `${items.length} occurrence(s)` : 'ok',
      items,
    });
  }
  return { key: 'best-practices', name: 'Best Practices', advisory: true, checks };
}

module.exports = { runBestPractices, bpRuleIds, statusFor };
