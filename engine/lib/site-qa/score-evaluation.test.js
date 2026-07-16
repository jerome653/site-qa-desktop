'use strict';
// score-evaluation.test.js — a check that never ran must not score as a pass.
//
// THE FAILURE MODE THIS LOCKS:
// score.js builds each suite's denominator from the REGISTRY (every rule that COULD fire) while the
// numerator only accrues from rows that actually ran. So a check that did NOT run is subtracted
// from the TOP of the fraction alone — and it pays out as RESOLVED RISK. The engine cannot tell
// "I looked and it is clean" from "I never looked", and it resolves that ambiguity in the client's
// favour every time. Measured on the REAL sgen.com data below, not theorised:
//   · with the render pass merely ABSENT: console 0 -> 100, performance 27 -> 79, overall 72 -> 86.
//     A suite that measured NOTHING scored a perfect 100 and banked its full weight.
//   · a run against a host that DOES NOT RESOLVE scored 93 / quality 98 with 38 green ticks and
//     zero pages fetched. The worse the target, the better the report.
//
// WHY THE DATA HERE IS REAL. This repo's signature failure is a synthetic fixture that agrees with
// the bug: score.js's unit tests were 25/25 green while the engine scored every real site quality 0,
// because the tests built rows from the full registry (every row carrying a ruleId) while real
// audits emit `ruleId: null` summary rows for passes. An invented fixture would just agree with me
// too. So REAL_RUNS below is a verbatim capture of the two real sgen.com runs stored under
// "SGEN Site QA/engines/sgen/W5-Live-Surface-Audit/site-qa/_ui-runs" — 3.0.3 engine, registry
// 1.12.0, NEEDS ATTENTION 49%/quality 72 and 60%/quality 80. Only (status, ruleId) is kept, because
// those are the ONLY fields compute() reads; the capture reproduces each run's stored quality.overall
// exactly, and LIVE_FIDELITY below re-asserts that against the real report.json whenever those runs
// are present on the machine, so the capture cannot silently drift into fiction.
const fs = require('fs');
const { compute } = require('./score');
const { RULES, getById, WEIGHTS } = require('./rules/registry');

let pass = 0, fail = 0; const failures = [];
function ok(c, n) { if (c) pass++; else { fail++; failures.push(n); console.log('  ✗ ' + n); } }

// ── REAL DATA (verbatim capture; 0 = the row carried no ruleId, as real pass rows do) ────────────
// THREE = sgen.com 3-page run 1784139227918 (score 49, quality 72)
const THREE = [
  ["functional", "Functional", [["pass",0],["pass",0],["pass",0],["pass",0],["pass",0],["manual","FUNC-900"]]],
  ["links", "Links & Redirects", [["pass",0],["pass",0],["warn","LINK-007"],["pass",0],["pass",0],["warn","LINK-003"]]],
  ["forms", "Forms", [["warn","FORM-001"],["manual","FORM-900"]]],
  ["responsive", "Responsive", [["pass",0],["fail","RESP-004"],["warn","RESP-005"],["warn","RESP-006"],["manual","RESP-900"]]],
  ["a11y", "Accessibility", [["fail","A11Y-003"],["warn","A11Y-005"],["pass",0],["warn","A11Y-008"],["pass",0],["warn","DOM-003"],["warn","A11Y-002"],["warn","FONT-002"],["manual",0]]],
  ["seo", "SEO", [["pass",0],["warn","SEO-003"],["pass",0],["pass",0],["warn","SEO-011"],["pass",0],["pass",0],["pass",0],["pass",0],["warn","SEO-021"],["pass",0],["pass",0],["warn","SEO-027"],["pass",0],["pass",0],["pass",0]]],
  ["performance", "Performance", [["warn","PERF-003"],["pass",0],["warn","PERF-005"],["warn","DOM-004"],["warn","PERF-001"],["warn","PERF-002"],["warn","PERF-002"],["warn","PERF-006"]]],
  ["security", "Security", [["pass",0],["pass",0],["pass",0],["warn","SEC-011"],["warn","SEC-012"],["warn","SEC-013"],["warn","SEC-014"],["warn","SEC-015"],["pass",0],["warn","SEC-023"],["pass",0],["pass",0],["pass",0],["pass",0]]],
  ["crossbrowser", "Cross-Browser", [["warn","XBR-003"],["warn","XBR-003"]]],
  ["console", "Console & Network", [["fail","CON-001"],["fail","CON-002"],["warn","CON-003"]]],
];
// ONE = sgen.com 1-page run 1784157273881 (score 60, quality 80)
const ONE = [
  ["functional", "Functional", [["pass",0],["pass",0],["pass",0],["pass",0],["pass",0],["manual","FUNC-900"]]],
  ["links", "Links & Redirects", [["pass",0],["pass",0],["pass",0],["pass",0],["pass",0],["warn","LINK-003"]]],
  ["forms", "Forms", [["pass",0],["manual","FORM-900"]]],
  ["responsive", "Responsive", [["pass",0],["fail","RESP-004"],["warn","RESP-005"],["manual","RESP-900"]]],
  ["a11y", "Accessibility", [["pass",0],["pass",0],["warn","A11Y-008"],["pass",0],["warn","DOM-003"],["warn","A11Y-002"],["warn","FONT-002"],["manual",0]]],
  ["seo", "SEO", [["pass",0],["pass",0],["pass",0],["pass",0],["pass",0],["pass",0],["pass",0],["pass",0],["pass",0],["warn","SEO-021"],["pass",0],["pass",0],["warn","SEO-027"],["pass",0],["pass",0],["pass",0]]],
  ["performance", "Performance", [["warn","PERF-003"],["pass",0],["warn","PERF-005"],["warn","DOM-004"],["warn","PERF-001"],["warn","PERF-002"],["warn","PERF-006"]]],
  ["security", "Security", [["pass",0],["pass",0],["warn","SEC-011"],["warn","SEC-012"],["warn","SEC-013"],["warn","SEC-014"],["warn","SEC-015"],["pass",0],["warn","SEC-023"],["pass",0],["pass",0],["pass",0],["pass",0]]],
  ["crossbrowser", "Cross-Browser", [["warn","XBR-003"],["warn","XBR-003"]]],
  ["console", "Console & Network", [["fail","CON-001"],["fail","CON-002"]]],
];
const hydrate = (cap) => cap.map(([key, name, rows]) => ({ key, name, checks: rows.map(([status, ruleId]) => ({ status, name: ruleId || 'summary', ruleId: ruleId || null })) }));
const REAL = { three: hydrate(THREE), one: hydrate(ONE) };
const cat = (q, k) => q.categories.find(c => c.key === k);
const ALL_IDS = RULES.map(r => r.id);
const allBut = (...ids) => ALL_IDS.filter(i => !ids.includes(i));

