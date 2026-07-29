'use strict';
// pipeline.js — the integration layer. Wires the whole auditor together into ONE flow:
//
//   live scan (runAudit)
//     → merge advisory passes: FUNC-008 content-artifacts (into Functional) + Best Practices (Suite 11)
//     → re-score deterministically (registry-driven)
//     → persist to the immutable Scan Store (WP-003)
//     → drive the Finding lifecycle (WP-004)
//     → build the Timeline (WP-005)
//     → run the Regression gate vs the baseline (WP-006)
//
// Freeze-safe (ADR-0001 §4): it CONSUMES the frozen engine's result + the public store APIs. It changes
// no rule, schema, event, or scoring math — merging FUNC-008 uses the same registry-driven compute().
// runAudit is injectable (opts.auditFn) so the flow is testable offline without a live crawl.
const { runAudit } = require('./audit');
const { compute } = require('./score');
const { RULES } = require('./rules/registry');   // ADR-0011: advisory rule sets derived from the registry, never hand-listed
const { runBestPractices } = require('./best-practices');
const { scanContentArtifacts } = require('./content-artifacts');
const { scanSpelling } = require('./spelling');
const { scanCopyReview } = require('./copy-review');
const { foldVisual } = require('./visual-match/fold');
const visualMatch = require('./visual-match');
const scanStore = require('./scan-store');
const findingStore = require('./finding-store');
const timeline = require('./timeline');
const regression = require('./regression');
const path = require('path');

// Re-derive tally + score + verdict + quality after the advisory passes change the suites.
// Uses the SAME formulas as audit.js (pass/graded ratio + registry-driven compute()).
// ── ADR-0011 · SCORE DECLARATION INTEGRITY ────────────────────────────────────────────────────────
// `evaluatedRules` is the coverage DECLARATION: the registry rules whose detection code provably ran.
// audit.js computes an honest, declared score with it; this function used to call `compute(suites)`
// with NO OPTIONS, which score.js correctly reads as its LEGACY shape — "assume every rule ran" — and
// the merge below then OVERWROTE the honest number with that one.
//
// Measured on a real site, ordinary --no-render run, before this change:
//     audit.js  79  (declared)      ->      shipped  90  (undeclared)     +11 points
//     crossbrowser  null -> 100  ·  console  null -> 100   (both measured NOTHING)
// Two suites that evaluated not one rule scored a perfect 100 and banked their full registry weight.
//
// score.js is NOT the bug and is untouched: its model was always right. The declaration was lost in
// TRANSPORT between two call sites.
function rescore(suites, opts = {}) {
  for (const s of suites) {
    const c = { pass: 0, warn: 0, fail: 0, manual: 0 };
    for (const r of s.checks) c[r.status] = (c[r.status] || 0) + 1;
    s.pass = c.pass; s.warn = c.warn; s.fail = c.fail; s.manual = c.manual;
  }
  const tally = suites.reduce((a, s) => { a.pass += s.pass; a.warn += s.warn; a.fail += s.fail; a.manual += s.manual; return a; }, { pass: 0, warn: 0, fail: 0, manual: 0 });
  const graded = tally.pass + tally.warn + tally.fail;
  const score = graded ? Math.round(tally.pass / graded * 100) : 0;
  const verdict = tally.fail > 0 ? 'NEEDS ATTENTION' : (tally.warn > 0 ? 'PASSED WITH WARNINGS' : 'ALL PASSING');
  const ready = tally.fail === 0;
  // A caller with a declaration passes it; one without (a legacy caller, a fixture) omits it and gets
  // exactly the previous behaviour. Absence is still honoured as "undeclared" — never invented.
  const quality = Array.isArray(opts.evaluatedRules)
    ? compute(suites, { evaluatedRules: opts.evaluatedRules })
    : compute(suites);
  return { tally, graded, score, verdict, ready, quality };
}

