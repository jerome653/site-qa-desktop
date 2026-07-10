# Operations Guide — SGEN Site Auditor

The auditor is self-contained: Node + Playwright (for live scans) + `sharp` (for visual match). The
deterministic history/score layer needs **no network and no external services**. This guide covers
running it, storing results, backup/restore, and monitoring.

## Configuration
`ops/config.js` holds every operational knob with safe defaults. Override with an object or a JSON file:
```js
const { loadConfig } = require('./ops');
const cfg = loadConfig('/etc/sgen-auditor.json');   // or loadConfig({ coverageGate: 90 })
```
Keys: `scanStoreDir`, `findingStoreDir`, `timelineStoreDir`, `regressionStoreDir`, `backupDir`,
`coverageGate`, `regressionPolicy`, `perfBudgets`, `verifyOnRestore`.

## Data stores
All history lives in append-only, content-addressed directories (`storage/` + `manifest/` + `index/`).
They are safe to copy at any time — nothing mutates in place. Never hand-edit a record: its digest will
no longer match and `verify()` will flag it.

## Backup
```js
const ops = require('./ops');
const manifest = ops.backup(scanStoreDir, `${backupDir}/scans-2026-07-08`, { createdAt });
```
Produces `BACKUP-MANIFEST.json` (per-file sha256 + overall digest). Backups are **verifiable**, not
assumed intact.

## Verify a backup
```js
const v = ops.verifyBackup(backupPath);   // { ok, fileCount, issues }
```
Detects corrupt, missing, unexpected files and a tampered manifest.

## Restore
```js
const r = ops.restore(backupPath, targetDir, { verifyStore: root => require('./scan-store').verify(new (require('./scan-store').ScanStore)(root)) });
// refuses a backup that fails verification; confirms restored-store integrity before success
```

## Integrity monitoring
Run periodically and alert on `ok === false`:
```
node -e "const S=require('./scan-store');console.log(S.verify(new S.ScanStore(process.argv[1])).ok)" <scanStoreDir>
```
Each store exposes `verify()` (scan/finding/timeline/regression). A `digest-mismatch`, `missing`,
`broken-chain`, or `invalid-transition` finding means tampering or disk damage — restore from backup.

## Health checklist
1. `node testing/run-all.js` → all suites green.
2. `node testing/security-audit.js` → 0 findings.
3. `verify()` on each live store → ok.
4. Latest backup `verifyBackup()` → ok.

## Performance envelope (measured, N=10k — `testing/benchmark.js`)
scan save ≈ 4.4 ms/scan · scan verify ≈ 0.5 ms/scan · index rebuild ≈ 2.7 ms/scan · timeline build
≈ 0.6 ms/scan · regression gate ≈ 16 ms. Finding ingest of a *single* very large scan is O(n) per
append (fine for real scans of hundreds of findings; see TD-008 for the large-batch note).
