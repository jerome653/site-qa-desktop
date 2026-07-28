'use strict';
// migration-qa/crawl.js — page discovery for a target site.
//
// Fixes the known gap in docs-qa-crawl.js (which read a single sitemap child): here we
// (1) find sitemaps from robots.txt + common locations, (2) recurse a sitemap INDEX into
// its child sitemaps, (3) dedup <loc>, then (4) link-follow same-host <a href> to catch
// live pages that no sitemap lists. Anonymous fetch = customer/crawler perspective.
//
// Returns raw fetched page records so the static checks can run on body+headers without refetching.

const { getText, abs, pool } = require('./http');

const COMMON_SITEMAPS = ['/sitemap.xml', '/sitemap_index.xml', '/sitemap-index.xml', '/wp-sitemap.xml'];

function sameHost(u, host) {
  try { return new URL(u).host === host; } catch (e) { return false; }
}

function extractLocs(xml) {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map(m => m[1].trim());
}
// A sitemap INDEX wraps children in <sitemap>...<loc>; a urlset wraps pages in <url>...<loc>.
function isIndex(xml) { return /<sitemapindex[\s>]/i.test(xml); }

// Resolve all sitemap URLs for the host: robots.txt Sitemap: lines + common paths.
async function findSitemaps(origin) {
  const found = new Set();
  const rob = await getText(origin + '/robots.txt');
  if (rob.ok && rob.status < 400) {
    for (const m of rob.body.matchAll(/^\s*sitemap:\s*(\S+)/gim)) {
      const u = abs(m[1].trim(), origin);
      if (u) found.add(u);
    }
  }
  for (const p of COMMON_SITEMAPS) found.add(origin + p);
  return [...found];
}

// Expand sitemaps (recursing indexes one level) into a deduped page-URL list, same-host only.
async function collectSitemapUrls(origin, host, conc) {
  const smUrls = await findSitemaps(origin);
  const pageUrls = new Set();
  const childSitemaps = new Set();

  await pool(smUrls, conc, async (sm) => {
    const r = await getText(sm);
    if (!r.ok || r.status >= 400 || !/xml/i.test(r.contentType || '') && !/<\?xml|<urlset|<sitemapindex/i.test(r.body)) return;
    if (isIndex(r.body)) { extractLocs(r.body).forEach(u => childSitemaps.add(u)); }
    else { extractLocs(r.body).forEach(u => { if (sameHost(u, host)) pageUrls.add(u); }); }
  });

  // one level of index expansion
  const children = [...childSitemaps].filter(u => !smUrls.includes(u));
  await pool(children, conc, async (sm) => {
    const r = await getText(sm);
    if (!r.ok || r.status >= 400) return;
    extractLocs(r.body).forEach(u => { if (sameHost(u, host)) pageUrls.add(u); });
  });

  return { pageUrls: [...pageUrls], sitemapCount: smUrls.length + children.length, hadSitemap: pageUrls.size > 0 };
}