// The rules each advisory pass EVALUATES. Derived from the registry by suite rather than hand-listed,
// so a rule added to Best Practices or Copy Review is covered automatically and this map cannot drift
// from the registry (ADR-0011 risk R5). FUNC-008/009 are single-rule passes and are named directly
// because they live in a SCORED suite alongside rules these passes do not evaluate.
//
// Why this exists at all: audit.js builds its declaration BEFORE the advisory passes run, so these 14
// rules genuinely execute and are absent from it. Threading the declaration through unchanged
// therefore subtracts them from `functional`'s denominator while that suite carries open risk —
// measured at 79 against a correct 80. The fix is not to thread it; it is to COMPLETE it.
function advisoryEvaluatedRules() {
  const bySuite = (suite) => RULES.filter(r => r.suite === suite).map(r => r.id);
  return {
    contentArtifacts: ['FUNC-008'],
    spelling: ['FUNC-009'],
    bestPractices: bySuite('best-practices'),
    copyReview: bySuite('copy'),
  };
}

// ── WHICH ADVISORY PASSES RUN ─────────────────────────────────────────────────────────────────────
// Site Audit runs all four. The SEO tool runs `copyReview` alone — the content surface an SEO report
// needs, and the only one of the four that is score-neutral BY CONSTRUCTION in a run where the
// functional suite never executed. The other three cannot be selected safely there:
//   • contentArtifacts / spelling push FUNC-008/FUNC-009 into the SCORED functional suite. An SEO run
//     skips that suite, so `suites.find(s => s.key === 'functional')` is undefined and both rows are
//     silently DROPPED — while the declaration below would still name them as evaluated. A rule
//     declared evaluated with no row behind it is the ADR-0011 lie, arrived at by accident.
//   • bestPractices belongs to the whole-site tool; running it here is what seo-split.test.js
//     measured as "SEO standalone that also returns eight best-practice findings".
// The default is every pass, so Site Audit's output is byte-identical to before this seam existed.
const ADVISORY_PASSES = ['contentArtifacts', 'spelling', 'bestPractices', 'copyReview'];
function selectedPasses(opts) {
  if (!Array.isArray(opts.passes)) return ADVISORY_PASSES.slice();
  // Fail loudly on a name that is not a pass. A typo would otherwise silently disable a pass while the
  // caller believed it ran — the same class of quiet nothing this module exists to prevent.
  const unknown = opts.passes.filter(p => !ADVISORY_PASSES.includes(p));
  if (unknown.length) throw new Error(`pipeline: unknown advisory pass(es) ${unknown.join(', ')} — expected any of ${ADVISORY_PASSES.join(', ')}`);
  return ADVISORY_PASSES.filter(p => opts.passes.includes(p)); // canonical order, deduped
}

