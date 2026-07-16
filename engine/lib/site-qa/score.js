'use strict';
// score.js — SGEN Quality Score v2. Deterministic, explainable, no AI, no hidden math.
//
// Constitutional: this file hardcodes NO deductions and NO weights. Both come from the Rule
// Registry (rules/registry.js) — the single source of truth. Change a number there, re-run, done.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY v2 (3.0.0) — v1 had two defects that made the number untrustworthy. Both measured, not guessed:
//
//  1. THE SCORE HAD A FLOOR OF 39. v1 was `category = 100 − Σdeductions`. Since each suite's total
//     available deductions differ wildly, most suites could never reach 0. Measured against the real
//     registry: a site where EVERY SINGLE CHECK FAILS scored 39/100. It could not express "disaster".
//
//  2. SECTIONS WERE NOT COMPARABLE. Under v1, a total failure of every check in a suite scored:
//        forms 93 · console 78 · performance 72 · crossbrowser 72 · responsive 53 · links 49
//        a11y 46 · functional 26 · seo 0 · security 0
//     "Forms: 93" could mean every form check failed. 10 of 12 suites could never reach 0, so a 72 in
//     Performance (total failure) and a 72 in SEO (moderate) meant completely different things.
//
// THE v2 MODEL — score the share of weighted risk RESOLVED, not an absolute deduction total:
//   • category_score = 100 × (1 − openRisk / totalRisk)   over that suite's scorable checks
//       openRisk  = Σ deductions of its non-pass, non-manual checks
//       totalRisk = Σ deductions of ALL its non-manual checks (the worst case for that suite)
//   • overall = Σ(category_score × weight) / Σ(weight), over suites that HAVE scorable checks
//   • Every suite now uses the full 0–100. All-pass = 100. All-fail = 0. Always.
//   • 50 means the same thing in every section: half that section's weighted risk is unresolved.
//   • A suite with no scorable checks is EXCLUDED from the average (it has no opinion) rather than
//     silently scoring 100 and inflating the overall. NOTE: for 3.0.0–3.0.3 this promise was
//     UNREACHABLE — the denominator came from the registry, so it was 0 only for a suite the
//     registry had no rules for, which is never true for the 10 weighted suites. "Did not run"
//     therefore scored 100, not null. It is delivered by `opts.evaluatedRules` (see the EVALUATION
//     SCOPE block below), and only for callers that declare what ran.
//
// ⚠️ BREAKING: v2 scores are NOT comparable to v1 scores. This is why 3.0.0 is a major.
//    Re-baseline before comparing. Every scan records `model` — check it before diffing two runs.
//
// Manual + pass rows never deduct. Same input → same score, always. Every deduction still
// line-itemed with its rule id ("SEO-006 · −18 · Canonical points off").
// ─────────────────────────────────────────────────────────────────────────────────────────────

const { WEIGHTS, getById, RULES } = require('./rules/registry');

const MODEL = 'sgen-quality-v2';

// Native identity: deduction resolves ONLY by the row's ruleId (WP-001). No title lookup.
function deductionFor(row) {
  const rule = row.ruleId ? getById(row.ruleId) : null;
  if (rule) return { points: rule.manual ? 0 : rule.deduction, ruleId: rule.id };
  return { points: 0, ruleId: null };
}

// ── THE DENOMINATOR MUST COME FROM THE REGISTRY, NOT FROM THE ROWS ──────────────────────────
// Caught by a live scan of sgen.com: v2 first shipped summing totalRisk over the rows present.
// That returns **0 for every suite on every real site**, because the engine emits per-rule rows
// ONLY for violations — a passing check is a generic summary row with `ruleId: null, deduction: 0`
// ("Every page has a title tag"). So the rows carrying deductions were exactly the failing ones:
// totalRisk == openRisk → score 0. sgen.com scored quality 0 with 33 passes and 4 failures.
//
// It survived unit tests because those built suites from the FULL registry — every row had a
// ruleId. Real audit data never looks like that. Synthetic fixtures agreed with the bug.
//
// The denominator is therefore the suite's TOTAL KNOWN RISK from the registry: every non-manual
// rule that could fire in it. A suite's score is then "the share of this suite's known risk that
// is currently open" — all-pass → 100, all-fail → 0, and it still cannot floor, because it is a
// ratio (v1's floor came from the ABSOLUTE `100 − Σded`, which most suites could never drive to 0).
const TOTAL_RISK_BY_SUITE = (() => {
  const t = {};
  for (const r of (RULES || [])) {
    if (r.manual || !(r.deduction > 0)) continue;
    t[r.suite] = (t[r.suite] || 0) + r.deduction;
  }
  return t;
})();

