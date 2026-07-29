'use strict';
// reachability.test.js — "did we actually see the site?"
//
// THE DEFECT THIS SUITE EXISTS TO PREVENT, measured on a fixture answering 403 to every path
// (2026-07-30, before the fix):
//     verdict NEEDS ATTENTION · score 50% · QUALITY 71 · htmlPages 0 · 87 of 97 rules not evaluated
//     "blocked" appears 0 times in the report · cross-browser scored 1 pass + 1 warn on the 403 page
// A site the tool never saw scored 71, and nothing said why. These assertions are about NAMING the
// cause and REFUSING to publish a number for a run that measured nothing.
//
// Every function under test is pure — no I/O, no clock — so the suite is deterministic.
const { diagnoseReachability, explainUnreachable, softStatusPage } = require('./reachability');

let pass = 0, fail = 0; const failures = [];
const ok = (c, n) => { if (c) pass++; else { fail++; failures.push(n); console.log('  ✗ ' + n); } };
const eq = (a, b, n) => { const g = JSON.stringify(a), w = JSON.stringify(b); ok(g === w, n + (g === w ? '' : ` (got ${g}, want ${w})`)); };
const has = (s, re, n) => ok(re.test(String(s)), n + ` (got "${String(s).slice(0, 90)}")`);

const P = (status, extra = {}) => ({ url: 'https://x.example/', status, body: '', contentType: '', ...extra });
const HTML = (body, url = 'https://x.example/') => ({ url, status: 200, contentType: 'text/html', body });

console.log('Reachability diagnosis — did we see the site? — test suite\n');

