# SGEN Site Auditor — Architecture

> Canonical technical reference. This document changes **rarely** — after the Architecture Freeze,
> no architectural change ships without a new ADR (see §13). Read this once and you understand the platform.
> Engine 2.0.0 · Registry 1.1.0 · Report 1.1.0 · Schema 1.0.

## 1 · System overview
A **deterministic** website auditor. Given a URL it crawls the site, runs a fixed set of checks
(static HTML, headless render, network, TLS, cross-engine), and produces an explainable **Quality
Score** + a self-contained HTML report. No AI, no cloud, no network egress beyond the audited site
and its assets. Identical input → identical output, always.

Everything about a *rule* (identity, suite, severity, deduction, method, docs) lives in **one place**:
the Rule Registry. The runtime derives all behaviour from it.

## 2 · Runtime flow
```
CLI (sgen.js)
  └─ entry (sgen-qa-site.js | -migration | -serve | -compare | -visual-match)
       └─ runAudit(url, opts, bus)                         [audit.js]
            ├─ crawl / discoverPages                        [migration-qa/crawl.js, http.js]
            ├─ static checks (per page)                     [migration-qa/checks-static.js] → findings
            ├─ link audit · form audit
            ├─ site checks (robots/sitemap/404/https)       [migration-qa/checks-static.js]
            ├─ render pass (headless Chromium)              [migration-qa/checks-render.js] → findings
            ├─ TLS cert · cross-browser (FF/WebKit)         [tls-check.js, cross-browser.js]
            ├─ assemble rows into 10 suites
            ├─ ENRICH: stamp each finding from registry     [finding.js]  ← rule metadata boundary
            ├─ count tally (from enriched status)
            ├─ SCORE: Quality Score from registry           [score.js]
            └─ RENDER: self-contained HTML                  [report.js]
       events fire throughout                               [events.js]
```
The **enrich** step is the single boundary where a finding acquires its rule metadata. Nothing after
it reconstructs metadata; nothing before it decides scoring.

## 3 · Rule Registry — the constitution (`rules/registry.js`)
- The **sole source of truth** for rule metadata. 83 rules across 10 suites.
- Each rule: `id` (permanent, `SUITE-NNN`), `slug`, `title`, `suite`, `category`, `severity`,
  `deduction`, `method`, `deterministic`, `manual`, `autofix`, `introduced`, `docs`.
- **Validation runs at load** (`validate()`, fail-fast): unique ids/slugs, valid suite/severity/method,
  manual⇔deduction=0, docs path, suite weights total 100. An invalid registry throws — the auditor
  never runs on one.
- **Lookup service** (the only place rule queries live): `getById`, `getBySlug`, `bySuite`,
  `getManualRules`, `getDeterministicRules`, `getRulesByMethod/Severity/Category`.
- Adding a rule requires **no other code change** — it scores, reports and appears automatically.

## 4 · Finding model (`finding.js` · `schemas/finding.schema.json`)
Canonical, immutable once emitted. A check decides only pass/fail + evidence; `enrichRow` stamps
`ruleId · ruleSlug · suite · severity · deduction · method · manual · docs` from the registry, and
derives pass/fail **status** from the registry severity (critical|high→fail, medium|low→warn).

## 5 · Scoring engine (`score.js`)
Deterministic Quality Score. Per-suite `score = clamp(0..100, 100 − Σ deductions)`;
`overall = Σ(suiteScore × weight)/Σweight`. **Reads only the registry** — zero hardcoded numbers.
Every deduction is line-itemed with its ruleId. Manual + pass never deduct.

## 6 · Event bus (`events.js`)
In-process `EventEmitter`. 7 lifecycle events: `scan.started · page.started · rule.started ·
rule.completed · finding.created · page.completed · scan.completed`. Guarded emit (a throwing
listener can't break a scan). This is the **primary extension seam** — history, live progress,
workers, dashboards subscribe here without touching the engine.

## 7 · Reporting engine (`report.js`)
`renderReport(result, outDir)` → self-contained `report.html` (inlined CSS/JS/screenshots) +
`report.json`. Client script renders the score strip, suites (collapsible, filterable), and the
per-finding drill-down (page·section·element). Theme-aware, SGEN-branded.

## 8 · History engine — PLANNED (Phase 3)
Append-only Scan/Finding/Page store; deterministic fingerprints; timeline; comparison. Writes come
**only** from event-bus subscribers — checks never write history (loose coupling). Not yet implemented.

## 9 · Storage model
Today: reports written to `reports/<host>-<timestamp>/` (`report.html` · `report.json` · `screenshots/`).
`qa-serve` records runs under `_records/<domain>/`. History storage: Phase 3 (append-only, immutable).

## 10 · Versioning (`version.js`)
Three independent streams so any old report stays reproducible: **Engine** (runtime), **Report**
(render shape), **Registry** (rule metadata). Every result records all three under `result.versions`.

## 11 · Contracts (`schemas/`)
Frozen JSON Schemas: `rule` · `finding` · `report-summary`. Everything downstream (export, history,
dashboards) builds on these; they change only by version bump + migration note.

## 12 · Extension points
1. **Add a rule** → registry only.
2. **New check** → emit findings with a ruleId; enrichment + scoring + report are automatic.
3. **New mode** → a new `sgen-qa-*.js` entry reusing `lib/site-qa/*`.
4. **React to scans** → subscribe to the event bus.
No core change required for any of these.

## 13 · Change discipline (post-Freeze)
After the **Architecture Freeze**, any change to: the registry contract, the finding/rule/report
schemas, the event model, the runtime flow, or the scoring model — requires a new **ADR** in
`docs/adr/`. Feature work (new rules, suites, packs, APIs) rests *on top of* this architecture and
does not reshape it.

## 14 · Directory layout
```
Runtime/bin/
  sgen.js                       CLI dispatcher
  sgen-qa-{site,migration,serve,compare,visual-match}.js   mode entries
  lib/site-qa/
    audit.js          runner/orchestrator
    finding.js        canonical finding + enrichment (registry metadata boundary)
    score.js          quality score (registry-sourced)
    events.js         event bus         version.js  version streams
    report.js         HTML report       report-visual.js / report-compare.js
    compare.js        scan diff          tls-check.js  cross-browser.js  visual-match.js
    rules/
      registry.js     THE registry + lookup + validation
      registry.test.js
    schemas/          rule · finding · report-summary (frozen)
    CERTIFICATION.md  ROADMAP.md  ARCHITECTURE.md  CHANGELOG.md
    docs/adr/         Architecture Decision Records (post-Freeze)
  lib/migration-qa/   shared primitives: crawl · http · checks-static · checks-render · verdict
```

## 15 · Data flow (one finding's life)
```
check fn (pass/fail + evidence, title = lookup key)
   → row assembled into its suite
   → enrichRow: registry stamps ruleId + all metadata, derives status
   → score.js: deduction (registry) applied to suite/overall
   → report.js: rendered with drill-down + docs link
   → (Phase 3) event-bus subscriber persists an immutable Finding snapshot
```
