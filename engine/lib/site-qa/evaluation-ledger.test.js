'use strict';
// evaluation-ledger.test.js — a check that did not run must never print a green tick.
//
// THE FAILURE MODE THIS LOCKS:
// audit.js could not tell "I looked and it is clean" from "I never looked", and it resolved that
// ambiguity in the client's favour every time. Measured on the real engine, before the fix:
//
//   runAudit('https://<host-that-does-not-resolve>', { render: false })
//     -> score 93 · quality 98 · 37 GREEN TICKS · crawl.htmlPages 0
//   Among the 37: "All pages return a successful status", "Images have alt text", "HTTPS enforced
//   site-wide", "No exposed .git / config / backup". NOT ONE BYTE OF HTML WAS FETCHED. The real
//   sgen.com run, where the tool genuinely worked, scores 49. THE WORSE THE TARGET, THE BETTER THE
//   REPORT. This tool is handed to a client as evidence a rebuild is sound.
//
// Three independent mints, all covered below:
//   1. no evidence   — the pass rule was "no finding carried this key => print PASS_LABEL[key]".
//   2. swallowed throw — `catch (e) { r = null }` turned a crash into "no finding" into a green tick.
//                        Poison checks-security.js and the report went UP: 8 green security rows.
//   3. null-means-both — page-status falls through all 3 arms at status 0 (DNS failure); https-enforce
//                        returns null when its probe cannot connect. Both then printed green.
//
// WHY THE INPUTS BELOW ARE NOT FIXTURES:
// This codebase's signature failure is a synthetic fixture that agrees with the bug — score.js's unit
// tests were 25/25 green while the engine scored every real site quality 0, because the tests built
// rows from the full registry while real audits emit ruleId:null summary rows. So nothing here is
// invented: T1/T2 drive the REAL runAudit over a REAL socket (a .invalid TLD cannot resolve, by
// RFC 2606 — this is a real DNS failure, not a stub), T3 poisons a REAL module in the require cache
// and runs the REAL audit through it, and T5 re-derives CHECK_RULES from the REAL emitter call sites
// in the shipping source. The only stub is the http layer in T4, and it stubs a SUCCESS, which is the
// direction that would hide a bug, not manufacture one.
const path = require('path');
const Module = require('module');
const {
  runAudit, PASS_LABEL, STATIC_SUITE, CHECK_RULES, NOT_APPLICABLE, newLedger,
} = require('./audit');
const REG = require('./rules/registry');

let pass = 0, fail = 0; const failures = [];
function ok(c, n) { if (c) pass++; else { fail++; failures.push(n); console.log('  ✗ ' + n); } }

// A host that cannot resolve. RFC 2606 reserves .invalid precisely so this can never be registered.
const DEAD = 'https://sgen-qa-evaluation-ledger-probe.example.invalid';