// ── SCOPE: BOTH SIDES OF THE RATIO MOVE, OR NEITHER DOES ────────────────────────────────────
// `opts.excludeRules` lets a caller score a CHOSEN SUBSET of the registry ("score what I selected
// alone"). The only way that can be honest is if an excluded rule leaves the numerator AND the
// denominator together:
//
//   • drop it from openRisk only  -> deleting a FAILING check makes the score climb. Scope becomes
//     a score-inflation dial: de-scope everything red, ship a 100. This is the single most
//     dangerous thing this file could be made to do.
//   • drop it from totalRisk only -> deleting a PASSING check makes the score climb too (the
//     resolved risk you were being credited for vanishes from the top but stays at the bottom).
//   • drop it from both           -> the score means "share of the SELECTED set's weighted risk
//     that is resolved". Excluding a failure raises it; excluding a pass LOWERS it. Neither
//     direction is free, so scope is not gameable — it just re-asks the question on a smaller set.
//
// Excluding every rule in a suite drives its totalRisk to 0 -> score null -> compute() already
// excludes null-scoring suites from the weighted mean, so Σweight renormalises over what is left
// and the suite does not silently score 100. That existing null path is why suite-level exclusion
// needs no separate code here.
//
// Default (no opts) subtracts nothing: byte-identical to the unscoped model.

// ── EVALUATION SCOPE: A CHECK THAT NEVER RAN IS NOT A PASS ──────────────────────────────────
// THE DEFECT THIS EXISTS TO KILL: the denominator above is built from the REGISTRY at module load
// (every rule that COULD fire), while the numerator only accrues from rows that actually ran. A
// check that never executed is therefore subtracted from the TOP of the fraction ALONE — and a
// one-sided subtraction from the numerator is the exact score-inflation dial the excludeRules
// comment block above says is "the single most dangerous thing this file could be made to do".
// Not-run silently pays out as resolved risk. Measured on real data, not theorised:
//   · re-scoring the REAL sgen.com run with the render pass merely ABSENT (same site, browser
//     results gone): console 0 -> 100, performance 27 -> 79, responsive 77 -> 100, quality 72 -> 86.
//     A suite that measured NOTHING scored a perfect 100 and banked its full weight of 3.
//   · a run against a host that does not resolve scored 93 / quality 98 with 38 green ticks and
//     zero pages fetched. The worse the target, the better the report.
// The header's promise ("a suite with no scorable checks is EXCLUDED from the average rather than
// silently scoring 100") was unreachable code: totalRisk only hits 0 when the REGISTRY has no rules
// for a suite, which is never true for any of the 10 weighted suites. This is what makes it real.
//
// THE CONTRACT (what score.js needs from its caller — audit.js/pipeline.js):
//
//   compute(suitesOut, { evaluatedRules: string[] | Set<string> })
//     evaluatedRules = the id of EVERY registry rule whose detection code actually EXECUTED this
//     run, regardless of outcome (pass, fail, or clean). Not "every rule that found something" —
//     every rule that LOOKED. It is a statement about execution, not about results.
//     Omit the key entirely => LEGACY SHAPE (see below).
//
//   The caller is the only party that can know this: score.js receives suitesOut, and a real audit's
//   passing rows are generic summaries carrying `ruleId: null` ("Every page has a title tag"), so
//   execution is NOT recoverable from the rows. Do not try to infer it here.
//
//   Worked example of what the caller must declare for the two REAL sgen.com runs in this repo:
//     · A11Y-001 (axe-core WCAG, deduction 12) — axe-core is not installed (package.json deps are
//       exactly {playwright, sharp}); require.resolve throws, AXE_SRC=null, the pass is skipped. It
//       has never run in any of 72 stored runs, and its absence made a11y HIGHER.
//     · SEC-010 (security-headers roll-up, 6) — `continue`d out of the STATIC_CHECKS loop.
//     · SEO-030 (staging-leak, 20) — `continue`d out as migration-only.
//     · every method:'render' rule, whenever renderRes.rendered === 0 / the pass errored.
//   Each is a rule that cannot fire, sitting in a denominator, paying the site free credit.
//
// TWO SHAPES, BOTH SAFE:
//   · NEW (evaluatedRules given): a rule that did not run leaves openRisk AND totalRisk TOGETHER —
//     the same both-sides discipline excludeRules already applies. The score then means "share of
//     the risk we ACTUALLY EVALUATED that is resolved", and a suite whose scorable rules all came
//     back not-run has totalRisk 0 -> score null -> dropped from the weighted mean by the existing
//     null path, with Σweight renormalising over the suites that did measure something.
//   · LEGACY (key absent/malformed): every rule is assumed evaluated -> byte-identical to the
//     previous model. Proven on both real sgen.com runs (72 and 80, unchanged).
//
// THE DEFAULT, AND WHY THE UNSAFE DIRECTION IS STRUCTURALLY IMPOSSIBLE:
// "Unknown execution" is dangerous in both directions, so neither answer is taken on trust:
//   · assume-evaluated  -> today's inflation survives (a skipped check keeps paying credit).
//   · assume-not-run    -> real risk gets deleted from the denominator, and a bad site looks good a
//     different way. This is the WORSE failure: it is silent, and it moves the score UP.
// So exclusion is EVIDENCE-BACKED ONLY — never inferred, never defaulted. A rule leaves the
// denominator only if the caller POSITIVELY declares the run's evaluated set and that rule is not
// in it. Absent a declaration we do not guess; we keep the old (known, documented, non-inflating-
// further) math and the report stays honest about being un-annotated.
// On top of that, an observed failure OVERRIDES the declaration: if a rule produced a real non-pass
// scoring row in this suite, that row IS proof it ran, and no `evaluatedRules` list — mistaken,
// stale, or hostile — can drop it from the denominator (see `seen` in compute()). Consequence,
// stated as an invariant:
//     the ONLY rules a declaration can remove are ones with NO open risk — i.e. rules that would
//     otherwise have been counted as free passes. Removing those can only hold the score level or
//     LOWER it (or null the suite out). **A declaration can never raise a suite's score.**
// De-scoping is a cost, never a discount. That is what makes the unsafe direction unreachable
// rather than merely discouraged — and it also preserves openRisk <= totalRisk by construction.
// Copied, never aliased: compute() must score one fixed set, not whatever the caller mutates later.
// An EMPTY array/Set is a real claim ("nothing ran"), not a missing one — it is honoured, and with
// the observed-failure override it scores the real sgen.com run 0, not 100.
function evaluatedSetFrom(opts) {
  const v = opts && opts.evaluatedRules;
  if (v instanceof Set || Array.isArray(v)) return new Set(v);
  return null;                                                   // absent/malformed -> legacy shape
}

