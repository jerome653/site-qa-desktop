'use strict';
// regression.test.js — comprehensive, deterministic suite for WP-006 (Regression Engine).
// Drives REAL WP-003 scans + WP-004 finding lifecycle, then gates candidates against baselines.
// Covers: policy verdicts (PASS/WARN/FAIL across new-finding/score-drop/escalation/reopen) ·
// determinism · baseline store (set/current/history) · verdict store (content-address / reproducibility
// / tamper / restart / recovery) · custom policy · frozen regression. No network/AI/clock deps.
const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');

const RG = require('./index');
const { buildRegression, RegressionStore, BaselineStore, gateAgainstBaseline, DEFAULT_POLICY, verify, reproduces, recover } = RG;
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
    versions: { engine: '2.1.0', registry: '1.1.0', report: '1.1.0' }, quality: { overall, suites: { security: overall } },
    tally: {}, suites: [{ key: 'audit', checks }], crawl: { maxPages: 20 } };
}
function tmpDir(tag) { const d = path.join(os.tmpdir(), 'regression-test', 'run-' + tag + '-' + (pass + fail)); if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }); return d; }
function stores(tag) { const root = tmpDir(tag); return { root, scanStore: new SS.ScanStore(path.join(root, 'scans')), findingStore: new FDS.FindingStore(path.join(root, 'findings')) }; }
function save(scanStore, r) { return scanStore.get(scanStore.save(r).scanId); }

const T = 'https://old.example.com';
const SEC = (sev, v) => ({ ruleId: 'SEC-001', suite: 'security', severity: sev, page: T + '/a', value: v || 'v1' });

console.log('WP-006 — Regression Engine — test suite\n');

// ===========================================================================
// 1 · POLICY VERDICTS
// ===========================================================================
(function verdicts() {
  // PASS — resolved finding, score up
  let { scanStore, findingStore } = stores('pass');
  let b = save(scanStore, result({ ts: '2026-07-01T00:00:00.000Z', overall: 85, findings: [SEC('high')] }));
  findingStore.ingestScan(b);
  let c = save(scanStore, result({ ts: '2026-07-02T00:00:00.000Z', overall: 100, findings: [] }));
  let r = buildRegression(scanStore, findingStore, { baselineScanId: b.scanId, candidateScanId: c.scanId });
  eq(r.verdict, 'PASS', 'policy: resolved + score up → PASS');
  eq(r.diff.counts.resolved, 1, 'policy: resolved counted');

  // FAIL — new high finding
  ({ scanStore, findingStore } = stores('failnew'));
  b = save(scanStore, result({ ts: '2026-07-01T00:00:00.000Z', overall: 85, findings: [SEC('high')] }));
  findingStore.ingestScan(b);
  c = save(scanStore, result({ ts: '2026-07-02T00:00:00.000Z', overall: 80, findings: [SEC('high'), { ruleId: 'SEC-002', suite: 'security', severity: 'high', page: T + '/b', value: 'x' }] }));
  r = buildRegression(scanStore, findingStore, { baselineScanId: b.scanId, candidateScanId: c.scanId });
  eq(r.verdict, 'FAIL', 'policy: new high finding → FAIL');
  ok(r.violations.some(v => v.rule === 'new-finding' && v.effect === 'FAIL'), 'policy: new-finding FAIL violation recorded');

  // WARN — new low finding + tiny score drop
  ({ scanStore, findingStore } = stores('warn'));
  b = save(scanStore, result({ ts: '2026-07-01T00:00:00.000Z', overall: 85, findings: [SEC('high')] }));
  findingStore.ingestScan(b);
  c = save(scanStore, result({ ts: '2026-07-02T00:00:00.000Z', overall: 84, findings: [SEC('high'), { ruleId: 'SEO-009', suite: 'seo', severity: 'low', page: T + '/c', value: 'y' }] }));
  r = buildRegression(scanStore, findingStore, { baselineScanId: b.scanId, candidateScanId: c.scanId });
  eq(r.verdict, 'WARN', 'policy: new low + minor drop → WARN');
  ok(!r.violations.some(v => v.effect === 'FAIL'), 'policy: no FAIL in WARN verdict');

  // FAIL — big score drop only
  ({ scanStore, findingStore } = stores('drop'));
  b = save(scanStore, result({ ts: '2026-07-01T00:00:00.000Z', overall: 85, findings: [SEC('high')] }));
  findingStore.ingestScan(b);
  c = save(scanStore, result({ ts: '2026-07-02T00:00:00.000Z', overall: 70, findings: [SEC('high')] }));
  r = buildRegression(scanStore, findingStore, { baselineScanId: b.scanId, candidateScanId: c.scanId });
  eq(r.verdict, 'FAIL', 'policy: score drop ≥10 → FAIL');
  eq(r.scoreDelta, -15, 'policy: score delta -15');

  // FAIL — severity escalation medium→critical
  ({ scanStore, findingStore } = stores('escalate'));
  b = save(scanStore, result({ ts: '2026-07-01T00:00:00.000Z', overall: 85, findings: [SEC('medium')] }));
  findingStore.ingestScan(b);
  c = save(scanStore, result({ ts: '2026-07-02T00:00:00.000Z', overall: 85, findings: [SEC('critical')] }));
  r = buildRegression(scanStore, findingStore, { baselineScanId: b.scanId, candidateScanId: c.scanId });
  eq(r.verdict, 'FAIL', 'policy: severity escalation to critical → FAIL');
  ok(r.violations.some(v => v.rule === 'severity-escalation'), 'policy: escalation violation recorded');

  // FAIL — reopened finding (store shows it was RESOLVED)
  ({ scanStore, findingStore } = stores('reopen'));
  const s1 = save(scanStore, result({ ts: '2026-07-01T00:00:00.000Z', overall: 80, findings: [SEC('high')] }));
  const s2 = save(scanStore, result({ ts: '2026-07-02T00:00:00.000Z', overall: 80, findings: [SEC('high')] }));
  const s3 = save(scanStore, result({ ts: '2026-07-03T00:00:00.000Z', overall: 100, findings: [] })); // clean → SEC resolved
  findingStore.ingestScan(s1);
  findingStore.ingestScan(s2, { prevScanRecord: s1 });
  findingStore.ingestScan(s3, { prevScanRecord: s2 }); // SEC-001 now RESOLVED in store
  const s4 = save(scanStore, result({ ts: '2026-07-04T00:00:00.000Z', overall: 90, findings: [SEC('high')] })); // reappears
  r = buildRegression(scanStore, findingStore, { baselineScanId: s3.scanId, candidateScanId: s4.scanId });
  eq(r.diff.counts.reopened, 1, 'policy: reopened detected via store state');
  eq(r.verdict, 'FAIL', 'policy: reopened finding → FAIL');
})();

