'use strict';
// registry.js — SGEN Site Auditor Rule Registry (Phase 1).
//
// The single source of truth. Every deterministic check the auditor performs is a RULE with a
// permanent ID. IDs never change and are never reused. Scoring, reporting, docs, analytics and the
// engine all derive from this registry — nothing hardcodes a deduction or a suite anywhere else.
//
// Fields (all required):
//   id            permanent, immutable  (e.g. "SEO-014")
//   slug          stable kebab-case handle
//   title         canonical finding title (MUST equal the string the check emits — the engine maps by it)
//   suite         exactly one of the 10 suites (one-check-one-suite is constitutional)
//   category      grouping within the suite (docs/UX only)
//   severity      critical | high | medium | low | manual   (classifies; does NOT set the score)
//   deduction     points off the suite's 100 when this rule fires (0 for manual)
//   method        static | render | network | cert | engine | manual
//   deterministic true for every rule here (constitutional)
//   manual        true = never affects score (Unknown, not Failed)
//   autofix       reserved for the future Autofix engine (all false today)
//   introduced    auditor version the rule first shipped in
//
// SEVERITY classifies the finding; DEDUCTION reflects real impact per Jerome's model. They are
// independent on purpose (a "high" TLS-expired hurts more than a "high" placeholder).

const REGISTRY_VERSION = '1.12.0'; // 1.12.0: +VIS-003 font-drift — the comparison lane's typography rule. font-checks.js has exported drift() since 1.11.0 with NOTHING calling it: it shipped dead in 3.0.0 and 3.0.1 while the UI advertised "font drift vs reference". Wired now by site-qa/visual-match.js (FONT_SWEEP once per PAGE PAIR, not per viewport — the same page-level reasoning that pins FONT-001..006 to one call per page in checks-render.js) and folded by visual-match/fold.js. It lands in 'visual' (Suite 12, WEIGHTS.visual=0) — NOT in a11y/typography beside FONT-001..006 — because a font that changed vs the reference is a COMPARISON fact, not a defect in the candidate: a redesign is supposed to change fonts, and scoring that against a11y (weight 14) would be a false blocker. Advisory, so overall scores stay byte-identical. // 1.11.0: +Typography & Icon Integrity (FONT-001..006, ICON-001..003) — first font coverage in the registry; all method:'render', emitted once per page by migration-qa/checks-render.js. FONT-003/006 (faux bold/italic) are a11y/typography, NOT best-practices: that suite is assembled by runBestPractices() from STATIC html DETECTORS, so a render-only rule there would emit a fake 'pass' (items.length?status:'pass') and is unreachable from the render pass (audit.js assembles 10 suites; 'best-practices' is not one of them). // 1.10.0: criteria re-prioritization (deploy false-concern fix, 2026-07-14): LINK-001 tier1->2 (HEAD-probe FP); +SEC-004/020/024/025 ->tier1 (real launch risks under-gated); relax FUNC-003/009,SEC-005,SEO-025,BP-004,VIS-001/002; cut RESP-003/004 deductions (overflow triple-count); RESP-001 kept tier1. // 1.6.0: +Interaction B1. 1.7.0: +Security B2. 1.8.0: +SEO B3. 1.9.0: +Stability B4 (DOM-003/004 dup-id/complexity, FORM-002 field-semantics, LINK-010 mailto/tel. Broken-markup/fonts deferred). // bump on ANY rule metadata change; every scan records this. 1.1.0: +SEO-029/030. 1.2.0: +Suite 11 Best Practices (advisory, weight 0 — provably score-neutral; WP-007). 1.2.1: +FUNC-008 content-artifacts. 1.3.0: +Suite 12 Visual Match (advisory, weight 0 — VIS-001/002; folded from qa-visual-match into the pipeline). 1.3.1: +FUNC-009 common-misspelling. 1.4.0: +CON-003 blocking-overlay (consent/age-gate dismissal, additive). 1.5.0: +tier field on every rule (launch-readiness; additive, scoring untouched).

// 10 SCORED suites + 1 ADVISORY suite (best-practices). Best Practices carries weight 0: it has its
// own sub-score for reporting, but contributes NOTHING to the SGEN Quality Score. This keeps every
// historical overall score byte-identical (proven by golden parity) — additive, not a scoring change.
const SUITES = ['functional', 'links', 'forms', 'responsive', 'a11y', 'seo', 'performance', 'security', 'crossbrowser', 'console', 'best-practices', 'visual'];
const SEVERITIES = ['critical', 'high', 'medium', 'low', 'manual'];
const METHODS = ['static', 'render', 'network', 'cert', 'engine', 'manual'];

// Suite category weights (scored suites sum = 100; best-practices = 0 advisory). Overall = Σ(suiteScore × weight)/Σweight.
const WEIGHTS = { functional: 18, links: 8, forms: 6, responsive: 8, a11y: 14, seo: 16, performance: 14, security: 10, crossbrowser: 3, console: 3, 'best-practices': 0, visual: 0 };

