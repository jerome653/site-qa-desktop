'use strict';
// crawl-stratify.test.js — the capped crawl must SAMPLE the site, not read the sitemap top-down.
//
// THE DEFECT THIS PINS: discoverPages() seeded its queue with `[...seed]` — sitemap order — and a
// sitemap INDEX expands its children CONCURRENTLY, so whichever child answered first filled every
// slot. Reported 2026-07-20: "I asked it to scan 5 pages — it does home and blogs?" A 5-page scan of
// a blog-heavy site audited the homepage and four posts: four samples of ONE template, and no pillar
// page, no service page, no contact form. The cap was honest; the sample was not.
//
// These assertions are about the SHAPE of the sample, which is the thing that was wrong. They do not
// touch which pages exist (that is collectSitemapUrls' job and is unchanged).

const assert = require('assert');
const { pageFamily, stratify } = require('./crawl');

let n = 0, bad = 0;
const ok = (cond, msg) => { n++; if (cond) return; bad++; console.error('  FAIL: ' + msg); };

// ── 1) family = first path segment + depth ──────────────────────────────────────────────────────
ok(pageFamily('https://x.com/') === '@0', 'root is its own family');
ok(pageFamily('https://x.com') === '@0', 'root without trailing slash is the same family');
ok(pageFamily('https://x.com/about') === 'about@1', 'top-level page');
ok(pageFamily('https://x.com/blog/a-post') === 'blog@2', 'section child carries section + depth');
ok(pageFamily('https://x.com/blog/') === 'blog@1', 'section index is NOT the same family as its children');
ok(pageFamily('https://x.com/BLOG/Post') === 'blog@2', 'family is case-insensitive');

// ── 2) THE REPORTED BUG: 5 pages of a blog-heavy sitemap ────────────────────────────────────────
// Sitemap order puts every post first — exactly what a WP post-sitemap answering first produces.
const blogHeavy = [
  'https://x.com/blog/post-1', 'https://x.com/blog/post-2', 'https://x.com/blog/post-3',
  'https://x.com/blog/post-4', 'https://x.com/blog/post-5', 'https://x.com/blog/post-6',
  'https://x.com/services', 'https://x.com/about', 'https://x.com/contact',
  'https://x.com/services/web-design',
];
const sampled = stratify(blogHeavy, new Map()).slice(0, 4);   // 4 = the 5-page cap minus the homepage
const fams = sampled.map(pageFamily);
ok(new Set(fams).size === 4, 'a 5-page scan takes FOUR DIFFERENT page types, not four of one — got ' + JSON.stringify(fams));
ok(sampled.filter(u => /\/blog\//.test(u)).length <= 1, 'at most ONE blog post in the first four — was four');
['about', 'contact', 'services'].forEach(p =>
  ok(sampled.some(u => u === 'https://x.com/' + p), `the ${p} pillar page is reached at maxPages 5 (it never was)`));

// ── 3) shallowest first: pillars before section children ────────────────────────────────────────
const depths = stratify(blogHeavy, new Map()).slice(0, 3).map(u => famDepthOf(u));
function famDepthOf(u) { const f = pageFamily(u); return +f.slice(f.lastIndexOf('@') + 1); }
ok(depths.every(d => d === 1), 'top-level pages are sampled before any section child — got depths ' + JSON.stringify(depths));

// ── 4) nothing is dropped — an UNCAPPED crawl is the identical SET ──────────────────────────────
// This is what makes the change safe to ship: only the ORDER moved, so every existing full-site scan
// fetches exactly what it fetched before and no stored result changes meaning.
const all = stratify(blogHeavy, new Map());
ok(all.length === blogHeavy.length, 'no page is lost by reordering');
ok(JSON.stringify([...all].sort()) === JSON.stringify([...blogHeavy].sort()), 'the reordered set is the SAME set');

// ── 5) deterministic — the same site crawls the same pages in the same order every run ──────────
// The child-sitemap pool made this false before: two runs of one site could audit different pages,
// so "compare against the last scan" was comparing different samples.
const shuffled = [...blogHeavy].reverse();
ok(JSON.stringify(stratify(shuffled, new Map())) === JSON.stringify(all), 'input order does not change output order');

// ── 6) `seen` steers the pending queue toward what has NOT been sampled ─────────────────────────
// This is the link-follow path (a site with no sitemap): without it, nav order refills the cap from
// one family and the defect returns by the back door.
const seen = new Map([['blog@2', 6], ['about@1', 0]]);
const next = stratify(['https://x.com/blog/post-9', 'https://x.com/about'], seen);
ok(next[0] === 'https://x.com/about', 'an unsampled family outranks one we already have six of');

// ── 7) degenerate inputs do not throw ───────────────────────────────────────────────────────────
ok(stratify([], new Map()).length === 0, 'empty input is empty output');
ok(stratify(['not a url'], new Map()).length === 1, 'an unparsable URL is kept, not dropped');

console.log((bad ? 'FAIL' : 'PASS') + ' crawl-stratify.test.js — ' + (n - bad) + '/' + n + ' assertions');
if (bad) process.exit(1);
