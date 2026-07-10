# SGEN Site Auditor — Roadmap (Work Packages)

> Execution is tracked as **Work Packages (WP)**, not phases — better traceability at platform scale.
> **`CERTIFICATION.md` answers "can this ship?"** · this file answers **"what gets built next?"**
> Legend: ✔ Done · ◐ In progress · ○ Not started · 🚧 Blocked. Updated: 2026-07-08.

## Maturity milestones
| Milestone | Meaning | Reached when |
|---|---|---|
| Alpha | Foundation under active construction | — |
| Beta | Foundation frozen; persistence + history under development | WP-002 (Architecture Freeze) |
| **RC** ← current | All production gates pass except final live operational validation | 2026-07-08 (all 10 gates PASS) |
| GA | Production certified | live e2e scan + visual-match live run (E9 / TD-005) |

## ✔ Completed
- ✔ **WP-000a — Rule Registry** (83 rules, permanent IDs, sole authority) _(E1)_
- ✔ **WP-000b — Registry-Driven Engine** (enrichment, versioning, event bus, schemas, tests) _(E1–E4)_
- ✔ **WP-000c — SGEN Quality Score** (deterministic, per-check deductions, explainable, 10 suites) _(E3,E4)_

### ✔ WP-001 — Runtime Identity Finalization — COMPLETE (2026-07-08, Engine 2.1.0)
Native `ruleId` identity; `matchTitle()` removed. All acceptance criteria verified:
- [x] Zero title-based identity resolution · [x] `matchTitle()` removed (repo audit 0 refs, E5)
- [x] All emitters native `ruleId` (checks-static/render + audit rows) · [x] Finding resolves only from `ruleId`
- [x] Golden parity byte-identical (24/24, both tools) · [x] Registry/Integration/Headless pass
- [x] Rename test pass (E10) · [x] TD-001 CLOSED · [x] Architecture gate PASS (awaiting WP-002 seal)

### ✔ WP-002 — Architecture Freeze — COMPLETE / SEALED (2026-07-08) → milestone **BETA**
Verification-only. All 10 Freeze criteria verified (see CERTIFICATION §1a Freeze Certificate). Foundation frozen; ADR-0001 sealed; post-Freeze ADR rule now in force.

### ✔ WP-003 — Immutable Scan Store — COMPLETE (2026-07-08, Scan-Store 1.0.0) **[TD-002 CLOSED]**
Append-only, immutable, content-addressed (`scan-store/`). Additive to the frozen core (no ADR needed — consumes report-summary + bus per ADR-0001 §4). All acceptance criteria verified (E11, 56/56):
- [x] Append-only + immutable (temp→fsync→rename; duplicate never mutates) · [x] Content-addressed (fingerprint/scanId/digest, deterministic)
- [x] Rebuildable indexes (byte-identical rebuild) · [x] Diff engine (regression/improvement/mixed/unchanged)
- [x] History/lineage (parent-chain + chronology) · [x] Integrity (7 damage classes) + recovery + restart
- [x] Parallel scans · [x] Performance measured @ 3,000 scans · [x] No regression to frozen architecture

### ✔ WP-004 — Immutable Finding Store — COMPLETE (2026-07-08, Finding-Store 1.0.0)
Append-only, immutable, content-addressed finding lifecycle/history (`finding-store/`). Additive to the frozen core (no ADR — consumes WP-003 records + ruleId identity per ADR-0001 §4). All acceptance criteria verified (E12, 60/60):
- [x] Content-addressed identity (ruleId + target + evidence location; title-invariant) · [x] Immutable per-event records, never mutation
- [x] Deterministic lifecycle (OPEN→CONFIRMED→ACTIVE; UPDATED/RESOLVED/REOPENED/DUPLICATE/SUPERSEDED; invalid transitions fail closed)
- [x] Evidence linked to immutable scan (one truth source, digest-tied) · [x] Rebuildable indexes (byte-identical) · [x] Diff (new/unchanged/modified/resolved/reopened/severity/evidence, no title matching)
- [x] Integrity (9 classes incl. reorder/forged/identity-conflict/invalid-transition) + recovery + restart · [x] Concurrency · [x] Performance measured · [x] No frozen file modified; Scan Store compatibility proven (real WP-003 records)

