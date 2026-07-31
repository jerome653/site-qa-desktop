'use strict';
// indexability.test.js — can Google and Bing actually index this, per URL, from evidence.
//
// THE DEFECT CLASS THIS SUITE EXISTS TO PIN. Every input here was already being fetched and every
// signal was already checked in isolation — SEO-007 sees noindex, SEO-020 sees a blanket robots block,
// SEO-023 sees dead sitemap URLs. What nothing could see is the INTERSECTION. The e2e fixture below is
// built to be individually clean and collectively broken: a sitemap that advertises a URL robots.txt
// forbids, a URL whose noindex the crawler is never permitted to read, and a robots group that closes
// Googlebot while `*` stays open. A tool that checks signals one at a time passes all of it.
//
// The other thing asserted here is the boundary: this ships INDEXABLE, never INDEXED. `indexStatus`
// must stay `measured: false` with a stated reason — an estimate would be worse than the gap.

const http = require('http');

let pass = 0; const fails = [];
const ok = (c, n) => { if (c) pass++; else fails.push(n); };
const eq = (a, b, n) => ok(a === b, `${n} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
// Arrays are never ===, so a strict-equality helper reports a passing case as "got [], want []" — a
// failure message that accuses the code of a defect it does not have. Deep-compare gets its own helper.
const eqA = (a, b, n) => ok(JSON.stringify(a) === JSON.stringify(b), `${n} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

console.log('\nIndexability — sitemap · robots · canonical · discovery\n');

const { buildRobots, parseRobots, patternToRegex } = require('./robots');
const { parseSitemapDoc, validLastmod } = require('./sitemap');
const { validateLlms, validateYaml, validateDirectives } = require('./discovery');
const { scanSchema } = require('./schema');
const { metaRobotsFrom, xRobotsFrom, canonicalFrom, sameUrl, verdictFor } = require('./index');

// ── robots.txt: the per-agent matcher ────────────────────────────────────────────────────────────
{
  const txt = [
    'User-agent: *', 'Allow: /', 'Disallow: /private/', '',
    'User-agent: Googlebot', 'Disallow: /no-google/', 'Allow: /no-google/ok.html', '',
    'User-agent: Google-Extended', 'Disallow: /', '',
    'Sitemap: https://example.com/sitemap.xml',
  ].join('\n');
  const r = buildRobots({ status: 200, body: txt });

  eq(r.state, 'present', 'a 200 robots.txt is state "present"');
  eq(r.sitemaps.length, 1, 'the Sitemap: line is captured');
  eq(r.allows('googlebot', 'https://example.com/page').allowed, true, 'Googlebot may fetch a normal page');
  eq(r.allows('googlebot', 'https://example.com/no-google/x').allowed, false, 'the group NAMING googlebot wins over *');
  // Longest-match precedence — the single rule most implementations get wrong, and the one that decides
  // whether an exception inside a blocked folder is reported as blocked.
  eq(r.allows('googlebot', 'https://example.com/no-google/ok.html').allowed, true, 'a longer Allow beats a shorter Disallow');
  // bingbot is not named, so it falls to `*` and is NOT bound by the googlebot group. Unioning the
  // groups (the naive parse) would wrongly report Bing as blocked here.
  eq(r.allows('bingbot', 'https://example.com/no-google/x').allowed, true, 'an unnamed agent falls to * and is not bound by another agent\'s group');
  eq(r.allows('bingbot', 'https://example.com/private/x').allowed, false, 'the * group still applies to Bing');

  // AI-training agents are a POLICY surface, never a crawlability defect. checks-static.js already
  // shipped this bug once (calling sgen.com CRITICAL for a deliberate opt-out); it must not return.
  const ai = r.aiPolicy();
  const ge = ai.find(a => a.token === 'google-extended');
  ok(ge && ge.declared && ge.blocked, 'Google-Extended blocked is DECLARED, and reported');
  eq(r.allows('googlebot', 'https://example.com/').allowed, true, 'blocking Google-Extended does NOT block Googlebot — different agent, different index');
  const gptbot = ai.find(a => a.token === 'gptbot');
  ok(gptbot && !gptbot.declared, 'an agent that falls under * only is reported as UNDECLARED, not as a decision');

  eq(buildRobots({ status: 404, body: '' }).state, 'absent', 'a 404 robots.txt is "absent"');
  eq(buildRobots({ status: 404, body: '' }).allows('googlebot', 'https://e.com/x').allowed, true, 'no robots.txt means everything is allowed');
  // A 5xx is NOT "absent". Google treats a persistent 5xx as disallow-all, and collapsing the two would
  // report a site as fully crawlable during an outage.
  eq(buildRobots({ status: 503, body: '' }).allows('googlebot', 'https://e.com/x').allowed, false, 'a 5xx robots.txt is treated as disallow, not as absent');

  // wildcards + end-anchor
  ok(patternToRegex('/*.pdf$').test('/docs/a.pdf'), '* and $ match a suffix pattern');
  ok(!patternToRegex('/*.pdf$').test('/docs/a.pdf?x=1'), '$ anchors the end');
  const wc = buildRobots({ status: 200, body: 'User-agent: *\nDisallow: /*?sort=' });
  eq(wc.allows('bingbot', 'https://e.com/list?sort=asc').allowed, false, 'a wildcard mid-pattern blocks a query variant');
  eq(wc.allows('bingbot', 'https://e.com/list').allowed, true, 'the same rule leaves the clean URL alone');
  // `Disallow:` with an empty value is an explicit allow-all and must not match everything.
  const empty = buildRobots({ status: 200, body: 'User-agent: *\nDisallow:' });
  eq(empty.allows('googlebot', 'https://e.com/anything').allowed, true, 'an empty Disallow matches nothing');
  eq(parseRobots('# just a comment\n').groups.length, 0, 'a comment-only file yields no groups');
}

// ── sitemap parsing + validation ─────────────────────────────────────────────────────────────────
{
  const urlset = '<?xml version="1.0"?><urlset><url><loc>https://e.com/a</loc><lastmod>2026-01-02</lastmod></url>'
    + '<url><loc>https://e.com/b?x=1&amp;y=2</loc><lastmod>02/01/2026</lastmod></url></urlset>';
  const d = parseSitemapDoc(urlset);
  eq(d.kind, 'urlset', 'a urlset is recognised');
  eq(d.entries.length, 2, 'both <url> entries parse');
  // An unescaped &amp; left encoded turns a live URL into a 404 in the report — the tool manufacturing
  // the defect it went looking for.
  eq(d.entries[1].loc, 'https://e.com/b?x=1&y=2', 'XML entities in <loc> are decoded');
  ok(validLastmod('2026-01-02'), 'a W3C date is valid');
  ok(validLastmod('2026-01-02T10:30:00Z'), 'a W3C datetime is valid');
  ok(!validLastmod('02/01/2026'), 'a US-format date is NOT a valid lastmod');
  ok(!validLastmod('2026-13-45'), 'an impossible date is rejected');

  const idx = parseSitemapDoc('<sitemapindex><sitemap><loc>https://e.com/sm1.xml</loc></sitemap></sitemapindex>');
  eq(idx.kind, 'index', 'a sitemapindex is recognised as an index, not a urlset');
  // Generators that emit bare <loc> are real; the URLs are visible to a human and invisible to a
  // block parser, so they are recovered AND the structure is still reported as malformed.
  const loose = parseSitemapDoc('<urlset><loc>https://e.com/x</loc></urlset>');
  eq(loose.looseLocs.length, 1, 'a bare <loc> outside <url> is recovered rather than silently lost');
}

// ── directive extraction ─────────────────────────────────────────────────────────────────────────
{
  const m = metaRobotsFrom('<meta name="robots" content="index,follow"><meta name="googlebot" content="noindex">');
  eq(m.all, 'index,follow', 'the generic robots meta is read');
  // Agent-specific tags OVERRIDE the generic one FOR THAT AGENT. Collapsing them into one field
  // reports both engines wrong on exactly the pages where they differ.
  eq(m.googlebot, 'noindex', 'an agent-specific robots meta is kept separate');
  eq(xRobotsFrom({ 'x-robots-tag': 'noindex, nofollow' }).all, 'noindex, nofollow', 'X-Robots-Tag is read from headers');
  eq(xRobotsFrom({ 'x-robots-tag': 'googlebot: noindex' }).googlebot, 'noindex', 'the agent-scoped X-Robots-Tag form is parsed');
  eq(xRobotsFrom({}).all, null, 'no header means no directive, not an empty directive');
  eq(canonicalFrom('<link rel="canonical" href="/real">', 'https://e.com/x'), 'https://e.com/real', 'a relative canonical resolves against the page URL');
  // Trailing-slash-only difference is not a canonical disagreement; treating it as one would fail
  // every site that canonicalises /about from /about/.
  ok(sameUrl('https://e.com/a/', 'https://e.com/a'), 'trailing slash is not a canonical mismatch');
  ok(!sameUrl('https://e.com/a', 'https://e.com/b'), 'a different path IS a mismatch');
}

// ── the verdict, including the trap ──────────────────────────────────────────────────────────────
{
  const base = { checked: true, status: 200, isHtml: true, contentType: 'text/html', metaRobots: {}, xRobotsTag: {}, canonical: null, canonicalSelf: true, robots: { google: { allowed: true }, bing: { allowed: true } } };
  eq(verdictFor({ ...base }, 'googlebot').verdict, 'indexable', 'a clean 200 is indexable');
  eq(verdictFor({ ...base, status: 404 }, 'googlebot').verdict, 'error', 'a 404 is an error');
  // Precedence: a 404 that also carries noindex is a 404. Reporting the noindex would send someone to
  // edit a meta tag on a page that does not exist.
  eq(verdictFor({ ...base, status: 404, metaRobots: { all: 'noindex' } }, 'googlebot').verdict, 'error', 'status outranks a directive on a page that is not there');
  eq(verdictFor({ ...base, status: 301 }, 'googlebot').verdict, 'redirect', 'a 3xx is a redirect');
  eq(verdictFor({ ...base, metaRobots: { all: 'noindex' } }, 'googlebot').verdict, 'noindex', 'noindex is honoured');
  eq(verdictFor({ ...base, metaRobots: { all: 'none' } }, 'googlebot').verdict, 'noindex', '"none" is noindex,nofollow');
  eq(verdictFor({ ...base, canonical: 'https://e.com/other', canonicalSelf: false }, 'googlebot').verdict, 'canonicalized-away', 'a cross-URL canonical removes the page as itself');
  eq(verdictFor({ ...base, robots: { google: { allowed: false, rule: 'Disallow: /x' }, bing: { allowed: true } } }, 'googlebot').verdict, 'blocked-robots', 'robots.txt blocks the fetch');
  // Per-engine divergence — the whole reason the verdict is computed twice.
  eq(verdictFor({ ...base, robots: { google: { allowed: false, rule: 'Disallow: /x' }, bing: { allowed: true } } }, 'bingbot').verdict, 'indexable', 'the same URL can be blocked in one engine and indexable in the other');
  eq(verdictFor({ ...base, checked: false }, 'googlebot').verdict, 'not-checked', 'a URL that was never fetched is "not-checked", never assumed clean');

  // THE TRAP. robots.txt forbids the fetch, so the crawler never READS the noindex — the URL can sit
  // in the index as a bare link indefinitely. Both directives are individually correct.
  const trap = verdictFor({ ...base, metaRobots: { all: 'noindex' }, robots: { google: { allowed: false, rule: 'Disallow: /x' }, bing: { allowed: false, rule: 'Disallow: /x' } } }, 'googlebot');
  eq(trap.verdict, 'blocked-robots', 'the blocked verdict wins — the noindex is unreachable');
  ok(trap.noindexUnreadable === true, 'noindex-behind-a-robots-block is flagged, not silently folded into "blocked"');
  ok(trap.reasons.some(r => /never read|remain indexed/i.test(r)), 'the row explains WHY the two correct directives are together a defect');
}

// ── discovery validators ─────────────────────────────────────────────────────────────────────────
{
  ok(validateLlms('# Acme\n\n> We sell things.\n\n## Docs\n- [Guide](https://e.com/g)\n').valid, 'a well-formed llms.txt validates');
  ok(!validateLlms('Just some prose with no heading.').valid, 'prose without an H1 is not llms.txt');
  eq(validateLlms('# Acme\n## Docs\n- [A](https://e.com/a)\n- [B](https://e.com/b)\n').meta.linkCount, 2, 'llms.txt links are counted');
  ok(validateYaml('openapi: 3.0.0\ninfo:\n  title: X\n').valid, 'an OpenAPI YAML document is recognised');
  eq(validateYaml('openapi: 3.0.0\ninfo:\n  title: X\n').meta.openapi, '3.0.0', 'the OpenAPI version is read off the document');
  ok(!validateYaml('This is a sentence about nothing in particular.').valid, 'prose is not a YAML mapping document');
  ok(/shape only|not schema-validated/i.test(validateYaml('a: 1\nb: 2\n').note), 'the YAML row states that it is a shape check, not schema validation');
  ok(validateDirectives('Contact: mailto:x@e.com\nExpires: 2027-01-01T00:00:00Z').valid, 'security.txt directives validate');
  ok(!validateDirectives('').valid, 'an empty file is not a directive file');
}

// ── schema: required properties, and the @graph false-positive guard ─────────────────────────────
{
  const bad = scanSchema([{ url: 'https://e.com/p', html: '<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","description":"x"}</script>' }]);
  ok(bad.missingRequired.some(i => /name/.test(i.value)), 'a Product with no name is caught — SEO-016..019 all pass on it');

  const good = scanSchema([{ url: 'https://e.com/p', html: '<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Widget"}</script>' }]);
  eq(good.missingRequired.length, 0, 'a Product with a name has no REQUIRED property missing');
  ok(good.missingRecommended.length > 0, 'the same item still reports RECOMMENDED gaps — a separate, unscored tier');

  // THE FALSE-POSITIVE GUARD. Real CMS markup (Yoast, RankMath) emits a @graph whose nodes reference
  // each other by @id. A validator that only reads inline values calls this a missing author on a site
  // whose markup is exactly right — the single worst thing a structured-data checker can do.
  const graph = scanSchema([{ url: 'https://e.com/a', html: '<script type="application/ld+json">' + JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'Article', '@id': 'https://e.com/a#article', headline: 'H', author: { '@id': 'https://e.com/#person' }, image: 'https://e.com/i.jpg', datePublished: '2026-01-01', dateModified: '2026-01-02' },
      { '@type': 'Person', '@id': 'https://e.com/#person', name: 'Jane' },
    ],
  }) + '</script>' }]);
  eq(graph.missingRequired.length, 0, '@graph markup with @id cross-references is NOT reported as missing properties');
  // Scoped to the Article. The Person node in the same graph legitimately lacks url/sameAs/jobTitle, so
  // asserting zero graph-wide would be asserting the wrong thing — every node is validated, not just
  // the one under test.
  eq(graph.missingRecommended.filter(i => i.section === 'Article').length, 0, 'an @id author satisfies the Article\'s recommended tier too');
  ok(graph.types.some(t => t.type === 'Article'), 'types inside @graph are inventoried');

  // A dangling @id — a reference to a node that does not exist — is a genuine gap and must still fire.
  const dangling = scanSchema([{ url: 'https://e.com/a', html: '<script type="application/ld+json">' + JSON.stringify({
    '@type': 'Article', headline: 'H', author: { '@id': 'https://e.com/#nobody' },
  }) + '</script>' }]);
  ok(dangling.missingRecommended.some(i => /author/.test(i.value)), 'a reference to a node that does not exist is still a gap');

  // An unknown @type is NOT an error. It is unvalidated, and the report says so rather than banking a pass.
  const unknown = scanSchema([{ url: 'https://e.com/x', html: '<script type="application/ld+json">{"@type":"SomethingExotic","x":1}</script>' }]);
  eq(unknown.missingRequired.length, 0, 'an unknown @type produces no required-property failure');
  ok(unknown.unvalidatedTypes.some(t => t.type === 'SomethingExotic'), 'an unknown @type is DECLARED unvalidated, never silently passed');

  // Subtype inheritance — a Dentist is a LocalBusiness and needs an address.
  const dentist = scanSchema([{ url: 'https://e.com/d', html: '<script type="application/ld+json">{"@type":"Dentist","name":"D"}</script>' }]);
  ok(dentist.missingRequired.some(i => /address/.test(i.value)), 'a LocalBusiness subtype inherits its required properties');
}

