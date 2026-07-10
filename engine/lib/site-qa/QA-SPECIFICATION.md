# SGEN QA — Completed Specification (Viewports · Evidence · Visual Package · Global Components)

> Continuation of `QA-ARCHITECTURE.md` (approved 3-tool architecture). Specification only — **no code**.
> Every recommendation is evidence-backed against the actual implementation. Deterministic, no AI.
> 2026-07-08.

---

## PART 1 — Viewport Certification

### 1.1 SGEN already defines the breakpoints — reuse them (do not invent)
**Evidence:** the canonical set is the **6 SG-Builder breakpoints**, defined identically in
`visual-match.js:19-24` and in `CLAUDE.md:98` / `.claude/agents/cd-to-sg.md:27` (the `.sgbuilder-pn-btn`
sweep). These are the widths SGB authors *build* against, so a comparison at these widths lines up with
how the site was made.

| Profile (canonical) | Width | Role | Required? |
|---|---|---|---|
| Desktop XL | **1920** | large desktop | ✅ required |
| Desktop | **1199** | standard desktop / laptop | ✅ required |
| Tablet Landscape | **991** | tablet landscape | ✅ required |
| Tablet (Portrait) | **767** | tablet portrait | ✅ required |
| Mobile Landscape | **575** | large phone / landscape | ✅ required |
| Mobile (Portrait) | **480** | phone | ✅ required |
| **Full Browser (current window)** | dynamic | the user's actual window | ⭘ optional (advisory) |

**Honest reconciliations (must be fixed in implementation, flagged here):**
- The user's list included **"Laptop"** — **SGEN has no distinct Laptop breakpoint.** Do not invent one; **1199 (Desktop)** covers the laptop range. Recorded so nobody adds a phantom width later.
- **"Full Browser (current window)"** is a *dynamic* profile (the live window size), so it is **non-deterministic** — it is **optional and advisory only, never certification-blocking**, and its result is labelled with the exact width used.
- **Inconsistency to resolve:** the migration render-pass (`checks-render.js:23-27`) uses a *different* 3-viewport subset (390/768/1440) than the canonical 6. **The spec mandates a single source of truth: the 6 SGB widths.** All tools (Site Audit render pass, Visual Comparison, Migration Certification) execute the identical profile.

### 1.2 Custom breakpoints
The viewport profile is **sourced from SGB, not hardcoded per tool.** If a project defines custom SGB
breakpoints, those **automatically join the required profile** (the profile is read from the SGB
breakpoint set, so custom widths are included without code changes). Custom widths inherit the same
required/optional + certification rules as the built-ins.

### 1.3 Required vs optional execution
- **Required:** all 6 canonical widths (+ any project custom widths). A comparison/audit is **not certifiable** unless every required viewport produced a result (PASS / WARNING / FAIL / Manual).
- **Optional:** Full Browser. Runs on request; contributes evidence but **never blocks** certification.

### 1.4 Certification requirements (per-viewport)
- A viewport **PASSES** when it has **no mandatory (blocking) finding** at that width.
- A viewport is **WARNING** when it has only advisory findings.
- A viewport **FAILS** when it has ≥1 mandatory finding (e.g. horizontal overflow RESP-002, element-wider-than-viewport RESP-004).
- **Mobile widths (575, 480) are required and blocking** — a mobile-only failure fails the certification. (Migrations most often break on mobile; this is deliberate.)
- **Overall certification = every required viewport is PASS or WARNING.** One required-viewport FAIL ⇒ the site fails certification, with the failing viewport(s) named.

### 1.5 Failure handling (a viewport that cannot be measured)
If a viewport cannot render or capture (navigation timeout, JS crash, blocked asset, screenshot
failure), that viewport is **`Manual Verification Required`** — **never auto-PASS and never auto-FAIL.**
This mirrors the existing platform stance: the tool already carries a `manual` status that never fakes
green (`verdict.js`, migration `manual-checklist.js`). Certification with any required viewport in
`Manual` state is **`PASS WITH MINOR ISSUES` at best**, never a clean PASS.

