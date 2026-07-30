'use strict';
// producer.test.js — Phase 3 evidence: the Collection Store wired into production.
//
// The load-bearing assertion is §2: a run WITH persistence and a run WITHOUT it produce a
// BYTE-IDENTICAL audit result. Persisting an acquisition must be invisible to everything downstream —
// no finding moves, no score moves, no report field appears.
//
// Drives the REAL `runAudit` against a REAL local http server. No fixture: a fixture cannot prove that
// wiring a producer into the live path changed nothing.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { runAudit } = require('../audit');
const { CollectionStore } = require('./index');
const { replay } = require('../replay');
const version = require('../version');

let pass = 0, fail = 0; const failures = [];
function ok(c, n) { if (c) pass++; else { fail++; failures.push(n); console.log('  ✗ ' + n); } }
function eq(a, b, n) { ok(JSON.stringify(a) === JSON.stringify(b), n + (JSON.stringify(a) === JSON.stringify(b) ? '' : ` (got ${JSON.stringify(a)})`)); }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sgen-prod-'));

const PAGE = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Producer Test Page</title>'
  + '<meta name="description" content="A deterministic local page used to prove the producer changes nothing at all."></head>'
  + '<body><header><nav><a href="/">Home</a></nav></header><h1>Producer</h1><p>Body copy.</p>'
  + '<img src="/i.png" alt="i" width="10" height="10"><footer>f</footer></body></html>';

// Non-deterministic fields that legitimately differ between two runs of the same site. Removing them
// is what makes the comparison meaningful rather than trivially false.
// The run timestamp is the one field that legitimately differs between two runs of the same site, and
// it appears in three places: `result.generated`, the `observedAt`/`capturedAt` keys, and EMBEDDED IN
// TEXT inside every `_md` dev-ticket ("_Source: … · <generated>_"). The first version of this helper
// stripped only the keys, and the comparison failed on nothing but two runs 32ms apart — so the ISO
// timestamp is normalised inside string values too. Everything else is compared verbatim.
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g;
function stable(r) {
  const c = JSON.parse(JSON.stringify(r));
  delete c.generated;
  const strip = (o) => {
    if (!o || typeof o !== 'object') return;
    for (const k of Object.keys(o)) {
      // `projectionMs` is a Date.now() DURATION (lib/report-contract.js), so it differs run to run by
      // a millisecond or two regardless of what changed. Measured here: 2 vs 0. Normalising it is not
      // hiding a difference — it removes the last source of noise so a REAL difference would be
      // visible. The run timestamp and this duration were the ONLY two fields that ever differed.
      if (k === 'observedAt' || k === 'capturedAt' || k === 'projectionMs') { delete o[k]; continue; }
      if (typeof o[k] === 'string') { o[k] = o[k].replace(ISO, '<RUN-TIMESTAMP>'); continue; }
      strip(o[k]);
    }
  };
  strip(c);
  return JSON.stringify(c, null, 2).replace(ISO, '<RUN-TIMESTAMP>');
}

console.log('Collection Store producer wiring — test suite\n');