### ✔ WP-005 — Timeline Engine — COMPLETE (2026-07-08, Timeline 1.0.0)
Deterministic health/quality timeline over the two immutable stores (`timeline/`). Additive read/compute layer — owns no state, mutates nothing (no ADR). All acceptance criteria verified (E13, 38/38):
- [x] Deterministic score series + scan-to-scan deltas/classification · [x] Finding lifecycle activity per scan · [x] Open-findings-over-time
- [x] Milestones (best/worst/first-clean) · streaks · trajectory · finding rollups (longest-open, most-reopened)
- [x] Content-addressed reproducible snapshots (materialize + certify) · [x] Integrity (tamper) + reproducibility-drift detection + recovery/restart
- [x] Builds with or without the finding store · [x] Frozen regression green in-suite (56/56 + 60/60); consumes real WP-003+WP-004 records

### ✔ WP-006 — Regression Engine — COMPLETE (2026-07-08, Regression 1.0.0) → History gate **PASS**
Deterministic regression detection + release gate over the immutable stores (`regression/`). Additive read/policy layer (no ADR). All acceptance criteria verified (E14, 32/32):
- [x] Policy = explicit data (thresholds + severity sets), never heuristic · [x] PASS/WARN/FAIL verdict (new-finding/score-drop/severity-escalation/reopen)
- [x] Baseline store (append-only pointers, latest wins, history) · [x] Content-addressed reproducible verdict records (gate decision certifiable)
- [x] Integrity (tamper) + reproducibility (verdict rebuild → drift/forgery exposed) + recovery/restart · [x] Custom policy stored full + reproduces
- [x] ruleId identity (no title matching) · [x] Frozen regression green in-suite (56/60/38); consumes real WP-003+WP-004 stores

### ✔ WP-007 — Suite 11 (Best Practices) — COMPLETE (2026-07-08, Registry 1.2.0) **[TD-003 CLOSED]**
Advisory suite (weight 0 — own sub-score, **provably no impact on the SGEN Quality Score**). Freeze-safe registry growth (ADR-0001: adding rules needs no core change), no ADR. All acceptance criteria verified (E15, 38/38):
- [x] 8 deterministic Best-Practice rules (BP-001..008) in the registry · [x] Weights still total 100; every historical score byte-identical (golden 24/24, integration 95)
- [x] Deterministic detectors (pure over page HTML; `best-practices/`) — no frozen runtime touched · [x] Score-neutrality proven (overall identical with vs without the suite)

### ✔ WP-008 — Operational Pillars — COMPLETE (2026-07-08) → milestone **RC**
Six gate-closing pillars, all additive (no frozen file changed), each with executable evidence:
- [x] **Testing** — `testing/run-all.js` (9 suites, one command) + `testing/coverage.js` (built-in V8, **97.6% ≥ 95%**, E6). TD-006 CLOSED.
- [x] **Performance** — `testing/benchmark.js` measured @ 10k scans / 10k findings (E7).
- [x] **Security** — `testing/security-audit.js` deterministic offline self-audit, 6 threat classes, 0 findings (E8).
- [x] **Operations** — `ops/` config + tamper-evident backup/verify/restore (E16).
- [x] **Reporting depth** — `reporting/` exec-summary + scan-diff renderers, self-contained HTML (E17).
- [x] **Documentation** — DEVELOPER · OPERATIONS · TROUBLESHOOTING · UPGRADE guides.

## ◐ Remaining for GA
- ○ **Final live operational validation** — one real end-to-end live scan + `qa-visual-match` live run (E9 / TD-005). Needs network/browser (sandboxed this session).
- ○ Future (post-GA): Intelligence · Component Graph · deeper Visual QA · Enterprise (multi-tenant) — all additive.

## Post-Freeze rule
After WP-002, **no architectural change ships** unless (a) a production defect requires it, or (b) an ADR is approved. All other work = *adding capabilities on a stable core*.

## Rule
Nothing advances ○→◐→✔ without its evidence row in `CERTIFICATION.md`. Each ✔ retires/updates its linked **[TD-xxx]**. Rule coverage follows the CHARTER's quality-not-quantity standard — no target count.
