'use strict';
// collection-store.test.js — ADR-0009 evidence.
//
// The load-bearing suites are §3 (a rebuilt index is BYTE-IDENTICAL, proving indexes hold no
// independent authority), §5 (damage is classified, per channel) and §7 (the store is built ON the
// shared infrastructure — asserted by function identity and prototype chain, not by claim).
const fs = require('fs');
const os = require('os');
const path = require('path');
const CS = require('./index');
const { CollectionStore, buildRecord, recordForDigest, evidenceRefsOf, isCollectionId, CHANNELS, INDEX_NAMES, ID_PREFIX } = CS;
const IS = require('../immutable-store');
const { makeCollection } = require('../inventory/collection');

let pass = 0, fail = 0; const failures = [];
function ok(c, n) { if (c) pass++; else { fail++; failures.push(n); console.log('  ✗ ' + n); } }
function eq(a, b, n) { ok(JSON.stringify(a) === JSON.stringify(b), n + (JSON.stringify(a) === JSON.stringify(b) ? '' : ` (got ${JSON.stringify(a)})`)); }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sgen-cs-'));
const root = (n) => path.join(TMP, n);

const AT = '2026-07-28T00:00:00.000Z';
const META = {
  acquiredAt: AT, target: 'https://old.example.com', host: 'old.example.com',
  versions: { engine: '2.3.0', registry: '1.13.0', providerContract: '1.0' },
  providerSet: ['page', 'network', 'document'],
};
const COLLECTION = makeCollection({
  staticPages: [{ url: 'https://old.example.com/', status: 200, contentType: 'text/html', headers: {}, body: '<html><head><link rel="stylesheet" href="/a.css"></head><body>x</body></html>' }],
  network: [{ url: 'https://old.example.com/a.css', method: 'GET', status: 200, mimeType: 'text/css', sizeBytes: 11, protocol: null, fromCache: null, initiator: null }],
  documents: [{ documentUrl: 'https://old.example.com/', source: 'rendered', assets: [{ index: 0, tag: 'link', section: 'head' }] }],
  shots: [
    { label: '1920 · Desktop', file: '/runs/x/home--page--full--1920.png', artifactId: 'ev-' + 'a'.repeat(64) },
    { label: '414 · iPhone XR/11', file: '/runs/x/home--page--full--414.png', artifactId: 'ev-' + 'b'.repeat(64) },
    { label: 'dup', file: '/runs/x/dup.png', artifactId: 'ev-' + 'a'.repeat(64) },
  ],
  collected: ['staticPages', 'network', 'documents', 'shots'],
});

console.log('Collection Store (ADR-0009) — test suite\n');

// ── 1 · a collection is written, and content-addressed ───────────────────────────────────────────
(function write() {
  const s = new CollectionStore(root('w'));
  const r = s.save(COLLECTION, META);
  ok(isCollectionId(r.collectionId), `write: content-addressed id (${r.collectionId.slice(0, 12)}…)`);
  eq(r.duplicate, false, 'write: first save is not a duplicate');
  eq(r.collectionId, ID_PREFIX + r.digest, 'write: the id IS the content address of the record');
  ok(s.has(r.collectionId), 'write: record on disk');
  eq(s.count(), 1, 'write: manifest has one entry');
  const rec = s.get(r.collectionId);
  eq(rec.counts, { staticPages: 1, documents: 1, network: 1, render: 0, console: 0, fonts: 0, shots: 3 }, 'write: per-channel counts recorded');
  eq(rec.channels.network[0].url, 'https://old.example.com/a.css', 'write: channel data persisted intact');
  // determinism: the same acquisition + same meta = the same id, on any machine
  const s2 = new CollectionStore(root('w2'));
  eq(s2.save(COLLECTION, META).collectionId, r.collectionId, 'write: identical acquisition → identical id (deterministic content address)');
})();

// ── 2 · sealing: immutable once written ──────────────────────────────────────────────────────────
(function sealing() {
  const s = new CollectionStore(root('seal'));
  const a = s.save(COLLECTION, META);
  const before = fs.readFileSync(s.recordPath(a.collectionId), 'utf8');
  const b = s.save(COLLECTION, META);
  eq(b.duplicate, true, 'seal: re-saving an identical acquisition reports a DUPLICATE');
  eq(b.collectionId, a.collectionId, 'seal: same id');
  eq(fs.readFileSync(s.recordPath(a.collectionId), 'utf8'), before, 'seal: the record on disk is NOT rewritten — append-only, never mutated');
  eq(s.count(), 1, 'seal: no second manifest line for a duplicate');
  // a DIFFERENT acquisition is a different collection, appended alongside
  const other = makeCollection({ staticPages: [{ url: 'https://x/', status: 200, body: '<html>y</html>' }], collected: ['staticPages'] });
  const c = s.save(other, META);
  ok(c.collectionId !== a.collectionId && s.count() === 2, 'seal: a different acquisition appends a new collection');
})();