// ===========================================================================
// 2 · DETERMINISM
// ===========================================================================
(function determinism() {
  const { scanStore, findingStore } = stores('det');
  const b = save(scanStore, result({ ts: '2026-07-01T00:00:00.000Z', overall: 85, findings: [SEC('high')] }));
  findingStore.ingestScan(b);
  const c = save(scanStore, result({ ts: '2026-07-02T00:00:00.000Z', overall: 80, findings: [SEC('high'), { ruleId: 'SEC-002', severity: 'high', page: T + '/b', value: 'x' }] }));
  const r1 = buildRegression(scanStore, findingStore, { baselineScanId: b.scanId, candidateScanId: c.scanId, generatedAt: '2026-07-02T09:00:00.000Z' });
  const r2 = buildRegression(scanStore, findingStore, { baselineScanId: b.scanId, candidateScanId: c.scanId, generatedAt: '2026-07-02T09:00:00.000Z' });
  eq(r1, r2, 'determinism: identical inputs → identical verdict record');
})();

// ===========================================================================
// 3 · BASELINE STORE
// ===========================================================================
(function baselines() {
  const { root, scanStore } = stores('base');
  const bstore = new BaselineStore(path.join(root, 'baselines'));
  const s1 = save(scanStore, result({ ts: '2026-07-01T00:00:00.000Z', overall: 85, findings: [SEC('high')] }));
  const s2 = save(scanStore, result({ ts: '2026-07-05T00:00:00.000Z', overall: 95, findings: [] }));
  eq(bstore.current(T), null, 'baseline: none set → null');
  bstore.set(s1, { setAt: '2026-07-01T10:00:00.000Z', reason: 'first good' });
  eq(bstore.current(T).scanId, s1.scanId, 'baseline: current after set');
  bstore.set(s2, { setAt: '2026-07-05T10:00:00.000Z', reason: 're-baseline' });
  eq(bstore.current(T).scanId, s2.scanId, 'baseline: re-baseline → latest wins (append-only)');
  eq(bstore.history(T).length, 2, 'baseline: history preserves both pointers');
  // gate against current baseline
  const { scanStore: ss2, findingStore } = stores('gate');
  const gb = save(ss2, result({ ts: '2026-07-01T00:00:00.000Z', overall: 90, findings: [] }));
  findingStore.ingestScan(gb);
  const gbstore = new BaselineStore(path.join(root, 'gate-baselines'));
  gbstore.set(gb, { setAt: '2026-07-01T10:00:00.000Z' });
  const cand = save(ss2, result({ ts: '2026-07-02T00:00:00.000Z', overall: 90, findings: [SEC('critical')] }));
  const gr = gateAgainstBaseline(ss2, findingStore, gbstore, T, cand.scanId);
  eq(gr.verdict, 'FAIL', 'baseline: gateAgainstBaseline uses current baseline → new critical FAIL');
})();

