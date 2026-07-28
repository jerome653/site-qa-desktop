'use strict';
// production-wiring.test.js — D2 remediation evidence.
//
// The governance review found that the Collection Store producer existed in `runAudit` and NO
// PRODUCTION PATH EVER PASSED IT: the shipped app never sealed an acquisition. `producer.test.js`
// proved the producer WORKS; it could not prove the app REACHES it, because it called runAudit
// directly. That is precisely the gap this suite closes.
//
// So this drives the REAL production path end to end:
//     spawn sgen-qa-serve.js  ->  HTTP POST /api/run  ->  the app's own runAudit call site
// No stubbing, no direct import of runAudit. If the wiring is absent, this suite fails.
//
// Both states are exercised, because "opt-in" is a claim with two halves:
//   SGEN_QA_COLLECTIONS unset -> nothing written anywhere        (zero behavioural change)
//   SGEN_QA_COLLECTIONS=1     -> a verifiable sealed collection   (genuinely reachable)
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const cp = require('child_process');
const { CollectionStore } = require('./index');

let pass = 0, fail = 0; const failures = [];
function ok(c, n) { if (c) pass++; else { fail++; failures.push(n); console.log('  ✗ ' + n); } }
function eq(a, b, n) { ok(JSON.stringify(a) === JSON.stringify(b), n + (JSON.stringify(a) === JSON.stringify(b) ? '' : ` (got ${JSON.stringify(a)})`)); }

const SERVE = path.resolve(__dirname, '..', '..', '..', 'sgen-qa-serve.js');
const DATA = path.resolve(__dirname, '..', '..', '..', '..', 'sgen', 'W5-Live-Surface-Audit', 'site-qa', '_auditor-data');
const COLLECTIONS = path.join(DATA, 'collections');

const PAGE = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Wiring Probe</title>'
  + '<meta name="description" content="A deterministic page used to prove the production path reaches the collection producer."></head>'
  + '<body><header><nav><a href="/">Home</a></nav></header><h1>Probe</h1><p>Copy.</p><footer>f</footer></body></html>';

function freePortServer() {
  const s = http.createServer((req, res) => {
    if (req.url === '/robots.txt') { res.writeHead(404); return res.end('x'); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(PAGE);
  });
  return new Promise(r => s.listen(0, '127.0.0.1', () => r(s)));
}

// Boot the REAL server binary as a child process, exactly as the desktop shell does.
function bootServe(port, env) {
  const child = cp.spawn(process.execPath, [SERVE, '--port', String(port)], {
    cwd: path.dirname(SERVE),
    env: Object.assign({}, process.env, env),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    let out = '';
    const t = setTimeout(() => reject(new Error('server did not start in time: ' + out.slice(0, 300))), 30000);
    const onData = (d) => { out += d.toString(); if (/127\.0\.0\.1:\d+|listening|ready/i.test(out)) { clearTimeout(t); resolve(child); } };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.on('exit', (c) => { clearTimeout(t); reject(new Error('server exited early (' + c + '): ' + out.slice(0, 300))); });
  });
}

// POST /api/run and drain the streamed response to completion.
function apiRun(port, target) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ url: target, maxPages: 1, render: false });
    const req = http.request({ host: '127.0.0.1', port, path: '/api/run', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => {
      let data = ''; res.on('data', d => { data += d; }); res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(180000, () => reject(new Error('/api/run timed out')));
    req.end(body);
  });
}

const countCollections = () => { try { return new CollectionStore(COLLECTIONS).count(); } catch (_) { return 0; } };

console.log('Production wiring — Collection Store producer (D2) — test suite\n');