// Merge the advisory passes into a raw runAudit result. Returns a NEW result (does not mutate input).
// Re-scores only when the suites actually change (FUNC-008 / Best Practices added, or a visual suite
// already folded in) — otherwise it's a pure pass-through so the base case stays byte-for-byte.
function applyAdvisory(result, opts = {}) {
  const pages = result.pages || [];
  const suites = result.suites.map(s => ({ ...s, checks: s.checks.slice() }));
  let changed = suites.some(s => s.key === 'visual');
  // Did the ADVISORY passes actually run this call? A folded visual suite also sets `changed`, and in
  // that case no advisory rule was evaluated -- so the two must not share one flag.
  let ranAdvisory = false; // a folded visual suite already counts as a change
  const passes = selectedPasses(opts);
  const running = (p) => passes.includes(p);

  if (pages.length && passes.length && opts.advisory !== false) {
    // FUNC-008 → Functional suite (scored). One row aggregating all content artifacts across pages.
    const func = suites.find(s => s.key === 'functional');
    const pushRow = r => { if (func) func.checks.push({ status: r.status, name: r.name, target: r.target, detail: r.detail, meta: r.ruleId, items: r.items.length ? r.items : undefined, ruleId: r.ruleId, severity: r.severity, suite: 'functional', deduction: r.deduction }); };
    if (running('contentArtifacts')) pushRow(scanContentArtifacts(pages)); // FUNC-008 loose symbols / tokens / mojibake
    if (running('spelling')) pushRow(scanSpelling(pages));                  // FUNC-009 common misspellings / doubled words
    // Best Practices → advisory suite (weight 0, never moves the score).
    if (running('bestPractices') && !suites.some(s => s.key === 'best-practices')) {
      const bp = runBestPractices(pages);
      suites.push({ key: 'best-practices', name: 'Best Practices', desc: 'Advisory · modern web hygiene', icon: 'cursor', advisory: true, checks: bp.checks });
    }
    // Copy Review (Suite 13, COPY-001..004) → advisory suite, exactly like Best Practices above:
    // WEIGHTS.copy = 0 AND every row is status 'manual', so it cannot move the score by either the
    // suite-weight path or the risk path. NOT folded into 'functional' the way FUNC-008/009 are —
    // those are scored defects (a mojibake IS a bug); these are flags a human reads, and putting them
    // in a weight-18 suite would let a phrasing signal act like a defect. See registry Suite 13.
    if (running('copyReview') && !suites.some(s => s.key === 'copy')) {
      suites.push({ key: 'copy', name: 'Copy Review', desc: 'Advisory · AI flags & copy artifacts', icon: 'cursor', advisory: true, checks: scanCopyReview(pages) });
    }
    ranAdvisory = true;
    changed = true;
  }

  if (!changed) { const m = { ...result, suites }; delete m.pages; return m; }

  // ── ADR-0011 · complete the declaration, then re-score with it ──────────────────────────────────
  // This module is the ONLY place that knows which advisory passes actually executed, so it is the
  // only place that can complete the declaration audit.js started. `coverage` survives the merge
  // (verified), so the input is available right here.
  let evaluatedRules = null;
  let coverage = result.coverage;
  if (coverage && Array.isArray(coverage.evaluatedRules)) {
    const adv = advisoryEvaluatedRules();
    // Only the passes that ACTUALLY RAN are declared. Reading the same `passes` list the execution above
    // used is the point: a declaration derived from a second list could disagree with what executed, and
    // "declared evaluated but never emitted a row" is precisely the defect ADR-0011 exists to stop.
    const ran = ranAdvisory ? passes.flatMap(p => adv[p]) : [];
    const set = new Set([...coverage.evaluatedRules, ...ran]);
    evaluatedRules = [...set].sort();
    // Keep the RECORD and the SCORE in agreement: a coverage block that disagreed with the number
    // computed from it would be a second source of truth for the same fact.
    coverage = {
      ...coverage,
      evaluatedRules,
      notEvaluatedRules: (coverage.notEvaluatedRules || []).filter(id => !set.has(id)),
      counts: { ...coverage.counts, rulesEvaluated: evaluatedRules.length, rulesNotEvaluated: (coverage.notEvaluatedRules || []).filter(id => !set.has(id)).length },
    };
  }

  const scored = rescore(suites, evaluatedRules ? { evaluatedRules } : {});

  // ── THE GUARD ──────────────────────────────────────────────────────────────────────────────────
  // A recompute may NEVER downgrade a declared score to an undeclared one. That downgrade is exactly
  // how this defect shipped: an honest number was silently replaced by one that credits every rule
  // that never ran. Fail loudly instead — the same discipline as registry.validate() and
  // assertTransition(). This is the part that stops the defect CLASS, not just this instance.
  if (result.quality && result.quality.evaluationDeclared === true && scored.quality.evaluationDeclared !== true) {
    throw new Error('pipeline: refusing to replace a coverage-declared Quality Score with an undeclared one — the declaration was lost in transport (ADR-0011). This is the defect that inflated every shipped score; it must never regress silently.');
  }

  // ── A NOT-MEASURED RESULT MUST NOT BECOME A MEASURED ONE ────────────────────────────────────────
  // audit.js publishes score null / quality.overall null / verdict COULD NOT AUDIT when the crawl never
  // read a page (see reachability.js). rescore() above knows nothing about that and happily computes a
  // number from the handful of site-level checks that run without a page — measured on a 403-only
  // origin: the honest null came back out of here as 70. Exactly the ADR-0011 defect, one layer up:
  // the declaration was not lost, the NULL was.
  const blind = !!(result.reachability && result.reachability.audited === false);
  const merged = { ...result, suites, ...scored, ...(coverage ? { coverage } : {}) };
  if (blind) {
    merged.quality = result.quality;      // the not-measured object audit.js built
    merged.score = null;
    merged.verdict = 'COULD NOT AUDIT';
    merged.ready = false;
  }
  // The guard, in the same spirit as the declaration guard above: state the invariant rather than trust
  // that no future caller re-derives these three fields.
  if (blind && (merged.score != null || (merged.quality && merged.quality.overall != null))) {
    throw new Error('pipeline: refusing to publish a score for a run that never read a page — "not measured" must never be replaced by a number (see reachability.js).');
  }
  delete merged.pages; // don't persist raw HTML into the immutable record
  return merged;
}

