# Upgrade Guide — SGEN Site Auditor

The auditor uses **independent version streams** so any past report stays reproducible against the exact
rules + engine that produced it:

- **Engine** (`version.js` `ENGINE_VERSION`) — runtime behaviour.
- **Registry** (`REGISTRY_VERSION`) — rule metadata (ids, deductions, weights, suites).
- **Report** (`REPORT_VERSION`) — report/scoring output shape.

Every scan record stamps all three. Never reuse an id; never silently change a deduction.

## Safe (additive) changes — no ADR
- **Add a rule**: new `SUITE-NNN` id + slug; keep scored-suite weights summing to 100. Bump `REGISTRY_VERSION`. Run `node rules/registry.test.js`.
- **Add an advisory suite** (like Best Practices): register it with **weight 0** so historical `overall` scores stay byte-identical (proven by golden parity). A *scored* suite (weight > 0) rebalances weights → changes historical scores → **requires an ADR**.
- **Add a subsystem** that only reads immutable records (history/reporting/ops). Additive per ADR-0001 §4.

## Changes that REQUIRE a new ADR (`docs/adr/`)
The Architecture Freeze (WP-002) sealed these; a change to any needs an approved ADR first:
- registry contract / schemas / event model / runtime flow / **scoring model** (including suite weights of scored suites).

## Version-bump checklist
1. Make the change; bump the affected version stream(s).
2. `node testing/run-all.js` → all suites green.
3. `node golden.js check` + integration parity → **byte-identical** if you did NOT intend to change scores. A diff here is your early warning.
4. `node testing/coverage.js 95` → coverage holds.
5. Update `CHANGELOG.md` (dated, with the version tags) and the `CERTIFICATION.md` evidence ledger.

## Data migration
Records are immutable and versioned; there is **no in-place migration**. A new engine/registry version
simply produces new records alongside the old — old records remain readable and reproducible. If a record
schema ever changes, add a `schemaVersion`-aware reader; never rewrite existing records.

## Reproducing an old result
Check the record's stamped `versions`. Because scoring reads only the registry and the registry is
versioned, re-running the same engine+registry on the same input yields the same score — deterministically.
