'use strict';
// registry.test.js — Phase 2 item 14. Run: node registry.test.js  (exit 0 = 100% pass).
// Proves every rule is reachable, unique, valid, one-suite, and that enrichment stamps correctly.
const reg = require('./registry');
const { enrichRow, suiteConsistency } = require('../finding');

let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.error('  FAIL:', msg); fails++; } };

// unique ids + slugs
const ids = new Set(), slugs = new Set();
for (const r of reg.RULES) {
  ok(!ids.has(r.id), 'duplicate id ' + r.id); ids.add(r.id);
  ok(!slugs.has(r.slug), 'duplicate slug ' + r.slug); slugs.add(r.slug);
}
// every rule reachable by id + slug (no orphan)
for (const r of reg.RULES) {
  ok(reg.getById(r.id) === r, 'getById unreachable ' + r.id);
  ok(reg.getBySlug(r.slug) === r, 'getBySlug unreachable ' + r.slug);
}
// launch-readiness tier (1.5.0): every scored rule carries tier 1|2|3; manual rules carry null;
// criticals are always tier 1 (the veto layer must never miss a catastrophe)
for (const r of reg.RULES) {
  if (r.manual) ok(r.tier === null, 'manual rule must have tier null: ' + r.id);
  else ok([1, 2, 3].includes(r.tier), 'scored rule needs tier 1|2|3: ' + r.id);
  if (r.severity === 'critical') ok(r.tier === 1, 'critical must be tier 1: ' + r.id);
}
// valid metadata on every rule
for (const r of reg.RULES) {
  ok(/^[A-Z0-9]+-\d{3}$/.test(r.id), 'bad id format ' + r.id);
  ok(reg.SUITES.includes(r.suite), 'invalid suite ' + r.id);
  ok(reg.SEVERITIES.includes(r.severity), 'invalid severity ' + r.id);
  ok(reg.METHODS.includes(r.method), 'invalid method ' + r.id);
  ok((r.severity === 'manual') === r.manual, 'manual flag mismatch ' + r.id);
  ok(r.manual ? r.deduction === 0 : r.deduction > 0, 'deduction rule ' + r.id);
  ok(typeof r.docs === 'string' && r.docs.startsWith('/docs/rules/'), 'docs path ' + r.id);
  ok(r.deterministic === true, 'not deterministic ' + r.id);
  ok(!!r.category, 'missing category ' + r.id);
}
// weights total 100, every suite has rules
ok(reg.SUITES.reduce((a, s) => a + (reg.WEIGHTS[s] || 0), 0) === 100, 'weights must total 100');
for (const s of reg.SUITES) ok(reg.bySuite(s).length > 0, 'orphan suite ' + s);
// query API returns correctly-filtered sets
ok(reg.getManualRules().every(r => r.manual), 'getManualRules');
ok(reg.getRulesByMethod('cert').every(r => r.method === 'cert'), 'getRulesByMethod');
ok(reg.getRulesBySeverity('critical').every(r => r.severity === 'critical'), 'getRulesBySeverity');
// enrichment: one synthetic finding per non-manual rule (native ruleId) maps back to itself, in its own suite
const suites = reg.SUITES.map(s => ({ key: s, checks: reg.bySuite(s).filter(r => !r.manual).map(r => ({ status: 'fail', name: r.title, ruleId: r.id })) }));
const mismatches = suiteConsistency(suites);
ok(mismatches.length === 0, 'suite consistency: ' + JSON.stringify(mismatches));
for (const s of suites) for (const row of s.checks) {
  const f = enrichRow(row, s.key);
  ok(f.ruleId && f.suite === s.key && f.deduction > 0, 'enrich ' + row.name + ' -> ' + f.ruleId + '/' + f.suite + '/' + f.deduction);
}

if (fails === 0) console.log('PASS · ' + reg.RULES.length + ' rules · registry v' + reg.REGISTRY_VERSION + ' · all invariants hold');
else console.log('FAILED · ' + fails + ' assertion(s)');
process.exit(fails ? 1 : 0);
