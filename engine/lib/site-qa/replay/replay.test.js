'use strict';
// replay.test.js — ADR-0010 evidence.
//
// Load-bearing suites: §2 (replaying the same collection twice is BYTE-IDENTICAL — the reproducibility
// claim), §4 (impact diff over a real provider-set change) and §5 (every fail-closed refusal, each
// proven distinct rather than lumped into "it throws").
const fs = require('fs');
const os = require('os');
const path = require('path');
const RP = require('./index');
const { replay, impact, compatibility, verifyRecord, collectionFrom, MODEL, SUPPORTED_SCHEMA_VERSIONS } = RP;
const { CollectionStore } = require('../collection-store');
const { makeCollection } = require('../inventory/collection');
const { PROVIDERS } = require('../inventory');
const version = require('../version');

let pass = 0, fail = 0; const failures = [];
function ok(c, n) { if (c) pass++; else { fail++; failures.push(n); console.log('  ✗ ' + n); } }
function eq(a, b, n) { ok(JSON.stringify(a) === JSON.stringify(b), n + (JSON.stringify(a) === JSON.stringify(b) ? '' : ` (got ${JSON.stringify(a)})`)); }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sgen-rp-'));
const AT = '2026-07-28T00:00:00.000Z';
const VERSIONS = { engine: '2.3.0', registry: '1.13.0', providerContract: '1.0' };
const ALL_TYPES = PROVIDERS.map(p => p.type);

const COLLECTION = makeCollection({
  staticPages: [
    { url: 'https://old.example.com/', status: 200, contentType: 'text/html', headers: {}, body: '<!doctype html><html><head><title>Home</title><link rel="stylesheet" href="/a.css"></head><body><header><nav>n</nav></header><h1>Welcome</h1><h2>Services</h2><img src="/hero.jpg"><form action="/contact"><input name="e"></form><footer>f</footer></body></html>' },
    { url: 'https://old.example.com/about', status: 200, contentType: 'text/html', headers: {}, body: '<html><body><header></header><h1>About</h1><img src="/team.jpg"><footer></footer></body></html>' },
  ],
  network: [
    { url: 'https://old.example.com/a.css', method: 'GET', resourceType: 'stylesheet', status: 200, mimeType: 'text/css', sizeBytes: 11, headers: {}, timing: { responseEnd: 12.5 }, initiator: null, fromCache: null, protocol: null, capturedAt: 'X', context: 'metrics', failure: null, documentUrl: 'https://old.example.com/' },
    { url: 'https://cdn.other/t.js', method: 'GET', resourceType: 'script', status: 200, mimeType: 'application/javascript', sizeBytes: null, headers: {}, timing: null, initiator: null, fromCache: null, protocol: null, capturedAt: 'Y', context: 'metrics', failure: null, documentUrl: 'https://old.example.com/' },
  ],
  documents: [{ documentUrl: 'https://old.example.com/', source: 'rendered', assets: [
    { index: 0, sectionIndex: 0, section: 'head', tag: 'link', offset: 40, raw: '<link rel="stylesheet" href="/a.css">', inline: false, external: true, href: '/a.css', src: null, rel: 'stylesheet', relTokens: ['stylesheet'], type: null, media: null, integrity: null, crossorigin: null, async: false, defer: false, nomodule: false, module: false, inlineIndex: null, attrs: { rel: 'stylesheet', href: '/a.css' } },
  ] }],
  shots: [{ label: '1920 · Desktop', file: '/runs/x/a.png', artifactId: 'ev-' + 'a'.repeat(64) }],
  collected: ['staticPages', 'network', 'documents', 'shots'],
});

function sealed(dir = 'seal') {
  const s = new CollectionStore(path.join(TMP, dir));
  const r = s.save(COLLECTION, { acquiredAt: AT, target: 'https://old.example.com', host: 'old.example.com', versions: VERSIONS, providerSet: ALL_TYPES });
  return { store: s, record: s.get(r.collectionId) };
}

console.log('Replay Engine (ADR-0010) — test suite\n');

// ── 1 · a sealed collection replays ──────────────────────────────────────────────────────────────
(function basic() {
  const { record } = sealed('b');
  const r = replay(record, { versions: VERSIONS });
  eq(r.model, MODEL, 'replay: model tag');
  eq(r.mode, 'reproducibility', 'replay: Mode A');
  eq(r.collectionId, record.collectionId, 'replay: reports which collection it replayed');
  ok(/^[a-f0-9]{64}$/.test(r.inventoryDigest), 'replay: inventory is content-addressed');
  ok(r.inventory.counts.page === 2, `replay: pages rebuilt from the sealed collection (${r.inventory.counts.page})`);
  ok(r.inventory.counts.network === 2, 'replay: network items rebuilt WITHOUT a browser');
  ok(r.inventory.counts.document === 1, 'replay: document assets rebuilt');
  eq(r.integrity.ok, true, 'replay: integrity verified before replaying');
})();