function extractLinks(html, pageUrl, host) {
  const out = new Set();
  for (const m of html.matchAll(/<a\b[^>]*\shref\s*=\s*["']([^"'#?]+)[^"']*["']/gi)) {
    const a = abs(m[1].trim(), pageUrl);
    if (!a) continue;
    if (!sameHost(a, host)) continue;
    // skip obvious non-HTML assets
    if (/\.(png|jpe?g|gif|webp|svg|pdf|zip|mp4|mp3|css|js|ico|woff2?|ttf)(\?|$)/i.test(a)) continue;
    out.add(a.split('#')[0]);
  }
  return [...out];
}

// ---- STRATIFIED SAMPLING: one of each PAGE TYPE before a second of any -------------------------
// THE DEFECT THIS EXISTS TO KILL: a capped crawl took the sitemap's own order verbatim. A sitemap
// INDEX expands its children CONCURRENTLY (collectSitemapUrls' pool above), so whichever child
// sitemap answered FIRST filled every slot — on a blog-heavy site that is the post sitemap. Measured
// consequence: "Max pages 5" returned the homepage plus four blog posts. Four samples of ONE
// template, zero coverage of the pillar pages, the service pages, the contact form. The CAP was
// honest; the SAMPLE was not — and a report that audits one template while naming the whole site is
// the same class of lie as a suite that never ran scoring 100.
//
// Fix: bucket by TEMPLATE FAMILY (first path segment + depth — the cheapest signal that survives
// every CMS, needs no fetch and no config) and round-robin the buckets, shallowest family first, so
// page N+1 is always a type we have not looked at yet while any unseen type remains. Depth-first
// ordering is what makes "5 pages" mean home + four DIFFERENT top-level sections (the pillars)
// before any second post.
//
// Nothing is dropped — only reordered — so an UNCAPPED crawl fetches the byte-identical set. And
// because buckets and members are both sorted, the order is deterministic, which also removes the
// child-sitemap race: the same site now crawls the same pages in the same order every run.
function pageFamily(u) {
  let p;
  try { p = new URL(u).pathname.replace(/\/+$/, ''); } catch (e) { return 'zz-unparsable@9'; }
  const segs = p.split('/').filter(Boolean);
  if (!segs.length) return '@0';                                  // homepage / root
  return segs[0].toLowerCase() + '@' + segs.length;
}
const famDepth = (f) => +f.slice(f.lastIndexOf('@') + 1) || 0;

// Order `urls` so each successive page comes from the LEAST-sampled family. `seen` carries the
// families already fetched, so this works both for the initial seed (empty map) and for re-ordering
// the pending queue mid-crawl — link-follow on a site with NO sitemap otherwise re-creates the exact
// same defect, with nav order filling the cap from one family.
function stratify(urls, seen) {
  const buckets = new Map();
  for (const u of urls) {
    const f = pageFamily(u);
    if (!buckets.has(f)) buckets.set(f, []);
    buckets.get(f).push(u);
  }
  const keys = [...buckets.keys()].sort((a, b) => {
    const sa = (seen && seen.get(a)) || 0, sb = (seen && seen.get(b)) || 0;
    if (sa !== sb) return sa - sb;                                // least-sampled type first
    const da = famDepth(a), db = famDepth(b);
    return da - db || a.localeCompare(b);                         // then shallowest (pillars), then stable
  });
  for (const k of keys) buckets.get(k).sort();
  const out = [];
  for (let i = 0; ; i++) {
    let added = false;
    for (const k of keys) { const b = buckets.get(k); if (i < b.length) { out.push(b[i]); added = true; } }
    if (!added) break;
  }
  return out;
}

// Discover pages: sitemap first, then BFS link-follow for anything not listed, up to maxPages.
// fetchedPages carry { url, status, body, headers, contentType, location, error, errorCode } for reuse.
async function discoverPages(startUrl, { maxPages = 150, concurrency = 8, sitemapOnly = false, log = () => {} } = {}) {
  const start = new URL(startUrl);
  const origin = start.origin;
  const host = start.host;

  log(`Resolving sitemaps for ${origin} ...`);
  const { pageUrls, sitemapCount, hadSitemap } = await collectSitemapUrls(origin, host, concurrency);
  log(`Sitemaps: ${sitemapCount} · pages listed: ${pageUrls.length}`);

  const home = start.href.split('#')[0];
  const seed = new Set([home, ...pageUrls]);
  // In sitemap-only mode fetch the entire canonical documented set regardless of --max-pages, so the
  // completeness verdict is authoritative (uncapped) over exactly the pages both sitemaps declare.
  if (sitemapOnly) maxPages = Math.max(maxPages, seed.size);
  // Homepage ALWAYS first (it is the one page every report is expected to cover), then one of each
  // template family — see the stratify() block above for why sitemap order was the wrong sample.
  const seenFam = new Map();
  let queue = [home, ...stratify([...seed].filter(u => u !== home), seenFam)];
  const fetched = new Map();      // url -> record
  const enqueued = new Set(queue);
  let linkFollowed = 0;

  while (queue.length && fetched.size < maxPages) {
    // Cap each batch to the REMAINING budget, not a full `concurrency` slice — otherwise maxPages:1
    // still grabbed (and fetched) up to `concurrency` (8) pages before the loop re-checked the cap.
    // (sitemapOnly deliberately raised maxPages to the seed size above, so it is unaffected.)
    const batch = queue.splice(0, Math.max(0, Math.min(concurrency, maxPages - fetched.size)));
    const recs = await pool(batch, concurrency, async (u) => {
      const r = await getText(u);
      return { url: u, status: r.status, body: r.body, headers: r.headers, contentType: r.contentType, location: r.location, error: r.error, errorCode: r.errorCode };
    });
    let discovered = false;
    for (const rec of recs) {
      if (!rec || !rec.url) continue;
      fetched.set(rec.url, rec);
      const fam = pageFamily(rec.url); seenFam.set(fam, (seenFam.get(fam) || 0) + 1);
      // only link-follow real HTML 200s, and only to top up beyond the sitemap.
      // sitemapOnly mode = certify the canonical documented page set exactly (bounded → uncapped
      // → authoritative completeness); link-follow would re-introduce non-canonical URLs that keep
      // the crawl perpetually capped on pagination/query variants.
      const isHtml = /text\/html/i.test(rec.contentType || '') || /<html[\s>]/i.test(rec.body || '');
      if (!sitemapOnly && rec.status === 200 && isHtml && fetched.size < maxPages) {
        for (const link of extractLinks(rec.body || '', rec.url, host)) {
          if (!enqueued.has(link) && fetched.size + queue.length < maxPages) {
            enqueued.add(link); queue.push(link); discovered = true;
            if (!seed.has(link)) linkFollowed++;
          }
        }
      }
    }
    // Re-order what is still pending against what we have now actually sampled. Without this a
    // no-sitemap site falls straight back into the original defect: link-follow appends in nav order,
    // and nav order is one family deep (every post linked from the blog index) — so the cap fills
    // with one template again despite the seed having been stratified.
    if (discovered) queue = stratify(queue, seenFam);
  }

  const pages = [...fetched.values()];
  const capped = enqueued.size > fetched.size;
  log(`Crawled ${pages.length} pages (${linkFollowed} via link-follow${capped ? `, capped at --max-pages ${maxPages}` : ''})`);
  return { pages, origin, host, sitemapCount, hadSitemap, sitemapUrls: pageUrls, linkFollowed, capped, maxPages };
}

module.exports = { discoverPages, collectSitemapUrls, findSitemaps, extractLinks, sameHost, pageFamily, stratify };
