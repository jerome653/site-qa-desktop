# ADR-0009 — Collection Store (sealed acquisitions)

- **Status:** PROPOSED (2026-07-28) — promoted to ACCEPTED only on demonstrated implementation; criteria in §Acceptance
- **Date:** 2026-07-28
- **Deciders:** Jerome (product) · auditor
- **Governed by:** **ADR-0004** (§D3 · §D4 · §D5 · §D7 · §D8 · §D9) · **built on ADR-0008** (Immutable Store)
- **Affects:** new `collection-store/` (infrastructure only)
- **Does NOT affect:** any existing store · registry contract · finding schema · report output · scoring model · event model · provider contract · collection schema

---

## Context

The Collection Store is the last acquisition-layer persistence component. Everything it needs already
exists:

- **ADR-0004** defined the sealed Collection and the `collected[]` declaration.
- **ADR-0005 / ADR-0006** fill the `network` and `documents` channels.
- **ADR-0007** gives artifacts content-addressed ids, so a collection can *reference* a screenshot
  instead of carrying it.
- **ADR-0008** extracted `RecordStore` and the durable-commit primitives *specifically so this store
  would not be store #6*:

  > *"The extraction should make Collection Store essentially configuration rather than another
  > implementation."*

This ADR is the test of whether that extraction actually paid off.

---

## Problem

Persist a complete acquisition — immutably, verifiably, once — **without**:

- forking any infrastructure ADR-0008 already owns,
- duplicating a single artifact byte,
- or letting a persistence layer make a decision that belongs to a rule, a view, or the future Replay
  Engine.

Three specific hazards:

1. **A store that timestamps its own writes is making policy.** "When did this happen" is a fact the
   caller owns, not one the filesystem layer should invent.
2. **A store that imports `version.js` imports the rule registry transitively** — the exact boundary
   this component is forbidden to cross (`version.js` re-exports `REGISTRY_VERSION` from
   `rules/registry`).
3. **A manifest that records "replayable: true" has made a replay decision.** Replay is a later ADR;
   the manifest must record facts and stop.

---

## Decision

### D1 · `CollectionStore extends RecordStore` — configuration, not implementation

Everything durable is inherited: the storage / indexes / manifest layout, the temp→fsync→rename commit,
the append-only journals, the canonical digest. What this file adds is only its **specialisation** —
what a collection record contains, which indexes it projects, and what counts as damage.

Asserted by **prototype identity**, not by claim: `s instanceof RecordStore`,
`Object.getPrototypeOf(CollectionStore) === RecordStore`, and `commit`/`recordPath`/`indexPath`/`has`/
`get`/`manifest` are each proven to be *the same function object* as `RecordStore`'s and **not** own
properties of `CollectionStore.prototype`. The module is additionally asserted to contain no
`createHash`, `renameSync`, `fsyncSync` or `openSync` — it cannot have forked the infrastructure.

### D2 · The record

```
{ collectionId, digest, model,
  manifest:    { schemaVersion, engineVersion, registryVersion, providerContractVersion,
                 collectorSet[], providerSet[], acquiredAt, target, host },
  counts:      { per channel },
  integrity:   { channelDigests: { per channel } },
  evidenceRefs:[ artifactId… ],
  channels:    { staticPages, documents, network, render, console, fonts, shots } }
```

`collectionId = 'col-' + sha256(record minus its own id/digest)` — an id may never be part of the
content it identifies, the same discipline as `scan-store`'s `recordForDigest`.

### D3 · The manifest records compatibility FACTS ONLY

It says what produced the collection. It never says what that means. Asserted directly: the whole
serialised record is checked to contain no `replay` / `replayable` / `canReplay` / `compatible: bool`
field. Something else may later decide replayability; this store must not pre-empt it.

`collectorSet` comes from the collection's **own `collected[]` declaration** — never inferred from a
channel being empty, which is the ADR-0005 "looked vs never looked" distinction carried through to
persistence.

### D4 · It reads no clock and imports no version module

`acquiredAt` and `versions {engine, registry, providerContract}` are **required inputs** and throw when
absent. This is not defensive coding, it is the boundary: a caller that cannot say what produced a
collection has no business sealing one. It also keeps the module free of `version.js`, and therefore of
the rule registry — asserted by source inspection alongside the no-clock check.

### D5 · References, never copies

Binary artifacts are never read, copied or stored. Shot entries are recorded as the references they
already are, and their ADR-0007 `artifactId`s are collected into `evidenceRefs`, de-duplicated and
sorted. **Proven, not asserted:** the fixture references artifact paths that do not exist on the test
machine, and the collection still saves and verifies — which is only possible if no artifact byte was
ever read.

Page bodies and the structured channels are the acquisition *itself*, not artifacts, so they are stored
as given. Externalising them is **storage optimisation**, explicitly excluded by this ADR.

### D6 · Sealing and integrity

Immutable once written: an identical acquisition re-saved is reported as a duplicate and the record on
disk is **byte-for-byte unchanged** (asserted by reading the file before and after). Indexes are pure
projections — `rebuildIndexes()` regenerates every index **byte-identically** and leaves the
append-only manifest untouched.

Damage is classified, never boolean:

