'use strict';
// score-integrity-e2e.test.js — ADR-0011 Phase 4. THE ASSERTION WHOSE ABSENCE LET THIS SHIP.
//
// The inflation existed only on the production path: `applyAdvisory`'s `changed` flag needs
// `collectPages: true`, which the app sets and a direct `runAudit` call does not. Every unit test in
// this repository called runAudit directly, so 49/49 green said nothing about it.
//
// This suite therefore touches NO internals. It spawns the real `sgen-qa-serve.js`, drives it over
// HTTP, and reads the report.json the app actually wrote — default runs, scoped runs, advisory
// results, sealed collections, and a real browser render, all through the real pipeline.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const cp = require('child_process');

let pass = 0, fail = 0; const failures = [];
function ok(c, n) { if (c) pass++; else { fail++; failures.push(n); console.log('  ✗ ' + n); } }
function eq(a, b, n) { ok(JSON.stringify(a) === JSON.stringify(b), n + (JSON.stringify(a) === JSON.stringify(b) ? '' : ` (got ${JSON.stringify(a)})`)); }

const SERVE = path.resolve(__dirname, '..', '..', '..', 'sgen-qa-serve.js');
const RUNS = path.resolve(__dirname, '..', '..', '..', '..', 'sgen', 'W5-Live-Surface-Audit', 'site-qa', '_ui-runs');

const PAGE = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>e2e</title>'
  + '<meta name="description" content="deterministic page driving the real server for score declaration integrity"></head>'
  + '<body><header><nav><a href="/">h</a></nav></header><h1>E2E</h1>'
  + '<p>Lorem ipsum dolor sit amet placeholder text here</p><footer>f</footer></body></html>';

