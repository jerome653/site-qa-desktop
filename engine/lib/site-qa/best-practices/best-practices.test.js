'use strict';
// best-practices.test.js — deterministic suite for WP-007 (Suite 11 · Best Practices).
// Covers: each detector fires on a crafted fixture + stays silent on clean input · suite shape ·
// determinism · registry integration · and the CRITICAL invariant — including the advisory suite
// NEVER changes the SGEN Quality Score (weight 0). No network/AI.
const cp = require('child_process');
const REG = require('../rules/registry');
const { runBestPractices, bpRuleIds } = require('./index');
const { compute } = require('../score');

let pass = 0, fail = 0; const failures = [];
function ok(c, n) { if (c) pass++; else { fail++; failures.push(n); console.log('  ✗ ' + n); } }
function eq(a, b, n) { ok(JSON.stringify(a) === JSON.stringify(b), n + (JSON.stringify(a) === JSON.stringify(b) ? '' : ` (got ${JSON.stringify(a)} want ${JSON.stringify(b)})`)); }

const U = 'https://old.example.com/';
function suiteMap(html) { const m = {}; for (const c of runBestPractices([{ url: U, html }]).checks) m[c.ruleId] = c; return m; }
function fired(html, ruleId) { return suiteMap(html)[ruleId].status !== 'pass'; }

console.log('WP-007 — Best Practices (Suite 11) — test suite\n');

// ===========================================================================
// 1 · REGISTRY INTEGRATION
// ===========================================================================
(function registry() {
  eq(bpRuleIds(), ['BP-001', 'BP-002', 'BP-003', 'BP-004', 'BP-005', 'BP-006', 'BP-007', 'BP-008'], 'registry: 8 BP rules present');
  ok(REG.SUITES.includes('best-practices'), 'registry: best-practices suite registered');
  eq(REG.WEIGHTS['best-practices'], 0, 'registry: best-practices weight is 0 (advisory)');
  ok(REG.bySuite('best-practices').every(r => !r.manual && r.deduction > 0 && r.deterministic), 'registry: BP rules are deterministic, non-manual, scored-within-suite');
  eq(REG.SUITES.reduce((a, s) => a + (REG.WEIGHTS[s] || 0), 0), 100, 'registry: weights still total 100');
})();

// ===========================================================================
// 2 · DETECTORS — each fires on a bad fixture, silent on a clean one
// ===========================================================================
(function detectors() {
  const clean = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>x</title></head><body><a href="/p" target="_blank" rel="noopener">Read the full report</a></body></html>';
  for (const id of bpRuleIds()) ok(!fired(clean, id), 'clean: ' + id + ' does not fire on well-formed page');

  ok(fired('<html><head><meta charset="utf-8"></head><body></body></html>', 'BP-001'), 'BP-001: missing doctype fires');
  ok(fired('<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01//EN"><html></html>', 'BP-008'), 'BP-008: legacy doctype fires');
  ok(!fired('<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01//EN"><html></html>', 'BP-001'), 'BP-001: does not fire when a (legacy) doctype IS present');
  ok(fired('<!doctype html><html><head><title>x</title></head><body></body></html>', 'BP-002'), 'BP-002: missing charset fires');
  ok(fired('<!doctype html><body><center>hi</center><font>y</font></body>', 'BP-003'), 'BP-003: deprecated tags fire');
  ok(fired('<!doctype html><body><a href="/x" target="_blank">go</a></body>', 'BP-004'), 'BP-004: target=_blank without rel fires');
  ok(fired('<!doctype html><body><a href="/x">click here</a></body>', 'BP-005'), 'BP-005: generic link text fires');
  ok(fired('<!doctype html><head><meta name="generator" content="SomeCMS 4.2"></head>', 'BP-006'), 'BP-006: exposed generator fires');
  ok(fired('<!doctype html><body><button onclick="f()">x</button></body>', 'BP-007'), 'BP-007: inline handler fires');

  // detail integrity: BP-003 lists each deprecated tag; BP-006 captures the version string
  const m = suiteMap('<!doctype html><head><meta name="generator" content="SomeCMS 4.2"></head><body><center>a</center><marquee>b</marquee></body>');
  eq(m['BP-003'].items.map(i => i.id).sort(), ['center', 'marquee'], 'BP-003: items name each deprecated tag');
  eq(m['BP-006'].items[0].value, 'SomeCMS 4.2', 'BP-006: captures generator value');
})();