const V1 = '1.0';
// Launch-readiness tier (1.5.0, additive — scoring untouched):
//   1 = breaks the site / launch blocker · 2 = hurts users · 3 = polish · null = manual (unscored)
// Default maps from severity (critical→1, high/medium→2, low→3); rules whose real-world impact is
// "site is broken" regardless of severity label override with { tier: 1 } below.
const TIER_BY_SEVERITY = { critical: 1, high: 2, medium: 2, low: 3 };
const R = (id, slug, title, suite, category, severity, deduction, method, extra = {}) => ({
  id, slug, title, suite, category, severity, deduction, method,
  tier: severity === 'manual' ? null : TIER_BY_SEVERITY[severity],
  deterministic: true, manual: severity === 'manual', autofix: false, introduced: V1,
  docs: `/docs/rules/${id.toLowerCase()}`, ...extra,
});

const RULES = [
  // ---------------- FUNCTIONAL ----------------
  R('FUNC-001', 'page-status-server-error', 'Page returns server error', 'functional', 'availability', 'critical', 25, 'network'),
  R('FUNC-002', 'page-status-client-error', 'Page returns client error', 'functional', 'availability', 'critical', 18, 'network'),
  R('FUNC-003', 'page-status-redirect', 'Page in sitemap/nav redirects', 'functional', 'availability', 'medium', 4, 'network', { tier: 3 }),
  R('FUNC-004', 'placeholder-content', 'Placeholder / lorem text in visible copy', 'functional', 'content', 'high', 6, 'static'),
  R('FUNC-005', 'global-components', 'Global landmark(s) not detected', 'functional', 'components', 'low', 2, 'static'),
  R('FUNC-006', 'empty-code-block', 'Empty code block', 'functional', 'content', 'low', 2, 'static'),
  R('FUNC-007', 'empty-table', 'Empty/structureless table', 'functional', 'content', 'low', 2, 'static'),
  R('FUNC-008', 'content-artifacts', 'Loose symbols / unresolved tokens / mojibake in visible copy', 'functional', 'content', 'high', 6, 'static', { introduced: '1.2.1' }),
  R('FUNC-009', 'misspelling-common', 'Common misspelling / typo in visible copy', 'functional', 'content', 'medium', 3, 'static', { introduced: '1.3.1', tier: 3 }),
  R('FUNC-900', 'visual-design-intent', 'Visual design matches the intended design', 'functional', 'manual', 'manual', 0, 'manual'),

  // ---------------- LINKS & REDIRECTS ----------------
  R('LINK-001', 'broken-internal-link', 'Broken internal link(s)', 'links', 'integrity', 'high', 12, 'network', { tier: 2 }),
  R('LINK-002', 'broken-external-link', 'Broken external link(s)', 'links', 'integrity', 'medium', 4, 'network'),
  R('LINK-003', 'redirect-chain', 'Redirect chain(s) / loop(s)', 'links', 'integrity', 'high', 6, 'network'),
  R('LINK-004', 'soft-404', 'Soft 404 (unknown URL returns 200)', 'links', 'integrity', 'medium', 5, 'network'),
  R('LINK-005', 'anchor-target', 'In-page anchor links point to missing IDs', 'links', 'integrity', 'low', 2, 'static'),
  // ---- Interaction Integrity (Batch 1, V2 — all Verified; feed the interaction score via `interaction:true`) ----
  R('LINK-006', 'dead-link-empty', 'Dead link (empty href)', 'links', 'integrity', 'high', 8, 'static', { introduced: '2.0', interaction: true, inspector: 'seo', cost: 'cheap', evidenceQuality: 'verified', fixability: 'guided', impact: { seo: 'med', a11y: 'high', security: null, devEffort: 'low' } }),
  R('LINK-010', 'uri-malformed', 'Malformed mailto: / tel: link', 'links', 'integrity', 'low', 2, 'static', { introduced: '2.0', interaction: true, inspector: 'seo', cost: 'cheap', evidenceQuality: 'verified', fixability: 'guided', impact: { seo: 'low', a11y: 'med', security: null, devEffort: 'low' } }),
  R('LINK-007', 'dead-link-hash', 'Link goes nowhere (href="#")', 'links', 'integrity', 'medium', 4, 'static', { introduced: '2.0', interaction: true, inspector: 'seo', cost: 'cheap', evidenceQuality: 'verified', fixability: 'guided', impact: { seo: 'low', a11y: 'med', security: null, devEffort: 'low' } }),
  R('LINK-008', 'dead-link-jsvoid', 'Dead link (javascript: no-op)', 'links', 'integrity', 'medium', 4, 'static', { introduced: '2.0', interaction: true, inspector: 'seo', cost: 'cheap', evidenceQuality: 'verified', fixability: 'guided', impact: { seo: 'med', a11y: 'med', security: null, devEffort: 'low' } }),
  R('LINK-009', 'link-missing-href', 'Link has no href', 'links', 'integrity', 'medium', 4, 'static', { introduced: '2.0', interaction: true, inspector: 'seo', cost: 'cheap', evidenceQuality: 'verified', fixability: 'guided', impact: { seo: 'med', a11y: 'high', security: null, devEffort: 'low' } }),
  R('DOM-003', 'duplicate-id', 'Duplicate id attribute(s)', 'a11y', 'semantics', 'medium', 4, 'static', { introduced: '2.0', inspector: 'stability', cost: 'cheap', evidenceQuality: 'verified', fixability: 'guided', impact: { seo: null, a11y: 'high', security: null, devEffort: 'low' } }),
  R('DOM-004', 'dom-complexity', 'Excessive DOM size', 'performance', 'weight', 'low', 3, 'static', { introduced: '2.0', inspector: 'stability', cost: 'moderate', evidenceQuality: 'derived', fixability: 'manual', impact: { seo: null, a11y: null, security: null, devEffort: 'high' } }),
  R('DOM-010', 'dead-button-submit', 'Button submits nothing (type=submit outside form)', 'functional', 'components', 'medium', 4, 'static', { introduced: '2.0', interaction: true, inspector: 'stability', cost: 'cheap', evidenceQuality: 'verified', fixability: 'manual', impact: { seo: null, a11y: 'med', security: null, devEffort: 'med' } }),
  R('DOM-011', 'empty-onclick', 'Empty onclick handler', 'functional', 'components', 'low', 2, 'static', { introduced: '2.0', interaction: true, inspector: 'stability', cost: 'cheap', evidenceQuality: 'verified', fixability: 'manual', impact: { seo: null, a11y: 'low', security: null, devEffort: 'low' } }),
  R('DOM-012', 'nested-interactive', 'Nested interactive controls', 'a11y', 'semantics', 'medium', 4, 'static', { introduced: '2.0', interaction: true, inspector: 'stability', cost: 'cheap', evidenceQuality: 'verified', fixability: 'manual', impact: { seo: null, a11y: 'high', security: null, devEffort: 'med' } }),
  R('DOM-013', 'disabled-active', 'Disabled control presented as active', 'a11y', 'semantics', 'low', 2, 'static', { introduced: '2.0', interaction: true, inspector: 'stability', cost: 'cheap', evidenceQuality: 'verified', fixability: 'manual', impact: { seo: null, a11y: 'med', security: null, devEffort: 'low' } }),

  // ---------------- FORMS ----------------
  R('FORM-001', 'form-structure', 'Form structure issue', 'forms', 'structure', 'medium', 5, 'static'),
  R('FORM-002', 'form-field-semantics', 'Form field missing correct type / autocomplete', 'forms', 'structure', 'low', 2, 'static', { introduced: '2.0', inspector: 'stability', cost: 'cheap', evidenceQuality: 'verified', fixability: 'guided', impact: { seo: null, a11y: 'med', security: null, devEffort: 'low' } }),
  R('FORM-900', 'form-submission-delivery', 'Form submission → email / CRM delivery', 'forms', 'manual', 'manual', 0, 'manual'),

  // ---------------- RESPONSIVE ----------------
  R('RESP-001', 'viewport-meta', 'No <meta name="viewport">', 'responsive', 'meta', 'critical', 20, 'static'),
  R('RESP-002', 'horizontal-overflow', 'Page scrolls horizontally', 'responsive', 'overflow', 'high', 10, 'render'),
  R('RESP-003', 'overflow-element', 'Element bleeds past right edge', 'responsive', 'overflow', 'high', 6, 'render'),
  R('RESP-004', 'element-wider-than-viewport', 'Element wider than viewport', 'responsive', 'overflow', 'high', 5, 'render'),
  R('RESP-005', 'tap-target-small', 'Tap target < 44px', 'responsive', 'touch', 'medium', 4, 'render'),
  R('RESP-006', 'input-font-small', 'Input font < 16px', 'responsive', 'touch', 'low', 2, 'render'),
  R('RESP-900', 'multi-device-eyeball', 'Multi-device eyeball pass (Responsive Viewer)', 'responsive', 'manual', 'manual', 0, 'manual'),

  // ---------------- ACCESSIBILITY ----------------
  R('A11Y-001', 'axe-wcag', 'axe-core WCAG 2.1 A/AA violation', 'a11y', 'wcag', 'high', 12, 'render', { titleMatch: /axe|WCAG/i }),
  R('A11Y-002', 'low-contrast', 'Text below AA contrast', 'a11y', 'contrast', 'medium', 6, 'render'),
  R('A11Y-003', 'no-h1', 'No <h1> on page', 'a11y', 'headings', 'high', 6, 'static'),
  R('A11Y-004', 'multiple-h1', 'Multiple <h1> on page', 'a11y', 'headings', 'low', 2, 'static'),
  R('A11Y-005', 'heading-skip', 'Heading level skipped', 'a11y', 'headings', 'low', 2, 'static'),
  R('A11Y-006', 'img-missing-alt', 'Images missing alt text', 'a11y', 'images', 'medium', 6, 'static'),
  R('A11Y-007', 'img-missing-src', '<img> without a src', 'a11y', 'images', 'medium', 6, 'static'),
  R('A11Y-008', 'img-missing-dimensions', 'Images without width/height', 'a11y', 'images', 'low', 2, 'static'),
  R('A11Y-009', 'html-lang', '<html> missing lang attribute', 'a11y', 'semantics', 'low', 2, 'static'),

  // ---- Typography & Icon Integrity (1.11.0) — the registry's first font coverage ----
  // Cross-suite by real impact (the Batch-1 precedent: one contiguous block, rules land in the suite
  // that owns the consequence). a11y/typography = "text is painted with the wrong font"; performance/
  // delivery = "font delivery costs the visitor"; functional/components = "the UI lost its icons".
  //
  // All method:'render': every one of these is provable ONLY by a real paint (CSSOM @font-face status
  // + CDP CSS.getPlatformFontsForNode), never from markup. Emitted ONCE per page by
  // migration-qa/checks-render.js — they are viewport-independent, so a per-viewport call would
  // multiply every finding by the ~10-entry device matrix.
  //
  // NOTE on FONT-003/FONT-006: proposed as advisory 'best-practices'; that is structurally impossible
  // here and would have shipped a false green. See the REGISTRY_VERSION note above.
  R('FONT-001', 'font-not-loaded', 'Webfont failed to load — text silently falling back', 'a11y', 'typography', 'high', 12, 'render', { introduced: '1.11.0' }),
  R('FONT-002', 'font-undeclared', 'Font used but never declared', 'a11y', 'typography', 'medium', 6, 'render', { introduced: '1.11.0' }),
  R('FONT-003', 'synthetic-bold', 'Faux bold — requested weight never loaded', 'a11y', 'typography', 'low', 2, 'render', { introduced: '1.11.0' }),
  R('FONT-004', 'font-display-missing', 'font-display not set (FOIT risk)', 'performance', 'delivery', 'low', 3, 'render', { introduced: '1.11.0' }),
  R('FONT-005', 'font-preloaded-unused', 'Font preloaded but never used', 'performance', 'delivery', 'low', 2, 'render', { introduced: '1.11.0' }),
  R('FONT-006', 'synthetic-italic', 'Faux italic — no real italic face loaded', 'a11y', 'typography', 'low', 2, 'render', { introduced: '1.11.0' }),
  R('ICON-001', 'icon-font-not-loaded', 'Icon font failed to load — icons not rendering', 'functional', 'components', 'high', 10, 'render', { introduced: '1.11.0' }),
  R('ICON-002', 'icon-ligature-visible', 'Icon names rendering as literal words', 'functional', 'components', 'high', 10, 'render', { introduced: '1.11.0' }),
  R('ICON-003', 'icon-tofu', 'Icons rendering as tofu boxes', 'functional', 'components', 'high', 8, 'render', { introduced: '1.11.0' }),

  // ---------------- SEO ----------------
  R('SEO-001', 'title-missing', 'Missing <title>', 'seo', 'metadata', 'high', 10, 'static'),
  R('SEO-002', 'title-length', 'Title length outside 10–70 chars', 'seo', 'metadata', 'low', 2, 'static'),
  R('SEO-003', 'meta-description-missing', 'Missing meta description', 'seo', 'metadata', 'medium', 6, 'static'),
  R('SEO-004', 'meta-description-length', 'Meta description length outside 50–170', 'seo', 'metadata', 'low', 2, 'static'),
  R('SEO-005', 'canonical-missing', 'Missing canonical URL', 'seo', 'canonical', 'medium', 8, 'static'),
  R('SEO-006', 'canonical-offdomain', 'Canonical points off the production domain', 'seo', 'canonical', 'critical', 18, 'static'),
  R('SEO-007', 'indexability-noindex-live', 'Live page is set to NOINDEX', 'seo', 'indexability', 'critical', 22, 'static'),
  R('SEO-008', 'indexability-staging-indexable', 'Staging page is indexable', 'seo', 'indexability', 'medium', 5, 'static'),
  R('SEO-009', 'duplicate-title', 'Duplicate title across pages', 'seo', 'duplication', 'medium', 5, 'static'),
  R('SEO-010', 'duplicate-description', 'Duplicate description across pages', 'seo', 'duplication', 'medium', 4, 'static'),
  R('SEO-011', 'social-og-incomplete', 'Incomplete Open Graph tags', 'seo', 'social', 'medium', 4, 'static'),
  R('SEO-012', 'social-twitter-missing', 'Missing twitter:card', 'seo', 'social', 'low', 2, 'static'),
  R('SEO-013', 'ogimage-no-load', 'og:image does not load', 'seo', 'social', 'medium', 4, 'network'),
  R('SEO-014', 'favicon-missing', 'No favicon declared', 'seo', 'metadata', 'low', 1, 'static'),
  R('SEO-015', 'favicon-no-load', 'Favicon does not load', 'seo', 'metadata', 'low', 1, 'network'),
  R('SEO-016', 'schema-none', 'No JSON-LD structured data', 'seo', 'structured-data', 'low', 3, 'static'),
  R('SEO-017', 'schema-invalid', 'Invalid JSON-LD', 'seo', 'structured-data', 'medium', 3, 'static'),
  R('SEO-018', 'schema-no-type', 'JSON-LD item missing @type', 'seo', 'structured-data', 'low', 3, 'static'),
  R('SEO-019', 'schema-bad-context', 'JSON-LD @context is not schema.org', 'seo', 'structured-data', 'low', 3, 'static'),
  R('SEO-020', 'robots-blocks-site', 'robots.txt blocks the whole site on live', 'seo', 'crawlability', 'critical', 20, 'network'),
  R('SEO-021', 'robots-no-sitemap', 'robots.txt has no Sitemap: line', 'seo', 'crawlability', 'low', 2, 'network'),
  R('SEO-022', 'sitemap-missing', 'No XML sitemap found', 'seo', 'crawlability', 'medium', 6, 'network'),
  R('SEO-023', 'sitemap-dead-url', 'Dead URL(s) in sitemap', 'seo', 'crawlability', 'medium', 4, 'network'),
  R('SEO-024', 'orphan-page', 'Orphan page(s) (not in sitemap)', 'seo', 'crawlability', 'medium', 4, 'network'),
  R('SEO-025', 'analytics-missing', 'No analytics/tracking detected on live page', 'seo', 'analytics', 'medium', 3, 'static', { tier: 3 }),
  R('SEO-026', 'analytics-staging-present', 'Tracking present on staging — verify target', 'seo', 'analytics', 'low', 2, 'static'),
  R('SEO-027', 'mobile-web-metadata', 'Mobile web-app metadata missing', 'seo', 'mobile', 'low', 2, 'static'),
  R('SEO-028', 'privacy-signals', 'Privacy / cookie signals incomplete', 'seo', 'compliance', 'low', 2, 'static'),
  R('SEO-029', 'robots-missing', 'No robots.txt', 'seo', 'crawlability', 'medium', 4, 'network'),
  R('SEO-030', 'staging-leak', 'Staging/preview host referenced on live page', 'seo', 'indexability', 'critical', 20, 'static'),
  // ---- SEO Batch 3 (V2) — hreflang, indexability-signal conflicts (Verified) + thin content / readability (Derived) ----
  R('SEO-031', 'hreflang-invalid', 'hreflang is invalid or missing x-default', 'seo', 'international', 'medium', 4, 'static', { introduced: '2.0', inspector: 'seo', cost: 'cheap', evidenceQuality: 'verified', fixability: 'guided', impact: { seo: 'high', a11y: null, security: null, devEffort: 'low' } }),
  R('SEO-035', 'noindex-canonical-conflict', 'noindex combined with a cross-URL canonical (conflicting signals)', 'seo', 'indexability', 'medium', 5, 'static', { introduced: '2.0', inspector: 'seo', cost: 'cheap', evidenceQuality: 'verified', fixability: 'guided', impact: { seo: 'high', a11y: null, security: null, devEffort: 'low' } }),
  R('SEO-036', 'robots-signal-conflict', 'meta robots and X-Robots-Tag disagree', 'seo', 'indexability', 'medium', 5, 'static', { introduced: '2.0', inspector: 'seo', cost: 'cheap', evidenceQuality: 'verified', fixability: 'guided', impact: { seo: 'high', a11y: null, security: null, devEffort: 'low' } }),
  R('SEO-037', 'thin-content', 'Thin content (very low word count)', 'seo', 'content', 'low', 3, 'static', { introduced: '2.0', inspector: 'seo', cost: 'moderate', evidenceQuality: 'derived', fixability: 'manual', impact: { seo: 'med', a11y: null, security: null, devEffort: 'high' } }),
  R('SEO-038', 'readability-hard', 'Very hard to read (low Flesch reading ease)', 'seo', 'content', 'low', 2, 'static', { introduced: '2.0', inspector: 'seo', cost: 'moderate', evidenceQuality: 'derived', fixability: 'manual', impact: { seo: 'low', a11y: 'med', security: null, devEffort: 'med' } }),

  // ---------------- PERFORMANCE ----------------
  R('PERF-001', 'cwv-lcp', 'Largest Contentful Paint', 'performance', 'core-web-vitals', 'medium', 6, 'render', { titleMatch: /Largest Contentful Paint|LCP needs/i }),
  R('PERF-002', 'cwv-cls', 'Cumulative Layout Shift', 'performance', 'core-web-vitals', 'medium', 6, 'render', { titleMatch: /Cumulative Layout Shift|CLS needs/i }),
  R('PERF-003', 'image-perf-lazy', 'Little/no image lazy-loading', 'performance', 'assets', 'low', 2, 'static'),
  R('PERF-004', 'image-perf-modern', 'No WebP/AVIF images detected', 'performance', 'assets', 'low', 2, 'static'),
  R('PERF-005', 'render-blocking', 'Render-blocking resources in <head>', 'performance', 'delivery', 'low', 2, 'static'),
  R('PERF-006', 'page-weight', 'Heavy page (many requests / large transfer)', 'performance', 'weight', 'medium', 5, 'render'),
  R('PERF-007', 'compression', 'HTML served without compression', 'performance', 'delivery', 'low', 2, 'static'),

  // ---------------- SECURITY ----------------
  R('SEC-001', 'tls-expired', 'TLS certificate has expired', 'security', 'tls', 'high', 18, 'cert', { tier: 1 }),
  R('SEC-002', 'tls-handshake-failed', 'TLS handshake failed', 'security', 'tls', 'high', 18, 'cert', { tier: 1 }),
  R('SEC-003', 'tls-untrusted', 'TLS certificate not fully trusted', 'security', 'tls', 'medium', 8, 'cert'),
  R('SEC-004', 'tls-host-mismatch', 'TLS certificate hostname mismatch', 'security', 'tls', 'medium', 15, 'cert', { tier: 1 }),
  R('SEC-005', 'tls-expiring', 'TLS certificate expiring soon', 'security', 'tls', 'medium', 3, 'cert', { tier: 3 }),
  R('SEC-006', 'tls-protocol', 'Outdated TLS protocol', 'security', 'tls', 'medium', 8, 'cert'),
  R('SEC-007', 'https-not-origin', 'Origin is not HTTPS', 'security', 'transport', 'high', 14, 'network', { tier: 1 }),
  R('SEC-008', 'https-not-enforced', 'HTTP not redirected to HTTPS', 'security', 'transport', 'high', 14, 'network'),
  R('SEC-009', 'mixed-content', 'Mixed content (http on https page)', 'security', 'transport', 'high', 12, 'static'),
  R('SEC-010', 'security-headers', 'Security headers missing', 'security', 'headers', 'medium', 6, 'static', { deprecatedIn: '2.0' }), // qa-migration roll-up; qa-site emits the granular SEC-011..015 below
  // ---- Security Batch 2 (V2) — header split + cookies + exposure + dangerous JS (Verified except SEC-023) ----
  R('SEC-011', 'header-csp', 'Content-Security-Policy header missing', 'security', 'headers', 'medium', 4, 'static', { introduced: '2.0', inspector: 'security', cost: 'cheap', evidenceQuality: 'verified', fixability: 'guided', impact: { seo: null, a11y: null, security: 'high', devEffort: 'med' } }),
  R('SEC-012', 'header-xfo', 'X-Frame-Options / frame-ancestors missing (clickjacking)', 'security', 'headers', 'medium', 3, 'static', { introduced: '2.0', inspector: 'security', cost: 'cheap', evidenceQuality: 'verified', fixability: 'guided', impact: { seo: null, a11y: null, security: 'high', devEffort: 'low' } }),
  R('SEC-013', 'header-referrer', 'Referrer-Policy header missing', 'security', 'headers', 'low', 2, 'static', { introduced: '2.0', inspector: 'security', cost: 'cheap', evidenceQuality: 'verified', fixability: 'guided', impact: { seo: null, a11y: null, security: 'med', devEffort: 'low' } }),
  R('SEC-014', 'header-permissions', 'Permissions-Policy header missing', 'security', 'headers', 'low', 2, 'static', { introduced: '2.0', inspector: 'security', cost: 'cheap', evidenceQuality: 'verified', fixability: 'guided', impact: { seo: null, a11y: null, security: 'med', devEffort: 'low' } }),
  R('SEC-015', 'header-nosniff', 'X-Content-Type-Options: nosniff missing', 'security', 'headers', 'low', 3, 'static', { introduced: '2.0', inspector: 'security', cost: 'cheap', evidenceQuality: 'verified', fixability: 'guided', impact: { seo: null, a11y: null, security: 'med', devEffort: 'low' } }),
  R('SEC-016', 'cookie-secure', 'Cookie missing Secure flag', 'security', 'cookies', 'medium', 4, 'static', { introduced: '2.0', inspector: 'security', cost: 'cheap', evidenceQuality: 'verified', fixability: 'guided', impact: { seo: null, a11y: null, security: 'high', devEffort: 'low' } }),
  R('SEC-017', 'cookie-httponly', 'Cookie missing HttpOnly flag', 'security', 'cookies', 'medium', 4, 'static', { introduced: '2.0', inspector: 'security', cost: 'cheap', evidenceQuality: 'verified', fixability: 'guided', impact: { seo: null, a11y: null, security: 'high', devEffort: 'low' } }),
  R('SEC-018', 'cookie-samesite', 'Cookie missing/weak SameSite', 'security', 'cookies', 'low', 2, 'static', { introduced: '2.0', inspector: 'security', cost: 'cheap', evidenceQuality: 'verified', fixability: 'guided', impact: { seo: null, a11y: null, security: 'med', devEffort: 'low' } }),
  R('SEC-019', 'git-exposed', '.git directory exposed', 'security', 'exposure', 'critical', 20, 'network', { introduced: '2.0', inspector: 'security', cost: 'moderate', evidenceQuality: 'verified', fixability: 'manual', impact: { seo: null, a11y: null, security: 'high', devEffort: 'low' } }),
  R('SEC-020', 'backup-exposed', 'Backup / archive file exposed', 'security', 'exposure', 'high', 15, 'network', { tier: 1, introduced: '2.0', inspector: 'security', cost: 'moderate', evidenceQuality: 'verified', fixability: 'manual', impact: { seo: null, a11y: null, security: 'high', devEffort: 'low' } }),
  R('SEC-021', 'config-exposed', 'Configuration file exposed', 'security', 'exposure', 'critical', 20, 'network', { introduced: '2.0', inspector: 'security', cost: 'moderate', evidenceQuality: 'verified', fixability: 'manual', impact: { seo: null, a11y: null, security: 'high', devEffort: 'low' } }),
  R('SEC-022', 'dir-listing', 'Directory listing enabled', 'security', 'exposure', 'medium', 6, 'network', { introduced: '2.0', inspector: 'security', cost: 'moderate', evidenceQuality: 'verified', fixability: 'manual', impact: { seo: null, a11y: null, security: 'med', devEffort: 'low' } }),
  R('SEC-023', 'dangerous-js', 'Dangerous JavaScript pattern (eval / document.write / innerHTML)', 'security', 'content', 'low', 3, 'static', { introduced: '2.0', inspector: 'security', cost: 'moderate', evidenceQuality: 'heuristic', fixability: 'manual', impact: { seo: null, a11y: null, security: 'med', devEffort: 'med' } }),
  R('SEC-024', 'password-over-http', 'Password field served over HTTP', 'security', 'transport', 'high', 16, 'static', { tier: 1, introduced: '2.0', inspector: 'security', cost: 'cheap', evidenceQuality: 'verified', fixability: 'manual', impact: { seo: null, a11y: null, security: 'high', devEffort: 'med' } }),
  R('SEC-025', 'login-form-get', 'Login form uses method=GET (credentials in URL)', 'security', 'transport', 'high', 15, 'static', { tier: 1, introduced: '2.0', inspector: 'security', cost: 'cheap', evidenceQuality: 'verified', fixability: 'manual', impact: { seo: null, a11y: null, security: 'high', devEffort: 'low' } }),

  // ---------------- CROSS-BROWSER ----------------
  R('XBR-001', 'firefox-fail', 'Firefox failed to load the page', 'crossbrowser', 'render', 'high', 12, 'engine', { titleMatch: /Firefox failed to load/i, tier: 1 }),
  R('XBR-002', 'webkit-fail', 'WebKit (Safari engine) failed to load the page', 'crossbrowser', 'render', 'high', 12, 'engine', { titleMatch: /WebKit.*failed to load/i, tier: 1 }),
  R('XBR-003', 'engine-console-errors', 'Cross-browser console error(s)', 'crossbrowser', 'render', 'medium', 4, 'engine', { titleMatch: /(Firefox|WebKit).*console error/i }),

  // ---------------- CONSOLE & NETWORK ----------------
  R('CON-001', 'console-errors', 'JavaScript / console errors', 'console', 'runtime', 'high', 10, 'render'),
  R('CON-002', 'failed-requests', 'Failed / broken asset requests', 'console', 'network', 'high', 8, 'render'),
  R('CON-003', 'blocking-overlay', 'Page blocked by overlay the audit could not dismiss', 'console', 'runtime', 'medium', 4, 'render', { introduced: '1.4.0' }),

  // ---------------- BEST PRACTICES (Suite 11 — ADVISORY, weight 0; own sub-score, no overall impact) ----------------
  // Deterministic, static, non-overlapping with the 10 scored suites. Deductions shape the advisory
  // sub-score only. `introduced` = 1.2 (first shipped after the Architecture Freeze, additive).
  R('BP-001', 'doctype-missing', 'No <!DOCTYPE html> (quirks-mode risk)', 'best-practices', 'standards', 'medium', 5, 'static', { introduced: '1.2' }),
  R('BP-002', 'charset-missing', 'No character encoding declared', 'best-practices', 'standards', 'low', 3, 'static', { introduced: '1.2' }),
  R('BP-003', 'deprecated-html-tags', 'Deprecated HTML tag(s) in markup', 'best-practices', 'standards', 'low', 3, 'static', { introduced: '1.2' }),
  R('BP-004', 'target-blank-no-rel', 'target="_blank" without rel="noopener"', 'best-practices', 'safety', 'medium', 2, 'static', { introduced: '1.2', tier: 3 }),
  R('BP-005', 'generic-link-text', 'Non-descriptive link text ("click here")', 'best-practices', 'clarity', 'low', 2, 'static', { introduced: '1.2' }),
  R('BP-006', 'meta-generator-exposed', 'Platform/version exposed via <meta generator>', 'best-practices', 'hygiene', 'low', 2, 'static', { introduced: '1.2' }),
  R('BP-007', 'inline-event-handlers', 'Inline on*="" event handler(s)', 'best-practices', 'hygiene', 'low', 2, 'static', { introduced: '1.2' }),
  R('BP-008', 'legacy-doctype', 'Legacy/quirks DOCTYPE (not HTML5)', 'best-practices', 'standards', 'low', 2, 'static', { introduced: '1.2' }),

  // ---------------- VISUAL MATCH (Suite 12 — ADVISORY, weight 0; live vs staging, own sub-score) ----------------
  R('VIS-001', 'visual-mismatch', 'Visual mismatch vs reference exceeds threshold', 'visual', 'match', 'medium', 4, 'render', { introduced: '1.3', tier: 3 }),
  R('VIS-002', 'unmatched-page', 'Reference page has no match on the candidate site', 'visual', 'coverage', 'medium', 3, 'render', { introduced: '1.3', tier: 3 }),
  // VIS-003 (1.12.0) — the comparison-lane counterpart to FONT-001..006. Those ask "did the CANDIDATE's
  // own fonts break?"; this asks "did the candidate stop using a typeface the REFERENCE renders?". A
  // genuinely different claim from structDelta's per-element `restyled` font X→Y: that only fires on
  // elements that PAIRED (same landmark + tag + text), so a whole-site typeface loss slips through it
  // whenever the copy also changed. This is set-based and page-level: family used on the reference,
  // used NOWHERE on the candidate.
  R('VIS-003', 'font-drift', 'Font changed vs the reference site', 'visual', 'typography', 'medium', 3, 'render', { introduced: '1.12.0', tier: 3 }),
];

