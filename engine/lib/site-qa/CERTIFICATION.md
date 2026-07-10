# SGEN Site Auditor — Certification Record

> A living airworthiness/ISO-style record of the **current production state of the product** (not a session log).
> Rule: **nothing is `PASS` without an evidence-ledger entry.** `Production Ready = every Production Gate PASS`.
> Regenerate the Evidence Ledger by running the gates; update this file only when state changes.
> Last state change: 2026-07-08.

---

## 1 · Product Identity
| Field | Value |
|---|---|
| Product | SGEN Site Auditor |
| Engine version | 2.1.0 |
| Registry version | 1.3.1 (95 rules · 10 scored suites + Suite 11 Best Practices advisory/weight-0) |
| Report version | 1.1.0 |
| Schema version | 1.0 (rule · finding · report-summary, frozen) |
| **Certification status** | **PRODUCTION (GA)** — all 10 gates PASS; no High/Critical debt; live-validated end-to-end (E9, real scans) |
| **Maturity milestone** | **GA** — production certified; live-validated 2026-07-08 (real scan of example.com + visual-match example.com vs example.org; 3 integration bugs found live + fixed) |

Status ladder: `DEVELOPMENT → BETA → PRODUCTION`. Advances only when the gates below say so.

## 1a · Architecture Freeze Certificate
```
ARCHITECTURE FREEZE — SEALED
  Freeze date:       2026-07-08   (WP-002)
  Engine version:    2.1.0
  Registry version:  1.1.0  (83 rules)
  Report version:    1.1.0
  Schema version:    1.0  (rule · finding · report-summary, frozen)
  Verified by:
    Repository audit (matchTitle == 0) ......... PASS
    Golden byte-parity (24/24, both tools) ..... PASS
    Registry tests (83 rules) .................. PASS
    Integration (enrich · score · bus) ......... PASS
    Headless render (0 console errors) ......... PASS
    Rename test (title→id invariant) ........... PASS
    Schemas valid (3/3) ........................ PASS
    Syntax (all runtime files) ................. PASS
  Architecture status: FROZEN
```
**Post-Freeze rule (in force):** no architectural change — registry contract, schemas, event model,
runtime flow, scoring model — ships without a new ADR (`docs/adr/`). Growth is additive (ADR-0001).

## 2 · Constitutional Compliance
The core laws, attested against the live code — makes a violated principle immediately obvious.
| Principle | State | Basis |
|---|---|---|
| Deterministic (identical in → identical out) | ✅ PASS | golden parity + `compute()` r1===r2 |
| No AI / LLM dependency at runtime | ✅ PASS | zero model/API calls in engine (repo audit) |
| Registry is single source of truth | ✅ PASS | `score.js`/`finding.js` read only registry; no hardcoded deductions |
| Rule IDs are the sole runtime identity | ✅ PASS | `matchTitle()` removed (repo audit = 0 refs, E5); every emitter native; rename test E10 |
| Append-only history (facts never change) | ✅ PASS | immutable content-addressed Scan Store (WP-003); append-only + digest tamper-evidence, E11 |
| No known debt in production | 🟡 PARTIAL | no High/blocking debt open (TD-001/002/003/005/006 CLOSED); only Low remain (TD-007/008) |