| Class | Meaning |
|---|---|
| `modified` | content no longer hashes to its recorded digest |
| `channel-modified` | **which channel** changed — a diagnosis without re-deriving it |
| `id-mismatch` | a **forged** id/digest pair — deliberately distinct from `modified` |
| `missing-record` | a manifest line whose record is gone |
| `uncommitted` | a record with no manifest line: a recoverable partial write, **not** corruption |

---

## Consequences

**Positive**
- ADR-0008's payoff is demonstrated: a new store is ~200 lines of specialisation with zero forked
  infrastructure, and inheritance is machine-checked.
- Acquisitions are now sealable, verifiable and addressable — the prerequisite for the Replay Engine.
- Artifact storage stays single-copy by construction: collections reference, they do not carry.
- Per-channel digests mean a future replay can report *which* channel drifted.

**Negative / trade-offs**
- **Collections carry page bodies and full channel data.** They can be large. Storage optimisation is
  excluded by this ADR and stated in the record rather than quietly mitigated.
- **Nothing writes to this store yet.** No collector, pipeline or serve path persists a collection —
  wiring it is a consumer-side change and belongs with the Replay Engine that will read it. The store
  is infrastructure standing ready, and saying so is more honest than wiring a producer nobody reads.
- `providerSet` is caller-supplied. The store cannot verify it, because enumerating providers would
  couple persistence to the provider layer. A wrong `providerSet` is a caller defect the store records
  faithfully.
- Two test assertions in the first draft were **wrong and went red** (see §Evidence C6) — corrected by
  strengthening, not by weakening. Recorded rather than silently amended.

**Migration / version impact**
- **No version stream moved.** `ENGINE_VERSION` 2.3.0 · `REPORT_VERSION` 1.4.0 · `REGISTRY_VERSION`
  1.13.0 · `COLLECTION_SCHEMA_VERSION` 1.1 · `PROVIDER_CONTRACT_VERSION` 1.0. `release-metadata.json`
  untouched. Infrastructure only — **no release is due**.

---

## Evidence

| # | Evidence | Result |
|---|---|---|
| **C1** | `collection-store/collection-store.test.js` | ✅ **71/71** |
| C2 | Written + content-addressed; identical acquisition → identical id on a second store | ✅ in C1 |
| C3 | **Sealed:** duplicate save does not rewrite the record (file bytes compared before/after) and appends no manifest line | ✅ in C1 |
| C4 | **Rebuild:** every index BYTE-IDENTICAL after `rebuildIndexes()`; manifest untouched; integrity still verifies | ✅ in C1 |
| C5 | **Manifest = facts only:** no replay/compatibility judgement anywhere in the record; `collectorSet` from the collection's own declaration | ✅ in C1 |
| C6 | **Integrity classified:** `modified` + `channel-modified` (names the channel) + forged-digest `id-mismatch` + `uncommitted` + `missing-record`, each proven distinct | ✅ in C1 |
| C7 | **References not copies:** referenced artifacts do not exist on the machine, yet save + verify succeed | ✅ in C1 |
| C8 | **Built on ADR-0008:** `instanceof`, prototype identity, six inherited methods proven same-function-object and not own properties; no forked hashing or atomic write | ✅ in C1 |
| C9 | **No policy:** no registry/score/report/audit/version import, no Playwright, no clock, no severity/deduction/verdict/threshold; fails closed on missing `acquiredAt`, missing/partial versions, missing schemaVersion, null collection | ✅ in C1 |
| C10 | **Existing stores unaffected:** the ADR-0008 on-disk oracle re-run — 31 files across ScanStore, FindingStore, Timeline, Regression, EvidenceLedger | ✅ overall SHA `a0f727d8ca5028834cdc922d63387bbbb557addf20c445e760c13a0fd60246d3`, unchanged |
| C11 | Full suite before vs after | see §Acceptance |

---

## Acceptance

**PROPOSED until reviewed.** ACCEPTED means demonstrated, not intended.

| # | Criterion | State |
|---|---|---|
| 1 | Built on Immutable Store | **met (C8)** |
| 2 | Collections immutable after persistence | **met (C3)** |
| 3 | Manifest captures compatibility metadata only | **met (C5)** |
| 4 | Integrity verification passes | **met (C6)** |
| 5 | Existing behaviour byte-identical | **met (C10)** |
| 6 | No report output change | **met** — no report module touched |
| 7 | No registry change | **met (C9)** |
| 8 | No scoring change | **met** — no scoring module touched |
| 9 | No event-model change | **met** — `events.js` untouched |
| 10 | No new failures in the full suite | **met (C11)** |

**Explicitly not implemented**, per the brief: replay engine, replay API, historical comparison, rule
execution over stored collections, certification replay, impact analysis, storage optimisation, report
consumers.

**ADR-0004, 0005, 0006, 0007, 0008 and 0009 all remain PROPOSED.** None promotes itself or its parent.

---

## Related

- **ADR-0008** — the extraction this ADR consumes; its predicted payoff, measured.
- **ADR-0007** — supplies the `artifactId`s referenced in `evidenceRefs`.
- **Replay Engine (next ADR)** — the first reader of this store. Reproducibility-replay vs
  impact-replay both consume the manifest facts recorded here; neither decision is made here.
- **Deferred, recorded:** a producer that persists collections during a real run; page-body
  externalisation (storage optimisation); `providerSet` verification.
