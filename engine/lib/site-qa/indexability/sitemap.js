'use strict';
// indexability/sitemap.js — fetch, parse and VALIDATE the sitemap set, in detail.
//
// WHAT WAS ALREADY THERE, AND WHY IT IS NOT ENOUGH. migration-qa/crawl.js already resolves sitemaps
// and expands them — but it is a page-DISCOVERY component, so it returns exactly what discovery needs:
// a flat, deduped, same-host list of page URLs plus a count. Everything a sitemap AUDIT needs is
// discarded on the way: which file each URL came from, whether the XML actually parsed, how many URLs
// a single file carries against the 50,000 limit, whether `<lastmod>` is a legal W3C datetime, whether
// a listed URL is even on this host. Re-deriving those from `pageUrls` is impossible — the information
// is gone. So this module fetches the sitemap set again, for the audit, and keeps the evidence.
//
// It does NOT change discovery. crawl.js keeps its own path; nothing here feeds back into which pages
// get crawled, so page selection is byte-identical to before this module existed.
//
// LIMITS ARE THE PROTOCOL'S, NOT OURS: 50,000 URLs and 50 MB uncompressed per file (sitemaps.org).
// Exceeding either means the file is rejected wholesale by Google and Bing — every URL in it, not the
// overflow. That is why it is a scored defect rather than a note.

const { getText, pool } = require('../../migration-qa/http');

const MAX_URLS_PER_FILE = 50000;
const MAX_BYTES_PER_FILE = 50 * 1024 * 1024;
const COMMON_SITEMAPS = ['/sitemap.xml', '/sitemap_index.xml', '/sitemap-index.xml', '/wp-sitemap.xml', '/sitemap.xml.gz'];

// W3C Datetime, the profile of ISO 8601 the sitemap protocol actually specifies. Anything else
// (US-format dates, epoch seconds, "2026-13-01") is ignored by consumers — silently, which is why the
// tool has to be the one to say it.
const W3C_DATETIME = /^\d{4}(-\d{2}(-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?)?)?$/;

function validLastmod(v) {
  const s = String(v || '').trim();
  if (!W3C_DATETIME.test(s)) return false;
  const d = new Date(s);
  return !Number.isNaN(d.getTime());
}

const tagAll = (xml, tag) => [...String(xml).matchAll(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'gi'))].map(m => m[1]);
const tagOne = (block, tag) => { const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(block); return m ? m[1].trim() : null; };
// Entity-decode the minimum a sitemap is required to escape. A `&amp;` left encoded turns a live URL
// into a 404 in this report, which is the tool manufacturing the very defect it is looking for.
const decodeEntities = (s) => String(s).replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#0?39;|&apos;/gi, "'");

const isIndex = (xml) => /<sitemapindex[\s>]/i.test(xml);
const looksXml = (body, contentType) => /xml/i.test(contentType || '') || /<\?xml|<urlset|<sitemapindex/i.test(String(body || '').slice(0, 4000));

// Parse one sitemap document into its entries, keeping per-entry evidence.
function parseSitemapDoc(xml) {
  const kind = isIndex(xml) ? 'index' : 'urlset';
  const blocks = tagAll(xml, kind === 'index' ? 'sitemap' : 'url');
  const entries = blocks.map((b) => {
    const loc = tagOne(b, 'loc');
    return {
      loc: loc ? decodeEntities(loc.trim()) : null,
      lastmod: tagOne(b, 'lastmod'),
      changefreq: kind === 'urlset' ? tagOne(b, 'changefreq') : null,
      priority: kind === 'urlset' ? tagOne(b, 'priority') : null,
    };
  });
  // Some generators emit bare <loc> with no <url> wrapper. Those URLs are real to a human reading the
  // file and invisible to a block-based parser, so they are recovered rather than silently lost — but
  // recorded as `looseLocs` so "the file is malformed" is still sayable.
  const wrapped = new Set(entries.map(e => e.loc).filter(Boolean));
  const looseLocs = tagAll(xml, 'loc').map(v => decodeEntities(v.trim())).filter(v => v && !wrapped.has(v));
  return { kind, entries, looseLocs };
}

// Resolve the sitemap URLs to try: robots.txt `Sitemap:` lines first (declared), then the common
// conventional paths (guessed). Which of the two a file came from is kept — "declared in robots.txt"
// and "we found it by guessing" are different facts about a site.
function candidateSitemaps(origin, robotsSitemaps = []) {
  const out = new Map();
  for (const s of robotsSitemaps) { const u = absolutize(s, origin); if (u) out.set(u, 'robots.txt'); }
  for (const p of COMMON_SITEMAPS) if (!out.has(origin + p)) out.set(origin + p, 'common-path');
  return [...out].map(([url, source]) => ({ url, source }));
}

function absolutize(u, origin) { try { return new URL(u, origin).href; } catch (e) { return null; } }
function hostOf(u) { try { return new URL(u).host; } catch (e) { return null; } }

