'use strict';
// page-coverage.test.js — deterministic suite for buildPageCoverage() (audit.js).
//
// buildPageCoverage is PURE — it turns the facts a crawl already collected (crawl.pages = every page
// fetched with its status, crawl.sitemapUrls = the sitemap URL list, crawl.capped/maxPages) plus the
// htmlPages set (the pages that WERE audited) into the coverage surface the report exposes: which URLs
// were audited, which errored (fetched but non-200 or non-html), and which the sitemap listed but the
// crawl never reached (capped by maxPages). So every branch is provable here without a browser or a
// live host, matching this repo's no-browser test convention (grade.test.js / diagnose.test.js build
// their run fixtures the same way). Locks the coverage math that lets an operator SEE crawl coverage
// instead of a bare page count, and the full guarding that keeps an OLD result without pageCoverage
// unaffected: an undefined crawl must yield empty arrays + zero counts, never a throw.
const { buildPageCoverage } = require('./audit');

let pass = 0, fail = 0; const failures = [];
function ok(c, n) { if (c) pass++; else { fail++; failures.push(n); console.log('  ✗ ' + n); } }
function eq(a, b, n) { const p = JSON.stringify(a) === JSON.stringify(b); ok(p, n + (p ? '' : ` (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`)); }

// page builder — the shape crawl.pages carries (url + status + contentType + body). htmlPages is the
// already-filtered subset (status 200 + html) the auditor actually graded, so fixtures can't drift from
// the runAudit contract that computes `htmlPages` and passes it straight into buildPageCoverage.
const page = (url, status, o = {}) => ({ url, status, contentType: status === 200 ? 'text/html' : '', body: status === 200 ? '<html></html>' : '', ...o });

console.log('buildPageCoverage() — site-audit page coverage — test suite\n');

// ── 1 · audited — two 200+html pages, both in the htmlPages set → both listed as audited, none errored ──
(function audited() {
  const p1 = page('https://x.com/', 200);
  const p2 = page('https://x.com/about', 200);
  const cov = buildPageCoverage({ pages: [p1, p2], sitemapUrls: [], capped: false, maxPages: 150 }, [p1, p2]);
  eq(cov.audited, ['https://x.com/', 'https://x.com/about'], 'audited: both 200+html urls are listed as audited');
  eq(cov.counts.audited, 2, 'audited: counts.audited is 2');
  eq(cov.errored, [], 'audited: nothing errored when every fetched page was audited');
})();

// ── 2 · errored — a 404 + a 403 (and a 200 non-html) fetched but NOT audited → listed with status ──
(function errored() {
  const ok200 = page('https://x.com/', 200);
  const p404 = page('https://x.com/missing', 404);
  const p403 = page('https://x.com/blocked', 403);
  const pNonHtml = page('https://x.com/feed.xml', 200, { contentType: 'application/xml', body: '<rss/>' });
  // htmlPages = only the one real audited page. The non-html 200 is NOT in it, so it must land in errored.
  const cov = buildPageCoverage({ pages: [ok200, p404, p403, pNonHtml], sitemapUrls: [] }, [ok200]);
  eq(cov.errored, [
    { url: 'https://x.com/missing', status: 404 },
    { url: 'https://x.com/blocked', status: 403 },
    { url: 'https://x.com/feed.xml', status: 200 },
  ], 'errored: a 404, a 403 and a non-html 200 are each listed with {url,status}');
  eq(cov.audited, ['https://x.com/'], 'errored: only the 200+html page is audited');
  ok(!cov.audited.includes('https://x.com/missing') && !cov.audited.includes('https://x.com/blocked'), 'errored: audited excludes the non-200 pages');
  eq(cov.counts.errored, 3, 'errored: counts.errored is 3');
})();

// ── 3 · notReached — a sitemap url never fetched is listed; one that WAS fetched is not ──
(function notReached() {
  const fetched = page('https://x.com/', 200);
  const cov = buildPageCoverage({ pages: [fetched], sitemapUrls: ['https://x.com/', 'https://x.com/orphan'] }, [fetched]);
  ok(cov.notReached.includes('https://x.com/orphan'), 'notReached: a sitemap url never fetched is listed');
  ok(!cov.notReached.includes('https://x.com/'), 'notReached: a sitemap url that WAS fetched is NOT listed');
  eq(cov.notReached, ['https://x.com/orphan'], 'notReached: exactly the un-fetched sitemap url');
  eq(cov.counts.notReached, 1, 'notReached: counts.notReached is 1');
})();

// ── 4 · capped/maxPages passthrough + counts.discovered = audited + errored + notReached ──
(function cappedAndDiscovered() {
  const a = page('https://x.com/', 200);
  const b404 = page('https://x.com/gone', 404);
  const cov = buildPageCoverage(
    { pages: [a, b404], sitemapUrls: ['https://x.com/', 'https://x.com/unseen'], capped: true, maxPages: 150 },
    [a],
  );
  eq(cov.capped, true, 'capped: the crawl-capped flag passes through as boolean true');
  eq(cov.maxPages, 150, 'capped: maxPages passes through');
  // audited 1 (a) + errored 1 (b404) + notReached 1 (/unseen) = 3
  eq(cov.counts.discovered, 3, 'counts: discovered = audited + errored + notReached = 3');
  eq(cov.counts.discovered, cov.counts.audited + cov.counts.errored + cov.counts.notReached, 'counts: discovered equals the sum of the three buckets');
})();

// ── 5 · empty / undefined crawl — all arrays empty, all counts 0, never a throw (old-result guard) ──
(function emptyAndGuarded() {
  const empty = buildPageCoverage(undefined, undefined);
  eq(empty.audited, [], 'empty: undefined crawl → audited []');
  eq(empty.errored, [], 'empty: undefined crawl → errored []');
  eq(empty.notReached, [], 'empty: undefined crawl → notReached []');
  eq(empty.capped, false, 'empty: undefined crawl → capped false');
  eq(empty.counts, { audited: 0, errored: 0, notReached: 0, discovered: 0 }, 'empty: undefined crawl → all counts 0');

  let threw = false;
  try { buildPageCoverage(); } catch (e) { threw = true; }
  ok(!threw, 'empty: called with NO args at all does not throw');

  const emptyObj = buildPageCoverage({}, []);
  eq(emptyObj.counts.discovered, 0, 'empty: an empty-object crawl → discovered 0');
})();

console.log('\n' + (fail === 0 ? '✅ PASS' : '❌ FAIL') + ` — ${pass}/${pass + fail} assertions`);
if (fail) { console.log('Failures:\n' + failures.map(f => '  - ' + f).join('\n')); process.exit(1); }