// ---- runtime validation: fail fast, never run on an invalid registry (Phase 2 item 8) ----
const ID_RE = /^[A-Z0-9]+-\d{3}$/;
const byId = new Map();
const bySlug = new Map();
function validate() {
  for (const r of RULES) {
    if (!ID_RE.test(r.id)) throw new Error(`registry: bad id format ${r.id} (want SUITE-NNN)`);
    if (byId.has(r.id)) throw new Error(`registry: duplicate rule id ${r.id}`);
    if (bySlug.has(r.slug)) throw new Error(`registry: duplicate slug ${r.slug}`);
    if (!r.slug || !/^[a-z0-9-]+$/.test(r.slug)) throw new Error(`registry: ${r.id} bad slug "${r.slug}"`);
    if (!r.title) throw new Error(`registry: ${r.id} missing title`);
    if (!SUITES.includes(r.suite)) throw new Error(`registry: ${r.id} unknown suite ${r.suite}`);
    if (!SEVERITIES.includes(r.severity)) throw new Error(`registry: ${r.id} invalid severity ${r.severity}`);
    if (!METHODS.includes(r.method)) throw new Error(`registry: ${r.id} invalid method ${r.method}`);
    if (typeof r.deduction !== 'number' || r.deduction < 0 || r.deduction > 100) throw new Error(`registry: ${r.id} invalid deduction ${r.deduction}`);
    if (r.deterministic !== true) throw new Error(`registry: ${r.id} must be deterministic`);
    if ((r.severity === 'manual') !== r.manual) throw new Error(`registry: ${r.id} manual flag must match severity`);
    if (r.manual && r.deduction !== 0) throw new Error(`registry: manual rule ${r.id} must have deduction 0`);
    if (!r.manual && r.deduction === 0) throw new Error(`registry: non-manual rule ${r.id} must deduct > 0`);
    if (typeof r.docs !== 'string' || !r.docs.startsWith('/docs/rules/')) throw new Error(`registry: ${r.id} bad docs path`);
    if (!r.category) throw new Error(`registry: ${r.id} missing category`);
    byId.set(r.id, r); bySlug.set(r.slug, r);
  }
  const wsum = SUITES.reduce((a, s) => a + (WEIGHTS[s] || 0), 0);
  if (wsum !== 100) throw new Error(`registry: suite weights must total 100 (got ${wsum})`);
  for (const s of SUITES) if (!RULES.some(r => r.suite === s)) throw new Error(`registry: suite ${s} has no rules`);
}
validate();

// ---- rule lookup service (Phase 2 item 7) — the ONLY place rule queries live ----
function getById(id) { return byId.get(id) || null; }
function getBySlug(slug) { return bySlug.get(slug) || null; }
function bySuite(suite) { return RULES.filter(r => r.suite === suite); }
function getRules() { return RULES.slice(); }
function getManualRules() { return RULES.filter(r => r.manual); }
function getDeterministicRules() { return RULES.filter(r => r.deterministic); }
function getRulesByMethod(m) { return RULES.filter(r => r.method === m); }
function getRulesBySeverity(sev) { return RULES.filter(r => r.severity === sev); }
function getRulesByCategory(c) { return RULES.filter(r => r.category === c); }
function getSuiteOf(id) { const r = byId.get(id); return r ? r.suite : null; }

module.exports = {
  REGISTRY_VERSION, RULES, SUITES, SEVERITIES, METHODS, WEIGHTS,
  getById, getBySlug, bySuite, getSuiteOf,
  getRules, getManualRules, getDeterministicRules, getRulesByMethod, getRulesBySeverity, getRulesByCategory,
};
