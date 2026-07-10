# ADR-0001 — Constitutional deterministic architecture

- **Status:** ACCEPTED · SEALED at the Architecture Freeze (2026-07-08, WP-002). Changes hereafter require a new ADR.
- **Date:** 2026-07-08
- **Deciders:** Jerome (product) · auditor
- **Affects:** registry contract · schemas · event model · runtime flow · scoring model

## Context
The SGEN Site Auditor must be an enterprise-grade website auditor that customers can trust: results
must be **reproducible** (identical input → identical output), **explainable** (every score traceable),
and **independent** (no AI, no cloud, no per-run cost). A pile of hardcoded checks cannot meet that bar
— rule metadata scattered across the runtime makes scores unexplainable and changes unsafe.

## Decision
Adopt a constitutional architecture:
1. **Rule Registry is the single source of truth** for all rule metadata (identity, suite, severity,
   deduction, method, docs). Nothing else defines a rule.
2. **Rule IDs are the sole runtime identity.** Titles are presentation only. (Completion: Phase 2.1 —
   remove the `matchTitle` bridge, TD-001.)
3. **Immutable Finding model**, stamped from the registry at one enrichment boundary.
4. **Event-driven runtime** — a lifecycle event bus is the extension seam; subscribers (history,
   dashboards, workers) never require engine changes.
5. **Frozen, versioned schemas** (rule · finding · report-summary) and **independent version streams**
   (engine · registry · report) so any past report stays reproducible.
6. **Determinism and no-AI are inviolable** — enforced by golden-parity tests and a no-LLM repo audit.

## Consequences
- Positive: explainable deterministic scoring; adding a rule needs no core change; safe to extend;
  past reports reproducible; a clear production certification is possible.
- Trade-off: an enrichment boundary + registry indirection (worth it for the guarantees).
- Version impact: Engine 2.0.0, Registry 1.1.0, Report 1.1.0.

## Evidence
CERTIFICATION.md ledger E1–E4 (registry tests, golden parity, headless render, integration) PASS.
Open: E5 (matchTitle audit FAIL, 3 refs) — must reach 0 before this ADR is sealed at the Freeze.
