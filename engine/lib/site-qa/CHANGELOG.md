# SGEN Site Auditor — Changelog

> Product changes (not git commits). Format: [Keep a Changelog]. Component version streams are tagged
> per entry: **E** = Engine · **R** = Registry · **Rep** = Report.

## [Unreleased]
### Next
- Phase 2: inspector lenses + Interaction Integrity top-line score + rendered-DOM link crawl.
- Wider real-site validation + production-scale load tuning (operational).

### Fixed — Site Comparison: two findings that misled rather than merely missed — R 1.12.0
- **`drift()` was dead code, shipped in 3.0.0 and 3.0.1.** `font-checks.js` has exported and unit-tested
  `drift(refSweep, candSweep)` since R 1.11.0 and **nothing ever called it** — `grep -E '\bdrift\('` over
  `visual-match.js` / `audit.js` returned nothing — while the design mockup advertised *"Font drift vs
  reference"* as a shipping **NEW** feature. Now wired into the real comparison path: `visual-match.js`
  runs `FONT_SWEEP` on both sides **once per page pair** (not per viewport — the same page-level rule that
  pins FONT-001..006 to one call per page), guarded in try/catch so it can never break a run, and folds to
  the new **VIS-003 font-drift**. Emitted at the page level as `pages[].fontDrift` + `fontDriftAt`.
- **VIS-003 lands in `visual` (Suite 12, weight 0), not a11y** beside FONT-001..006: a font that changed
  vs the reference is a *comparison fact*, not a defect in the candidate. Advisory → overall scores are
  unchanged. Matches CONSOLIDATION open decision #5 ("only font drift vs reference is comparison-specific").