// ===========================================================================
// 3 · SUITE SHAPE + DETERMINISM
// ===========================================================================
(function shape() {
  const html = '<html><body><center>x</center><a target="_blank" href="/y">here</a></body></html>';
  const s1 = runBestPractices([{ url: U, html }]);
  const s2 = runBestPractices([{ url: U, html }]);
  eq(s1, s2, 'determinism: identical input → identical suite');
  eq(s1.key, 'best-practices', 'shape: suite key');
  ok(s1.advisory === true, 'shape: suite marked advisory');
  ok(s1.checks.length === 8, 'shape: one row per BP rule');
  ok(s1.checks.every(c => ['pass', 'warn', 'fail'].includes(c.status)), 'shape: valid statuses');
  ok(s1.checks.filter(c => c.status !== 'pass').every(c => c.severity === 'medium' || c.severity === 'low'), 'shape: BP findings are advisory severity (warn)');
  // multi-page aggregation
  const multi = runBestPractices([{ url: U + 'a', html: '<body><center>1</center></body>' }, { url: U + 'b', html: '<body><font>2</font></body>' }]);
  eq(multi.checks.find(c => c.ruleId === 'BP-003').items.length, 2, 'shape: aggregates findings across pages');
})();

// ===========================================================================
// 4 · SCORE NEUTRALITY — the advisory suite must not change the SGEN Quality Score
// ===========================================================================
(function neutrality() {
  const scored = [
    { key: 'security', name: 'Security', checks: [{ status: 'fail', name: 'TLS certificate has expired', ruleId: 'SEC-001' }] },
    { key: 'seo', name: 'SEO', checks: [{ status: 'fail', name: 'Missing <title>', ruleId: 'SEO-001' }] },
  ];
  const withoutBP = compute(scored);
  const bpSuite = runBestPractices([{ url: U, html: '<body><center>x</center><a target="_blank" href="/y">click here</a></body>' }]);
  ok(bpSuite.checks.some(c => c.status !== 'pass'), 'neutrality: the BP suite DOES have findings in this fixture');
  const withBP = compute([...scored, bpSuite]);
  eq(withBP.overall, withoutBP.overall, 'neutrality: overall score identical with vs without the advisory suite');
  // and the BP category is present with weight 0
  const bpCat = withBP.categories.find(c => c.key === 'best-practices');
  ok(bpCat && bpCat.weight === 0, 'neutrality: BP category scored but weight 0');
  ok(bpCat.score < 100, 'neutrality: BP sub-score reflects its own findings (advisory)');
})();

// ===========================================================================
// 5 · FROZEN REGRESSION — scores/engine unchanged by the registry growth
// ===========================================================================
(function frozen() {
  const dir = __dirname + '/..';
  const env = Object.assign({}, process.env, { SCANSTORE_PERF_N: '200', FINDINGSTORE_PERF_N: '200' });
  const run = (cmd, needle) => { try { return needle.test(cp.execSync(cmd, { cwd: dir, env }).toString()); } catch (_) { return false; } };
  ok(run('node rules/registry.test.js', /PASS · 138 rules/), 'frozen: registry 138 rules, invariants hold');
  ok(run('node scan-store/scan-store.test.js', /56\/56/), 'frozen: scan-store 56/56');
  ok(run('node finding-store/finding-store.test.js', /60\/60/), 'frozen: finding-store 60/60');
})();

console.log('\n' + (fail === 0 ? '✅ PASS' : '❌ FAIL') + ` — ${pass}/${pass + fail} assertions`);
if (fail) { console.log('Failures:\n' + failures.map(f => '  - ' + f).join('\n')); process.exit(1); }