### 1.6 Reporting format (this becomes part of certification)
Every audit/comparison report carries a **Viewport Results** block, and the certification record embeds it:
```
Viewport Results
  Desktop XL   (1920)   PASS
  Desktop      (1199)   PASS
  Tablet LS    (991)    PASS
  Tablet       (767)    WARNING
  Mobile LS    (575)    PASS
  Mobile       (480)    FAIL        ← blocks certification
  Full Browser (1536)   PASS        (advisory)
Certification viewport gate: FAIL (Mobile 480)
```

---

## PART 2 — Evidence Standard (platform rule)

### 2.1 The rule
**No automated finding may exist without evidence.** This becomes a platform-wide law for Site Audit,
Visual Comparison, and Migration Certification. **Precedent already exists** — the QA pipeline enforces
exactly this for feature cards via `block-card-status-without-evidence.js` (a finding without
screenshot+console+network evidence is rejected). This spec generalises that hook's principle to every
automated finding.

### 2.2 Evidence schema (per finding)
`always` = mandatory for every finding; `as-applicable` = required when the finding type produces it.

| Field | Requirement | Source today |
|---|---|---|
| `ruleId` | **always** | present (registry identity) |
| `severity` | **always** | present (registry) |
| `confidence` | **always** | ⭘ **new field** (see 2.3) |
| `method` (automated \| manual) | **always** | present (registry `method`) |
| `pageUrl` | **always** | present (`location`) |
| `viewport` | as-applicable (render/visual) | present in render items (`[label]`) — **promote to a field** |
| `timestamp` | **always** | ⭘ **new** (scan has `generated`; stamp per finding) |
| `section` | as-applicable | present (`items[].section`) |
| `component` | as-applicable | ⭘ **new** (component labelling, planned) |
| `element` / `domSelector` | as-applicable | present (`items[].id` = selector) |
| `cssPath` | as-applicable (if available) | ⭘ **new** (structural read can emit it) |
| `coordinates` / `boundingBox` | as-applicable (visual/responsive) | ⭘ **new** (geometry exists in the sweep; persist it) |
| `screenshot` | as-applicable (render) | present (`shots{}` per page×viewport) |
| `before` / `after` images | as-applicable (comparison) | present (ref/cand shots in visual-match) |
| `diffOverlay` | as-applicable (comparison) | present (`__diff.png` from `pixelDiff`) |
| `highlightRegion` | as-applicable (comparison) | ⭘ **new** (from boundingBox) |
| `metrics` (px%, ratio, ms, bytes…) | as-applicable | present (`value`) |

**Net:** ~60% of the schema is already captured; the additions (`confidence`, `timestamp`,
`component`, `cssPath`, `boundingBox`, `highlightRegion`) are **field promotions/persistence of data the
engine already computes** — not new detection. No finding shape is rewritten; the evidence object is
*extended*.

### 2.3 Detection Confidence (NOT a generic "confidence" score)
Do **not** expose a generic `confidence` — it gets confused with overall migration quality. Expose
**Detection Confidence**: *how sure the tool is that it detected this finding correctly*, paired with an
**Evidence** completeness flag. It is about the *detection*, never about the *migration*.
```
Rule       VIS-018
Detection  98%          ← Detection Confidence: how reliably this was detected
Evidence   Complete     ← Complete | Partial | Unavailable
Status     PASS
```
- **~100% — deterministic detection:** exact HTML/header facts (missing title, noindex, 4xx, mixed content, unresolved `{{token}}`, pixel diff). The vast majority.
- **~70–90% — sampled/heuristic detection:** contrast sampling (capped set), page-weight (content-length floor), CWV (lab not field), structural pairing by text, class-name-inferred globals ("sticky header").
- Detection Confidence + Evidence(Complete/Partial/Unavailable) print on every finding. **Evidence = Unavailable ⇒ `Manual Verification Required`** (never a certainty claim). Neither field is ever averaged into the SGEN Quality Score.

