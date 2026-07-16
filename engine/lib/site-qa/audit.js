'use strict';
// site-qa/audit.js — the real, deterministic "does the site work + pass" auditor.
//
// Reuses the proven migration-QA primitives (crawl / static checks / Playwright render), but
// re-organizes results into the 9 QA suites the tester UI shows, and adds a link audit + form
// audit. NO AI at runtime — pure Node + Playwright. Every row is REAL observed evidence, or it is
// explicitly status:'manual' (needs a human / needs credentials) — the tool never fakes a green.

const http = require('../migration-qa/http');
const { discoverPages, extractLinks } = require('../migration-qa/crawl');
const { STATIC_CHECKS, buildCtx } = require('../migration-qa/checks-static');
const { renderPass, VIEWPORTS } = require('../migration-qa/checks-render');
const { tlsCheck } = require('./tls-check');
const { crossBrowser } = require('./cross-browser');
const { compute: computeQuality } = require('./score');
const { compute: computeReadiness } = require('./readiness');
const { projectFindings } = require('./lib/report-contract');
const { computeLenses } = require('./lib/lenses');
const { interactionCheck } = require('./lib/checks-interaction');
const { securityPageChecks, securitySiteProbes } = require('./lib/checks-security');
const { seoPageChecks } = require('./lib/checks-seo');
const { stabilityPageChecks } = require('./lib/checks-stability');
const { enrichSuites } = require('./finding');
const { createBus } = require('./events');
const VERSIONS = require('./version');

// ---- suites (order + presentation) ----
const SUITES = [
  { key: 'functional', name: 'Functional', desc: 'pages load · content · components', icon: 'cursor' },
  { key: 'links', name: 'Links & Redirects', desc: 'internal links · redirects · no dead ends', icon: 'link' },
  { key: 'forms', name: 'Forms', desc: 'structure · labels · submission', icon: 'form' },
  { key: 'responsive', name: 'Responsive', desc: 'mobile · tablet · desktop · no overflow', icon: 'device' },
  { key: 'a11y', name: 'Accessibility', desc: 'alt · labels · contrast · headings', icon: 'a11y' },
  { key: 'seo', name: 'SEO', desc: 'titles · meta · canonical · sitemap · schema', icon: 'search' },
  { key: 'performance', name: 'Performance', desc: 'Core Web Vitals · assets · caching', icon: 'gauge' },
  { key: 'security', name: 'Security', desc: 'HTTPS · TLS cert · headers · mixed content', icon: 'shield' },
  { key: 'crossbrowser', name: 'Cross-Browser', desc: 'Firefox · WebKit (Safari engine)', icon: 'browsers' },
  { key: 'console', name: 'Console & Network', desc: 'JS errors · failed requests', icon: 'terminal' },
];

const STATIC_SUITE = {
  'page-status': 'functional', 'placeholder-content': 'functional', 'global-components': 'functional', 'broken-rich-content': 'functional',
  'viewport-meta': 'responsive',
  'title': 'seo', 'meta-description': 'seo', 'canonical': 'seo', 'indexability': 'seo', 'social-meta': 'seo', 'favicon': 'seo',
  'schema': 'seo', 'duplicate-title': 'seo', 'duplicate-description': 'seo', 'robots-txt': 'seo', 'sitemap': 'seo', 'analytics': 'seo',
  'headings': 'a11y', 'html-lang': 'a11y', 'images': 'a11y',
  'image-perf': 'performance', 'compression': 'performance',
  'mixed-content': 'security', 'security-headers': 'security', 'https-enforce': 'security',
  '404-config': 'links',
  'render-blocking': 'performance', 'mobile-web': 'seo', 'privacy-links': 'seo', 'anchor-target': 'links',
  'interactive-link': 'links', 'interactive-control': 'functional', 'interactive-nesting': 'a11y',
  'sec-header': 'security', 'sec-cookie': 'security', 'sec-js': 'security', 'sec-transport': 'security', 'sec-exposure': 'security',
  'seo-hreflang': 'seo', 'seo-index': 'seo', 'seo-content': 'seo',
  'stb-dup-id': 'a11y', 'stb-dom': 'performance', 'stb-form': 'forms', 'stb-uri': 'links',
};
const PASS_LABEL = {
  'page-status': 'All pages return a successful status', 'placeholder-content': 'No placeholder / lorem text',
  'global-components': 'Header, navigation and footer present', 'broken-rich-content': 'Tables and code blocks render',
  'viewport-meta': 'Every page declares a mobile viewport',
  'title': 'Every page has a title tag', 'meta-description': 'Every page has a meta description',
  'canonical': 'Canonical URLs present', 'indexability': 'Pages are indexable', 'social-meta': 'Open Graph / Twitter cards complete',
  'favicon': 'Favicon declared', 'schema': 'Structured data present and valid', 'duplicate-title': 'Page titles are unique',
  'duplicate-description': 'Meta descriptions are unique', 'robots-txt': 'robots.txt present', 'sitemap': 'XML sitemap present',
  'analytics': 'Analytics / tracking detected', 'headings': 'Heading structure is valid', 'html-lang': 'Language attribute set',
  'images': 'Images have alt text', 'image-perf': 'Images optimized (lazy-load + modern formats)', 'compression': 'HTML served compressed',
  'mixed-content': 'No mixed (http) content', 'https-enforce': 'HTTPS enforced site-wide',
  // NO 'security-headers' LABEL — deliberate. A key in this map prints its green label whenever no
  // finding carries that key, which CANNOT distinguish "checked, clean" from "never checked". The
  // SEC-010 roll-up is `continue`d out of the STATIC_CHECKS loop below (it is deprecatedIn 2.0;
  // qa-site uses the granular SEC-011..015), so nothing can ever emit 'security-headers' here — the
  // label printed "Security headers present" on every site ever scanned, including sgen.com, where it
  // sat directly above five SEC-011..015 warnings saying those exact headers were missing. The
  // granular checks already report this suite honestly, so this row is deleted rather than downgraded
  // to "not checked": the headers ARE checked, just not by a roll-up. Do not re-add a label here
  // unless the check that emits it actually runs.
  '404-config': 'Unknown URLs return a proper 404',
  'render-blocking': 'No render-blocking resources in <head>', 'mobile-web': 'Mobile web-app metadata present', 'privacy-links': 'Privacy / cookie signals present', 'anchor-target': 'In-page anchor links resolve',
  'interactive-link': 'All links have working targets', 'interactive-control': 'Interactive controls are wired', 'interactive-nesting': 'No nested or disabled-but-active controls',
  'sec-header': 'Security response headers present', 'sec-cookie': 'Cookies set with Secure/HttpOnly/SameSite', 'sec-js': 'No dangerous inline JavaScript patterns', 'sec-transport': 'Credentials transported securely', 'sec-exposure': 'No exposed .git / config / backup / directory listing',
};
// render checks. NOTE: the render fold below iterates THESE KEYS — a check the render pass emits but
// that is missing here is silently dropped from the audit, so every new render check must be added.
// Each value MUST equal the registry suite of the rule the check maps to (one-check-one-suite), or
// suiteConsistency() flags a mismatch.
const RENDER_SUITE = {
  'console-errors': 'console', 'failed-requests': 'console', 'blocking-overlay': 'console',
  'cwv-lcp': 'performance', 'cwv-cls': 'performance', 'low-contrast': 'a11y',
  'horizontal-overflow': 'responsive', 'overflow-element': 'responsive', 'element-wider-than-viewport': 'responsive',
  'tap-target-small': 'responsive', 'input-font-small': 'responsive', 'axe': 'a11y', 'page-weight': 'performance',
  // fonts + icons (registry 1.11.0 — FONT-001..006 / ICON-001..003)
  'font-not-loaded': 'a11y', 'font-undeclared': 'a11y', 'synthetic-bold': 'a11y', 'synthetic-italic': 'a11y',
  'font-display-missing': 'performance', 'font-preloaded-unused': 'performance',
  'icon-font-not-loaded': 'functional', 'icon-ligature-visible': 'functional', 'icon-tofu': 'functional',
};
const RENDER_PASS = {
  console: [['console-errors', 'No JavaScript / console errors on load'], ['failed-requests', 'No failed asset requests']],
  performance: [['cwv-lcp', 'Largest Contentful Paint within target'], ['cwv-cls', 'Layout is stable (low CLS)']],
  a11y_render: [['low-contrast', 'Text meets AA colour contrast']],
  responsive_render: [['overflow', 'No horizontal overflow across viewports'], ['tap', 'Tap targets and input fonts sized for touch']],
};

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE EVALUATION LEDGER — "I looked and it is clean" vs "I never looked"
//
// THE DEFECT THIS EXISTS TO KILL, measured on this exact code before it was written:
//   node -e "runAudit('https://<host-that-does-not-resolve>', { render:false })"
//     -> verdict NEEDS ATTENTION · score 93 · quality 98 · 37 GREEN TICKS · crawl.htmlPages 0
//   Among the 37: "All pages return a successful status", "Images have alt text", "HTTPS enforced
//   site-wide", "No exposed .git / config / backup". NOT ONE BYTE OF HTML WAS EVER FETCHED. The real
//   sgen.com run — where the tool genuinely worked — scores 49. The worse the target, the better the
//   report. This tool is handed to a client as evidence a rebuild is sound.
//
// THE MECHANISM (three independent ways a green tick is minted from nothing):
//   1. The pass-row rule is "no finding carried this key => print PASS_LABEL[key]". Absence of a
//      complaint is not evidence of correctness. It is equally consistent with: the check crashed,
//      the page never loaded, the viewport never rendered, or the site is genuinely clean.
//   2. Every check is wrapped in `try { r = chk.fn(ctx) } catch (e) { r = null }`. A thrown exception
//      becomes `no finding` becomes a green tick. Poison checks-security.js and the report goes UP:
//      8 green security rows, and nothing in the report, the JSON or the logs says anything broke.
//   3. Several checks return null for "no response" as well as for "clean" — page-status falls
//      through all three of its arms when status is 0 (DNS failure), and https-enforce returns null
//      when its http:// probe cannot connect at all. Both then print green.
//
// THE FIX: a check may only claim a pass if it PROVABLY LOOKED. Every check family records, per run:
//   applicable — pages it could actually read (the evidence it needs existed)
//   ok         — invocations that returned without throwing
//   err        — invocations that threw (the exception is no longer swallowed silently)
// A pass row now requires ok > 0 && err === 0. Anything else emits a NOT-VERIFIED row instead.
//
// WHY 'manual' AND NOT A NEW STATUS — this was tested, not assumed. report.js line 336:
//     function worst(s){return s.fail?'fail':s.warn?'warn':s.manual&&!s.pass?'manual':'pass';}
// An unrecognised status falls through to 'pass' — a suite of nothing-but-not-run rows would render
// a GREEN "all passing" badge, i.e. a new status would REBUILD the exact bug it was invented to fix,
// in the one file a client actually reads. GLYPH[status], the status tabs, the palette and CK_RANK
// are all keyed to the four known statuses too. readiness.js counts only fail/warn, so a new status
// is invisible to the veto; score.js skips pass+manual, so a new status would be fed to
// deductionFor() and silently scored as a violation it has no evidence for.
// 'manual' is the only status that is already non-green, non-scoring and non-clean in ALL THREE of
// report.js / score.js / readiness.js — files other agents own. So a not-run row is a FLAGGED
// VARIANT of manual: status 'manual' for the three consumers that branch on status, plus the
// machine-readable `notRun` / `unverified` contract below for anything that wants the truth.
//
// THE CONTRACT (this is what the score-model agent consumes — see also result.coverage):
//   row.notRun    : true            — this row is NOT a result. Never render it as clean.
//   row.verified  : false
//   row.unverified: { checkId, suite, reason, ruleIds[], attempted, errored, error }
//       reason ∈ 'no-evidence' | 'check-error' | 'partial-error' | 'render-not-run' | 'engine-missing'
//       ruleIds — the registry rules that WERE NOT EVALUATED. score.js builds its denominator from
//                 every rule that COULD fire; these are the ones whose absence is currently being
//                 paid out as credit. Subtract them from the denominator, or refuse to score.
//   result.coverage: { model, checks[], evaluatedRules[], notEvaluatedRules[], counts{} }
// ─────────────────────────────────────────────────────────────────────────────────────────────