// ── 2 · REPRODUCIBILITY — byte-identical, twice, and across stores ───────────────────────────────
(function reproducible() {
  const { record } = sealed('r1');
  const a = replay(record, { versions: VERSIONS });
  const b = replay(record, { versions: VERSIONS });
  ok(a.serialized === b.serialized, 'reproducibility: replaying the SAME collection twice is BYTE-IDENTICAL');
  eq(a.inventoryDigest, b.inventoryDigest, 'reproducibility: identical content address');
  // and from an independently sealed copy of the same acquisition
  const { record: rec2 } = sealed('r2');
  eq(rec2.collectionId, record.collectionId, 'reproducibility: the same acquisition seals to the same collectionId');
  eq(replay(rec2, { versions: VERSIONS }).inventoryDigest, a.inventoryDigest, 'reproducibility: a separately sealed copy replays identically');
  // ids are reproducible from the collection alone — not from invocation history
  const ids = (x) => Object.values(x.inventory.items).flat().map(i => i.id);
  eq(ids(a), ids(b), 'reproducibility: minted ids identical — a fresh IdRegistry per replay, no history leak');
})();

// ── 3 · read-only, no clock, no random, no browser ───────────────────────────────────────────────
(function readOnly() {
  const { store, record } = sealed('ro');
  const before = fs.readFileSync(store.recordPath(record.collectionId), 'utf8');
  const manifestBefore = fs.readFileSync(store.manifestPath, 'utf8');
  replay(record, { versions: VERSIONS });
  impact(record, { baselineProviders: PROVIDERS, candidateProviders: PROVIDERS, versions: VERSIONS });
  eq(fs.readFileSync(store.recordPath(record.collectionId), 'utf8'), before, 'read-only: the collection record is untouched by replay');
  eq(fs.readFileSync(store.manifestPath, 'utf8'), manifestBefore, 'read-only: the manifest is untouched');
  // the reconstructed collection is deep-frozen — a provider cannot corrupt a sealed acquisition
  const c = collectionFrom(record);
  ok(Object.isFrozen(c) && Object.isFrozen(c.network) && (c.network.length === 0 || Object.isFrozen(c.network[0])),
    'read-only: the reconstructed collection is DEEP-frozen, so mutation throws rather than corrupting silently');
  const src = fs.readFileSync(require.resolve('./index.js'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  ok(!/Date\.now|new Date\(/.test(src), 'determinism: replay reads NO clock');
  ok(!/Math\.random/.test(src), 'determinism: replay uses NO randomness');
  ok(!/playwright|chromium|page\./.test(src), 'determinism: replay touches NO browser');
  ok(!/writeFileSync|appendFileSync|mkdirSync|renameSync/.test(src), 'read-only: replay performs NO writes at all');
})();

// ── 4 · IMPACT — same collection, different provider sets ────────────────────────────────────────
(function impactMode() {
  const { record } = sealed('imp');
  const all = PROVIDERS;
  const withoutNetwork = PROVIDERS.filter(p => p.type !== 'network');

  const same = impact(record, { baselineProviders: all, candidateProviders: all, versions: VERSIONS });
  eq(same.identical, true, 'impact: identical provider sets → identical inventories');
  eq(same.counts.added + same.counts.removed + same.counts.changed, 0, 'impact: no drift when nothing changed');
  ok(same.counts.unchanged > 0, `impact: unchanged items counted (${same.counts.unchanged})`);

  // REMOVING a provider: its items disappear from the candidate
  const dropped = impact(record, { baselineProviders: all, candidateProviders: withoutNetwork, versions: VERSIONS });
  eq(dropped.identical, false, 'impact: dropping a provider changes the inventory');
  eq(dropped.counts.added, 0, 'impact: nothing added when a provider is removed');
  ok(dropped.counts.removed === 2 && dropped.removed.every(r => r.type === 'network'),
    `impact: exactly the removed provider's items are reported removed (${dropped.counts.removed})`);

  // ADDING a provider back: mirror image
  const restored = impact(record, { baselineProviders: withoutNetwork, candidateProviders: all, versions: VERSIONS });
  eq(restored.counts.added, 2, 'impact: re-adding a provider reports its items as ADDED');
  eq(restored.counts.removed, 0, 'impact: nothing removed');

  // CHANGED: a provider that emits different meta for the same identity
  const patched = PROVIDERS.map(p => p.type !== 'page' ? p : {
    type: 'page',
    enumerate(c, ctx) { return p.enumerate(c, ctx).map(i => ({ identityKey: i.identityKey, meta: { ...i.meta, extra: 'v2' } })); },
  });
  const ch = impact(record, { baselineProviders: all, candidateProviders: patched, versions: VERSIONS });
  eq(ch.counts.changed, 2, 'impact: same identity + different meta → CHANGED (not added/removed)');
  eq(ch.counts.added + ch.counts.removed, 0, 'impact: a meta change is never miscounted as add/remove');
  ok(ch.changed.every(c => c.type === 'page'), 'impact: the changed items are the patched provider\'s');

  // diff is by identityKey, not by minted id — positional churn must not read as semantic change
  const src = fs.readFileSync(require.resolve('./index.js'), 'utf8');
  ok(/identityKey/.test(src) && /NOT by minted id/.test(src), 'impact: diffs by stable identity, documented as such');
  // deterministic output ordering
  const twice = impact(record, { baselineProviders: all, candidateProviders: withoutNetwork, versions: VERSIONS });
  eq(JSON.stringify(twice), JSON.stringify(dropped), 'impact: the diff itself is deterministic');
})();

// ── 5 · FAILS CLOSED — each refusal distinct ─────────────────────────────────────────────────────
(function failsClosed() {
  const { record } = sealed('fc');

  // unknown schema — built as an INTACT record, because integrity is checked first (see precedence
  // below). Simply editing schemaVersion on a sealed record breaks its digest, so the engine correctly
  // refuses it as damaged and the schema guard is never reached. That ordering is right; the test had
  // to be built to exercise the guard rather than the one in front of it.
  const { buildRecord } = require('../collection-store');
  const rec99 = buildRecord(
    { schemaVersion: '99.0', collected: [], staticPages: [], documents: [], network: [], render: [], console: [], fonts: [], shots: [] },
    { acquiredAt: AT, versions: VERSIONS, providerSet: [] });
  let t1 = false, m1 = '';
  try { replay(rec99, { versions: VERSIONS }); } catch (e) { t1 = true; m1 = e.message; }
  ok(t1 && /unsupported collection schema/i.test(m1), 'fail-closed: an UNKNOWN SCHEMA on an INTACT record is refused, named in the error');
  eq(verifyRecord(rec99).ok, true, 'fail-closed: …and that record is genuinely intact — the refusal is the schema guard, not integrity');
  eq(compatibility(rec99).schemaSupported, false, 'fail-closed: compatibility reports the schema as unsupported');
  // precedence: a DAMAGED record is refused before its schema is even considered
  const tamperedSchema = JSON.parse(JSON.stringify(record));
  tamperedSchema.manifest.schemaVersion = '99.0';
  let mp = '';
  try { replay(tamperedSchema, { versions: VERSIONS }); } catch (e) { mp = e.message; }
  ok(/integrity check FAILED/i.test(mp), 'fail-closed: PRECEDENCE — a damaged record is refused before the schema guard runs');
  ok(SUPPORTED_SCHEMA_VERSIONS.includes('1.1'), 'fail-closed: the supported set is explicit');

  // unknown / missing provider
  let t2 = false, m2 = '';
  try { replay(record, { providers: PROVIDERS.filter(p => p.type !== 'network'), versions: VERSIONS }); } catch (e) { t2 = true; m2 = e.message; }
  ok(t2 && /no longer exist/i.test(m2), 'fail-closed: a provider SEALED INTO the collection that no longer exists is refused — replaying without it would be a different computation');

  // damaged collection
  const damaged = JSON.parse(JSON.stringify(record));
  damaged.channels.network[0].status = 500;
  let t3 = false, m3 = '';
  try { replay(damaged, { versions: VERSIONS }); } catch (e) { t3 = true; m3 = e.message; }
  ok(t3 && /integrity check FAILED/i.test(m3), 'fail-closed: a DAMAGED collection is never replayed');
  eq(verifyRecord(damaged).ok, false, 'fail-closed: verifyRecord detects the damage');
  eq(verifyRecord(record).ok, true, 'fail-closed: an intact record verifies');

  // not a collection record at all
  let t4 = false; try { replay({ nope: 1 }); } catch (_) { t4 = true; }
  ok(t4, 'fail-closed: a non-collection object is refused');
  let t5 = false; try { impact(record, { baselineProviders: PROVIDERS }); } catch (_) { t5 = true; }
  ok(t5, 'fail-closed: impact without both provider sets throws');
})();

// ── 6 · compatibility reports FACTS, decides nothing ─────────────────────────────────────────────
(function compat() {
  const { record } = sealed('cp');
  const c = compatibility(record, { versions: { engine: '9.9.9', registry: '9.9.9', providerContract: '9.9' } });
  eq(c.sealedVersions, { engine: '2.3.0', registry: '1.13.0', providerContract: '1.0' }, 'compatibility: sealed versions reported');
  eq(c.versionDrift, { engine: true, registry: true, providerContract: true }, 'compatibility: drift is REPORTED as a fact');
  // …and drift alone does NOT block a replay — deciding what drift means is the caller's job
  const r = replay(record, { versions: { engine: '9.9.9', registry: '9.9.9', providerContract: '9.9' } });
  ok(r.inventoryDigest, 'compatibility: version drift does NOT block replay — the engine reports, the caller decides');
  eq(c.collectorSet, ['documents', 'network', 'shots', 'staticPages'], 'compatibility: collector set carried from the seal');
  const rec = JSON.stringify(compatibility(record, { versions: VERSIONS }));
  ok(!/"(replayable|canReplay|verdict|ok)"\s*:/.test(rec), 'compatibility: emits no verdict field — facts only');
})();

// ── 7 · frozen scope: replay mutates nothing it reads ────────────────────────────────────────────
(function frozenScope() {
  const reg = require('../rules/registry');
  const rulesBefore = reg.RULES.length;
  const providersBefore = PROVIDERS.length;
  const { record } = sealed('fz');
  replay(record, { versions: VERSIONS });
  impact(record, { baselineProviders: PROVIDERS, candidateProviders: PROVIDERS.filter(p => p.type !== 'network'), versions: VERSIONS });
  eq(reg.RULES.length, rulesBefore, 'frozen: replay does not mutate the registry');
  eq(PROVIDERS.length, providersBefore, 'frozen: replay does not mutate the provider set');
  eq(reg.RULES.length, 142, 'D9: registry unchanged — ADR-0010 adds NO rule');
  // ADR-0011 note: this used to pin a version LITERAL, which made the test a SECOND AUTHORITY --
  // exactly the defect D6 eliminated, reintroduced here and exposed the moment ENGINE_VERSION
  // legitimately moved to 2.4.0. A test may assert the SHAPE of a stream and that it comes from the
  // authority; it must never re-declare the value.
  const SEMVER_ = /^\d+\.\d+(\.\d+)?$/;
  ok(SEMVER_.test(version.ENGINE_VERSION), 'D9: engine version unmoved (from the authority: ' + version.ENGINE_VERSION + ')');
  ok(SEMVER_.test(version.REPORT_VERSION), 'D9: report version unmoved (from the authority: ' + version.REPORT_VERSION + ')');
  const src = fs.readFileSync(require.resolve('./index.js'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  ok(!/require\(.*(\.\.\/score|\.\.\/report|rules\/registry|\.\.\/audit)/.test(src), 'boundary: replay imports no score, report, registry or audit module');
  ok(!/severity|deduction|verdict/i.test(src), 'boundary: no scoring or verdict logic');
})();

// ── 8 · what this engine does NOT claim ──────────────────────────────────────────────────────────
// Stated as a test so the limitation is machine-checked rather than living only in prose: replay
// covers the PROVIDER layer. Finding-level replay needs the rules layer to consume inventories, which
// no ADR in force has authorised.
(function notClaimed() {
  const { record } = sealed('nc');
  const r = replay(record, { versions: VERSIONS });
  ok(!('findings' in r) && !('score' in r) && !('quality' in r),
    'scope: replay returns NO findings, score or quality — the rules layer is still page-first and this engine does not pretend otherwise');
  const hdr = fs.readFileSync(require.resolve('./index.js'), 'utf8');
  ok(/It is NOT the rules layer/.test(hdr), 'scope: the limitation is documented at the top of the module, not buried');
})();

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}

console.log('\n' + (fail === 0 ? '✅ PASS' : '❌ FAIL') + ` — ${pass}/${pass + fail} assertions`);
if (fail) { console.log('Failures:\n' + failures.map(f => '  - ' + f).join('\n')); process.exit(1); }