(async () => {
  // ── T1 · THE HEADLINE: a host that does not resolve must not mint a single green tick ─────────
  const dead = await runAudit(DEAD, { maxPages: 2, render: false, log() {}, progress() {} });
  const greens = [];
  dead.suites.forEach(s => s.checks.forEach(c => { if (c.status === 'pass') greens.push(s.key + ' :: ' + c.name); }));
  ok(dead.crawl.htmlPages === 0, `T1 precondition: nothing was fetched (htmlPages=${dead.crawl.htmlPages})`);
  ok(greens.length === 0, `T1 dead host mints ZERO green ticks (got ${greens.length}${greens.length ? ': ' + greens.slice(0, 3).join(' | ') : ''})`);
  // The three the brief named by name — each was green at 93%/98 quality.
  const named = ['All pages return a successful status', 'Images have alt text', 'HTTPS enforced site-wide'];
  named.forEach(n => ok(!greens.includes.call ? true : !greens.some(g => g.endsWith(n)), `T1 no green tick for "${n}" on a dead host`));

  // A not-run row is not a silent drop: it must be PRESENT, and it must be visibly unverified.
  const notRun = [];
  dead.suites.forEach(s => s.checks.forEach(c => { if (c.notRun) notRun.push(c); }));
  ok(notRun.length > 0, `T1 dead host emits not-verified rows (${notRun.length})`);
  ok(notRun.every(c => c.status === 'manual'), 'T1 every not-run row carries status manual');
  ok(notRun.every(c => c.verified === false), 'T1 every not-run row carries verified:false');
  ok(notRun.every(c => /not verified/i.test(c.name)), 'T1 every not-run row NAMES itself as not verified');
  ok(notRun.every(c => /NOT a pass/i.test(c.detail || '')), 'T1 every not-run row states plainly it is NOT a pass');

  // ── T2 · THE CONTRACT the score model consumes ────────────────────────────────────────────────
  const cov = dead.coverage;
  ok(!!cov && cov.model === 'sgen-coverage-v1', 'T2 result.coverage present, model sgen-coverage-v1');
  ok(Array.isArray(cov.notEvaluatedRules) && cov.notEvaluatedRules.length > 50,
    `T2 coverage names the rules that were never evaluated (${cov.notEvaluatedRules.length})`);
  // The exact inflation path the brief calls out: console + crossbrowser have NO static rules, so
  // with no render they measure nothing and bank full registry risk as "resolved".
  ['CON-001', 'CON-002', 'CON-003', 'XBR-001', 'XBR-002', 'XBR-003'].forEach(r =>
    ok(cov.notEvaluatedRules.includes(r), `T2 ${r} reported as NOT evaluated when no browser ran`));
  // A11Y-001 = axe-core, which is not installed and has never run in any stored run.
  ok(cov.notEvaluatedRules.includes('A11Y-001'), 'T2 A11Y-001 (axe-core) reported as NOT evaluated');
  ok(cov.evaluatedRules.every(r => !cov.notEvaluatedRules.includes(r)), 'T2 evaluated and notEvaluated are disjoint');
  ok(cov.evaluatedRules.every(r => !!REG.getById(r)) && cov.notEvaluatedRules.every(r => !!REG.getById(r)),
    'T2 every rule id in the contract is a REAL registry rule');
  ok(cov.counts.rulesNotEvaluated === cov.notEvaluatedRules.length && cov.counts.rulesEvaluated === cov.evaluatedRules.length,
    'T2 coverage.counts agrees with its own arrays');
  ok(dead.tally.notRun === notRun.length, `T2 tally.notRun counts the not-run rows (${dead.tally.notRun})`);
  // notRun ⊆ manual — the four status counters must keep their exact meaning for report.js.
  ok(dead.tally.notRun <= dead.tally.manual, 'T2 tally.notRun is a subset of tally.manual (statuses unchanged)');

  // ── T3 · A POISONED MODULE MUST NOT MAKE THE REPORT BETTER ────────────────────────────────────
  // Poison the REAL checks-security module in the require cache, then run the REAL audit through it.
  // Before the fix this produced 8 green security rows and said nothing anywhere about the crash.
  const secPath = require.resolve('./lib/checks-security');
  const realSec = require('./lib/checks-security');
  const auditPath = require.resolve('./audit');
  require.cache[secPath].exports = {
    securityPageChecks() { throw new Error('POISONED MODULE (evaluation-ledger.test.js)'); },
    securitySiteProbes() { throw new Error('POISONED MODULE (evaluation-ledger.test.js)'); },
  };
  delete require.cache[auditPath];                       // re-bind audit.js to the poisoned module
  const poisoned = require('./audit');
  // Stub http so the crawl succeeds and yields one real HTML page: the ONLY thing wrong in this run
  // is the exploding module. Any green security row here is minted purely from the exception.
  const httpPath = require.resolve('../migration-qa/http');
  const realHttp = require.cache[httpPath] && require.cache[httpPath].exports;
  const HTML = '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width">'
    + '<title>Evaluation ledger probe page</title><meta name="description" content="A page long enough to satisfy the meta description length rule for this test.">'
    + '</head><body><header>h</header><nav>n</nav><main><h1>Probe</h1><p>text</p></main><footer>f</footer></body></html>';
  const okRes = (body) => ({ ok: true, status: 200, body, headers: { 'content-type': 'text/html' }, finalUrl: 'https://probe.test/', location: null, contentType: 'text/html' });
  require.cache[httpPath].exports = Object.assign({}, realHttp, {
    getText: async (u) => (/robots\.txt|sitemap|\.xml/i.test(u) ? { ok: true, status: 404, body: '', headers: {}, contentType: '', finalUrl: u, location: null } : okRes(HTML)),
    head: async () => 200,
  });
  delete require.cache[require.resolve('../migration-qa/crawl')];
  delete require.cache[require.resolve('../migration-qa/checks-static')];
  delete require.cache[auditPath];
  const poisoned2 = require('./audit');
  const pr = await poisoned2.runAudit('https://probe.test/', { maxPages: 1, render: false, log() {}, progress() {} });
  const secSuite = pr.suites.find(s => s.key === 'security');
  const secGreens = secSuite.checks.filter(c => c.status === 'pass').map(c => c.name);
  const secGreenFromCrash = secGreens.filter(n => /header|cookie|javascript|transported|exposed/i.test(n));
  ok(secGreenFromCrash.length === 0, `T3 a poisoned security module mints ZERO green security rows (got ${secGreenFromCrash.length}: ${secGreenFromCrash.join(' | ')})`);
  const secNotRun = secSuite.checks.filter(c => c.notRun);
  ok(secNotRun.length >= 4, `T3 the crash is REPORTED as not-verified rows (${secNotRun.length})`);
  ok(secNotRun.some(c => c.unverified.reason === 'check-error'), 'T3 the not-run reason is check-error, not no-evidence');
  ok(secNotRun.some(c => /POISONED MODULE/.test(c.unverified.error || '')), 'T3 the swallowed exception text reaches the report');
  ok(secNotRun.some(c => /POISONED MODULE/.test(c.detail || '')), 'T3 the exception is stated in the human-readable detail too');
  ok((pr.coverage.notEvaluatedRules || []).includes('SEC-011'), 'T3 SEC-011 reported NOT evaluated when its module crashed');
  // ...and the run that DID work still keeps its earned greens (the poison is scoped to security).
  ok(pr.suites.find(s => s.key === 'seo').checks.some(c => c.status === 'pass'),
    'T3 unaffected suites keep their green ticks (the fix is not a blanket downgrade)');

  // ── T4 · A HEALTHY PAGE STILL PASSES — the fix must not just paint everything grey ────────────
  delete require.cache[secPath]; require.cache[secPath] = undefined;
  delete require.cache[auditPath];
  delete require.cache[require.resolve('../migration-qa/crawl')];
  delete require.cache[require.resolve('../migration-qa/checks-static')];
  const healthy = require('./audit');
  const hr = await healthy.runAudit('https://probe.test/', { maxPages: 1, render: false, log() {}, progress() {} });
  const hGreens = [];
  hr.suites.forEach(s => s.checks.forEach(c => { if (c.status === 'pass') hGreens.push(c.name); }));
  ok(hGreens.length > 10, `T4 a healthy fetched page still earns its green ticks (${hGreens.length})`);
  ok(hGreens.includes('Every page has a title tag'), 'T4 a check that ran and was clean still says pass');
  ok(hr.coverage.evaluatedRules.includes('SEO-001'), 'T4 coverage reports SEO-001 as evaluated on a real page');
  // The static families are evaluated here, so none of them may claim "no evidence".
  const staticNotRun = [];
  hr.suites.forEach(s => s.checks.forEach(c => { if (c.notRun && c.unverified.reason === 'no-evidence' && !/render|browser|axe/i.test(c.name)) staticNotRun.push(c.name); }));
  ok(staticNotRun.length === 0, `T4 no static check claims "no evidence" when a page WAS fetched (got: ${staticNotRun.join(' | ')})`);

  // restore the real modules for anything downstream in this process
  delete require.cache[httpPath]; require.cache[httpPath] = undefined;
  void realSec;

  // ── T5 · CHECK_RULES MUST NOT DRIFT FROM THE REAL EMITTERS ───────────────────────────────────
  // CHECK_RULES is hand-written (the registry has no `check` field), so it is exactly the kind of map
  // that silently rots. Re-derive it from the shipping source — the same technique
  // pass-label-reachability.test.js uses — and fail on drift. A rule added without a CHECK_RULES
  // entry would be invisible to the coverage contract, i.e. silently "evaluated".
  const fs = require('fs');
  const SRC = [
    '../migration-qa/checks-static.js', 'lib/checks-security.js', 'lib/checks-seo.js',
    'lib/checks-stability.js', 'lib/checks-interaction.js', 'audit.js',
  ];
  const derived = {};
  for (const rel of SRC) {
    const t = fs.readFileSync(path.join(__dirname, rel), 'utf8');
    for (const m of t.matchAll(/(?:F|mk|push)\(\s*'([A-Z0-9]+-\d+)'\s*,\s*'([a-z0-9-]+)'/g)) (derived[m[2]] = derived[m[2]] || new Set()).add(m[1]);
    for (const m of t.matchAll(/ruleId:\s*'([A-Z0-9]+-\d+)',\s*check:\s*'([a-z0-9-]+)'/g)) (derived[m[2]] = derived[m[2]] || new Set()).add(m[1]);
  }
  let drift = 0;
  for (const [check, ids] of Object.entries(derived)) {
    if (NOT_APPLICABLE.has(check)) continue;               // deliberately not run (SEC-010 roll-up)
    const declared = new Set(CHECK_RULES[check] || []);
    for (const id of ids) if (!declared.has(id)) { drift++; console.log(`  ✗ T5 CHECK_RULES['${check}'] is missing ${id} (found at a real emitter call site)`); }
  }
  ok(drift === 0, `T5 CHECK_RULES matches the real emitter call sites (${drift} drifted)`);
  const badRule = Object.entries(CHECK_RULES).flatMap(([c, ids]) => ids.filter(i => !REG.getById(i)).map(i => c + '/' + i));
  ok(badRule.length === 0, `T5 every rule id in CHECK_RULES exists in the registry (${badRule.join(', ')})`);
  // Every PASS_LABEL key — every green tick the engine can mint — must be answerable by the contract.
  const unmapped = Object.keys(PASS_LABEL).filter(k => !CHECK_RULES[k] && !NOT_APPLICABLE.has(k));
  ok(unmapped.length === 0, `T5 every PASS_LABEL key maps to registry rules in CHECK_RULES (${unmapped.join(', ')})`);
  const notInSuite = Object.keys(CHECK_RULES).filter(k => STATIC_SUITE[k] === undefined
    && !['link-audit', 'cross-browser', 'axe', 'console-errors', 'failed-requests', 'blocking-overlay', 'cwv-lcp', 'cwv-cls', 'page-weight', 'low-contrast', 'horizontal-overflow', 'overflow-element', 'element-wider-than-viewport', 'tap-target-small', 'input-font-small'].includes(k));
  ok(notInSuite.length === 0, `T5 every static CHECK_RULES key is a real STATIC_SUITE family (${notInSuite.join(', ')})`);

  // ── T6 · THE LEDGER RULE ITSELF: a pass costs evidence ───────────────────────────────────────
  const l = newLedger();
  ok(l.verified('never-touched') === false, 'T6 a check never marked is NOT verified (silence is not a pass)');
  l.mark('clean', true);
  ok(l.verified('clean') === true, 'T6 a check that ran and returned is verified');
  const l2 = newLedger(); l2.mark('threw', false, new Error('boom'));
  ok(l2.verified('threw') === false, 'T6 a check that only ever threw is NOT verified');
  ok(l2.get('threw').error === 'boom', 'T6 the ledger keeps the exception text');
  const l3 = newLedger(); l3.mark('partial', true); l3.mark('partial', false, new Error('page 2 blew up'));
  ok(l3.verified('partial') === false, 'T6 a check that crashed on ANY page forfeits its green tick (partial != clean)');

  console.log('\n' + (fail === 0 ? '✅ PASS' : '❌ FAIL') + ` — ${pass}/${pass + fail} assertions`);
  if (fail) { failures.forEach(f => console.log('   · ' + f)); process.exit(1); }
})().catch(e => { console.log('❌ FAIL — threw: ' + (e && e.stack || e)); process.exit(1); });
