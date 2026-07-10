'use strict';
// benchmark.js — measured (not estimated) performance of the immutable stores at scale. Deterministic
// workload (supplied timestamps), built-in timing only. Records throughput for the operations that
// matter operationally: scan save, finding ingest, indexed query, integrity verify, index rebuild,
// diff, timeline build, regression gate.
//
//   node testing/benchmark.js            # default scale
//   node testing/benchmark.js 20000      # custom N
const fs = require('fs');
const path = require('path');
const os = require('os');
const SS = require('../scan-store');
const FDS = require('../finding-store');
const TL = require('../timeline');
const RG = require('../regression');

const N = Number(process.argv[2] || process.env.BENCH_N || 10000);
const T = 'https://old.example.com';
const hr = () => process.hrtime.bigint();
const ms = (a, b) => Number(b - a) / 1e6;

function tmp(tag) { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'auditor-bench-' + tag + '-')); return d; }
function isoAt(i) { // deterministic distinct timestamps (no clock)
  const s = i % 60, m = Math.floor(i / 60) % 60, h = Math.floor(i / 3600) % 24, day = 1 + (Math.floor(i / 86400) % 27);
  return `2026-07-${String(day).padStart(2, '0')}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(i % 1000).padStart(3, '0')}Z`;
}
function result(ts, i) {
  return { target: T, host: T, generated: ts, verdict: 'ready', ready: true,
    versions: { engine: '2.1.0', registry: '1.2.0', report: '1.1.0' }, quality: { overall: 80 + (i % 20), suites: { security: 80 } }, tally: {},
    suites: [{ key: 'audit', checks: [{ status: 'fail', ruleId: 'SEC-001', ruleSlug: 'tls-expired', suite: 'security', severity: 'high', deduction: 18, target: T + '/p' + (i % 500), detail: 'd' + i, items: [{ page: T + '/p' + (i % 500), section: 'body', id: '', value: 'v' + i }] }] }], crawl: { maxPages: 20 } };
}

const rows = [];
function bench(name, unit, count, fn) { const a = hr(); const r = fn(); const t = ms(a, hr()); rows.push({ name, t, perOp: t / count, count, unit }); return r; }

console.log(`SGEN Site Auditor — performance benchmark (N=${N})\n`);

// Scan store
const scanStore = new SS.ScanStore(tmp('scans'));
let firstId = null, lastId = null;
bench('scan-store: save', 'scan', N, () => { for (let i = 0; i < N; i++) { const s = scanStore.save(result(isoAt(i), i)); if (i === 0) firstId = s.scanId; lastId = s.scanId; } });
bench('scan-store: byRule query', 'query', 1, () => scanStore.byRule('SEC-001'));
bench('scan-store: verify (all)', 'scan', N, () => SS.verify(scanStore));
bench('scan-store: rebuild indexes', 'scan', N, () => scanStore.rebuildIndexes());
bench('scan-store: diff first↔last', 'diff', 1, () => SS.diffRecords(scanStore.get(firstId), scanStore.get(lastId)));

// Finding store (ingest a single large scan of M distinct findings)
const M = Math.min(N, 10000);
const findingStore = new FDS.FindingStore(tmp('findings'));
const bigChecks = [];
for (let i = 0; i < M; i++) bigChecks.push({ status: 'fail', ruleId: 'SEC-00' + (i % 6 + 1), suite: 'security', severity: i % 2 ? 'high' : 'medium', deduction: 5, target: T + '/f' + i, detail: 'd', items: [{ page: T + '/f' + i, section: 'body', id: '', value: 'v' + i }] });
const bigResult = { target: T, host: T, generated: isoAt(0), verdict: 'ready', ready: true, versions: { engine: '2.1.0', registry: '1.2.0', report: '1.1.0' }, quality: { overall: 80, suites: {} }, tally: {}, suites: [{ key: 'audit', checks: bigChecks }], crawl: {} };
const bigScanId = scanStore.save(bigResult).scanId; const bigRec = scanStore.get(bigScanId);
bench('finding-store: ingest', 'finding', M, () => findingStore.ingestScan(bigRec));
bench('finding-store: verify (all)', 'finding', M, () => FDS.verify(findingStore));
bench('finding-store: rebuild indexes', 'finding', M, () => findingStore.rebuildIndexes());

// Timeline over the first store (N scans, one target)
bench('timeline: build', 'scan', N, () => TL.buildTimeline(scanStore, T));

// Regression gate (baseline vs candidate)
bench('regression: gate', 'gate', 1, () => RG.buildRegression(scanStore, findingStore, { baselineScanId: firstId, candidateScanId: lastId }));

// ---- report ----
console.log('  operation'.padEnd(34) + 'total(ms)'.padStart(12) + 'per-op'.padStart(14));
for (const r of rows) {
  const per = r.count > 1 ? (r.perOp < 1 ? (r.perOp * 1000).toFixed(1) + ' µs/' + r.unit : r.perOp.toFixed(3) + ' ms/' + r.unit) : r.t.toFixed(2) + ' ms';
  console.log('  ' + r.name.padEnd(32) + r.t.toFixed(1).padStart(12) + per.padStart(14));
}
console.log('\n✅ benchmark complete — ' + N + ' scans, ' + M + ' findings, all operations measured');