// check family -> the registry rules it can emit. Hardcoded deliberately: the registry has no
// `check` field, so this is the only place the mapping exists. It is NOT maintained by hand-vigilance
// — evaluation-ledger.test.js re-derives it from the real emitter call sites in checks-static.js and
// the site-qa check modules and fails on any drift, the same way pass-label-reachability.test.js
// derives its emitter inventory. Add a rule, the test goes red.
const CHECK_RULES = {
  // per-page static (checks-static.js)
  'page-status': ['FUNC-001', 'FUNC-002', 'FUNC-003'], 'placeholder-content': ['FUNC-004'],
  'global-components': ['FUNC-005'], 'broken-rich-content': ['FUNC-006', 'FUNC-007'],
  'viewport-meta': ['RESP-001'],
  'title': ['SEO-001', 'SEO-002'], 'meta-description': ['SEO-003', 'SEO-004'],
  'canonical': ['SEO-005', 'SEO-006'], 'indexability': ['SEO-007', 'SEO-008'],
  'social-meta': ['SEO-011', 'SEO-012'], 'favicon': ['SEO-014'],
  'schema': ['SEO-016', 'SEO-017', 'SEO-018', 'SEO-019'],
  'duplicate-title': ['SEO-009'], 'duplicate-description': ['SEO-010'],
  'analytics': ['SEO-025', 'SEO-026'], 'mobile-web': ['SEO-027'], 'privacy-links': ['SEO-028'],
  'headings': ['A11Y-003', 'A11Y-004', 'A11Y-005'], 'html-lang': ['A11Y-009'],
  'images': ['A11Y-006', 'A11Y-007', 'A11Y-008'],
  'image-perf': ['PERF-003', 'PERF-004'], 'compression': ['PERF-007'], 'render-blocking': ['PERF-005'],
  'mixed-content': ['SEC-009'], 'anchor-target': ['LINK-005'],
  // site-level (checks-static.js SITE_CHECKS)
  'robots-txt': ['SEO-020', 'SEO-021', 'SEO-029'], 'sitemap': ['SEO-022'],
  '404-config': ['LINK-004'], 'https-enforce': ['SEC-007', 'SEC-008'],
  // site-qa check modules
  'interactive-link': ['LINK-006', 'LINK-007', 'LINK-008', 'LINK-009'],
  'interactive-control': ['DOM-010', 'DOM-011'], 'interactive-nesting': ['DOM-012', 'DOM-013'],
  'sec-header': ['SEC-011', 'SEC-012', 'SEC-013', 'SEC-014', 'SEC-015'],
  'sec-cookie': ['SEC-016', 'SEC-017', 'SEC-018'], 'sec-js': ['SEC-023'],
  'sec-transport': ['SEC-024', 'SEC-025'], 'sec-exposure': ['SEC-022'],
  'seo-hreflang': ['SEO-031'], 'seo-index': ['SEO-035', 'SEO-036'], 'seo-content': ['SEO-037', 'SEO-038'],
  'stb-dup-id': ['DOM-003'], 'stb-dom': ['DOM-004'], 'stb-form': ['FORM-002'], 'stb-uri': ['LINK-010'],
  // render pass (checks-render.js / font-checks.js)
  'console-errors': ['CON-001'], 'failed-requests': ['CON-002'], 'blocking-overlay': ['CON-003'],
  'cwv-lcp': ['PERF-001'], 'cwv-cls': ['PERF-002'], 'page-weight': ['PERF-006'],
  'low-contrast': ['A11Y-002'], 'axe': ['A11Y-001'],
  'horizontal-overflow': ['RESP-002'], 'overflow-element': ['RESP-003'],
  'element-wider-than-viewport': ['RESP-004'], 'tap-target-small': ['RESP-005'], 'input-font-small': ['RESP-006'],
  // inline in this file
  'link-audit': ['LINK-001', 'LINK-002', 'LINK-003'],
  'cross-browser': ['XBR-001', 'XBR-002', 'XBR-003'],
};

// Check families this run deliberately does not execute, and that are NOT an evidence gap.
// 'security-headers' = SEC-010, the deprecatedIn-2.0 roll-up. qa-site runs the granular SEC-011..015
// instead and they cover the same risk, so its absence must not print a not-verified row either — it
// is superseded, not unmeasured. (Its green PASS_LABEL was deleted in wave 1 for the same reason.)
const NOT_APPLICABLE = new Set(['security-headers', 'staging-leak']);

