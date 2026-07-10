# ADR-0002 — Native Rule IDs across the shared emitter (WP-001)

- **Status:** ACCEPTED (2026-07-08) — implemented in WP-001; verified (matchTitle removed, golden parity, rename test)
- **Date:** 2026-07-08
- **Deciders:** Jerome (product) · auditor
- **Affects:** finding model · emission layer (`checks-static.js`, `checks-render.js`) · both products (qa-site + qa-migration)

## Context
WP-001 requires every emitter to produce a native `ruleId` and the removal of `matchTitle()`. While
scoping it, a coupling surfaced:

`lib/migration-qa/checks-static.js` and `checks-render.js` are **shared by two products**:
- **qa-site** groups findings by `f.check` (check-family → suite) and reads `f.section` in drill-downs.
- **qa-migration** groups by `f.section` (v2.0 Standard section, e.g. "10 Technical") in `verdict.js`,
  and by `f.check` for its check view; `report.js` displays `f.check`.

So `f.check` (family) and `f.section` (v2.0 label) are **load-bearing grouping keys for two different
products**. Replacing them with `ruleId` breaks qa-migration's section-verdict. The v2.0 `section` is a
migration presentation concern; it is not, and should not be, rule identity.

## Options
**A — Additive ruleId (recommended).** `F(ruleId, detail, url, value)` derives `title` + `severity` from
the registry (removing the duplicated severity arg) and **also emits `ruleId`**, while continuing to emit
the legacy `check` (family) and `section` (v2.0 label) fields used for grouping/presentation.
- qa-site: scoring/enrichment resolve via `getById(f.ruleId)`; `matchTitle` deleted. Grouping stays by family.
- qa-migration: unchanged — `check`/`section`/`severity`/`title` still present.
- Constitution: **identity = ruleId** (native, no title lookup) ✅; `check`/`section` are grouping/display
  scaffolding, not identity. Golden parity is byte-identical (title/severity/section/items unchanged).
- Cost: ~40 call sites gain a ruleId arg (additive, low-risk). Residual → **TD-007**.

**B — Full native.** `F(ruleId)` only; move the v2.0 `section` into the registry and migration grouping
into a migration resolver. Larger, breaks migration during transition, mixes migration metadata into the
site-qa registry. Not preferred.

**C — Split emitters.** Separate qa-site and qa-migration check layers entirely. Cleanest long-term,
largest effort; premature now.

## Decision (proposed)
Adopt **Option A**. It satisfies WP-001's constitutional goal (native `ruleId`, `matchTitle` deleted,
findings resolve from `ruleId`, reports resolve titles from the registry) with the fewest moving parts,
zero migration breakage, and byte-identical golden parity. Decision policy favours it: deterministic,
simplest, fewest moving parts, explicit.

## Consequences
- Positive: WP-001 completes without a two-product rewrite; both tools keep working; parity provable.
- Trade-off: `check`/`section` remain as shared legacy grouping/display fields → **TD-007** (Low, non-blocking):
  eventual full separation of the two products' emission (or a registry-side v2.0-section map).
- Version impact: Engine 2.1.0 (identity finalized), Report unchanged, Registry unchanged.

## Evidence (to attach on implementation)
Golden parity byte-identical · `grep matchTitle == 0` · registry/integration/headless PASS · rename test.