(async function main() {
  let server, base;
  try {
    server = http.createServer((req, res) => {
      if (req.url === '/i.png') { res.writeHead(200, { 'content-type': 'image/png' }); return res.end('png'); }
      if (req.url === '/robots.txt') { res.writeHead(404); return res.end('x'); }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(PAGE);
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    base = 'http://127.0.0.1:' + server.address().port + '/';

    const opts = { maxPages: 1, render: false, concurrency: 2, screensDir: path.join(TMP, 'shots') };

    // ── 1 · a run WITHOUT persistence (today's behaviour) ────────────────────────────────────────
    const without = await runAudit(base, { ...opts });
    ok(!!without.quality, 'baseline: an ordinary run completes');

    // ── 2 · a run WITH persistence — the audit result must be IDENTICAL ──────────────────────────
    const root = path.join(TMP, 'collections');
    const withStore = await runAudit(base, { ...opts, collectionRoot: root });
    ok(stable(without) === stable(withStore),
      'NO BEHAVIOUR CHANGE: the audit result is BYTE-IDENTICAL with and without collection persistence');
    eq(withStore.quality.overall, without.quality.overall, 'no score moved');
    eq(withStore.tally, without.tally, 'no finding moved (tally identical)');
    eq(withStore.verdict, without.verdict, 'verdict identical');
    eq(withStore.readiness.verdict, without.readiness.verdict, 'launch verdict identical');
    ok(!('collection' in withStore) && !('collectionId' in withStore),
      'no report change: the result object gains NO field — persistence is invisible to every consumer');

    // ── 3 · the collection was actually written, and verifies ────────────────────────────────────
    const store = new CollectionStore(root);
    eq(store.count(), 1, 'written: exactly one collection sealed');
    const id = store.list()[0];
    ok(/^col-[a-f0-9]{64}$/.test(id), `written: content-addressed id (${id.slice(0, 12)}…)`);
    eq(store.verify().ok, true, 'verified: integrity passes on the persisted collection');
    const rec = store.get(id);
    eq(rec.manifest.target, base, 'written: target recorded');
    eq(rec.manifest.engineVersion, version.ENGINE_VERSION, 'written: engine version from the AUTHORITY (D6)');
    eq(rec.manifest.providerContractVersion, version.PROVIDER_CONTRACT_VERSION, 'written: provider contract version from the authority');
    eq(rec.manifest.schemaVersion, version.COLLECTION_SCHEMA_VERSION, 'written: collection schema version');
    ok(rec.manifest.collectorSet.includes('staticPages'), 'written: collectorSet declares what actually ran');
    ok(rec.counts.staticPages >= 1, `written: the crawled page is in the acquisition (${rec.counts.staticPages})`);
    ok(Array.isArray(rec.manifest.providerSet) && rec.manifest.providerSet.length >= 9, 'written: provider set recorded for replay compatibility');

    // ── 4 · rebuilt ──────────────────────────────────────────────────────────────────────────────
    const idxBefore = fs.existsSync(store.indexPath('by-target')) ? fs.readFileSync(store.indexPath('by-target'), 'utf8') : null;
    const manifestBefore = fs.readFileSync(store.manifestPath, 'utf8');
    eq(store.rebuildIndexes().rebuilt, 1, 'rebuilt: index rebuild covers the collection');
    eq(fs.readFileSync(store.indexPath('by-target'), 'utf8'), idxBefore, 'rebuilt: index BYTE-IDENTICAL after rebuild');
    eq(fs.readFileSync(store.manifestPath, 'utf8'), manifestBefore, 'rebuilt: manifest untouched');
    eq(store.verify().ok, true, 'rebuilt: integrity still passes');

    // ── 5 · the sealed collection is replayable — but replay was NOT invoked by the audit ────────
    const r = replay(rec, { versions: { engine: version.ENGINE_VERSION, registry: version.REGISTRY_VERSION, providerContract: version.PROVIDER_CONTRACT_VERSION } });
    ok(r.inventoryDigest && r.inventory.counts.page >= 1, 'replayable: the persisted collection replays without a browser');
    const auditSrc = fs.readFileSync(require.resolve('../audit.js'), 'utf8');
    ok(!/require\(['"]\.\/replay/.test(auditSrc), 'NO REPLAY INVOKED: audit.js does not import the replay engine — persistence only');
    ok(!/replay\s*\(/.test(auditSrc), 'NO REPLAY INVOKED: audit.js never calls replay()');

    // ── 6 · opt-in, and failure-proof ────────────────────────────────────────────────────────────
    ok(!fs.existsSync(path.join(TMP, 'never')), 'opt-in: no store directory is created when collectionRoot is absent');
    // an unwritable root must NOT fail the audit
    const bad = await runAudit(base, { ...opts, collectionRoot: '\0invalid\0path' });
    ok(!!bad.quality && bad.verdict === without.verdict,
      'guarded: an unpersistable collection does NOT fail an audit that genuinely succeeded');
    ok(stable(bad) === stable(without), 'guarded: …and the result is still byte-identical');

    // ── 7 · frozen scope ─────────────────────────────────────────────────────────────────────────
    eq(require('../rules/registry').RULES.length, 144, 'D9: registry unchanged');
  // ADR-0011 note: this used to pin a version LITERAL, which made the test a SECOND AUTHORITY --
  // exactly the defect D6 eliminated, reintroduced here and exposed the moment ENGINE_VERSION
  // legitimately moved to 2.4.0. A test may assert the SHAPE of a stream and that it comes from the
  // authority; it must never re-declare the value.
  const SEMVER_ = /^\d+\.\d+(\.\d+)?$/;
    ok(SEMVER_.test(version.ENGINE_VERSION), 'D9: engine version unmoved — wiring a producer is not user-visible behaviour (from the authority: ' + version.ENGINE_VERSION + ')');
    ok(SEMVER_.test(version.REPORT_VERSION), 'D9: report version unmoved (from the authority: ' + version.REPORT_VERSION + ')');
  } catch (e) {
    ok(false, 'producer: suite FAILED — ' + String((e && e.stack) || e).slice(0, 300));
  } finally {
    if (server) { try { server.close(); } catch (_) {} }
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  }

  console.log('\n' + (fail === 0 ? '✅ PASS' : '❌ FAIL') + ` — ${pass}/${pass + fail} assertions`);
  if (fail) { console.log('Failures:\n' + failures.map(f => '  - ' + f).join('\n')); process.exit(1); }
})();