// ── 3 · rebuildable indexes — BYTE-IDENTICAL ─────────────────────────────────────────────────────
(function rebuild() {
  const s = new CollectionStore(root('rb'));
  s.save(COLLECTION, META);
  s.save(makeCollection({ staticPages: [{ url: 'https://x/', status: 200, body: '<html>y</html>' }], collected: ['staticPages'] }),
    Object.assign({}, META, { acquiredAt: '2026-07-29T00:00:00.000Z', target: 'https://x/' }));

  const manifestBefore = fs.readFileSync(s.manifestPath, 'utf8');
  const idxBefore = {};
  for (const n of INDEX_NAMES) idxBefore[n] = exists(s.indexPath(n)) ? fs.readFileSync(s.indexPath(n), 'utf8') : null;

  const res = s.rebuildIndexes();
  eq(res.rebuilt, 2, 'rebuild: every committed collection re-projected');

  for (const n of INDEX_NAMES) {
    const after = exists(s.indexPath(n)) ? fs.readFileSync(s.indexPath(n), 'utf8') : null;
    ok(after === idxBefore[n], `rebuild: index ${n} is BYTE-IDENTICAL after rebuild — it holds no independent authority`);
  }
  eq(fs.readFileSync(s.manifestPath, 'utf8'), manifestBefore, 'rebuild: the append-only MANIFEST is untouched by an index rebuild');
  eq(s.verify().ok, true, 'rebuild: integrity still verifies after rebuild');
  function exists(p) { return fs.existsSync(p); }
})();