// ── 1 · THE CAUSE IS NAMED, AND THE RIGHT ONE ────────────────────────────────────────────────────
{
  const d = diagnoseReachability({ pages: [P(403)], htmlPages: [], target: 'https://x.example/' });
  ok(!!d, 'blocked: a 403-only origin produces a diagnosis at all — this is the case that scored 71');
  eq(d.reason, 'blocked', 'blocked: reason');
  eq(d.audited, false, 'blocked: audited=false — no page was ever readable');
  has(d.message, /blocked this scanner \(HTTP 403\)/, 'blocked: the message names the status');
  has(d.action, /allowlist/i, 'blocked: the action is about allowlisting, not "check the URL"');

  eq(diagnoseReachability({ pages: [P(401)], htmlPages: [] }).reason, 'blocked', 'blocked: 401 counts too');
  eq(diagnoseReachability({ pages: [P(451)], htmlPages: [] }).reason, 'blocked', 'blocked: 451 (legal block) counts too');

  eq(diagnoseReachability({ pages: [P(0, { errorCode: 'ENOTFOUND' })], htmlPages: [] }).reason, 'dns', 'dns: unresolvable name');
  has(diagnoseReachability({ pages: [P(0, { errorCode: 'ENOTFOUND' })], htmlPages: [] }).message, /spelled correctly/, 'dns: only DNS blames the address');

  const route = diagnoseReachability({ pages: [P(0, { errorCode: 'UND_ERR_CONNECT_TIMEOUT' })], htmlPages: [] });
  eq(route.reason, 'route', 'route: undici connect timeout is a ROUTE problem, not a bad address');
  has(route.message, /unreachable from THIS network/, 'route: the message points outward — "unreachable from here" is weaker than "down"');
  ok(!/spelled correctly/.test(route.message), 'route: it does NOT tell the operator to check the spelling');

  eq(diagnoseReachability({ pages: [P(0, { errorCode: 'ECONNREFUSED' })], htmlPages: [] }).reason, 'refused', 'refused: connection refused');
  eq(diagnoseReachability({ pages: [P(0, { errorCode: 'ERR_SSL_PROTOCOL_ERROR' })], htmlPages: [] }).reason, 'tls', 'tls: handshake failure');
  eq(diagnoseReachability({ pages: [P(503)], htmlPages: [] }).reason, 'server-error', 'server-error: 5xx');
  has(diagnoseReachability({ pages: [P(503)], htmlPages: [] }).message, /the site's own failure, not a scanner problem/, 'server-error: blame is placed correctly');
  eq(diagnoseReachability({ pages: [P(404)], htmlPages: [] }).reason, 'not-found', 'not-found: 404 on the entry URL');
  eq(diagnoseReachability({ pages: [P(301), P(302)], htmlPages: [] }).reason, 'redirect-dead-end', 'redirect-dead-end: every response was a redirect');
  // A 200 that is not HTML (a PDF, an API root) is not a network failure and must not be described as one.
  const nohtml = diagnoseReachability({ pages: [P(200, { contentType: 'application/json' })], htmlPages: [] });
  eq(nohtml.reason, 'no-html', 'no-html: a 200 that is not HTML');
  ok(!/could not connect/i.test(nohtml.message), 'no-html: it is NOT described as a connection failure');
}

// ── 2 · A HEALTHY RUN IS UNTOUCHED ───────────────────────────────────────────────────────────────
{
  const good = HTML('<html><head><title>Acme — industrial widgets</title></head><body><h1>Widgets</h1>'
    + '<p>' + 'Acme has manufactured precision widgets since 1974 for industrial customers. '.repeat(12) + '</p></body></html>');
  eq(diagnoseReachability({ pages: [good], htmlPages: [good] }), null,
    'healthy: a real page returns NULL — an absent field is what keeps existing output byte-identical');
}

// ── 3 · STATUS PAGES SERVED WITH A 200 (the soft case) ───────────────────────────────────────────
// WAFs and CDNs serve their block page with a 200, so the status line says fine while the body says
// "Access denied". Auditing that produces confident findings about a page no visitor sees.
{
  const block = HTML('<html><head><title>403 Forbidden</title></head><body><h1>Forbidden</h1><p>Access to this resource is denied.</p></body></html>');
  const s = softStatusPage(block);
  ok(!!s, 'soft: a thin 200 titled "403 Forbidden" is recognised');
  const d = diagnoseReachability({ pages: [block], htmlPages: [block] });
  ok(!!d && d.reason === 'soft-status-page', 'soft: every page being a block page is flagged');
  eq(d.audited, true, 'soft: audited=true — the pages WERE readable, so the audit still runs');
  eq(d.ok, false, 'soft: but ok=false, because the findings may describe an error page');
  has(d.action, /normal browser/i, 'soft: the action is to check it in a real browser');

  const cf = HTML('<html><head><title>Attention Required! | Cloudflare</title></head><body><h1>Checking your browser</h1><p>Please enable JavaScript and cookies.</p></body></html>');
  ok(!!softStatusPage(cf), 'soft: a Cloudflare interstitial is recognised');

  // FALSE-POSITIVE GUARD. Refusing to audit a real page is worse than auditing an error page, so both
  // conditions must hold: a status-page signature in the HEADLINE, and a thin body.
  const article = HTML('<html><head><title>How to fix a 404 on your site</title></head><body><h1>Fixing 404 errors</h1><p>'
    + 'A 404 means the server could not find the resource. Here is how to diagnose and fix it properly. '.repeat(14) + '</p></body></html>');
  eq(softStatusPage(article), null, 'soft: a real ARTICLE about 404s is NOT flagged — it has body copy');
  const mentions = HTML('<html><head><title>Acme Widgets</title></head><body><h1>Widgets</h1><p>Our 404 page is custom. Forbidden fruit is on sale.</p></body></html>');
  eq(softStatusPage(mentions), null, 'soft: a normal page merely MENTIONING 404/forbidden is NOT flagged — the headline is what is tested');
  eq(softStatusPage({ url: 'x', body: '' }), null, 'soft: an empty body is not a status page');

  // A MIX is advisory only — those pages are real findings about real (bad) pages.
  const mix = diagnoseReachability({ pages: [block, article], htmlPages: [block, article] });
  eq(mix.reason, 'some-soft-status-pages', 'soft/mix: some-but-not-all is a lesser signal');
  eq(mix.ok, true, 'soft/mix: ok stays true — the run is valid, one page is a status page');
  has(mix.action, /SEO defect/i, 'soft/mix: it names the real consequence — a 200 status page gets indexed');
}

// ── 4 · THE EVIDENCE IS CARRIED, NOT JUST THE VERDICT ────────────────────────────────────────────
{
  const d = diagnoseReachability({ pages: [P(403), P(0, { errorCode: 'ECONNRESET' })], htmlPages: [], target: 'https://x.example/' });
  eq(d.evidence.pagesFetched, 2, 'evidence: responses counted');
  eq(d.evidence.htmlPages, 0, 'evidence: readable pages counted');
  eq(d.evidence.statuses, [0, 403], 'evidence: distinct statuses, sorted');
  eq(d.evidence.errorCodes, ['ECONNRESET'], 'evidence: low-level codes kept');
  eq(d.target, 'https://x.example/', 'evidence: the target is recorded');
  // Precedence: a blocking status is more actionable than a connection wobble, so it wins.
  eq(d.reason, 'blocked', 'precedence: a 401/403 outranks a transport error when both were seen');
}

// ── 5 · THE SHARED WORDING ───────────────────────────────────────────────────────────────────────
// visual-match's diagnoseEmpty() imports this. Two tools must not explain one failure two ways.
{
  has(explainUnreachable([403], [], 'reference site', 'reference'), /reference site blocked this scanner/,
    'shared: the noun and URL label are caller-supplied, so visual-match keeps its own phrasing');
  has(explainUnreachable([], [], 'site', 'target'), /Could not connect/,
    'shared: no evidence at all stays deliberately vague rather than asserting a cause');
}

console.log('\n' + (fail === 0 ? '✅ PASS' : '❌ FAIL') + ` — ${pass}/${pass + fail} assertions`);
if (fail) { console.log('Failures:\n' + failures.map(f => '  - ' + f).join('\n')); process.exit(1); }