// ── FALSE POSITIVES CAUGHT ON REAL DATA (sgen.com, 2026-07-31) ───────────────────────────────────
// Both had the same root cause and neither unit test above would have found it: on that host EVERY
// unknown path answers `301 → /404?from=…` with an empty body. "Absent" arrived as a redirect, and
// both modules read a redirect as "present, and broken".
(async () => {
  const { collectSitemaps } = require('./sitemap');
  const { probeDiscovery } = require('./discovery');
  const PORT = 7974;
  const ORIGIN = `http://127.0.0.1:${PORT}`;
  const srv = http.createServer((q, s) => {
    const u = q.url.split('?')[0];
    if (u === '/sitemap.xml') {
      s.writeHead(200, { 'content-type': 'text/xml' });
      return s.end(`<?xml version="1.0"?><urlset><url><loc>${ORIGIN}/a</loc></url></urlset>`);
    }
    // Everything else: the catch-all redirect that caused both defects.
    s.writeHead(301, { location: ORIGIN + '/404?from=' + encodeURIComponent(u), 'content-type': 'text/html' });
    s.end();
  });
  await new Promise(r => srv.listen(PORT, '127.0.0.1', r));
  let sm, disc;
  try {
    sm = await collectSitemaps(ORIGIN, `127.0.0.1:${PORT}`, { robotsSitemaps: [] });
    disc = await probeDiscovery(ORIGIN, { homeHtml: '', homeUrl: ORIGIN });
  } finally {
    if (typeof srv.closeAllConnections === 'function') srv.closeAllConnections();
    await new Promise(r => srv.close(r));
  }

  // A GUESSED path that redirects away is absent, not unreadable. Before the fix this reported
  // /sitemap-index.xml and /sitemap_index.xml as "redirect, not-xml" and failed the site on SEO-043
  // for two paths it never claimed to have.
  const guessedBroken = sm.files.filter(f => f.source === 'common-path' && f.problems.length);
  eqA(guessedBroken.map(f => f.url), [], 'a guessed sitemap path that redirects away raises NO finding');
  eq(sm.counts.files, 1, 'only the sitemap that actually parsed is counted');
  ok(sm.found, 'the real sitemap is still found alongside the redirecting guesses');

  // A JSON descriptor path that redirects away is absent, not malformed. Before the fix this reported
  // four files as present-and-INVALID on a site that publishes none of them.
  eqA(disc.present, [], 'a redirect-to-404 origin publishes NO well-known files');
  eqA(disc.invalid, [], 'and therefore has NO invalid ones — absent is not broken');
  ok(disc.files.every(f => !f.present), 'every probe resolves to absent, including the JSON ones');
  ok(disc.files.some(f => /redirected away/.test(f.note || '')), 'the row states WHY it is absent (redirected away), not just that it is');
})();

