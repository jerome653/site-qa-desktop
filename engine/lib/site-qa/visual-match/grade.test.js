'use strict';
// grade.test.js — deterministic suite for the v5 reference-fidelity scorer (grade.js).
//
// Fixtures are plain objects shaped exactly like a visual-match run() result (pages[].viewports[].struct
// = a structDelta output, plus page.fontDrift and top-level unmatchedRef), matching this repo's no-browser
// test convention (font-checks.test.js builds its sweep fixtures the same way). grade() is PURE — it turns
// the structural facts a run collected into severity-graded findings and a fidelity score — so every rule
// is provable here without Chromium.
//
// Locks the four things a scorer can get quietly wrong: TIER classification (a background restyle must be
// a DEFECT, not a spacing tweak), the FIDELITY MATH (score = round(100·(1 − Σpenalty/Σrefweight))), the
// KEEP/IGNORE semantics (de-scoping a MISSING lifts the score; de-scoping a penalty-0 IMPROVEMENT never
// moves it), and DETERMINISM (same input → byte-identical grade).
const { grade } = require('./grade');

let pass = 0, fail = 0; const failures = [];
function ok(c, n) { if (c) pass++; else { fail++; failures.push(n); console.log('  ✗ ' + n); } }
function eq(a, b, n) { const p = JSON.stringify(a) === JSON.stringify(b); ok(p, n + (p ? '' : ` (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`)); }

// element + run builders — every field grade() reads off a real run(), so fixtures can't drift from the
// contract. `el` is a structural element (the shape READ emits); `struct` is a structDelta result; `run`
// is the top-level object grade() consumes.
const el = (o = {}) => ({ sec: 'main', tag: 'p', text: 'x', x: 0, y: 0, w: 100, h: 20, color: 'rgb(0,0,0)', bgImg: '', ...o });
const struct = (o = {}) => ({ refCount: 0, missing: [], moved: [], restyled: [], extra: [], ...o });
const page = (path, st, extra = {}) => ({ path, viewports: [{ label: '1920 · Desktop', struct: st }], ...extra });
const byKind = (g, kind) => g.findings.find(f => f.kind === kind);

console.log('sgen-visual-fidelity-v1 — grade() scoring — test suite\n');

// ── 1 · tier classification — each source of difference lands in the right severity tier ──
(function tiers() {
  const run = {
    unmatchedRef: ['/about'],
    pages: [page('/', struct({
      refCount: 10,
      missing:  [el({ tag: 'h1', text: 'gone' })],
      moved:    [{ el: el({ tag: 'p', text: 'shifted' }) }],
      restyled: [
        { el: el({ tag: 'section', text: 'hero' }), diffs: ['background a.jpg→b.jpg'], bg: true },
        { el: el({ tag: 'h2', text: 'retitled' }), diffs: ['color rgb(0,0,0)→rgb(20,20,20)'], bg: false },
      ],
      extra:    [el({ tag: 'a', text: 'new-link' })],
    }), { fontDrift: [{ family: 'Brand Sans' }], fontDriftAt: '1920 · Desktop' })],
  };
  const g = grade(run, { profile: 'balanced' });

  eq(byKind(g, 'missing-element').tier, 'MISSING', 'tier: a missing element → MISSING');
  eq(byKind(g, 'moved').tier, 'SPACING', 'tier: a moved element → SPACING');
  eq(byKind(g, 'background').tier, 'DEFECT', 'tier: a BACKGROUND restyle → DEFECT (not spacing)');
  eq(byKind(g, 'background').kind, 'background', 'tier: a bg:true restyle is kind "background", not "restyle"');
  eq(byKind(g, 'restyle').tier, 'DEFECT', 'tier: a non-bg restyle → DEFECT');
  eq(byKind(g, 'extra').tier, 'IMPROVEMENT', 'tier: an extra element → IMPROVEMENT');
  eq(byKind(g, 'font-drift').tier, 'DEFECT', 'tier: a drifted font → DEFECT');
  eq(byKind(g, 'missing-page').tier, 'MISSING', 'tier: an unmatched reference page → MISSING');

  // an IMPROVEMENT is ACCEPTABLE — it must carry a zero penalty so it can never lower the score
  eq(byKind(g, 'extra').penalty, 0, 'tier: IMPROVEMENT penalty is 0 (acceptable, never docks the score)');

  // the tier buckets tally every finding exactly once
  eq(g.tiers.MISSING.count, 2, 'tier: 2 MISSING (one element + one page)');
  eq(g.tiers.DEFECT.count, 3, 'tier: 3 DEFECT (background + restyle + font-drift)');
  eq(g.tiers.SPACING.count, 1, 'tier: 1 SPACING (the moved element)');
  eq(g.tiers.IMPROVEMENT.count, 1, 'tier: 1 IMPROVEMENT (the extra element)');
  eq(g.counts.total, 7, 'tier: 7 findings total');
})();

// A single run reused by the math / keep-ignore / strictness / determinism cases below. One page,
// refCount 10, one finding in each of the four tiers → an exactly hand-computable numerator.
const RUN = {
  pages: [page('/', struct({
    refCount: 10,
    missing:  [el({ tag: 'h1', text: 'm' })],                                                  // MISSING  → penalty 1.0
    moved:    [{ el: el({ tag: 'p', text: 'mv' }) }],                                           // SPACING  → penalty 0.1
    restyled: [{ el: el({ tag: 'section', text: 'bg' }), diffs: ['background a→b'], bg: true }],// DEFECT   → penalty 0.4
    extra:    [el({ tag: 'a', text: 'ex' })],                                                   // IMPROVEMENT → penalty 0
  }))],
};

