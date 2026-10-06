'use strict';
// canonical.test.js — the static canonical check (checks-static.js, check id 'canonical') against
// Google's rel=canonical guidance (Search Central, "Consolidate duplicate URLs"):
//   · a relative canonical is accepted by Google but it recommends absolute URLs   → SEO-050 (low)
//   · a canonical on another site tells Google to index THAT page; correct only for
//     syndicated content                                                            → SEO-051 (low, live)
//   · a staging/preview host is a real leak and stays critical                     → SEO-006
// Before this, all four cases in A:/AI/_metrics/siteaudit-canonical-miss.mjs passed silently.
// Run: node lib/migration-qa/canonical.test.js
const { STATIC_CHECKS, buildCtx } = require('./checks-static');
const REG = require('../site-qa/rules/registry');

let fails = 0, total = 0;
const ok = (c, m) => { total++; if (!c) { console.error('  FAIL:', m); fails++; } };
const chk = STATIC_CHECKS.find(c => c.id === 'canonical');
const PAGE = 'https://example.com/page';
function run(linkTag, env = 'live', url = PAGE) {
  const body = `<!doctype html><html><head><title>t</title>${linkTag}</head><body><main>x</main></body></html>`;
  const c = buildCtx({ url, status: 200, body, contentType: 'text/html', headers: { 'content-type': 'text/html' } }, new URL(url).host);
  return chk.fn(c, { env });
}
const canon = (href, env, url) => run(`<link rel="canonical" href="${href}">`, env, url);
const id = (f) => (f ? f.ruleId : null);

// registry — both rules exist, are SEO, and warn rather than fail (low → 'warn' in audit.js sevToStatus)
for (const rid of ['SEO-050', 'SEO-051']) {
  const r = REG.getById(rid);
  ok(r && r.suite === 'seo' && r.category === 'canonical', `${rid} registered in seo/canonical`);
  ok(r && r.severity === 'low', `${rid} is a warning (severity low), not a fail`);
}

// relative canonicals — every env, because the markup ships as-is
for (const href of ['/relative/page', 'page.html', '//example.com/page']) {
  ok(id(canon(href)) === 'SEO-050', `relative canonical "${href}" → SEO-050 on live`);
  ok(id(canon(href, 'staging')) === 'SEO-050', `relative canonical "${href}" → SEO-050 on staging`);
}
ok(/absolute/i.test((canon('/relative/page') || {}).detail || ''), 'SEO-050 detail cites Google recommending absolute URLs');

// cross-site canonicals — live only (staging lives on a different host than production by design)
for (const href of ['https://competitor.com/page', 'https://other-site.org/']) {
  ok(id(canon(href)) === 'SEO-051', `cross-site canonical "${href}" → SEO-051`);
  ok(canon(href, 'staging') === null, `cross-site canonical "${href}" is not judged on staging`);
}
ok(/syndicated/i.test((canon('https://competitor.com/page') || {}).detail || ''), 'SEO-051 detail says it is correct only for syndicated content');
ok((canon('https://competitor.com/page') || {}).value === 'competitor.com', 'SEO-051 value names the other host');

// same site — no finding
ok(canon('https://example.com/page') === null, 'self canonical → clean');
ok(canon('https://example.com/other') === null, 'same-host canonical to another path → clean (not this check\'s concern)');
ok(canon('https://www.example.com/page') === null, 'www. vs bare host → same site');
ok(canon('https://example.com/page', 'live', 'https://www.example.com/page') === null, 'bare canonical from a www. page → same site');
ok(canon('https://blog.example.com/x') === null, 'subdomain canonical → same site');
ok(canon('https://example.com/x', 'live', 'https://shop.example.com/p') === null, 'parent-domain canonical from a subdomain → same site');
ok(id(canon('https://notexample.com/page')) === 'SEO-051', 'a host that merely ends with the same letters is another site');

// staging host — the real leak, still critical, takes precedence over cross-site
ok(id(canon('https://staging.example.com/page')) === 'SEO-006', 'staging host canonical → SEO-006 (unchanged)');
ok(id(canon('https://preview.agency.com/page')) === 'SEO-006', 'off-domain staging host → SEO-006, not SEO-051');

// missing / empty
ok(id(run('')) === 'SEO-005', 'no canonical → SEO-005 (unchanged)');
ok(canon('') === null, 'empty href → no host/relative finding');

// detection agrees with indexability/index.js canonicalFrom(), which accepts an unquoted rel value
ok(id(run('<link rel=canonical href="https://competitor.com/page">')) === 'SEO-051', 'unquoted rel=canonical is read, as indexability reads it');

if (fails) { console.error(`❌ FAIL — ${total - fails}/${total} assertions`); process.exit(1); }
console.log(`✅ PASS — ${total}/${total} assertions`);
