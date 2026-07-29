'use strict';
// seo-split.test.js — SEO is its own tool, and Site Audit is purely technical.
//
// THE DEFECT THIS EXISTS TO PREVENT. Splitting a suite out of a scored product is a SCORE change, not a
// UI change. Two ways to get it wrong, both invisible to a screenshot:
//   1. Site Audit stops SHOWING SEO but keeps SEO's registry risk in the denominator — a nine-suite
//      score presented as a ten-suite one. ADR-0011 is exactly this class of lie.
//   2. Site Audit drops SEO's risk from the denominator only, banking its rules as resolved — which
//      would RAISE the technical score for removing work. Scope must narrow the question, never
//      restore the inflation.
// So this suite asserts the SCORE CONTRACT, not the tab bar: which suites ran, and what the coverage
// declaration says about the ones that did not.
//
// It touches no internals. It spawns the real sgen-qa-serve.js, drives /api/run and /api/seo over HTTP,
// and reads the report.json the APP wrote — because the split lives in the server's scope derivation
// and a unit test of audit.js could not see it.
const cp = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

let pass = 0, fail = 0; const failures = [];
function ok(c, n) { if (c) pass++; else { fail++; failures.push(n); console.log('  ✗ ' + n); } }
function eq(a, b, n) { const g = JSON.stringify(a), w = JSON.stringify(b); ok(g === w, n + (g === w ? '' : ` (got ${g}, want ${w})`)); }

const SERVE = path.resolve(__dirname, '..', '..', 'sgen-qa-serve.js');
const RUNS = path.resolve(__dirname, '..', '..', '..', 'sgen', 'W5-Live-Surface-Audit', 'site-qa', '_ui-runs');
const { SUITES } = require('./audit');

const PAGE = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>seo split</title>'
  + '<meta name="description" content="deterministic page driving the real server for the seo split"></head>'
  + '<body><header><nav><a href="/">h</a></nav></header><h1>Split</h1><p>Body copy for the split test.</p><footer>f</footer></body></html>';

