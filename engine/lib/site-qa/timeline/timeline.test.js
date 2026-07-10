'use strict';
// timeline.test.js — comprehensive, deterministic suite for WP-005 (Timeline Engine).
// Drives REAL WP-003 scan records + REAL WP-004 finding lifecycle, then builds the timeline over
// them. Covers: determinism · score series/deltas · lifecycle activity · open-findings-over-time ·
// milestones · streaks · trajectory · finding rollups · snapshot (content-address / reproducibility /
// tamper / restart / recovery) · frozen regression. No network/AI/clock deps (timestamps supplied).
const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');

const TL = require('./index');
const { buildTimeline, aggregate, TimelineStore, verify, reproduces, recover } = TL;
const SS = require('../scan-store');
const FDS = require('../finding-store');

let pass = 0, fail = 0; const failures = [];
function ok(c, n) { if (c) pass++; else { fail++; failures.push(n); console.log('  ✗ ' + n); } }
function eq(a, b, n) { ok(JSON.stringify(a) === JSON.stringify(b), n + (JSON.stringify(a) === JSON.stringify(b) ? '' : ` (got ${JSON.stringify(a)} want ${JSON.stringify(b)})`)); }

function result({ target = 'https://old.example.com', ts, overall, findings = [] }) {
  const checks = findings.map(f => ({
    status: f.severity === 'low' || f.severity === 'medium' ? 'warn' : 'fail',
    ruleId: f.ruleId, ruleSlug: (f.ruleId || '').toLowerCase(), suite: f.suite || 'security',
    severity: f.severity || 'high', deduction: 5, target: f.page || target, detail: f.value || (f.ruleId + ' finding'),
    items: [{ page: f.page || target, section: f.section || 'body', id: f.id || '', value: f.value || '' }],
  }));
  return { target, host: target, generated: ts, verdict: overall >= 80 ? 'ready' : 'not-ready', ready: overall >= 80,
    versions: { engine: '2.1.0', registry: '1.1.0', report: '1.1.0' }, quality: { overall, suites: { security: overall, seo: overall } },
    tally: {}, suites: [{ key: 'audit', checks }], crawl: { maxPages: 20 } };
}

