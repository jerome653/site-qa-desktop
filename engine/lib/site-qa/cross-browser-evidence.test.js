'use strict';
// Reproduce the reported staging failure shape locally: the document loads fine, but a subresource NEVER
// responds. That is what stops `networkidle` from ever firing and, because the request is still in
// flight, holds the load event too. Assert the row now carries the evidence that was missing.
const http = require('http');
const path = require('path');
const os = require('os');

const { renderIn } = require('./cross-browser');

// The hang is on NON-render-blocking subresources (an image and a beacon), which is Jerome's actual
// case — a stuck analytics POST and an icon font, not a stylesheet. That matters: a hanging <link
// rel=stylesheet> in <head> legitimately blocks DOMContentLoaded (verified — the first run of this
// test reported domReady=false and the engine was right), so it would exercise the "document never
// arrived" branch. This shape exercises the more useful one: DOM fine, a subresource never finishes.
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Hanging</title></head>
<body><h1>Document is fine</h1>
<img src="/never-responds.css" alt="stuck"><img src="/also-hangs.js" alt="stuck too"></body></html>`;

const srv = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  if (u === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(html); }
  if (u === '/dead-host.png') { res.destroy(); return; }          // hard failure -> requestfailed
  // never respond, never close: the exact "still in flight" case
});

srv.listen(0, '127.0.0.1', async () => {
  const url = 'http://127.0.0.1:' + srv.address().port + '/';
  const shots = os.tmpdir();
  console.log('driving webkit against a page with hanging subresources (expect ~55s)...\n');
  const t0 = Date.now();
  const b = await renderIn('webkit', url, shots);
  const took = Math.round((Date.now() - t0) / 1000);

  let bad = 0; const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) bad++; };
  if (!b.available) { console.log('  SKIP — webkit not installed here: ' + b.note); srv.close(); process.exit(0); }

  console.log('  elapsed: ' + took + 's · ok=' + b.ok + ' · domReady=' + b.domReady);
  console.log('  attempts: ' + JSON.stringify(b.attempts));
  console.log('  stalled : ' + JSON.stringify((b.stalled || []).map(s => s.url.replace(/^http:\/\/[^/]+/, ''))));
  console.log('  failed  : ' + JSON.stringify((b.failedReq || []).map(s => s.url.replace(/^http:\/\/[^/]+/, '') + ' ' + s.why)) + '\n');

  ok(b.ok === false, 'the hanging page is reported as a navigation failure');
  ok(took < 70, `the whole failing engine finishes under 70s (was 102s measured) — took ${took}s`);
  ok(Array.isArray(b.attempts) && b.attempts.length === 2, 'both goto attempts are recorded');
  ok(b.attempts[0] && b.attempts[0].waitUntil === 'networkidle' && b.attempts[0].ok === false, 'attempt 1 = networkidle, recorded as failed');
  ok(b.attempts[1] && b.attempts[1].waitUntil === 'load', 'attempt 2 = load');
  ok(b.attempts[1] && b.attempts[1].ms < 20000, 'the load fallback is capped near 15s, not another 40s');
  ok(b.domReady === true, 'DOMContentLoaded is recorded as fired — proves the DOCUMENT was fine and a SUBRESOURCE hung');
  // The culprits land in EITHER bucket and which one is engine-specific: WebKit cancels its pending
  // requests when the navigation times out, so they arrive as `requestfailed` rather than as still-
  // in-flight. Chromium/Firefox can leave them pending. The row prints both lists, so the assertion
  // is on the union — pinning one bucket would pass on one engine and fail on another.
  const culprits = [...(b.failedReq || []).map(r => r.url), ...(b.stalled || []).map(r => r.url)];
  ok(culprits.length > 0, 'the requests that failed or were still in flight are captured (the culprit list)');
  ok(culprits.some(u => /never-responds\.css|also-hangs\.js/.test(u)), 'the actual hanging URLs are named');
  ok((b.stalled || []).every(s => typeof s.waitedMs === 'number'), 'any stalled request carries how long it was waited on');
  ok(typeof b.navErr === 'string' && b.navErr.length > 0, 'the raw engine error is still reported');

  console.log((bad?'FAIL':'PASS')+' cross-browser-evidence.test.js — '+(11-bad)+'/11 assertions');
  srv.close(); process.exit(bad ? 1 : 0);
});