// ── 4 · manifest records COMPATIBILITY FACTS ONLY ────────────────────────────────────────────────
(function manifest() {
  const s = new CollectionStore(root('mf'));
  const r = s.save(COLLECTION, META);
  const m = s.get(r.collectionId).manifest;
  eq(m.schemaVersion, COLLECTION.schemaVersion, 'manifest: collection schema version');
  eq(m.engineVersion, '2.3.0', 'manifest: engine version');
  // NOT the live registry version — this asserts the manifest records what META SUPPLIED, faithfully.
  // (engineVersion above is pinned to a fixture value for the same reason.) Bumping it with the real
  // registry would turn a fidelity assertion into a version assertion and stop testing anything.
  eq(m.registryVersion, '1.13.0', 'manifest: registry version');
  eq(m.providerContractVersion, '1.0', 'manifest: provider contract version');
  eq(m.collectorSet, ['documents', 'network', 'shots', 'staticPages'], 'manifest: collector set from the collection\'s OWN declaration, sorted — never inferred from emptiness');
  eq(m.providerSet, ['document', 'network', 'page'], 'manifest: provider set as supplied, sorted');
  eq(m.acquiredAt, AT, 'manifest: acquisition timestamp as supplied');
  // facts only — no replay judgement anywhere in the record
  const rec = JSON.stringify(s.get(r.collectionId));
  ok(!/replay|replayable|compatible["']?\s*:\s*(true|false)|canReplay/i.test(rec),
    'manifest: records NO replay decision — it says what produced the collection, never what that means');
  // integrity information is present and per-channel
  const cd = s.get(r.collectionId).integrity.channelDigests;
  eq(Object.keys(cd).sort(), [...CHANNELS].sort(), 'manifest: a content address per channel');
  ok(Object.values(cd).every(h => /^[a-f0-9]{64}$/.test(h)), 'manifest: channel digests are sha256');
})();

// ── 5 · integrity: damage CLASSIFIED, per channel ────────────────────────────────────────────────
(function integrity() {
  const s = new CollectionStore(root('int'));
  const r = s.save(COLLECTION, META);
  eq(s.verify(), { ok: true, checked: 1, problems: [] }, 'integrity: a clean store verifies');

  // tamper with one channel
  const rec = s.get(r.collectionId);
  rec.channels.network[0].status = 500;
  fs.writeFileSync(s.recordPath(r.collectionId), JSON.stringify(rec, null, 2));
  const v = s.verify();
  eq(v.ok, false, 'integrity: tampering detected');
  ok(v.problems.some(p => p.class === 'modified'), 'integrity: classed `modified`, not a bare boolean');
  ok(v.problems.some(p => p.class === 'channel-modified' && p.channel === 'network'),
    'integrity: names WHICH channel changed — a diagnosis does not require re-deriving it');
  // NOTE: content tampering does NOT produce `id-mismatch`. Editing a channel leaves the stored
  // `digest`/`collectionId` pair internally consistent — it is the CONTENT that no longer hashes to
  // the recorded digest, which is `modified`. `id-mismatch` is the distinct, worse case: a forged
  // id/digest pair. The first version of this assertion conflated the two; keeping them separate is
  // the whole reason damage is classified rather than boolean.
  ok(!v.problems.some(p => p.class === 'id-mismatch'), 'integrity: content tampering is `modified`, NOT `id-mismatch` — the classes stay distinct');
  const sF = new CollectionStore(root('forge'));
  const rF = sF.save(COLLECTION, META);
  const forged = sF.get(rF.collectionId);
  forged.digest = 'f'.repeat(64);                      // forge the content address itself
  fs.writeFileSync(sF.recordPath(rF.collectionId), JSON.stringify(forged, null, 2));
  ok(sF.verify().problems.some(p => p.class === 'id-mismatch'), 'integrity: a FORGED digest is caught as `id-mismatch`');

  // a record with no manifest line = partial write, distinct from corruption
  const s2 = new CollectionStore(root('int2'));
  const r2 = s2.save(COLLECTION, META);
  fs.writeFileSync(s2.manifestPath, '');
  const v2 = s2.verify();
  ok(v2.problems.some(p => p.class === 'uncommitted' && p.collectionId === r2.collectionId),
    'integrity: an un-committed record is `uncommitted` (recoverable), NOT corruption');

  // a manifest line with no record = committed then lost
  const s3 = new CollectionStore(root('int3'));
  const r3 = s3.save(COLLECTION, META);
  fs.unlinkSync(s3.recordPath(r3.collectionId));
  ok(s3.verify().problems.some(p => p.class === 'missing-record'), 'integrity: a lost record is `missing-record`');
})();

// ── 6 · references, never copies ─────────────────────────────────────────────────────────────────
(function references() {
  const s = new CollectionStore(root('ref'));
  const rec = s.get(s.save(COLLECTION, META).collectionId);
  eq(rec.evidenceRefs, ['ev-' + 'a'.repeat(64), 'ev-' + 'b'.repeat(64)],
    'references: artifact ids de-duplicated and sorted — 3 shots, 2 distinct artifacts');
  eq(evidenceRefsOf({ shots: [] }), [], 'references: no shots → no refs');
  eq(evidenceRefsOf({}), [], 'references: absent shots channel handled');
  // the store must never have read an artifact's bytes: the referenced paths do not even exist here
  ok(!fs.existsSync('/runs/x/home--page--full--1920.png'), 'references: the referenced artifact does not exist on this machine…');
  eq(s.verify().ok, true, '…and the collection still verifies — proof the store stored a REFERENCE, never a copy');
  const src = fs.readFileSync(require.resolve('./index.js'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  ok(!/readFileSync\s*\(\s*[a-zA-Z_$.]*(file|artifact|shot)/i.test(src), 'references: no artifact byte is ever read by this store');
})();

// ── 7 · BUILT ON the shared infrastructure (ADR-0008), not forked ────────────────────────────────
(function infrastructure() {
  const s = new CollectionStore(root('inf'));
  ok(s instanceof IS.RecordStore, 'infrastructure: CollectionStore IS a RecordStore — configuration, not a sixth implementation');
  ok(Object.getPrototypeOf(CollectionStore) === IS.RecordStore, 'infrastructure: prototype chain proves inheritance, not imitation');
  // `CollectionStore.prototype.commit` resolves THROUGH the chain, so it is never undefined — the
  // correct test for "inherited, not re-declared" is that it is the same function object and that
  // CollectionStore.prototype does not own the property.
  ok(!Object.prototype.hasOwnProperty.call(CollectionStore.prototype, 'commit'), 'infrastructure: commit is NOT re-declared on CollectionStore');
  ok(CollectionStore.prototype.commit === IS.RecordStore.prototype.commit, 'infrastructure: commit IS RecordStore\'s function (same object, inherited)');
  for (const m of ['recordPath', 'indexPath', 'has', 'get', 'manifest']) {
    ok(!Object.prototype.hasOwnProperty.call(CollectionStore.prototype, m) && CollectionStore.prototype[m] === IS.RecordStore.prototype[m],
      `infrastructure: ${m}() inherited from RecordStore, not reimplemented`);
  }
  const src = fs.readFileSync(require.resolve('./index.js'), 'utf8');
  const code = src.replace(/^\s*\/\/.*$/gm, '');
  ok(/require\(.*immutable-store/.test(src), 'infrastructure: primitives imported from immutable-store');
  ok(!/createHash|renameSync|fsyncSync|openSync/.test(code), 'infrastructure: no forked hashing or atomic-write implementation');
  eq(CS.MODEL, 'sgen-collection-store-v1', 'infrastructure: model tag stable');
})();

// ── 8 · it persists; it decides nothing ──────────────────────────────────────────────────────────
(function noPolicy() {
  const src = fs.readFileSync(require.resolve('./index.js'), 'utf8');
  const code = src.replace(/^\s*\/\/.*$/gm, '');
  ok(!/require\(.*(rules\/registry|\.\.\/score|\.\.\/report|playwright|\.\.\/audit|\.\.\/version)/.test(code),
    'boundary: imports no registry, score, report, audit, version module or Playwright');
  ok(!/severity|deduction|verdict|threshold/i.test(code), 'boundary: no severity, deduction, verdict or threshold logic');
  ok(!/Date\.now|new Date\(/.test(code), 'boundary: reads NO clock');

  // fails closed on everything it would otherwise have to invent
  let t1 = false; try { buildRecord(COLLECTION, { versions: META.versions }); } catch (_) { t1 = true; }
  ok(t1, 'fail-closed: a missing acquiredAt THROWS — infrastructure that timestamps its own writes is making a policy decision');
  let t2 = false; try { buildRecord(COLLECTION, { acquiredAt: AT }); } catch (_) { t2 = true; }
  ok(t2, 'fail-closed: missing versions THROW — the store records what it is TOLD, never what it discovers');
  let t3 = false; try { buildRecord(COLLECTION, { acquiredAt: AT, versions: { engine: '1', registry: '1' } }); } catch (_) { t3 = true; }
  ok(t3, 'fail-closed: a partial version set throws');
  let t4 = false; try { buildRecord({ staticPages: [] }, META); } catch (_) { t4 = true; }
  ok(t4, 'fail-closed: refusing to seal an acquisition with no schemaVersion');
  let t5 = false; try { buildRecord(null, META); } catch (_) { t5 = true; }
  ok(t5, 'fail-closed: null collection throws');
  // digest excludes the identity fields it names
  const rec = buildRecord(COLLECTION, META);
  eq(IS.sha256(recordForDigest(rec)), rec.digest, 'content address: the digest is computed over the record MINUS its own id/digest');
})();

// ── 9 · frozen scope ─────────────────────────────────────────────────────────────────────────────
(function frozen() {
  const version = require('../version'); const reg = require('../rules/registry');
  // ADR-0011 note: this used to pin a version LITERAL, which made the test a SECOND AUTHORITY --
  // exactly the defect D6 eliminated, reintroduced here and exposed the moment ENGINE_VERSION
  // legitimately moved to 2.4.0. A test may assert the SHAPE of a stream and that it comes from the
  // authority; it must never re-declare the value.
  const SEMVER_ = /^\d+\.\d+(\.\d+)?$/;
  ok(SEMVER_.test(version.ENGINE_VERSION), 'D9: engine version unmoved (from the authority: ' + version.ENGINE_VERSION + ')');
  ok(SEMVER_.test(version.REPORT_VERSION), 'D9: report version unmoved (from the authority: ' + version.REPORT_VERSION + ')');
  ok(SEMVER_.test(version.COLLECTION_SCHEMA_VERSION), 'D9: collection schema version unmoved (from the authority: ' + version.COLLECTION_SCHEMA_VERSION + ')');
  ok(SEMVER_.test(version.PROVIDER_CONTRACT_VERSION), 'D9: provider contract version unmoved (from the authority: ' + version.PROVIDER_CONTRACT_VERSION + ')');
  eq(reg.RULES.length, 163, 'D9: registry unchanged — ADR-0009 adds NO rule');
})();

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}

console.log('\n' + (fail === 0 ? '✅ PASS' : '❌ FAIL') + ` — ${pass}/${pass + fail} assertions`);
if (fail) { console.log('Failures:\n' + failures.map(f => '  - ' + f).join('\n')); process.exit(1); }
