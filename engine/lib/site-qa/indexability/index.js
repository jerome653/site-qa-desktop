'use strict';
// indexability/ — "can Google and Bing actually index this page?", answered per URL, from evidence.
//
// ── THE QUESTION THIS ANSWERS, AND THE ONE IT DOES NOT ────────────────────────────────────────────
// INDEXABLE and INDEXED are different facts and this module only ever claims the first.
//
//   INDEXABLE (what ships here) — every technical gate between a search crawler and the index, checked
//   against evidence this run fetched: HTTP status, robots.txt as the named agent reads it, meta
//   robots, X-Robots-Tag, canonical, content type, and whether the sitemap agrees with any of it.
//   Deterministic, offline, zero-cost, same answer on every run.
//
//   INDEXED (what does NOT ship here) — "is this URL in Google's index right now". That is not
//   derivable from the site. It requires a credentialed API per engine (Search Console URL Inspection;
//   Bing Webmaster URL Info), each needing verified ownership of the property. The other route —
//   scraping `site:` queries — is non-deterministic, rate-limited into captcha within a few dozen
//   URLs, and against both engines' terms; a check whose answer depends on whether a captcha fired is
//   not a check this engine is allowed to ship (see the determinism clause in CHARTER.md).
//
// So the report states index STATUS as NOT MEASURED, names why, and never estimates it. `indexStatus`
// travels on the data as an explicit not-measured object rather than being absent, for the same reason
// techStack.note travels with techStack: a surface must not be able to render the result without the
// caveat that makes it honest.
//
// ── WHY THE PER-URL TABLE EXISTS ──────────────────────────────────────────────────────────────────
// Every input below was already being fetched, and each was already checked in isolation: SEO-007 sees
// noindex, SEO-020 sees a blanket robots block, SEO-005/006 see canonicals, SEO-023 sees dead sitemap
// URLs. What no rule could see is the INTERSECTION — a URL the sitemap advertises, that robots.txt
// forbids, that carries a noindex nobody will ever read because the crawler is not allowed to fetch it.
// That page is not in the index and no existing row says so. The verdict table is that join.

const { get, getText, pool } = require('../../migration-qa/http');
const { buildRobots, SEARCH_AGENTS } = require('./robots');
const { collectSitemaps } = require('./sitemap');
const { probeDiscovery } = require('./discovery');
const { scanSchema } = require('./schema');

// How many sitemap URLs the crawl did NOT already fetch will be probed for status + headers. A sitemap
// can list 50,000 URLs; probing all of them is a load test, not an audit. The cap is DECLARED on the
// result (`probe.capped` / `probe.notProbed`) so a partial sweep can never read as a complete one.
const DEFAULT_PROBE_CAP = 500;

const NOINDEX = /\bnoindex\b/i;
const NONE = /\bnone\b/i;                 // `none` === `noindex, nofollow`
const isHtmlLike = (contentType, body) => /text\/html|application\/xhtml/i.test(contentType || '') || /<html[\s>]/i.test(String(body || '').slice(0, 2000));

// ---- directive extraction ----------------------------------------------------------------------

// <meta name="robots|googlebot|bingbot" content="…">. Agent-specific tags OVERRIDE the generic one for
// that agent — a page with `robots: noindex` and `googlebot: index` is indexable in Google and not in
// Bing, and collapsing the two into one field would report both engines wrong.
function metaRobotsFrom(html) {
  const out = { all: null, googlebot: null, bingbot: null };
  for (const m of String(html || '').matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    const name = (/name\s*=\s*["']([^"']+)["']/i.exec(tag) || [])[1];
    if (!name) continue;
    const key = name.trim().toLowerCase();
    if (key !== 'robots' && key !== 'googlebot' && key !== 'bingbot') continue;
    const content = (/content\s*=\s*["']([^"']*)["']/i.exec(tag) || [])[1];
    if (content == null) continue;
    const slot = key === 'robots' ? 'all' : key;
    out[slot] = out[slot] ? `${out[slot]}, ${content.trim()}` : content.trim();
  }
  return out;
}

