'use strict';
// coverage.js — deterministic line-coverage measurement using Node's BUILT-IN V8 coverage
// (NODE_V8_COVERAGE) — no external dependency (c8/nyc/istanbul). Runs the unit suites with coverage
// on, merges the per-process V8 reports, and computes per-file line coverage for the deterministic
// data/logic layer (the part unit tests own; the live-scan runtime — audit/checks/report — is covered
// by golden + integration + live evidence, not unit tests, so it is intentionally out of scope here).
//
//   node testing/coverage.js            # measure + print
//   node testing/coverage.js 90         # measure + enforce a ≥90% total gate (exit 1 if below)
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const os = require('os');

const ROOT = path.join(__dirname, '..');

// The deterministic layer that unit tests exercise. Explicit list = an honest, stable denominator.
const INCLUDE = [
  'rules/registry.js', 'score.js', 'finding.js', 'events.js', 'version.js', 'pipeline.js', 'inventory/lifecycle.js', 'inventory/id-registry.js', 'inventory/model.js', 'inventory/providers.js', 'inventory/index.js',
  'scan-store/digest.js', 'scan-store/record.js', 'scan-store/store.js', 'scan-store/history.js', 'scan-store/diff.js', 'scan-store/integrity.js', 'scan-store/index.js',
  'finding-store/digest.js', 'finding-store/record.js', 'finding-store/lifecycle.js', 'finding-store/store.js', 'finding-store/history.js', 'finding-store/diff.js', 'finding-store/integrity.js', 'finding-store/index.js',
  'timeline/digest.js', 'timeline/timeline.js', 'timeline/aggregate.js', 'timeline/snapshot.js', 'timeline/integrity.js', 'timeline/index.js',
  'regression/digest.js', 'regression/policy.js', 'regression/baseline.js', 'regression/regression.js', 'regression/store.js', 'regression/integrity.js', 'regression/index.js',
  'best-practices/checks.js', 'best-practices/index.js',
  'content-artifacts/checks.js', 'content-artifacts/index.js',
  'ops/config.js', 'ops/backup.js', 'ops/index.js',
  'reporting/summary.js', 'reporting/index.js',
];
const SUITES = [
  'rules/registry.test.js', 'testing/foundation.test.js', 'scan-store/scan-store.test.js', 'finding-store/finding-store.test.js',
  'timeline/timeline.test.js', 'regression/regression.test.js', 'best-practices/best-practices.test.js',
  'content-artifacts/content-artifacts.test.js', 'spelling/spelling.test.js', 'ops/ops.test.js', 'reporting/reporting.test.js', 'pipeline.test.js', 'inventory/inventory.test.js',
];

function toAbs(u) { try { return path.normalize(u.startsWith('file:') ? new URL(u).pathname.replace(/^\/([A-Za-z]:)/, '$1') : u); } catch (_) { return u; } }
function includeKey(abs) {
  const n = abs.replace(/\\/g, '/');
  return INCLUDE.find(rel => n.endsWith('/' + rel) || n.endsWith('/site-qa/' + rel));
}

// Per file: covered[byte] boolean, ORed across all runs. V8 ranges are nested outer→inner; applying
// them in order lets an inner block override its parent (the standard precise-coverage fold).
const covered = new Map(); // rel → Uint8Array

function applyReport(cov) {
  for (const entry of cov.result || []) {
    const abs = toAbs(entry.url);
    const rel = includeKey(abs);
    if (!rel) continue;
    const srcPath = path.join(ROOT, rel);
    if (!fs.existsSync(srcPath)) continue;
    const len = fs.readFileSync(srcPath).length;
    // Per-report fold: apply nested ranges in order so an inner count-0 block OVERRIDES its executed
    // parent (V8 lists ranges outer→inner). This is the true coverage FOR THIS RUN.
    const local = new Int8Array(len).fill(-1);
    for (const fn of entry.functions || []) {
      for (const r of fn.ranges || []) {
        const val = r.count > 0 ? 1 : 0;
        for (let i = r.startOffset; i < r.endOffset && i < len; i++) local[i] = val;
      }
    }
    if (!covered.has(rel)) covered.set(rel, new Uint8Array(len));
    const g = covered.get(rel);
    // Union across runs: a byte is covered if it was executed in ANY report.
    for (let i = 0; i < len; i++) if (local[i] === 1) g[i] = 1;
  }
}

function lineCoverage(rel) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const arr = covered.get(rel);
  const lines = src.split('\n');
  let total = 0, hit = 0, off = 0;
  for (const line of lines) {
    const codeStart = line.search(/\S/);
    const trimmed = line.trim();
    const isCode = trimmed && !trimmed.startsWith('//') && trimmed !== '}' && trimmed !== '{' && !trimmed.startsWith('*') && !trimmed.startsWith('/*');
    if (isCode) {
      total++;
      let anyCov = false;
      if (arr) for (let i = off + Math.max(codeStart, 0); i < off + line.length; i++) if (arr[i]) { anyCov = true; break; }
      if (anyCov) hit++;
    }
    off += line.length + 1; // + newline
  }
  return { total, hit, pct: total ? +(100 * hit / total).toFixed(1) : 100 };
}

function main() {
  const gate = process.argv[2] ? Number(process.argv[2]) : null;
  const covDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auditor-cov-'));
  const env = Object.assign({}, process.env, { NODE_V8_COVERAGE: covDir, SCANSTORE_PERF_N: '150', FINDINGSTORE_PERF_N: '150' });
  console.log('SGEN Site Auditor — coverage (built-in V8, no external deps)\n');
  for (const s of SUITES) { try { cp.execSync('node ' + JSON.stringify(s), { cwd: ROOT, env, stdio: 'ignore' }); } catch (_) {} }

  // Merge every V8 report (each suite spawns child procs → many files).
  const walk = d => fs.readdirSync(d).forEach(f => { const p = path.join(d, f); const st = fs.statSync(p); if (st.isDirectory()) walk(p); else if (f.endsWith('.json')) { try { applyReport(JSON.parse(fs.readFileSync(p, 'utf8'))); } catch (_) {} }; });
  walk(covDir);

  let tTotal = 0, tHit = 0; const missing = [];
  console.log('  file'.padEnd(46) + 'lines   cov%');
  for (const rel of INCLUDE) {
    if (!covered.has(rel)) { missing.push(rel); console.log('  ' + rel.padEnd(44) + '   —    (not loaded)'); continue; }
    const c = lineCoverage(rel);
    tTotal += c.total; tHit += c.hit;
    console.log('  ' + rel.padEnd(44) + String(c.total).padStart(4) + '   ' + c.pct.toFixed(1) + '%');
  }
  const pct = tTotal ? +(100 * tHit / tTotal).toFixed(1) : 0;
  try { fs.rmSync(covDir, { recursive: true, force: true }); } catch (_) {}
  console.log('\n  TOTAL line coverage: ' + tHit + '/' + tTotal + ' = ' + pct + '%');
  if (missing.length) console.log('  files never loaded: ' + missing.join(', '));
  if (gate != null) {
    const ok = pct >= gate;
    console.log('\n' + (ok ? '✅ PASS' : '❌ FAIL') + ` — coverage ${pct}% ${ok ? '≥' : '<'} gate ${gate}%`);
    process.exit(ok ? 0 : 1);
  }
}
main();
