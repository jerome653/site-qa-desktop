# ADR-0005 — Network Ledger (Collector + Provider)

- **Status:** PROPOSED (2026-07-28) — promoted to ACCEPTED only on demonstrated implementation; criteria in §Acceptance
- **Date:** 2026-07-28
- **Deciders:** Jerome (product) · auditor
- **Governed by:** **ADR-0004 — Layered Acquisition Architecture** (§D2 provider contract · §D3 determinism boundary · §D4 adjacency · §D5 versioned boundaries · §D7 seam validators · §D9 frozen scope)
- **Affects:** acquisition layer (new) · collection schema 1.0 → 1.1 · inventory provider set (+1) · id-registry prefix map (+1)
- **Does NOT affect:** registry contract · finding schema · report schema · event model · scoring model

---

## Context

### 1 · The engine already observes this data and throws it away

`migration-qa/checks-render.js` has attached listeners to every request and response on every scan
since engine 2.0:

```js
pg.on('response', r => {
  const s = r.status(); if (s >= 400) failed.push(…);
  if (!weigh) return;
  const cl = parseInt((r.headers()['content-length'] || '0'), 10);
  if (cl > 0) totalBytes += cl;                 // ← record discarded
});
if (weigh) pg.on('request', () => { reqCount++; });   // ← URL discarded
```

Two aggregates survive: PERF-006's request count and its byte floor. Everything else — the URL,
method, resource type, status, headers, MIME type, size and timing of every single request — is
observed and dropped, once per page, on every scan this engine has ever run.

Third-party attribution, cache and compression analysis, waterfalls, HAR export, CDN detection and
migration payload deltas are all blocked on data the engine is *already collecting*. This is not a
missing measurement. It is a missing **retention**.

### 2 · ADR-0004 created the place for it to live

Before ADR-0004 the provider contract was `enumerate(pages, host)` — static crawl records only — so
there was nowhere to put a network record even if it were kept. A1 widened the contract to
`enumerate(collection, ctx)` and declared a `network` channel. This ADR fills it.

### 3 · ADR-0004 acceptance criterion 3 is still open

> *"One new collector/provider pair — Network Ledger (ADR-0005) or Document Asset Inventory
> (ADR-0006) — flows end-to-end through the new architecture."*

The Network Ledger is the cheaper of the two: its collector is a retention change to listeners that
already run, so it adds no browser work and no scan time.

---

## Problem

Retain per-request observations as a deterministic, replayable inventory — **without** changing a
single finding, score, verdict or report, and without letting acquisition logic leak below the
determinism boundary.

Three specific hazards:

1. **Timing is real evidence and is non-deterministic.** `capturedAt` and `request.timing()` differ on
   every run. If they reach an inventory item, the inventory stops being reproducible and ADR-0004's
   "same collection → same score, forever" dies quietly.
2. **Several wanted fields are not observable** through Playwright's public Response API — wire
   protocol, cache provenance, initiator chain. Recording them as `''`/`0`/`false` would be the
   engine's oldest defect in a new place: an unmeasured value grading as a measured one.
3. **An empty channel is ambiguous.** "A collector ran and saw nothing" and "no collector ran" are
   different facts, and an empty array cannot tell them apart. This is exactly the confusion that
   `audit.js`'s evaluation ledger and `score.js`'s `evaluatedRules` had to be retrofitted to fix.

---

## Options

**A — Collector + Provider pair, records retained, evidence referenced not copied. (recommended)**
A `collectors/network.js` attaches its own listeners alongside the existing ones; records flow into
`collection.network`; a `NetworkProvider` enumerates one item per logical request and points *back* at
its records by index rather than copying them.

**B — Extend the existing render-pass aggregates in place.**
Add arrays next to `totalBytes`/`reqCount` inside `checks-render.js`. Rejected: it puts acquisition
inside a module that also emits findings, entrenching the collector/rule conflation ADR-0004 §D4
exists to end, and it gives the records no contract, no version and no home.

**C — CDP collector for full fidelity (protocol, cache, initiator).**
Rejected *as sequencing, not as design*. CDP would supply the three null fields, at the cost of a
Chromium-only code path and materially more machinery, in the same change that introduces the layer.
Ship the honest-null version first; a child ADR can add a CDP collector behind the same channel.