// What evidence a check family needs before "clean" means anything. Default = at least one page that
// was fetched 200 AND is HTML. Overrides are the checks that read something else:
//   'response' — needs any real HTTP response (page-status reads the status code itself; the 404 and
//                https-enforce probes hit the origin directly, and both return null when the
//                connection fails, which is indistinguishable from their pass condition)
//   'always'   — the check self-reports its own failure (robots-txt and sitemap emit SEO-029/SEO-022
//                when they cannot fetch), so it needs no external evidence gate
const STATIC_NEEDS = { 'page-status': 'response' };
const SITE_NEEDS = { 'robots-txt': 'always', 'sitemap': 'always', '404-config': 'response', 'https-enforce': 'response' };

// Batch modules emit several families from ONE call, so one throw silently takes out every family in
// the batch — this is the "poison a module -> 8 green security rows" path. The ledger must mark them
// all, or the survivors of a crashed batch keep printing green.
const BATCH_IDS = {
  interaction: ['interactive-link', 'interactive-control', 'interactive-nesting'],
  securityPage: ['sec-header', 'sec-cookie', 'sec-js', 'sec-transport'],
  seoPage: ['seo-hreflang', 'seo-index', 'seo-content'],
  stabilityPage: ['stb-dup-id', 'stb-dom', 'stb-form', 'stb-uri'],
  securitySite: ['sec-exposure'],
};

// Render families grouped by the suite their not-verified row lands in. console + crossbrowser have
// NO static rules at all, so when the render pass does not run they measure literally nothing — and
// today they bank their full registry risk as "resolved". That is the score-inflation path.
const RENDER_FAMILIES = {
  console: ['console-errors', 'failed-requests', 'blocking-overlay'],
  performance: ['cwv-lcp', 'cwv-cls', 'page-weight'],
  a11y: ['low-contrast'],
  responsive: ['horizontal-overflow', 'overflow-element', 'element-wider-than-viewport', 'tap-target-small', 'input-font-small'],
};

const sevToStatus = (sev) => (sev === 'critical' || sev === 'high') ? 'fail' : 'warn'; // medium+low -> warn
const SEV_RANK = { critical: 0, high: 1, medium: 2, low: 3 };
const worstSev = (arr) => arr.slice().sort((a, b) => (SEV_RANK[a] ?? 4) - (SEV_RANK[b] ?? 4))[0] || 'low';

// A row can carry an items[] = every occurrence (page · section · identifier · value) for the
// second-level drill-down in the report. Kept out of the flat row; the renderer expands it.
function row(status, name, target, detail, meta, items, ruleId) { return { status, name, target: target || '', detail: detail || '', meta: meta || '', items: (items && items.length) ? items : undefined, ruleId: ruleId || null }; }

// ---- ledger primitives ----
// A fresh ledger per run (runAudit must be re-entrant — the UI server runs concurrent scans).
function newLedger() {
  const m = new Map();
  return {
    // Record ONE invocation of `id` against ONE unit of evidence it could actually read.
    // Call ONLY when the evidence existed: a check that was never given a page to look at must stay
    // at applicable 0, because "never asked" and "asked and answered clean" are the two states this
    // whole file exists to keep apart.
    mark(id, ok, err) {
      const l = m.get(id) || { applicable: 0, ok: 0, err: 0, error: null };
      l.applicable++;
      if (ok) l.ok++;
      else { l.err++; if (!l.error) l.error = String((err && err.message) || err || 'unknown error').slice(0, 200); }
      m.set(id, l);
    },
    markAll(ids, ok, err) { ids.forEach(id => this.mark(id, ok, err)); },
    get(id) { return m.get(id) || { applicable: 0, ok: 0, err: 0, error: null }; },
    // A check family is VERIFIED only if it returned a real answer at least once and never blew up.
    // err > 0 forfeits the pass even when other pages succeeded: a green tick claims the whole crawl
    // is clean, and a crashed page is not clean — it is unknown.
    verified(id) { const l = this.get(id); return l.ok > 0 && l.err === 0; },
  };
}

// The not-verified row. status 'manual' is deliberate — see the header: report.js worst() renders an
// unknown status as a GREEN "all passing" badge, so a new status would rebuild this exact bug.
// Human labels for the not-run rows whose checkId is synthetic (a group, not a static check family).
// Deliberately NOT added to PASS_LABEL: a key there is a GREEN tick minted from the absence of a
// finding, and pass-label-reachability.test.js requires every PASS_LABEL key to have a live emitter.
// These keys have no emitter by definition — that is the whole point of them.
const NOT_RUN_LABEL = {
  // families that have no PASS_LABEL (they never minted a green tick, so they were never part of the
  // defect) still need a human name the moment they DO have to report an evidence gap
  'seo-hreflang': 'hreflang annotations valid', 'seo-index': 'Indexability signals agree',
  'seo-content': 'Content depth and readability', 'stb-dup-id': 'No duplicate element ids',
  'stb-dom': 'DOM size within budget', 'stb-form': 'Form fields carry valid semantics',
  'stb-uri': 'mailto: / tel: links are valid',
  'link-audit': 'Internal / external links and redirect chains',
  'cross-browser': 'Cross-browser render (Firefox · WebKit)',
  'axe': 'Deep WCAG 2.1 A/AA scan (axe-core)',
  'render:console': 'Console & network errors (browser render pass)',
  'render:performance': 'Core Web Vitals and page weight (browser render pass)',
  'render:a11y': 'Colour-contrast sweep (browser render pass)',
  'render:responsive': 'Responsive sweep — overflow and tap targets (browser render pass)',
};
function notRunRow(checkId, suite, reason, ruleIds, detail, l) {
  const label = NOT_RUN_LABEL[checkId] || PASS_LABEL[checkId] || checkId;
  return {
    status: 'manual',
    name: `Not verified — ${label}`,
    target: '',
    detail,
    meta: 'not verified',
    items: undefined,
    ruleId: null,                 // a not-run row is not a rule violation; the rules it could not
                                  // reach travel in unverified.ruleIds, where nothing mistakes them
                                  // for an observed finding.
    notRun: true,                 // machine flag: THIS ROW IS NOT A RESULT
    verified: false,
    unverified: {
      checkId, suite, reason,
      ruleIds: ruleIds || [],
      attempted: l ? l.applicable : 0,
      errored: l ? l.err : 0,
      error: l ? l.error : null,
    },
  };
}

// Plain-English WHY for a static/site check that could not be trusted. Never "no issues found".
function whyNotVerified(l) {
  if (l.applicable === 0) return { reason: 'no-evidence', detail: 'this check never ran — the crawl produced no page it could read, so a green tick here would mean nothing. This is NOT a pass.' };
  if (l.ok === 0) return { reason: 'check-error', detail: `this check threw on all ${l.err} attempt(s) and returned no result — the failure was swallowed, not observed: ${l.error}. This is NOT a pass.` };
  return { reason: 'partial-error', detail: `this check errored on ${l.err} of ${l.applicable} page(s), so it cannot claim the site is clean: ${l.error}. This is NOT a pass.` };
}

// Flatten a group of same-check/same-title findings into drill-down items. Each finding is per-page;
// its .items are the offenders on that page. Checks that don't enumerate get one page-level item.
function itemsOf(finds) {
  const out = [];
  for (const f of finds) {
    const ev = f.evidence ? String(f.evidence).split(/[\\/]/).pop() : '';
    if (f.items && f.items.length) f.items.forEach(it => out.push({ page: f.location || '—', section: it.section || '—', id: it.id || '(element)', value: it.value == null ? '' : String(it.value), evidence: ev, descriptor: it.descriptor || null }));
    else out.push({ page: f.location || '—', section: f.section || '—', id: '(whole page)', value: f.value == null ? '' : String(f.value), evidence: ev });
  }
  return out;
}
// group findings (same check id) by their title — one check can emit several distinct problems
function byTitle(finds) { const g = {}; for (const f of finds) (g[f.title] = g[f.title] || []).push(f); return g; }

