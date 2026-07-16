# SGEN QA — Three-Tool Architecture

> Three **independent** tools that compose into workflows. Each is focused and reusable. Deterministic,
> no AI. This is the governing design; build-status is honest (✅ built · 🟡 partial · ○ planned).
> Aligns with `CAPABILITIES.md` (engine) + `migration-qa/MIGRATION-QA-CERTIFICATION.md` (gate spec).

## The separation (and why)
| Tool | Question it answers | Compares sites? | Assumes migration? |
|---|---|---|---|
| **1 · Site Audit** | Is *this* site healthy + production-ready? | **No** | No |
| **2 · Visual Comparison** | Do *two* sites match (visually/structurally)? | **Yes** | **No** (live→staging, prod→prod, ref→dev, competitor→ref) |
| **3 · Migration Certification** | Can this migration be safely deployed + does it faithfully represent the source? | Consumes 1 + 2 | **Yes** |

A user who just wants to audit a live site uses Tool 1. A QA/designer comparing staging to live uses
Tool 2. A migration project composes both in Tool 3 and adds source→target completeness + a deploy verdict.

---

## Tool 1 · Site Audit  — *audit only, never compares*
**Purpose:** health + production-readiness of a site or selected pages.

**Input / scan modes:** ○ Single Page · ○ Selected Pages · ○ Entire Sitemap · ○ Crawl Website.
- Sitemap present → Discover Sitemap → **show pages → tickbox select** (Home/About/Services/Blog/Contact) → run on selected.
- No sitemap → crawl from homepage → show discovered URLs → manual selection.

**Engine (built):** `audit.js` (10 scored suites, 95 registry rules) + `crawl.js` (sitemap+index+link-follow) + `checks-static.js`/`checks-render.js` + advisory passes (Best Practices, FUNC-008 content-artifacts, FUNC-009 spelling) → `pipeline.js` (persist · finding lifecycle · timeline · regression gate) → `report.js`.
**CLI:** `sgen qa-site <url>` · `sgen qa-full <url>` (full pipeline) · `sgen qa-serve` (web UI, 127.0.0.1:7878).
**Output:** SGEN Quality Score (0–100) + per-finding drill-down + immutable history.

| Scan mode | Status |
|---|---|
| Entire sitemap / crawl | ✅ built (`crawl.js`, `--max-pages`) |
| Single page | ✅ built (`--max-pages 1`) |
| **Selected-pages tickbox UI** | 🟡 UI mock built (scan-config artifact); not wired to a selection→scan run |

---

## Tool 2 · Visual Comparison  — *two sites, no migration assumption*
**Purpose:** compare a **Reference** site against a **Target** site. Never assumes one is a migration.

**Inputs:** Reference URL → Target URL (e.g. `oldsite.com` → `new-staging-host`).
**Scope:** Entire Site · Selected Pages · Single Page.
**Comparison level:** Entire Page · **Sections** · **Components** · **Elements** — reported PASS / WARNING / FAIL per unit (e.g. Home → Hero PASS · Testimonials WARNING · Footer PASS; Primary CTA PASS · Pricing Card FAIL; Heading PASS · SVG FAIL · Spacing WARNING).

**Engine (built):** `visual-match.js` — crawl both, pair by path, at 6 SG-Builder breakpoints (1920/1199/991/767/575/480) capture full-page screenshot + **per-element structural read (section→element geometry + computed styles)** + **pixel mismatch % (sharp)** + structural deltas (missing/extra/moved/restyled), plus a page-level **font drift** read (a family the reference renders that the candidate never uses). Folded into the pipeline as advisory suite `visual` (VIS-001/002/003).
**Comparison mode (R 1.12.0):** `like-for-like` (default) | `redesign`. The pixel pass answers "same pixels?", which is only a question worth asking on a like-for-like replatform — on a redesign the sites are *supposed* to differ, so `redesign` **skips** it entirely (`pixelMismatchPct: null`, no diff overlays) and `matchScore` falls back to the structural score alone. Structural deltas and font drift report in both modes. The mode is recorded in the result JSON (`mode` / `pixelPass`), and `fold.js` re-gates on it independently of the engine.
**CLI:** `sgen qa-visual-match <ref> <cand> [--mode like-for-like|redesign]` · `sgen qa-full <target> --compare <ref>`.
**Verified live 2026-07-08** (example.com vs example.org, 100% match).