- **The pixel pass ran on every comparison.** VIS-001 is only meaningful for a **like-for-like** replatform;
  on a **redesign** the sites are *supposed* to differ, so it is a documented false-positive machine
  (antialiasing + font rasterisation alone spend 1–3%). Added a **comparison mode** — `like-for-like`
  (default, today's behaviour byte-for-byte) vs `redesign`. In redesign the pixel pass is **skipped**, not
  softened: `pixelMismatchPct` is `null`, no diff overlays are written, `matchScore` falls back to the
  structural score, and VIS-001 cannot fire on the pixel axis. Structural mismatches still report — only
  the pixel axis is gated. Unknown/absent mode → `like-for-like` (fails toward the status quo).
  Settings popup (`v-mode`, bound to the live control per the one-source-of-truth rule), `/api/visual`,
  and `sgen qa-visual-match --mode` all carry it; the run records `mode`/`pixelPass` in its result JSON so
  a stored report can never be re-read out of context. Implements CONSOLIDATION open decision #4 (recommended option).
- **VIS-001 evidence read `[object Object]` on every real run since R 1.3.** `structDelta()` returns
  missing/extra/moved/restyled as **arrays of elements**; both consumers (`visual-match/fold.js` and
  `inventory/visual-stage.js`) independently read them as counts, so the evidence string rendered
  `" missing,  extra,  moved, [object Object],[object Object] restyled"` — empty categories listed with a
  blank count (`[]` is truthy) and populated ones stringified as objects. It survived because the fold
  fixtures passed **numbers**, a shape the engine has never emitted. One shared `structDeltaLabels()`
  (tolerates arrays and numbers, drops empties), fixtures corrected to the real shape, and the suites now
  assert the evidence is human-readable rather than merely present.

---

## 2026-07-09 — V2 Phase 1  (Developer-first platform: contract · providers · +32 rules) — E 2.3.0 · R 1.9.0 · Rep 1.2.0
### Added — platform (the durable foundation)
- **Finding Contract v1** (ADR-0003, `contract.js`, `schemas/finding-contract.schema.json`): one canonical
  finding shape every rule emits; five-question invariant (what/where/certainty/why/how). Frozen.
- **Developer Locator Object** + **Evidence Providers** (`lib/evidence-providers.js`): DOM/Render providers
  build a stable, ranked-strategy locator + deterministic `locatorId` + copy-as CSS/XPath/querySelector/
  Playwright/Cypress. Network/Build providers stubbed for Phase 3. Screenshots stay optional/lazy.
- **Single canonical source** (`lib/report-contract.js`): JSON / Markdown / Copy-MD all derive from the
  contract — no format-specific reconstruction.
- **Services:** `lib/fingerprint` (extends the content-addressed digest), `lib/locator`, `lib/uri-validate`,
  `lib/rule-deps` (dependsOn/skipIf).
- **Rule metadata:** `inspector` · `interaction` · `cost` · `evidenceQuality` (Verified/Derived/Heuristic) ·
  `impact{seo,a11y,security,devEffort}` (no "affected users" — not measurable offline) · `fixability` ·
  `deprecatedIn`/`lastModified`.
### Added — rules (+32; catalog: `docs/RULE-CATALOG-v2.md`)
- **Interaction:** LINK-006..010, DOM-010..013 (dead links/buttons, nesting, disabled-active, mailto/tel).
- **Security:** SEC-011..015 (header split), SEC-016..018 (cookie flags), SEC-019..022 (.git/backup/config/
  dir-listing exposure), SEC-023 (dangerous JS, heuristic), SEC-024/025 (transport).
- **SEO:** SEO-031 (hreflang), SEO-035/036 (index-signal conflicts), SEO-037/038 (thin content / readability).
- **Stability:** DOM-003 (duplicate ids), DOM-004 (DOM size), FORM-002 (field semantics).
### Changed
- **qa-site** now emits granular security-header rules (SEC-011..015) instead of the lumped **SEC-010**
  (kept, marked `deprecatedIn: 2.0`, still emitted by **qa-migration**). Migration note: JSON consumers that
  keyed on SEC-010 for qa-site should switch to SEC-011..015.
- Dev-ticket Markdown (Copy-MD) now derives from the contract and carries certainty · launch-tier ·
  fingerprint · copy-as locator (richer than v1; format changed, not purely additive).
### Notes
- Additive: frozen scoring formula unchanged; existing-rule findings byte-identical; historical certs
  reproduce. Overall scores move only on sites that have the newly-detected defects (by design).
- Perf: +0.75 ms/page static · projection ~4 ms/scan · +5 bounded site-probe GETs/origin · no memory leak.
- Deferred (roadmap-tracked): image/video/news sitemaps, broken-markup, broken-fonts, near-duplicate.

---

## 2026-07-08 — GA  (FUNC-009 spelling · live E9 validation · milestone → Production)
### Added
- **FUNC-009 common-misspelling** (Functional, medium, −4): deterministic curated common-typo map (~150 entries) + doubled-function-word detection over visible prose. Zero false positives (only known typos + unambiguous doublings; excludes "that that"/"had had"). New `spelling/` module; merged into the pipeline like FUNC-008. Not AI, not a full dictionary — a high-precision typo linter.
### Verified live (E9)
- **Real end-to-end scan against example.com** via `sgen qa-full`: crawl + Chromium render + **Firefox + WebKit** cross-browser + TLS + advisory passes + persist + finding lifecycle + regression gate. Result: quality **91**, 39/15/1/3, **18 finding events**, stores **verify true**, gate **PASS**, **fingerprint byte-identical across two independent runs** (determinism proven live).
- **Real visual-match** (`--compare`): example.com vs example.org — crawled both, paired by path, screenshots at breakpoints, **sharp** pixel diff → **100% match** (correct: both serve the identical page).
### Fixed (found by live execution — offline tests missed these)
- Pipeline did not pass `screensDir` → render `mkdirSync(undefined)`. Now provides a shots dir.
- `finding-store` threw on real findings with no `ruleId`. `ingestScan` + `diff.indexScan` now skip un-ruled findings (they remain in the immutable scan record but aren't lifecycle-tracked). finding-store 60/60, regression 32/32 re-verified.
### Notes
- Registry **1.3.1 / 95 rules**; golden 24/24; full suite **12/12**; coverage **97.8%**. Milestone **RC → GA**. Debt closed: TD-005. Remaining Low-only: TD-007, TD-008.

---

## 2026-07-08 — Registry 1.3.0  (Suite 12 · Visual Match folded into the pipeline)
### Added
- **Suite 12 — Visual Match** (advisory, weight 0): rules **VIS-001** (visual mismatch vs reference over threshold) and **VIS-002** (reference page has no candidate match). New `visual-match/fold.js` turns a `visual-match.run()` result into registry-native VIS findings.
- **`pipeline.js` folds visual match in**: pass `compareUrl` (or `sgen qa-full <staging> --compare <old-live>`) → runs visual-match (reference vs candidate) → folds the `visual` suite → flows through re-score (weight 0, no overall impact) → Scan Store → Finding lifecycle → Timeline → Regression gate. `visualFn` injectable for offline tests.
### Notes
- Freeze-safe registry growth (94 rules, weights still total 100). Golden **24/24 byte-identical**, integration **95**. Pipeline test **33/33** (visual suite folds, VIS findings persist with real ruleIds, score stays neutral). Full suite **11/11**, coverage **97.8%**. Visual findings now tracked over time + gateable like any other finding — a visual regression on the `/` mobile breakpoint becomes a first-class, resolvable finding.

## 2026-07-08 — Integration  (pipeline · everything wired)
### Added
- **`pipeline.js` orchestrator + `sgen qa-full` CLI** — one flow wires the whole platform: live scan (`runAudit`) -> advisory merge (FUNC-008 into Functional + Best Practices Suite 11) -> deterministic re-score -> persist to the immutable **Scan Store** -> **Finding** lifecycle -> **Timeline** -> **Regression gate** vs a saved baseline. Registered as `qa-full` in the `sgen` dispatcher; `--set-baseline`, `--data`, `--out`, `--json`; exit 1 on gate FAIL.
- **`audit.js` opt-in `collectPages`** (default OFF) — attaches page HTML to the result so the advisory passes can run. Default path unchanged.
### Notes
- Freeze-safe (ADR-0001 §4): the orchestrator consumes the frozen engine result + public store APIs; merging FUNC-008 re-scores via the same registry-driven `compute()`. Verified: golden **24/24 byte-identical**, integration parity **95** with `collectPages` off. Pipeline test **25/25** proves the gate flips PASS->FAIL->PASS as a {{token}} leak appears then is fixed. Full suite **11/11**, coverage **97.8%**. Two bugs caught + fixed in-build (merged FUNC-008 row missing severity -> gate under-counted; verify is a module fn not a method).

## 2026-07-08 — Registry 1.2.1  (FUNC-008 · content-artifacts)
### Added
- **FUNC-008 content-artifacts** (Functional, high, −6): deterministic detector for loose/broken symbols in visible copy — unresolved template tokens (`{{ }}`, `{% %}`, `${ }`), U+FFFD replacement chars, UTF-8/Latin-1 mojibake, double-escaped entities, stray control chars. New `content-artifacts/` module (pure regex over prose; skips script/style/pre/code so examples do not false-positive). Complements FUNC-004 (placeholder/lorem).
### Notes
- Additive, freeze-safe: golden 24/24 byte-identical, integration parity 95, registry 92 rules. Test 25/25. Full suite 10/10, coverage 97.7%. Does not touch the frozen runtime (standalone module like best-practices).

## 2026-07-08 — Operational Pillars  (WP-008 · milestone → Release Candidate)
### Added
- **Testing** — `testing/run-all.js` runs every suite in one command (9 suites, ordered, bounded perf N); `testing/foundation.test.js` unit-covers the event bus + version streams; `testing/coverage.js` measures line coverage with Node's **built-in V8 coverage** (no c8/nyc/istanbul) — **97.6%** on the deterministic layer, with a `≥N%` gate mode. Closes TD-006.
- **Performance** — `testing/benchmark.js`: measured throughput at 10k scans / 10k findings (scan save 4.4 ms · verify 0.5 ms/scan · index rebuild 2.7 ms/scan · timeline build 0.6 ms/scan · regression gate 16 ms).
- **Security** — `testing/security-audit.js`: deterministic, offline self-audit over 6 threat classes (dynamic-exec, network-in-core, secrets, path-traversal, prototype-pollution, integrity) with live probes; 0 findings across 35 core files.
- **Operations** — `ops/`: `config.js` (explicit defaults + override/file load) and `backup.js` (tamper-evident backup with per-file + overall sha256 manifest; `verifyBackup`; `restore` that refuses an unverified backup and confirms restored-store integrity).
- **Reporting depth** — `reporting/`: deterministic executive-summary + scan-diff renderers (text + self-contained, escaped HTML) over the immutable history layer. Does not touch the frozen `report.js`.
- **Documentation** — DEVELOPER · OPERATIONS · TROUBLESHOOTING · UPGRADE guides (`docs/`).
### Changed
- **Milestone → Release Candidate.** All 10 production gates PASS; no High/Critical debt; Architecture Freeze held.
### Notes
- All additive — no frozen file modified; full suite green (9/9). New debt logged honestly: **TD-008** (finding-store index query is O(file) per append → O(n²) for a *single* 10k-finding scan; fine at real scan scale). GA remains gated on one live end-to-end scan + a live visual-match run (E9 / TD-005) — both need network/browser, sandboxed this session.

---

## 2026-07-08 — Registry 1.2.0  (WP-007 · Suite 11 · Best Practices)
### Added
- **Suite 11 — Best Practices** (advisory): 8 deterministic rules (`BP-001` doctype-missing · `BP-002` charset-missing · `BP-003` deprecated-html-tags · `BP-004` target-blank-no-rel · `BP-005` generic-link-text · `BP-006` meta-generator-exposed · `BP-007` inline-event-handlers · `BP-008` legacy-doctype) in the Rule Registry.
- **Best-Practices detectors** (`best-practices/`) — pure, deterministic checks over page HTML (mirrors `checks-static`), emitting registry-native findings; runs as an additive advisory pass. The frozen runtime is untouched.
- **Test suite** (`best-practices/best-practices.test.js`) — 38/38: detector fire/silence, suite shape, determinism, registry integration, and **score-neutrality**.
### Changed
- Registry → **1.2.0** (91 rules). Best-Practices suite carries **weight 0** — it has its own advisory sub-score but contributes nothing to the SGEN Quality Score.
### Notes
- **Freeze-safe, not a scoring change**: the 10 scored suite weights are unchanged and still total 100; every historical `overall` is byte-identical (golden 24/24, integration parity 95). No ADR required — additive per ADR-0001. Closes TD-003.

---

## 2026-07-08 — Regression 1.0.0  (WP-006 · Regression Engine)
### Added
- **Deterministic Regression Engine + release gate** (`regression/`) — reads the immutable stores (WP-003 scans + WP-004 findings), applies an explicit policy to a diff, and returns a PASS/WARN/FAIL verdict. Additive per ADR-0001 §4: owns no engine state; changes no rule/schema/event/score. No title matching (ruleId identity).
  - **Policy** (`policy.js`): explicit data — fail-on-new-severities, warn-on-new-severities, fail-on-reopen, fail-on-escalation-to, fail/warn score-drop thresholds. Verdict = worst fired effect. Default policy provided + fully overridable.
  - **Baseline store** (`baseline.js`): append-only baseline pointers per target (immutable; re-baseline appends, latest wins; full history retained).
  - **Detection** (`regression.js`): classifies created / resolved / modified / reopened / severity-escalations + score delta between baseline and candidate; builds a content-addressed verdict record.
  - **Verdict store** (`store.js`): append-only, content-addressed verdict records (temp→fsync→rename + manifest commit) — a gate decision is durable + certifiable; query by target/verdict.
  - **Integrity + reproducibility** (`integrity.js`): digest tamper detection + a reproducibility check that rebuilds the verdict from live stores (exposes a forged verdict, e.g. PASS where a rebuild yields FAIL) + recovery.
- **Comprehensive test suite** (`regression.test.js`) — 32/32 assertions across policy verdicts, determinism, baseline store, verdict store (content-address/reproducibility/tamper/restart/recovery), custom policy, and frozen regression; drives **real WP-003 + WP-004 stores**.
### Notes
- No frozen file modified. **History production gate → PASS** (Scan + Finding + Timeline + Regression all complete). Full custom policy stored in each verdict so a decision reproduces exactly.

---

## 2026-07-08 — Timeline 1.0.0  (WP-005 · Timeline Engine)
### Added
- **Deterministic health/quality Timeline Engine** (`timeline/`) — an analytics/read layer over the two immutable stores (WP-003 scans + WP-004 findings). Additive per ADR-0001 §4: reads immutable records only — owns no state, mutates nothing, changes no rule/schema/event/score. Same store content → byte-identical timeline.
  - **Timeline build** (`timeline.js`): per scan point — overall + per-suite score, finding counts (total + by severity), scan-to-scan delta (score + introduced/resolved/changed + classification), finding lifecycle activity, and open-findings-over-time. Builds with or without the finding store.
  - **Aggregates** (`aggregate.js`): milestones (best/worst/first-clean), streaks (trailing improving/regressing, clean runs), score trajectory, and finding rollups (longest-open, most-reopened).
  - **Materialized snapshots** (`snapshot.js`): content-addressed, append-only, reproducible timeline records (temp→fsync→rename + manifest commit) so a timeline shown to a customer can be certified.
  - **Integrity + reproducibility** (`integrity.js`): digest tamper detection, orphan/missing/partial-write, plus a reproducibility check that rebuilds from the live stores and flags drift; recovery removes partial writes and reports the unrepairable.
- **Comprehensive test suite** (`timeline.test.js`) — 38/38 assertions across determinism, series/deltas, lifecycle activity, open-over-time, milestones/streaks/trajectory/rollups, snapshot (content-address/reproducibility/tamper/restart/recovery), and edge cases; drives **real WP-003 + WP-004 stores** and re-runs the frozen suites in-process (56/56 + 60/60).
### Notes
- No frozen file modified. History production gate advanced (Scan + Finding + Timeline PASS; Regression pending WP-006).

---

## 2026-07-08 — Finding-Store 1.0.0  (WP-004 · Immutable Finding Store)
### Added
- **Immutable, append-only, content-addressed Finding Store** (`finding-store/`) — the authoritative lifecycle/history layer for QA findings. Additive to the frozen architecture (ADR-0001 §4): consumes immutable WP-003 scan records + the ruleId-only identity model (WP-001); changes no rule, schema, event, score, or frozen store. Findings are evidence objects — recorded, never mutated.
  - **Content-addressed identity** (`record.js`): `findingId` = sha256(ruleId | targetDigest | evidence-location) — stable across scans, title-invariant (WP-001); value changes keep identity but change `evidenceDigest`. `fingerprint` = semantic content hash; `recordId` = per-event address; `digest` = tamper-evidence.
  - **Deterministic lifecycle** (`lifecycle.js`): OPEN→CONFIRMED→ACTIVE; ACTIVE→UPDATED/RESOLVED/DUPLICATE/SUPERSEDED; RESOLVED→REOPENED→ACTIVE; DUPLICATE/SUPERSEDED terminal. Every illegal transition **fails closed** (no record written).
  - **Scan ingestion** (`store.js`): derives lifecycle events from an immutable scan record (with optional auto-RESOLVE of findings absent vs the previous scan); the only engine→history writer path. Append = temp→fsync→rename + manifest commit marker.
  - **Rebuildable indexes** — findingId · ruleId · target · severity · status · scanId · fingerprint · digest · date (+ firstSeen/lastSeen views); rebuild byte-identical.
  - **Diff engine** (`diff.js`): new / unchanged / modified / resolved / reopened / severity-changes / evidence-changes, keyed on ruleId identity (no title matching).
  - **Integrity + recovery** (`integrity.js`): detects modified/forged (digest + content-address), deleted, orphan, duplicate-identity-conflict, broken-chain, invalid-lifecycle-transition, reorder, torn-manifest (truncation), partial-write, orphaned scan-reference; recovery removes partial writes, truncates torn manifest tail, rebuilds indexes, preserves valid history, reports the unrepairable.
- **Comprehensive test suite** (`finding-store.test.js`) — 60/60 assertions across identity, lifecycle, integrity (9 classes), recovery/restart, history, concurrency, and measured performance @ 2,000 findings — fed **real WP-003 scan records** to prove cross-store compatibility.
### Notes
- Frozen regression green (scan-store 56/56, registry 83). No frozen file modified. History production gate advanced (Scan + Finding stores PASS; Timeline/Regression pending WP-005/006). No existing TD closed by this WP (TD-003 = Suite 11, unrelated).

---

## 2026-07-08 — Scan-Store 1.0.0  (WP-003 · Immutable Scan Store)
### Added
- **Immutable, append-only, content-addressed Scan Store** (`scan-store/`) — the platform history layer. Additive to the frozen architecture (ADR-0001 §4): consumes the frozen report-summary shape + lifecycle bus; changes no rule, schema, event, or scoring.
  - **Content-addressing** (`digest.js`, `record.js`): canonical serialization + sha256. `fingerprint` = sha256 of scored content (identical-scan detection); `scanId` = sha256(fingerprint|timestamp) (unique per run, deterministic — no clock/random); `digest` = whole-record hash (tamper-evidence).
  - **Append-only store** (`store.js`): atomic temp→fsync→rename record write; manifest append = the durable commit marker; a re-save of identical content is a reported duplicate, never a mutation.
  - **Rebuildable indexes** — by target · date · rule · severity · project · engine · digest · fingerprint; rebuild is byte-identical to incremental append (indexes hold no independent authority).
  - **Diff engine** (`diff.js`): deterministic scan/finding/rule/score/evidence diff; regression / improvement / mixed / unchanged classification.
  - **History/lineage** (`history.js`): parent↔child chains + per-target chronology (ancestors, children, previous, next, first, latest, root).
  - **Integrity + recovery** (`integrity.js`): detects digest-mismatch (tamper), orphan, missing, duplicate, broken-chain, address-mismatch, partial-write; recovery removes interrupted temp writes + rebuilds indexes and reports anything unrepairable.
- **Comprehensive test suite** (`scan-store.test.js`) — 56/56 assertions: determinism, append-only, immutability, lineage, diff, all integrity classes, recovery, restart, index-rebuild determinism, parallel scans, and measured performance @ 3,000 scans.
### Notes
- Closes TD-002. History production gate → PASS. Constitutional "append-only history" → PASS. Milestone stays BETA (Performance/Security/Testing/Ops gates still open).

---

## 2026-07-08 — E 2.1.0  (WP-001 · Native Rule IDs)
### Changed
- **Runtime identity is now the native `ruleId`.** Every emitter (`checks-static`, `checks-render`, `audit` row builders) names its registry rule ID; severity+title resolve from the registry (with per-finding display overrides for axe/CWV via `over`).
- `checks-static.js` `F()` → `F(ruleId, check, section, detail, url, value)`; `checks-render.js` `F()` → `F(ruleId, check, section, detail, url, value, over)`; `audit.js` `row()` gains `ruleId`.
### Removed
- **`matchTitle()` deleted** from the runtime (registry, finding, score) — the title→id bridge is gone (repo audit: 0 refs).
### Fixed
- Latent `titleMatch` over-match on a pass row (removed with `matchTitle`; TD-004 closed).
### Notes
- Backward-compatible: golden parity byte-identical (24/24), both qa-site + qa-migration unchanged. Rename test proves titles are presentation-only. Debt: TD-001 CLOSED; TD-007 (shared `check`/`section` grouping) remains Low/non-blocking.

---

## 2026-07-08 — E 2.0.0 · R 1.1.0 · Rep 1.1.0  (Registry-Driven Engine)
### Added
- **Rule Registry** (`rules/registry.js`) — single source of truth, 83 rules with permanent IDs, full metadata.
- **Rule lookup service** — `getById/getBySlug/bySuite/getManualRules/getDeterministicRules/getRulesByMethod/Severity/Category`.
- **Runtime validation** — fail-fast on invalid registry (ids, slugs, suites, severities, methods, docs, weights=100, manual⇔0).
- **Registry versioning** (`REGISTRY_VERSION`) + independent Engine/Report/Registry version streams (`version.js`).
- **Canonical Finding model** (`finding.js`) — findings carry `ruleId` + registry metadata natively.
- **Event bus** (`events.js`) — 7 lifecycle events; guarded emit; the platform extension seam.
- **Frozen JSON Schemas** — rule · finding · report-summary.
- **Registry test suite** (`rules/registry.test.js`) — invariants, reachability, one-check-one-suite.
- **Governance docs** — CHARTER.md (program charter), CERTIFICATION.md, ROADMAP.md, ARCHITECTURE.md, CHANGELOG.md, docs/adr/ (TEMPLATE + ADR-0001).
- Registry rules SEO-029 (`robots-missing`) and SEO-030 (`staging-leak`) — closed coverage gaps.
### Changed
- **Quality Score now derives entirely from the registry** — zero hardcoded deductions/weights.
- Pass/fail **status** is registry-derived (from rule severity), not check-emitted.
- `audit.js` reordered to **enrich → count → score**; result now includes `versions` + registry-stamped `suites`.
### Fixed
- Manual findings were incorrectly emitting `finding.created` — now only real findings (fail/warn) do.
- Report client-script regression (`\/` inside a template literal broke a regex → empty suites) — fixed.
- qa-serve report clipping (iframe `scrolling=no` + one-shot height) — re-measures + open-full-report link.
### Removed
- Hardcoded scoring table from `score.js` (moved into the registry).

---

## 2026-07-07/08 — E 1.x  (Baseline auditor)
### Added
- 10-suite deterministic auditor: Functional · Links · Forms · Responsive · Accessibility · SEO · Performance · Security · Cross-Browser · Console.
- Deterministic **SGEN Quality Score** (initial), per-finding **drill-down** (page · section · element, clickable links), full-page screenshots.
- Real engines: axe-core (WCAG), TLS certificate inspection, Firefox + WebKit cross-browser.
- Modes: `qa-site` · `qa-migration` (v2.0 Standard) · `qa-serve` (local web UI) · `qa-compare` (scan diff).
- **`qa-visual-match`** — old-live vs SGEN-staging structural + pixel comparison at the 6 SG-Builder breakpoints.
- Self-contained, shareable HTML reports; shippable standalone package.

_Nothing in this file is dated without a corresponding evidence-ledger entry in CERTIFICATION.md for the same day._