// <meta name="description"> content. Local copy: checks-static.js has an identical metaContent()
// but does not export it, and buildCtx() does not surface the description on the ctx. Mirrors that
// regex exactly (name OR property, quoted) so the duplicate-description pass below agrees with the
// meta-description check on what "has a description" means.
function metaDescriptionOf(head) {
  const m = (head || '').match(/<meta\b[^>]*(?:name|property)\s*=\s*["']description["'][^>]*>/i);
  if (!m) return null;
  const c = m[0].match(/\scontent\s*=\s*["']([^"']*)["']/i);
  const v = c ? c[1].trim() : '';
  return v || null;
}

// ---- link audit: internal + EXTERNAL broken links, and redirect chains/loops ----
function allLinks(html, pageUrl, host) {
  const internal = new Set(), external = new Set();
  for (const m of html.matchAll(/<a\b[^>]*\shref\s*=\s*["']([^"']+)["']/gi)) {
    const raw = m[1].trim();
    if (/^(mailto:|tel:|javascript:|#|data:)/i.test(raw)) continue;
    const a = http.abs(raw.split('#')[0], pageUrl); if (!a) continue;
    if (/\.(png|jpe?g|gif|webp|svg|pdf|zip|mp4|mp3|css|js|ico|woff2?|ttf)(\?|$)/i.test(a)) continue;
    let h; try { h = new URL(a).host; } catch (e) { continue; }
    if (h === host) internal.add(a); else if (/^https?:/i.test(a)) external.add(a);
  }
  return { internal: [...internal], external: [...external] };
}
async function followChain(url) {
  const seen = new Set([url]); let cur = url, hops = 0, status = 0;
  while (hops < 8) {
    const r = await http.getText(cur); status = r.status;
    if (r.status >= 300 && r.status < 400 && r.location) {
      const nxt = http.abs(r.location, cur); if (!nxt) break;
      if (seen.has(nxt)) return { hops: hops + 1, final: nxt, status: r.status, loop: true };
      seen.add(nxt); cur = nxt; hops++;
    } else break;
  }
  return { hops, final: cur, status, loop: false };
}
async function linkAudit(htmlPages, host, conc) {
  const internal = new Set(), external = new Set();
  for (const p of htmlPages) { const l = allLinks(p.body || '', p.url, host); l.internal.forEach(u => internal.add(u)); l.external.forEach(u => external.add(u)); }
  const intList = [...internal].slice(0, 300), extList = [...external].slice(0, 80);
  const intRes = await http.pool(intList, conc, async (u) => ({ u, s: await http.head(u) }));
  const brokenInternal = intRes.filter(r => !(typeof r.s === 'number' && r.s >= 200 && r.s < 400)).map(r => ({ url: r.u, status: r.s }));
  const extRes = await http.pool(extList, conc, async (u) => ({ u, s: await http.head(u) }));  // lenient: only clear 4xx/5xx (many block HEAD)
  const brokenExternal = extRes.filter(r => typeof r.s === 'number' && r.s >= 400).map(r => ({ url: r.u, status: r.s }));
  const redirs = intRes.filter(r => typeof r.s === 'number' && r.s >= 300 && r.s < 400).map(r => r.u).slice(0, 30);
  const chains = [];
  await http.pool(redirs, conc, async (u) => { const c = await followChain(u); if (c.loop || c.hops > 1) chains.push({ url: u, hops: c.hops, loop: c.loop, final: c.final }); });
  return { totalInternal: intList.length, totalExternal: extList.length, brokenInternal, brokenExternal, chains, capped: internal.size > 300 };
}

// ---- form audit (structure only; submission/email is a manual/needs-input item) ----
function formAudit(htmlPages) {
  let forms = 0; const problems = [];
  for (const p of htmlPages) {
    for (const m of (p.body || '').matchAll(/<form\b[\s\S]*?<\/form>/gi)) {
      forms++;
      const f = m[0];
      const inputs = (f.match(/<input\b[^>]*>/gi) || []).filter(i => !/type\s*=\s*["'](hidden|submit|button)["']/i.test(i));
      const labelled = (f.match(/<label\b/gi) || []).length;
      if (inputs.length && labelled < inputs.length) problems.push({ url: p.url, detail: `form has ${inputs.length} field(s) but only ${labelled} <label> — unlabelled inputs hurt a11y + autofill` });
      if (!/\smethod\s*=/i.test(f) && !/\saction\s*=/i.test(f)) problems.push({ url: p.url, detail: 'form has no action/method attribute' });
    }
  }
  return { forms, problems };
}

async function runAudit(url, { maxPages = 150, concurrency = 8, renderSample = 12, render = true, viewports = null, screensDir, log = () => {}, progress = () => {}, bus = createBus(), collectPages = false } = {}) {
  const host = new URL(url).host;
  bus.fire('scan.started', { url, host, versions: VERSIONS });
  log(`\n=== SGEN Site QA · ${url} ===`);
  progress(4, 'starting scan');

  // 1) crawl
  progress(6, 'crawling pages');
  const crawl = await discoverPages(url, { maxPages, concurrency, log });
  const htmlPages = crawl.pages.filter(p => p.status === 200 && (/text\/html/i.test(p.contentType || '') || /<html[\s>]/i.test(p.body || '')));
  progress(22, `crawled ${crawl.pages.length} pages`);

  // 2) static checks aggregated by id
  const staticBy = {};
  const titles = {}, descs = {};
  const ledger = newLedger();
  // The two evidence gates every static pass row is now held to. `htmlOk` is the same predicate the
  // htmlPages filter uses; `responded` means the host actually answered SOMETHING (on a host that
  // does not resolve, getText returns status 0 — page-status then falls through all three of its
  // arms and returns null, which the old code printed as "All pages return a successful status").
  const htmlOk = (p) => p.status === 200 && (/text\/html/i.test(p.contentType || '') || /<html[\s>]/i.test(p.body || ''));
  const respondedOk = (p) => typeof p.status === 'number' && p.status >= 100;
  const originResponded = crawl.pages.some(respondedOk);
  for (const p of crawl.pages) {
    const ctx = buildCtx(p, host);
    const pageIsHtml = htmlOk(p), pageResponded = respondedOk(p);
    for (const chk of STATIC_CHECKS) {
      if (chk.id === 'staging-leak') continue; // migration-only
      if (chk.id === 'security-headers') continue; // qa-site uses granular SEC-011..015 (checks-security); SEC-010 roll-up is qa-migration only
      let r, threw = null;
      try { r = chk.fn(ctx, { env: 'live', host }); } catch (e) { r = null; threw = e; }
      // The catch above still swallows, because one bad page must not abort the crawl — but the
      // swallow is now RECORDED. Before this line, `catch -> r = null -> no finding -> green tick`
      // meant a crashing check made the report BETTER, and nothing anywhere said it broke.
      if ((STATIC_NEEDS[chk.id] || 'html') === 'response' ? pageResponded : pageIsHtml) ledger.mark(chk.id, !threw, threw);
      if (!r) continue;
      (Array.isArray(r) ? r : [r]).forEach(f => (staticBy[f.check] = staticBy[f.check] || []).push(f));
    }
    // Batch modules: ONE throw takes out every family in the batch, so the ledger marks them all.
    // Interaction Integrity (Batch 1) — dead links/buttons, nesting, disabled-active. Static + deterministic.
    if (ctx.isHtml && p.status === 200) { try { interactionCheck(ctx).forEach(f => (staticBy[f.check] = staticBy[f.check] || []).push(f)); ledger.markAll(BATCH_IDS.interaction, true); } catch (e) { ledger.markAll(BATCH_IDS.interaction, false, e); } }
    // Security Batch 2 — granular headers, cookies, dangerous JS, password/login transport (per page).
    if (p.status === 200) { try { securityPageChecks(ctx).forEach(f => (staticBy[f.check] = staticBy[f.check] || []).push(f)); ledger.markAll(BATCH_IDS.securityPage, true); } catch (e) { ledger.markAll(BATCH_IDS.securityPage, false, e); } }
    // SEO Batch 3 — hreflang, indexability-signal conflicts, thin content, readability (per page).
    if (ctx.isHtml && p.status === 200) { try { seoPageChecks(ctx).forEach(f => (staticBy[f.check] = staticBy[f.check] || []).push(f)); ledger.markAll(BATCH_IDS.seoPage, true); } catch (e) { ledger.markAll(BATCH_IDS.seoPage, false, e); } }
    // Stability Batch 4 — duplicate ids, DOM size, form field semantics, mailto/tel validity (per page).
    if (ctx.isHtml && p.status === 200) { try { stabilityPageChecks(ctx).forEach(f => (staticBy[f.check] = staticBy[f.check] || []).push(f)); ledger.markAll(BATCH_IDS.stabilityPage, true); } catch (e) { ledger.markAll(BATCH_IDS.stabilityPage, false, e); } }
    // The cross-page duplicate roll-ups below are fed from HERE, so their evidence is this page, not
    // a STATIC_CHECKS entry — without these marks they would look "never run" on every site.
    if (pageIsHtml) ledger.markAll(['duplicate-title', 'duplicate-description'], true);
    if (ctx.isHtml && p.status === 200 && ctx.title) (titles[ctx.title] = titles[ctx.title] || []).push(p.url);
    // `descs` was declared and never read: SEO-010 (duplicate-description) had NO detection code
    // anywhere in the product, yet PASS_LABEL printed "Meta descriptions are unique" on every scan —
    // a green tick with nothing behind it. Collect the descriptions so the row below is real.
    if (ctx.isHtml && p.status === 200) { const d = metaDescriptionOf(ctx.head); if (d) (descs[d] = descs[d] || []).push(p.url); }
  }
  // ruleId is REQUIRED on these: enrichRow() resolves rule identity ONLY by ruleId, so a finding
  // emitted without one is stamped deduction 0 and never scored — it would show as a warning row
  // that costs the site nothing. duplicate-title shipped without its SEO-009 id for exactly that
  // reason; both are named explicitly here.
  for (const [ti, u] of Object.entries(titles)) if (u.length > 1) u.forEach(x => (staticBy['duplicate-title'] = staticBy['duplicate-title'] || []).push({ ruleId: 'SEO-009', check: 'duplicate-title', severity: 'medium', title: 'Duplicate title across pages', detail: `shared by ${u.length} pages: "${ti.slice(0, 50)}"`, location: x }));
  for (const [de, u] of Object.entries(descs)) if (u.length > 1) u.forEach(x => (staticBy['duplicate-description'] = staticBy['duplicate-description'] || []).push({ ruleId: 'SEO-010', check: 'duplicate-description', severity: 'medium', title: 'Duplicate description across pages', detail: `shared by ${u.length} pages: "${de.slice(0, 50)}"`, location: x }));

  progress(32, 'analyzing pages (SEO · a11y · security)');
  // 3) link + form audits
  log(`Auditing internal links...`);
  progress(36, 'checking links');
  const links = await linkAudit(htmlPages, host, concurrency);
  const forms = formAudit(htmlPages);
  progress(44, 'links checked');

  // 4) site-level checks (robots/sitemap/404/https)
  const { SITE_CHECKS } = require('../migration-qa/checks-static');
  for (const chk of SITE_CHECKS) {
    let r, threw = null;
    try { r = await chk.fn({ origin: crawl.origin, host, env: 'live', http, crawl }); } catch (e) { r = null; threw = e; }
    // 404-config and https-enforce probe the origin themselves and return null BOTH when the probe
    // passes AND when it cannot connect — so on a dead host they printed "Unknown URLs return a
    // proper 404" and "HTTPS enforced site-wide" green. Gate them on the origin having answered.
    if ((SITE_NEEDS[chk.id] || 'always') === 'response' ? originResponded : true) ledger.mark(chk.id, !threw, threw);
    if (r) (Array.isArray(r) ? r : [r]).forEach(f => (staticBy[f.check] = staticBy[f.check] || []).push(f));
  }
  // Security Batch 2 — site-level exposure probes (.git / config / backup / dir-listing), once per origin.
  if (originResponded) {
    try { (await securitySiteProbes(crawl.origin, http, log)).forEach(f => (staticBy[f.check] = staticBy[f.check] || []).push(f)); ledger.markAll(BATCH_IDS.securitySite, true); }
    catch (e) { ledger.markAll(BATCH_IDS.securitySite, false, e); }
  }

  // 5) render pass aggregated
  let renderRes = { findings: [], shots: {}, rendered: 0, sampled: 0, total: htmlPages.length, error: 'skipped' };
  if (render && htmlPages.length) {
    // Count the matrix — never hardcode it. This literal said "3 viewports" while the engine
    // actually rendered 10, then 13: a stale string that survived every matrix change because no
    // offline test reads log copy. A live scan of sgen.com is what exposed it.
    const vpCount = (viewports && viewports.length) || VIEWPORTS.length;
    log(`Render pass (up to ${renderSample} pages × ${vpCount} viewports)...`);
    renderRes = await renderPass(htmlPages.map(p => p.url), { screensDir, sampleN: renderSample, viewports, log, progress: (r, t) => progress(46 + Math.round(r / Math.max(1, t) * 38), `rendering page ${r}/${t}`) });
  } else progress(84, 'render skipped');
  const renderBy = {};
  for (const f of renderRes.findings) (renderBy[f.check] = renderBy[f.check] || []).push(f);

  progress(86, 'security · cross-browser · sitemap');
  // 6) real TLS certificate inspection (free, node tls)
  let tls = null;
  if (/^https:/i.test(crawl.origin)) { try { tls = await tlsCheck(host); } catch (e) { tls = { reachable: false, error: String(e && e.message || e) }; } }

  // 7) real cross-browser render (free Firefox + WebKit engines; degrades to manual if not installed)
  let xbrowser = [];
  if (render) { try { xbrowser = await crossBrowser(url, { screensDir, log }); } catch (e) { xbrowser = []; } }

  // 8) og:image + favicon actually LOAD (#3) — HEAD the declared URLs from the first HTML page
  let assetLoad = null;
  { const fp = htmlPages[0];
    if (fp) { const h = fp.body || '';
      const og = (h.match(/<meta\b[^>]*property\s*=\s*["']og:image["'][^>]*>/i) || [''])[0];
      const ogUrl = og && (og.match(/content\s*=\s*["']([^"']+)["']/i) || [])[1];
      const fav = (h.match(/<link\b[^>]*rel\s*=\s*["'][^"']*icon[^"']*["'][^>]*>/i) || [''])[0];
      const favUrl = fav && (fav.match(/href\s*=\s*["']([^"']+)["']/i) || [])[1];
      const ogAbs = ogUrl ? http.abs(ogUrl, fp.url) : null, favAbs = favUrl ? http.abs(favUrl, fp.url) : null;
      assetLoad = { ogUrl: ogAbs, ogStatus: ogAbs ? await http.head(ogAbs) : null, favUrl: favAbs, favStatus: favAbs ? await http.head(favAbs) : null };
    } }

  // 9) sitemap ↔ crawl coverage (#4) — dead sitemap URLs + orphan pages
  let coverage = null;
  if (crawl.hadSitemap && crawl.sitemapUrls && crawl.sitemapUrls.length) {
    const smSet = new Set(crawl.sitemapUrls.map(u => u.split('#')[0]));
    const statusByUrl = {}; crawl.pages.forEach(p => statusByUrl[p.url] = p.status);
    const dead = crawl.sitemapUrls.filter(u => { const s = statusByUrl[u]; return typeof s === 'number' && s >= 400; });
    const orphans = crawl.pages.filter(p => p.status === 200 && (/text\/html/i.test(p.contentType || '') || /<html[\s>]/i.test(p.body || '')) && !smSet.has(p.url.split('#')[0]) && p.url.split('#')[0] !== crawl.origin + '/').map(p => p.url);
    coverage = { dead, orphans };
  }

  // ---- assemble suites ----
  const suiteRows = {}; SUITES.forEach(s => suiteRows[s.key] = []);
  const cap = (arr, n) => arr.slice(0, n);

  // coverage: the machine-readable record of which check families actually looked. Built alongside
  // the rows so the two can never disagree.
  const coverageChecks = [];
  const recordCoverage = (checkId, suite, verified, reason, l) => coverageChecks.push({
    checkId, suite, verified,
    reason: verified ? 'evaluated' : reason,
    ruleIds: CHECK_RULES[checkId] || [],
    attempted: l ? l.applicable : 0, errored: l ? l.err : 0, error: l ? l.error : null,
  });

  // static -> rows (one row per distinct problem-title, carrying EVERY occurrence as drill-down items)
  for (const id of Object.keys(STATIC_SUITE)) {
    if (NOT_APPLICABLE.has(id)) continue;
    const suite = STATIC_SUITE[id];
    const finds = staticBy[id] || [];
    const l = ledger.get(id);
    const ok = ledger.verified(id);
    recordCoverage(id, suite, ok, ok ? null : whyNotVerified(l).reason, l);
    // Findings still print first — a check that crashed on page 3 may have found something real on
    // page 1, and that evidence is not retracted by the ledger.
    for (const [title, fs] of Object.entries(byTitle(finds))) {
      const items = itemsOf(fs);
      const pages = new Set(fs.map(f => f.location)).size;
      const target = pages > 1 ? `${items.length} occurrence(s) · ${pages} page(s)` : (fs[0].location || '');
      suiteRows[suite].push(row(sevToStatus(worstSev(fs.map(f => f.severity))), title, target, fs[0].detail, fs[0].value, items, fs[0].ruleId));
    }
    // THE GREEN TICK NOW COSTS EVIDENCE. Old rule: "no finding => pass". New rule: "no finding AND
    // the check provably looked and never threw => pass". Everything else is stated as unverified.
    if (ok) { if (!finds.length && PASS_LABEL[id]) suiteRows[suite].push(row('pass', PASS_LABEL[id], null, '', '')); }
    else { const w = whyNotVerified(l); suiteRows[suite].push(notRunRow(id, suite, w.reason, CHECK_RULES[id], w.detail, l)); }
  }

  // links -> rows (internal broken, external broken, redirect chains/loops)
  // linkAudit reads htmlPages. With none, it checks 0 links and every row below printed green — "No
  // broken internal links · 0 internal link(s) checked" is a pass row whose own evidence field says
  // it looked at nothing. LINK-001..003 are unverified in that case, not resolved.
  const linksLooked = htmlPages.length > 0;
  recordCoverage('link-audit', 'links', linksLooked, 'no-evidence', { applicable: htmlPages.length, err: 0, error: null });
  if (!linksLooked) {
    suiteRows.links.push(notRunRow('link-audit', 'links', 'no-evidence', CHECK_RULES['link-audit'], 'no HTML page was fetched, so no link was ever requested — broken links, redirect chains and loops are all UNKNOWN. This is NOT a pass.', { applicable: 0, err: 0, error: null }));
  } else {
  if (!links.brokenInternal.length) suiteRows.links.push(row('pass', 'No broken internal links', null, `${links.totalInternal} internal link(s) checked`, `${links.totalInternal}`));
  else suiteRows.links.push(row('fail', 'Broken internal link(s)', `${links.brokenInternal.length} broken`, 'internal links that did not resolve (2xx/3xx)', String(links.brokenInternal.length), links.brokenInternal.map(b => ({ page: '—', section: 'internal link', id: b.url, value: String(b.status) })), 'LINK-001'));
  if (links.totalExternal) {
    if (!links.brokenExternal.length) suiteRows.links.push(row('pass', 'No broken external links', null, `${links.totalExternal} outbound link(s) checked`, `${links.totalExternal}`));
    else suiteRows.links.push(row('warn', 'Broken external link(s)', `${links.brokenExternal.length} broken`, 'outbound targets returning 4xx/5xx', String(links.brokenExternal.length), links.brokenExternal.map(b => ({ page: '—', section: 'external link', id: b.url, value: String(b.status) })), 'LINK-002'));
  }
  if (!links.chains.length) suiteRows.links.push(row('pass', 'No long redirect chains or loops', null, '', 'ok'));
  else suiteRows.links.push(row(links.chains.some(c => c.loop) ? 'fail' : 'warn', 'Redirect chain(s) / loop(s)', `${links.chains.length} affected`, 'long redirect chains or loops', String(links.chains.length), links.chains.map(c => ({ page: '—', section: c.loop ? 'redirect loop' : 'redirect chain', id: c.url, value: c.loop ? 'loop' : `${c.hops} hops → ${c.final}` })), 'LINK-003'));
  }

  // forms -> rows
  if (forms.forms === 0) suiteRows.forms.push(row('manual', 'No forms detected to test', null, 'if the site has forms behind auth or JS, add them to a manual pass', ''));
  else {
    if (!forms.problems.length) suiteRows.forms.push(row('pass', `${forms.forms} form(s) structurally sound`, null, 'fields labelled, method/action present', `${forms.forms}`));
    else cap(forms.problems, 4).forEach(pr => suiteRows.forms.push(row('warn', 'Form structure issue', pr.url, pr.detail, '', undefined, 'FORM-001')));
    suiteRows.forms.push(row('manual', 'Form submission → email / CRM delivery', null, 'requires test credentials + an inbox/webhook to watch; not machine-verifiable without them', 'needs input', undefined, 'FORM-900'));
  }

  // render -> rows (pass rows only if the pass actually ran and was clean)
  const renderedOk = renderRes.rendered > 0 && !renderRes.error;
  for (const id of Object.keys(RENDER_SUITE)) {
    if (id === 'low-contrast' && renderRes.axeRan) continue; // axe-core owns contrast when it ran (avoid double-count)
    const suite = RENDER_SUITE[id];
    const finds = renderBy[id] || [];
    if (!finds.length) continue;
    for (const [title, fs] of Object.entries(byTitle(finds))) {
      const items = itemsOf(fs);
      const pages = new Set(fs.map(f => f.location)).size;
      suiteRows[suite].push(row(sevToStatus(worstSev(fs.map(f => f.severity))), title, `${items.length} occurrence(s) · ${pages} page(s)`, fs[0].detail, fs[0].value, items, fs[0].ruleId));
    }
  }
  // consent overlays auto-dismissed (cookie banner / age gate / T&C): informational pass row — the
  // clicks are evidence a reviewer must be able to see, never a silent mutation of the page under test.
  const consentPages = Object.entries(renderRes.consentByPage || {}).filter(([, c]) => c.dismissed && c.dismissed.length);
  if (consentPages.length) {
    const items = consentPages.flatMap(([pg, c]) => c.dismissed.map(d => ({ page: pg, section: d.container || 'overlay', id: d.selector || '(button)', value: `clicked "${d.text}"` })));
    suiteRows.console.push(row('pass', 'Consent overlay(s) auto-dismissed before audit', `${items.length} click(s) · ${consentPages.length} page(s)`, 'cookie banner / age gate / terms overlay accepted so the audit sees the real page — every click listed below', `${consentPages.length} page(s)`, items));
  }
  if (renderedOk) {
    if (!(renderBy['console-errors'] || []).length) suiteRows.console.push(row('pass', 'No JavaScript / console errors on load', null, `${renderRes.rendered} page(s) rendered`, '0 errors'));
    if (!(renderBy['failed-requests'] || []).length) suiteRows.console.push(row('pass', 'No failed asset requests', null, '', '0 failed'));
    if (!(renderBy['cwv-lcp'] || []).length) suiteRows.performance.push(row('pass', 'Largest Contentful Paint within target', null, '', 'ok'));
    if (!(renderBy['cwv-cls'] || []).length) suiteRows.performance.push(row('pass', 'Layout is stable (low CLS)', null, '', 'ok'));
    if (!(renderBy['page-weight'] || []).length) suiteRows.performance.push(row('pass', 'Page weight within budget', null, '', 'ok'));
    if (!renderRes.axeRan && !(renderBy['low-contrast'] || []).length) suiteRows.a11y.push(row('pass', 'Sampled text meets AA colour contrast', null, '', 'ok'));
    const respIds = ['horizontal-overflow', 'overflow-element', 'element-wider-than-viewport', 'tap-target-small', 'input-font-small'];
    // Same stale literal, but this one is WORSE: it lands in a client-facing PASS row, so a report
    // claimed "N page(s) × 3 viewports" while 13 were actually swept — understating the evidence
    // behind a clean result. Derive it from the matrix that ran.
    const sweptCount = (renderRes.viewports && renderRes.viewports.length) || (viewports && viewports.length) || VIEWPORTS.length;
    if (!respIds.some(i => (renderBy[i] || []).length)) suiteRows.responsive.push(row('pass', 'No horizontal overflow across viewports', null, `${renderRes.rendered} page(s) × ${sweptCount} viewports`, 'clean'));
  }
  // WHETHER OR NOT the pass ran, every render family is recorded — this is the score-inflation path.
  // Re-scoring the REAL sgen.com data with the render pass removed (same site, browser results merely
  // absent): console 0 -> 100, performance 27 -> 79, responsive 77 -> 100, quality 72 -> 86. console
  // and crossbrowser have NO static rules at all, so with no render they measure literally NOTHING
  // and bank their full registry risk as "resolved". Before this, the whole event emitted ONE manual
  // row in one suite; the other three suites went quietly green.
  for (const [suite, fams] of Object.entries(RENDER_FAMILIES)) {
    fams.forEach(f => recordCoverage(f, suite, renderedOk, 'render-not-run', { applicable: renderedOk ? renderRes.rendered : 0, err: 0, error: renderedOk ? null : (renderRes.error || null) }));
    if (renderedOk) continue;
    const ruleIds = fams.flatMap(f => CHECK_RULES[f] || []);
    const why = renderRes.error === 'skipped'
      ? 'the browser render pass was skipped (--no-render), so nothing in this group was measured — re-run without --no-render'
      : `the browser render pass could not run (${renderRes.error}), so nothing in this group was measured`;
    suiteRows[suite].push(notRunRow(`render:${suite}`, suite, 'render-not-run', ruleIds,
      `${why}. ${ruleIds.length} rule(s) UNMEASURED: ${ruleIds.join(', ')}. This is NOT a pass.`,
      { applicable: 0, err: 0, error: renderRes.error || null }));
  }

  // axe-core deep WCAG (real, industry-standard) -> a11y
  // axe-core IS NOT INSTALLED and has never run in any stored run: package.json deps are exactly
  // {playwright, sharp}, so require.resolve('axe-core') throws, AXE_SRC stays null and the pass is
  // skipped. A11Y-001 is therefore unmeasured on every scan this engine has ever produced — and its
  // absence made a11y scores HIGHER. The row existed; the machine-readable "unmeasured" did not.
  const axeOk = renderedOk && !!renderRes.axeRan;
  recordCoverage('axe', 'a11y', axeOk, renderRes.axeAvailable === false ? 'engine-missing' : 'render-not-run',
    { applicable: axeOk ? renderRes.rendered : 0, err: 0, error: renderRes.axeAvailable === false ? 'axe-core not installed' : null });
  if (renderRes.axeAvailable === false) suiteRows.a11y.push(notRunRow('axe', 'a11y', 'engine-missing', CHECK_RULES['axe'], 'axe-core is not installed, so the deep WCAG 2.1 A/AA scan never ran — A11Y-001 is UNMEASURED, not clean. Run: npm i axe-core. This is NOT a pass.', { applicable: 0, err: 0, error: 'axe-core not installed' }));
  else if (renderedOk && renderRes.axeRan && !(renderBy['axe'] || []).length) suiteRows.a11y.push(row('pass', 'axe-core: no WCAG 2.1 A/AA violations', null, 'industry-standard automated accessibility scan', 'clean'));

  // real TLS certificate -> security
  if (tls) {
    if (!tls.reachable) suiteRows.security.push(row('fail', 'TLS handshake failed', crawl.origin, tls.error || 'could not read certificate', 'error', undefined, 'SEC-002'));
    else if (tls.daysRemaining != null && tls.daysRemaining < 0) suiteRows.security.push(row('fail', 'TLS certificate has expired', null, `expired ${-tls.daysRemaining} day(s) ago (${tls.validTo})`, 'expired', undefined, 'SEC-001'));
    else if (!tls.authorized) suiteRows.security.push(row('warn', 'TLS certificate not fully trusted', null, tls.error || 'certificate chain / authorization issue', tls.error || 'untrusted', undefined, 'SEC-003'));
    else if (!tls.hostMatch) suiteRows.security.push(row('warn', 'TLS certificate hostname mismatch', null, `certificate names: ${(tls.names || []).join(', ')}`, 'host', undefined, 'SEC-004'));
    else if (tls.daysRemaining != null && tls.daysRemaining < 21) suiteRows.security.push(row('warn', 'TLS certificate expiring soon', null, `expires in ${tls.daysRemaining} day(s) · issuer ${tls.issuer || '?'}`, `${tls.daysRemaining}d`, undefined, 'SEC-005'));
    else suiteRows.security.push(row('pass', 'Valid TLS certificate', null, `expires in ${tls.daysRemaining} day(s) · issuer ${tls.issuer || '?'}`, tls.daysRemaining != null ? `${tls.daysRemaining}d` : 'ok'));
  }

  // TLS protocol grade (#9) -> security
  if (tls && tls.reachable && tls.protocol) {
    const weak = /^(SSLv|TLSv1$|TLSv1\.0|TLSv1\.1)/.test(tls.protocol);
    suiteRows.security.push(weak ? row('warn', 'Outdated TLS protocol', null, `${tls.protocol} — upgrade to TLS 1.2+`, tls.protocol, undefined, 'SEC-006') : row('pass', 'Modern TLS protocol', null, `${tls.protocol}${tls.cipher ? ' · ' + tls.cipher : ''}`, tls.protocol));
  }

  // og:image + favicon actually load (#3) -> seo
  if (assetLoad) {
    if (assetLoad.ogUrl) { const ok = typeof assetLoad.ogStatus === 'number' && assetLoad.ogStatus < 400; suiteRows.seo.push(ok ? row('pass', 'og:image loads', null, '', String(assetLoad.ogStatus)) : row('warn', 'og:image does not load', assetLoad.ogUrl, `returned ${assetLoad.ogStatus}`, String(assetLoad.ogStatus), undefined, 'SEO-013')); }
    if (assetLoad.favUrl && !(typeof assetLoad.favStatus === 'number' && assetLoad.favStatus < 400)) suiteRows.seo.push(row('warn', 'Favicon does not load', assetLoad.favUrl, `returned ${assetLoad.favStatus}`, String(assetLoad.favStatus), undefined, 'SEO-015'));
  }

  // sitemap ↔ crawl coverage (#4) -> seo
  if (coverage) {
    if (!coverage.dead.length && !coverage.orphans.length) suiteRows.seo.push(row('pass', 'Sitemap matches the crawl', null, 'no dead sitemap URLs or orphan pages', 'ok'));
    else {
      if (coverage.dead.length) suiteRows.seo.push(row('warn', 'Dead URL(s) in sitemap', `${coverage.dead.length} dead`, 'listed in the XML sitemap but return an error', String(coverage.dead.length), coverage.dead.map(u => ({ page: u, section: 'sitemap.xml', id: u, value: 'dead' })), 'SEO-023'));
      if (coverage.orphans.length) suiteRows.seo.push(row('warn', 'Orphan page(s) (not in sitemap)', `${coverage.orphans.length} orphan`, 'reachable via links but missing from the XML sitemap', String(coverage.orphans.length), coverage.orphans.map(u => ({ page: u, section: 'crawl', id: u, value: 'orphan' })), 'SEO-024'));
    }
  }

  // real cross-browser render -> crossbrowser
  // crossbrowser carries NO static rules, so when no engine runs this suite measures nothing and
  // scores 100 on its full registry weight. It must say "unmeasured", per engine.
  const xbRan = xbrowser.filter(b => b.available && b.ok !== undefined);
  recordCoverage('cross-browser', 'crossbrowser', xbRan.length > 0, xbrowser.length ? 'engine-missing' : 'render-not-run',
    { applicable: xbRan.length, err: 0, error: xbrowser.length ? 'engine not installed' : (render ? 'no engines available' : 'render disabled') });
  if (!xbrowser.length) {
    suiteRows.crossbrowser.push(notRunRow('cross-browser', 'crossbrowser', 'render-not-run', CHECK_RULES['cross-browser'],
      `${render ? 'no browser engine was available this run' : 'the render pass is disabled (--no-render)'}, so Firefox and WebKit were never launched — XBR-001, XBR-002, XBR-003 are UNMEASURED. This is NOT a pass.`,
      { applicable: 0, err: 0, error: renderRes.error || null }));
  } else {
    for (const b of xbrowser) {
      const label = b.engine === 'webkit' ? 'WebKit (Safari engine)' : 'Firefox';
      if (!b.available) { suiteRows.crossbrowser.push(notRunRow('cross-browser', 'crossbrowser', 'engine-missing', b.engine === 'webkit' ? ['XBR-002'] : ['XBR-001'], `the ${label} engine is not installed, so the page was never opened in it — this browser is UNMEASURED, not working. Run once: npx playwright install ${b.engine}. This is NOT a pass.`, { applicable: 0, err: 0, error: 'engine not installed' })); continue; }
      if (!b.ok) suiteRows.crossbrowser.push(row('fail', `${label} failed to load the page`, url, b.navErr || 'navigation error', 'fail', undefined, b.engine === 'webkit' ? 'XBR-002' : 'XBR-001'));
      else if (b.errors && b.errors.length) suiteRows.crossbrowser.push(row('warn', `${label}: ${b.errors.length} console error(s)`, url, b.errors[0], String(b.errors.length), undefined, 'XBR-003'));
      else suiteRows.crossbrowser.push(row('pass', `Renders in ${label} with no console errors`, url, '', 'ok'));
      if (b.shot) (renderRes.shots[url] = renderRes.shots[url] || []).push({ label: b.engine, file: b.shot });
    }
  }

  // universal manual rows (honest — code cannot certify these)
  suiteRows.functional.push(row('manual', 'Visual design matches the intended design', null, 'compare against the approved design / reference — needs a human eye or a baseline', 'needs review', undefined, 'FUNC-900'));
  suiteRows.responsive.push(row('manual', 'Multi-device eyeball pass (Responsive Viewer)', null, 'automated sweep is Chromium at 3 widths; confirm real device frames', 'needs review', undefined, 'RESP-900'));

  progress(98, 'building report');
  // ---- registry-driven assembly: enrich FIRST (status/suite/severity/deduction/ruleId all from the
  // registry), THEN count + score from the enriched findings. No rule metadata is decided here. ----
  const suites = enrichSuites(SUITES.map(s => ({ ...s, checks: suiteRows[s.key] })), bus);
  suites.forEach(s => {
    const c = { pass: 0, warn: 0, fail: 0, manual: 0 };
    s.checks.forEach(r => c[r.status]++);
    s.pass = c.pass; s.warn = c.warn; s.fail = c.fail; s.manual = c.manual;
    // Additive counter — s.notRun ⊆ s.manual. The four status counters keep their exact meaning, so
    // report.js's `su.pass+su.warn+su.fail+su.manual` total and worst() are untouched, while a
    // consumer that wants to know how much of this suite was never measured can now ask.
    s.notRun = s.checks.filter(r => r.notRun).length;
  });
  const tot = suites.reduce((a, s) => { a.pass += s.pass; a.warn += s.warn; a.fail += s.fail; a.manual += s.manual; a.notRun += s.notRun; return a; }, { pass: 0, warn: 0, fail: 0, manual: 0, notRun: 0 });
  const graded = tot.pass + tot.warn + tot.fail;
  const score = graded ? Math.round(tot.pass / graded * 100) : 0;
  const verdict = tot.fail > 0 ? 'NEEDS ATTENTION' : (tot.warn > 0 ? 'PASSED WITH WARNINGS' : 'ALL PASSING');
  const ready = tot.fail === 0;
  // THE SEAM. The evaluation ledger is built HERE, before scoring, because computeQuality() needs it:
  // score.js builds each suite's denominator from the REGISTRY (every rule that COULD fire) while the
  // numerator only accrues from rows that actually ran — so a check that does not run is subtracted from
  // the TOP of the fraction only and pays out as CREDIT. Declaring what provably ran lets score.js drop
  // a never-run rule from BOTH sides, which is what makes its own documented "a suite that measured
  // nothing is excluded, not scored 100" reachable instead of dead code.
  //
  // This line is load-bearing and was nearly lost: the ledger and its consumer were written into
  // different files, and without this argument BOTH halves are inert — audit.js would build a ledger
  // nobody reads and score.js would keep the old inflation while looking fixed. The ledger used to be
  // assembled ~30 lines BELOW this call, which is why passing it alone would not have been enough.
  //
  // Safety is score.js's, not ours: an observed failing row overrides this list, so a wrong or stale
  // declaration can never delete real risk or raise a score. Passing it can only ever cost points.
  const evaluatedRules = new Set(), notEvaluatedRules = new Set();
  for (const c of coverageChecks) for (const r of (c.ruleIds || [])) (c.verified ? evaluatedRules : notEvaluatedRules).add(r);
  for (const r of evaluatedRules) notEvaluatedRules.delete(r);
  const quality = computeQuality(suites, { evaluatedRules: [...evaluatedRules] }); // SGEN Quality Score, scored over what was ACTUALLY evaluated
  const readiness = computeReadiness(suites); // launch-readiness veto layer (additive; tier-1 rules gate)
  const generated = new Date().toISOString();
  // Stage-2 single projection point: findings become canonical contract objects ONCE. Every finding-level
  // output (JSON/Markdown/Copy-MD/CI/API) derives from `findings`; annotates checks with `_md` so the HTML
  // report copies precomputed contract markdown (no client-side field reconstruction). Additive — scoring
  // aggregates (quality/readiness/tally) stay suite-based and byte-identical.
  const projected = projectFindings(suites, { host, generated });

  // ---- COVERAGE: the machine-readable answer to "what did this run actually evaluate?" ----
  // THE CONTRACT (stable shape; consumed by the score model — do not reshape without telling it):
  //   coverage.model              'sgen-coverage-v1'
  //   coverage.checks[]           { checkId, suite, verified:bool, reason, ruleIds[], attempted, errored, error }
  //                               reason ∈ evaluated | no-evidence | check-error | partial-error |
  //                                        render-not-run | engine-missing
  //   coverage.evaluatedRules[]   registry rule ids whose check PROVABLY RAN (sorted, deduped)
  //   coverage.notEvaluatedRules[] registry rule ids that were NEVER EVALUATED (sorted, deduped)
  //   coverage.counts             { checks, verified, notRun, rulesEvaluated, rulesNotEvaluated }
  //
  // WHY score.js needs this: it builds TOTAL_RISK_BY_SUITE from the registry at module load — every
  // rule that COULD fire — while the numerator only accrues from rows that actually ran. So a check
  // that does not run is subtracted from the TOP of the fraction only, and pays out as credit. Its
  // own header promises "a suite with no scorable checks is EXCLUDED from the average rather than
  // silently scoring 100", but that exclusion (totalRisk > 0 ? ... : null) only triggers when the
  // REGISTRY has no rules for a suite — never true for any of the 10 weighted suites. The promise is
  // unreachable code. `notEvaluatedRules` is the missing input that makes it reachable: subtract them
  // from the denominator and a suite that measured nothing lands on totalRisk 0 -> null -> excluded,
  // exactly as documented.
  //
  // A rule reached by BOTH an evaluated and an unevaluated check counts as evaluated (some evidence
  // beats none) — hence the ordering below: notEvaluated is built first, then evaluated is subtracted.
  // (named *Out: `coverage` is already taken above by the sitemap↔crawl coverage object)
  const coverageOut = {
    model: 'sgen-coverage-v1',
    checks: coverageChecks.slice().sort((a, b) => a.checkId.localeCompare(b.checkId)),
    evaluatedRules: [...evaluatedRules].sort(),
    notEvaluatedRules: [...notEvaluatedRules].sort(),
    counts: {
      checks: coverageChecks.length,
      verified: coverageChecks.filter(c => c.verified).length,
      notRun: coverageChecks.filter(c => !c.verified).length,
      rulesEvaluated: evaluatedRules.size,
      rulesNotEvaluated: notEvaluatedRules.size,
    },
  };

  const result = {
    target: url, host, generated,
    versions: { engine: VERSIONS.ENGINE_VERSION, report: VERSIONS.REPORT_VERSION, registry: VERSIONS.REGISTRY_VERSION },
    verdict, ready, score, quality, readiness, tally: tot, coverage: coverageOut,
    crawl: { pages: crawl.pages.length, htmlPages: htmlPages.length, sitemapCount: crawl.sitemapCount, linkFollowed: crawl.linkFollowed, capped: crawl.capped, maxPages },
    render: { rendered: renderRes.rendered, total: renderRes.total, viewports: renderRes.viewports || [], error: renderRes.error || null },
    links: { checked: links.totalInternal + links.totalExternal, broken: links.brokenInternal.length + links.brokenExternal.length, brokenInternal: links.brokenInternal.length, brokenExternal: links.brokenExternal.length, chains: links.chains.length },
    suites, shots: renderRes.shots || {}, consent: renderRes.consentByPage || {},
    findings: projected.findings, contractMetrics: projected.metrics,
    lenses: computeLenses(projected.findings), // Phase 2 Inspector Lenses (additive; frozen scoring untouched)
    // opt-in only (default off → identical output): raw page HTML for additive advisory passes
    // (Best Practices, FUNC-008 content-artifacts) run by the pipeline orchestrator.
    ...(collectPages ? { pages: htmlPages.map(p => ({ url: p.url, html: p.body || '' })) } : {}),
  };
  bus.fire('scan.completed', { url, host, overall: quality.overall, verdict, versions: VERSIONS });
  return result;
}

// RENDER_SUITE is exported for the test suite: it is the map the render fold iterates, so a render
// check missing from it is silently dropped from the audit. font-checks.test.js asserts every font/
// icon check is present here and lands in its registry suite.
// PASS_LABEL + STATIC_SUITE are exported for the test suite for the same reason RENDER_SUITE is:
// PASS_LABEL prints a green row for any key that NO finding carried, so a key whose check cannot run
// is a tick that can never fail. pass-label-reachability.test.js asserts every key has a live emitter.
// metaDescriptionOf is exported so its extraction contract is testable.
// CHECK_RULES / NOT_APPLICABLE / newLedger are exported for evaluation-ledger.test.js: CHECK_RULES is
// the check-family -> registry-rule map the coverage contract is built from, and it is hand-written
// because the registry carries no `check` field — so the test re-derives it from the real emitter
// call sites and fails on drift. newLedger is exported so the pass-requires-evidence rule (ok > 0 &&
// err === 0) is testable without a network round-trip.
module.exports = { runAudit, SUITES, RENDER_SUITE, PASS_LABEL, STATIC_SUITE, metaDescriptionOf, CHECK_RULES, NOT_APPLICABLE, newLedger };