// ---------------------------------------------------------------------------------------------
// Fetch and validate the whole sitemap set. Recurses index → children ONE level (the protocol allows
// exactly one level of nesting; deeper is itself a defect and is reported as `nestedTooDeep`).
async function collectSitemaps(origin, host, { robotsSitemaps = [], concurrency = 6 } = {}) {
  const files = [];
  const seen = new Set();
  const urlToFiles = new Map();     // page URL -> [sitemap file urls] (duplicate detection across files)

  async function fetchOne(url, source, depth) {
    if (seen.has(url)) return null;
    seen.add(url);
    const r = await getText(url);
    const bytes = Buffer.byteLength(String(r.body || ''), 'utf8');
    const rec = {
      url, source, depth,
      status: r.status || null,
      error: r.error || null,
      bytes,
      kind: null,
      urlCount: 0,
      // Every defect class this file exhibits, as flags rather than one collapsed verdict — a file can
      // be oversized AND carry bad lastmods, and a single string would lose one of them.
      problems: [],
      entries: [],
    };
    if (r.error || !r.status) { rec.problems.push('unreachable'); files.push(rec); return rec; }
    if (r.status >= 400) { rec.problems.push(source === 'robots.txt' ? 'declared-but-missing' : 'missing'); files.push(rec); return rec; }
    if (r.status >= 300) { rec.problems.push('redirect'); }
    // A .gz sitemap is legal and common. This engine reads text, so it is recorded as PRESENT and
    // UNPARSED rather than reported as malformed — claiming a valid compressed sitemap is broken would
    // be a false blocker, and "we did not read it" is the honest row.
    if (/\.gz$/i.test(url) && !looksXml(r.body, r.contentType)) { rec.problems.push('compressed-not-parsed'); files.push(rec); return rec; }
    if (!looksXml(r.body, r.contentType)) { rec.problems.push('not-xml'); files.push(rec); return rec; }

    const doc = parseSitemapDoc(r.body);
    rec.kind = doc.kind;
    rec.entries = doc.entries;
    if (doc.looseLocs.length) rec.problems.push('malformed-structure');
    const all = doc.entries.filter(e => e.loc).concat(doc.looseLocs.map(loc => ({ loc, lastmod: null })));
    rec.urlCount = all.length;
    if (!all.length) rec.problems.push('empty');
    if (all.length > MAX_URLS_PER_FILE) rec.problems.push('over-url-limit');
    if (bytes > MAX_BYTES_PER_FILE) rec.problems.push('over-size-limit');

    const badLastmod = doc.entries.filter(e => e.lastmod != null && !validLastmod(e.lastmod));
    if (badLastmod.length) { rec.problems.push('invalid-lastmod'); rec.badLastmod = badLastmod.slice(0, 25).map(e => ({ loc: e.loc, lastmod: e.lastmod })); }

    if (doc.kind === 'index') {
      if (depth >= 1) { rec.problems.push('nested-too-deep'); files.push(rec); return rec; }
      files.push(rec);
      const children = all.map(e => absolutize(e.loc, origin)).filter(Boolean);
      await pool(children, concurrency, (c) => fetchOne(c, 'sitemap-index', depth + 1));
      return rec;
    }

    // urlset: record every listed page URL, on-host or not.
    rec.pageUrls = [];
    for (const e of all) {
      const abs = absolutize(e.loc, origin);
      if (!abs) { rec.problems.push('unparsable-url'); continue; }
      rec.pageUrls.push(abs);
      if (!urlToFiles.has(abs)) urlToFiles.set(abs, []);
      urlToFiles.get(abs).push(url);
    }
    const foreign = rec.pageUrls.filter(u => hostOf(u) !== host);
    if (foreign.length) { rec.problems.push('foreign-host'); rec.foreignHost = foreign.slice(0, 25); }
    files.push(rec);
    return rec;
  }

  const candidates = candidateSitemaps(origin, robotsSitemaps);
  await pool(candidates, concurrency, (c) => fetchOne(c.url, c.source, 0));

  // ── A GUESS THAT MISSES IS NOT A DEFECT ────────────────────────────────────────────────────────
  // COMMON_SITEMAPS is five conventional paths tried blind. Most sites have exactly one sitemap, so
  // four of the five are always absent — and "absent" arrives in more shapes than 404. MEASURED on
  // sgen.com: /sitemap-index.xml and /sitemap_index.xml both answer `301 → /404?from=…`, so the file
  // was recorded as a redirect, then as not-XML, and the site was FAILED on SEO-043 for two paths it
  // never claimed to have. Its real /sitemap.xml was fine.
  //
  // So a GUESSED path only survives if it actually parsed as a sitemap. A path the site itself pointed
  // at — declared in robots.txt, or listed inside a sitemap index — is held to the full standard,
  // because there the site made the claim and the claim is broken.
  const real = files.filter(f => f.source !== 'common-path' || (f.kind && f.status && f.status < 300));
  const listed = [...urlToFiles.keys()];
  const onHost = listed.filter(u => hostOf(u) === host);
  const duplicates = [...urlToFiles.entries()].filter(([, fs]) => new Set(fs).size > 1).map(([u, fs]) => ({ url: u, files: [...new Set(fs)] }));

  return {
    files: real,
    // Every URL any sitemap listed, and the same list narrowed to this host. Both are needed: a
    // foreign-host entry is a defect that only exists in the difference between them.
    listedUrls: listed,
    onHostUrls: onHost,
    duplicates,
    found: real.some(f => f.status && f.status < 300 && (f.kind === 'urlset' || f.kind === 'index')),
    declaredInRobots: robotsSitemaps.length > 0,
    counts: {
      files: real.length,
      indexFiles: real.filter(f => f.kind === 'index').length,
      urlsetFiles: real.filter(f => f.kind === 'urlset').length,
      listed: listed.length,
      onHost: onHost.length,
      foreignHost: listed.length - onHost.length,
    },
  };
}

module.exports = {
  collectSitemaps, parseSitemapDoc, validLastmod, candidateSitemaps,
  MAX_URLS_PER_FILE, MAX_BYTES_PER_FILE, COMMON_SITEMAPS,
};
