'use strict';
// scan-store.test.js — comprehensive, deterministic test suite for WP-003 (Immutable Scan Store).
// Covers: append-only · immutability · determinism · content-addressing · history/lineage · diff ·
// integrity (digest/orphan/missing/duplicate/broken-chain/partial-write) · recovery · restart ·
// index rebuild determinism · parallel scans · performance @ scale. No network, no AI, no clock deps
// (every timestamp is supplied → results are reproducible).
const fs = require('fs');
const path = require('path');
const os = require('os');

const { ScanStore, persist, buildRecord, verify, recover, lineage, chronology, ancestors, children,
        diff, diffRecords, rebuildOK, sha256, canonical } = require('./index');

// ---- tiny test harness ----------------------------------------------------
let pass = 0, fail = 0; const failures = [];
function ok(cond, name) { if (cond) { pass++; } else { fail++; failures.push(name); console.log('  ✗ ' + name); } }
function eq(a, b, name) { ok(JSON.stringify(a) === JSON.stringify(b), name + (a === b ? '' : ` (got ${JSON.stringify(a)} want ${JSON.stringify(b)})`)); }

// ---- deterministic fixture builder ----------------------------------------
// Build a runAudit()-shaped result. `findings` = [{ruleId, suite, severity, page, deduction, value}].
function fixture({ target = 'https://old.example.com', host = 'old.example.com', ts, findings = [], overall = 90, suites = {} } = {}) {
  const checks = findings.map(f => ({
    status: f.severity === 'low' || f.severity === 'medium' ? 'warn' : 'fail',
    ruleId: f.ruleId, ruleSlug: (f.ruleId || '').toLowerCase(), suite: f.suite,
    severity: f.severity, deduction: f.deduction != null ? f.deduction : 5,
    target: f.page || target, detail: f.value || (f.ruleId + ' finding'),
    items: f.items || [{ page: f.page || target, section: f.section || 'body', id: f.id || '', value: f.value || '' }],
  }));
  // group into one synthetic suite for storage flattening (suite key from first finding)
  const suiteObj = { key: 'audit', checks };
  return {
    target, host, generated: ts, verdict: overall >= 80 ? 'ready' : 'not-ready', ready: overall >= 80,
    versions: { engine: '2.1.0', registry: '1.1.0', report: '1.1.0' },
    quality: { overall, suites },
    tally: { fail: checks.filter(c => c.status === 'fail').length, warn: checks.filter(c => c.status === 'warn').length, pass: 0 },
    suites: [suiteObj], crawl: { maxPages: 20 },
  };
}