### 2.4 Fallback (evidence cannot be collected)
If the tool cannot collect the evidence a finding *requires*, it **must not claim certainty**. It emits
the finding as **`Manual Verification Required`** — **never FAIL, never fake PASS.** (Same discipline as
the existing 4th `manual` status; the tool has never fake-greened and must not start.)

---

## PART 3 — Visual Comparison Evidence Package

Every mismatch produces a **complete, self-contained evidence package** so any issue is immediately
actionable and reproducible from the report alone.

### 3.1 Artifact tiers
| Tier | Artifacts |
|---|---|
| **Required** (every mismatch) | Reference screenshot · Current screenshot · Difference overlay · Viewport · DOM selector · Section · Similarity score · Pixel-difference % · Rendered dimensions · Capture timestamp · Page URL |
| **Recommended** | Highlighted region (bounding box) · Component name · Coordinates · CSS path · Before/After crop of the changed region |
| **Optional** | Per-element side-by-side crop · Computed-style delta table · Animation-frame note · Font/asset load list |

### 3.2 Evidence per comparison level
| Level | Required evidence | Similarity basis |
|---|---|---|
| **Page** | full-page ref + current + diff overlay · page pixel-mismatch % · viewport · page match score | pixel-mismatch % over the aligned full page |
| **Section** | section screenshot (ref+current) · section label (landmark+heading) · section pixel % · structural deltas (missing/extra/moved/restyled) | pixel % of the section region + structural delta count |
| **Component** | component crop (ref+current) · component name · bounding box · pass/warn/fail | element-set match within the component + pixel % of its box |
| **Element** | element bounding box · DOM selector · computed-style delta (font/size/weight/color/spacing) · geometry delta (x/y/w/h) | geometry + computed-style equality; pixel % of the element box |

### 3.3 Screenshot capture (deterministic)
- Render at the **exact profile width** (§Part 1), **full-page** (Playwright full-page scroll — also forces lazy assets to load, so below-the-fold issues surface). *(reuse `visual-match.js:158`)*
- **Freeze non-determinism before capture:** disable CSS animations/transitions, pause autoplaying media/carousels, wait for `networkidle` + a settle delay, and (optional) mask known dynamic regions (ads, live counters) so they don't produce false mismatches.
- Same capture pipeline for reference and current — identical viewport, identical settle — so the only variable is the site.

### 3.4 Overlay generation
- Align the candidate to the reference dimensions (candidate resized to ref W×H) and compare pixel-by-pixel; mark differing pixels on a copy → the **difference overlay** `__diff.png`. *(the mechanism already exists: `visual-match.js pixelDiff`, RGB-delta threshold >60 to ignore anti-aliasing/sub-pixel noise)*.
- The overlay is a **required** artifact for every page/section mismatch.

### 3.5 Highlighted differences
- Draw the **bounding box** of each changed element/region (from the structural read geometry) on the current screenshot → the **highlight region**. Colour by severity (FAIL red / WARNING amber).

### 3.6 Similarity calculation (defined, deterministic)
- **Pixel similarity** = `100 − (differingPixels ÷ totalPixels × 100)` at a fixed RGB-delta tolerance (>60 = changed), candidate aligned to reference size. *(matches `pixelDiff` today).*
- **Structural similarity** = matched-elements ÷ total-reference-elements, pairing by `section + tag + text|heading`.
- A unit's verdict: **PASS** ≥ 90 similarity & no structural loss · **WARNING** 75–90 or minor structural drift · **FAIL** < 75 or a component/element missing. (Thresholds match the SGB build rule ≥90 advance / <75 rebuild.)

### 3.7 Confidence reporting
- **Pixel diff = objective** (confidence 1.0).
- **Structural pairing** carries a pairing confidence (exact text match = high; fuzzy heading/section match = medium) so a "moved" verdict that rests on a weak pairing is visibly lower-confidence.
- Dynamic-region mismatches (unmasked carousels/ads) are auto-tagged **`Manual Verification Required`**, not FAIL.

