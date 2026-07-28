'use strict';
// report-merged.test.js — the 4.4.0 report is ONE findings list, and the honesty contract survived
// the merge.
//
// WHAT THIS PINS. Before 4.4.0 the report rendered the same checks TWICE: a flat "Issues" list
// (fail|warn only) and a "Passed tests & per-section detail" tree (everything), with "detail →"
// jumping between them. They were merged into one filtered, section-grouped list. Two things can rot
// silently after a merge like that, and neither shows up in a screenshot:
//   1. a host element or handler gets half-removed, so the list renders empty on a real scan;
//   2. the ignore disclosure or the PASSED/REVIEW split quietly goes missing, and the report starts
//      implying that a manual or never-ran check passed — the exact inflation score.js exists to kill.
// Structural assertions over the EMITTED html, plus a parse of the client script, catch both without
// needing a browser. (Interaction — chips filtering, in-place expand, ignore marking — is driven with
// Playwright separately; that needs browsers this suite does not assume.)

const assert = require('assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runAudit } = require('./audit');
const { renderReport } = require('./report');

const PAGES = { '/': 'Home', '/blog/post-1': 'Post 1', '/services': 'Services', '/about': 'About', '/contact': 'Contact' };
const page = (t) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${t}</title></head>
<body><header><nav><a href="/">Home</a></nav></header><main><h1>${t}</h1>
<p>${'Body copy. '.repeat(20)}</p><img src="/x.png"></main><footer><p>F</p></footer></body></html>`;

let PORT = 0;
const srv = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  if (u === '/sitemap.xml') {
    res.writeHead(200, { 'content-type': 'application/xml' });
    return res.end('<?xml version="1.0"?><urlset>' + Object.keys(PAGES).filter(p => p !== '/')
      .map(p => '<loc>http://127.0.0.1:' + PORT + p + '</loc>').join('') + '</urlset>');
  }
  if (u === '/robots.txt') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('User-agent: *'); }
  if (PAGES[u] != null) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(page(PAGES[u])); }
  res.writeHead(404, { 'content-type': 'text/html' }); res.end('<html><body>404</body></html>');
});

let n = 0, bad = 0;
const ok = (c, m) => { n++; if (c) return; bad++; console.error('  FAIL: ' + m); };

srv.listen(0, '127.0.0.1', async () => {
  PORT = srv.address().port;
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'siteqa-report-merged-'));
  try {
    const data = await runAudit('http://127.0.0.1:' + PORT + '/', { maxPages: 5, render: false, log() {}, progress() {} });
    const { htmlPath } = renderReport(data, out, {});
    const h = fs.readFileSync(htmlPath, 'utf8');

    // ── 1) ONE list, and the two old hosts are gone (a leftover host renders an empty duplicate) ──
    ok(h.includes('id="findsec"'), 'the merged findings section is present');
    ok(!h.includes('id="issec"'), 'the old flat Issues host is gone');
    ok(!h.includes('id="results"'), 'the old per-section results host is gone');
    ok(!/class="tabs"/.test(h), 'the old status tab-bar is gone');
    ok(!/Passed tests &amp; per-section detail/.test(h), 'the old second heading is gone');
    ok(!/>detail \\u2192</.test(h), 'the cross-table "detail →" jump is gone with the table it jumped to');

    // ── 2) all six filters exist. PASSED and REVIEW are SEPARATE — folding manual / never-ran rows
    // under "Passed" would restate the not-run-reads-as-pass defect in the UI. ────────────────────
    ["'all'", "'1'", "'2'", "'3'", "'pass'", "'review'"].forEach((f) =>
      ok(h.includes('issPrio(' + f.replace(/'/g, "\\'")) || h.includes(f), 'filter wired: ' + f));
    ok(h.includes('PASSED') && h.includes('REVIEW'), 'PASSED and REVIEW are distinct chips');

    // ── 3) the row model + renderers the merged list depends on ──────────────────────────────────
    ['function allRows', 'function rowMatches', 'function detailRow', 'function issueRow',
     'function summaryMD', 'window.secToggle', 'window.renderIssues'].forEach((s) =>
      ok(h.includes(s), 'present: ' + s));

    // ── 4) copy affordances at all three levels ──────────────────────────────────────────────────
    ok(h.includes('Copy summary'), 'report-level copy summary');
    ok(h.includes('Copy section summary'), 'per-section copy summary');
    ok(h.includes('Copy for dev'), 'per-finding dev ticket copy');

    // ── 5) THE HONESTY CONTRACT — unchanged by the merge ─────────────────────────────────────────
    // Ignore stays a VIEW filter: rows are marked, never removed, and the reduced view is disclosed.
    // If this ever silently becomes a scoring control, the report can be made to look clean by
    // clicking, which is the single worst thing this file could ship.
    ok(h.includes('REDUCED VIEW'), 'the reduced-view disclosure survived');
    ok(h.includes('view filter only'), 'ignore is still documented as view-only');
    ok(h.includes('launch gate'), 'the disclosure still says a waived blocker does not clear launch');
    ok(h.includes('.iss.ignored'), 'ignored rows are styled as marked, not removed');

    // ── 6) the emitted client script actually parses (a stray backtick in the CLIENT template
    // literal produced a report that rendered blank with a console SyntaxError — caught once) ─────
    const m = h.match(/<script>((?:(?!<\/script>)[\s\S])*renderIssues\(\);[\s\S]*?)<\/script>/);
    ok(!!m, 'the client script block is locatable');
    if (m) {
      let parsed = true;
      try { new Function(m[1]); } catch (e) { parsed = false; console.error('  parse error: ' + e.message); }
      ok(parsed, 'the emitted client JS parses');
    }
    ok(!/>\[object Object\]</.test(h), 'no object stringified into the markup');
  } catch (e) {
    bad++; console.error('  FAIL: threw — ' + (e && e.message || e));
  } finally {
    try { fs.rmSync(out, { recursive: true, force: true }); } catch (_) {}
    srv.close();
  }
  console.log((bad ? 'FAIL' : 'PASS') + ' report-merged.test.js — ' + (n - bad) + '/' + n + ' assertions');
  process.exit(bad ? 1 : 0);
});