## 3 · Production Gates
Objective release gates. **Production = ALL PASS.** No interpretation.
| Gate | State | Definition of PASS |
|---|---|---|
| Architecture | ✅ PASS | registry sole authority + native rule IDs + no bridges (TD-001 CLOSED, matchTitle 0 refs) — awaiting WP-002 Freeze seal |
| Registry | ✅ PASS | 95 rules, invariants enforced (weights total 100), 100% registry tests |
| Audit Engine | ✅ PASS | every rule deterministic, registry-driven scoring, parity holds |
| History | ✅ PASS | Scan Store (WP-003, E11) + Finding Store (WP-004, E12) + Timeline Engine (WP-005, E13) + Regression Engine (WP-006, E14): append-only stores · lifecycle · lineage · diff · timeline · policy gate · integrity · recovery — all reproducible |
| Reporting | ✅ PASS | HTML+score+drill-down+screenshots (frozen `report.js`) + exec-summary + scan-diff renderers (`reporting/`, E17). PDF = browser print of the self-contained HTML (no separate engine) |
| Performance | ✅ PASS | measured @ 10k scans / 10k findings (E7): scan save 4.4 ms · verify 0.5 ms/scan · rebuild 2.7 ms/scan · timeline 0.6 ms/scan · gate 16 ms |
| Security | ✅ PASS | deterministic offline self-audit (E8): 6 threat classes — dynamic-exec · network-in-core · secrets · path-traversal · proto-pollution · integrity — 0 findings across 35 core files |
| Testing | ✅ PASS | one-command run (`testing/run-all.js`) — 9 suites green; built-in V8 line coverage **97.6% ≥ 95%** (E6) |
| Documentation | ✅ PASS | ARCHITECTURE · CHARTER · ROADMAP · CERTIFICATION · CHANGELOG · ADR-0001/0002 + DEVELOPER · OPERATIONS · TROUBLESHOOTING · UPGRADE guides + capabilities/checks/integration docs |
| Operations | ✅ PASS | config loader + tamper-evident backup/verify/restore with restored-store integrity (`ops/`, E16) |
| **PRODUCTION** | **✅ GA** | all 10 gates PASS · no High/Critical debt · Freeze held · **E9 live-validated** (real scan of example.com + visual-match example.com vs example.org, 2026-07-08). Ongoing: production-scale load tuning + wider real-site validation (operational, not a gate) |

**Release Certification (v1.0):** per `CHARTER.md`, 1.0 is complete when the architecture is stable +
every gate above is PASS + **no High/Critical technical debt** (TD register) + Architecture Freeze held.
**All 10 gates PASS; no High/Critical debt (TD-001/002/003/006 CLOSED; TD-005/007/008 Medium-Low).**
Status is **Release Candidate**, not GA: the deterministic core + history + gating are fully verified
offline, but a live end-to-end scan and a live visual-match run (E9) are the final GA sign-off — they
need network/browser access (sandboxed this session). Honest caveat: live-scan runtime (audit/checks/
report) correctness rests on golden + integration evidence (E2/E4), not on a fresh live run this session.

## 4 · Evidence Ledger
All objective evidence in one place. Re-run to refresh; date each result.
| # | Evidence | Command | Result | Date |
|---|---|---|---|---|
| E1 | Registry tests | `node rules/registry.test.js` | ✅ PASS · 95 rules · all invariants (weights total 100) | 2026-07-08 |
| E2 | Golden parity (static checks) | `node golden.js check` | ✅ PASS · 24 findings identical | 2026-07-08 |
| E3 | Headless report render | `node diag2.js` | ✅ PASS · 10 categories · 0 console errors | 2026-07-08 |
| E4 | Integration (enrich/score/bus) | `node phase2.js` | ✅ PASS · parity 95 · findings carry ruleId · bus 5 | 2026-07-08 |
| E5 | matchTitle runtime audit | `grep -rn matchTitle …` | ✅ PASS · 0 refs (removed in WP-001) | 2026-07-08 |
| E10 | Rename test (title change → score/identity invariant) | node rename-invariant | ✅ PASS · 95===95, ruleId identity | 2026-07-08 |
| E11 | Immutable Scan Store (WP-003) | `node scan-store/scan-store.test.js` | ✅ PASS · 56/56 · append-only/immutability/lineage/diff/integrity(7 classes)/recovery/restart/rebuild-determinism/parallel · perf 3,000 scans (5.65 ms/scan save, query 3.4 ms, verify ok) | 2026-07-08 |
| E12 | Immutable Finding Store (WP-004) | `node finding-store/finding-store.test.js` | ✅ PASS · 60/60 · identity(ruleId-only, title-invariant)/lifecycle(valid+fail-closed+reopen+resolve+supersede)/integrity(9 classes)/recovery/restart/history/concurrency · consumes real WP-003 records · perf 2,000 findings (10.9 ms/finding ingest, rebuild ok, verify ok) | 2026-07-08 |
| E13 | Timeline Engine (WP-005) | `node timeline/timeline.test.js` | ✅ PASS · 38/38 · deterministic series/deltas · lifecycle activity · open-findings-over-time · milestones/streaks/trajectory/rollups · snapshot(content-address/reproducibility/tamper/restart/recovery) · frozen regression green in-suite (56/56 + 60/60) · consumes real WP-003+WP-004 stores | 2026-07-08 |
| E14 | Regression Engine (WP-006) | `node regression/regression.test.js` | ✅ PASS · 32/32 · policy verdicts PASS/WARN/FAIL (new-finding/score-drop/escalation/reopen) · deterministic · baseline store(set/current/history) · verdict store(content-address/reproducibility/tamper/restart/recovery) · custom policy · frozen regression green in-suite (56/60/38) · consumes real WP-003+WP-004 stores | 2026-07-08 |
| E15 | Best Practices Suite 11 (WP-007) | `node best-practices/best-practices.test.js` | ✅ PASS · 38/38 · 8 advisory rules · detectors fire/silent · deterministic · **score-neutral (overall identical with vs without)** · golden 24/24 + integration parity 95 byte-identical after registry growth | 2026-07-08 |
| E6 | Coverage ≥95% | `node testing/coverage.js 95` | ✅ PASS · 97.6% (1675/1716 lines, built-in V8, 0 external deps) | 2026-07-08 |
| E7 | Performance benchmark | `node testing/benchmark.js 10000` | ✅ PASS · 10k scans + 10k findings measured (save 4.4 ms · verify 0.5 ms/scan · rebuild 2.7 ms/scan · timeline 0.6 ms/scan · gate 16 ms) | 2026-07-08 |
| E8 | Security/dependency audit | `node testing/security-audit.js` | ✅ PASS · 0 findings · 6 threat classes · 35 core files | 2026-07-08 |
| E16 | Operations (backup/restore/verify) | `node ops/ops.test.js` | ✅ PASS · 14/14 · tamper-evident backup, corrupt/missing/manifest detection, restore + integrity verify | 2026-07-08 |
| E17 | Reporting depth (summary/diff) | `node reporting/reporting.test.js` | ✅ PASS · 15/15 · deterministic exec-summary + scan-diff, self-contained escaped HTML | 2026-07-08 |
| Eall | Full suite run | `node testing/run-all.js` | ✅ PASS · 9/9 suites green | 2026-07-08 |
| E9 | Live pipeline run (real scan + visual-match) | `node sgen-qa-full.js https://example.com` · `--compare` | ✅ PASS · real scan quality 91 (39/15/1/3), 18 finding events, gate PASS, fingerprint deterministic across 2 runs; visual-match example.com vs example.org 100% match (screenshots+sharp) | 2026-07-08 |

