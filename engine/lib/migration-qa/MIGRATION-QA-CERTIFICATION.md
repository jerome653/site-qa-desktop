# SGEN Migration QA & Production Certification Standard

> The definitive standard for deciding whether a migrated website is **safe to deploy to production
> and faithfully represents the source site**. Evidence-backed against the actual implementation
> (`lib/migration-qa/*`, `lib/site-qa/*`). No feature creep — migration validation + production
> readiness only. Deterministic, no AI. Last audit: 2026-07-08.

**Scope discipline (binding):** this is a *migration + production-readiness* gate, **not** a generic
website-auditing platform. Every item below earns its place by answering one question:
*"would a client notice, or would production break, if this failed?"* Anything that doesn't is
advisory or explicitly out of scope.

---

## Phase 0 · Honest note on the referenced "proposed" document
`Downloads/SGEN-Migration-Current-vs-Proposed.html` was supplied as the "proposed future state."
**On inspection it is a comparison of the migration *process/workflow*** (SGEN's 4-phase / 67-step
board vs an 11-phase / 39-step best-practice SOP, offboarding, effort estimates) — **not a
specification of QA checks.** It contains zero check definitions. Treating it as a check spec would
be fabrication. Therefore **Phase 2 maps the existing implementation against the 9 release gates
defined in this program's own master prompt**, which *are* a check specification. The process doc is
correctly used only as context for *which lifecycle phase* each gate belongs to.

---

## Phase 1 · Inventory of what already exists (DISCOVERY)

The Migration QA engine is `sgen qa-migration <url> [--env staging|live] [--redirects <file>]`. It is
**deterministic, env-aware** (staging expects `noindex`; live is post-cutover), and produces a
`NOT-READY` / `AUTOMATED-PASS — awaiting manual sign-off` verdict. Identity is the native registry
`ruleId` (single source of truth: `lib/site-qa/rules/registry.js`, 95 rules).

### 1.1 Existing capabilities (present, working)
| Capability | Where | Status |
|---|---|---|
| Page discovery — sitemap + sitemap-index recursion + BFS link-follow, same-host, anonymous | `crawl.js` | ✅ production |
| Per-page static HTML + response-header checks (26) | `checks-static.js` STATIC_CHECKS | ✅ production |
| Site-level checks (4: robots, sitemap, 404-config, HTTPS-enforce) | `checks-static.js` SITE_CHECKS | ✅ production |
| Headless render pass (Playwright/Chromium) | `checks-render.js` | ✅ production |
| axe-core WCAG 2.1 A/AA engine (A11Y-001) | `checks-render.js` | ✅ (skips honestly if axe not installed) |
| Responsive overflow / tap-target / input-font sweep @ 3 viewports (390/768/1440) | `checks-render.js` SWEEP | ✅ production |
| AA colour-contrast sampling (A11Y-002) | `checks-render.js` | ✅ production |
| Console-error + failed-request capture (CON-001/002) | `checks-render.js` | ✅ production |
| Core Web Vitals LCP + CLS (PERF-001/002), page-weight (PERF-006) | `checks-render.js` | ✅ (LCP/CLS lab, not field) |
| Full-page screenshot per page×viewport (manual-review evidence) | `checks-render.js` | ✅ production |
| **Redirect preservation** — old-URL list → 301/410 check on live (`--redirects`) | `sgen-qa-migration.js` | ✅ production |
| Production gate — NOT-READY iff any critical/high survives | `verdict.js` | ✅ production |
| Manual sign-off checklist (env-split: staging QA vs launch/post-launch) | `manual-checklist.js` | ✅ production |
| HTML + JSON report, section + check grouping, drill-down items | `report.js` | ✅ production |
| **Source-vs-migrated visual match** (old-live vs new at 6 breakpoints; pixel + structural diff) | `site-qa/visual-match.js` + `pipeline.js --compare` | ✅ exists (separate engine; **not wired into `qa-migration`**) |

### 1.2 Existing checks — full inventory (by category, with rule ID + severity + status)
Severity classifies; the **registry deduction** (not shown) sets score. `env` = when it runs.
Blocking = critical/high (fails the gate). All are deterministic + production-ready unless noted.

