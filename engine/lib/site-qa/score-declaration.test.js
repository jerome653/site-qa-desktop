'use strict';
// score-declaration.test.js — ADR-0011 evidence. THE DIFFERENTIAL ORACLE.
//
// Pins the three numbers that define this defect, forever, measured from a REAL audit against a REAL
// local server (the ADR-0006 pattern: an oracle in the test, not a fixture that can agree with a bug):
//
//     80  HONEST     audit.js's declared score, before the advisory passes run
//     90  INFLATED   what the bug shipped — compute(suites) with NO declaration
//     80  CORRECT    the declaration COMPLETED with the advisory rules that genuinely ran
//
// RE-BASELINED at registry 1.15.0 (indexability & sitemap integrity, SEO-039..049 + Suite 14). HONEST
// moved 79 -> 80: the seo suite gained evaluated, passing rules on this fixture (chiefly SEO-048 — no
// robots.txt means neither Googlebot nor Bingbot is blocked), which lifts the weighted mean by a point.
// INFLATED is UNMOVED at 90, which is the assertion that actually matters: the defect signature is
// preserved and still reproduces on demand.
//
// HONEST and CORRECT now round to the SAME integer, so "naive < correct" no longer discriminates at the
// overall level. The over-penalty is unchanged and still measurable — it was never really about the
// rounded overall — so the assertion moved to where the mechanism lives: the FUNCTIONAL category, which
// the naive computation scores 91 against a correct 92 because FUNC-008/009 are missing from its
// declaration. Restated, not relaxed: deleting it would have thrown away the oracle.
//
// RE-BASELINED at registry 1.17.0 (SEO-002/004 length gates retired — Google sets no length limit).
// The fixture's one-character <title>t</title> used to emit SEO-002; it no longer does, so the naive
// undeclared computation moved 90 -> 91. HONEST and CORRECT are UNMOVED at 80, so the defect signature
// (naive inflated above the declared score) still reproduces on demand, by 11 points instead of 10.
//
// The suite fails if any future change reproduces the inflated number. That is its entire purpose.
//
// RE-BASELINING: these numbers are a function of this page + this registry. A registry change moves
// them legitimately. Re-baseline DELIBERATELY (run with SGEN_P0_PRINT=1, paste the new trio, say why in
// the commit) — never by loosening an assertion, and never by deleting the inflated number.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runAudit } = require('./audit');
const { applyAdvisory, rescore } = require('./pipeline');
const { compute } = require('./score');
const { RULES } = require('./rules/registry');

let pass = 0, fail = 0; const failures = [];
function ok(c, n) { if (c) pass++; else { fail++; failures.push(n); console.log('  ✗ ' + n); } }
function eq(a, b, n) { ok(JSON.stringify(a) === JSON.stringify(b), n + (JSON.stringify(a) === JSON.stringify(b) ? '' : ` (got ${JSON.stringify(a)})`)); }

// The golden trio. Do not edit without re-measuring.
const HONEST = 80, INFLATED = 91, CORRECT = 80;
// The category the over-penalty actually lands in, and by how much. FUNC-008/009 run but are absent
// from audit.js's pre-advisory declaration, so the naive computation subtracts them from the top of
// `functional`'s fraction only. Pinned as its own pair because the overall score can round the gap away.
const NAIVE_FUNCTIONAL = 91, CORRECT_FUNCTIONAL = 92;

// A page with REAL open functional risk (placeholder copy trips FUNC-004) and no mojibake/typos, so
// FUNC-008/009 do NOT fire. That combination is what makes the naive fix visibly wrong: `functional`
// carries open risk while the advisory rules are absent from the declaration.
const PAGE = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>t</title>'
  + '<meta name="description" content="deterministic probe page for the inversion measurement"></head>'
  + '<body><header><nav><a href="/">h</a></nav></header><h1>P0</h1>'
  + '<p>Lorem ipsum dolor sit amet placeholder text here</p><footer>f</footer></body></html>';

console.log('Score declaration integrity (ADR-0011) — test suite\n');

