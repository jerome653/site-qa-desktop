# ADR-0011 — Score Declaration Integrity (P0 · score inflation)

- **Status:** PROPOSED (2026-07-29) — **design only; nothing implemented**
- **Date:** 2026-07-29
- **Deciders:** Jerome (product) · auditor
- **Governed by:** ADR-0004 §D9 (frozen scope) · ADR-0001 (constitutional architecture)
- **Affects:** `pipeline.js` (`rescore` / `applyAdvisory`) · possibly `sgen-qa-serve.js` · **the shipped Quality Score**
- **Does NOT affect:** the scoring *model* (`score.js` maths unchanged) · registry · finding schema · report rendering · event model · provider contract · collection schema

---

## Problem statement

The SGEN Quality Score shipped by the application is **inflated on the default path**. The engine
computes an honest, coverage-declared score and then throws it away and replaces it with an
undeclared one, in which every rule that never ran is credited as resolved risk.

Measured on this branch, 2026-07-29, against a real local server, ordinary `--no-render` run:

```
audit.js (honest, declared)    79        evaluationDeclared: true
SHIPPED  (after advisory pass) 90        evaluationDeclared: false      +11 points
```

Per suite, the same run:

| Suite | honest | shipped | note |
|---|---|---|---|
| crossbrowser | **null** | **100** | measured NOTHING — no engine launched |
| console | **null** | **100** | measured NOTHING — no render pass |
| responsive | 0 | 57 | RESP-002..006 never evaluated |
| security | 73 | 88 | |
| performance | 82 | 94 | |
| seo | 77 | 81 | |

Two suites that measured *literally nothing* score a perfect 100 and bank their full registry weight.
This is the exact defect `score.js`'s own header documents at length and was written to eliminate.

---

## Current architecture (traced, not recalled)

```
sgen-qa-serve.js:1986   runAudit(url, { …, collectPages: true, … })
        │
audit.js:869-875        builds the evaluation ledger →
                        computeQuality(suites, { evaluatedRules })      ← HONEST. declared: true
        │
sgen-qa-serve.js:1997   applyAdvisory(raw)
        │
pipeline.js:49-76       pages.length > 0  ⇒  changed = true
        │               (merges FUNC-008/009, Best Practices, Copy Review)
pipeline.js:77          rescore(suites)
        │
pipeline.js:42          compute(suites)          ← ★ NO OPTS. score.js LEGACY SHAPE:
        │                                           "every rule assumed evaluated"
pipeline.js:78          { ...result, ...scored } ← ★ OVERWRITES result.quality
        │
sgen-qa-serve.js:2032   recompute WITH the declaration — but ONLY when the operator
                        narrowed scope (excludeRules / skipSuites)
```

**`compute()` is correct.** `score.js` already implements the honest model and documents it. The defect
is entirely in the **transport of the declaration** between the two call sites.

---

## Root cause

**One line: `pipeline.js:42` calls `compute(suites)` with no options.**

`score.js` treats an absent `evaluatedRules` as the *legacy shape* — "assume every rule ran" — which is
the safe default **for a caller that has no declaration**. `rescore()` does have one available
(`result.coverage.evaluatedRules`, which survives the merge — verified) and simply does not pass it.

Three aggravating facts, each measured:

1. **The overwrite is unconditional.** `{ ...result, ...scored }` replaces a *declared* quality with an
   *undeclared* one. Nothing detects that a stronger claim was downgraded to a weaker one.
2. **It only fires on the production path.** `changed` requires `pages.length > 0`, which requires
   `collectPages: true` — set by `sgen-qa-serve.js` and by `pipeline.runFullAudit`. A direct `runAudit`
   call (as most tests make) never trips it, which is why 49/49 green says nothing about this.
3. **A perverse inversion.** Measured: unscoped **90 / declared:false**, scoped **80 / declared:true**.
   **Narrowing the scope makes the score more honest by 10 points** — the operator who de-scopes gets
   the truthful number, and the one who runs a full audit does not.

---

## Constraints

- `score.js`'s model, formulas and both shapes stay **unchanged**. This is a transport fix.
- ADR-0004 §D9 frozen scope: no registry, finding schema, report rendering, event model change.
- **The fix must LOWER scores on real sites.** Any variant that leaves them level is not a fix.
- It must not over-correct: a rule that genuinely ran must never be dropped from the denominator.
- `score.js`'s existing safety must be preserved: an observed failure (`seen`) overrides any
  declaration, so a wrong declaration can never delete real risk.

---

## Design alternatives considered