// ── end to end: a fixture that is individually clean and collectively broken ─────────────────────
(async () => {
  const { runAudit } = require('../audit');
  const PORT = 7973;
  const ORIGIN = `http://127.0.0.1:${PORT}`;
  const page = (title, extraHead = '') => '<!doctype html><html lang="en"><head><meta charset="utf-8">'
    + `<title>${title}</title><meta name="description" content="A description long enough that the auditor treats it as a real one and not a stub.">`
    + extraHead + '</head><body><header><nav><a href="/">Home</a></nav></header><h1>' + title + '</h1><p>'
    + 'Real words so the page is not thin content for the readability and depth checks. '.repeat(20)
    + '</p><footer>Footer</footer></body></html>';

  const ROUTES = {
    // Sitemap lists all four. robots.txt blocks /blocked/. /noindexed/ carries noindex. /moved/ 301s.
    '/': page('Home', '<link rel="canonical" href="' + ORIGIN + '/">'),
    '/blocked/': page('Blocked', '<meta name="robots" content="noindex">'),   // the trap: noindex the crawler may not read
    '/noindexed/': page('Noindexed', '<meta name="robots" content="noindex">'),
    '/ok/': page('Ok', '<link rel="canonical" href="' + ORIGIN + '/ok/">'),
  };

  const srv = http.createServer((q, s) => {
    const u = q.url.split('?')[0];
    if (u === '/robots.txt') {
      s.writeHead(200, { 'content-type': 'text/plain' });
      // `*` is wide open; a group NAMING Googlebot closes the whole site to Google alone. SEO-020's
      // site-level boolean reads this as clean — which is the gap SEO-048 exists to close.
      return s.end(['User-agent: *', 'Allow: /', 'Disallow: /blocked/', '',
        'User-agent: Googlebot', 'Disallow: /', '',
        `Sitemap: ${ORIGIN}/sitemap.xml`].join('\n'));
    }
    if (u === '/sitemap.xml') {
      s.writeHead(200, { 'content-type': 'application/xml' });
      return s.end('<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
        + ['/', '/blocked/', '/noindexed/', '/moved/'].map(p => `<url><loc>${ORIGIN}${p}</loc><lastmod>01/02/2026</lastmod></url>`).join('')
        + '</urlset>');
    }
    if (u === '/moved/') { s.writeHead(301, { location: ORIGIN + '/ok/' }); return s.end(); }
    if (u === '/llms.txt') { s.writeHead(200, { 'content-type': 'text/plain' }); return s.end('# Fixture\n\n> A fixture site.\n\n## Pages\n- [Home](' + ORIGIN + '/)\n'); }
    if (ROUTES[u]) { s.writeHead(200, { 'content-type': 'text/html' }); return s.end(ROUTES[u]); }
    s.writeHead(404, { 'content-type': 'text/html' }); s.end(page('Not found'));
  });

  await new Promise(r => srv.listen(PORT, '127.0.0.1', r));
  let res;
  try { res = await runAudit(ORIGIN + '/', { maxPages: 10, render: false, log: () => {} }); }
  finally {
    if (typeof srv.closeAllConnections === 'function') srv.closeAllConnections();
    await new Promise(r => srv.close(r));
  }

  const IX = res.indexability;
  ok(!!IX, 'the audit result carries `indexability`');
  if (IX) {
    // THE BOUNDARY. This ships indexABLE and must never imply indexED.
    eq(IX.indexStatus.measured, false, 'index STATUS is declared not-measured — the tool never claims a URL is in the index');
    ok(/Search Console|Webmaster/i.test(IX.indexStatus.reason), 'the not-measured row names what it would actually take');

    const g = IX.robots.searchAgents.find(a => a.key === 'google');
    const b = IX.robots.searchAgents.find(a => a.key === 'bing');
    ok(g && !g.allowed, 'Googlebot is correctly reported as blocked by its own named group');
    ok(b && b.allowed, 'Bingbot is correctly reported as allowed — * is open, and the groups are not unioned');

    const byUrl = Object.fromEntries(IX.urls.map(u => [u.url, u]));
    const blocked = byUrl[ORIGIN + '/blocked/'];
    ok(blocked && blocked.verdict.bing === 'blocked-robots', 'the /blocked/ URL is blocked for Bing by the * group');
    ok(IX.urls.some(u => !u.agree), 'per-engine disagreement is recorded rather than averaged away');
    ok(IX.summary.disagree.length > 0, 'the summary surfaces the URLs where Google and Bing differ');
  }

  // The rows. Every `name` must equal its registry title — the engine maps rows to rules BY TITLE.
  const seo = (res.suites || []).find(s => s.key === 'seo') || { checks: [] };
  const disc = (res.suites || []).find(s => s.key === 'discovery') || { checks: [] };
  const rule = (suite, id) => suite.checks.find(c => c.ruleId === id);

  ok(!!rule(seo, 'SEO-048'), 'SEO-048 fires: robots.txt closes a NAMED search engine while * stays open');
  ok(!!rule(seo, 'SEO-039'), 'SEO-039 fires: the sitemap advertises a URL robots.txt blocks');
  ok(!!rule(seo, 'SEO-040'), 'SEO-040 fires: the sitemap advertises a noindexed URL');
  ok(!!rule(seo, 'SEO-042'), 'SEO-042 fires: the sitemap lists a URL that redirects');
  ok(!!rule(seo, 'SEO-045'), 'SEO-045 fires: 01/02/2026 is not a W3C datetime');
  ok(!!rule(seo, 'SEO-047'), 'SEO-047 fires: noindex sits behind a robots.txt block and can never be read');

  ok(!!rule(disc, 'DISC-001'), 'DISC-001 reports the llms.txt this fixture serves');
  ok(!!rule(disc, 'DISC-006'), 'DISC-006 states that live index status was not measured');
  eq(disc.checks.every(c => c.status === 'manual'), true, 'EVERY Discovery row is manual — mechanism 2 of 2 that keeps Suite 14 score-neutral');
  ok(disc.checks.length >= 6, 'the Discovery suite carries its full row set');

  // Coverage must not claim a rule ran when the pass never produced it, and must not claim one did not.
  const ev = new Set((res.coverage && res.coverage.evaluatedRules) || []);
  ok(ev.has('SEO-048'), 'SEO-048 is DECLARED evaluated — the check provably looked');
  ok(ev.has('SEO-039'), 'the sitemap-indexability family is declared evaluated when a sitemap was read');

  console.log(fails.length ? `\n❌ FAIL — ${pass} passed, ${fails.length} failed\n` : `\n✅ PASS — ${pass}/${pass} assertions\n`);
  for (const f of fails) console.log('   ✗ ' + f);
  process.exitCode = fails.length ? 1 : 0;
})();
