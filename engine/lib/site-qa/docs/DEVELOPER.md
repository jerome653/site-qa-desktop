# Developer Guide — SGEN Site Auditor

The auditor is a **deterministic, offline, registry-driven** website quality platform. No AI, no cloud,
no per-run cost. Same input → same output, always. Read `CHARTER.md` and `ARCHITECTURE.md` first;
this guide is the practical map.

## Layers
```
Foundation   rules/registry.js ── score.js ── finding.js ── events.js ── version.js ── schemas/
Runtime      audit.js · checks-static.js · checks-render.js · report.js   (live scan; browser/network)
History      scan-store/ · finding-store/ · timeline/ · regression/        (immutable, content-addressed)
Advisory     best-practices/                                               (Suite 11, weight 0)
Ops/Test     ops/ · testing/ · reporting/                                  (backup · runner · coverage · summaries)
```

## The one law that governs every subsystem
**The Rule Registry (`rules/registry.js`) is the single source of truth.** Nothing else defines a rule,
a deduction, a weight, or a suite. Identity is the native `ruleId` (WP-001) — never a title. To add a
rule: add a `R(...)` line (unique `SUITE-NNN` id + slug), keep suite weights summing to 100, run
`node rules/registry.test.js`. Adding a rule needs no core change (ADR-0001).

## History layer contract (WP-003…006)
Every store is **append-only, content-addressed, crash-safe** (temp→fsync→rename; manifest append =
commit marker). Nothing is ever overwritten. Digests give tamper-evidence; indexes are rebuildable
projections. See each subsystem's `index.js` header for its API. The stores CONSUME immutable records;
only subscribers write history — checks never do.

## Determinism rules (do not break)
- No `Date.now()` / `Math.random()` in content that gets hashed — pass timestamps in.
- Canonical serialization (`digest.js`) sorts object keys; hashing is stable across machines.
- `scanId`/`recordId`/`findingId` are sha256 hex — safe as filenames, no path traversal.

## Running the tests
```
node testing/run-all.js            # every suite, one command (exit 0 = all green)
node testing/coverage.js 95        # built-in V8 line coverage, ≥95% gate
node testing/benchmark.js 10000    # measured performance at scale
node testing/security-audit.js     # deterministic offline security self-audit
```

## Adding a subsystem
Mirror the existing pattern: `digest.js` (or reuse), a builder producing an immutable record, an
append-only store (temp→fsync→rename + manifest), rebuildable indexes, an `integrity.js` (verify +
recover), an `index.js` barrel, and a `*.test.js` with real fixtures. Additive only — an architecture
change requires a new ADR (`docs/adr/`).