**A · Thread `evaluatedRules` through `rescore` (the obvious fix).**
`rescore(suites, { evaluatedRules: result.coverage.evaluatedRules })`.
Measured: **79 → 79 honest**, versus a correct 80. **Over-penalises by 1 point.** Cause: the declaration
is built *before* the advisory pass, so the 14 rules the advisory pass genuinely runs
(`FUNC-008`, `FUNC-009`, `BP-001..008`, `COPY-001..004`) are absent from it and get subtracted from
`functional`'s denominator while `functional` carries open risk. **Rejected as incomplete** — it trades
inflation for a smaller, opposite error.

**B · Thread it, and extend the declaration with the advisory rules that actually ran.**
`applyAdvisory` knows exactly which advisory passes it executed. Measured: **80**, matching the correct
value. **Selected core.**

**C · Make a declaration mandatory in `score.js` (fail closed).**
Strongest, and closest to this codebase's discipline — but it changes `score.js`'s public contract and
breaks every legacy caller, including stored-record replays. **Rejected for this ADR**; revisit once
every caller declares.

**D · Do not overwrite `quality` in `rescore` when the input already carries a declared one.**
Minimal, but fragile: it preserves a *stale* score computed before the advisory suites were merged, so
the number would no longer match the suites beside it. **Rejected.**

---

## Selected design

**B, plus a structural guard so this class of defect cannot recur silently.**

1. **`applyAdvisory` owns the declaration.** It is the only module that knows which advisory passes ran.
   It extends `result.coverage.evaluatedRules` with the rules of the passes it executed, and updates
   `result.coverage` so the record and the score agree.
2. **`rescore(suites, { evaluatedRules })`** — pass it through. `score.js` is untouched.
3. **The guard — the part that matters more than the fix.** A recompute may never downgrade a declared
   score to an undeclared one. If `result.quality.evaluationDeclared === true` and the recompute would
   produce `false`, that is a defect, not a fallback: fail loudly rather than silently ship the weaker
   number. This is the same discipline as `registry.validate()` and `assertTransition()`.
4. **`sgen-qa-serve.js:2032` becomes redundant** for correctness (its declaration now survives from
   upstream) and should keep passing `excludeRules` only — removing the inversion by construction.

---

## Blast radius

| Surface | Impact |
|---|---|
| `pipeline.js` | ~10 lines: `rescore` signature, declaration extension, guard |
| `sgen-qa-serve.js` | 1 line simplification (optional; behaviour already correct after the fix) |
| **`report.json` / `report.html` quality number** | **CHANGES on real sites — scores go DOWN** |
| `score.js`, registry, schemas, report renderer, events | **untouched** |
| Stored historical reports | untouched; they keep the number they were generated with |
| `readiness.js`, tally, verdict, `score` (checks-passing) | untouched — this is the `quality` stream only |
| `compare.js` trend panel | reads `score`, not `quality` — unaffected, and that is itself worth a separate look |

**Approximately 10–11 points on a `--no-render` run.** A full render run will move less, because fewer
rules go unevaluated — the true delta per site is unknown until measured across the stored corpus, and
the plan below measures it rather than estimating it.

---

## Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | Over-correction — a rule that ran gets dropped | Design B extends the declaration; `seen` override in `score.js` already makes an observed failure un-droppable |
| R2 | Client-facing scores drop without explanation | Ship with the coverage banner (already available in `result.coverage`); this is a **communications** task, not an engineering one |
| R3 | Historical comparison shows a phantom regression | Every scan records `model` + `evaluationDeclared`; the diff must refuse to compare a declared score to an undeclared one |
| R4 | A future caller reintroduces the drop | The guard (design item 3) turns it into a loud failure |
| R5 | Advisory rule list drifts from what `applyAdvisory` actually runs | Derive it from the passes executed, not a hand-written list — and test that the two agree |
| R6 | Certification baselines invalidated | Regression baselines are content-addressed; a re-baseline is required and must be explicit |

---

## Migration strategy

1. Land the fix behind **no flag**. A correctness fix that is opt-in ships the bug by default — the
   opposite of the producer wiring, where opt-in was correct because the feature was additive.
2. **Re-score the stored corpus before shipping** (28 stored runs under `_ui-runs`) to produce the real
   distribution of the change, per site and per suite.
3. Re-baseline the regression store deliberately, recording why.
4. Update `CERTIFICATION.md` — its E-rows and gate table are already stale (governance review D6).

---

## Rollback strategy

- The change is ~10 lines in one file; `git revert` restores prior behaviour exactly.
- No schema, store or artifact migration, so **no data is stranded** by a rollback.
- Stored reports are immutable and unaffected in either direction.
- The regression re-baseline is the only step needing a deliberate undo — record the prior baseline
  pointer before re-baselining.

---

## Deterministic testing strategy