---

## PART 4 — Global Components (expanded, first-class)

Site-wide UI is inventoried and compared **independently of any page** (a broken cookie banner or a
dropped chat widget is not a page issue). Advisory suite `global` (weight 0). `GLOB-001
global-component-missing` fires in comparison when a reference component is absent on the target.

### 4.1 Full catalog (all site-wide UI outside page content)
| Group | Components |
|---|---|
| **Global Layout** | Header · Sticky Header · Desktop Nav · Mobile Nav · Mega Menu · Announcement Bar · Notification Bar · Top Banner · Utility Bar · Footer · Sub-Footer |
| **Global Interactive / floating & persistent** | Cookie Banner · Consent/Privacy Banner · Newsletter Popup · Exit-Intent Popup · Age Verification · Login Modal · Search Overlay · Cart Drawer · Sidebar · Quick Contact · Floating CTA · Chat Widget · WhatsApp · Messenger · Phone Button · Email Button · Back-to-Top · Accessibility Widget · Language Switcher · Theme Toggle |
| **Global Commerce** | Mini Cart · Wishlist · Account Menu · Currency Selector · Region Selector · Shipping Banner |
| **Global Tracking** | Analytics (GA4) · Tag Manager (GTM) · Facebook Pixel · LinkedIn · TikTok · Consent Manager |
| **Global Assets** | Favicon · Web Manifest · App Icons · Fonts · Global CSS · Global JS |
| **Catch-all** | **Any floating or persistent interface** not above (rule: fixed/sticky-positioned + present on ≥N sampled pages ⇒ treat as global). |

### 4.2 SGEN-specific globals to include (evidence-backed)
- **Menu Builder navigation** — SGEN nav (incl. mega-menu, mobile menu) is driven by the **Menu Builder**, *not* inline `<nav>` HTML (`CLAUDE.md` hard-do-not; `cd-to-sg` agent rule e). The inventory must recognise Menu-Builder-rendered nav, not only raw `<nav>`.
- **Popups are their own surface** — SGEN popups (newsletter / exit-intent / age-gate / login modal / search overlay) are **built as separate surfaces, never page sections** (`sgen-cookbook/build-popup.md`). The Global Components inventory must treat them as **global surfaces**, inventoried once site-wide, not per-page content.
- **Announcement / notification bars & floating CTAs** appear in the migration manual checklist (`manual-checklist.js`) as site-wide behaviour — promote them from "manual behaviour note" to inventoried components.

### 4.3 Inventory + comparison semantics
- **Audit (Tool 1):** the inventory is an **informational presence catalog** — reuses existing signals (favicon SEO-014, analytics SEO-025/026, header/nav/footer FUNC-005) rather than duplicating them; adds the components those checks don't cover (chat, floating CTA, back-to-top, cookie banner, language/theme, commerce).
- **Comparison (Tool 2/3):** diff reference inventory vs target inventory → **`GLOB-001`** for each component present on reference but absent on target, plus a per-component visual comparison (the header/footer/announcement bar compared **once**, independent of page). Detection is deterministic (class/role/script-signature heuristics) with a **confidence** value (a chat-widget script signature = high; a "sticky header" inferred from class name = medium).

---

### 4.4 Additional first-class inventories — Assets · Forms · Behaviors
Per the inventory-driven core (`QA-ARCHITECTURE.md`), these are **independent inventories**, not
sub-types of Components. Each is enumerated once (per site) and diffed source↔target.

