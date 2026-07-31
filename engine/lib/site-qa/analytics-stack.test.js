'use strict';
// analytics-stack.test.js — "Analytics / tracking detected" must say WHICH.
//
// The detector has known the vendor since it was written: checks-static.js builds a `found` array of
// GA4 / GTM / Meta Pixel / LinkedIn and, on a LIVE run, returns null when anything is present — a silent
// pass. The row then rendered the generic PASS_LABEL, "Analytics / tracking detected", and the vendor
// list died in a local variable. On staging the same detector names them. So the tool knew, and only
// the environment decided whether it said so.
//
// Written BEFORE the implementation and watched failing.
const http = require('http');
const path = require('path');

let pass = 0; const fails = [];
const ok = (c, n) => { if (c) pass++; else fails.push(n); };
const eqA = (a, b, n) => ok(JSON.stringify(a) === JSON.stringify(b), n + ` (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
const has = (s, re, n) => ok(re.test(String(s)), n + ` (got "${String(s).slice(0, 90)}")`);

console.log('\nAnalytics stack — name what was detected, do not just say "detected"\n');

// ── 1) the detector is a pure, exported function ──────────────────────────────────────────────────
const cs = require('../migration-qa/checks-static');
ok(typeof cs.detectAnalytics === 'function', 'checks-static exports detectAnalytics()');
if (typeof cs.detectAnalytics === 'function') {
  const d = cs.detectAnalytics;
  eqA(d('<script>gtag("config","G-ABC1234")</script>'), ['GA4'], 'GA4 by gtag + measurement id');
  eqA(d('<script src="https://www.googletagmanager.com/gtm.js?id=GTM-ABCD"></script>'), ['GTM'], 'GTM by loader url');
  eqA(d('<script>fbq("init","1")</script>'), ['Meta Pixel'], 'Meta Pixel by fbq');
  eqA(d('<script>_linkedin_partner_id="123"</script>'), ['LinkedIn'], 'LinkedIn by partner id');
  eqA(d('<p>nothing here</p>'), [], 'a clean page detects nothing');
  eqA(d(''), [], 'empty html is safe');
  eqA(d(null), [], 'null html is safe');
  const both = d('<script>gtag("config","G-ABC1234")</script><script src="https://www.googletagmanager.com/gtm.js?id=GTM-ABCD"></script><script>fbq("init","1")</script>');
  eqA(both, ['GA4', 'GTM', 'Meta Pixel'], 'multiple vendors are returned in a stable order');
}

// ── 2) end to end: a LIVE run names the stack on the passing row ──────────────────────────────────
(async () => {
  const { runAudit } = require('./audit');
  // Ephemeral, not fixed. A fixed port collides the moment anything else on the machine holds it —
  // this one binds BEFORE it connects, so a collision is a loud EADDRINUSE rather than the silent
  // talk-to-a-stranger failure found in seo-split/ui-script, but a suite that cannot run beside a
  // second session is still a suite that blocks work. Assigned once listen() resolves.
  let PORT = 0;
  const srv = http.createServer((q, s) => {
    s.writeHead(200, { 'content-type': 'text/html' });
    s.end('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Analytics fixture page</title>'
      + '<meta name="description" content="A description long enough to be treated as a real one by the auditor">'
      + '<script>gtag("config","G-ABC1234")</script>'
      + '<script src="https://www.googletagmanager.com/gtm.js?id=GTM-ABCD"></script></head>'
      + '<body><h1>Analytics</h1><p>' + 'Words to keep the page from being thin. '.repeat(30) + '</p></body></html>');
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', () => { PORT = srv.address().port; r(); }));
  let res;
  try {
    res = await runAudit(`http://127.0.0.1:${PORT}/`, { maxPages: 3, render: false, log: () => {} });
  } finally {
    // Close keep-alive sockets and WAIT for the server to actually shut before the process ends.
    // srv.close() alone leaves agent sockets open, and process.exit() on top of that trips libuv's
    // "!(handle->flags & UV_HANDLE_CLOSING)" assertion — which aborts with a NON-ZERO exit code even
    // though every assertion passed. run-all.js reads the exit code, so a green test reported as a
    // failed suite. The teardown is part of the test.
    if (typeof srv.closeAllConnections === 'function') srv.closeAllConnections();
    await new Promise(r => srv.close(r));
  }

  const rows = (res.suites || []).flatMap(s => (s.checks || []).map(c => ({ ...c, _suite: s.key })));
  const arow = rows.find(r => r.check === 'analytics');
  ok(!!arow, 'the analytics row is present in the result');
  if (arow) {
    ok(arow.status === 'pass', 'analytics is a PASS on a live page that has tracking (got ' + arow.status + ')');
    const text = [arow.name, arow.detail, arow.value, arow.target].filter(Boolean).join(' | ');
    has(text, /GA4/, 'the row names GA4');
    has(text, /GTM/, 'the row names GTM');
    ok(!/Meta Pixel/.test(text), 'the row does NOT name a vendor that is absent');
  }
  // and the machine-readable form, so a consumer does not have to scrape the sentence
  ok(res.techStack && Array.isArray(res.techStack.analytics), 'result carries techStack.analytics for consumers');
  if (res.techStack && Array.isArray(res.techStack.analytics))
    eqA(res.techStack.analytics.slice().sort(), ['GA4', 'GTM'], 'techStack.analytics lists exactly what was found');

  console.log(fails.length ? `\n❌ FAIL — ${pass} passed, ${fails.length} failed\n` : `\n✅ PASS — ${pass}/${pass} assertions\n`);
  for (const f of fails) console.log('   ✗ ' + f);
  // exitCode, not exit(): let the loop drain so the verdict is the assertions' verdict and not a
  // teardown race. Playwright/undici sockets from runAudit are still settling at this point.
  process.exitCode = fails.length ? 1 : 0;
})();