**Unit**
- `rescore` with and without a declaration → declared result is not downgraded.
- The guard throws when a declared quality would be replaced by an undeclared one.
- The advisory declaration equals exactly the rules of the passes executed (R5).

**Differential (the load-bearing one, per the ADR-0006 precedent)**
- Same suites + coverage → `compute(suites, {evaluatedRules})` vs the shipped path. Must agree.
- The measured trio pinned as a golden: honest **79** · inflated **90** · corrected **80**.

**Integration — the real production path**
- Spawn `sgen-qa-serve.js`, `POST /api/run`, assert `report.json.quality.evaluationDeclared === true`.
  This is the assertion whose absence let the defect ship; `producer.test.js`'s pattern already proves
  a unit test cannot cover it.

**Regression / inversion**
- Scoped and unscoped runs of the same site must now produce the **same** quality for the same
  evaluated set — the inversion (90 vs 80) must be gone.
- `crossbrowser` and `console` must be `null`, never 100, when nothing ran.

**Golden / certification**
- Existing goldens (`82c2ea07…` inventory, `a0f727d8…` store oracle) must not move — they do not touch
  scoring. If either moves, the change escaped its blast radius.
- Full suite 49/49 and coverage ≥95% must hold.

**Production verification**
- Re-score the 28 stored runs; publish before/after per site.

**Performance**
- One extra array union per scan. Expect no measurable change; assert `projectionMs` and total scan
  duration are within noise rather than assuming it.

---

## Acceptance criteria

1. A default (unscoped) run emits `quality.evaluationDeclared === true`.
2. `crossbrowser` / `console` score `null`, not 100, when nothing was evaluated.
3. The scoped/unscoped inversion is gone.
4. Corrected value matches the measured **80**, not the naive **79** and not the inflated **90**.
5. Declaration equals the rules actually executed, advisory passes included.
6. A recompute that would downgrade a declared score fails loudly.
7. `score.js`, registry, schemas, report renderer, event model unchanged.
8. Full suite green; coverage ≥95%; both goldens unmoved.
9. Stored-corpus re-score published.
10. An integration test asserts the declaration survives the real server path.

---

## Version impact — **this one is different**

Every ADR in this programme so far moved no version, because none changed user-visible behaviour.

**This one does.** The Quality Score on the report changes for real sites. Therefore:

- **`ENGINE_VERSION` minor bump** (behaviour change, backward-compatible shape).
- `REPORT_VERSION` — **only if** the report gains the coverage banner (R2). If the fix ships without a
  rendering change, it does not move.
- `REGISTRY_VERSION`, `COLLECTION_SCHEMA_VERSION`, `PROVIDER_CONTRACT_VERSION`, `CONTRACT_VERSION` —
  unchanged.
- `release-metadata.json` regenerated **from `version.js`** via `version-authority.js` (D6), never by hand.
- **A release IS warranted here** — the first in this programme.

---

## Governance considerations

- ADR-0011 is a **scoring-model transport** change; ADR-0004 §D9 lists the scoring *model* as frozen.
  The model is untouched — but the shipped number moves, so this ADR is the record of that decision and
  should not be folded into another.
- It should NOT be bundled with the ADR-0004..0010 infrastructure branch: that branch's defining claim
  is "no user-visible behaviour changed", and this change would falsify it.
- **Every archived report generated to date carries an inflated number.** Whether prior clients are told
  is a business decision, not an engineering one. It belongs in the record.

---

## Evidence (measured 2026-07-29, this branch)

| # | Measurement | Result |
|---|---|---|
| M1 | Inflation, ordinary `--no-render` run | **79 → 90** (+11); second scenario **81 → 91** (+10) |
| M2 | Suites scoring 100 having measured nothing | `crossbrowser`, `console` |
| M3 | `evaluationDeclared` before / after the advisory merge | `true` → **`false`** |
| M4 | Naive fix (A) | **79** — 1 point BELOW correct |
| M5 | Corrected fix (B) | **80** |
| M6 | Advisory rules absent from the declaration | **14** — FUNC-008/009, BP-001..008, COPY-001..004 |
| M7 | Scoped vs unscoped inversion | **80 declared** vs **90 undeclared** |
| M8 | `result.coverage` survives `applyAdvisory` | **yes** — the declaration is available at the fix site |

---

## Related

- **`score.js`** — its header documents this exact defect class and the model that prevents it. The
  model was never wrong; its declaration was dropped in transit.
- **ADR-0004 §D6** — the same shape of defect (a value with two sources), fixed for versions.
- **ADR-0006** — the differential-oracle pattern this ADR's test strategy reuses.
- **Governance review (2026-07-29)** — D4/D5/D6 remain open and are independent of this ADR.