| Comparison level | Status |
|---|---|
| Entire page (pixel + page match score) | ✅ built |
| Section (section→heading grouping) | ✅ built (structural read groups by landmark+heading) |
| Element (per-element geometry/style delta) | ✅ built (the structural read *is* element-level) |
| **Component-level** (named components: CTA / Pricing Card / Accordion) | 🟡 partial — elements are read, but not yet *labelled as named components* |
| PASS/WARNING/FAIL per unit rollup UI | 🟡 data exists; the tri-state per-unit table is a reporting add |

---

## Tool 3 · Migration Certification  — *consumes 1 + 2, adds completeness + verdict*
**Purpose:** the deploy decision. Does **not** crawl itself unless necessary — it composes the other two.

**Workflow:** Source Site → **Inventory** → Migrated Site → **Inventory** → **Visual Comparison (Tool 2)** → **Production Audit (Tool 1)** → **Certification**.

**Engine (built + gaps):** `qa-migration` (env-aware production audit + redirect preservation + manual sign-off) is the Tool-1-for-migration half. **Missing the source→target Inventory + completeness diff** (the P0 gap from the certification standard) and a **three-value verdict** (`PASS` / `PASS WITH MINOR ISSUES` / `FAIL`).
**CLI:** `sgen qa-migration <url> [--env] [--redirects]` (production-audit half built).

| Certification stage | Status |
|---|---|
| Production audit (health on the migrated site) | ✅ built (`qa-migration`) |
| Redirect preservation (old URLs 301/410) | ✅ built (`--redirects`) |
| Visual comparison vs source | 🟡 engine built (Tool 2); not yet wired into `qa-migration` |
| **Source↔target inventory + completeness diff** | ○ **planned (P0)** — the defining migration check |
| **Three-value certification verdict** | ○ planned (P1) |
| Manual sign-off checklist | ✅ built |

---