// ── 0) the capture is the real thing (baseline: what the tool actually told a client) ───────────
const baseThree = compute(REAL.three);
const baseOne = compute(REAL.one);
ok(baseThree.overall === 72, `real 3-page run scores its stored quality 72 (got ${baseThree.overall})`);
ok(baseOne.overall === 80, `real 1-page run scores its stored quality 80 (got ${baseOne.overall})`);
ok(cat(baseThree, 'console').score === 0 && cat(baseThree, 'performance').score === 27, 'real per-suite baseline matches the stored report (console 0 · performance 27)');

// LIVE FIDELITY: if the real runs are on this machine, the capture must still reproduce them. This is
// the anti-fixture guard — the moment the capture stops agreeing with reality, this suite says so.
const LIVE = [
  ['three', 72, process.env.APPDATA && process.env.APPDATA + '/SGEN Site QA/engines/sgen/W5-Live-Surface-Audit/site-qa/_ui-runs/sgen.com-1784139227918/report.json'],
  ['one', 80, process.env.APPDATA && process.env.APPDATA + '/SGEN Site QA/engines/sgen/W5-Live-Surface-Audit/site-qa/_ui-runs/sgen.com-1784157273881/report.json'],
];
let liveChecked = 0;
for (const [k, want, p] of LIVE) {
  if (!p || !fs.existsSync(p)) continue;                       // absent on other machines: capture stands alone
  liveChecked++;
  const live = JSON.parse(fs.readFileSync(p, 'utf8'));
  ok(live.quality.overall === want, `live ${k}-page report.json still stores quality ${want}`);
  ok(compute(live.suites).overall === compute(REAL[k]).overall, `capture reproduces the LIVE ${k}-page run's suites (fixture has not drifted)`);
}
console.log(`  · live report.json cross-check: ${liveChecked ? liveChecked + ' run(s) verified' : 'skipped (runs not on this machine)'}`);

// ── 1) LEGACY SHAPE: a caller that says nothing must be byte-identical (no silent regression) ────
for (const [k, want] of [['three', 72], ['one', 80]]) {
  ok(compute(REAL[k]).overall === want, `legacy: no opts -> unchanged (${k})`);
  ok(compute(REAL[k], {}).overall === want, `legacy: empty opts -> unchanged (${k})`);
  ok(compute(REAL[k]).evaluationDeclared === false, `legacy: evaluationDeclared=false marks the un-annotated number (${k})`);
}
// A malformed declaration must NOT be read as "nothing ran" — that would delete real risk from the
// denominator on a typo. Fall back to the legacy (known, documented) math instead.
for (const bad of ['A11Y-001', 42, { a: 1 }, null, undefined, true]) {
  let got; try { got = compute(REAL.three, { evaluatedRules: bad }).overall; } catch (e) { got = 'THREW ' + e.message; }
  ok(got === 72, `malformed evaluatedRules (${JSON.stringify(bad)}) falls back to legacy, never crashes (got ${got})`);
}
// declaring that EVERYTHING ran is exactly the legacy assumption, made explicit
ok(compute(REAL.three, { evaluatedRules: ALL_IDS }).overall === 72, 'declaring every rule evaluated == the legacy assumption');
ok(compute(REAL.three, { evaluatedRules: new Set(ALL_IDS) }).overall === 72, 'a Set is accepted as well as an array');
ok(compute(REAL.three, { evaluatedRules: ALL_IDS }).evaluationDeclared === true, 'evaluationDeclared=true when the caller declares coverage');

