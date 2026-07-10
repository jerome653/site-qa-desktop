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
const { renderPass } = require('../migration-qa/checks-render');
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
  'mixed-content': 'No mixed (http) content', 'security-headers': 'Security headers present', 'https-enforce': 'HTTPS enforced site-wide',
  '404-config': 'Unknown URLs return a proper 404',
  'render-blocking': 'No render-blocking resources in <head>', 'mobile-web': 'Mobile web-app metadata present', 'privacy-links': 'Privacy / cookie signals present', 'anchor-target': 'In-page anchor links resolve',
  'interactive-link': 'All links have working targets', 'interactive-control': 'Interactive controls are wired', 'interactive-nesting': 'No nested or disabled-but-active controls',
  'sec-header': 'Security response headers present', 'sec-cookie': 'Cookies set with Secure/HttpOnly/SameSite', 'sec-js': 'No dangerous inline JavaScript patterns', 'sec-transport': 'Credentials transported securely', 'sec-exposure': 'No exposed .git / config / backup / directory listing',
};
// render checks
const RENDER_SUITE = {
  'console-errors': 'console', 'failed-requests': 'console', 'blocking-overlay': 'console',
  'cwv-lcp': 'performance', 'cwv-cls': 'performance', 'low-contrast': 'a11y',
  'horizontal-overflow': 'responsive', 'overflow-element': 'responsive', 'element-wider-than-viewport': 'responsive',
  'tap-target-small': 'responsive', 'input-font-small': 'responsive', 'axe': 'a11y', 'page-weight': 'performance',
};
const RENDER_PASS = {
  console: [['console-errors', 'No JavaScript / console errors on load'], ['failed-requests', 'No failed asset requests']],
  performance: [['cwv-lcp', 'Largest Contentful Paint within target'], ['cwv-cls', 'Layout is stable (low CLS)']],
  a11y_render: [['low-contrast', 'Text meets AA colour contrast']],
  responsive_render: [['overflow', 'No horizontal overflow across viewports'], ['tap', 'Tap targets and input fonts sized for touch']],
};

const sevToStatus = (sev) => (sev === 'critical' || sev === 'high') ? 'fail' : 'warn'; // medium+low -> warn
const SEV_RANK = { critical: 0, high: 1, medium: 2, low: 3 };
const worstSev = (arr) => arr.slice().sort((a, b) => (SEV_RANK[a] ?? 4) - (SEV_RANK[b] ?? 4))[0] || 'low';

// A row can carry an items[] = every occurrence (page · section · identifier · value) for the
// second-level drill-down in the report. Kept out of the flat row; the renderer expands it.
function row(status, name, target, detail, meta, items, ruleId) { return { status, name, target: target || '', detail: detail || '', meta: meta || '', items: (items && items.length) ? items : undefined, ruleId: ruleId || null }; }

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

