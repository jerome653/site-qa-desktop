# ADR-0008 — Immutable Store (infrastructure extraction)

- **Status:** PROPOSED (2026-07-28) — promoted to ACCEPTED only on demonstrated implementation; criteria in §Acceptance
- **Date:** 2026-07-28
- **Deciders:** Jerome (product) · auditor
- **Governed by:** **ADR-0004 — Layered Acquisition Architecture**, specifically **§D8** (store consolidation precedes new stores)
- **Affects:** new `immutable-store/` infrastructure · `scan-store` · `finding-store` · `regression` · `timeline` · `evidence-ledger` (all behaviour-preserving)
- **Does NOT affect:** registry contract · finding schema · report output · scoring model · event model · provider contract · collection schema

---

## Context

ADR-0004 §D8 required this before any new store was built:

> *"Content-addressing, append-only semantics, rebuildable indexes and integrity verification are
> **infrastructure concerns, not application concerns**. … The shared base is extracted first, then
> instantiated for the two new ones. Integrity guarantees that mean different things in different
> stores are not integrity guarantees."*

### 1 · The duplication, measured before touching anything

**Content addressing — four copies, functionally identical.** `scan-store/digest.js`,
`finding-store/digest.js`, `regression/digest.js` and `timeline/digest.js` each carried their own
`canonical()` + `sha256()`. Verified **empirically, not by reading**: all four produced identical
output for both functions across 8 value shapes (nested objects, arrays, `null`, `0`, `''`,
`undefined`). The files differed only in comments and one temp-variable spelling.

Each file *documented* the requirement in prose — "byte-identical to scan-store/digest.js **by
contract**", "byte-identical to the other stores' digest **by contract**" — which is exactly the
situation where four files are agreeing to stay in step by good intentions.

**Durable commit — three copies.** `scan-store/store.js`, `finding-store/store.js` and
`regression/store.js` each wrote the same sequence: temp → `openSync` → `writeSync(JSON.stringify(rec,
null, 2))` → `fsyncSync` → `closeSync` → `renameSync`, then `appendFileSync(JSON.stringify(line) +
'\n')` to the manifest. Index projection repeated `appendFileSync(path, lines.join('\n') + '\n')`.

**A fifth store had already reached across.** ADR-0007's evidence-ledger imported `sha256` from
`finding-store/digest` — infrastructure borrowing from an unrelated store because there was nowhere
else for it to live. That is the smell this ADR removes.

### 2 · Why now

ADR-0008's own instruction: *"Do not build a sixth bespoke implementation."* Collection Store is next.
Extracting after it would mean six.

---

## Decision

### D1 · `lib/site-qa/immutable-store/` — primitives only

| Primitive | Replaces |
|---|---|
| `canonical(v)` · `sha256(input)` | four identical copies |
| `writeRecordAtomic(path, record)` | three copies of temp→fsync→rename |
| `appendLine(path, obj)` | three copies of the manifest commit append |
| `appendLines(path, lines)` | two copies of index projection append |
| `readJsonl(path)` · `readRecord(path)` · `exists` · `ensureDir` | scattered inline reads |
| `RecordStore` | the storage/indexes/manifest layout every store shares |

### D2 · What it deliberately does not do

No replay, no collections, no scoring, no reporting, no registry access, no provider logic, no business
rules. It performs filesystem persistence — an infrastructure concern — but **makes no policy
decisions**: what a record contains, which indexes exist, what counts as damage and what may be
recovered all stay with the store that owns that meaning.

Asserted, not promised: the suite greps the module's own source for registry/score/report/Playwright
imports, for severity/deduction/verdict/threshold logic, for any clock read (`Date.now`, `new Date`),
and for filesystem *discovery* (`readdirSync`, `glob`) — all absent. Its export surface is asserted to
be exactly the ten primitives above.

### D3 · `appendLines` takes already-serialised strings

Deliberate, and the reason the extraction is byte-safe: the index projections build their own line
strings, and re-serialising them inside infrastructure would change bytes. Infrastructure carries the
write; the store owns the shape.

### D4 · Migration by call-site, not by re-parenting

The four `digest.js` files became **thin adapters** that re-export from `immutable-store`, so every
existing caller and the "byte-identical hashing across stores" contract keep working — now guaranteed
by construction rather than by four files agreeing. The three `store.js` write paths call the shared
primitives.

**The four legacy stores were NOT re-parented onto `RecordStore`.** Their duplicated *infrastructure*
is gone, which is what §D8 asked for; what remains in each is its specialisation (record shape,
manifest payload, index rules, integrity classes, diff and lineage semantics) — which is the adapter
shape. Changing the class hierarchy of four certified stores would be a second, riskier change with no
additional payoff against this ADR's binding constraint: byte-identical behaviour. Recorded as a
deliberate stop, not an oversight.

`RecordStore` is exercised and tested so a **new** store is configuration rather than another
implementation — ADR-0008's stated goal for Collection Store. Proven in-suite by instantiating a second
store with a different layout and no new code.

---

## Consequences

**Positive**
- One implementation of content-addressing. `scan-store/digest.sha256 === finding-store/digest.sha256`
  is now true by **function identity** (asserted as `===`, not as equal output), so the four stores
  cannot drift apart.