// X-Robots-Tag, including the agent-scoped form `X-Robots-Tag: googlebot: noindex`. Multiple headers
// are joined by the fetch layer into one comma-separated value, so the parse works off the whole string.
function xRobotsFrom(headers) {
  const raw = (headers || {})['x-robots-tag'];
  const out = { all: null, googlebot: null, bingbot: null, raw: raw || null };
  if (!raw) return out;
  for (const part of String(raw).split(',')) {
    const seg = part.trim();
    if (!seg) continue;
    const scoped = /^([a-z0-9_-]+)\s*:\s*(.+)$/i.exec(seg);
    if (scoped && ['googlebot', 'bingbot'].includes(scoped[1].toLowerCase())) {
      const k = scoped[1].toLowerCase();
      out[k] = out[k] ? `${out[k]}, ${scoped[2].trim()}` : scoped[2].trim();
    } else {
      out.all = out.all ? `${out.all}, ${seg}` : seg;
    }
  }
  return out;
}

function canonicalFrom(html, pageUrl) {
  const m = /<link\b[^>]*rel\s*=\s*["']?canonical["']?[^>]*>/i.exec(String(html || ''));
  if (!m) return null;
  const href = (/href\s*=\s*["']([^"']*)["']/i.exec(m[0]) || [])[1];
  if (!href || !href.trim()) return null;
  try { return new URL(href.trim(), pageUrl).href; } catch (e) { return null; }
}

// Trailing slash and the default port are not a canonical disagreement; a different path is. Comparing
// raw strings would report every site that canonicalises `/about` from `/about/` as broken.
function sameUrl(a, b) {
  if (!a || !b) return false;
  try {
    const ua = new URL(a), ub = new URL(b);
    const norm = (u) => (u.protocol + '//' + u.host + u.pathname.replace(/\/+$/, '') + u.search).toLowerCase();
    return norm(ua) === norm(ub);
  } catch (e) { return a === b; }
}

// ---- the verdict ------------------------------------------------------------------------------

const VERDICTS = ['indexable', 'blocked-robots', 'noindex', 'canonicalized-away', 'redirect', 'error', 'non-html', 'not-checked'];

// One agent's verdict for one URL, with every reason kept. Ordering is a precedence decision, not a
// style one: a 404 that also carries noindex is a 404 — reporting the noindex would send someone to
// edit a meta tag on a page that does not exist.
function verdictFor(rec, agentToken) {
  const reasons = [];
  if (!rec.checked) return { verdict: 'not-checked', reasons: ['not fetched in this run'] };
  if (rec.error || !rec.status) return { verdict: 'error', reasons: [rec.error ? `request failed: ${rec.error}` : 'no response'] };
  if (rec.status >= 400) return { verdict: 'error', reasons: [`HTTP ${rec.status}`] };
  if (rec.status >= 300) return { verdict: 'redirect', reasons: [`HTTP ${rec.status}${rec.redirectTo ? ` → ${rec.redirectTo}` : ''}`] };

  const robots = rec.robots[agentToken === 'googlebot' ? 'google' : 'bing'];
  const blocked = robots && !robots.allowed;

  const meta = rec.metaRobots || {};
  const xr = rec.xRobotsTag || {};
  const agentDirective = agentToken === 'googlebot' ? (meta.googlebot || xr.googlebot) : (meta.bingbot || xr.bingbot);
  const generic = [meta.all, xr.all].filter(Boolean).join(', ');
  const effective = agentDirective != null ? agentDirective : generic;
  const noindexed = !!effective && (NOINDEX.test(effective) || NONE.test(effective));

  if (blocked) {
    reasons.push(`robots.txt disallows this path${robots.rule ? ` (${robots.rule})` : ''}`);
    // THE TRAP, named on the row. A URL that is both robots-disallowed and noindex is the worst of both:
    // the crawler may not fetch the page, so it never READS the noindex, and the URL can stay in the
    // index indefinitely as a bare link. The two directives are individually correct and together they
    // do the opposite of what was intended — which is exactly why no single-directive rule finds it.
    if (noindexed) reasons.push('a noindex is set but robots.txt prevents the crawler from ever reading it — the URL can remain indexed');
    return { verdict: 'blocked-robots', reasons, noindexUnreadable: noindexed };
  }
  if (noindexed) { reasons.push(`noindex directive: "${effective}"`); return { verdict: 'noindex', reasons }; }
  if (!rec.isHtml) { reasons.push(`content-type ${rec.contentType || 'unknown'} — not an indexable HTML document`); return { verdict: 'non-html', reasons }; }
  if (rec.canonical && !rec.canonicalSelf) { reasons.push(`canonical points to ${rec.canonical}`); return { verdict: 'canonicalized-away', reasons }; }
  return { verdict: 'indexable', reasons: ['crawlable, no noindex, self-canonical'] };
}

// ---- the scan ---------------------------------------------------------------------------------

// `crawlPages` are the FULL crawl records (status/headers/body), not the {url,html} pairs the advisory
// pipeline sees — this runs inside audit.js precisely because the headers are needed and the advisory
// seam throws them away.
// ── `siteLevel: false` — THE SINGLE-PAGE CONTRACT ────────────────────────────────────────────────
// Content & SEO's "This page" scope promises exactly one thing: no page other than the URL you gave it
// is ever fetched. That is asserted by seo-split.test.js against a fixture that logs every request, and
// it caught this module red-handed — expanding the sitemap and HEAD-probing /a, /b and /c on a run the
// operator had scoped to one page. Three pages fetched that the operator had just said not to fetch.
//
// So on a single-page run this pass does robots.txt and the one page's verdict, and nothing else. The
// sitemap set, the URL probe and the well-known discovery sweep are all SITE-level questions — like
// duplicate-title, they cannot mean anything for one page, and the caller declares their checks
// not-applicable rather than passing them. robots.txt alone is kept because it is the only thing that
// makes "is THIS page indexable" answerable at all, and the site-check pass already fetches it.
// `knownSitemapUrls` — membership the CRAWL already established, at no extra cost.
// A single-page run still resolves sitemaps for page DISCOVERY (crawl.js does it to build the seed), so
// `crawl.sitemapUrls` is populated even when this pass is forbidden from fetching sitemaps itself. Not
// using it reported "not checked" for a URL whose membership was sitting in the crawl result — a weaker
// claim than the evidence supported, which is its own kind of wrong. Membership and VALIDATION are now
// separate: membership comes free from the crawl, while file validation (limits, lastmod, foreign hosts)
// genuinely needs the extra fetches and stays site-level only.
async function scanIndexability({ origin, host, crawlPages = [], knownSitemapUrls = null, probeCap = DEFAULT_PROBE_CAP, concurrency = 6, siteLevel = true, log = () => {} } = {}) {
  // 1) robots.txt, fetched once and parsed properly (per-agent groups, longest-match rules).
  // getText, NOT a raw get: it is the fetch helper the whole engine shares, so it returns the parsed
  // {status, body, error} shape and — the part that matters — it is the seam the test suite stubs.
  // Reaching past it meant this pass made a live DNS lookup inside a fully-mocked run, came back
  // `unreachable`, and reported the crawl gate as unverifiable on a page the fixture had served.
  const rob = await getText(origin + '/robots.txt');
  const robots = buildRobots({ status: rob.status, body: rob.body, error: rob.error });

  // 2) the sitemap set, validated (see sitemap.js for why crawl.js's output cannot be reused).
  const EMPTY_SITEMAPS = { files: [], listedUrls: [], onHostUrls: [], duplicates: [], found: false, declaredInRobots: robots.sitemaps.length > 0, counts: { files: 0, indexFiles: 0, urlsetFiles: 0, listed: 0, onHost: 0, foreignHost: 0 }, notRun: 'single-page-scope' };
  const sitemaps = siteLevel
    ? await collectSitemaps(origin, host, { robotsSitemaps: robots.sitemaps, concurrency })
    : EMPTY_SITEMAPS;

  // 3) build the URL universe: everything crawled + every on-host URL any sitemap listed.
  const byUrl = new Map();
  const norm = (u) => { try { const x = new URL(u); x.hash = ''; return x.href; } catch (e) { return u; } };

  // ── `inSitemap` IS THREE-VALUED, NOT TWO ────────────────────────────────────────────────────────
  // true = listed · false = looked and it is not listed · NULL = never looked.
  // On a single-page run the sitemap set is deliberately not fetched (the contract above), so `false`
  // there is a claim of absence from a check that never ran. MEASURED: a "This page" run against
  // /local-seo-aeo reported "not in sitemap" for a URL the whole-site run proves IS in the sitemap.
  // That is the same defect class as the dead-host green tick and redirect-means-absent — this engine's
  // one standing rule is that not-looked and not-there must never render the same.
  // Membership is established when THIS pass read the sitemaps (siteLevel) or when the CRAWL already
  // did and handed the list over. Only when neither happened is it genuinely unknown.
  const membershipKnown = siteLevel || (Array.isArray(knownSitemapUrls) && knownSitemapUrls.length > 0);
  const sitemapUnknown = !membershipKnown;
  for (const p of crawlPages.filter(Boolean)) {
    const url = norm(p.url);
    byUrl.set(url, {
      url, inSitemap: sitemapUnknown ? null : false, checked: true, source: 'crawl',
      status: p.status || 0, error: p.error || null, redirectTo: p.location || null,
      contentType: p.contentType || '', isHtml: isHtmlLike(p.contentType, p.body),
      metaRobots: metaRobotsFrom(p.body), xRobotsTag: xRobotsFrom(p.headers),
      canonical: canonicalFrom(p.body, p.url),
    });
  }
  // Membership flags come from whichever source established them. When only the CRAWL knows (a
  // single-page run), flag the pages we HAVE and do NOT mint rows for the other 89 — the operator asked
  // for one page and the table must show one page.
  const sitemapSet = new Set((siteLevel ? sitemaps.onHostUrls : (knownSitemapUrls || [])).map(norm));
  for (const u of sitemapSet) {
    if (byUrl.has(u)) { byUrl.get(u).inSitemap = true; continue; }
    if (!siteLevel) continue;                    // crawl-sourced membership: flag only, never expand
    byUrl.set(u, { url: u, inSitemap: true, checked: false, source: 'sitemap', status: 0, error: null, redirectTo: null, contentType: '', isHtml: false, metaRobots: { all: null }, xRobotsTag: { all: null }, canonical: null });
  }

  // 4) probe the sitemap URLs the crawl never fetched. Bounded and DECLARED — "all sitemap links are
  //    live" must not be inferred from a sample. A HEAD carries status, content-type and X-Robots-Tag,
  //    which is every header-borne signal; only the meta tag needs a body, and that limit is stated on
  //    the row rather than papered over.
  const unprobed = [...byUrl.values()].filter(r => !r.checked);
  const toProbe = siteLevel ? unprobed.slice(0, probeCap) : [];
  if (toProbe.length) log(`Indexability: probing ${toProbe.length} sitemap URL(s) not reached by the crawl ...`);
  await pool(toProbe, concurrency, async (rec) => {
    try {
      let r = await get(rec.url, { method: 'HEAD' });
      if (r.status === 405 || r.status === 501) r = await get(rec.url, { method: 'GET' });
      const headers = {}; r.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
      rec.checked = true;
      rec.status = r.status;
      rec.redirectTo = r.headers.get('location') || null;
      rec.contentType = headers['content-type'] || '';
      rec.isHtml = isHtmlLike(rec.contentType, '');
      rec.xRobotsTag = xRobotsFrom(headers);
      rec.headOnly = true;   // no body was read, so meta robots + canonical are UNKNOWN for this URL
    } catch (e) {
      rec.checked = true; rec.status = 0; rec.error = String(e && e.message || e);
    }
  });

  // 5) robots decision + per-engine verdict for every URL.
  const urls = [...byUrl.values()].sort((a, b) => a.url.localeCompare(b.url));
  for (const rec of urls) {
    rec.canonicalSelf = rec.canonical ? sameUrl(rec.canonical, rec.url) : true;
    rec.robots = {
      google: robots.allows('googlebot', rec.url),
      bing: robots.allows('bingbot', rec.url),
    };
    const g = verdictFor(rec, 'googlebot');
    const b = verdictFor(rec, 'bingbot');
    rec.verdict = { google: g.verdict, bing: b.verdict };
    rec.reasons = { google: g.reasons, bing: b.reasons };
    rec.noindexUnreadable = !!(g.noindexUnreadable || b.noindexUnreadable);
    // One headline verdict for the table: the engines agree on the overwhelming majority of URLs, and
    // when they disagree THAT is the finding, so the disagreement is flagged rather than averaged.
    rec.agree = rec.verdict.google === rec.verdict.bing;
  }

  const count = (engine, v) => urls.filter(r => r.verdict[engine] === v).length;
  const summary = {
    total: urls.length,
    crawled: urls.filter(r => r.source === 'crawl').length,
    inSitemap: urls.filter(r => r.inSitemap).length,
    // Whether sitemap membership was established at all. Without this a renderer cannot tell "0 of these
    // are listed" from "we never opened the sitemap", and would print the first while meaning the second.
    // True when the crawl established it too — membership and file-validation are different questions.
    sitemapKnown: membershipKnown,
    probed: toProbe.length,
    notProbed: Math.max(0, unprobed.length - toProbe.length),
    capped: unprobed.length > toProbe.length,
    google: Object.fromEntries(VERDICTS.map(v => [v, count('google', v)])),
    bing: Object.fromEntries(VERDICTS.map(v => [v, count('bing', v)])),
    disagree: urls.filter(r => !r.agree).map(r => ({ url: r.url, google: r.verdict.google, bing: r.verdict.bing })),
  };

  // 6) the sitemap↔indexability contradictions — the join that no single rule could see.
  const inSm = urls.filter(r => r.inSitemap && r.checked);
  const conflicts = {
    blocked: inSm.filter(r => r.verdict.google === 'blocked-robots' || r.verdict.bing === 'blocked-robots'),
    noindex: inSm.filter(r => r.verdict.google === 'noindex' || r.verdict.bing === 'noindex'),
    // headOnly URLs have no body, so canonical is UNKNOWN, not absent — excluded rather than assumed
    // self-canonical, which would bank a pass this run did not earn.
    nonCanonical: inSm.filter(r => !r.headOnly && r.canonical && !r.canonicalSelf),
    redirect: inSm.filter(r => r.verdict.google === 'redirect'),
    dead: inSm.filter(r => r.verdict.google === 'error'),
    noindexUnreadable: urls.filter(r => r.noindexUnreadable),
  };

  // 7) the discovery surface (llms.txt, ai.txt, security.txt, YAML/JSON descriptors, app-association)
  //    and the deeper schema pass. Both advisory — see discovery.js / schema.js headers.
  const home = crawlPages.find(p => p && sameUrl(p.url, origin + '/')) || crawlPages[0] || {};
  const discovery = siteLevel
    ? await probeDiscovery(origin, { homeHtml: home.body || '', homeUrl: home.url || origin })
    : { files: [], present: [], invalid: [], feeds: [], byKey: {}, notRun: 'single-page-scope' };
  // Schema needs NO extra request — it reads the HTML this run already fetched — so it runs in both
  // scopes. A one-page run still gets its structured data validated.
  //
  // HTML 200s ONLY, which is the same population every other static check in the engine runs over.
  // MEASURED on a real 119-page run: the crawl held 92 HTML pages and 27 redirects/errors, and scanning
  // all 119 reported schema on 93 — so at least one NON-200 record carried JSON-LD. SEO-049 is SCORED,
  // which means a redirect page's leftover markup could deduct points from a site whose real pages are
  // clean. Same false-positive class as the redirect-is-absent gate above, one layer along.
  const schemaPages = crawlPages.filter(p => p && p.status === 200 && isHtmlLike(p.contentType, p.body));
  const schema = scanSchema(schemaPages.map(p => ({ url: p.url, html: p.body })));

  return {
    // What this pass was allowed to look at. Read by the caller to decide which check families may be
    // declared evaluated — a site-level rule must not bank a pass on a run that never looked.
    siteLevel,
    robots: {
      state: robots.state, status: robots.status, sitemapsDeclared: robots.sitemaps,
      namedAgents: robots.namedAgents, crawlDelay: robots.crawlDelay,
      // Whether robots.txt blocks a NAMED search engine while the site is otherwise open. This is the
      // literal "is it searchable on Google and Bing" gate, at the site level.
      searchAgents: SEARCH_AGENTS.map(a => { const d = robots.allows(a.token, '/'); return { ...a, allowed: d.allowed, rule: d.rule, reason: d.reason }; }),
      aiPolicy: robots.aiPolicy(),
    },
    sitemaps,
    urls,
    summary,
    conflicts,
    discovery,
    schema,
    // ── NOT MEASURED, STATED AS SUCH ────────────────────────────────────────────────────────────
    // Travels with the data so no renderer can show the verdict table as "indexed in Google".
    indexStatus: {
      measured: false,
      reason: 'Live index membership is not derivable from the site. It requires a credentialed, '
        + 'ownership-verified API per engine (Google Search Console URL Inspection, Bing Webmaster URL '
        + 'Info); scraping "site:" queries is non-deterministic and against both engines\' terms, so it '
        + 'is not an option this engine will take.',
      whatWasMeasured: 'Every technical gate between a search crawler and the index — status, robots.txt '
        + 'as Googlebot and Bingbot each read it, meta robots, X-Robots-Tag, canonical, content type, and '
        + 'whether the sitemap agrees. A URL marked indexable is eligible; whether it has been indexed is '
        + 'the engine\'s decision and is not claimed here.',
    },
  };
}

module.exports = { scanIndexability, verdictFor, metaRobotsFrom, xRobotsFrom, canonicalFrom, sameUrl, VERDICTS, DEFAULT_PROBE_CAP };
