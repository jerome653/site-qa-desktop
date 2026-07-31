'use strict';
// network-ledger.test.js — ADR-0005 evidence. Collector → Collection → Provider, end to end.
//
// Two levels, deliberately:
//   • PURE tests against a fake Playwright-shaped page. Deterministic, no browser, and they are where
//     the record shape and the provider's determinism are actually pinned.
//   • ONE REAL end-to-end: a local http server + real Chromium + the real collector. That is what
//     ADR-0004 acceptance criterion 3 asks for ("a collector/provider pair flows end-to-end"), and a
//     fake page cannot supply it. If Chromium cannot launch, this suite FAILS — it does not skip.
//     A skipped end-to-end reported as green is the exact defect class this engine keeps un-shipping.
const http = require('http');
const { EventEmitter } = require('events');
const { buildInventory, PROVIDERS } = require('./index');
const { makeCollection, wasCollected } = require('./collection');
const { IdRegistry } = require('./id-registry');
const { attachNetworkCollector, createNetworkSink, makeNetworkRecord, RECORD_CAP } = require('../collectors/network');

let pass = 0, fail = 0; const failures = [];
function ok(c, n) { if (c) pass++; else { fail++; failures.push(n); console.log('  ✗ ' + n); } }
function eq(a, b, n) { ok(JSON.stringify(a) === JSON.stringify(b), n + (JSON.stringify(a) === JSON.stringify(b) ? '' : ` (got ${JSON.stringify(a)})`)); }

const netProvider = () => PROVIDERS.find(p => p.type === 'network');
const collectionWith = (network, collected = ['network']) => makeCollection({ network, collected });

// A Playwright-shaped fake. Only the methods the collector actually calls.
function fakePage() {
  const em = new EventEmitter();
  em.emitResponse = ({ url, method = 'GET', resourceType = 'document', status = 200, headers = {}, timing = null }) => {
    em.emit('response', {
      url: () => url, status: () => status, headers: () => headers,
      request: () => ({ method: () => method, resourceType: () => resourceType, timing: () => timing }),
    });
  };
  em.emitFailed = ({ url, method = 'GET', resourceType = 'image', errorText = 'net::ERR_FAILED' }) => {
    em.emit('requestfailed', { url: () => url, method: () => method, resourceType: () => resourceType, failure: () => ({ errorText }) });
  };
  return em;
}

console.log('Network Ledger (ADR-0005) — test suite\n');

// ── 1 · the collector retains what the engine used to discard ─────────────────────────────────────
(function collectorRetains() {
  const page = fakePage();
  const sink = createNetworkSink();
  attachNetworkCollector(page, sink, { context: 'metrics', now: () => '2026-07-28T00:00:00.000Z' });
  page.emitResponse({ url: 'https://x.example/', headers: { 'content-type': 'text/html; charset=utf-8', 'content-length': '1024' } });
  page.emitResponse({ url: 'https://cdn.other/app.js', resourceType: 'script', headers: { 'content-type': 'application/javascript', 'content-length': '2048' } });
  page.emitFailed({ url: 'https://x.example/missing.png' });
  const recs = sink.drain();
  ok(recs.length === 3, `collector: retained 3 records (got ${recs.length})`);
  eq(recs[0].url, 'https://x.example/', 'collector: url retained');
  eq(recs[0].mimeType, 'text/html', 'collector: mimeType parsed off content-type (charset stripped)');
  eq(recs[0].sizeBytes, 1024, 'collector: sizeBytes from content-length');
  eq(recs[1].resourceType, 'script', 'collector: resourceType retained');
  eq(recs[2].failure, 'net::ERR_FAILED', 'collector: requestfailed reason retained');
  eq(recs[2].status, null, 'collector: a failed request has status null, NOT 0');
  eq(recs[0].context, 'metrics', 'collector: observing context stamped');
  ok(!sink.capped, 'collector: not capped at 3 records');
})();

// ── 2 · unavailable stays unavailable (never '' or 0) ─────────────────────────────────────────────
(function unavailable() {
  const r = makeNetworkRecord({ url: 'https://x.example/a', method: 'GET', resourceType: 'fetch', status: 204, headers: {}, capturedAt: 'T' });
  eq(r.protocol, null, 'unavailable: protocol is null (Playwright does not expose it)');
  eq(r.fromCache, null, 'unavailable: fromCache is null, not false');
  eq(r.initiator, null, 'unavailable: initiator is null');
  eq(r.sizeBytes, null, 'unavailable: absent content-length is null, NOT 0');
  eq(r.mimeType, null, 'unavailable: absent content-type is null, NOT ""');
  eq(r.timing, null, 'unavailable: absent timing is null');
  ok(Object.values(r).every(v => v !== ''), 'unavailable: no field uses an empty string to mean unknown');
  const cap = createNetworkSink();
  for (let i = 0; i < RECORD_CAP + 5; i++) cap.push(makeNetworkRecord({ url: 'https://x/' + i, headers: {} }));
  ok(cap.capped && cap.records.length === RECORD_CAP, `cap: truncation is bounded AND declared (${cap.records.length}/${cap.seen})`);
})();

