# Troubleshooting — SGEN Site Auditor

| Symptom | Likely cause | Fix |
|---|---|---|
| `registry: suite weights must total 100` | a weight edit unbalanced the suites | restore weights so the 10 scored suites sum to 100 (Best Practices stays 0) |
| `registry: duplicate rule id/slug` | a copy-pasted rule | give the new rule a unique `SUITE-NNN` id + slug |
| `verify()` reports `digest-mismatch` | a record was hand-edited or disk-corrupted | never edit records; restore from a verified backup |
| `verify()` reports `broken-chain` / `invalid-transition` (finding store) | a finding record was tampered/reordered | restore from backup; the lifecycle is fail-closed, so this is real |
| `verify()` reports `orphan` | a record on disk was never committed to the manifest (crash mid-write) | run `recover()` — it rebuilds indexes and reports anything unrepairable |
| `verify()` reports `partial-write` / `torn-manifest` | interrupted write (crash/kill) | run `recover()` — removes the temp file / truncates the torn tail; valid history preserved |
| `invalid lifecycle transition: X → Y` thrown on ingest | code tried an illegal state move | the state machine is correct; fix the caller (e.g. resolve requires ACTIVE, not OPEN) |
| Coverage below the gate | a new branch is untested | add a test; `node testing/coverage.js` lists per-file % |
| Benchmark slow on a huge single scan | O(n) finding-index scan per append (TD-008) | expected at 10k+ findings in ONE scan; real scans (hundreds) are fast |
| Scores changed unexpectedly after an edit | a deduction/weight changed in the registry | registry is the only place scores come from — diff `rules/registry.js`; bump `REGISTRY_VERSION` |
| A stored timeline/verdict no longer `reproduces()` | the source stores changed under it (drift) | expected if new scans landed; re-materialize the snapshot |

## First moves for any anomaly
1. `node testing/run-all.js` — is the code itself healthy?
2. `<store>.verify()` — is the data intact?
3. If data damage: `<store>.recover()`, then re-verify; if still not `ok`, restore from backup.
4. Never "fix" a record by editing it — that breaks content-addressing and hides the real problem.