- One implementation of the durable commit; a durability fix now lands everywhere at once.
- The evidence-ledger no longer reaches into an unrelated store for infrastructure.
- Collection Store (ADR-future) becomes a `RecordStore` subclass with a record shape.
- ~120 lines of duplicated infrastructure removed from the specialised stores.

**Negative / trade-offs**
- **The legacy four are not `RecordStore` subclasses.** Stated above; deliberate.
- Integrity verification and index *rules* remain per-store. They genuinely differ (scan-store
  classifies 7 damage classes, finding-store 9, and those classes encode different meanings), so
  unifying them would be unification by force. §D8's wording — "integrity guarantees that mean
  different things in different stores are not integrity guarantees" — argues for a shared *mechanism*,
  which is what was extracted; the classification stays where the meaning is.
- One new module in the require graph for every store. No measured cost; the suites' timing lines moved
  only within normal run-to-run variance.
- **One test assertion had to change** (see §Evidence I5) — the only non-mechanical edit in the
  migration, and it is called out rather than folded in silently.

**Migration / version impact**
- **No version stream moved.** `ENGINE_VERSION` 2.3.0 · `REPORT_VERSION` 1.4.0 · `REGISTRY_VERSION`
  1.13.0 · `COLLECTION_SCHEMA_VERSION` 1.1 · `PROVIDER_CONTRACT_VERSION` 1.0 — all unchanged.
  `release-metadata.json` untouched. Infrastructure work, no user-visible behaviour change, **no release
  is due**.

---

## Evidence

Parity was captured **before** any edit and re-run after. It is measurement, not assertion.

| # | Evidence | Result |
|---|---|---|
| **I1** | **On-disk parity oracle** — drives the real ScanStore, FindingStore, Timeline, Regression and EvidenceLedger with fixed inputs, then hashes **every byte written** | ✅ **31 files, overall SHA `a0f727d8ca5028834cdc922d63387bbbb557addf20c445e760c13a0fd60246d3` — identical before and after, 0 bytes differ** |
| I2 | Logical digests through the oracle: scan1 `b59d5d65c322a790…`, scan2 `6830ccadb516b600…`, gate `WARN 8dd2c506484b26b2`, ledger `{artifacts:1, files:2, duplicates:1}` | ✅ unchanged |
| I3 | Digest equivalence, all four stores, 8 value shapes, both functions — captured pre-extraction | ✅ identical; `sha256({b:2,a:1}) = 43258cff783fe703…` pinned in-suite |
| I4 | `timeline` + `regression` suite stdout | ✅ **byte-identical** before vs after |
| I5 | `scan-store` (56/56) + `finding-store` (60/60) suite stdout | ✅ **byte-identical once wall-clock timing lines are normalised** — the only differences are the perf harness's own `ms` readings |
| I6 | `evidence-ledger` | ⚠️ **went 57/58 on the extraction, by design.** Its ADR-0007 assertion pinned hashing to `finding-store/digest` — the wrong home, which is precisely what this ADR corrects. Re-pointed at `immutable-store` and strengthened with "the ledger implements no hashing of its own" → ✅ **59/59** |
| I7 | `immutable-store/immutable-store.test.js` | ✅ **49/49** |
| I8 | Single-source invariant: each store's `digest.sha256` **is the same function object** (`===`), and no store's digest carries `createHash` | ✅ in I7 |
| I9 | No-policy boundary: no registry/score/report/Playwright import, no severity/deduction/verdict/threshold, no clock read, no filesystem discovery, export surface = 10 primitives | ✅ in I7 |
| I10 | Full suite before vs after | see §Acceptance |

---

## Acceptance

**PROPOSED until reviewed.** ACCEPTED means demonstrated, not intended.

| # | Criterion | State |
|---|---|---|
| 1 | Existing stores migrated onto the Immutable Store | **met** — 5 stores, digest + commit + journal primitives |
| 2 | Behaviour byte-identical | **met (I1, I4, I5)** |
| 3 | Regression suites green except the known `foundation.test.js` failure | **met (I10)** |
| 4 | No frozen boundary crossed | **met (I9)** |
| 5 | No report output change | **met** — no report module touched |
| 6 | No registry change | **met (I7)** |
| 7 | No scoring change | **met** — no scoring module touched |
| 8 | No event-model change | **met** — `events.js` untouched |
| 9 | Evidence demonstrates parity rather than asserting it | **met (I1)** — bytes compared, not claimed |

**Did any golden output change?** **No.** The on-disk oracle's overall SHA is unchanged, and every
per-file hash across all 31 written files is unchanged. The only test-output changes are wall-clock
timings (I5) and the one deliberately re-pointed assertion (I6).

**ADR-0004, ADR-0005, ADR-0006, ADR-0007 and ADR-0008 all remain PROPOSED.** None promotes itself or
its parent.

---

## Related

- **ADR-0004 §D8** — the requirement this ADR discharges.
- **ADR-0007** — evidence-ledger; its borrowed `sha256` import is corrected here.
- **Collection Store (future ADR)** — should be a `RecordStore` subclass, i.e. configuration.
- **Deferred, recorded:** re-parenting the four legacy stores onto `RecordStore`; unifying integrity
  *classification* (mechanism is shared, meaning is not).