// ── 3 · the provider consumes collection.network ──────────────────────────────────────────────────
(function providerConsumes() {
  const recs = [
    makeNetworkRecord({ url: 'https://x.example/', method: 'GET', resourceType: 'document', status: 200, headers: { 'content-length': '10' }, capturedAt: 'A' }),
    makeNetworkRecord({ url: 'https://cdn.other/app.js', method: 'GET', resourceType: 'script', status: 200, headers: {}, capturedAt: 'B' }),
    makeNetworkRecord({ url: 'https://x.example/', method: 'GET', resourceType: 'document', status: 200, headers: { 'content-length': '10' }, capturedAt: 'C' }),
  ];
  const items = netProvider().enumerate(collectionWith(recs), {});
  ok(items.length === 2, `provider: 3 records collapse to 2 logical requests (got ${items.length})`);
  const home = items.find(i => i.identityKey === 'network:GET https://x.example/');
  ok(!!home, 'provider: identity is method + url');
  eq(home.meta.occurrences, 2, 'provider: repeat requests counted, not duplicated');
  eq(home.meta.recordIndexes, [0, 2], 'provider: item points BACK at its collection records by index');
  eq(home.meta.origin, 'https://x.example', 'provider: origin derived');
  eq(items.find(i => i.meta.resourceType === 'script').meta.origin, 'https://cdn.other', 'provider: third-party origin distinguishable');

  // through the real inventory layer
  const inv = buildInventory(collectionWith(recs), { idRegistry: new IdRegistry(), host: 'x.example' });
  eq(inv.counts.network, 2, 'inventory: network items land in the inventory via buildInventory');
  ok(inv.items.network.every(i => i.provider === 'network' && i.state === 'DISCOVERED'), 'inventory: network items are ordinary inventory items (provider + lifecycle)');
})();

// ── 4 · deterministic: the same collection always yields the same items ───────────────────────────
(function deterministic() {
  const mk = (stamp) => [
    makeNetworkRecord({ url: 'https://x.example/b', method: 'GET', resourceType: 'script', status: 200, headers: {}, capturedAt: stamp, timing: { responseEnd: Math.random() } }),
    makeNetworkRecord({ url: 'https://x.example/a', method: 'GET', resourceType: 'image', status: 200, headers: {}, capturedAt: stamp, timing: { responseEnd: Math.random() } }),
  ];
  const a = netProvider().enumerate(collectionWith(mk('2026-01-01T00:00:00.000Z')), {});
  const b = netProvider().enumerate(collectionWith(mk('2099-12-31T23:59:59.999Z')), {});
  ok(JSON.stringify(a) === JSON.stringify(b), 'determinism: capturedAt and timing DIFFER between runs yet items are byte-identical');
  ok(JSON.stringify(a).indexOf('2026-01-01') === -1, 'determinism: no wall-clock leaked into an inventory item');
  ok(JSON.stringify(a).indexOf('responseEnd') === -1, 'determinism: no timing leaked into an inventory item');
  const i1 = buildInventory(collectionWith(mk('A')), { idRegistry: new IdRegistry() });
  const i2 = buildInventory(collectionWith(mk('B')), { idRegistry: new IdRegistry() });
  eq(i1.items.network.map(i => i.id), i2.items.network.map(i => i.id), 'determinism: minted ids stable across runs');
})();

// ── 5 · fails closed ──────────────────────────────────────────────────────────────────────────────
(function failsClosed() {
  // "never looked" vs "looked, saw nothing" — the distinction the whole schema-1.1 change exists for.
  const undeclared = makeCollection({ staticPages: [], collected: ['staticPages'] });
  const declaredEmpty = collectionWith([]);
  eq(netProvider().enumerate(undeclared, {}), [], 'fail-closed: an UNCOLLECTED channel yields no items and makes no claim');
  eq(netProvider().enumerate(declaredEmpty, {}), [], 'fail-closed: a COLLECTED-but-empty channel yields no items');
  ok(wasCollected(declaredEmpty, 'network') && !wasCollected(undeclared, 'network'),
    'fail-closed: "collected, empty" is DISTINGUISHABLE from "never collected" — an empty array alone can never say which');

  let threwMalformed = false;
  try { netProvider().enumerate(collectionWith([{ method: 'GET' }]), {}); } catch (_) { threwMalformed = true; }
  ok(threwMalformed, 'fail-closed: a malformed record (no url) THROWS rather than being silently dropped');
  let threwArr = false;
  try { netProvider().enumerate([], {}); } catch (_) { threwArr = true; }
  ok(threwArr, 'fail-closed: a bare array is not a Collection');
  let threwChannel = false;
  try { makeCollection({ collected: ['nonsense'] }); } catch (_) { threwChannel = true; }
  ok(threwChannel, 'fail-closed: declaring an unknown channel as collected throws');
})();