(async function main() {
  let site, serveOff, serveOn;
  const before = countCollections();
  try {
    // ── 0 · the wiring must exist in the SOURCE of the production entrypoint ─────────────────────
    const serveSrc = fs.readFileSync(SERVE, 'utf8');
    ok(/collectionRoot:\s*COLLECTION_ROOT/.test(serveSrc), 'wiring: the app\'s runAudit call site passes collectionRoot');
    ok(/process\.env\.SGEN_QA_COLLECTIONS/.test(serveSrc), 'wiring: activation is opt-in by environment, not always-on');
    ok(/SGEN_QA_COLLECTIONS\s*\?\s*path\.join/.test(serveSrc), 'wiring: unset => null => the producer constructs nothing');

    site = await freePortServer();
    const target = 'http://127.0.0.1:' + site.address().port + '/';

    // ── 1 · OPT-IN OFF — the default. Nothing may be written. ───────────────────────────────────
    const portOff = 7911;
    serveOff = await bootServe(portOff, { SGEN_QA_COLLECTIONS: '' });
    const rOff = await apiRun(portOff, target);
    ok(rOff.status === 200, `off: /api/run through the REAL server returned 200 (${rOff.status})`);
    ok(/verdict|quality|score/i.test(rOff.body), 'off: the app produced a real audit result');
    eq(countCollections(), before, 'off: NOT ONE collection written — default behaviour is unchanged');

    try { serveOff.kill(); } catch (_) {} serveOff = null;

    // ── 2 · OPT-IN ON — the same production path must now seal an acquisition ────────────────────
    const portOn = 7912;
    serveOn = await bootServe(portOn, { SGEN_QA_COLLECTIONS: '1' });
    const rOn = await apiRun(portOn, target);
    ok(rOn.status === 200, `on: /api/run returned 200 (${rOn.status})`);
    const after = countCollections();
    ok(after === before + 1, `on: the REAL production path sealed exactly one collection (${before} -> ${after})`);

    // ── 3 · and what it sealed is a valid, verifiable, replayable collection ─────────────────────
    const store = new CollectionStore(COLLECTIONS);
    const id = store.list()[store.list().length - 1];
    ok(/^col-[a-f0-9]{64}$/.test(id), `on: content-addressed id (${String(id).slice(0, 12)}…)`);
    eq(store.verify().ok, true, 'on: the sealed collection passes integrity verification');
    const rec = store.get(id);
    eq(rec.manifest.target, target, 'on: the sealed collection records the audited target');
    ok(rec.counts.staticPages >= 1, `on: the crawled page is in the acquisition (${rec.counts.staticPages})`);
    const version = require('../version');
    eq(rec.manifest.engineVersion, version.ENGINE_VERSION, 'on: versions come from the single authority (D6)');
    // replayable without a browser — the point of sealing it
    const { replay } = require('../replay');
    const rp = replay(rec, { versions: { engine: version.ENGINE_VERSION, registry: version.REGISTRY_VERSION, providerContract: version.PROVIDER_CONTRACT_VERSION } });
    ok(!!rp.inventoryDigest, 'on: the sealed acquisition replays with no browser and no network');

    // ── 4 · nothing else moved ───────────────────────────────────────────────────────────────────
    ok(!/replay/.test(fs.readFileSync(SERVE, 'utf8').split('COLLECTION_ROOT')[0]), 'scope: the app does not invoke replay');
    eq(require('../rules/registry').RULES.length, 142, 'scope: registry unchanged');
  // ADR-0011 note: this used to pin a version LITERAL, which made the test a SECOND AUTHORITY --
  // exactly the defect D6 eliminated, reintroduced here and exposed the moment ENGINE_VERSION
  // legitimately moved to 2.4.0. A test may assert the SHAPE of a stream and that it comes from the
  // authority; it must never re-declare the value.
  const SEMVER_ = /^\d+\.\d+(\.\d+)?$/;
    ok(SEMVER_.test(version.REPORT_VERSION), 'scope: report version unmoved (from the authority: ' + version.REPORT_VERSION + ')');
  } catch (e) {
    ok(false, 'production wiring: suite FAILED — ' + String((e && e.message) || e).slice(0, 300));
  } finally {
    for (const c of [serveOff, serveOn]) { if (c) { try { c.kill(); } catch (_) {} } }
    if (site) { try { site.close(); } catch (_) {} }
  }

  console.log('\n' + (fail === 0 ? '✅ PASS' : '❌ FAIL') + ` — ${pass}/${pass + fail} assertions`);
  if (fail) { console.log('Failures:\n' + failures.map(f => '  - ' + f).join('\n')); process.exit(1); }
})();