function bootServe(port) {
  const child = cp.spawn(process.execPath, [SERVE, '--port', String(port)], {
    cwd: path.dirname(SERVE), env: Object.assign({}, process.env), stdio: ['ignore', 'pipe', 'pipe'],
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
// The run directory the APP wrote — located by id from the stream's own done message, never guessed.
function reportFor(id) {
  const f = path.join(RUNS, id, 'report.json');
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
}
function doneOf(ndjson) {
  for (const line of ndjson.split('\n')) {
    if (!line.trim()) continue;
    try { const m = JSON.parse(line); if (m.t === 'done') return m; } catch (_) {}
  }
  return null;
}

console.log('SEO split — Site Audit is technical, SEO is its own tool — REAL SERVER e2e — test suite\n');

(async function main() {
  let site, serve;
  try {
    site = await new Promise(r => {
      const s = http.createServer((q, res) => {
        if (q.url === '/robots.txt') { res.writeHead(404); return res.end('x'); }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(PAGE);
      }); s.listen(0, '127.0.0.1', () => r(s));
    });
    const target = 'http://127.0.0.1:' + site.address().port + '/';
    const port = 7800 + (process.pid % 90);
    serve = await bootServe(port);

    // ── 1 · SITE AUDIT — nine suites, SEO genuinely absent ────────────────────────────────────────
    const aRes = await post(port, '/api/run', { url: target, maxPages: 1, render: false });
    const aDone = doneOf(aRes.body);
    ok(aDone && aDone.ok, 'audit: /api/run completed' + (aDone && aDone.error ? ' — ' + aDone.error : ''));
    const A = aDone && aDone.ok ? reportFor(aDone.id) : null;
    ok(!!A, 'audit: the app wrote a report.json');

    if (A) {
      const keys = A.suites.map(s => s.key);
      ok(!keys.includes('seo'), 'audit: the seo suite is ABSENT from the report — not merely hidden');
      // MEASURED, not assumed: a Site Audit report also carries the weight-0 ADVISORY suites
      // (best-practices, copy) that applyAdvisory() appends and that are NOT part of audit.js's SUITES.
      // They are orthogonal to this split, so count the scored suites only.
      const SUITE_KEYS = new Set(SUITES.map(x => x.key));
      eq(keys.filter(k => SUITE_KEYS.has(k)).length, SUITES.length - 1, 'audit: exactly nine of the ten scored suites present');
      // The score contract. SEO must leave the DENOMINATOR with the suite; if its rules stayed declared
      // as evaluated they would bank as resolved risk and removing SEO would RAISE the technical score.
      const declared = A.coverage && Array.isArray(A.coverage.evaluatedRules) ? A.coverage.evaluatedRules : null;
      ok(!!declared, 'audit: a coverage declaration is present (ADR-0011)');
      eq(A.quality && A.quality.evaluationDeclared, true, 'audit: evaluationDeclared stays TRUE — the score still states what it covers');
      if (declared) {
        const rules = require('./rules/registry');
        const all = (rules.all ? rules.all() : rules.RULES) || [];
        const seoIds = new Set(all.filter(r => r.suite === 'seo').map(r => r.id));
        const leaked = declared.filter(id => seoIds.has(id));
        eq(leaked, [], 'audit: NO seo rule is declared evaluated — its risk leaves the denominator with it, so the split cannot buy points');
      }
      ok(!(A.quality.categories || []).some(c => c.suite === 'seo' || c.key === 'seo'),
        'audit: no seo category in the quality breakdown');
      // The narrowing is recorded on disk, not just rendered.
      ok(A.scope && Array.isArray(A.scope.suitesNotRun) && A.scope.suitesNotRun.includes('seo'),
        'audit: report.json records seo in scope.suitesNotRun — the narrowing is auditable after the fact');
    }

    // ── 2 · SEO TOOL — the exact complement ───────────────────────────────────────────────────────
    const sRes = await post(port, '/api/seo', { url: target, maxPages: 1, render: false });
    const sDone = doneOf(sRes.body);
    ok(sDone && sDone.ok, 'seo: /api/seo completed' + (sDone && sDone.error ? ' — ' + sDone.error : ''));
    eq(sDone && sDone.mode, 'seo', 'seo: the done message carries mode:"seo" so the client can state scope instead of listing nine NOT RUN sections');
    ok(sDone && /-seo-\d+$/.test(sDone.id || ''), 'seo: the run id is marked -seo- so listRuns() can classify it from the id alone');

    const S = sDone && sDone.ok ? reportFor(sDone.id) : null;
    ok(!!S, 'seo: the app wrote a report.json');
    if (S) {
      eq(S.suites.map(x => x.key), ['seo'], 'seo: EXACTLY the seo suite ran — no advisory pass, nothing else');
      eq(S.quality && S.quality.evaluationDeclared, true, 'seo: evaluationDeclared stays TRUE — an SEO score that states its coverage');
      const declared = S.coverage && Array.isArray(S.coverage.evaluatedRules) ? S.coverage.evaluatedRules : [];
      const rules = require('./rules/registry');
      const all = (rules.all ? rules.all() : rules.RULES) || [];
      const nonSeo = new Set(all.filter(r => r.suite !== 'seo').map(r => r.id));
      eq(declared.filter(id => nonSeo.has(id)), [],
        'seo: no NON-seo rule is declared evaluated — the SEO score is an SEO score, not a whole-site score in disguise');
    }

    // ── 3 · THE TWO TOOLS ARE COMPLEMENTARY, NOT OVERLAPPING ──────────────────────────────────────
    if (A && S) {
      const aKeys = new Set(A.suites.map(s => s.key));
      const sKeys = new Set(S.suites.map(s => s.key));
      const KEYS = new Set(SUITES.map(x => x.key));
      const aScored = [...aKeys].filter(k => KEYS.has(k)), sScored = [...sKeys].filter(k => KEYS.has(k));
      eq(aScored.filter(k => sScored.includes(k)), [], 'split: the two tools share NO scored suite — no check is scored twice across the product');
      eq(aScored.concat(sScored).sort(), SUITES.map(x => x.key).sort(),
        'split: together they cover every suite audit.js declares — the split loses nothing');
    }
  } catch (e) {
    ok(false, 'harness: ' + String(e && e.message || e));
  } finally {
    try { serve && serve.kill(); } catch (_) {}
    try { site && site.close(); } catch (_) {}
  }

  console.log('\n' + (fail === 0 ? '✅ PASS' : '❌ FAIL') + ` — ${pass}/${pass + fail} assertions`);
  if (fail) { console.log('Failures:\n' + failures.map(f => '  - ' + f).join('\n')); process.exit(1); }
})();