## Global Components — a first-class concept (the underrepresented area)
**Not everything belongs to a page.** Headers, footers, announcement bars, cookie banners, floating
CTAs, chat widgets, sticky nav, tracking, global assets appear **site-wide** and must be **inventoried,
validated, and compared independently of page content** — otherwise site-wide regressions hide (a
broken cookie banner or a dropped chat widget isn't tied to one page).

**Global Components Inventory** (new primitive — `global-components/`): detects, per site, which of the
following are present, producing a structured catalog that Tool 1 displays, Tool 2 compares
independently, and Tool 3 diffs source↔target.

| Group | Components inventoried |
|---|---|
| **Global Layout** | Header · Desktop Nav · Mobile Nav · Mega Menu · Sticky Header · Announcement Bar · Notification Bar · Top Banner · Utility Bar · Footer · Sub-Footer |
| **Global Interactive** | Cookie/Privacy Banner · Newsletter Popup · Exit-Intent · Age Verification · Login Modal · Search Overlay · Cart Drawer · Sidebar · Quick Contact · Floating CTA · Chat Widget · WhatsApp · Messenger · Phone · Email · Back-to-Top · Accessibility Widget · Language Switcher · Theme Toggle |
| **Global Commerce** | Mini Cart · Wishlist · Account Menu · Currency Selector · Region Selector · Shipping Banner |
| **Global Tracking** | Analytics (GA4) · Tag Manager (GTM) · Facebook Pixel · LinkedIn · TikTok · Consent Manager |
| **Global Assets** | Favicon · Web Manifest · App Icons · Fonts · Global CSS · Global JS |

**Rule:** advisory suite `global` (weight 0 — never perturbs the SGEN Quality Score). `GLOB-001
global-component-missing` fires in *comparison* when a component present on the reference is absent on
the target. In *audit* mode the inventory is informational (presence catalog), reusing existing signals
where they already exist (favicon SEO-014, analytics SEO-025/026) instead of duplicating them.

---

## Comparison modes (explicit, exposed to the user)
Tool 2 / Tool 3 expose the comparison axis explicitly:
`Page Layout · Section Layout · Component Layout · Element Layout · Content · Assets · Interactive
Behaviour · Responsive Behaviour · Accessibility · SEO · Performance`.
Built today: Page/Section/Element layout + Content + Assets + Responsive (via visual-match structural
read + pixel diff). **Component-labelling, Interactive-behaviour, and per-axis A11y/SEO/Perf comparison
are planned reporting layers** over the existing per-element data.

---

## Composed workflow (what the user sees)
```
Site Audit           →  Production Health     (Tool 1)
Visual Comparison    →  Visual Accuracy       (Tool 2)
Migration Certification → Production Acceptance (Tool 3 = 1 + 2 + completeness + verdict)
```
Each tool stands alone; Tool 3 only *composes*. Global Components run across all three, independent of
any single page.

## Inventory-Driven Core (governing model)
**Principle (binding): the engine is inventory-driven, not page-driven.** Every audit, comparison, and
certification operates on **inventories** as the single source of truth. One detection pass builds the
inventories; audit/compare/certify consume them. This removes duplicate detection logic, makes evidence
collection uniform, and lets new inventory types be added **without redesigning the core engine**.

### The seven inventories (first-class, independent)
| Inventory | What it enumerates | Why independent |
|---|---|---|
| **Pages** | every URL (sitemap + crawl) | the spine |
| **Sections** | landmark+heading regions per page | a section can vanish while the page survives |
| **Components** | named reusable units (CTA, pricing card, accordion) | a component can break while the section survives |
| **Global Components** | site-wide UI (header/footer/nav/announcement/popup/floating/…) | not owned by any page |
| **Assets** | images · SVGs · favicons · fonts · video · PDFs/downloads · background images · logos · OG images · manifest · app icons | **the page/section/component can exist but the image is missing** — must be caught independently |
| **Forms** | contact · newsletter · quote · booking · search · login · registration · checkout | too important to bury under Components — each carries present · fields · validation · submission · success · error · integrations |
| **Behaviors** | sticky header · accordion · tabs · carousel · modal · drawer · search overlay · video playback · dropdown · mega-menu · infinite scroll · pagination · lazy-load · back-to-top · cookie banner · theme switch · language switch | these are **behaviors, not components** — presence ≠ working |

Completeness, visual comparison, and certification all diff **inventory ↔ inventory** (source vs target),
so "page exists but its hero image is gone" or "the contact form lost its success state" is caught
*independently* of whether the page rendered.

### Inventory Providers (reserved extension points — not implemented now)
Each inventory is produced by a **Provider** behind a stable interface (`enumerate(ctx) → items[]`,
`diff(ref, tgt) → deltas[]`, `evidence(item) → package`). Reserved providers:
`PageProvider · SectionProvider · ComponentProvider · GlobalProvider · AssetProvider · FormProvider ·
BehaviorProvider`. When SGEN later adds **Ecommerce / LMS / Membership / Booking**, a new provider
(e.g. `CommerceProvider`, `CourseProvider`) plugs in — the audit/compare/certify engines are untouched.
*Reserve the seam now; build providers as each inventory ships.*

## Build order (revised per Jerome, 2026-07-08 — freeze-safe, additive)
The verdict consumes everything, so it is **last**. Completeness owns the inventory, so it is **first**.

| Phase | Deliverable | Why this order |
|---|---|---|
| **P0** | **Completeness Engine** (source↔target inventory diff) | The defining capability of Migration QA. Without it everything else grades an *incomplete* migration. Establishes the inventory abstraction the rest consume. |
| **P1** | **Global Components + Assets + Forms + Behaviors inventories** | The completeness engine must already know headers/footers/popups/notification-bars/floating-buttons/cookie-banners/sticky-nav **and** assets/forms/behaviors — they are part of the migration inventory, not an afterthought. |
| **P2** | **Visual Comparison integration** | Now the comparison engine already knows pages · sections · components · globals · assets — producing much cleaner, inventory-aligned comparisons. |
| **P3** | **Evidence Persistence** | Now every comparison can store before · after · overlay · bounding-box · viewport · timestamp per inventory item, uniformly. |
| **P4** | **Three-state Verdict** (`PASS` / `PASS WITH MINOR ISSUES` / `FAIL`) | **Last** — the verdict *consumes* completeness + inventories + visual + evidence. |

Reporting layers (selection-tickbox UI → scan run, component-labelling, tri-state per-unit rollup)
ride on top of the inventories once they exist.
