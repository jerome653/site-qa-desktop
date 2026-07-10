# SGEN Site Auditor — Program Charter v1.0

> The governing mission document. Sits above all others: **CHARTER** (why + laws + definition of done)
> → **ROADMAP** (what next) → **ARCHITECTURE** (how) → **CERTIFICATION** (can it ship) → **CHANGELOG** (what changed) → **ADR/** (decisions).
> Charter changes are rare and require an ADR.

## Mission
Transform the SGEN Site Auditor into an enterprise-grade, **deterministic** Website Quality Platform that:
requires no AI · requires no cloud · produces identical results for identical inputs · preserves every
audit as immutable history · explains every finding and every score · is fully versioned, testable,
documented, and certifiable. **The platform is complete only when every production gate passes.**

## Non-negotiable constitution
Overrides all implementation decisions. Attested live in `CERTIFICATION.md §2`.
1. **Determinism** — no AI, no heuristics, no probabilistic scoring, no hidden math; every finding reproducible.
2. **Explainability** — finding → rule → evidence → deduction → score is fully visible; nothing hidden.
3. **Registry is the only authority** — nothing else defines severity/suite/deduction/method/title/docs.
4. **Rule identity** — Rule IDs are permanent; titles are presentation only; IDs never change.
5. **History** — facts never change; append-only; nothing overwritten or deleted.
6. **Versioning** — engine · registry · report · schemas · APIs versioned independently.
7. **Governance** — architecture changes require ADRs; production requires certification; the roadmap controls execution.

## Program phases (execution order in ROADMAP.md)
Foundation → **Architecture Freeze** → Persistence → History → Rule Coverage → Reporting → Intelligence
→ Component Graph → Visual QA → Enterprise → Performance → Security → Testing → Documentation → Operations.
Each phase passes the Quality Gates (`CERTIFICATION.md §3`) before the next begins.

## Rule coverage — quality, not quantity
> There is **no target rule count.** A count is a vanity metric that invites low-value checks.

**The standard:** implement every deterministic rule that (a) provides measurable value, (b) has a clear
specification, (c) produces objective evidence, and (d) can be maintained without compromising
performance or explainability. Every rule is documented, tested, versioned, and deterministic — or it
does not ship.

## Definition of "1.0 complete" — a mature platform, not "done forever"
> Version 1.0 is complete when the **architecture is stable**, the platform is **production-certified**,
> and **future enhancements can be delivered by adding capabilities rather than redesigning the core.**

Concretely, all of the following must be objectively true (evidence in `CERTIFICATION.md`):
- **Architecture:** registry sole authority · native Rule IDs · no transitional code · Architecture Freeze held.
- **Audit engine:** all suites implemented · every rule deterministic, documented, tested, versioned.
- **Persistence:** immutable scan + finding history · versioned snapshots.
- **Intelligence:** timeline · comparison · regression · trend · technical debt — all deterministic.
- **Reporting:** professional reports · historical comparison · executive summaries generated from
  deterministic data (never AI) · evidence linked to every finding.
- **Enterprise / Operations:** projects · APIs · CLI · scheduling · workers · monitoring · recovery · release.
- **Certification:** every production gate PASS · every constitutional requirement PASS · **no High/Critical
  technical debt** · no architectural blockers.

After 1.0, the Architecture Freeze is maintained: no undocumented architectural change; growth is additive.

## Current state (pointer)
`CERTIFICATION.md` → status **DEVELOPMENT**. Nearest gate: **Architecture Freeze**, blocked only by
**TD-001** (Phase 2.1, remove the `matchTitle` bridge). See `ROADMAP.md` for the ordered path.
