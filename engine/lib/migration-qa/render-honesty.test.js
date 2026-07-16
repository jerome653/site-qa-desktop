'use strict';
// render-honesty.test.js — the render pass must never report a check it did not run as a check that passed.
//
// THE DEFECT, one sentence: the engine cannot tell "I looked and it is clean" from "I never looked",
// and it resolves that ambiguity in the client's favour every time. score.js builds each suite's
// denominator from the REGISTRY (every rule that COULD fire) while the numerator only accrues from
// rows that actually ran — so a check that does not run is subtracted from the TOP of the fraction
// only, and pays out as credit. The worse the target, the better the report.
//
// Why a real browser and the REAL stored runs, not fixtures: this codebase's signature failure is a
// synthetic fixture that agrees with the bug. The unit tests were 25/25 green while the engine scored
// every real site quality 0, because the tests built rows from the full registry while real audits emit
// ruleId:null summary rows. So: PerformanceObserver semantics are asserted against Chromium (only a
// real engine knows when an LCP entry fires), and every scoring claim is re-derived from the two real
// sgen.com report.json files on disk. No invented numbers.
//
//   node render-honesty.test.js

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { renderPass, sweepViewport, CWV_INIT, AXE_AVAILABLE } = require('./checks-render');
const { compute } = require('../site-qa/score');
const REG = require('../site-qa/rules/registry');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '\n      → ' + extra : '')); }
}

// The two REAL sgen.com runs through the shipped 3.0.3 engine. Optional on disk: this file must stay
// runnable in CI / on a fresh clone, so their absence SKIPS those assertions loudly rather than
// inventing stand-in data that would agree with whatever the code currently does.
const RUNS = path.join(process.env.APPDATA || '', 'SGEN Site QA', 'engines', 'sgen', 'W5-Live-Surface-Audit', 'site-qa', '_ui-runs');
const REAL = [
  { name: '3-page', file: path.join(RUNS, 'sgen.com-1784139227918', 'report.json'), a11y: 66, honest: 59 },
  { name: '1-page', file: path.join(RUNS, 'sgen.com-1784157273881', 'report.json'), a11y: 76, honest: 72 },
].map(r => ({ ...r, json: fs.existsSync(r.file) ? JSON.parse(fs.readFileSync(r.file, 'utf8')) : null }));