// ===========================================================================
// 4 · VERDICT STORE — content-address, reproducibility, tamper, restart, recovery, queries
// ===========================================================================
(function verdictStore() {
  const { root, scanStore, findingStore } = stores('vstore');
  const b = save(scanStore, result({ ts: '2026-07-01T00:00:00.000Z', overall: 85, findings: [SEC('high')] }));
  findingStore.ingestScan(b);
  const c = save(scanStore, result({ ts: '2026-07-02T00:00:00.000Z', overall: 80, findings: [SEC('high'), { ruleId: 'SEC-002', severity: 'high', page: T + '/b', value: 'x' }] }));
  const store = new RegressionStore(path.join(root, 'verdicts'));
  const v1 = store.save(scanStore, findingStore, { baselineScanId: b.scanId, candidateScanId: c.scanId, generatedAt: '2026-07-02T09:00:00.000Z' });
  eq(v1.verdict, 'FAIL', 'vstore: verdict persisted');
  const v2 = store.save(scanStore, findingStore, { baselineScanId: b.scanId, candidateScanId: c.scanId, generatedAt: '2026-07-02T09:00:00.000Z' });
  ok(v2.duplicate, 'vstore: identical gate → duplicate (content+time addressed)');
  ok(verify(store).ok, 'vstore: verifies ok');
  ok(store.byVerdict('FAIL').length === 1, 'vstore: byVerdict query');
  // reproducibility
  const rep = reproduces(store, v1.recordId, scanStore, findingStore);
  ok(rep.ok && !rep.drift, 'vstore: verdict reproduces from live stores');
  // tamper — flip the verdict
  const rec = store.get(v1.recordId); rec.verdict = 'PASS'; fs.writeFileSync(store.recordPath(v1.recordId), JSON.stringify(rec, null, 2));
  ok(verify(store).issues.some(i => i.type === 'digest-mismatch'), 'vstore: tampered verdict → digest-mismatch');
  const rep2 = reproduces(store, v1.recordId, scanStore, findingStore);
  ok(rep2.storedVerdict === 'PASS' && rep2.rebuiltVerdict === 'FAIL', 'vstore: reproduction exposes forged verdict (PASS≠FAIL)');
  // recovery + restart
  fs.writeFileSync(path.join(store.storageDir, 'zzz.json.tmp'), '{half');
  const rc = recover(store);
  ok(rc.actions.some(a => a.action === 'removed-partial-write'), 'vstore: recovery removes partial write');
  const reopened = new RegressionStore(path.join(root, 'verdicts'));
  eq(reopened.count(), store.count(), 'vstore: restart sees committed verdicts');
})();

// ===========================================================================
// 5 · CUSTOM POLICY (stored full → reproduces)
// ===========================================================================
(function customPolicy() {
  const { scanStore, findingStore } = stores('custom');
  const b = save(scanStore, result({ ts: '2026-07-01T00:00:00.000Z', overall: 85, findings: [SEC('high')] }));
  findingStore.ingestScan(b);
  const c = save(scanStore, result({ ts: '2026-07-02T00:00:00.000Z', overall: 84, findings: [SEC('high'), { ruleId: 'SEO-009', severity: 'low', page: T + '/c', value: 'y' }] }));
  // strict policy: even a new low fails
  const strict = { name: 'strict', version: '1.0.0', failOnNewSeverities: ['critical', 'high', 'medium', 'low'] };
  const r = buildRegression(scanStore, findingStore, { baselineScanId: b.scanId, candidateScanId: c.scanId, policy: strict, generatedAt: '2026-07-02T09:00:00.000Z' });
  eq(r.verdict, 'FAIL', 'custom-policy: strict policy fails on new low');
  ok(r.policy.failOnNewSeverities.includes('low') && r.policy.warnScoreDropAtLeast === 1, 'custom-policy: full resolved policy stored (defaults merged)');
})();

// ===========================================================================
// 6 · FROZEN REGRESSION (WP-003 + WP-004 + WP-005 unchanged)
// ===========================================================================
(function frozen() {
  const dir = __dirname + '/..';
  const env = Object.assign({}, process.env, { SCANSTORE_PERF_N: '200', FINDINGSTORE_PERF_N: '200' });
  const run = (cmd, needle) => { try { return needle.test(cp.execSync(cmd, { cwd: dir, env }).toString()); } catch (_) { return false; } };
  ok(run('node scan-store/scan-store.test.js', /56\/56/), 'frozen: WP-003 scan-store 56/56 green');
  ok(run('node finding-store/finding-store.test.js', /60\/60/), 'frozen: WP-004 finding-store 60/60 green');
  ok(run('node timeline/timeline.test.js', /38\/38/), 'frozen: WP-005 timeline 38/38 green');
})();

console.log('\n' + (fail === 0 ? '✅ PASS' : '❌ FAIL') + ` — ${pass}/${pass + fail} assertions`);
if (fail) { console.log('Failures:\n' + failures.map(f => '  - ' + f).join('\n')); process.exit(1); }