---

## Decision

Adopt **Option A**.

### D1 · The Network Collector — `lib/site-qa/collectors/network.js`

The first inhabitant of the Collector layer, and the first module in this engine whose declared job is
acquisition and nothing else. It sits **above** the determinism boundary: allowed to touch the browser
and the clock, and forbidden — permanently — to contain a rule, finding, severity, threshold, score or
format. Tested as a boundary condition, not merely stated (`network-ledger.test.js` asserts the module
imports no score/registry/finding/report module and contains no severity/deduction/verdict logic).

Exports `attachNetworkCollector(page, sink, { context, documentUrl, now })`, `createNetworkSink()` and
the pure `makeNetworkRecord()`. `now` is injectable so the one non-deterministic input is pinnable in a
test without the layer below ever becoming impure.

### D2 · The record

```
{ url, documentUrl, method, resourceType, status, mimeType, headers,
  sizeBytes, timing, initiator, fromCache, protocol, capturedAt, context, failure }
```

- **`initiator`, `fromCache`, `protocol` are `null`.** Not exposed by Playwright's public Response API.
  Null is the honest state and is distinguishable from a measured value; `''`/`0`/`false` would not be.
- **`sizeBytes` is a floor**, from `content-length` — absent header → `null`, never `0`. The existing
  page-weight finding already labels itself "(content-length floor)" for the same reason.
- **`status` on a failed request is `null`**, never `0`.
- **`url` strips the fragment only.** Query is load-bearing for a request identity, so this is
  deliberately *not* the aggressive page-URL normalisation in `lib/fingerprint.js`.
- **`documentUrl`** exceeds the minimum field set on purpose: a request that cannot say which page
  asked for it is nearly useless for per-page weight, third-party attribution or payload deltas.
- **Bounded at `RECORD_CAP = 600` per run, and truncation is declared** (`sink.capped`), consistent
  with every other bound in the engine. A truncated ledger must say so rather than under-report.

### D3 · `collected[]` — collection schema 1.0 → 1.1

A Collection now carries the explicit list of channels a collector actually populated, and
`wasCollected(collection, channel)` is the only sanctioned way to ask. An empty channel no longer has
to carry two meanings. A 1.0 collection has no declaration, which reads as "nothing declared" — the
safe direction. `fromPages()` declares `staticPages`, because a legacy caller has by definition just
crawled.

### D4 · The Network Provider

Registered as the eighth provider. Pure: no browser, no filesystem, no clock, no scoring, no
formatting.

- **Identity = `method + ' ' + url`.** Repeat requests collapse to one item and are counted.
- **The item carries LESS than the record.** `timing` and `capturedAt` stay in the collection; the item
  holds `recordIndexes: [...]` pointing back at them. That index-not-copy seam is what keeps the
  inventory reproducible, and it is the shape ADR-0007's Evidence Ledger will formalise.
- **Undeclared channel → zero items, no claim.** It does not throw: a static-only crawl legitimately
  has no network channel, and every existing caller is exactly that. The distinction survives for
  consumers through `wasCollected`.
- **Fails closed** on a non-Collection input and on a malformed record (a record with no URL throws
  rather than being silently dropped — a ledger that drops unreadable rows under-reports while looking
  complete).

### D5 · Wiring, and why it cannot move a finding

`checks-render.js` attaches the collector inside `watchPage` alongside the existing listeners and
returns `network` / `networkCapped` on the render result. `totalBytes`, `reqCount`, `failed`,
`consoleErr` and every finding path are untouched. The collector's own listeners are individually
try/caught: a collector must never break the run it is observing.

### D6 · `id-registry` prefix `network → NET`

Additive. The registry throws on an unknown type rather than inventing an ID scheme — that guard is
what caught the provider arriving before its prefix did, during this implementation.

### D7 · No consumer

No rule, view, report or score reads `collection.network` in this ADR. HAR export, waterfalls, CDN
detection, cache recommendations, third-party views and performance scoring are **consumers** and are
explicitly out of scope. Collector → Collection → Provider only.

---

## Consequences