function tmpDir() {
  const base = process.env.SCANSTORE_TMP || path.join(os.tmpdir(), 'scan-store-test');
  const dir = path.join(base, 'run-' + Buffer.from(canonical(process.pid + ':' + pass + ':' + fail)).toString('hex').slice(0, 8));
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

console.log('WP-003 — Immutable Scan Store — test suite\n');

// ===========================================================================
// 1 · DETERMINISM + CONTENT-ADDRESSING
// ===========================================================================
(function determinism() {
  const r = fixture({ ts: '2026-07-08T10:00:00.000Z', findings: [{ ruleId: 'SEC-001', suite: 'security', severity: 'high', page: 'https://old.example.com/' }] });
  const a = buildRecord(r), b = buildRecord(r);
  eq(a.fingerprint, b.fingerprint, 'determinism: same result → same fingerprint');
  eq(a.scanId, b.scanId, 'determinism: same result → same scanId');
  eq(a.digest, b.digest, 'determinism: same result → same digest');
  ok(a.digest === sha256(require('./record').recordForDigest(a)), 'content-address: digest = sha256(record\\digest)');
  // identical content, different timestamp → same fingerprint, different scanId (re-scan)
  const c = buildRecord(fixture({ ts: '2026-07-09T10:00:00.000Z', findings: [{ ruleId: 'SEC-001', suite: 'security', severity: 'high', page: 'https://old.example.com/' }] }));
  eq(a.fingerprint, c.fingerprint, 'fingerprint: identical outcome, different time → same fingerprint (dup detection)');
  ok(a.scanId !== c.scanId, 'scanId: identical outcome, different time → distinct scanId (re-scan allowed)');
  // different content → different fingerprint
  const d = buildRecord(fixture({ ts: '2026-07-08T10:00:00.000Z', findings: [{ ruleId: 'SEC-002', suite: 'security', severity: 'high' }] }));
  ok(a.fingerprint !== d.fingerprint, 'fingerprint: different outcome → different fingerprint');
})();

// ===========================================================================
// 2 · APPEND-ONLY + IMMUTABILITY + DUPLICATE
// ===========================================================================
(function appendOnly() {
  const dir = tmpDir(); const store = new ScanStore(dir);
  const r = fixture({ ts: '2026-07-08T11:00:00.000Z', findings: [{ ruleId: 'A11Y-001', suite: 'accessibility', severity: 'critical' }] });
  const s1 = store.save(r);
  ok(!s1.duplicate, 'append-only: first save is not a duplicate');
  const bytes1 = fs.readFileSync(store.recordPath(s1.scanId));
  const s2 = store.save(r); // identical → same scanId
  ok(s2.duplicate, 'append-only: re-save identical content → duplicate flag');
  const bytes2 = fs.readFileSync(store.recordPath(s1.scanId));
  ok(Buffer.compare(bytes1, bytes2) === 0, 'immutability: record bytes unchanged after duplicate save');
  eq(store.count(), 1, 'append-only: duplicate did not add a manifest entry');
  // manifest is append-only text; count grows only with new scans
  const r2 = fixture({ ts: '2026-07-08T12:00:00.000Z', findings: [{ ruleId: 'A11Y-002', suite: 'accessibility', severity: 'medium' }] });
  store.save(r2);
  eq(store.count(), 2, 'append-only: distinct scan appends one manifest entry');
})();

// ===========================================================================
// 3 · HISTORY / LINEAGE
// ===========================================================================
(function historyLineage() {
  const dir = tmpDir(); const store = new ScanStore(dir);
  const T = 'https://old.example.com';
  // three scans of the same target, linked parent→child chronologically
  const s1 = persist(store, fixture({ target: T, ts: '2026-07-01T00:00:00.000Z', findings: [{ ruleId: 'SEO-001', suite: 'seo', severity: 'high' }] }));
  const s2 = persist(store, fixture({ target: T, ts: '2026-07-02T00:00:00.000Z', findings: [{ ruleId: 'SEO-002', suite: 'seo', severity: 'medium' }] }));
  const s3 = persist(store, fixture({ target: T, ts: '2026-07-03T00:00:00.000Z', findings: [{ ruleId: 'SEO-003', suite: 'seo', severity: 'low' }] }));
  eq(s2.parentScanId, s1.scanId, 'lineage: persist() auto-links parent = previous latest');
  eq(s3.parentScanId, s2.scanId, 'lineage: chain continues to newest');
  const lin = lineage(store, s3.scanId);
  eq(lin.parent.scanId, s2.scanId, 'lineage: parent resolves');
  eq(lin.previous.scanId, s2.scanId, 'lineage: chronological previous');
  eq(lin.first.scanId, s1.scanId, 'lineage: first');
  eq(lin.latest.scanId, s3.scanId, 'lineage: latest');
  eq(lin.root.scanId, s1.scanId, 'lineage: root = oldest ancestor');
  eq(ancestors(store, s3.scanId).map(r => r.scanId), [s2.scanId, s1.scanId], 'lineage: ancestors nearest→root');
  eq(children(store, s1.scanId).map(r => r.scanId), [s2.scanId], 'lineage: children resolve');
  eq(chronology(store, T, false).map(r => r.scanId), [s1.scanId, s2.scanId, s3.scanId], 'history: chronology oldest→newest');
})();

// ===========================================================================
// 4 · DIFF ENGINE
// ===========================================================================
(function diffEngine() {
  const dir = tmpDir(); const store = new ScanStore(dir);
  const T = 'https://old.example.com';
  const base = persist(store, fixture({ target: T, ts: '2026-07-01T00:00:00.000Z', overall: 80, findings: [
    { ruleId: 'SEC-001', suite: 'security', severity: 'high', page: T + '/a' },
    { ruleId: 'SEO-001', suite: 'seo', severity: 'medium', page: T + '/b' },
  ] }));
  // candidate: SEO-001 resolved, SEC-001 got worse (high→critical), new A11Y-001, score up
  const cand = persist(store, fixture({ target: T, ts: '2026-07-02T00:00:00.000Z', overall: 85, findings: [
    { ruleId: 'SEC-001', suite: 'security', severity: 'critical', page: T + '/a' },
    { ruleId: 'A11Y-001', suite: 'accessibility', severity: 'high', page: T + '/c' },
  ] }));
  const d = diff(store, base.scanId, cand.scanId);
  eq(d.counts.introduced, 1, 'diff: 1 introduced (A11Y-001)');
  eq(d.counts.resolved, 1, 'diff: 1 resolved (SEO-001)');
  eq(d.counts.changed, 1, 'diff: 1 changed (SEC-001 severity)');
  eq(d.introduced[0].ruleId, 'A11Y-001', 'diff: introduced identity');
  eq(d.resolved[0].ruleId, 'SEO-001', 'diff: resolved identity');
  eq(d.scoreDiff.delta, 5, 'diff: score delta +5');
  ok(d.regression && d.improvement, 'diff: both regression + improvement present');
  eq(d.classification, 'mixed', 'diff: classification mixed');
  // deterministic: identical inputs → identical diff
  eq(diff(store, base.scanId, cand.scanId), d, 'diff: deterministic (identical output)');
  // identical fingerprint diff
  const same = diffRecords(store.get(base.scanId), store.get(base.scanId));
  ok(same.identical && same.classification === 'unchanged', 'diff: same scan → identical + unchanged');
})();

// ===========================================================================
// 5 · INTEGRITY — clean, corruption, orphan, missing, duplicate, broken-chain, partial-write
// ===========================================================================
(function integrityChecks() {
  // clean
  let dir = tmpDir(); let store = new ScanStore(dir);
  const s1 = store.save(fixture({ ts: '2026-07-01T00:00:00.000Z', findings: [{ ruleId: 'SEC-001', suite: 'security', severity: 'high' }] }));
  store.save(fixture({ ts: '2026-07-02T00:00:00.000Z', findings: [{ ruleId: 'SEC-002', suite: 'security', severity: 'high' }] }));
  ok(verify(store).ok, 'integrity: clean store verifies ok');

  // corruption / tamper — edit record content, digest no longer matches
  const rec = store.get(s1.scanId); rec.quality.overall = 1; // silent mutation attempt
  fs.writeFileSync(store.recordPath(s1.scanId), JSON.stringify(rec, null, 2));
  let v = verify(store);
  ok(!v.ok && v.issues.some(i => i.type === 'digest-mismatch'), 'integrity: tampered record → digest-mismatch');

  // orphan — record on disk, no manifest line
  dir = tmpDir(); store = new ScanStore(dir);
  const orphan = buildRecord(fixture({ ts: '2026-07-03T00:00:00.000Z', findings: [{ ruleId: 'SEO-001', suite: 'seo', severity: 'low' }] }));
  fs.writeFileSync(store.recordPath(orphan.scanId), JSON.stringify(orphan, null, 2)); // bypass commit
  v = verify(store);
  ok(v.issues.some(i => i.type === 'orphan'), 'integrity: uncommitted record → orphan');

  // missing — manifest line, no record
  dir = tmpDir(); store = new ScanStore(dir);
  fs.appendFileSync(store.manifestPath, JSON.stringify({ scanId: 'deadbeefdeadbeefdeadbeefdeadbeef', digest: 'x', ts: '', parent: null }) + '\n');
  v = verify(store);
  ok(v.issues.some(i => i.type === 'missing'), 'integrity: manifest w/o record → missing');

  // duplicate — same scanId twice in manifest
  dir = tmpDir(); store = new ScanStore(dir);
  const s = store.save(fixture({ ts: '2026-07-04T00:00:00.000Z', findings: [{ ruleId: 'SEC-003', suite: 'security', severity: 'high' }] }));
  const mline = fs.readFileSync(store.manifestPath, 'utf8').trim();
  fs.appendFileSync(store.manifestPath, mline + '\n'); // duplicate the line
  v = verify(store);
  ok(v.issues.some(i => i.type === 'duplicate'), 'integrity: duplicate manifest line → duplicate');

  // broken-chain — parent points nowhere
  dir = tmpDir(); store = new ScanStore(dir);
  store.save(fixture({ ts: '2026-07-05T00:00:00.000Z', findings: [{ ruleId: 'SEO-002', suite: 'seo', severity: 'medium' }] }), { parentScanId: 'ffffffffffffffffffffffffffffffff' });
  v = verify(store);
  ok(v.issues.some(i => i.type === 'broken-chain'), 'integrity: dangling parent → broken-chain');

  // partial-write — leftover .tmp
  dir = tmpDir(); store = new ScanStore(dir);
  store.save(fixture({ ts: '2026-07-06T00:00:00.000Z', findings: [{ ruleId: 'SEC-004', suite: 'security', severity: 'high' }] }));
  fs.writeFileSync(path.join(store.storageDir, 'aaaa.json.tmp'), '{partial');
  v = verify(store);
  ok(v.issues.some(i => i.type === 'partial-write'), 'integrity: leftover .tmp → partial-write');
})();

// ===========================================================================
// 6 · RECOVERY + RESTART
// ===========================================================================
(function recoveryRestart() {
  const dir = tmpDir(); let store = new ScanStore(dir);
  store.save(fixture({ ts: '2026-07-01T00:00:00.000Z', findings: [{ ruleId: 'SEC-001', suite: 'security', severity: 'high' }] }));
  store.save(fixture({ ts: '2026-07-02T00:00:00.000Z', findings: [{ ruleId: 'SEO-001', suite: 'seo', severity: 'low' }] }));
  // simulate crash mid-write: leftover temp + torn index tail
  fs.writeFileSync(path.join(store.storageDir, 'bbbb.json.tmp'), '{half');
  fs.appendFileSync(store.indexPath('by-rule'), '{"key":"SEC-001","scanId":"broken'); // torn line, no newline
  const rec = recover(store);
  ok(rec.actions.some(a => a.action === 'removed-partial-write'), 'recovery: removed partial write');
  ok(rec.actions.some(a => a.action === 'rebuilt-indexes'), 'recovery: rebuilt indexes');
  ok(rec.verified, 'recovery: store verifies after recover');
  eq(rec.remaining.length, 0, 'recovery: no unrepairable issues remain');
  // restart: brand-new instance on same dir sees identical data
  store = new ScanStore(dir);
  eq(store.count(), 2, 'restart: reopened store sees all committed scans');
  ok(verify(store).ok, 'restart: reopened store verifies ok');
})();

// ===========================================================================
// 7 · INDEX REBUILD DETERMINISM
// ===========================================================================
(function indexDeterminism() {
  const dir = tmpDir(); const store = new ScanStore(dir);
  for (let i = 0; i < 20; i++) {
    store.save(fixture({ target: 'https://old.example.com/p' + i, host: 'old.example.com', ts: '2026-07-01T00:00:' + String(i).padStart(2, '0') + '.000Z',
      findings: [{ ruleId: (i % 2 ? 'SEC-001' : 'SEO-001'), suite: (i % 2 ? 'security' : 'seo'), severity: (i % 3 ? 'high' : 'low'), page: 'https://old.example.com/p' + i }] }));
  }
  const { INDEX_NAMES } = require('./store');
  const before = INDEX_NAMES.map(n => fs.existsSync(store.indexPath(n)) ? fs.readFileSync(store.indexPath(n), 'utf8') : '');
  store.rebuildIndexes();
  const after = INDEX_NAMES.map(n => fs.existsSync(store.indexPath(n)) ? fs.readFileSync(store.indexPath(n), 'utf8') : '');
  ok(JSON.stringify(before) === JSON.stringify(after), 'index: rebuild is byte-identical to incremental append');
  // queries resolve
  eq(store.byRule('SEC-001').length, 10, 'index: by-rule query count');
  eq(store.byRule('SEO-001').length, 10, 'index: by-rule query count 2');
  ok(store.byTarget('https://old.example.com/p3').length === 1, 'index: by-target query');
})();

// ===========================================================================
// 8 · PARALLEL SCANS (distinct scans committed interleaved)
// ===========================================================================
(function parallelScans() {
  const dir = tmpDir(); const store = new ScanStore(dir);
  const results = [];
  for (let i = 0; i < 10; i++) {
    results.push(fixture({ target: 'https://old.example.com/s' + i, ts: '2026-07-01T00:10:' + String(i).padStart(2, '0') + '.000Z',
      findings: [{ ruleId: 'FUNC-001', suite: 'functional', severity: 'high', page: '/s' + i }] }));
  }
  // interleave saves (simulating concurrent completions arriving in arbitrary order)
  const order = [3, 7, 1, 9, 0, 5, 2, 8, 4, 6];
  const ids = order.map(i => store.save(results[i]).scanId);
  eq(new Set(ids).size, 10, 'parallel: 10 distinct scans all committed');
  ok(verify(store).ok, 'parallel: store consistent after interleaved commits');
  eq(store.count(), 10, 'parallel: manifest has all 10');
})();

// ===========================================================================
// 9 · PERFORMANCE @ SCALE (measured, not estimated)
// ===========================================================================
const perf = (function performance() {
  const N = Number(process.env.SCANSTORE_PERF_N || 3000);
  const dir = tmpDir(); const store = new ScanStore(dir);
  const hr = () => process.hrtime.bigint();
  const ms = (a, b) => Number(b - a) / 1e6;

  let t0 = hr();
  let firstId = null, lastId = null;
  for (let i = 0; i < N; i++) {
    const r = fixture({ target: 'https://old.example.com', host: 'old.example.com',
      ts: new Date(0).toISOString().replace('1970', '2026').replace(/\.\d{3}Z$/, '.' + String(i % 1000).padStart(3, '0') + 'Z').replace('T00:00:00', 'T' + String(Math.floor(i / 3600) % 24).padStart(2, '0') + ':' + String(Math.floor(i / 60) % 60).padStart(2, '0') + ':' + String(i % 60).padStart(2, '0')),
      findings: [{ ruleId: 'PERF-00' + (i % 6 + 1), suite: 'performance', severity: (i % 2 ? 'high' : 'medium'), page: 'https://old.example.com/p' + i, value: 'v' + i }] });
    const s = store.save(r);
    if (i === 0) firstId = s.scanId;
    lastId = s.scanId;
  }
  const tSave = ms(t0, hr());

  t0 = hr(); const q = store.byRule('PERF-001'); const tQuery = ms(t0, hr());
  t0 = hr(); const reb = store.rebuildIndexes(); const tRebuild = ms(t0, hr());
  t0 = hr(); const v = verify(store); const tVerify = ms(t0, hr());
  t0 = hr(); const d = diff(store, firstId, lastId); const tDiff = ms(t0, hr());
  t0 = hr(); const chrono = chronology(store, 'https://old.example.com', false); const tChrono = ms(t0, hr());

  eq(store.count(), N, 'performance: all N scans stored');
  ok(v.ok, 'performance: N-scan store verifies ok');
  ok(q.length > 0, 'performance: by-rule query returns');
  ok(chrono.length === N, 'performance: chronology returns all');

  return { N, tSave, tQuery, tRebuild, tVerify, tDiff, tChrono, queryHits: q.length, rebuilt: reb.rebuilt };
})();

// ---- report ---------------------------------------------------------------
console.log('\nPerformance (N=' + perf.N + ' scans):');
console.log('  save total      : ' + perf.tSave.toFixed(1) + ' ms  (' + (perf.tSave / perf.N).toFixed(3) + ' ms/scan)');
console.log('  by-rule query   : ' + perf.tQuery.toFixed(2) + ' ms  (' + perf.queryHits + ' hits)');
console.log('  rebuild indexes : ' + perf.tRebuild.toFixed(1) + ' ms  (' + perf.rebuilt + ' records)');
console.log('  verify (all)    : ' + perf.tVerify.toFixed(1) + ' ms');
console.log('  diff first↔last : ' + perf.tDiff.toFixed(2) + ' ms');
console.log('  chronology      : ' + perf.tChrono.toFixed(2) + ' ms');

console.log('\n' + (fail === 0 ? '✅ PASS' : '❌ FAIL') + ` — ${pass}/${pass + fail} assertions`);
if (fail) { console.log('Failures:\n' + failures.map(f => '  - ' + f).join('\n')); process.exit(1); }
