'use strict';
// ops.test.js — deterministic suite for the Operations pillar: config + backup/restore/verify.
// Uses a REAL scan store so restore is validated against real integrity. No network/AI.
const fs = require('fs');
const path = require('path');
const os = require('os');
const OPS = require('./index');
const { loadConfig, DEFAULTS, backup, verifyBackup, restore } = OPS;
const SS = require('../scan-store');

let pass = 0, fail = 0; const failures = [];
function ok(c, n) { if (c) pass++; else { fail++; failures.push(n); console.log('  ✗ ' + n); } }
function eq(a, b, n) { ok(JSON.stringify(a) === JSON.stringify(b), n); }
function tmp(t) { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-' + t + '-')); return d; }

function seedStore(dir) {
  const store = new SS.ScanStore(dir);
  for (let i = 0; i < 5; i++) store.save({ target: 'https://old.example.com', host: 'h', generated: '2026-07-0' + (i + 1) + 'T00:00:00.000Z', versions: { engine: '2.1.0', registry: '1.2.0', report: '1.1.0' }, quality: { overall: 90, suites: {} }, tally: {}, suites: [{ key: 'audit', checks: [{ status: 'fail', ruleId: 'SEC-001', suite: 'security', severity: 'high', deduction: 18, target: 'h', detail: 'd', items: [] }] }], crawl: {} });
  return store;
}

console.log('Operations (config + backup/restore) — test suite\n');

// ---- config ----
eq(loadConfig().coverageGate, 95, 'config: default coverage gate');
eq(loadConfig({ coverageGate: 90 }).coverageGate, 90, 'config: override merges over default');
ok(loadConfig().scanStoreDir === DEFAULTS.scanStoreDir, 'config: defaults exposed');
(function fileConfig() {
  const d = tmp('cfg'); const p = path.join(d, 'c.json'); fs.writeFileSync(p, JSON.stringify({ coverageGate: 80 }));
  eq(loadConfig(p).coverageGate, 80, 'config: loads from a JSON file path');
})();

// ---- backup / verify / restore ----
(function backupFlow() {
  const src = tmp('src'); const store = seedStore(src);
  const dest = tmp('bak');
  const manifest = backup(src, dest, { createdAt: '2026-07-08T00:00:00.000Z' });
  ok(manifest.fileCount > 0, 'backup: files captured');
  ok(fs.existsSync(path.join(dest, 'BACKUP-MANIFEST.json')), 'backup: manifest written');
  const v = verifyBackup(dest);
  ok(v.ok, 'backup: fresh backup verifies ok');

  // corrupt a backed-up file → detected
  const someFile = manifest.files.find(f => f.rel.endsWith('.json'));
  fs.appendFileSync(path.join(dest, 'data', someFile.rel), 'X');
  ok(verifyBackup(dest).issues.some(i => i.type === 'corrupt-file'), 'backup: corrupted file detected');

  // restore refuses a corrupt backup
  const target = tmp('restore-bad');
  ok(!restore(dest, target).ok, 'restore: refuses a backup that fails verification');

  // clean backup → restore + store integrity verify
  const dest2 = tmp('bak2'); backup(src, dest2, { createdAt: '2026-07-08T00:00:00.000Z' });
  const target2 = tmp('restore-ok');
  const r = restore(dest2, target2, { verifyStore: root => SS.verify(new SS.ScanStore(root)) });
  ok(r.ok && r.storeVerified, 'restore: clean backup restores + restored store passes integrity');
  // restored store has identical data
  const restored = new SS.ScanStore(target2);
  eq(restored.count(), store.count(), 'restore: restored store has all scans');
  ok(SS.verify(restored).ok, 'restore: restored store verifies');

  // deleted file in backup → detected
  const dest3 = tmp('bak3'); const m3 = backup(src, dest3); fs.unlinkSync(path.join(dest3, 'data', m3.files[0].rel));
  ok(verifyBackup(dest3).issues.some(i => i.type === 'missing-file'), 'backup: deleted file detected');

  // tampered manifest → detected
  const dest4 = tmp('bak4'); backup(src, dest4);
  const mp = path.join(dest4, 'BACKUP-MANIFEST.json'); const mm = JSON.parse(fs.readFileSync(mp, 'utf8')); mm.files[0].sha256 = 'deadbeef'; fs.writeFileSync(mp, JSON.stringify(mm, null, 2));
  ok(verifyBackup(dest4).issues.some(i => i.type === 'manifest-digest-mismatch' || i.type === 'corrupt-file'), 'backup: tampered manifest detected');
})();

console.log('\n' + (fail === 0 ? '✅ PASS' : '❌ FAIL') + ` — ${pass}/${pass + fail} assertions`);
if (fail) { console.log('Failures:\n' + failures.map(f => '  - ' + f).join('\n')); process.exit(1); }