(async function main() {
  let srv;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p0-'));
  try {
    srv = http.createServer((q, r) => {
      if (q.url === '/robots.txt') { r.writeHead(404); return r.end('x'); }
      r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); r.end(PAGE);
    });
    await new Promise(x => srv.listen(0, '127.0.0.1', x));
    const base = 'http://127.0.0.1:' + srv.address().port + '/';

    // render:false ⇒ every method:'render' rule is genuinely NOT evaluated. The ordinary --no-render
    // path, not a contrived failure. collectPages:true is what the app passes — and is REQUIRED to
    // reach the defect at all (applyAdvisory's `changed` flag needs pages).
    const raw = await runAudit(base, { maxPages: 1, render: false, concurrency: 2, screensDir: path.join(tmp, 's'), collectPages: true });

    // ── 1 · HONEST — audit.js declares what ran ───────────────────────────────────────────────────
    eq(raw.quality.evaluationDeclared, true, 'honest: audit.js emits a DECLARED score');
    eq(raw.quality.overall, HONEST, `honest: audit.js scores ${HONEST}`);
    ok(raw.coverage.counts.rulesNotEvaluated > 0, `honest: rules genuinely un-evaluated (${raw.coverage.counts.rulesNotEvaluated})`);

    const data = applyAdvisory(raw);

    // ── 2 · THE ORACLE — reproduce EXACTLY what the bug produced ──────────────────────────────────
    // compute(suites) with no declaration is score.js's legacy shape, which is precisely what
    // pipeline.rescore() used to call. This is the bug, reconstructed from the same suites.
    const inflated = compute(data.suites);
    if (process.env.SGEN_P0_PRINT) console.log(`  TRIO honest=${raw.quality.overall} inflated=${inflated.overall} shipped=${data.quality.overall}`);
    eq(inflated.overall, INFLATED, `oracle: the undeclared computation still scores ${INFLATED} — the defect reproduces on demand`);
    eq(inflated.evaluationDeclared, false, 'oracle: …and is undeclared');
    const cat = (q, k) => (q.categories.find(c => c.key === k) || {}).score;
    eq(cat(inflated, 'crossbrowser'), 100, 'oracle: crossbrowser scores 100 having measured NOTHING');
    eq(cat(inflated, 'console'), 100, 'oracle: console scores 100 having measured NOTHING');

    // ── 3 · SHIPPED — must be the corrected value, never the inflated one ─────────────────────────
    eq(data.quality.evaluationDeclared, true, 'FIX: the shipped score is DECLARED');
    eq(data.quality.overall, CORRECT, `FIX: the shipped score is ${CORRECT}`);
    ok(data.quality.overall !== INFLATED, `FIX: the shipped score is NOT the inflated ${INFLATED}`);
    eq(cat(data.quality, 'crossbrowser'), null, 'FIX: crossbrowser is null — it measured nothing, so it has no opinion');
    eq(cat(data.quality, 'console'), null, 'FIX: console is null');
    ok(INFLATED - CORRECT === 11, `FIX: the correction is worth ${INFLATED - CORRECT} points on this page`);

    // ── 4 · THE NAIVE FIX IS WRONG — pinned so nobody "simplifies" to it ──────────────────────────
    const naive = compute(data.suites, { evaluatedRules: raw.coverage.evaluatedRules });
    eq(naive.overall, HONEST, `naive: threading audit's declaration UNCHANGED scores ${HONEST}`);
    // The over-penalty, measured where it lives. At registry 1.15.0 HONEST and CORRECT round to the same
    // overall, so comparing the two integers proves nothing; the FUNCTIONAL category is where the
    // missing FUNC-008/009 declaration actually costs points, and it still does.
    const catOf = (q, key) => ((q.categories || []).find(c => (c.key || c.suite || c.name) === key) || {}).score;
    eq(catOf(naive, 'functional'), NAIVE_FUNCTIONAL, `naive: the functional category scores ${NAIVE_FUNCTIONAL}`);
    eq(catOf(data.quality, 'functional'), CORRECT_FUNCTIONAL, `FIX: the functional category scores ${CORRECT_FUNCTIONAL} once the declaration is completed`);
    ok(catOf(naive, 'functional') < catOf(data.quality, 'functional'),
      'naive: …which is BELOW the correct value — it over-penalises the suite the advisory rules land in');
    const advisory = ['FUNC-008', 'FUNC-009',
      ...RULES.filter(r => r.suite === 'best-practices').map(r => r.id),
      ...RULES.filter(r => r.suite === 'copy').map(r => r.id)];
    const declared = new Set(raw.coverage.evaluatedRules);
    eq(advisory.filter(id => !declared.has(id)).length, 16,
      'naive: 16 advisory rules RUN but are absent from audit\'s pre-advisory declaration — the reason the naive fix is wrong');

    // ── 5 · the completed declaration is recorded, not just used ──────────────────────────────────
    ok(data.coverage.evaluatedRules.length > raw.coverage.evaluatedRules.length,
      'record: the merged coverage block declares MORE rules than audit.js alone');
    for (const id of advisory) ok(data.coverage.evaluatedRules.includes(id), `record: ${id} declared as evaluated`);
    ok(!data.coverage.notEvaluatedRules.some(id => advisory.includes(id)), 'record: no advisory rule is still listed as un-evaluated');
    eq(data.coverage.counts.rulesEvaluated, data.coverage.evaluatedRules.length, 'record: counts agree with the list');

    // ── 6 · THE GUARD — a downgrade must fail loudly, not ship quietly ────────────────────────────
    let threw = false, msg = '';
    try {
      // A result whose quality is declared but whose coverage is gone: the exact shape of the defect.
      applyAdvisory({ ...raw, coverage: undefined, pages: raw.pages || [{ url: 'https://x/', html: '<html></html>' }] });
    } catch (e) { threw = true; msg = e.message; }
    ok(threw && /declared/i.test(msg), 'guard: replacing a DECLARED score with an undeclared one THROWS');

    // ── 7 · legacy callers preserved ──────────────────────────────────────────────────────────────
    const legacySuites = data.suites.map(s => ({ ...s, checks: s.checks.slice() }));
    const legacy = rescore(legacySuites);
    eq(legacy.quality.evaluationDeclared, false, 'legacy: rescore() with no declaration is unchanged — absence is honoured, never invented');
    eq(legacy.quality.overall, INFLATED, 'legacy: …and produces exactly the previous number');
    eq(rescore(legacySuites, { evaluatedRules: data.coverage.evaluatedRules }).quality.overall, CORRECT, 'legacy: with a declaration it produces the corrected value');

    // ── 8 · nothing outside score integrity moved ─────────────────────────────────────────────────
    // The tally/verdict DO differ from `raw` — the advisory merge adds suites and rows, which is
    // pre-existing behaviour and nothing to do with this fix. The claim that matters is narrower and
    // is the one asserted: passing a declaration changes ONLY `quality`, nothing else rescore emits.
    const undeclared = rescore(data.suites.map(s => ({ ...s, checks: s.checks.slice() })));
    const declaredR = rescore(data.suites.map(s => ({ ...s, checks: s.checks.slice() })), { evaluatedRules: data.coverage.evaluatedRules });
    eq(declaredR.tally, undeclared.tally, 'scope: the declaration changes NOTHING in the tally');
    eq(declaredR.verdict, undeclared.verdict, 'scope: …nor the verdict');
    eq(declaredR.score, undeclared.score, 'scope: …nor the checks-passing score');
    eq(declaredR.ready, undeclared.ready, 'scope: …nor `ready`');
    ok(declaredR.quality.overall !== undeclared.quality.overall, 'scope: it changes ONLY the Quality Score — which is the entire point');
    eq(data.readiness, raw.readiness, 'scope: the launch-readiness verdict is untouched by the fix');
    eq(RULES.length, 163, 'scope: registry unchanged — ADR-0011 adds NO rule');
    const scoreSrc = fs.readFileSync(require.resolve('./score.js'), 'utf8');
    ok(/MODEL = 'sgen-quality-v2'/.test(scoreSrc), 'scope: score.js model untouched — the fix is transport, not maths');
  } catch (e) {
    ok(false, 'score-declaration: suite FAILED — ' + String((e && e.stack) || e).slice(0, 400));
  } finally {
    if (srv) { try { srv.close(); } catch (_) {} }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }

  console.log('\n' + (fail === 0 ? '✅ PASS' : '❌ FAIL') + ` — ${pass}/${pass + fail} assertions`);
  if (fail) { console.log('Failures:\n' + failures.map(f => '  - ' + f).join('\n')); process.exit(1); }
})();