// Both scopes subtract from the denominator, and both must subtract from the numerator too — which
// they do: `excluded` skips the row in the openRisk loop, and `seen` force-keeps any rule that DID
// open risk. `seen` is the suite's own observed failures, so a rule whose row landed in a different
// suite than the registry assigns it is untouched here and still surfaces loudly as openRisk >
// totalRisk, exactly as before — a suite-mapping bug must not be smoothed over by this path.
function scopedTotalRisk(suiteKey, excluded, evaluated, seen) {
  const base = TOTAL_RISK_BY_SUITE[suiteKey] || 0;
  if ((!excluded || !excluded.size) && !evaluated) return base;
  let off = 0;
  for (const r of (RULES || [])) {
    if (r.suite !== suiteKey || r.manual || !(r.deduction > 0)) continue;
    if (excluded && excluded.has(r.id)) { off += r.deduction; continue; }
    // not declared as evaluated, and it opened no risk here => it never looked. It cannot be a pass.
    if (evaluated && !evaluated.has(r.id) && !(seen && seen.has(r.id))) off += r.deduction;
  }
  return Math.max(0, base - off);
}

function compute(suitesOut, opts = {}) {
  const excluded = new Set((opts && Array.isArray(opts.excludeRules)) ? opts.excludeRules : []);
  const evaluated = evaluatedSetFrom(opts);
  const categories = suitesOut.map(s => {
    const deductions = [];

    // ── COUNT EACH RULE ONCE ────────────────────────────────────────────────────────────────
    // The denominator (TOTAL_RISK_BY_SUITE) sums each rule ONCE. The numerator must do the same,
    // or the two sides measure different things.
    //
    // The engine emits MANY rows per rule — one per page or per occurrence-group:
    //   • audit.js:298 pushes up to 4 rows all carrying FORM-001 (one per page with that form)
    //   • checks-render.js:453 emits PERF-001/002 as per-page threshold VARIANTS with distinct
    //     titles, and audit.js's byTitle grouping then splits them into separate rows
    //   • checks-render.js:368 gives every axe violation ruleId A11Y-001 with a dynamic title
    //
    // Summing per row therefore counted one rule N times against a denominator that counted it
    // once. Measured: ONE footer newsletter form on 3 pages -> openRisk 15 vs totalRisk 7 ->
    // **Forms 0/100**, the value this model defines as "every check failed". Production v1 scored
    // the same rows 85. That is catastrophic false data on an ordinary site.
    //
    // The first version of this file SAW the symptom and clamped it — `Math.min(openRisk,
    // totalRisk)` with a comment admitting "openRisk can exceed totalRisk if one rule fires on
    // many pages". The clamp did not fix anything; it turned a loud bug (a nonsense ratio) into a
    // silent one (a confident 0). The clamp is gone: with each rule counted once, openRisk <=
    // totalRisk holds by construction, so it is unreachable — and if it ever fires again that is a
    // real defect that should surface, not be smoothed over.
    //
    // TRADE-OFF, stated plainly: occurrence count no longer affects the score. One broken form and
    // twelve broken forms both cost FORM-001's 5 points. That matches the registry's own semantics
    // — a deduction is defined per rule, not per occurrence — and the per-page detail is preserved
    // in `items` and in the report. Occurrence-weighting would need a per-rule cap in the registry,
    // which is a calibration decision, not a bug fix.
    const seen = new Map();                       // ruleId -> points (counted once)
    for (const row of s.checks) {
      if (row.status === 'pass' || row.status === 'manual') continue;
      const d = deductionFor(row);
      if (!(d.points > 0) || !d.ruleId) continue;
      if (excluded.has(d.ruleId)) continue;       // out of scope: leaves openRisk AND totalRisk together
      if (!seen.has(d.ruleId)) seen.set(d.ruleId, d.points);
      deductions.push({ label: row.name, points: d.points, ruleId: d.ruleId, status: row.status });
    }
    const openRisk = [...seen.values()].reduce((a, p) => a + p, 0);

    deductions.sort((a, b) => b.points - a.points);

    const totalRisk = scopedTotalRisk(s.key, excluded, evaluated, seen);
    // A suite with no scorable checks LEFT — the registry knows none, every one was scoped out, or
    // (the case this file now actually reaches) every one came back NOT EVALUATED — has no opinion
    // → null, and is EXCLUDED from the overall rather than defaulting to 100, which would inflate
    // the average with a suite that measured nothing. Before evaluatedRules existed this branch was
    // unreachable for all 10 weighted suites, and "the render pass didn't run" scored console 100.
    const score = totalRisk > 0
      ? Math.max(0, Math.round(100 * (1 - openRisk / totalRisk)))
      : null;

    // notEvaluated: the rules dropped from THIS suite's denominator for never having run. Reported
    // (not just subtracted) so the client-facing report can say "we did not look at these" instead
    // of quietly narrowing the question. A shrinking denominator is a coverage fact, and coverage
    // facts that only live in the maths are how "I never looked" reads as "I looked and it's clean".
    const notEvaluated = evaluated
      ? (RULES || []).filter(r => r.suite === s.key && !r.manual && r.deduction > 0
          && !excluded.has(r.id) && !evaluated.has(r.id) && !seen.has(r.id)).map(r => r.id)
      : [];

    return {
      key: s.key,
      name: s.name,
      weight: WEIGHTS[s.key] || 0,
      score,
      deductions,
      openRisk,
      totalRisk,
      notEvaluated,
      evaluationDeclared: !!evaluated,
    };
  });

  // Weighted mean over suites that actually measured something AND carry weight.
  const scored = categories.filter(c => c.score !== null && c.weight > 0);
  const wsum = scored.reduce((a, c) => a + c.weight, 0);
  const overall = wsum > 0
    ? Math.round(scored.reduce((a, c) => a + c.score * c.weight, 0) / wsum)
    : null;

  // evaluationDeclared:false marks a score computed under the LEGACY shape — every rule assumed to
  // have run because nobody said otherwise. It is the un-annotated number, not a verified one; a
  // consumer that wants to state coverage to a client should require this to be true.
  return { overall, categories, model: MODEL, evaluationDeclared: !!evaluated };
}

module.exports = { compute, WEIGHTS, deductionFor, MODEL };