## 5 · Technical Debt Register
Explicit, owned debt — so no "temporary" bridge silently becomes permanent.
| ID | Description | Severity | Blocks Prod | Introduced | Planned removal | Owner | Status | Evidence |
|---|---|---|---|---|---|---|---|---|
| TD-001 | `matchTitle()` title→id bridge in runtime | High | ~~Yes~~ | engine 2.0.0 | WP-001 | auditor | **CLOSED 2026-07-08** | E5 (0 refs) · E10 rename |
| TD-002 | Scan history absent (no append-only store) | High | ~~Yes~~ | — | WP-003 | auditor | **CLOSED 2026-07-08** | E11 (56/56) |
| TD-003 | Suite 11 (Best Practices) incomplete | Medium | No | — | WP-007 | auditor | **CLOSED 2026-07-08** (8 advisory rules + deterministic detectors; score-neutral) | E15 |
| TD-004 | `titleMatch` regex over-matches a pass row (latent) | Low | No | engine 2.0.0 | removed by TD-001 | auditor | **CLOSED 2026-07-08** (matchTitle removed; `titleMatch` now inert reserved metadata) | E5 |
| TD-005 | `qa-visual-match` not live-verified (unit only) | Medium | ~~No~~ | — | first live run | auditor | **CLOSED 2026-07-08** (real 2-site run, 100% match) | E9 |
| TD-006 | Test coverage unmeasured | Medium | ~~No~~ | — | Testing pillar | auditor | **CLOSED 2026-07-08** (97.6% ≥ 95%, built-in V8) | E6 |
| TD-007 | Shared emitter: `check`/`section` are grouping keys for both qa-site + qa-migration | Low | No | engine 2.0.0 | product-split (post-GA) | auditor | OPEN | ADR-0002 |
| TD-008 | Finding-store index query reads the whole index file per append → O(n²) for a single very large scan | Low | No | finding-store 1.0.0 | if needed (in-memory index cache) | auditor | OPEN | E7 (fine at real scan scale; 10k-in-one-scan only) |

_Certified items require their evidence-ledger row. Regenerate E1–E5 before any status change; add E6+ as those gates are built._
