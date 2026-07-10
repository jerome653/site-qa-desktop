'use strict';
// finding-store.test.js — comprehensive, deterministic suite for WP-004 (Immutable Finding Store).
// Feeds REAL WP-003 scan records (built via scan-store) to prove cross-store compatibility.
// Covers: identity · lifecycle (valid/invalid/reopen/resolve/supersede) · integrity (mutation /
// truncation / reorder / forged / restart / partial-write) · history · concurrency · performance.
// No network, no AI, no clock/random deps (all timestamps supplied → reproducible).
const fs = require('fs');
const path = require('path');
const os = require('os');

const FS = require('./index');
const { FindingStore, buildRecord, findingIdentity, verify, recover, lineage, chronology, relations, diffScans, canTransition } = FS;
const SS = require('../scan-store'); // WP-003 — the authoritative scan store (frozen dependency)

let pass = 0, fail = 0; const failures = [];
function ok(c, n) { if (c) pass++; else { fail++; failures.push(n); console.log('  ✗ ' + n); } }
function eq(a, b, n) { ok(JSON.stringify(a) === JSON.stringify(b), n + (JSON.stringify(a) === JSON.stringify(b) ? '' : ` (got ${JSON.stringify(a)} want ${JSON.stringify(b)})`)); }
function throws(fn, n) { let t = false; try { fn(); } catch (_) { t = true; } ok(t, n); }

// Build a REAL WP-003 scan record from a light fixture (proves compatibility end-to-end).
function scanRecord({ target = 'https://old.example.com', host, ts, findings = [] }) {
  const checks = findings.map(f => ({
    status: f.severity === 'low' || f.severity === 'medium' ? 'warn' : 'fail',
    ruleId: f.ruleId, ruleSlug: (f.ruleId || '').toLowerCase(), suite: f.suite || 'security',
    severity: f.severity || 'high', deduction: 5, target: f.page || target, detail: f.value || (f.ruleId + ' finding'),
    items: [{ page: f.page || target, section: f.section || 'body', id: f.id || '', value: f.value || '' }],
  }));
  const result = { target, host: host || target, generated: ts, verdict: 'ready', ready: true,
    versions: { engine: '2.1.0', registry: '1.1.0', report: '1.1.0' }, quality: { overall: 90, suites: {} },
    tally: {}, suites: [{ key: 'audit', checks }], crawl: { maxPages: 20 } };
  return SS.buildRecord(result, { environment: 'production' });
}