**Positive**
- Data observed and discarded on every scan since 2.0 is retained, at no additional browser cost.
- ADR-0004 acceptance criterion 3 is satisfied with a real end-to-end path.
- The Collector layer physically exists, with a tested boundary, instead of being a diagram.
- `collected[]` closes the "never looked vs looked-and-clean" ambiguity at the acquisition boundary,
  before any consumer can inherit it.
- Third-party attribution, cache/compression audit, waterfall, HAR and migration payload deltas each
  become a *view over existing data* rather than a new acquisition system.

**Negative / trade-offs**
- `protocol`, `fromCache` and `initiator` are null until a CDP collector exists. Stated in the data,
  not hidden.
- `RECORD_CAP` can truncate a pathological page. Declared via `sink.capped`; no consumer exists yet to
  surface it.
- Records are retained per run in memory. Bounded by the cap; persistence is ADR-0008's problem.
- **Only `NetworkProvider` validates its input** (`assertCollection`). The other seven providers are
  always called from `buildInventory` with a real Collection, so generalising the seam validator to all
  eight is deferred rather than done — recorded here so it does not become invisible debt.

**Migration / version impact**
- `COLLECTION_SCHEMA_VERSION` 1.0 → 1.1 (additive) in `version.js`, the single authority (ADR-0004 §D6).
- `PROVIDER_CONTRACT_VERSION` unchanged — the contract shape did not move, only what fills it.
- **No engine / registry / report / package version moved. No user-visible behaviour changed, so no
  release is due.**

---

## Evidence

| # | Evidence | Result |
|---|---|---|
| N1 | `inventory/network-ledger.test.js` | ✅ **51/51** |
| N2 | Real end-to-end: local http server + real Chromium + real collector → Collection → Provider → Inventory | ✅ in N1 (document, stylesheet, script and a real 404 all in the ledger with true status/MIME/size) |
| N3 | Determinism: same requests with **different** `capturedAt` and `timing` → byte-identical items; no wall-clock or timing string in any item | ✅ in N1 |
| N4 | Fail-closed: bare array throws · malformed record throws · unknown channel declaration throws · "collected-empty" distinguishable from "never collected" | ✅ in N1 |
| N5 | Unavailable stays unavailable: `protocol`/`fromCache`/`initiator` null, absent size null not 0, failed-request status null not 0, no field uses `''` | ✅ in N1 |
| N6 | Boundary: the collector imports no score/registry/finding/report module and contains no severity/deduction/verdict logic | ✅ in N1 |
| N7 | Frozen scope (§D9): 142 rules · weights 100 · registry 1.13.0 · engine 2.3.0 · report 1.4.0 all unmoved | ✅ in N1 |
| N8 | ADR-0004 A1 golden still holds with the eighth provider registered | ✅ `contract-parity.test.js` **32/32** |
| N9 | Full suite before vs after | see §Acceptance |

---

## Acceptance

**PROPOSED until the evidence above is reviewed.** Same discipline as ADR-0004: ACCEPTED means
demonstrated, not intended.

**Acceptance criteria:**

1. Collector exists, is acquisition-only, and its boundary is tested rather than asserted. — **met (N1, N6)**
2. Provider consumes `collection.network`, is pure, and is deterministic across runs. — **met (N1, N3)**
3. One collector/provider pair flows end-to-end against a real browser. — **met (N2)**
4. Fails closed on bad input; unavailable fields remain unavailable. — **met (N4, N5)**
5. No registry, finding-schema, scoring, report or event-model change. — **met (N7, N8)**
6. No consumer built. — **met (D7)**

**On promotion of the parent:** ADR-0004 criterion 3 is the one this work exists to close. Once N1–N9
are reviewed, **ADR-0004 may move PROPOSED → ACCEPTED** (its criteria 1, 2 and 4 were met at A1), and
ADR-0005 may move with it. Neither is promoted by this document.

---

## Related

- **ADR-0004** — governing architectural decision. This ADR is its first implementation child.
- **ADR-0006** (Document Asset Inventory) — the sibling collector/provider pair; would satisfy the same
  parent criterion independently.
- **ADR-0007** (Evidence Ledger) — will formalise the index-not-copy seam this ADR uses for records.
- **ADR-0008** (Collection Store & Replay) — will persist and seal collections; `RECORD_CAP` retention
  and manifest sealing belong there.
