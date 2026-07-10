# SGEN Site Auditor — Capability Reference

> Complete documentation of what the auditor does **today** (Release Candidate, 2026-07-08).
> Companion docs: `CHARTER.md` (why) · `ARCHITECTURE.md` (how it's built) · `CERTIFICATION.md` (proof it works) ·
> `ROADMAP.md` (what's next) · `docs/` (developer/ops/troubleshooting/upgrade guides).
> Versions: **Engine 2.1.0 · Registry 1.2.0 · Report 1.1.0**. Status: **RELEASE CANDIDATE** (all 10 gates PASS; GA needs a live run — E9/TD-005).

## 1 · What it is
A **deterministic, offline** website-quality platform. Identical input → identical output, every time,
on any machine. No AI, no cloud, no per-run cost. Every point of every score traces to a permanent
rule ID; nothing is a black box. It scans a site across 10 quality dimensions, scores it, and keeps an
**immutable, tamper-evident history** so quality can be tracked, diffed, gated in CI, and certified.

## 2 · Layers & subsystems

### Foundation — the deterministic engine
| Subsystem | File | Capability |
|---|---|---|
| Rule Registry | `rules/registry.js` | **Single source of truth.** 95 rules with permanent `SUITE-NNN` ids; each carries suite, severity, deduction, method, docs. Load-time invariants (unique ids/slugs, valid suite/severity/method, suite weights total 100, manual⇔deduction 0). Query API: `getById/getBySlug/bySuite/…`. |
| Quality Score | `score.js` | Per-suite `score = clamp(0..100, 100 − Σ deductions)`; `overall = Σ(score×weight)/Σweight`. **Zero hardcoded numbers** — every deduction/weight comes from the registry. Each deduction is line-itemed with its rule id. |
| Finding model | `finding.js` | Canonical finding; enrichment stamps ruleId/suite/severity/deduction/docs from the registry at one boundary. Identity is the **native ruleId** (no title matching). |
| Event bus | `events.js` | 7 lifecycle events (`scan.started`…`scan.completed` + `finding.created`); guarded emit (a throwing listener can't break a scan). The extension seam. |
| Versions / schemas | `version.js`, `schemas/` | Independent engine/registry/report version streams; frozen JSON schemas (rule · finding · report-summary). Every scan stamps all three → old reports stay reproducible. |

### Runtime — the live scan (needs browser/network)
`audit.js` orchestrates; `checks-static.js` / `checks-render.js` run the deterministic checks; `report.js`
renders the self-contained HTML report (quality strip, per-suite breakdown, per-finding drill-down with
clickable page·section·element links, full-page screenshots). Modes: `qa-site`, `qa-migration`,
`qa-serve` (local UI), `qa-compare`, `qa-visual-match` (old-live vs SGEN-staging at 6 SG-Builder
breakpoints). *This layer's correctness is proven by golden + integration evidence; a fresh live run is
the remaining GA step.*

### History — immutable, content-addressed (all append-only, crash-safe, reproducible)
| Store | File | Capability |
|---|---|---|
| Scan Store | `scan-store/` | Every scan → an immutable record: `fingerprint` (sha256 of scored content — identical-scan detection), `scanId` (unique per run), `digest` (tamper-evidence). Rebuildable indexes (target/date/rule/severity/…). Diff engine (regression/improvement/mixed). Lineage. Integrity (7 damage classes) + recovery. |
| Finding Store | `finding-store/` | Per-finding **lifecycle**: OPEN→CONFIRMED→ACTIVE, then UPDATED/RESOLVED/REOPENED/DUPLICATE/SUPERSEDED. Illegal transitions **fail closed**. Identity = ruleId + target + evidence location (title-invariant). Diff, lineage, integrity (9 classes) + recovery. |
| Timeline Engine | `timeline/` | Per-target quality timeline: score series + scan-to-scan deltas, finding lifecycle activity, open-findings-over-time, milestones (best/worst/first-clean), streaks, trajectory, rollups (longest-open, most-reopened). Content-addressed, reproducible snapshots. |
| Regression Engine | `regression/` | CI **gate**: compares a candidate vs a baseline, applies an explicit policy (fail on new high/critical, reopen, severity escalation, bounded score drop), returns **PASS / WARN / FAIL** with reasons. Append-only baseline pointers + content-addressed verdict records (a gate decision is reproducible + certifiable). |

### Advisory — Best Practices (Suite 11)
`best-practices/` — 8 deterministic checks (doctype, charset, deprecated tags, `target=_blank` w/o rel,
generic link text, exposed generator, inline handlers, legacy doctype). Registry **weight 0**: it has its
own advisory sub-score but **provably never changes** the SGEN Quality Score (verified by parity).

### Assurance & operations
| Pillar | File | Capability |
|---|---|---|
| Testing | `testing/run-all.js`, `testing/coverage.js` | One command runs all 9 suites; line coverage via Node's **built-in V8 coverage** (no external deps) — currently **97.6%**, with a `≥N%` gate mode. |
| Performance | `testing/benchmark.js` | Measured throughput at scale (10k scans / 10k findings). |
| Security | `testing/security-audit.js` | Deterministic offline self-audit over 6 threat classes with live probes. |
| Operations | `ops/` | Config loader; tamper-evident backup (per-file + overall sha256 manifest), `verifyBackup`, and `restore` that refuses an unverified backup and confirms restored-store integrity. |
| Reporting depth | `reporting/` | Deterministic executive-summary + scan-diff renderers (text + self-contained, escaped HTML). |

## 3 · The 10 scored suites (+ 1 advisory)
Functional (18) · Links (8) · Forms (6) · Responsive (8) · Accessibility (14) · SEO (16) ·
Performance (14) · Security (10) · Cross-Browser (3) · Console (3) — **weights total 100**.
Plus **Best Practices (0, advisory)**. Real engines behind the checks: axe-core (WCAG), TLS certificate
inspection, Firefox + WebKit cross-browser.

## 4 · Using the CI gate
```js
const RG = require('./regression');
const base = new RG.BaselineStore(root); base.set(scanStore.get(knownGoodScanId), { setAt });
const verdict = RG.gateAgainstBaseline(scanStore, findingStore, base, target, candidateScanId);
// verdict.verdict === 'PASS' | 'WARN' | 'FAIL'; verdict.violations lists why. Fail the build on FAIL.
```
Policy is explicit data (`regression/policy.js`) and fully overridable; the full resolved policy is stored
in every verdict so a decision reproduces exactly.

## 5 · Guarantees (what you can rely on)
- **Deterministic** — same input → same score/verdict (golden parity 24/24 byte-identical).
- **Explainable** — every deduction names its rule id; no hidden math.
- **Immutable & tamper-evident** — history records are content-addressed; edits are detected by `verify()`.
- **Reproducible** — versioned registry/engine/report; old records replay exactly.
- **Independent** — the deterministic layer needs no network, no AI, no external service.
- **Additive-safe** — the architecture is frozen (ADR-0001); growth doesn't destabilise the core.

## 6 · Run it
```
node testing/run-all.js            # all suites (exit 0 = green)
node testing/coverage.js 95        # line coverage, ≥95% gate
node testing/benchmark.js 10000    # measured performance
node testing/security-audit.js     # offline security self-audit
```

## 7 · Current limits (honest)
- **Not yet GA-certified.** All gates pass offline, but GA needs one live end-to-end scan + a live
  `qa-visual-match` run (E9 / TD-005) — both require network/browser.
- **Low-severity debt:** TD-007 (a shared grouping key — cosmetic), TD-008 (finding-store index is
  O(n²) only for a *single* 10k-finding scan; fine at real scan sizes).
- The live-scan runtime (`audit`/`checks`/`report`) is covered by golden + integration evidence, not
  by unit coverage (it needs a browser) — see `CERTIFICATION.md` E2/E4/E9.