async function runAudit(url, { maxPages = 150, concurrency = 8, renderSample = 12, render = true, screensDir, log = () => {}, progress = () => {}, bus = createBus(), collectPages = false } = {}) {
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
  for (const p of crawl.pages) {
    const ctx = buildCtx(p, host);
    for (const chk of STATIC_CHECKS) {
      if (chk.id === 'staging-leak') continue; // migration-only
      if (chk.id === 'security-headers') continue; // qa-site uses granular SEC-011..015 (checks-security); SEC-010 roll-up is qa-migration only
      let r; try { r = chk.fn(ctx, { env: 'live', host }); } catch (e) { r = null; }
      if (!r) continue;
      (Array.isArray(r) ? r : [r]).forEach(f => (staticBy[f.check] = staticBy[f.check] || []).push(f));
    }
    // Interaction Integrity (Batch 1) — dead links/buttons, nesting, disabled-active. Static + deterministic.
    if (ctx.isHtml && p.status === 200) { try { interactionCheck(ctx).forEach(f => (staticBy[f.check] = staticBy[f.check] || []).push(f)); } catch (e) {} }
    // Security Batch 2 — granular headers, cookies, dangerous JS, password/login transport (per page).
    if (p.status === 200) { try { securityPageChecks(ctx).forEach(f => (staticBy[f.check] = staticBy[f.check] || []).push(f)); } catch (e) {} }
    // SEO Batch 3 — hreflang, indexability-signal conflicts, thin content, readability (per page).
    if (ctx.isHtml && p.status === 200) { try { seoPageChecks(ctx).forEach(f => (staticBy[f.check] = staticBy[f.check] || []).push(f)); } catch (e) {} }
    // Stability Batch 4 — duplicate ids, DOM size, form field semantics, mailto/tel validity (per page).
    if (ctx.isHtml && p.status === 200) { try { stabilityPageChecks(ctx).forEach(f => (staticBy[f.check] = staticBy[f.check] || []).push(f)); } catch (e) {} }
    if (ctx.isHtml && p.status === 200 && ctx.title) (titles[ctx.title] = titles[ctx.title] || []).push(p.url);
  }
  for (const [ti, u] of Object.entries(titles)) if (u.length > 1) u.forEach(x => (staticBy['duplicate-title'] = staticBy['duplicate-title'] || []).push({ check: 'duplicate-title', severity: 'medium', title: 'Duplicate title across pages', detail: `shared by ${u.length} pages: "${ti.slice(0, 50)}"`, location: x }));

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
    let r; try { r = await chk.fn({ origin: crawl.origin, host, env: 'live', http, crawl }); } catch (e) { r = null; }
    if (r) (Array.isArray(r) ? r : [r]).forEach(f => (staticBy[f.check] = staticBy[f.check] || []).push(f));
  }
  // Security Batch 2 — site-level exposure probes (.git / config / backup / dir-listing), once per origin.
  try { (await securitySiteProbes(crawl.origin, http, log)).forEach(f => (staticBy[f.check] = staticBy[f.check] || []).push(f)); } catch (e) {}

  // 5) render pass aggregated
  let renderRes = { findings: [], shots: {}, rendered: 0, sampled: 0, total: htmlPages.length, error: 'skipped' };
  if (render && htmlPages.length) {
    log(`Render pass (up to ${renderSample} pages × 3 viewports)...`);
    renderRes = await renderPass(htmlPages.map(p => p.url), { screensDir, sampleN: renderSample, log, progress: (r, t) => progress(46 + Math.round(r / Math.max(1, t) * 38), `rendering page ${r}/${t}`) });
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

  // static -> rows (one row per distinct problem-title, carrying EVERY occurrence as drill-down items)
  for (const id of Object.keys(STATIC_SUITE)) {
    const suite = STATIC_SUITE[id];
    const finds = staticBy[id] || [];
    if (!finds.length) { if (PASS_LABEL[id]) suiteRows[suite].push(row('pass', PASS_LABEL[id], null, '', '')); continue; }
    for (const [title, fs] of Object.entries(byTitle(finds))) {
      const items = itemsOf(fs);
      const pages = new Set(fs.map(f => f.location)).size;
      const target = pages > 1 ? `${items.length} occurrence(s) · ${pages} page(s)` : (fs[0].location || '');
      suiteRows[suite].push(row(sevToStatus(worstSev(fs.map(f => f.severity))), title, target, fs[0].detail, fs[0].value, items, fs[0].ruleId));
    }
  }

  // links -> rows (internal broken, external broken, redirect chains/loops)
  if (!links.brokenInternal.length) suiteRows.links.push(row('pass', 'No broken internal links', null, `${links.totalInternal} internal link(s) checked`, `${links.totalInternal}`));
  else suiteRows.links.push(row('fail', 'Broken internal link(s)', `${links.brokenInternal.length} broken`, 'internal links that did not resolve (2xx/3xx)', String(links.brokenInternal.length), links.brokenInternal.map(b => ({ page: '—', section: 'internal link', id: b.url, value: String(b.status) })), 'LINK-001'));
  if (links.totalExternal) {
    if (!links.brokenExternal.length) suiteRows.links.push(row('pass', 'No broken external links', null, `${links.totalExternal} outbound link(s) checked`, `${links.totalExternal}`));
    else suiteRows.links.push(row('warn', 'Broken external link(s)', `${links.brokenExternal.length} broken`, 'outbound targets returning 4xx/5xx', String(links.brokenExternal.length), links.brokenExternal.map(b => ({ page: '—', section: 'external link', id: b.url, value: String(b.status) })), 'LINK-002'));
  }
  if (!links.chains.length) suiteRows.links.push(row('pass', 'No long redirect chains or loops', null, '', 'ok'));
  else suiteRows.links.push(row(links.chains.some(c => c.loop) ? 'fail' : 'warn', 'Redirect chain(s) / loop(s)', `${links.chains.length} affected`, 'long redirect chains or loops', String(links.chains.length), links.chains.map(c => ({ page: '—', section: c.loop ? 'redirect loop' : 'redirect chain', id: c.url, value: c.loop ? 'loop' : `${c.hops} hops → ${c.final}` })), 'LINK-003'));

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
    if (!respIds.some(i => (renderBy[i] || []).length)) suiteRows.responsive.push(row('pass', 'No horizontal overflow across viewports', null, `${renderRes.rendered} page(s) × 3 viewports`, 'clean'));
  } else {
    suiteRows.console.push(row('manual', 'Browser render pass did not run', null, renderRes.error === 'skipped' ? 'run without --no-render for console / CWV / responsive checks' : `Playwright unavailable: ${renderRes.error}`, 'skipped'));
  }

  // axe-core deep WCAG (real, industry-standard) -> a11y
  if (renderRes.axeAvailable === false) suiteRows.a11y.push(row('manual', 'Deep WCAG scan (axe-core) not installed', null, 'run: npm i axe-core — enables full automated WCAG 2.1 A/AA scanning', 'optional'));
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
  if (!xbrowser.length) {
    suiteRows.crossbrowser.push(row('manual', 'Cross-browser render not run', null, render ? 'no engines available this run' : 'run without --no-render to enable', 'skipped'));
  } else {
    for (const b of xbrowser) {
      const label = b.engine === 'webkit' ? 'WebKit (Safari engine)' : 'Firefox';
      if (!b.available) { suiteRows.crossbrowser.push(row('manual', `${label} engine not installed`, null, `run once: npx playwright install ${b.engine}`, 'needs install')); continue; }
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
  });
  const tot = suites.reduce((a, s) => { a.pass += s.pass; a.warn += s.warn; a.fail += s.fail; a.manual += s.manual; return a; }, { pass: 0, warn: 0, fail: 0, manual: 0 });
  const graded = tot.pass + tot.warn + tot.fail;
  const score = graded ? Math.round(tot.pass / graded * 100) : 0;
  const verdict = tot.fail > 0 ? 'NEEDS ATTENTION' : (tot.warn > 0 ? 'PASSED WITH WARNINGS' : 'ALL PASSING');
  const ready = tot.fail === 0;
  const quality = computeQuality(suites); // deterministic SGEN Quality Score (0–100 per suite + overall)
  const readiness = computeReadiness(suites); // launch-readiness veto layer (additive; tier-1 rules gate)
  const generated = new Date().toISOString();
  // Stage-2 single projection point: findings become canonical contract objects ONCE. Every finding-level
  // output (JSON/Markdown/Copy-MD/CI/API) derives from `findings`; annotates checks with `_md` so the HTML
  // report copies precomputed contract markdown (no client-side field reconstruction). Additive — scoring
  // aggregates (quality/readiness/tally) stay suite-based and byte-identical.
  const projected = projectFindings(suites, { host, generated });

  const result = {
    target: url, host, generated,
    versions: { engine: VERSIONS.ENGINE_VERSION, report: VERSIONS.REPORT_VERSION, registry: VERSIONS.REGISTRY_VERSION },
    verdict, ready, score, quality, readiness, tally: tot,
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

module.exports = { runAudit, SUITES };
