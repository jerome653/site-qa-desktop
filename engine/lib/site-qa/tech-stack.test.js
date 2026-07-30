'use strict';
// tech-stack.test.js — what is this site actually BUILT on?
//
// A post-deployment check that only proves the new site is a faithful COPY has not proved it is a
// production site. "Is this really WordPress behind Cloudflare, or did we deploy the staging build to
// production?" is a question the crawl already holds the evidence for — HTML fingerprints and response
// headers — and never asked.
//
// Written BEFORE the implementation and watched failing.
//
// DESIGN RULE ASSERTED HERE: this reports SIGNATURES, never certainty. A generator meta tag can be
// removed and a header can be spoofed, so absence is never "not WordPress" — it is "no signature seen".
// The module must not let a caller confuse the two.
const http = require('http');

let pass = 0; const fails = [];
const ok = (c, n) => { if (c) pass++; else fails.push(n); };
const eqA = (a, b, n) => ok(JSON.stringify(a) === JSON.stringify(b), n + ` (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

console.log('\nTech stack — what the deployed site is built on\n');

let ts = null;
try { ts = require('./tech-stack'); } catch (e) { /* not built yet */ }
ok(!!ts && typeof ts.detectStack === 'function', 'tech-stack.js exports detectStack(html, headers)');

if (ts && typeof ts.detectStack === 'function') {
  const d = ts.detectStack;

  // ── CMS ────────────────────────────────────────────────────────────────────────────────────────
  eqA(d('<meta name="generator" content="WordPress 6.5">', {}).cms, ['WordPress'], 'WordPress by generator meta');
  eqA(d('<link href="/wp-content/themes/x/style.css">', {}).cms, ['WordPress'], 'WordPress by wp-content path');
  eqA(d('<script src="https://cdn.shopify.com/s/files/x.js"></script>', {}).cms, ['Shopify'], 'Shopify by cdn host');
  eqA(d('<meta name="generator" content="Drupal 10 (https://www.drupal.org)">', {}).cms, ['Drupal'], 'Drupal by generator');
  eqA(d('<div id="SITE_CONTAINER"></div><script>window.wixBiSession={}</script>', {}).cms, ['Wix'], 'Wix by runtime global');
  eqA(d('<html data-wf-site="abc123">', {}).cms, ['Webflow'], 'Webflow by data-wf-site');
  eqA(d('<p>plain html</p>', {}).cms, [], 'a hand-built page reports no CMS');

  // ── framework ──────────────────────────────────────────────────────────────────────────────────
  eqA(d('<script id="__NEXT_DATA__" type="application/json">{}</script>', {}).framework, ['Next.js'], 'Next.js by __NEXT_DATA__');
  eqA(d('<div id="__nuxt"></div>', {}).framework, ['Nuxt'], 'Nuxt by mount node');
  eqA(d('<div data-reactroot=""></div>', {}).framework, ['React'], 'React by data-reactroot');
  eqA(d('<p>nothing</p>', {}).framework, [], 'no framework signature is an empty list');

  // ── server + CDN come from HEADERS, not markup ─────────────────────────────────────────────────
  eqA(d('', { server: 'nginx/1.24.0' }).server, ['nginx'], 'server from the Server header');
  eqA(d('', { server: 'Apache/2.4.58 (Ubuntu)' }).server, ['Apache'], 'Apache from the Server header');
  eqA(d('', { 'cf-ray': '8a1b2c3d4e5f' }).cdn, ['Cloudflare'], 'Cloudflare by cf-ray');
  eqA(d('', { 'x-vercel-id': 'iad1::abc' }).cdn, ['Vercel'], 'Vercel by x-vercel-id');
  eqA(d('', { 'x-amz-cf-id': 'abc' }).cdn, ['CloudFront'], 'CloudFront by x-amz-cf-id');
  eqA(d('', { server: 'cloudflare' }).cdn, ['Cloudflare'], 'Cloudflare when it is the Server header itself');
  // header lookup must not depend on the caller's casing — node lowercases, other sources may not
  eqA(d('', { 'CF-RAY': 'x' }).cdn, ['Cloudflare'], 'header matching is case-insensitive');
  eqA(d('', {}).cdn, [], 'no CDN signature is an empty list, not null');

  // ── safety ─────────────────────────────────────────────────────────────────────────────────────
  const empty = d(null, null);
  ok(empty && Array.isArray(empty.cms), 'null input is safe and still returns the full shape');
  eqA(Object.keys(d('', {})).sort(), ['cdn', 'cms', 'ecommerce', 'framework', 'server'], 'the shape is fixed, so a consumer can rely on every key');
  // one page, several layers — the real case
  const real = d('<meta name="generator" content="WordPress 6.5"><script id="__NEXT_DATA__">{}</script>', { server: 'nginx', 'cf-ray': 'z' });
  eqA(real.cms, ['WordPress'], 'layered: CMS still found alongside a framework');
  eqA(real.framework, ['Next.js'], 'layered: framework found alongside a CMS (headless is normal)');
  eqA(real.cdn, ['Cloudflare'], 'layered: CDN found from headers');
  ok(ts.SIGNATURE_ONLY_NOTE && /signature|spoof|removed/i.test(ts.SIGNATURE_ONLY_NOTE),
    'the module ships the caveat text, so no surface can present a signature as certainty');
}

// ── end to end: a real audit carries it ───────────────────────────────────────────────────────────
(async () => {
  const { runAudit } = require('./audit');
  const PORT = 7951;
  const srv = http.createServer((q, s) => {
    s.writeHead(200, { 'content-type': 'text/html', 'server': 'nginx/1.24.0', 'cf-ray': '8a1b2c3d' });
    s.end('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Stack fixture page</title>'
      + '<meta name="description" content="A description long enough to be treated as a real one by the auditor">'
      + '<meta name="generator" content="WordPress 6.5"></head>'
      + '<body><h1>Stack</h1><p>' + 'Words to keep the page from being thin. '.repeat(30) + '</p></body></html>');
  });
  await new Promise(r => srv.listen(PORT, '127.0.0.1', r));
  let res;
  try {
    res = await runAudit(`http://127.0.0.1:${PORT}/`, { maxPages: 3, render: false, log: () => {} });
  } finally {
    if (typeof srv.closeAllConnections === 'function') srv.closeAllConnections();
    await new Promise(r => srv.close(r));
  }
  ok(!!(res.techStack), 'the audit result carries techStack');
  if (res.techStack) {
    eqA(res.techStack.cms, ['WordPress'], 'e2e: WordPress detected from the served page');
    eqA(res.techStack.server, ['nginx'], 'e2e: nginx detected from the response header');
    eqA(res.techStack.cdn, ['Cloudflare'], 'e2e: Cloudflare detected from cf-ray');
    ok(Array.isArray(res.techStack.analytics), 'e2e: the analytics list still lives on techStack — one home for "what is this site made of"');
  }

  console.log(fails.length ? `\n❌ FAIL — ${pass} passed, ${fails.length} failed\n` : `\n✅ PASS — ${pass}/${pass} assertions\n`);
  for (const f of fails) console.log('   ✗ ' + f);
  process.exitCode = fails.length ? 1 : 0;
})();