**Assets Inventory** — *the page/section/component can exist while the asset is missing; catch it independently.*
| Enumerates | Detection signal (deterministic) | Comparison / verdict |
|---|---|---|
| Images · background-images · logos · SVGs · favicons · fonts · videos · PDFs/downloads · OG images · manifest · app-icons | `<img src/srcset>`, inline/CSS `url()`, `<link rel=icon/manifest/apple-touch-icon>`, `@font-face`/font `<link>`, `<video>/<source>`, `<a href=*.pdf/.doc/.zip>`, `og:image`, `<image>`/`<use href>` in SVG | `ASSET-001 asset-missing` — a source asset (by normalized filename/role) has **no counterpart that loads (HTTP 200)** on target. Blocking when a **content asset** (hero/logo/linked document) is gone; advisory for decorative. Reuses broken-image (A11Y-007) + failed-request (CON-002) signals — does not re-detect them. |

**Forms Inventory** — *forms are too important to bury under Components.*
| Per form, track | Detection signal | Evidence / verdict |
|---|---|---|
| Type (contact/newsletter/quote/booking/search/login/registration/checkout) · Present · Fields (count+types) · Validation · Submission target · Success state · Error state · Integrations (email/CRM/webhook/reCAPTCHA) | `<form>` + input inventory; type inferred from action/field-names/context; `required`/`pattern` attrs (validation); `action`/`data-*`/embedded script (integration); success/error require **manual or a submission probe** | `FORM-001` structure (auto) + **`FORM-900` submission→delivery is `Manual Verification Required`** (code cannot certify a real email/CRM delivery — already the platform stance). Comparison: `FORM-002 form-missing` when a source form has no target counterpart; field-count drop = WARNING. |

**Behaviors Inventory** — *behaviors, not components: presence ≠ working.*
| Enumerates | Detection signal | Evidence / verdict |
|---|---|---|
| sticky header · accordion · tabs · carousel · modal · drawer · search overlay · video playback · dropdown · mega-menu · infinite scroll · pagination · lazy-load · back-to-top · cookie banner · theme switch · language switch | class/role/`data-*` signatures + known library markers; sticky/fixed from computed `position`; lazy-load from `loading=lazy`/IntersectionObserver | **Presence is auto-detected; *working* is `Manual Verification Required`** unless a render-time probe confirms it (e.g. accordion toggles, carousel advances). Comparison: `BEHAV-001 behavior-missing` when a source behavior has no target counterpart. All advisory (weight-0 `behavior` suite) except a **missing cookie/consent banner on a live EU-facing site**, which is blocking. |

Each ships as an advisory weight-0 registry suite (`asset`, `form` extension, `behavior`) — additive,
score-neutral, same freeze-safe pattern as Best Practices. Detection reuses existing signals; nothing is
re-detected.

---

## PART 5 — Final Critical Review (independent)

**Q: Any production-critical QA check still missing?**
Two, both already on the roadmap and neither is feature creep: (1) **source↔target completeness**
(the defining migration check — nothing detects silently-dropped pages/assets); (2) **SSL-cert
expiry in the migration gate on live** (reuse `qa-site` SEC-001..006). Everything else is present or
correctly advisory.

**Q: Is every automated finding backed by sufficient evidence?**
Structurally yes after Part 2 — ~60% of the evidence schema is already captured; the rest are field
promotions of data the engine already computes (`confidence`, `timestamp`, `boundingBox`,
`highlightRegion`, `component`, `cssPath`). The gap is **persistence + schema**, not detection.

**Q: Can a QA engineer reproduce every finding from the report alone?**
After the evidence package (Part 3), yes for visual/responsive (screenshot + overlay + selector +
viewport + coordinates + timestamp + reproduce command). Static findings already carry ruleId + page +
selector + the `sgen qa-site <url>` re-run line. **Requirement:** every finding must include the exact
re-run command + viewport so reproduction is one copy-paste.

**Q: Can a client understand why a migration passed or failed?**
After the three-value verdict (`PASS` / `PASS WITH MINOR ISSUES` / `FAIL`) + the per-viewport results
block + plain-language finding titles (registry titles are already customer-readable), yes. The verdict
names the **blocking** findings and the failing viewport(s) explicitly — no ambiguous language.

