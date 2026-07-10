'use strict';
// reporting.test.js — deterministic suite for the Reporting-depth pillar. Drives real WP-003/004/005
// stores, builds a timeline, renders the exec summary (text + self-contained HTML) and a scan diff.
const fs = require('fs');
const path = require('path');
const os = require('os');
const RPT = require('./index');
const SS = require('../scan-store');
const FDS = require('../finding-store');
const TL = require('../timeline');
const RG = require('../regression');

let pass = 0, fail = 0; const failures = [];
function ok(c, n) { if (c) pass++; else { fail++; failures.push(n); console.log('  ✗ ' + n); } }
function eq(a, b, n) { ok(JSON.stringify(a) === JSON.stringify(b), n); }
function tmp(t) { return fs.mkdtempSync(path.join(os.tmpdir(), 'rpt-' + t + '-')); }

const T = 'https://old.example.com';
function result(ts, overall, findings) {
  const checks = findings.map(f => ({ status: 'fail', ruleId: f.ruleId, ruleSlug: (f.ruleId || '').toLowerCase(), suite: f.suite || 'security', severity: f.severity || 'high', deduction: 5, target: f.page || T, detail: 'd', items: [{ page: f.page || T, section: 'body', id: '', value: f.value || 'v' }] }));
  return { target: T, host: T, generated: ts, verdict: 'ready', ready: true, versions: { engine: '2.1.0', registry: '1.2.0', report: '1.1.0' }, quality: { overall, suites: { security: overall } }, tally: {}, suites: [{ key: 'audit', checks }], crawl: {} };
}

console.log('Reporting depth (exec summary + diff) — test suite\n');

const root = tmp('stores');
const scanStore = new SS.ScanStore(path.join(root, 'scans'));
const findingStore = new FDS.FindingStore(path.join(root, 'findings'));
let prev = null; const ids = [];
for (const [ts, sc, f] of [
  ['2026-07-01T00:00:00.000Z', 70, [{ ruleId: 'SEC-001', page: T + '/a' }, { ruleId: 'SEO-001', severity: 'medium', page: T + '/b' }]],
  ['2026-07-02T00:00:00.000Z', 85, [{ ruleId: 'SEC-001', page: T + '/a' }]],
  ['2026-07-03T00:00:00.000Z', 100, []],
]) {
  const { scanId } = scanStore.save(result(ts, sc, f)); const rec = scanStore.get(scanId); ids.push(scanId);
  findingStore.ingestScan(rec, { prevScanRecord: prev }); prev = rec;
}

const timeline = TL.buildTimeline(scanStore, T, { findingStore });
const aggregate = TL.aggregate(timeline, findingStore);
const regression = RG.buildRegression(scanStore, findingStore, { baselineScanId: ids[0], candidateScanId: ids[2] });

// ---- exec summary ----
const s1 = RPT.execSummary({ target: T, timeline, aggregate, regression });
const s2 = RPT.execSummary({ target: T, timeline, aggregate, regression });
eq(s1, s2, 'summary: deterministic structured summary');
eq(s1.currentScore, 100, 'summary: current score = latest');
eq(s1.scanCount, 3, 'summary: scan count');
eq(s1.trajectory.net, 30, 'summary: trajectory net +30');
ok(s1.firstClean && s1.firstClean.overall === 100, 'summary: first clean captured');
ok(/quality 100\/100/.test(s1.headline), 'summary: headline reads current quality');
ok(s1.regression && s1.regression.verdict === 'PASS', 'summary: regression verdict embedded (resolved+score up = PASS)');

// ---- text render ----
const txt = RPT.renderText(s1);
ok(/EXECUTIVE SUMMARY/.test(txt) && /Current quality score: 100/.test(txt), 'text: renders headline metrics');
eq(RPT.renderText(s1), txt, 'text: deterministic');

// ---- HTML render (self-contained, escaped) ----
const html = RPT.renderHTML(s1);
ok(/<section class="exec-summary">/.test(html) && /<style>/.test(html), 'html: self-contained (inline style, no external refs)');
ok(!/https?:\/\/[^"'\s]*\.(css|js)/.test(html), 'html: no external stylesheet/script references');
ok(/PASS/.test(html), 'html: verdict badge rendered');
// escaping
const evil = RPT.renderHTML(RPT.execSummary({ target: '<script>x</script>', timeline: { points: [], scanCount: 0, span: null }, aggregate: { milestones: {}, streaks: {}, trajectory: null, findings: null } }));
ok(!/<script>x<\/script>/.test(evil) && /&lt;script&gt;/.test(evil), 'html: escapes untrusted target');

// ---- scan diff render ----
const diff = SS.diffRecords(scanStore.get(ids[0]), scanStore.get(ids[2]));
const dtxt = RPT.renderScanDiffText(diff);
ok(/SCAN DIFF/.test(dtxt) && /Resolved: 2/.test(dtxt), 'diff: renders resolved count (2 findings cleared)');
eq(RPT.renderScanDiffText(diff), dtxt, 'diff: deterministic');

console.log('\n' + (fail === 0 ? '✅ PASS' : '❌ FAIL') + ` — ${pass}/${pass + fail} assertions`);
if (fail) { console.log('Failures:\n' + failures.map(f => '  - ' + f).join('\n')); process.exit(1); }