**Content (§2)**
| Rule | Check | Sev | Purpose | Blocking |
|---|---|---|---|---|
| FUNC-004 | placeholder-content | high | lorem/`…here`/sample/TODO in visible copy | ✅ |
| FUNC-006 | broken-rich-content | low | empty `<pre>/<code>` | — |
| FUNC-007 | broken-rich-content | low | structureless `<table>` | — |
| FUNC-008 | content-artifacts | high | unresolved `{{tokens}}` / mojibake / `�` / double-escaped (pipeline advisory) | ✅ |
| FUNC-009 | misspelling-common | medium | common typos + doubled words (pipeline advisory) | — |

**Functional / availability (§3, §10)**
| Rule | Check | Sev | Purpose | Blocking |
|---|---|---|---|---|
| FUNC-001 | page-status | critical | HTTP 5xx | ✅ |
| FUNC-002 | page-status | critical | HTTP 4xx (also surfaces broken internal links found in crawl) | ✅ |
| FUNC-003 | page-status | medium | 3xx redirect on a crawled page | — |
| FUNC-005 | global-components | low | missing header/nav/footer landmark | — |
| LINK-004 | 404-config | medium | soft-404 (unknown path returns 200) | — |
| LINK-005 | anchor-target | low | dead in-page `#fragment` | — |

**Visual / assets (§1)**
| Rule | Check | Sev | Purpose | Blocking |
|---|---|---|---|---|
| A11Y-007 | images | medium | `<img>` with no src/srcset (broken image) | — |
| A11Y-006 | images | medium | images missing alt | — |
| A11Y-008 | images | low | images missing width/height (CLS) | — |
| RESP-001 | viewport-meta | critical | no `<meta viewport>` → cannot be responsive | ✅ |

**Responsive (§4) — render pass**
| Rule | Check | Sev | Purpose | Blocking |
|---|---|---|---|---|
| RESP-002 | horizontal-overflow | high | page scrolls sideways | ✅ |
| RESP-003 | overflow-element | high | element bleeds past right edge | ✅ |
| RESP-004 | element-wider-than-viewport | high | element wider than viewport | ✅ |
| RESP-005 | tap-target-small | medium | tap target < 44px (mobile) | — |
| RESP-006 | input-font-small | low | input font < 16px (iOS zoom) | — |

**Accessibility (§7) — render + static**
| Rule | Check | Sev | Purpose | Blocking |
|---|---|---|---|---|
| A11Y-001 | axe | high/med/low | axe-core WCAG 2.1 A/AA violations (dynamic sev by impact) | ✅ when high |
| A11Y-002 | low-contrast | medium | text below AA contrast | — |
| A11Y-003 | headings | high | no `<h1>` | ✅ |
| A11Y-004 | headings | low | multiple `<h1>` | — |
| A11Y-005 | headings | low | skipped heading level | — |
| A11Y-009 | html-lang | low | `<html>` missing lang | — |

**SEO / preservation (§8, §9)**
| Rule | Check | Sev | Purpose | Blocking |
|---|---|---|---|---|
| SEO-001 | title | high | missing `<title>` | ✅ |
| SEO-002 | title | low | title length 10–70 | — |
| SEO-003 | meta-description | medium | missing description | — |
| SEO-004 | meta-description | low | description length | — |
| SEO-005 | canonical | medium | missing canonical | — |
| SEO-006 | canonical | critical | **canonical points at a staging host on live** | ✅ |
| SEO-007 | indexability | critical | **live page carries `noindex`** (forgot to remove staging flag) | ✅ |
| SEO-008 | indexability | medium | staging is indexable (should be noindex pre-launch) | — |
| SEO-030 | staging-leak | critical | **staging/preview host referenced on live page** | ✅ |
| SEO-011/012 | social-meta | medium/low | incomplete OG / missing Twitter card | — |
| SEO-014 | favicon | low | no favicon | — |
| SEO-016–019 | schema | low/med | missing/invalid/typeless/bad-context JSON-LD | — |
| SEO-020 | robots-txt | critical | **`Disallow: /` on production** (blocks all crawling) | ✅ |
| SEO-021 | robots-txt | low | robots has no Sitemap: line | — |
| SEO-022 | sitemap | medium | no XML sitemap found | — |
| SEO-025/026 | analytics | medium/low | tracking absent on live / present on staging | — |
| SEO-027 | mobile-web | low | mobile web-app metadata | — |
| SEO-028 | privacy-links | low | privacy/terms/cookie signals | — |
| SEO-029 | robots-txt | medium | no robots.txt | — |
| _redirects_ | redirect preservation | — | old URLs 301/410 on live (`--redirects`) — **the core SEO-preservation migration check** | reported |