// The full flow. Returns everything wired together.
async function runFullAudit(url, opts = {}) {
  const dataRoot = opts.dataRoot || path.resolve(process.cwd(), '.auditor-data');
  const auditFn = opts.auditFn || runAudit;
  const environment = opts.environment || 'production';
  const project = opts.project || 'default';

  // 1) live scan (advisory passes need page HTML)
  const raw = await auditFn(url, { ...opts, collectPages: true });
  // 1b) optional visual match: reference (old/live) vs candidate (this target/staging)
  let visualSummary = null;
  if (opts.compareUrl) {
    const visualFn = opts.visualFn || visualMatch.run;
    // opts.mode reaches the engine so the programmatic lane can ask for a redesign comparison too;
    // absent → visual-match normalizes to like-for-like, i.e. every existing caller is unchanged.
    // foldVisual then reads the mode back off the RESULT, so the gate holds without being re-told.
    const visual = await visualFn(opts.compareUrl, url, { maxPages: opts.maxPages, urlMap: opts.urlMap, outDir: opts.visualOutDir, mode: opts.mode, log: opts.log });
    const suite = foldVisual(visual, opts);
    visualSummary = suite.summary;
    (raw.suites = raw.suites || []).push(suite); // fold into the suites before advisory re-score
  }
  // 2) merge advisory passes + re-score
  const result = applyAdvisory(raw, opts);

  // 3) persist to the immutable stores
  const scans = new scanStore.ScanStore(path.join(dataRoot, 'scans'));
  const findings = new findingStore.FindingStore(path.join(dataRoot, 'findings'));
  const prev = scanStore.latestForTarget(scans, result.target); // BEFORE saving (for lineage + finding diff)
  const saved = scanStore.persist(scans, result, { environment, project });
  const scanRecord = scans.get(saved.scanId);
  // 4) finding lifecycle
  const ingest = findings.ingestScan(scanRecord, { prevScanRecord: prev || null });
  // 5) timeline
  const tl = timeline.buildTimeline(scans, result.target, { findingStore: findings });
  // 6) regression gate vs baseline (if one is set)
  let gate = null;
  const baselines = new regression.BaselineStore(dataRoot);
  const base = baselines.current(result.target);
  if (base && base.scanId !== saved.scanId && scans.has(base.scanId)) {
    gate = regression.buildRegression(scans, findings, { baselineScanId: base.scanId, candidateScanId: saved.scanId, generatedAt: result.generated });
  }

  return {
    result,
    scanId: saved.scanId,
    fingerprint: saved.fingerprint,
    quality: result.quality,
    verdict: result.verdict,
    findingEvents: ingest.events.length,
    visual: visualSummary,
    timeline: tl,
    regression: gate,
    stores: { scans, findings, baselines },
    setBaseline: () => baselines.set(scanRecord, { setAt: result.generated, reason: 'pipeline' }),
  };
}

module.exports = { runFullAudit, applyAdvisory, rescore };