function tmpDir(tag) {
  const dir = path.join(os.tmpdir(), 'finding-store-test', 'run-' + tag + '-' + (pass + fail));
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

console.log('WP-004 — Immutable Finding Store — test suite\n');

// ===========================================================================
// 1 · IDENTITY
// ===========================================================================
(function identity() {
  const base = { ruleId: 'SEC-001', targetDigest: 'td', severity: 'high', newState: 'OPEN', scanId: 's1', timestamp: 't', evidence: { page: '/a', items: [{ page: '/a', section: 'head', id: 'x', value: 'v1' }] } };
  const fid = findingIdentity({ ruleId: base.ruleId, targetDigest: base.targetDigest, evidence: base.evidence });
  const r1 = buildRecord({ ...base, findingId: fid });
  const r2 = buildRecord({ ...base, findingId: fid });
  eq(r1.fingerprint, r2.fingerprint, 'identity: identical finding → same fingerprint');
  eq(r1.recordId, r2.recordId, 'identity: identical event → same recordId (content-addressed)');

  // title/display text is NOT part of identity or fingerprint
  const r3 = buildRecord({ ...base, findingId: fid, title: 'A COMPLETELY DIFFERENT TITLE', detail: 'different display text' });
  eq(r1.fingerprint, r3.fingerprint, 'identity: title/display change → same fingerprint (WP-001)');
  eq(findingIdentity({ ruleId: 'SEC-001', targetDigest: 'td', evidence: base.evidence }), fid, 'identity: findingId ignores title');

  // ruleId change → new identity
  const fid2 = findingIdentity({ ruleId: 'SEC-002', targetDigest: 'td', evidence: base.evidence });
  ok(fid2 !== fid, 'identity: ruleId change → new findingId');
  ok(buildRecord({ ...base, ruleId: 'SEC-002', findingId: fid2 }).fingerprint !== r1.fingerprint, 'identity: ruleId change → new fingerprint');

  // value change keeps identity (same location) but changes evidenceDigest
  const evB = { page: '/a', items: [{ page: '/a', section: 'head', id: 'x', value: 'v2' }] };
  eq(findingIdentity({ ruleId: 'SEC-001', targetDigest: 'td', evidence: evB }), fid, 'identity: value change → same findingId (location stable)');
  ok(buildRecord({ ...base, findingId: fid, evidence: evB }).evidenceRef.evidenceDigest !== r1.evidenceRef.evidenceDigest, 'identity: value change → different evidenceDigest');
})();

// ===========================================================================
// 2 · LIFECYCLE (valid, invalid, reopen, resolve, supersede) via scan ingestion
// ===========================================================================
(function lifecycleFlow() {
  const dir = tmpDir('life'); const store = new FindingStore(dir);
  const T = 'https://old.example.com';
  const F = (ruleId, value) => ({ ruleId, suite: 'security', severity: 'high', page: T + '/p', value });

  const s1 = scanRecord({ target: T, ts: '2026-07-01T00:00:00.000Z', findings: [F('SEC-001', 'v1')] });
  const s2 = scanRecord({ target: T, ts: '2026-07-02T00:00:00.000Z', findings: [F('SEC-001', 'v1')] });
  const s3 = scanRecord({ target: T, ts: '2026-07-03T00:00:00.000Z', findings: [F('SEC-001', 'v1')] });
  store.ingestScan(s1); const fid = store.findings()[0].findingId;
  eq(store.currentState(fid), 'OPEN', 'lifecycle: first sighting → OPEN');
  store.ingestScan(s2, { prevScanRecord: s1 });
  eq(store.currentState(fid), 'CONFIRMED', 'lifecycle: second sighting → CONFIRMED');
  store.ingestScan(s3, { prevScanRecord: s2 });
  eq(store.currentState(fid), 'ACTIVE', 'lifecycle: third sighting → ACTIVE');

  // evidence change → UPDATED, then settle → ACTIVE
  const s4 = scanRecord({ target: T, ts: '2026-07-04T00:00:00.000Z', findings: [F('SEC-001', 'v2-CHANGED')] });
  store.ingestScan(s4, { prevScanRecord: s3 });
  eq(store.currentState(fid), 'UPDATED', 'lifecycle: evidence change → UPDATED');
  const s5 = scanRecord({ target: T, ts: '2026-07-05T00:00:00.000Z', findings: [F('SEC-001', 'v2-CHANGED')] });
  store.ingestScan(s5, { prevScanRecord: s4 });
  eq(store.currentState(fid), 'ACTIVE', 'lifecycle: next sighting → settle to ACTIVE');

  // absent next scan → RESOLVED
  const s6 = scanRecord({ target: T, ts: '2026-07-06T00:00:00.000Z', findings: [] });
  store.ingestScan(s6, { prevScanRecord: s5 });
  eq(store.currentState(fid), 'RESOLVED', 'lifecycle: absence → RESOLVED');

  // present again → REOPENED
  const s7 = scanRecord({ target: T, ts: '2026-07-07T00:00:00.000Z', findings: [F('SEC-001', 'v2-CHANGED')] });
  store.ingestScan(s7, { prevScanRecord: s6 });
  eq(store.currentState(fid), 'REOPENED', 'lifecycle: reappearance after resolve → REOPENED');

  // explicit terminal transitions via append
  // supersede a REOPENED→ACTIVE finding
  const s8 = scanRecord({ target: T, ts: '2026-07-08T00:00:00.000Z', findings: [F('SEC-001', 'v2-CHANGED')] });
  store.ingestScan(s8, { prevScanRecord: s7 });
  eq(store.currentState(fid), 'ACTIVE', 'lifecycle: after REOPENED → ACTIVE');
  store.append({ findingId: fid, newState: 'SUPERSEDED', actor: 'analyst', scanId: 's8', timestamp: '2026-07-08T01:00:00.000Z', evidence: { page: T + '/p', items: [] } });
  eq(store.currentState(fid), 'SUPERSEDED', 'lifecycle: ACTIVE → SUPERSEDED (terminal)');
  throws(() => store.append({ findingId: fid, newState: 'ACTIVE', scanId: 's9', timestamp: 't', evidence: {} }), 'lifecycle: SUPERSEDED → ACTIVE fails closed (terminal)');

  // DUPLICATE terminal on a fresh finding
  const d = tmpDir('dup'); const st2 = new FindingStore(d);
  st2.ingestScan(scanRecord({ target: T, ts: '2026-07-01T00:00:00.000Z', findings: [F('SEO-001', 'x')] }));
  const fid2 = st2.findings()[0].findingId;
  st2.append({ findingId: fid2, newState: 'CONFIRMED', scanId: 's', timestamp: 't', evidence: { page: T, items: [] } });
  st2.append({ findingId: fid2, newState: 'ACTIVE', scanId: 's', timestamp: 't', evidence: { page: T, items: [] } });
  const dupRes = st2.append({ findingId: fid2, newState: 'DUPLICATE', scanId: 's', timestamp: 't', evidence: { page: T, items: [] } });
  ok(!dupRes.duplicate && st2.currentState(fid2) === 'DUPLICATE', 'lifecycle: ACTIVE → DUPLICATE (terminal)');

  // invalid transitions fail closed
  const inv = tmpDir('inv'); const st3 = new FindingStore(inv);
  st3.ingestScan(scanRecord({ target: T, ts: '2026-07-01T00:00:00.000Z', findings: [F('FUNC-001', 'y')] }));
  const fid3 = st3.findings()[0].findingId; // OPEN
  throws(() => st3.append({ findingId: fid3, newState: 'RESOLVED', scanId: 's', timestamp: 't', evidence: {} }), 'lifecycle: OPEN → RESOLVED fails closed');
  throws(() => st3.append({ findingId: fid3, newState: 'ACTIVE', scanId: 's', timestamp: 't', evidence: {} }), 'lifecycle: OPEN → ACTIVE (skip CONFIRMED) fails closed');
  ok(canTransition('RESOLVED', 'REOPENED') && !canTransition('RESOLVED', 'ACTIVE'), 'lifecycle: transition table correct (RESOLVED→REOPENED only)');
})();

// ===========================================================================
// 3 · HISTORY / LINEAGE
// ===========================================================================
(function historyLineage() {
  const dir = tmpDir('hist'); const store = new FindingStore(dir);
  const T = 'https://old.example.com';
  const F = v => ({ ruleId: 'A11Y-001', suite: 'accessibility', severity: 'critical', page: T + '/home', value: v });
  const scans = ['2026-07-01', '2026-07-02', '2026-07-03'].map((d, i) => scanRecord({ target: T, ts: d + 'T00:00:00.000Z', findings: [F('v' + i)] }));
  store.ingestScan(scans[0]);
  store.ingestScan(scans[1], { prevScanRecord: scans[0] });
  store.ingestScan(scans[2], { prevScanRecord: scans[1] });
  const fid = store.findings()[0].findingId;
  const lin = lineage(store, fid);
  eq(lin.timeline.map(t => t.to), ['OPEN', 'CONFIRMED', 'ACTIVE'], 'history: lineage state sequence (OPEN→CONFIRMED→ACTIVE over 3 scans)');
  eq(lin.firstSeen, '2026-07-01T00:00:00.000Z', 'history: firstSeen');
  eq(lin.lastSeen, '2026-07-03T00:00:00.000Z', 'history: lastSeen');
  eq(lin.observations, 3, 'history: observation count');
  // parent/child links
  const recs = store.recordsFor(fid);
  const rel = relations(store, recs[1].recordId);
  eq(rel.parent.recordId, recs[0].recordId, 'history: parent link');
  eq(rel.child.recordId, recs[2].recordId, 'history: child link');
  eq(recs[0].parentRecordId, null, 'history: root has no parent');
  // chronology
  const chrono = chronology(store, T);
  eq(chrono.length, 1, 'history: chronology finds the target finding');
})();

// ===========================================================================
// 4 · DIFF ENGINE
// ===========================================================================
(function diffEngine() {
  const dir = tmpDir('diff'); const store = new FindingStore(dir);
  const T = 'https://old.example.com';
  const a = scanRecord({ target: T, ts: '2026-07-01T00:00:00.000Z', findings: [
    { ruleId: 'SEC-001', severity: 'high', page: T + '/a', value: 'v1' },
    { ruleId: 'SEO-001', severity: 'medium', page: T + '/b', value: 'v1' },
  ] });
  const b = scanRecord({ target: T, ts: '2026-07-02T00:00:00.000Z', findings: [
    { ruleId: 'SEC-001', severity: 'critical', page: T + '/a', value: 'v1' }, // severity change
    { ruleId: 'A11Y-001', severity: 'high', page: T + '/c', value: 'v1' },    // new
  ] });
  const d = diffScans(a, b);
  eq(d.counts.created, 1, 'diff: 1 created (A11Y-001)');
  eq(d.counts.resolved, 1, 'diff: 1 resolved (SEO-001)');
  eq(d.counts.modified, 1, 'diff: 1 modified (SEC-001)');
  eq(d.counts.severityChanges, 1, 'diff: severity change tracked');
  eq(d.created[0].ruleId, 'A11Y-001', 'diff: created identity (ruleId, not title)');
  eq(diffScans(a, b), d, 'diff: deterministic (identical output)');

  // reopened detection uses the store: resolve SEO-001, then it reappears
  store.ingestScan(a);
  store.ingestScan(b, { prevScanRecord: a }); // SEO-001 now RESOLVED in store
  const c = scanRecord({ target: T, ts: '2026-07-03T00:00:00.000Z', findings: [{ ruleId: 'SEO-001', severity: 'medium', page: T + '/b', value: 'v1' }] });
  const d2 = diffScans(b, c, { store });
  eq(d2.counts.reopened, 1, 'diff: reopened detected via store state');
  eq(d2.counts.created, 0, 'diff: reappearing resolved finding is reopened, not created');
})();

// ===========================================================================
// 5 · INTEGRITY (mutation / truncation / reorder / forged / partial / duplicate / broken / orphan / transition)
// ===========================================================================
(function integrityChecks() {
  const T = 'https://old.example.com';
  const F = v => ({ ruleId: 'SEC-001', severity: 'high', page: T + '/p', value: v });
  function seeded(tag) {
    const store = new FindingStore(tmpDir(tag));
    const s1 = scanRecord({ target: T, ts: '2026-07-01T00:00:00.000Z', findings: [F('v1')] });
    const s2 = scanRecord({ target: T, ts: '2026-07-02T00:00:00.000Z', findings: [F('v1')] });
    const s3 = scanRecord({ target: T, ts: '2026-07-03T00:00:00.000Z', findings: [F('v1')] });
    store.ingestScan(s1); store.ingestScan(s2, { prevScanRecord: s1 }); store.ingestScan(s3, { prevScanRecord: s2 });
    return store;
  }
  ok(verify(seeded('clean')).ok, 'integrity: clean store verifies ok');

  // mutation (modified record → digest-mismatch)
  let store = seeded('mut'); let id = store.storedIds()[0];
  let rec = store.get(id); rec.severity = 'low'; fs.writeFileSync(store.recordPath(id), JSON.stringify(rec, null, 2));
  ok(verify(store).issues.some(i => i.type === 'digest-mismatch'), 'integrity: mutated record → digest-mismatch');

  // truncation (torn manifest tail)
  store = seeded('trunc');
  fs.appendFileSync(store.manifestPath, '{"recordId":"broken');
  ok(verify(store).issues.some(i => i.type === 'torn-manifest'), 'integrity: torn manifest tail → truncation detected');

  // reorder / broken chain (tamper previousState so the chain no longer links)
  store = seeded('reorder');
  const fid = store.findings()[0].findingId; const recs = store.recordsFor(fid);
  const mid = recs[1]; mid.previousState = 'RESOLVED'; mid.digest = FS.sha256(FS.recordForDigest(mid));
  fs.writeFileSync(store.recordPath(mid.recordId), JSON.stringify(mid, null, 2));
  const vRe = verify(store);
  ok(vRe.issues.some(i => i.type === 'broken-chain' || i.type === 'invalid-transition'), 'integrity: tampered chain → broken-chain/invalid-transition');

  // forged record (recordId not derivable from content)
  store = seeded('forge');
  const forged = store.get(store.storedIds()[0]);
  const fakeId = 'ffffffffffffffffffffffffffffffff';
  forged.recordId = fakeId; forged.digest = FS.sha256(FS.recordForDigest(forged));
  fs.writeFileSync(store.recordPath(fakeId), JSON.stringify(forged, null, 2));
  fs.appendFileSync(store.manifestPath, JSON.stringify({ recordId: fakeId, findingId: forged.findingId, seq: forged.seq, state: forged.newState }) + '\n');
  ok(verify(store).issues.some(i => i.type === 'address-mismatch'), 'integrity: forged recordId → address-mismatch');

  // duplicate identity conflict (two recordIds claim same findingId|seq)
  store = seeded('idconf');
  const r0 = store.get(store.recordsFor(store.findings()[0].findingId)[0].recordId);
  const clone = JSON.parse(JSON.stringify(r0)); clone.recordId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; clone.actor = 'x';
  clone.digest = FS.sha256(FS.recordForDigest(clone));
  fs.writeFileSync(store.recordPath(clone.recordId), JSON.stringify(clone, null, 2));
  fs.appendFileSync(store.manifestPath, JSON.stringify({ recordId: clone.recordId, findingId: clone.findingId, seq: clone.seq }) + '\n');
  ok(verify(store).issues.some(i => i.type === 'identity-conflict'), 'integrity: two records same findingId|seq → identity-conflict');

  // partial write
  store = seeded('partial');
  fs.writeFileSync(path.join(store.storageDir, 'zzzz.json.tmp'), '{half');
  ok(verify(store).issues.some(i => i.type === 'partial-write'), 'integrity: leftover .tmp → partial-write');

  // orphaned reference (scanRef not in scan store)
  store = seeded('orphanref');
  const scanStore = new SS.ScanStore(tmpDir('orphanref-scans')); // empty → all scan refs orphaned
  ok(verify(store, { scanStore }).issues.some(i => i.type === 'orphaned-reference'), 'integrity: scanRef missing from Scan Store → orphaned-reference');
})();

// ===========================================================================
// 6 · RECOVERY + RESTART
// ===========================================================================
(function recoveryRestart() {
  const T = 'https://old.example.com';
  const dir = tmpDir('recover'); let store = new FindingStore(dir);
  const s1 = scanRecord({ target: T, ts: '2026-07-01T00:00:00.000Z', findings: [{ ruleId: 'SEC-001', severity: 'high', page: T + '/p', value: 'v1' }] });
  const s2 = scanRecord({ target: T, ts: '2026-07-02T00:00:00.000Z', findings: [{ ruleId: 'SEC-001', severity: 'high', page: T + '/p', value: 'v1' }] });
  store.ingestScan(s1); store.ingestScan(s2, { prevScanRecord: s1 });
  const before = store.count();
  // simulate crash: partial temp + torn manifest tail + torn index tail
  fs.writeFileSync(path.join(store.storageDir, 'partial.json.tmp'), '{half');
  fs.appendFileSync(store.manifestPath, '{"recordId":"tor');
  fs.appendFileSync(store.indexPath('by-rule'), '{"key":"SEC-001","recordId":"tor');
  const rec = recover(store);
  ok(rec.actions.some(a => a.action === 'removed-partial-write'), 'recovery: removed partial write');
  ok(rec.actions.some(a => a.action === 'truncated-torn-manifest-tail'), 'recovery: truncated torn manifest tail');
  ok(rec.actions.some(a => a.action === 'rebuilt-indexes'), 'recovery: rebuilt indexes');
  ok(rec.verified, 'recovery: store verifies after recover');
  eq(rec.remaining.length, 0, 'recovery: no unrepairable issues remain');
  eq(store.count(), before, 'recovery: valid history preserved (count unchanged)');
  // restart: reopen fresh instance
  store = new FindingStore(dir);
  eq(store.count(), before, 'restart: reopened store sees all committed records');
  ok(verify(store).ok, 'restart: reopened store verifies ok');
})();

// ===========================================================================
// 7 · CONCURRENCY (parallel finding writes · interleaved scans · deterministic rebuild)
// ===========================================================================
(function concurrency() {
  const T = 'https://old.example.com';
  const dir = tmpDir('concur'); const store = new FindingStore(dir);
  // 20 distinct findings across one scan → parallel identities
  const findings = [];
  for (let i = 0; i < 20; i++) findings.push({ ruleId: 'SEC-00' + (i % 6 + 1), severity: i % 2 ? 'high' : 'medium', page: T + '/p' + i, value: 'v' + i });
  const s1 = scanRecord({ target: T, ts: '2026-07-01T00:00:00.000Z', findings });
  const s2 = scanRecord({ target: T, ts: '2026-07-02T00:00:00.000Z', findings });
  store.ingestScan(s1); store.ingestScan(s2, { prevScanRecord: s1 });
  eq(store.findings().length, 20, 'concurrency: 20 distinct findings tracked');
  ok(store.findings().every(f => f.state === 'CONFIRMED'), 'concurrency: all advanced OPEN→CONFIRMED');
  ok(verify(store).ok, 'concurrency: store consistent after interleaved scans');
  // deterministic rebuild
  const { INDEX_NAMES } = require('./store');
  const beforeIdx = INDEX_NAMES.map(n => fs.existsSync(store.indexPath(n)) ? fs.readFileSync(store.indexPath(n), 'utf8') : '');
  store.rebuildIndexes();
  const afterIdx = INDEX_NAMES.map(n => fs.existsSync(store.indexPath(n)) ? fs.readFileSync(store.indexPath(n), 'utf8') : '');
  ok(JSON.stringify(beforeIdx) === JSON.stringify(afterIdx), 'concurrency: index rebuild byte-identical');
})();

// ===========================================================================
// 8 · PERFORMANCE @ SCALE
// ===========================================================================
const perf = (function performance() {
  const N = Number(process.env.FINDINGSTORE_PERF_N || 2000);
  const T = 'https://old.example.com';
  const dir = tmpDir('perf'); const store = new FindingStore(dir);
  const hr = () => process.hrtime.bigint(); const ms = (a, b) => Number(b - a) / 1e6;
  // one finding per scan, chained across N scans (long lifecycle) + N distinct — use N distinct findings in one scan
  const findings = [];
  for (let i = 0; i < N; i++) findings.push({ ruleId: 'PERF-00' + (i % 6 + 1), severity: i % 2 ? 'high' : 'medium', page: T + '/p' + i, value: 'v' + i });
  const s1 = scanRecord({ target: T, ts: '2026-07-01T00:00:00.000Z', findings });

  let t0 = hr(); const ing = store.ingestScan(s1); const tIngest = ms(t0, hr());
  t0 = hr(); const q = store.byRule('PERF-001'); const tQuery = ms(t0, hr());
  t0 = hr(); const reb = store.rebuildIndexes(); const tRebuild = ms(t0, hr());
  t0 = hr(); const v = verify(store); const tVerify = ms(t0, hr());
  const fid = store.findings()[0].findingId;
  t0 = hr(); lineage(store, fid); const tLineage = ms(t0, hr());

  eq(store.findings().length, N, 'performance: all N findings tracked');
  ok(v.ok, 'performance: N-finding store verifies ok');
  return { N, records: ing.events.length, tIngest, tQuery, tRebuild, tVerify, tLineage, queryHits: q.length, rebuilt: reb.rebuilt };
})();

// ---- report ---------------------------------------------------------------
console.log('\nPerformance (N=' + perf.N + ' findings, ' + perf.records + ' records):');
console.log('  ingest scan     : ' + perf.tIngest.toFixed(1) + ' ms  (' + (perf.tIngest / perf.N).toFixed(3) + ' ms/finding)');
console.log('  by-rule query   : ' + perf.tQuery.toFixed(2) + ' ms  (' + perf.queryHits + ' findings)');
console.log('  rebuild indexes : ' + perf.tRebuild.toFixed(1) + ' ms  (' + perf.rebuilt + ' records)');
console.log('  verify (all)    : ' + perf.tVerify.toFixed(1) + ' ms');
console.log('  lineage (1)     : ' + perf.tLineage.toFixed(2) + ' ms');

console.log('\n' + (fail === 0 ? '✅ PASS' : '❌ FAIL') + ` — ${pass}/${pass + fail} assertions`);
if (fail) { console.log('Failures:\n' + failures.map(f => '  - ' + f).join('\n')); process.exit(1); }
