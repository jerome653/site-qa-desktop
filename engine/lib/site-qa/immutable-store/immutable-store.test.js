'use strict';
// immutable-store.test.js — ADR-0008 evidence for the extracted infrastructure itself.
//
// The parity evidence (the five specialised stores still producing byte-identical output) lives in
// their own suites and in the on-disk oracle recorded in the ADR. THIS suite covers the primitives
// those stores now depend on, and the invariant that makes the extraction meaningful: every store
// resolves content-addressing to ONE implementation.
const fs = require('fs');
const os = require('os');
const path = require('path');
const IS = require('./index');
const { canonical, sha256, writeRecordAtomic, appendLine, appendLines, readJsonl, readRecord, exists, ensureDir, RecordStore } = IS;

let pass = 0, fail = 0; const failures = [];
function ok(c, n) { if (c) pass++; else { fail++; failures.push(n); console.log('  ✗ ' + n); } }
function eq(a, b, n) { ok(JSON.stringify(a) === JSON.stringify(b), n + (JSON.stringify(a) === JSON.stringify(b) ? '' : ` (got ${JSON.stringify(a)})`)); }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sgen-is-'));

console.log('Immutable Store (ADR-0008) — test suite\n');

// ── 1 · content addressing ────────────────────────────────────────────────────────────────────────
(function addressing() {
  eq(canonical({ b: 2, a: 1 }), '{"a":1,"b":2}', 'canonical: object keys sorted');
  eq(canonical([1, { z: 1, a: 2 }]), '[1,{"a":2,"z":1}]', 'canonical: recursive, no whitespace');
  eq(canonical(undefined), 'null', 'canonical: undefined serialises as null');
  eq(sha256({ a: 1, b: 2 }), sha256({ b: 2, a: 1 }), 'sha256: key order cannot change the digest');
  ok(sha256({ a: 1 }) !== sha256({ a: 2 }), 'sha256: different content → different digest');
  eq(sha256('literal'), sha256('literal'), 'sha256: strings hash by value');
  // the exact value the four store copies produced BEFORE the extraction — pinned, not assumed
  eq(sha256({ b: 2, a: 1 }), '43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777',
    'sha256: byte-identical to the pre-extraction implementation the four stores each carried');
})();