// ── 2 · fidelity math — score = round(100·(1 − Σpenalty/Σrefweight)), a known small case exactly ──
(function math() {
  const g = grade(RUN, { profile: 'balanced' });
  // numerator = 1.0(MISSING) + 0.1(SPACING) + 0.4(DEFECT) + 0(IMPROVEMENT) = 1.5 ; denominator = refCount 10
  eq(g.numerator, 1.5, 'math: numerator = Σ penalty×refWeight over kept findings = 1.5');
  eq(g.denominator, 10, 'math: denominator = reference-element budget = 10');
  eq(g.score, 85, 'math: score = round(100·(1 − 1.5/10)) = 85');
  eq(g.model, 'sgen-visual-fidelity-v1', 'math: carries the v5 model id');
})();

// ── 3 · keep / ignore — de-scoping a MISSING lifts the score; de-scoping an IMPROVEMENT does not ──
(function keepIgnore() {
  const base = grade(RUN, { profile: 'balanced' });                 // 85
  const missId = byKind(base, 'missing-element').id;
  const extraId = byKind(base, 'extra').id;

  const noMiss = grade(RUN, { profile: 'balanced', excludeIds: [missId] });
  ok(noMiss.score > base.score, `keep/ignore: excluding the MISSING raises the score (${base.score} → ${noMiss.score})`);
  eq(noMiss.score, 95, 'keep/ignore: excluding the MISSING recomputes to exactly 95 (numerator 1.5 → 0.5)');
  eq(byKind(noMiss, 'missing-element').ignored, true, 'keep/ignore: the excluded MISSING is flagged ignored');
  eq(noMiss.counts.ignored, 1, 'keep/ignore: counts.ignored reflects the one excluded finding');

  const noExtra = grade(RUN, { profile: 'balanced', excludeIds: [extraId] });
  eq(noExtra.score, base.score, 'keep/ignore: excluding a penalty-0 IMPROVEMENT leaves the score UNCHANGED');
  eq(byKind(noExtra, 'extra').ignored, true, 'keep/ignore: the excluded IMPROVEMENT is still flagged ignored');
})();

// ── 4 · strictness ordering — score(strict) ≤ score(balanced) ≤ score(lenient) for a fixed run ──
(function strictness() {
  const s = grade(RUN, { profile: 'strict' }).score;
  const b = grade(RUN, { profile: 'balanced' }).score;
  const l = grade(RUN, { profile: 'lenient' }).score;
  ok(s <= b && b <= l, `strictness: strict(${s}) ≤ balanced(${b}) ≤ lenient(${l})`);
  // an unknown profile must fall back to the default (balanced), never throw or score differently
  eq(grade(RUN, { profile: 'nonsense' }).score, b, 'strictness: an unknown profile falls back to balanced');
  eq(grade(RUN).profile, 'balanced', 'strictness: no profile → balanced default');
})();

// ── 5 · determinism — grade(v) deep-equals grade(v) on the same input ──
(function determinism() {
  eq(grade(RUN, { profile: 'balanced' }), grade(RUN, { profile: 'balanced' }), 'determinism: identical input → identical grade');
  // finding ids are stable across runs — the property the whole keep/ignore mechanism rests on
  eq(grade(RUN).findings.map(f => f.id), grade(RUN).findings.map(f => f.id), 'determinism: finding ids are stable across re-runs');
})();

// ── 6 · missing-page weighting + empty input ──
(function weightingAndEmpty() {
  // one matched page (refCount 8) + one unmatched reference page. medianRef = 8, so the missing PAGE
  // weighs ≈ a whole page of elements — heavier than a single missing element.
  const run = {
    unmatchedRef: ['/about'],
    pages: [page('/', struct({ refCount: 8, missing: [el({ tag: 'h1', text: 'one' })] }))],
  };
  const g = grade(run, { profile: 'balanced' });
  const mpage = byKind(g, 'missing-page');
  const melem = byKind(g, 'missing-element');
  eq(mpage.refWeight, 8, 'weighting: an unmatched reference page is weighted ≈ medianRef (8) element-weights');
  eq(melem.refWeight, 1, 'weighting: a single missing element is weighted 1');
  ok(mpage.refWeight > melem.refWeight, 'weighting: a missing page is heavier than one missing element');
  ok((mpage.penalty * mpage.refWeight) > (melem.penalty * melem.refWeight), 'weighting: a missing page contributes more penalty than one missing element');
  eq(g.denominator, 16, 'weighting: denominator = matched budget 8 + missing-page budget 8 = 16');

  // no pages and no unmatched reference → nothing to compare → denominator 0 → score null (not 100, not 0)
  eq(grade({ pages: [], unmatchedRef: [] }).score, null, 'empty: no pages, no unmatchedRef → score null (denominator 0)');
  eq(grade({}).score, null, 'empty: an object with no fields at all → score null (no throw, denominator 0)');
})();

console.log('\n' + (fail === 0 ? '✅ PASS' : '❌ FAIL') + ` — ${pass}/${pass + fail} assertions`);
if (fail) { console.log('Failures:\n' + failures.map(f => '  - ' + f).join('\n')); process.exit(1); }
