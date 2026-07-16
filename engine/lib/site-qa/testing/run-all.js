'use strict';
// run-all.js — the single command that runs every auditor test suite and aggregates the result.
// Deterministic discovery (sorted), bounded perf N so the full run stays fast, non-zero exit on any
// failure. This is the Testing pillar's gate: "all suites green" is provable in one command.
//
//   node testing/run-all.js
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..');
// Explicit, ordered suite list (foundation → history → advisory → self). Explicit beats globbing:
// the run fails loudly if a known suite file goes missing, instead of silently covering less.
const SUITES = [
  'rules/registry.test.js',
  'evidence-name.test.js',
  'consent.test.js',
  'blocking-overlay.test.js',
  'contract.test.js',
  'readiness.test.js',
  'font-checks.test.js',
  'pass-label-reachability.test.js',
  // The render pass must never report a check it did not run as a check that passed. Real Chromium +
  // the real stored sgen.com runs — it re-derives the cost of axe-core's silence (a11y 66 vs an honest
  // 59) from report.json through the real scorer, so a fixture cannot agree with the bug.
  '../migration-qa/render-honesty.test.js',
  'score-evaluation.test.js',
  // "I looked and it is clean" vs "I never looked". Drives the REAL runAudit against a real
  // non-resolving host (37 green ticks, quality 98, before the fix) and through a REAL poisoned
  // module in the require cache, so no fixture can agree with the bug.
  'evaluation-ledger.test.js',
  // annotate.test.js (66 assertions) shipped in 3.0.0 but was left out of this list purely because
  // an earlier instruction pinned the suite count at 25 — a test that never runs is not a test.
  'annotate.test.js',
  'lib/infra.test.js',
  'lib/providers.test.js',
  'lib/interaction.test.js',
  'lib/security.test.js',
  'lib/seo.test.js',
  'lib/stability.test.js',
  'lib/lenses.test.js',
  'testing/foundation.test.js',
  // Boots the real server and parses the client script it SERVES. The dashboard is ~66 KB of JS
  // inside a template literal, so `node --check` passes while the emitted script is unparseable and
  // every tool on the page is dead. Nothing else in this list can see that.
  'testing/ui-script.test.js',
  'scan-store/scan-store.test.js',
  'finding-store/finding-store.test.js',
  'timeline/timeline.test.js',
  'regression/regression.test.js',
  'best-practices/best-practices.test.js',
  'content-artifacts/content-artifacts.test.js',
  'spelling/spelling.test.js',
  'copy-review/copy-review.test.js',
  'ops/ops.test.js',
  'reporting/reporting.test.js',
  'inventory/inventory.test.js',
  'inventory/qualification.js',
  'pipeline.test.js',
];

const env = Object.assign({}, process.env, {
  SCANSTORE_PERF_N: process.env.SCANSTORE_PERF_N || '300',
  FINDINGSTORE_PERF_N: process.env.FINDINGSTORE_PERF_N || '300',
});

function extractCount(out) {
  const m = out.match(/(\d+)\/(\d+)\s+assertions/) || out.match(/PASS · (\d+) rules/) || (/QUALIFIED/.test(out) ? ['qualified'] : null);
  return m ? m[0] : '';
}

console.log('SGEN Site Auditor — full test run\n');
let allOk = true;
const rows = [];
for (const rel of SUITES) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) { console.log('  ✗ MISSING ' + rel); allOk = false; rows.push({ rel, ok: false, note: 'missing' }); continue; }
  const t0 = process.hrtime.bigint();
  let ok = false, note = '';
  try {
    const out = cp.execSync('node ' + JSON.stringify(rel), { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
    ok = /✅ (PASS|QUALIFIED)|PASS ·/.test(out) && !/❌/.test(out);
    note = extractCount(out);
  } catch (e) {
    ok = false;
    note = extractCount(((e.stdout || '') + (e.stderr || '')).toString()) || 'exit ' + (e.status != null ? e.status : '?');
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  allOk = allOk && ok;
  rows.push({ rel, ok, note, ms });
  console.log('  ' + (ok ? '✓' : '✗') + ' ' + rel.padEnd(42) + ' ' + note.padEnd(18) + ' ' + ms.toFixed(0) + ' ms');
}

const passed = rows.filter(r => r.ok).length;
console.log('\n' + (allOk ? '✅ ALL SUITES PASS' : '❌ SUITE FAILURE') + ` — ${passed}/${rows.length} suites`);
process.exit(allOk ? 0 : 1);
