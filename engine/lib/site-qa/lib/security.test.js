'use strict';
// security.test.js — Batch 2 Security rules (per-page). Run: node lib/security.test.js
const { securityPageChecks } = require('./checks-security');

let fails = 0, total = 0;
const ok = (c, m) => { total++; if (!c) { console.error('  FAIL:', m); fails++; } };
const ids = (ctx) => securityPageChecks(ctx).map(f => f.ruleId);

const httpsBare = { url: 'https://x.test/', isHtml: true, html: '<html></html>', headers: {} };
// header split — all missing on a bare https page
let r = ids(httpsBare);
['SEC-011', 'SEC-012', 'SEC-013', 'SEC-014', 'SEC-015'].forEach(id => ok(r.includes(id), id + ' fires when header absent'));

// all headers present → clean
const secured = { url: 'https://x.test/', isHtml: true, html: '<html></html>', headers: {
  'content-security-policy': "default-src 'self'; frame-ancestors 'none'", 'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer', 'permissions-policy': 'geolocation=()', 'x-content-type-options': 'nosniff' } };
ok(securityPageChecks(secured).length === 0, 'fully-secured page → no header findings');

// cookies
const ck = { url: 'https://x.test/', isHtml: true, html: '<html></html>', headers: { ...secured.headers, 'set-cookie': ['sid=abc; Path=/', 'tok=xyz; Secure; HttpOnly; SameSite=Lax'] } };
r = ids(ck);
ok(r.includes('SEC-016'), 'SEC-016 cookie without Secure');
ok(r.includes('SEC-017'), 'SEC-017 cookie without HttpOnly');
ok(r.includes('SEC-018'), 'SEC-018 cookie without SameSite');
// the fully-flagged cookie alone → clean
const ck2 = { url: 'https://x.test/', isHtml: true, html: '<html></html>', headers: { ...secured.headers, 'set-cookie': 'tok=xyz; Secure; HttpOnly; SameSite=Lax' } };
ok(securityPageChecks(ck2).length === 0, 'fully-flagged cookie → clean');

// dangerous JS (heuristic)
ok(ids({ url: 'https://x.test/', isHtml: true, headers: secured.headers, html: '<script>eval(x)</script>' }).includes('SEC-023'), 'SEC-023 eval');
ok(ids({ url: 'https://x.test/', isHtml: true, headers: secured.headers, html: '<script>el.innerHTML=y</script>' }).includes('SEC-023'), 'SEC-023 innerHTML');
ok(!ids({ url: 'https://x.test/', isHtml: true, headers: secured.headers, html: '<script>const a=1</script>' }).includes('SEC-023'), 'safe script → no SEC-023');

// password over http + login GET
ok(ids({ url: 'http://x.test/login', isHtml: true, headers: {}, html: '<input type="password">' }).includes('SEC-024'), 'SEC-024 password over http');
ok(!ids({ url: 'https://x.test/login', isHtml: true, headers: secured.headers, html: '<input type="password">' }).includes('SEC-024'), 'password over https → no SEC-024');
ok(ids({ url: 'https://x.test/login', isHtml: true, headers: secured.headers, html: '<form method="get"><input type="password"></form>' }).includes('SEC-025'), 'SEC-025 login form GET');

// evidenceQuality: SEC-023 is heuristic, SEC-011 is verified (from registry)
const REG = require('../rules/registry');
ok(REG.getById('SEC-023').evidenceQuality === 'heuristic', 'SEC-023 heuristic');
ok(REG.getById('SEC-011').evidenceQuality === 'verified', 'SEC-011 verified');
ok(REG.getById('SEC-019').tier === 1, 'SEC-019 (.git exposed) is tier-1 blocker');

if (fails) { console.error(`❌ FAIL — ${total - fails}/${total} assertions`); process.exit(1); }
console.log(`✅ PASS — ${total}/${total} assertions`);