**Q: Is anything over-engineered?**
No net-new engine is proposed here — the spec is mostly *persist what's already computed* + *reuse
existing engines*. Risk to avoid: do **not** build a bespoke component-recognition ML/heuristic zoo —
component labelling should be a thin naming layer over the existing element read, not a new system.

**Q: Is anything duplicated?**
Guarded against: Global Components **reuses** favicon/analytics/landmark signals instead of re-checking
them; the evidence schema **extends** the finding object instead of a parallel store; viewports are a
**single** SGB-sourced profile (kills the current 3-vs-6 split). The one duplication to *remove* is the
migration render-pass's 3-viewport subset — fold it into the canonical 6.

**Q: Anything outside Migration QA scope?**
Keep out (advisory or separate Website Audit, per the certification standard): ongoing performance
optimisation, ranking/keyword analysis, uptime monitoring, full WCAG remediation beyond the axe
baseline. Migration QA stays a **one-shot cut-over gate**; the history/timeline platform owns "ongoing".

### Verdict
The specification is **complete and implementable without scope expansion**. It is dominated by
**reuse + persistence**, not new detection: one canonical viewport profile, an evidence schema that
extends the existing finding, a visual evidence package built from artifacts the engine already
produces, and inventories that reuse existing signals. The only genuinely new detection is the
**source↔target completeness diff** — already the approved P0. Nothing here is over-built, duplicated,
or out of scope.

---

## PART 6 — Final architecture review: inventory-driven, not page-driven

**Instruction (binding on implementation):** the engine must be **inventory-driven**. Every audit,
comparison, and certification operates on inventories (pages · sections · components · globals · assets ·
forms · behaviors) as the source of truth — one detection pass, many consumers.

**Where the engine is today (honest):** it is **page-first**. `audit.js` crawls pages and runs per-page
check functions; findings *are* already structured (`items[]` keyed by page · section · element), which
is **proto-inventory data** — but there is no explicit inventory abstraction, and detection logic is
spread across `checks-static` / `checks-render` / `best-practices` / `content-artifacts` / `spelling`.

**The refactor to inventory-driven (no rewrite of detection):**
1. **Introduce a Provider interface** — `enumerate(ctx) → items[]`, `diff(ref, tgt) → deltas[]`,
   `evidence(item) → package`. Reserve all seven providers now; implement per phase.
2. **One detection pass builds the inventories;** existing checks become **inventory consumers** (they
   already emit page/section/element-keyed findings — adapt, don't rewrite).
3. **Completeness, visual comparison, certification all diff inventory↔inventory** — a single diff
   contract, not seven bespoke comparisons.
4. **Evidence collection binds to inventory items,** so every finding's evidence package is produced the
   same way regardless of inventory type (uniform Part 2/3 schema).
5. **New inventory types (Ecommerce/LMS/Membership/Booking) = a new Provider,** never a core change.

**Why this matters (the three payoffs, confirmed):**
- **No duplicate detection logic** — each signal is detected once, in its provider, and consumed by
  audit + compare + certify (kills today's spread + the 3-vs-6 viewport split).
- **Consistent evidence** — one evidence contract per inventory item, not per check.
- **Extensible without redesign** — a new provider drops in behind the stable interface.

**Freeze-safety:** the Provider layer is **additive** — it wraps existing detectors; the frozen
registry/scoring/history contracts (ADR-0001) are untouched. New inventory suites (`asset`, `form`,
`behavior`, `global`) are advisory weight-0, score-neutral.

**Gate before implementation:** P0 (Completeness Engine) **must introduce the Provider interface +
Page/Asset inventories first**, so every later phase (globals, visual, evidence, verdict) builds on the
inventory abstraction rather than bolting onto page-first code. If P0 is built page-first, stop and
re-do it inventory-first — this is the one architectural decision that must not be deferred.

**Approved to implement in the P0→P4 order** once green-lit, inventory-first, with real executed proof
at each phase (no fakes, `Manual Verification Required` wherever evidence can't be collected).