**Performance (§6) — render + static**
| Rule | Check | Sev | Purpose | Blocking |
|---|---|---|---|---|
| PERF-001 | cwv-lcp | medium | LCP > 2.5s / 4s (lab) | — |
| PERF-002 | cwv-cls | medium | CLS > 0.1 / 0.25 (lab) | — |
| PERF-003 | image-perf | low | little/no lazy-loading | — |
| PERF-004 | image-perf | low | no WebP/AVIF | — |
| PERF-005 | render-blocking | low | render-blocking CSS/JS in `<head>` | — |
| PERF-006 | page-weight | medium | heavy page (requests/bytes) | — |
| PERF-007 | compression | low | no gzip/br on HTML | — |

**Security / production (§10)**
| Rule | Check | Sev | Purpose | Blocking |
|---|---|---|---|---|
| SEC-007 | https-enforce | high | origin served over HTTP | ✅ |
| SEC-008 | https-enforce | high | HTTP not redirected to HTTPS | ✅ |
| SEC-009 | mixed-content | high | insecure subresource on HTTPS page | ✅ |
| SEC-010 | security-headers | medium | ≥3 of HSTS/CSP/nosniff/frame/referrer absent | — |
| CON-001 | console-errors | high | JS/console errors at runtime | ✅ |
| CON-002 | failed-requests | high | asset requests ≥400 / failed (missing CSS/fonts/images) | ✅ |

**Browser (§5)** — automated render is **Chromium only**; Firefox/WebKit + real devices are **manual
checklist** items in migration-qa (the standalone `qa-site` engine runs Firefox+WebKit; migration-qa
does not). TLS-certificate inspection (SEC-001..006) lives in `qa-site`, **not** migration-qa.

### 1.3 What migration-qa does NOT do today (evidence, not assumption)
- **No source-vs-migrated completeness comparison.** It audits the migrated site *in isolation*. It never diffs the OLD site's page / section / image / document inventory against the new site to catch *unintentionally missing* content. (`crawl.js` crawls one target; there is no reference-site inventory.)
- **Source-vs-migrated visual fidelity is not wired into `qa-migration`.** The capability exists (`visual-match.js`, `pipeline.js --compare`) but is a separate command.
- **No dedicated broken-link graph** (LINK-001/002/003 external + redirect-chain live in `qa-site`, not migration-qa). Broken *internal* links still surface indirectly as 4xx pages during the crawl.
- **No form-submission / interactive-flow execution** (correctly deferred to the manual checklist — code cannot certify a real email/CRM delivery).
- **CWV is lab (headless), not field (CrUX).**

---

## Phase 2 · Coverage matrix — existing implementation vs the 9 gates
Legend: ✔ implemented · 🟡 partial · ❌ missing · ⚠ better existing alternative · 🚫 out of scope.

