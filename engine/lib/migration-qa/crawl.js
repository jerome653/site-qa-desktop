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

// Discover pages: sitemap first, then BFS link-follow for anything not listed, up to maxPages.
// fetchedPages carry { url, status, body, headers, contentType, location, error } for reuse.
async function discoverPages(startUrl, { maxPages = 150, concurrency = 8, sitemapOnly = false, log = () => {} } = {}) {
  const start = new URL(startUrl);
  const origin = start.origin;
  const host = start.host;

  log(`Resolving sitemaps for ${origin} ...`);
  const { pageUrls, sitemapCount, hadSitemap } = await collectSitemapUrls(origin, host, concurrency);
  log(`Sitemaps: ${sitemapCount} · pages listed: ${pageUrls.length}`);

  const seed = new Set([start.href.split('#')[0], ...pageUrls]);
  // In sitemap-only mode fetch the entire canonical documented set regardless of --max-pages, so the
  // completeness verdict is authoritative (uncapped) over exactly the pages both sitemaps declare.
  if (sitemapOnly) maxPages = Math.max(maxPages, seed.size);
  const queue = [...seed];
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
      return { url: u, status: r.status, body: r.body, headers: r.headers, contentType: r.contentType, location: r.location, error: r.error };
    });
    for (const rec of recs) {
      if (!rec || !rec.url) continue;
      fetched.set(rec.url, rec);
      // only link-follow real HTML 200s, and only to top up beyond the sitemap.
      // sitemapOnly mode = certify the canonical documented page set exactly (bounded → uncapped
      // → authoritative completeness); link-follow would re-introduce non-canonical URLs that keep
      // the crawl perpetually capped on pagination/query variants.
      const isHtml = /text\/html/i.test(rec.contentType || '') || /<html[\s>]/i.test(rec.body || '');
      if (!sitemapOnly && rec.status === 200 && isHtml && fetched.size < maxPages) {
        for (const link of extractLinks(rec.body || '', rec.url, host)) {
          if (!enqueued.has(link) && fetched.size + queue.length < maxPages) {
            enqueued.add(link); queue.push(link);
            if (!seed.has(link)) linkFollowed++;
          }
        }
      }
    }
  }

  const pages = [...fetched.values()];
  const capped = enqueued.size > fetched.size;
  log(`Crawled ${pages.length} pages (${linkFollowed} via link-follow${capped ? `, capped at --max-pages ${maxPages}` : ''})`);
  return { pages, origin, host, sitemapCount, hadSitemap, sitemapUrls: pageUrls, linkFollowed, capped, maxPages };
}

module.exports = { discoverPages, collectSitemapUrls, findSitemaps, extractLinks, sameHost };