// ── 2) THE GATE: the render pass never ran (the audit's own reproduction) ────────────────────────
// Same real site, browser results merely absent. Under the old model the suites that measured
// nothing scored 100 and PULLED THE OVERALL ABOVE the run where the tool actually worked.
const RENDER_IDS = new Set(RULES.filter(r => r.method === 'render').map(r => r.id));
const noRender = REAL.three.map(s => ({ ...s, checks: s.checks.filter(c => !(c.ruleId && RENDER_IDS.has(c.ruleId))) }));
const oldWay = compute(noRender);                                             // rows gone, nobody declared it
const newWay = compute(noRender, { evaluatedRules: allBut(...RENDER_IDS) });  // rows gone, caller declares it
ok(oldWay.overall === 86, `premise: un-declared, a render-less run still inflates to 86 vs the real 72 (got ${oldWay.overall})`);
ok(cat(oldWay, 'console').score === 100, 'premise: un-declared, a console suite that measured NOTHING scores 100');
// the fix:
ok(cat(newWay, 'console').score === null, `console scores null when every one of its rules is render-only and none ran (got ${cat(newWay, 'console').score})`);
ok(cat(newWay, 'console').totalRisk === 0, 'a suite with nothing evaluated has no denominator, not a full one');
ok(newWay.overall < oldWay.overall, `declaring the skipped pass LOWERS the overall (${oldWay.overall} -> ${newWay.overall}), never raises it`);
ok(cat(newWay, 'performance').score === 36 && cat(newWay, 'performance').totalRisk === 11, 'performance is scored on the 11 points of static risk it DID evaluate, not the 33 it did not');
ok((cat(newWay, 'console').notEvaluated || []).join(',') === 'CON-001,CON-002,CON-003', 'the suite reports WHICH rules went unevaluated — coverage is stated, not just subtracted');
// and the null suite must actually leave the weighted mean, not score 0 into it
const wOK = REAL.three.map(s => s.key).filter(k => cat(newWay, k).score !== null).reduce((a, k) => a + (WEIGHTS[k] || 0), 0);
const manual = Math.round(REAL.three.map(s => cat(newWay, s.key)).filter(c => c.score !== null && c.weight > 0)
  .reduce((a, c) => a + c.score * c.weight, 0) / wOK);
ok(newWay.overall === manual, `the null suite is EXCLUDED from the mean and Σweight renormalises over the rest (${manual})`);

// ── 3) axe-core: the accessibility engine that has never run in any of 72 stored runs ───────────
// package.json deps are exactly {playwright, sharp}; require.resolve('axe-core') -> MODULE_NOT_FOUND
// -> AXE_SRC=null -> the pass is skipped. The real 3-page report carries the row "Deep WCAG scan
// (axe-core) not installed" — and A11Y-001's 12 points sat in the a11y denominator as free credit.
const axeOut = compute(REAL.three, { evaluatedRules: allBut('A11Y-001') });
ok(cat(baseThree, 'a11y').score === 66 && cat(baseThree, 'a11y').totalRisk === 76, 'premise: the shipped report scored a11y 66 with A11Y-001 in the denominator');
ok(cat(axeOut, 'a11y').score === 59 && cat(axeOut, 'a11y').totalRisk === 64, `a11y drops to 59/64 once the uninstalled engine leaves the denominator (got ${cat(axeOut, 'a11y').score}/${cat(axeOut, 'a11y').totalRisk})`);
ok(axeOut.overall === 71, `overall drops 72 -> 71 when axe is declared not-run (got ${axeOut.overall})`);
ok(cat(axeOut, 'a11y').score < cat(baseThree, 'a11y').score, 'the absence of the a11y engine now LOWERS a11y — it used to raise it');