(async () => {
  // ── 1. THE PREMISE, FROM THE REAL RUNS ────────────────────────────────────────────────────────
  // Before asserting anything about the fix, prove the thing it is fixing is real and on disk.
  console.log('\n  — axe-core has never run (real stored runs) —');

  ok(AXE_AVAILABLE === false, 'axe-core does not resolve from the engine root (require.resolve fails)',
    'if this flips, axe was installed — re-derive the honest numbers below before trusting them');

  for (const r of REAL) {
    if (!r.json) { console.log(`  · SKIP (${r.name} run not on this machine: ${r.file})`); continue; }
    const rows = (r.json.suites || []).flatMap(s => (s.checks || []).map(c => ({ suite: s.key || s.name, ...c })));
    const axeRows = rows.filter(c => /axe/i.test(c.name || ''));
    // The only axe row in a real run says "not installed", and it is `manual` — manual rows never
    // deduct, so A11Y-001's 12 registry points sit in the denominator with nothing opposing them.
    ok(axeRows.length === 1 && axeRows[0].status === 'manual' && /not installed/i.test(axeRows[0].name),
      `${r.name}: the only axe row is manual "not installed" — axe produced no results`,
      JSON.stringify(axeRows.map(x => [x.status, x.name])));
    ok(!rows.some(c => c.ruleId === 'A11Y-001'), `${r.name}: no A11Y-001 row exists — nothing ever fired it`);
  }

  // ── 2. THE FREE CREDIT, RE-DERIVED FROM THE REAL RUNS THROUGH THE REAL SCORER ──────────────────
  // Not a claim about my code — a measurement of the engine as shipped. A11Y-001 is worth 12 of a11y's
  // 76 registry points. Because axe never runs, those 12 are never opposed, so the suite is paid for a
  // check it never performed. Excluding the rule from BOTH sides (score.js's own documented honest
  // path: "drop it from both -> the score means share of the SELECTED set's risk that is resolved")
  // is what the number becomes when the engine stops taking credit for silence.
  console.log('\n  — what axe\'s silence is worth, on the real data —');

  const a11y001 = REG.getById('A11Y-001');
  ok(a11y001 && a11y001.deduction === 12 && a11y001.suite === 'a11y',
    'A11Y-001 is a 12-point a11y rule in the registry (the size of the free credit)',
    a11y001 && `${a11y001.suite}/${a11y001.deduction}`);

  for (const r of REAL) {
    if (!r.json) { console.log(`  · SKIP (${r.name} run not on this machine)`); continue; }
    // Re-score the run's OWN suites through the real compute(), twice: as shipped, and with A11Y-001
    // excluded. Anchored to the number the stored report actually printed, so a drift in either the
    // registry or the scorer surfaces here instead of silently rewriting the baseline.
    const suites = r.json.suites;
    const asShipped = compute(suites).categories.find(c => c.key === 'a11y');
    const honest = compute(suites, { excludeRules: ['A11Y-001'] }).categories.find(c => c.key === 'a11y');

    ok(asShipped.score === r.a11y, `${r.name}: recompute reproduces the stored a11y score (${r.a11y})`, `got ${asShipped.score}`);
    ok(asShipped.totalRisk === 76 && honest.totalRisk === 64,
      `${r.name}: excluding A11Y-001 moves the denominator 76 -> 64`, `${asShipped.totalRisk} -> ${honest.totalRisk}`);
    ok(honest.openRisk === asShipped.openRisk,
      `${r.name}: the numerator does NOT move — axe contributed nothing to open risk, only to credit`);
    ok(honest.score === r.honest,
      `${r.name}: honest a11y is ${r.honest}, not ${r.a11y} — silence is worth +${r.a11y - r.honest}`, `got ${honest.score}`);
  }

  // ── 3. THE WHOLE DEFECT, END TO END, THROUGH THE REAL renderPass ───────────────────────────────
  // The scenario is not hypothetical: someone ran this engine at a host that DOES NOT RESOLVE and it
  // scored 93%, quality 98, 38 green ticks — "All pages return a successful status", "Images have alt
  // text", "HTTPS enforced site-wide" — with ZERO pages fetched. The real sgen.com run, where the tool
  // genuinely worked, scores 49%. The worse the target, the better the report.
  //
  // Here the render pass is pointed at exactly that: an unresolvable host. Nothing about the site can
  // possibly have been measured. The pass must SAY so — it must hand the scorer a list of what it never
  // looked at, so those rules can leave the numerator and denominator together instead of paying out.
  console.log('\n  — a host that does not resolve must not produce evidence —');

  const deadDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'render-honesty-dead-'));
  const dead = await renderPass(['http://sgen-does-not-resolve.invalid/'], {
    screensDir: deadDir, sampleN: 1, viewports: ['1920 · Desktop'], log: () => {},
  });

  ok(Array.isArray(dead.unverified),
    'the run reports an `unverified` list — what it never looked at is DATA, not silence',
    `got ${typeof dead.unverified}`);
  const unvIds = (dead.unverified || []).map(u => u.ruleId);
  ok(unvIds.includes('A11Y-001'),
    'A11Y-001 is reported unverified — axe never ran, so a11y has no opinion on it', JSON.stringify(unvIds));
  ok(unvIds.includes('PERF-001'),
    'PERF-001 is reported unverified — LCP never fired on a page that never loaded', JSON.stringify(unvIds));
  ok(!(dead.findings || []).some(f => f.check === 'cwv-lcp'),
    'and no cwv-lcp finding is invented — "not measured" is not "slow" either');
  ok(dead.axeRan === false, 'axeRan is false, keyed on results actually produced');
  // The proof that this is worth something: feed the list to score.js's own honest path and the free
  // credit disappears. This is the wiring the scoring wave owns (audit.js:436 calls compute() with no
  // opts) — asserted here so the signal is provably fit for that purpose the moment it is plugged in.
  if (REAL[0].json) {
    const withSignal = compute(REAL[0].json.suites, { excludeRules: unvIds }).categories.find(c => c.key === 'a11y');
    ok(withSignal.score === 59,
      'feeding `unverified` straight to score.js excludeRules yields the honest a11y 59, not 66',
      `got ${withSignal.score}`);
  }

  // ── 4. AN UNMEASURED METRIC MUST NOT BE GRADED AS GOOD ─────────────────────────────────────────
  // CWV was seeded {lcp:0, cls:0} and graded only `lcp>4000` / `lcp>2500`. lcp===0 is exactly what LCP
  // reads when NOTHING WAS MEASURED, so the unmeasured case fell through both thresholds, emitted no
  // finding, and audit.js's "no cwv-lcp finding ⇒ pass" rule printed "Largest Contentful Paint within
  // target". Across all 72 stored runs not one passing speed row carries a real measurement.
  console.log('\n  — Core Web Vitals: measured vs never measured —');

  // The "did it actually run?" contract has to be reachable to be tested. A missing export is itself a
  // failure of that contract, reported as one assertion rather than as a harness crash that buries
  // every result after it.
  ok(typeof CWV_INIT === 'string' && /lcpSeen/.test(CWV_INIT),
    'CWV_INIT records whether LCP was ever SEEN, not just its value', typeof CWV_INIT);
  ok(typeof sweepViewport === 'function', 'sweepViewport is reachable for test', typeof sweepViewport);
  if (typeof CWV_INIT !== 'string' || typeof sweepViewport !== 'function') {
    console.log('\n❌ FAIL · ' + pass + '/' + (pass + fail) + ' assertions — render pass does not expose whether it measured anything');
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(CWV_INIT);
  const page = await ctx.newPage();
  await page.setContent('<!doctype html><html><body style="margin:0"><h1 style="font-size:64px">A real painted headline</h1><p>Body copy.</p></body></html>');
  await page.waitForTimeout(600);
  const measured = await page.evaluate('window.__cwv');

  // Chromium is the oracle here: only the real engine can say whether an LCP entry actually fired.
  ok(measured.lcpSeen === true, 'a page that paints reports lcpSeen:true (the flag tracks reality)', JSON.stringify(measured));
  ok(measured.clsObserved === true, 'the layout-shift observer registers, so cls:0 is a real "nothing shifted"');

  // The grading contract, stated as the code now states it. `lcpSeen` is the gate — NOT `lcp > 0`.
  const gradedLcp = c => (c && c.lcpSeen) ? (c.lcp > 4000 ? 'poor' : c.lcp > 2500 ? 'needs-improvement' : 'good') : 'not-measured';
  const gradedCls = c => (c && c.clsObserved) ? (c.cls > 0.25 ? 'poor' : c.cls > 0.1 ? 'needs-improvement' : 'good') : 'not-measured';

  // THE REGRESSION THIS FILE EXISTS FOR. This is the exact object the old code produced when nothing
  // was measured — and the old grader called it "within target".
  const UNMEASURED = { lcp: 0, cls: 0, lcpSeen: false, clsObserved: false };
  ok(gradedLcp(UNMEASURED) === 'not-measured', 'lcp:0 with no LCP entry grades NOT MEASURED, never "within target"', gradedLcp(UNMEASURED));
  ok(gradedCls(UNMEASURED) === 'not-measured', 'cls:0 with no observer grades NOT MEASURED, never "stable"', gradedCls(UNMEASURED));
  ok(gradedLcp(measured) === 'good', 'a genuinely fast page still grades good (the guard does not swallow real passes)');
  ok(gradedCls({ cls: 0, clsObserved: true }) === 'good', 'a genuinely stable page still grades good — clsObserved, not entries, is the gate');
  ok(gradedLcp({ lcp: 5200, lcpSeen: true }) === 'poor', 'a measured slow LCP still grades poor');
  // The whole point of splitting the two flags: CLS's zero is meaningful, LCP's is not.
  ok(gradedCls({ cls: 0, clsObserved: true }) === 'good' && gradedLcp({ lcp: 0, lcpSeen: false }) === 'not-measured',
    'cls:0 and lcp:0 are NOT treated alike — one is a measurement, the other is an absence');

  // ── 4. A VIEWPORT THAT DID NOT SWEEP MUST NOT BE COUNTED AS SWEPT ──────────────────────────────
  // sweepViewport's try wrapped its ENTIRE body and returned nothing, so a failed viewport emitted no
  // finding, no shot and no log — and the caller reported `activeViewports.map(v => v.label)`, i.e.
  // what was REQUESTED. That is how a report prints "no horizontal overflow across 13 viewports —
  // clean" for a page that rendered on none of them.
  console.log('\n  — a viewport that did not sweep is not evidence —');

  const screensDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'render-honesty-'));
  const V = { label: '414 · iPhone XR/11', width: 414, height: 896, dpr: 2, touch: true, ua: 'ios' };

  // Success path, on a real page: the sweep runs and says so.
  let out = { findings: [], shots: [], failed: [] };
  const goodPage = await ctx.newPage();
  await goodPage.setContent('<!doctype html><html><body style="margin:0"><div style="width:600px;height:80px;background:#c00">overflows a 414px phone by 186px</div></body></html>');
  const sweptOk = await sweepViewport(goodPage, V, { url: 'https://example.test/a', screensDir, runContrast: false, out, log: () => {} });
  ok(sweptOk === true, 'a viewport that actually swept returns true');
  ok(out.findings.length > 0, 'and it produced the overflow findings the page really has', `${out.findings.length} finding(s)`);
  ok(out.failed.length === 0, 'and recorded no failure');

  // Failure path, forced with a REAL Playwright error (a closed page), not a stub that throws what I
  // want it to throw. This is the case the old code made invisible.
  let out2 = { findings: [], shots: [], failed: [] };
  const deadPage = await ctx.newPage();
  await deadPage.setContent('<!doctype html><html><body>gone in a moment</body></html>');
  await deadPage.close();
  const logged = [];
  const sweptDead = await sweepViewport(deadPage, V, { url: 'https://example.test/b', screensDir, runContrast: false, out: out2, log: m => logged.push(m) });

  ok(sweptDead === false, 'a viewport whose sweep threw returns false — it is NOT swept', String(sweptDead));
  ok(out2.findings.length === 0, 'it contributes no findings (it measured nothing)');
  ok(out2.failed.length === 1 && out2.failed[0].label === V.label, 'it is recorded as a failure with its label', JSON.stringify(out2.failed));
  ok(logged.some(m => /sweep FAILED/i.test(m) && /NOT counted as swept/i.test(m)),
    'and it is LOUD — the failure is logged, never silent', JSON.stringify(logged));

  // The reported matrix is the SWEPT set, not the requested set. This models exactly what renderPass
  // now returns: requested is the full ask; `viewports` is what survived.
  const requested = ['1920 · Desktop', '414 · iPhone XR/11'];
  const sweptEveryPage = new Set(['1920 · Desktop']); // the phone failed, as above
  const reported = requested.filter(l => sweptEveryPage.has(l));
  ok(reported.length === 1 && reported[0] === '1920 · Desktop',
    'the reported viewport list excludes the viewport that never rendered', JSON.stringify(reported));
  ok(reported.length !== requested.length,
    'so "N pages × M viewports · clean" can no longer count a viewport the page never rendered on');

  try { fs.rmSync(screensDir, { recursive: true, force: true }); } catch (e) {}
  await browser.close();

  const total = pass + fail;
  console.log('\n' + (fail === 0 ? '✅ PASS' : '❌ FAIL') + ` · ${pass}/${total} assertions`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('❌ FAIL · harness error\n', e); process.exit(1); });