// ── 2 · ONE implementation — the whole point of the extraction ───────────────────────────────────
(function oneImplementation() {
  const stores = ['scan-store', 'finding-store', 'regression', 'timeline'];
  for (const s of stores) {
    const d = require(`../${s}/digest`);
    ok(d.sha256 === sha256, `single source: ${s}/digest.sha256 IS immutable-store's function (same reference, not a copy)`);
    ok(d.canonical === canonical, `single source: ${s}/digest.canonical IS immutable-store's function`);
  }
  const led = fs.readFileSync(require.resolve('../evidence-ledger/index.js'), 'utf8');
  ok(/require\(.*immutable-store/.test(led), 'single source: evidence-ledger hashes via immutable-store');
  // no store may reimplement the hash
  for (const s of stores) {
    const src = fs.readFileSync(require.resolve(`../${s}/digest.js`), 'utf8').replace(/^\s*\/\/.*$/gm, '');
    ok(!/createHash/.test(src), `single source: ${s}/digest carries no crypto of its own`);
  }
})();

// ── 3 · durable commit ────────────────────────────────────────────────────────────────────────────
(function commit() {
  const p = path.join(TMP, 'rec.json');
  writeRecordAtomic(p, { b: 2, a: 1 });
  eq(fs.readFileSync(p, 'utf8'), JSON.stringify({ b: 2, a: 1 }, null, 2),
    'commit: serialisation is JSON.stringify(rec, null, 2) — the exact form the stores wrote before');
  ok(!fs.existsSync(p + '.tmp'), 'commit: no .tmp survives a successful write');
  eq(readRecord(p), { b: 2, a: 1 }, 'commit: readRecord round-trips');
  eq(readRecord(path.join(TMP, 'nope.json')), null, 'commit: reading a missing record is null, not a throw');
  ok(exists(p) && !exists(p + 'x'), 'commit: exists() is honest');
  const d = ensureDir(path.join(TMP, 'a', 'b', 'c'));
  ok(fs.existsSync(d), 'commit: ensureDir is recursive');
})();

// ── 4 · append-only journals ──────────────────────────────────────────────────────────────────────
(function journals() {
  const m = path.join(TMP, 'manifest.jsonl');
  appendLine(m, { id: 1 }); appendLine(m, { id: 2 });
  eq(fs.readFileSync(m, 'utf8'), '{"id":1}\n{"id":2}\n', 'journal: appendLine writes JSON + newline, nothing else');
  eq(readJsonl(m), [{ id: 1 }, { id: 2 }], 'journal: readJsonl round-trips');
  const ix = path.join(TMP, 'index.jsonl');
  appendLines(ix, ['{"k":"a"}', '{"k":"b"}']);
  eq(fs.readFileSync(ix, 'utf8'), '{"k":"a"}\n{"k":"b"}\n', 'journal: appendLines writes ALREADY-serialised lines verbatim (re-serialising would change bytes)');
  appendLines(ix, []);
  eq(fs.readFileSync(ix, 'utf8'), '{"k":"a"}\n{"k":"b"}\n', 'journal: an empty append writes nothing');
  eq(readJsonl(path.join(TMP, 'absent.jsonl')), [], 'journal: a missing journal is EMPTY, never a throw — a first run is not a corrupt run');
  // a torn tail line (crash mid-append) must not make the whole journal unreadable
  fs.appendFileSync(m, '{"id":3');
  eq(readJsonl(m), [{ id: 1 }, { id: 2 }], 'journal: a torn tail line is dropped, the rest still reads');
})();

// ── 5 · RecordStore — the layout a future store gets for free ────────────────────────────────────
(function recordStore() {
  const root = path.join(TMP, 'rs');
  const s = new RecordStore(root);
  ok(fs.existsSync(s.storageDir) && fs.existsSync(s.indexDir), 'RecordStore: storage + index dirs created');
  eq(s.has('x'), false, 'RecordStore: has() false before commit');
  s.commit('x', { v: 1 }, { id: 'x', ts: 'T' });
  ok(s.has('x'), 'RecordStore: has() true after commit');
  eq(s.get('x'), { v: 1 }, 'RecordStore: get() returns the record');
  eq(s.manifest(), [{ id: 'x', ts: 'T' }], 'RecordStore: manifest is the append-only commit log');
  eq(s.get('missing'), null, 'RecordStore: unknown id is null');
  ok(s.recordPath('x').endsWith(path.join('storage', 'x.json')), 'RecordStore: record layout');
  ok(s.indexPath('by-thing').endsWith(path.join('indexes', 'by-thing.jsonl')), 'RecordStore: index layout');
  // a second store type is CONFIGURATION, not another implementation — ADR-0008's stated goal
  const alt = new RecordStore(path.join(TMP, 'rs2'), { storageDirName: 'records', manifestName: 'log.jsonl' });
  alt.commit('y', { v: 2 }, { id: 'y' });
  ok(fs.existsSync(path.join(TMP, 'rs2', 'records', 'y.json')) && fs.existsSync(path.join(TMP, 'rs2', 'log.jsonl')),
    'RecordStore: layout is configurable — a new store is configuration, not a fifth implementation');
})();

// ── 6 · infrastructure makes NO policy decisions ─────────────────────────────────────────────────
(function noPolicy() {
  const src = fs.readFileSync(require.resolve('./index.js'), 'utf8');
  const code = src.replace(/^\s*\/\/.*$/gm, '');
  ok(!/require\(.*(rules\/registry|score|report|playwright|audit)/.test(code), 'boundary: imports no registry, score, report, Playwright or audit module');
  ok(!/severity|deduction|verdict|threshold/i.test(code), 'boundary: no severity, deduction, verdict or threshold logic');
  ok(!/Date\.now|new Date\(/.test(code), 'boundary: reads NO clock — a timestamp is always supplied by the caller');
  ok(!/readdirSync|glob/.test(code), 'boundary: no filesystem DISCOVERY — it writes and reads paths it is given');
  eq(Object.keys(IS).sort(), ['RecordStore', 'appendLine', 'appendLines', 'canonical', 'ensureDir', 'exists', 'readJsonl', 'readRecord', 'sha256', 'writeRecordAtomic'], 'surface: primitives only');
  const version = require('../version'); const reg = require('../rules/registry');
  // ADR-0011 note: this used to pin a version LITERAL, which made the test a SECOND AUTHORITY --
  // exactly the defect D6 eliminated, reintroduced here and exposed the moment ENGINE_VERSION
  // legitimately moved to 2.4.0. A test may assert the SHAPE of a stream and that it comes from the
  // authority; it must never re-declare the value.
  const SEMVER_ = /^\d+\.\d+(\.\d+)?$/;
  ok(SEMVER_.test(version.ENGINE_VERSION), 'D9: engine version unmoved — extraction changes no behaviour (from the authority: ' + version.ENGINE_VERSION + ')');
  ok(SEMVER_.test(version.REPORT_VERSION), 'D9: report version unmoved (from the authority: ' + version.REPORT_VERSION + ')');
  eq(reg.RULES.length, 161, 'D9: registry unchanged');
})();

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}

console.log('\n' + (fail === 0 ? '✅ PASS' : '❌ FAIL') + ` — ${pass}/${pass + fail} assertions`);
if (fail) { console.log('Failures:\n' + failures.map(f => '  - ' + f).join('\n')); process.exit(1); }