function tmpDir(tag) {
  const dir = path.join(os.tmpdir(), 'timeline-test', 'run-' + tag + '-' + (pass + fail));
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Seed both stores with a 5-scan story: findings appear, resolve, site goes clean, then a reopen.
function seed(tag) {
  const root = tmpDir(tag);
  const scanStore = new SS.ScanStore(path.join(root, 'scans'));
  const findingStore = new FDS.FindingStore(path.join(root, 'findings'));
  const T = 'https://old.example.com';
  const SEC = v => ({ ruleId: 'SEC-001', suite: 'security', severity: 'high', page: T + '/a', value: v });
  const SEO = v => ({ ruleId: 'SEO-001', suite: 'seo', severity: 'medium', page: T + '/b', value: v });
  const scans = [
    result({ ts: '2026-07-01T00:00:00.000Z', overall: 70, findings: [SEC('v1'), SEO('v1')] }),
    result({ ts: '2026-07-02T00:00:00.000Z', overall: 75, findings: [SEC('v1'), SEO('v1')] }),
    result({ ts: '2026-07-03T00:00:00.000Z', overall: 85, findings: [SEC('v1')] }),           // SEO resolved
    result({ ts: '2026-07-04T00:00:00.000Z', overall: 100, findings: [] }),                    // clean
    result({ ts: '2026-07-05T00:00:00.000Z', overall: 90, findings: [SEO('v1')] }),            // SEO reopened
  ];
  let prevRec = null;
  for (const r of scans) {
    const { scanId } = scanStore.save(r);
    const rec = scanStore.get(scanId);
    findingStore.ingestScan(rec, { prevScanRecord: prevRec });
    prevRec = rec;
  }
  return { root, scanStore, findingStore, T };
}

console.log('WP-005 — Timeline Engine — test suite\n');

// ===========================================================================
// 1 · DETERMINISM + SERIES + DELTAS
// ===========================================================================
(function seriesDeltas() {
  const { scanStore, findingStore, T } = seed('series');
  const t1 = buildTimeline(scanStore, T, { findingStore });
  const t2 = buildTimeline(scanStore, T, { findingStore });
  eq(t1, t2, 'determinism: buildTimeline twice → identical');
  eq(t1.scanCount, 5, 'series: 5 scan points');
  eq(t1.points.map(p => p.overall), [70, 75, 85, 100, 90], 'series: overall score sequence');
  eq(t1.points[0].delta, null, 'series: first point has no delta');
  eq(t1.points[1].delta.overall, 5, 'series: delta +5');
  eq(t1.points[1].delta.classification, 'improvement', 'series: classified improvement');
  eq(t1.points[4].delta.overall, -10, 'series: regression delta -10');
  eq(t1.points[2].delta.resolved, 1, 'series: SEO resolved counted in scan3 delta');
})();

// ===========================================================================
// 2 · LIFECYCLE ACTIVITY + OPEN-FINDINGS-OVER-TIME
// ===========================================================================
(function lifecycleOpen() {
  const { scanStore, findingStore, T } = seed('open');
  const t = buildTimeline(scanStore, T, { findingStore });
  eq(t.points.map(p => p.openFindings), [2, 2, 1, 0, 1], 'open-over-time: [2,2,1,0,1] across appear/resolve/clean/reopen');
  eq(t.points[0].lifecycle, { OPEN: 2 }, 'lifecycle: scan1 opened 2');
  eq(t.points[1].lifecycle, { CONFIRMED: 2 }, 'lifecycle: scan2 confirmed 2');
  // scan3: SEC confirmed→active (1 ACTIVE) + SEO resolved via CONFIRMED→ACTIVE→RESOLVED (1 ACTIVE +1 RESOLVED)
  eq(t.points[2].lifecycle, { ACTIVE: 2, RESOLVED: 1 }, 'lifecycle: scan3 activity');
  eq(t.points[3].lifecycle, { RESOLVED: 1 }, 'lifecycle: scan4 resolved SEC');
  eq(t.points[4].lifecycle, { REOPENED: 1 }, 'lifecycle: scan5 reopened SEO');
  // without a finding store, lifecycle/open are null but scores still build
  const bare = buildTimeline(scanStore, T);
  eq(bare.points[0].openFindings, null, 'timeline: builds without finding store (open=null)');
  eq(bare.points.map(p => p.overall), [70, 75, 85, 100, 90], 'timeline: scores present without finding store');
})();

// ===========================================================================
// 3 · MILESTONES + STREAKS + TRAJECTORY + ROLLUPS
// ===========================================================================
(function aggregates() {
  const { scanStore, findingStore, T } = seed('agg');
  const t = buildTimeline(scanStore, T, { findingStore });
  const a = aggregate(t, findingStore);
  eq(a.milestones.best.overall, 100, 'milestones: best score 100');
  eq(a.milestones.worst.overall, 70, 'milestones: worst score 70');
  eq(a.milestones.firstClean.index, 3, 'milestones: first clean scan at index 3');
  eq(a.trajectory, { start: 70, end: 90, net: 20, min: 70, max: 100 }, 'trajectory: start/end/net/min/max');
  eq(a.streaks.regressingTrailing, 1, 'streaks: 1 trailing regressing scan');
  eq(a.streaks.longestCleanRun, 1, 'streaks: longest clean run 1');
  eq(a.findings.mostReopened.ruleId, 'SEO-001', 'rollups: most-reopened is SEO-001');
  eq(a.findings.mostReopened.reopens, 1, 'rollups: reopen count 1');
  ok(a.findings.longestOpen && a.findings.longestOpen.ruleId === 'SEO-001', 'rollups: longest-open is SEO-001 (spans to reopen)');
})();

// ===========================================================================
// 4 · SNAPSHOT — content-address, reproducibility, tamper, duplicate, restart, recovery
// ===========================================================================
(function snapshots() {
  const { root, scanStore, findingStore, T } = seed('snap');
  const store = new TimelineStore(path.join(root, 'timelines'));
  const s1 = store.save(scanStore, findingStore, T, { generatedAt: '2026-07-05T12:00:00.000Z' });
  ok(!s1.duplicate, 'snapshot: first save committed');
  const s2 = store.save(scanStore, findingStore, T, { generatedAt: '2026-07-05T12:00:00.000Z' });
  ok(s2.duplicate, 'snapshot: identical materialization → duplicate (content+time addressed)');
  ok(verify(store).ok, 'snapshot: store verifies ok');
  // reproducibility: rebuild from source stores matches
  const rep = reproduces(store, s1.snapshotId, scanStore, findingStore);
  ok(rep.ok && !rep.drift, 'snapshot: reproduces from live stores (no drift)');
  // tamper → digest-mismatch
  const rec = store.get(s1.snapshotId); rec.points[0].overall = 0; fs.writeFileSync(store.recordPath(s1.snapshotId), JSON.stringify(rec, null, 2));
  ok(verify(store).issues.some(i => i.type === 'digest-mismatch'), 'snapshot: tampered snapshot → digest-mismatch');
  // drift: add a new scan to the source, old snapshot no longer reproduces
  const { root: r2, scanStore: ss2, findingStore: fs2, T: T2 } = seed('drift');
  const dstore = new TimelineStore(path.join(r2, 'timelines'));
  const d1 = dstore.save(ss2, fs2, T2, { generatedAt: '2026-07-05T12:00:00.000Z' });
  const { scanId } = ss2.save(result({ ts: '2026-07-06T00:00:00.000Z', overall: 95, findings: [] }));
  fs2.ingestScan(ss2.get(scanId), { prevScanRecord: null });
  const drift = reproduces(dstore, d1.snapshotId, ss2, fs2);
  ok(drift.drift, 'snapshot: source changed → reproducibility drift detected');
  // partial write recovery + restart
  fs.writeFileSync(path.join(dstore.storageDir, 'zzz.json.tmp'), '{half');
  const rec2 = recover(dstore);
  ok(rec2.actions.some(a => a.action === 'removed-partial-write') && rec2.verified, 'snapshot: recovery removes partial write + verifies');
  const reopened = new TimelineStore(path.join(r2, 'timelines'));
  eq(reopened.count(), dstore.count(), 'snapshot: restart sees committed snapshots');
})();

// ===========================================================================
// 5 · EMPTY / EDGE
// ===========================================================================
(function edge() {
  const root = tmpDir('edge');
  const scanStore = new SS.ScanStore(path.join(root, 'scans'));
  const t = buildTimeline(scanStore, 'https://never-scanned.example.com', {});
  eq(t.scanCount, 0, 'edge: empty timeline for unscanned target');
  eq(t.points, [], 'edge: no points');
  const a = aggregate(t, null);
  eq(a.milestones.best, null, 'edge: milestones null on empty');
})();

// ===========================================================================
// 6 · FROZEN REGRESSION (WP-003 + WP-004 unchanged)
// ===========================================================================
(function regression() {
  const dir = __dirname + '/..';
  const env = Object.assign({}, process.env, { SCANSTORE_PERF_N: process.env.SCANSTORE_PERF_N || '200', FINDINGSTORE_PERF_N: process.env.FINDINGSTORE_PERF_N || '200' });
  let scanOk = false, findOk = false;
  try { const o = cp.execSync('node scan-store/scan-store.test.js', { cwd: dir, env }).toString(); scanOk = /PASS/.test(o) && /56\/56/.test(o); } catch (_) {}
  try { const o = cp.execSync('node finding-store/finding-store.test.js', { cwd: dir, env }).toString(); findOk = /PASS/.test(o) && /60\/60/.test(o); } catch (_) {}
  ok(scanOk, 'regression: WP-003 scan-store 56/56 still green');
  ok(findOk, 'regression: WP-004 finding-store 60/60 still green');
})();

console.log('\n' + (fail === 0 ? '✅ PASS' : '❌ FAIL') + ` — ${pass}/${pass + fail} assertions`);
if (fail) { console.log('Failures:\n' + failures.map(f => '  - ' + f).join('\n')); process.exit(1); }