function bootServe(port, env) {
  const child = cp.spawn(process.execPath, [SERVE, '--port', String(port)], {
    cwd: path.dirname(SERVE), env: Object.assign({}, process.env, env || {}), stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    let out = '';
    const t = setTimeout(() => reject(new Error('server did not start: ' + out.slice(0, 200))), 30000);
    const on = d => { out += d.toString(); if (/127\.0\.0\.1:\d+|listening|ready/i.test(out)) { clearTimeout(t); resolve(child); } };
    child.stdout.on('data', on); child.stderr.on('data', on);
    child.on('exit', c => { clearTimeout(t); reject(new Error('server exited (' + c + '): ' + out.slice(0, 200))); });
  });
}
function post(port, route, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request({ host: '127.0.0.1', port, path: route, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, res => {
      let d = ''; res.on('data', x => { d += x; }); res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', reject); req.setTimeout(240000, () => reject(new Error(route + ' timed out'))); req.end(body);
  });
}
// The report.json the APP wrote — read from disk, never reconstructed.
function newestReport(since) {
  const dirs = fs.readdirSync(RUNS).map(d => path.join(RUNS, d))
    .filter(d => { try { return fs.statSync(d).isDirectory() && fs.statSync(d).mtimeMs > since && fs.existsSync(path.join(d, 'report.json')); } catch (_) { return false; } })
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return dirs.length ? JSON.parse(fs.readFileSync(path.join(dirs[0], 'report.json'), 'utf8')) : null;
}

console.log('Score declaration integrity — REAL SERVER e2e (ADR-0011) — test suite\n');

(async function main() {
  let site, serve;
  try {
    site = await new Promise(r => { const s = http.createServer((q, res) => {
      if (q.url === '/robots.txt') { res.writeHead(404); return res.end('x'); }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(PAGE);
    }); s.listen(0, '127.0.0.1', () => r(s)); });
    const target = 'http://127.0.0.1:' + site.address().port + '/';

    // Collections ON so the sealed-collection assertion is exercised on the same run.
    serve = await bootServe(7921, { SGEN_QA_COLLECTIONS: '1' });

    // ── 1 · DEFAULT RUN (no render) — the path that shipped the inflation ────────────────────────
    let t0 = Date.now() - 1000;
    const r1 = await post(7921, '/api/run', { url: target, maxPages: 1, render: false });
    eq(r1.status, 200, 'default: /api/run returned 200');
    const rep1 = newestReport(t0);
    ok(!!rep1, 'default: the app wrote a report.json');
    eq(rep1.quality.evaluationDeclared, true, 'DEFAULT RUN: evaluationDeclared SURVIVES to report.json — the assertion whose absence let this ship');
    const cat = (q, k) => { const c = (q.categories || []).find(x => x.key === k); return c ? c.score : undefined; };
    eq(cat(rep1.quality, 'crossbrowser'), null, 'default: crossbrowser is null — nothing ran, so no opinion');
    eq(cat(rep1.quality, 'console'), null, 'default: console is null');
    ok(rep1.coverage && rep1.coverage.counts.rulesNotEvaluated > 0, 'default: the report records un-evaluated rules');
    for (const id of ['FUNC-008', 'FUNC-009', 'BP-001', 'COPY-001']) {
      ok(rep1.coverage.evaluatedRules.includes(id), `default: advisory rule ${id} declared as evaluated in the shipped record`);
    }
    ok(rep1.suites.some(s => s.key === 'best-practices'), 'default: the advisory suites really did run');

    // ── 2 · SCOPED RUN — the inversion must be gone ──────────────────────────────────────────────
    t0 = Date.now() - 1000;
    const r2 = await post(7921, '/api/run', { url: target, maxPages: 1, render: false, excludeRules: ['SEO-002'] });
    eq(r2.status, 200, 'scoped: /api/run returned 200');
    const rep2 = newestReport(t0);
    eq(rep2.quality.evaluationDeclared, true, 'scoped: still declared');
    ok(rep2.quality.overall <= rep1.quality.overall + 1,
      `INVERSION GONE: scoping no longer makes the score dramatically more honest (unscoped ${rep1.quality.overall} vs scoped ${rep2.quality.overall})`);

    // ── 3 · SEALED COLLECTION on the same production path ────────────────────────────────────────
    const { CollectionStore } = require('./index');
    const store = new CollectionStore(path.resolve(__dirname, '..', '..', '..', '..', 'sgen', 'W5-Live-Surface-Audit', 'site-qa', '_auditor-data', 'collections'));
    ok(store.count() > 0, `collections: the production path sealed acquisitions (${store.count()})`);
    eq(store.verify().ok, true, 'collections: sealed collections verify');

    // ── 4 · REAL BROWSER RUN — render on, the full pipeline ──────────────────────────────────────
    t0 = Date.now() - 1000;
    const r3 = await post(7921, '/api/run', { url: target, maxPages: 1, render: true, viewports: ['1920 · Desktop'] });
    eq(r3.status, 200, 'render: /api/run with a real browser returned 200');
    const rep3 = newestReport(t0);
    eq(rep3.quality.evaluationDeclared, true, 'RENDER RUN: evaluationDeclared survives with a real browser too');
    ok(rep3.render && rep3.render.rendered > 0, `render: a real page was rendered (${rep3.render && rep3.render.rendered})`);
    ok(cat(rep3.quality, 'console') !== null, 'render: console now HAS an opinion — it actually measured something');
    ok(rep3.quality.overall >= rep1.quality.overall,
      `render: measuring more scores no lower than measuring less (${rep1.quality.overall} -> ${rep3.quality.overall})`);

    // ── 5 · the inflated number must not appear anywhere the app wrote ───────────────────────────
    for (const [n, rep] of [['default', rep1], ['scoped', rep2], ['render', rep3]]) {
      ok(rep.quality.evaluationDeclared === true, `${n}: declared`);
      ok(rep.quality.model === 'sgen-quality-v2', `${n}: scoring model unchanged`);
    }
  } catch (e) {
    ok(false, 'e2e: suite FAILED — ' + String((e && e.message) || e).slice(0, 300));
  } finally {
    if (serve) { try { serve.kill(); } catch (_) {} }
    if (site) { try { site.close(); } catch (_) {} }
  }

  console.log('\n' + (fail === 0 ? '✅ PASS' : '❌ FAIL') + ` — ${pass}/${pass + fail} assertions`);
  if (fail) { console.log('Failures:\n' + failures.map(f => '  - ' + f).join('\n')); process.exit(1); }
})();