// ── 4) THE INVARIANT: a declaration can never raise a score ──────────────────────────────────────
// The only rules a declaration can remove are ones with NO open risk (an observed failure force-keeps
// its rule — see below), i.e. rules that would otherwise have been counted as free passes. So
// de-scoping is a cost, never a discount. Proven exhaustively over the REAL registry × REAL data:
// every rule, one at a time, against both real runs.
let raised = [];
for (const k of ['three', 'one']) {
  const b = compute(REAL[k]).overall;
  for (const r of RULES) {
    const q = compute(REAL[k], { evaluatedRules: allBut(r.id) });
    if (q.overall > b) raised.push(`${k}/${r.id}: ${b} -> ${q.overall}`);
  }
}
ok(raised.length === 0, 'no single rule can be declared not-run to RAISE the overall: ' + (raised.slice(0, 3).join(' · ') || 'none'));
ok(RULES.length > 100, `the invariant swept the whole real registry (${RULES.length} rules × 2 real runs)`);
// per-suite, same property
let raisedSuite = [];
for (const r of RULES) {
  const q = compute(REAL.three, { evaluatedRules: allBut(r.id) });
  const before = cat(baseThree, r.suite), after = cat(q, r.suite);
  if (before && after && after.score !== null && before.score !== null && after.score > before.score) raisedSuite.push(r.id);
}
ok(raisedSuite.length === 0, 'no single de-scope raises its own suite either: ' + (raisedSuite.slice(0, 3).join(',') || 'none'));

// ── 5) AN OBSERVED FAILURE OVERRIDES THE DECLARATION (the unsafe direction, made impossible) ─────
// A non-pass row IS proof the rule ran. No evaluatedRules list — mistaken, stale, or hostile — may
// drop it from the denominator, because that would delete real, MEASURED risk and move the score UP.
const lie = compute(REAL.three, { evaluatedRules: [] });   // "nothing ran at all"
ok(lie.overall !== null && lie.overall <= baseThree.overall, `claiming nothing ran cannot beat the honest score (${lie.overall} <= 72)`);
ok(lie.overall === 0, `claiming nothing ran while 20 rules visibly failed scores 0, not 100 (got ${lie.overall})`);
ok(cat(lie, 'console').score === 0 && cat(lie, 'console').totalRisk === 22, 'CON-001/002/003 all fired, so their risk stays in the denominator despite the declaration');
ok(cat(lie, 'functional').score === null, 'functional had no failures to force-keep, so it correctly nulls out');
ok((cat(lie, 'console').notEvaluated || []).length === 0, 'a rule that demonstrably ran is never reported as not-evaluated');
// targeted: de-scoping a single FAILING rule must not move the score at all
const denyFail = compute(REAL.three, { evaluatedRules: allBut('CON-001') });
ok(cat(denyFail, 'console').totalRisk === 22 && cat(denyFail, 'console').score === 0, 'declaring a rule that FAILED as not-run is ignored — openRisk <= totalRisk holds by construction');

// ── 6) excludeRules still works, and composes with evaluatedRules ────────────────────────────────
// excludeRules = "do not ask this question" (scope). evaluatedRules = "we never asked it" (coverage).
// Both must leave BOTH sides of the ratio, and an excluded rule is never reported as not-evaluated.
const scoped = compute(REAL.three, { excludeRules: ['CON-001'] });
ok(cat(scoped, 'console').totalRisk === 12 && cat(scoped, 'console').openRisk === 12, 'excludeRules still removes a rule from openRisk AND totalRisk together');
ok(compute(REAL.three, { excludeRules: ALL_IDS.filter(i => getById(i).suite === 'console') }).categories.find(c => c.key === 'console').score === null, 'excluding a whole suite still nulls it out');
const both = compute(REAL.three, { excludeRules: ['CON-001'], evaluatedRules: allBut('CON-002') });
ok(cat(both, 'console').totalRisk === 12, 'the two scopes compose: CON-001 excluded, CON-002 force-kept by its failing row');
ok(!(cat(both, 'console').notEvaluated || []).includes('CON-001'), 'an EXCLUDED rule is not reported as unevaluated — different claims, different fields');

// ── 7) shape safety: the report must not crash on the null path ──────────────────────────────────
const empty = compute([]);
ok(empty.overall === null && Array.isArray(empty.categories), 'no suites -> overall null, no crash');
const nothing = compute(REAL.three.map(s => ({ ...s, checks: [] })), { evaluatedRules: [] });
ok(nothing.overall === null, 'every suite unevaluated -> overall null (fail closed and loud, never a confident 100)');
ok(nothing.categories.every(c => c.score === null), 'a run that measured nothing has no opinion anywhere');
ok(compute(REAL.three).categories.every(c => Array.isArray(c.notEvaluated)), 'notEvaluated is always an array (legacy shape included)');

console.log(`\n${fail ? '❌ FAIL' : '✅ PASS'} · ${pass}/${pass + fail} assertions`);
if (fail) { console.log('failures:\n  - ' + failures.join('\n  - ')); process.exit(1); }