| # | Gate | Status | Evidence |
|---|---|---|---|
| 1 | **Migration Completeness** (nothing unintentionally missing vs source) | ❌ **MISSING** | No reference-site inventory or source-vs-migrated diff anywhere in `migration-qa`. This is the single biggest gap and the one thing that makes migration QA *migration* QA. |
| 2 | **Visual Fidelity** (source vs migrated) | 🟡 **PARTIAL** | `visual-match.js` does old-vs-new pixel + structural diff at 6 breakpoints — but it is **not wired into `qa-migration`**; migration-qa only captures standalone screenshots as manual evidence. |
| 3 | **Functional Validation** (forms, buttons, interactive) | 🟡 **PARTIAL / by design** | Availability (FUNC-001/002/003), soft-404 (LINK-004), dead anchors (LINK-005) automated; forms/tabs/accordions/search/filters are **manual checklist** (correct — code can't certify real delivery). |
| 4 | **Responsive Verification** | ✔ **IMPLEMENTED** | RESP-002..006 overflow/tap/font sweep @ 3 viewports + screenshots; multi-device eyeball is manual. |
| 5 | **Content Integrity** (missing/dup/encoding/broken assets/placeholder) | 🟡 **PARTIAL** | placeholder (FUNC-004), artifacts/encoding (FUNC-008), broken images (A11Y-007), broken assets (CON-002) ✔; **missing/duplicate *text* vs source ❌** (needs the source inventory from Gate 1). |
| 6 | **SEO Preservation** | ✔ **IMPLEMENTED (strong)** | title/desc/canonical/OG/robots/sitemap/headings/alt/schema + **noindex-on-live, staging-leak, canonical-off-domain, Disallow:/** + **redirect preservation (`--redirects`)**. This is the most complete gate. |
| 7 | **Accessibility Baseline** | ✔ **IMPLEMENTED** | axe-core WCAG A/AA + contrast + headings + labels(via axe) + html-lang. (Keyboard-nav is manual.) |
| 8 | **Production Readiness** | ✔ **IMPLEMENTED** | console errors, failed assets, HTTPS-enforce, mixed-content, security headers, compression, 404-config. SSL-cert expiry is in `qa-site` (SEC-001..006), not migration-qa. |
| 9 | **Final Certification** (single verdict) | 🟡 **PARTIAL** | `verdict.js` emits NOT-READY / AUTOMATED-PASS-awaiting-sign-off — a **two-value** gate, not the required **PASS / PASS-WITH-MINOR-ISSUES / FAIL** three-value output. |

---

## Phase 3 · Gap analysis (production-critical only — no feature creep)

| Gap | Why needed | Production issue it detects | Client notices? | Blocks deploy? | Complexity | Priority |
|---|---|---|---|---|---|---|
| **G1 · Migration Completeness engine** (crawl OLD + NEW, pair by URL/path, diff page set + per-page section/image/document/heading counts; flag pages/assets present on source but absent on migrated) | The defining migration failure is *silently dropped content*. Nothing detects it today. | Missing pages, dropped sections, lost images/PDFs, absent nav items | **Yes — directly** | **Yes** | Medium (reuse `crawl.js` twice + a diff) | **P0** |
| **G2 · Wire visual-match into `qa-migration`** (`--compare <old>`; fold VIS-001/002 into the migration verdict at the SG-Builder breakpoints) | Visual fidelity vs source is Gate 2; the engine exists but is disconnected. | Layout/spacing/typography/color drift vs the original | **Yes** | Advisory→blocking on gross mismatch | Low (already built; wire it) | **P0** |
| **G3 · Three-value certification** (`PASS` / `PASS WITH MINOR ISSUES` / `FAIL`) | Gate 9 requires unambiguous output; today it is two-valued. | — (reporting correctness) | — | — | Low | **P1** |
| **G4 · Content-integrity vs source** (missing/duplicate visible text blocks vs the source inventory) | Gate 5's missing/duplicate-text half needs the source; depends on G1. | Dropped or duplicated copy | **Yes** | Advisory unless a whole block is gone | Medium (depends on G1) | **P1** |
| **G5 · Broken-document / media check** (PDF/DOC/video/audio links resolve 200; `<video>/<source>` load) | Migrations frequently drop linked documents + media. | Broken downloads, dead videos | **Yes** | Advisory→blocking if a linked doc 404s | Low (extend crawl to HEAD asset links) | **P1** |
| **G6 · SSL-certificate expiry in the migration gate** (reuse `qa-site` SEC-001..006) | Live cut-over with an expired/mismatched cert = hard outage. | Expired/untrusted/hostname-mismatch cert | **Yes** | **Yes (live)** | Low (module exists) | **P1** |
| **G7 · Redirect-chain / loop on the redirect list** (extend `--redirects` to flag multi-hop + loops, not just final status) | 301-chains bleed link equity + slow first paint. | SEO equity loss, redirect loops | Indirect | Advisory | Low | **P2** |

Explicitly **rejected as feature creep** (belong to a general Website Audit, not Migration QA):
full performance-budget optimization, exhaustive a11y remediation, keyword/ranking analysis, uptime
monitoring, content rewriting. These stay advisory or out of scope.

---

## Phase 4 · Release gates (the certification contract)

A migration is certified only when **every mandatory gate passes**. Mandatory = **blocking**;
advisory = reported, never blocks.

| Gate | Mandatory? | PASS definition (deterministic) | Backed by |
|---|---|---|---|
| **G-1 Completeness** | **Mandatory** | No source page/section/image/document is *unintentionally* absent on the migrated site (diff, with an allow-list for intentionally-removed URLs). | G1 (to build) |
| **G-2 Visual Fidelity** | Mandatory (gross), advisory (minor) | No page-pair exceeds the pixel/structural threshold at any SG-Builder breakpoint beyond an approved allow-list. | visual-match (wire via G2) |
| **G-3 Functional** | Mandatory (availability), manual (flows) | Zero 5xx/4xx on crawled pages; no soft-404; forms + interactive verified on the manual checklist. | FUNC-001/002, LINK-004/005 + manual |
| **G-4 Responsive** | Mandatory | No horizontal overflow / element-wider-than-viewport at 390/768/1440; multi-device eyeball signed off. | RESP-002..004 + manual |
| **G-5 Content Integrity** | Mandatory (assets), advisory (text) | No broken images/assets/documents; no placeholder/lorem; encoding clean. Missing/dup text advisory (G4). | A11Y-007, CON-002, FUNC-004/008, G5 |
| **G-6 SEO Preservation** | **Mandatory (live)** | No noindex-on-live, no staging leak, no off-domain canonical, no `Disallow:/`; redirect map 301/410-clean; title/canonical present. | SEO-006/007/020/030 + redirects |
| **G-7 Accessibility Baseline** | Mandatory (no high axe), advisory (rest) | No high-impact axe WCAG A/AA violations; contrast/headings advisory. | A11Y-001 (+002/003) |
| **G-8 Production Readiness** | **Mandatory** | No console errors, no failed asset requests, HTTPS enforced, no mixed content, SSL valid (live). | CON-001/002, SEC-007/008/009 + G6 |
| **G-9 Final Certification** | — | Emit exactly one: **PASS** (no mandatory finding) · **PASS WITH MINOR ISSUES** (only advisory findings) · **FAIL** (≥1 mandatory finding). | G3 (to build) |

**Certification statement (the one question this answers):**
> *"Can this migrated website be safely deployed to production, and does it faithfully represent the
> source website while meeting SGEN quality standards?"* — **PASS only if every mandatory gate passes.**

---

## Phase 5 · Critical review (challenging this spec)

- **Are we missing production-critical checks?** Yes — exactly one class: **completeness vs source (G1)**. Everything else is present or advisory. Without G1 the tool is a *site auditor*, not a *migration* auditor. This is the highest-value addition.
- **Are we checking anything unnecessary?** For a *migration* gate, the deep-SEO niceties (SEO-016..019 schema detail, SEO-027 mobile-web-app meta, SEO-028 privacy signals) and perf micro-hints (PERF-003/004/005/007) are **advisory, not migration-critical** — keep them non-blocking (they already are). Do **not** promote them.
- **Duplicate / mergeable checks:** `page-status` (FUNC-001/002/003) already catches broken internal links → **do not add a separate internal-link crawler** (would duplicate). FUNC-008 (artifacts) and FUNC-004 (placeholder) are complementary, not duplicate — keep both. `qa-site`'s LINK-001/002/003 overlap page-status for internal links; only **external** link + **redirect-chain** checking is genuinely additive (G7, and only advisory).
- **Should become advisory only:** PERF-001..007, SEO-011/012/016-019/021/027/028, A11Y-004/005/008/009 — quality signals, not deploy-blockers. (Already non-blocking; keep it that way.)
- **Should block deployment:** availability (5xx/4xx), responsive overflow, HTTPS/mixed-content, console/asset failures, noindex-on-live, staging-leak, off-domain canonical, `Disallow:/`, and (once built) **completeness** + **SSL-expiry-on-live**. This is the minimal blocking set — resist expanding it.
- **Belongs in a separate Website Audit, not Migration QA:** ongoing performance optimization, ranking/keyword analysis, full WCAG remediation beyond the axe baseline, uptime/monitoring. `qa-site` + the history/timeline platform already own the "ongoing quality" story; migration QA should stay a **one-shot cut-over gate**.

**Net:** the existing system is ~80% of a complete migration gate and is *not* over-built. The gap is
narrow and specific: **source-comparison** (completeness + visual + missing-text) and a **clean
three-value verdict**. Everything else is reuse.

---

## Phase 6 · Implementation roadmap (DO NOT build yet — plan only)

| ID | Capability | Category | Depends on | Effort | Priority | Reuse | Tests required | Docs | Migration impact |
|---|---|---|---|---|---|---|---|---|---|
| **MIG-G1** | Completeness engine: crawl OLD + NEW, pair by path (+ `--url-map`), diff page-set + per-page section/img/doc/heading counts; new rules `MIG-001 page-missing`, `MIG-002 asset-missing`, `MIG-003 section-count-drop` (advisory weight-0 suite `migration`, like Best Practices) | Migration | crawl.js | Medium | **P0** | `crawl.js` (run twice), registry additive pattern | unit: pairing, diff classification, allow-list, determinism, zero-false-positive on identical sites | rule docs + standard update | none to existing checks (additive suite) |
| **MIG-G2** | Wire `visual-match` into `qa-migration` (`--compare <old>`); fold VIS-001/002 into the section verdict | Visual | visual-match.js, pipeline fold | Low | **P0** | 100% reuse | integration: fold + verdict; live 2-site run | CLI flag doc | none (additive) |
| **MIG-G3** | Three-value verdict in `verdict.js` (`PASS` / `PASS WITH MINOR ISSUES` / `FAIL`) driven by mandatory-vs-advisory rule classification | Production | verdict.js | Low | **P1** | verdict.js | unit: each verdict boundary | standard update | changes verdict *labels* only (no rule change) |
| **MIG-G4** | Missing/duplicate visible-text diff vs source (`MIG-004`) | Content | MIG-G1 | Medium | **P1** | MIG-G1 inventory | unit: block-level diff, dup detection | rule doc | additive |
| **MIG-G5** | Broken-document/media resolver (HEAD linked PDF/DOC/video/audio; `<video>/<source>` load) — `LINK-002`/new `MIG-005` | Assets | crawl.js/http.js | Low | **P1** | http.pool | unit: 200/404/redirect classification | rule doc | additive |
| **MIG-G6** | SSL-cert expiry/trust in the migration gate on live (reuse SEC-001..006 from `qa-site`) | Security | tls-check.js | Low | **P1** | 100% reuse | integration | standard update | additive (live only) |
| **MIG-G7** | Redirect-chain/loop flag on the `--redirects` list (advisory) | SEO | redirect check | Low | **P2** | existing redirect loop | unit: chain/loop detection | CLI doc | additive |

**Sequencing:** MIG-G3 (verdict shape) + MIG-G2 (wire existing visual) first — both are near-zero-risk
reuse. Then MIG-G1 (the real gap) → MIG-G4 depends on it. MIG-G5/G6/G7 are independent quick wins.

**Every new rule** follows the proven freeze-safe pattern: additive registry entry (advisory
weight-0 `migration` suite so it never perturbs the existing SGEN Quality Score), a standalone
detector module, a test proving zero false positives on an identical-site control, and golden-parity
re-verification. No existing check is rewritten; no working code is touched.

---

## Certification summary (current state, honest)
- **Migration QA today: production-grade for a migrated site *in isolation* (SEO preservation, production readiness, responsive, a11y, content-artifacts) — verified live 2026-07-08.**
- **Not yet a complete *migration* gate:** it cannot yet prove *faithful representation of the source* (completeness + visual fidelity vs old) or emit the three-value certification. Those are the P0/P1 items above — small, reuse-heavy, additive.
- **Recommendation:** ship MIG-G3 + MIG-G2 immediately (verdict shape + wire existing visual-match), then MIG-G1 (completeness). That closes every gap to a full, deterministic, no-AI Migration Certification gate without expanding scope into a generic auditing platform.