// ── 6 · the frozen core did not move (ADR-0004 §D9) ───────────────────────────────────────────────
(function frozen() {
  const reg = require('../rules/registry');
  const version = require('../version');
  eq(reg.RULES.length, 161, 'D9: registry rule count unchanged — ADR-0005 adds NO rule');
  eq(reg.SUITES.reduce((a, s) => a + (reg.WEIGHTS[s] || 0), 0), 100, 'D9: suite weights still total 100');
  eq(reg.REGISTRY_VERSION, '1.15.0', 'D9: registry version unmoved');
  // ADR-0011 note: this used to pin a version LITERAL, which made the test a SECOND AUTHORITY --
  // exactly the defect D6 eliminated, reintroduced here and exposed the moment ENGINE_VERSION
  // legitimately moved to 2.4.0. A test may assert the SHAPE of a stream and that it comes from the
  // authority; it must never re-declare the value.
  const SEMVER_ = /^\d+\.\d+(\.\d+)?$/;
  ok(SEMVER_.test(version.ENGINE_VERSION), 'D9: engine version unmoved (no user-visible behaviour change) (from the authority: ' + version.ENGINE_VERSION + ')');
  ok(SEMVER_.test(version.REPORT_VERSION), 'D9: report version unmoved (from the authority: ' + version.REPORT_VERSION + ')');
  ok(SEMVER_.test(version.COLLECTION_SCHEMA_VERSION), 'D6: collection schema bumped additively, in the single version authority (from the authority: ' + version.COLLECTION_SCHEMA_VERSION + ')');
  // the ledger must not be able to reach the scorer
  const src = require('fs').readFileSync(require.resolve('../collectors/network.js'), 'utf8');
  ok(!/require\(.*(score|registry|finding|report)/.test(src), 'boundary: the collector imports no rule, score, finding or report module');
  ok(!/severity|deduction|verdict/i.test(src.replace(/^\s*\/\/.*$/gm, '')), 'boundary: the collector contains no severity, deduction or verdict logic');
})();

// ── 7 · REAL end-to-end: local server + real Chromium + the real collector ────────────────────────
(async function endToEnd() {
  let server, browser;
  try {
    server = http.createServer((req, res) => {
      if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end('<!doctype html><html><head><link rel="stylesheet" href="/s.css"></head><body><img src="/gone.png"><script src="/a.js"></script></body></html>'); }
      if (req.url === '/s.css') { res.writeHead(200, { 'content-type': 'text/css', 'content-length': '11' }); return res.end('body{a:1;}\n'); }
      if (req.url === '/a.js') { res.writeHead(200, { 'content-type': 'application/javascript' }); return res.end('var a=1;'); }
      res.writeHead(404, { 'content-type': 'text/plain' }); res.end('nope');
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = 'http://127.0.0.1:' + server.address().port + '/';

    const { chromium } = require('playwright');
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const sink = createNetworkSink();
    attachNetworkCollector(page, sink, { context: 'e2e' });
    await page.goto(base, { waitUntil: 'networkidle', timeout: 30000 });

    const collection = makeCollection({ network: sink.drain(), collected: ['network'] });
    const inv = buildInventory(collection, { idRegistry: new IdRegistry(), host: '127.0.0.1' });
    const urls = inv.items.network.map(i => i.meta.path).sort();

    ok(sink.records.length >= 4, `e2e: real Chromium produced ${sink.records.length} network records (>=4)`);
    ok(urls.includes('/') && urls.includes('/s.css') && urls.includes('/a.js'), `e2e: document, stylesheet and script all in the ledger (${urls.join(' ')})`);
    const css = inv.items.network.find(i => i.meta.path === '/s.css');
    eq(css.meta.mimeType, 'text/css', 'e2e: real mimeType observed');
    eq(css.meta.sizeBytes, 11, 'e2e: real content-length observed');
    eq(css.meta.status, 200, 'e2e: real status observed');
    const gone = inv.items.network.find(i => i.meta.path === '/gone.png');
    ok(gone && gone.meta.status === 404, 'e2e: the 404 asset is IN the ledger with its real status (this is the data the old code discarded)');
    ok(inv.items.network.every(i => i.meta.protocol === null), 'e2e: protocol honestly null — not invented from a guess');
    ok(inv.counts.network >= 4, 'e2e: Collector → Collection → Provider → Inventory, end to end');
  } catch (e) {
    // NOT a skip. An end-to-end that cannot run has not passed.
    ok(false, 'e2e: real Chromium end-to-end FAILED — ' + String((e && e.message) || e).slice(0, 160));
  } finally {
    if (browser) { try { await browser.close(); } catch (_) {} }
    if (server) { try { server.close(); } catch (_) {} }
  }

  console.log('\n' + (fail === 0 ? '✅ PASS' : '❌ FAIL') + ` — ${pass}/${pass + fail} assertions`);
  if (fail) { console.log('Failures:\n' + failures.map(f => '  - ' + f).join('\n')); process.exit(1); }
})();
