# ADR-0004 — Layered Acquisition Architecture

- **Status:** PROPOSED (2026-07-28) — promoted to ACCEPTED only on demonstrated implementation; criteria in §Acceptance
- **Date:** 2026-07-28
- **Deciders:** Jerome (product) · auditor
- **Affects:** runtime flow · provider contract · versioning · (no change to registry contract, finding/rule/report schemas, event model, or scoring model)
- **Parent of:** ADR-0005 (Network Ledger) · ADR-0006 (Document Asset Inventory) · ADR-0007 (Evidence Ledger) · ADR-0008 (Collection Store & Replay) · ADR-0009 (Immutable Store Extraction)

> This ADR is deliberately **architectural**. It fixes the layer model, the contracts between layers,
> and the invariants that govern them. Every primitive it enables gets its own child ADR; this one must
> stay stable while those evolve.

---

## Context

### 1 · The specification and the implementation disagree

`QA-SPECIFICATION.md` Part 6 is binding on implementation and states the model plainly:

> *"the engine must be **inventory-driven**. Every audit, comparison, and certification operates on
> inventories … as the source of truth — **one detection pass, many consumers**."*

and specifies the interface as:

> *"Introduce a Provider interface — `enumerate(ctx) → items[]` …"*

The implementation narrowed `ctx` to static crawl records. `inventory/index.js` calls:

```js
const raw = provider.enumerate(pages, host);   // pages = { url, body, headers, status }
```

That one-word drift is load-bearing. A provider can see raw HTML and response headers, and **nothing
else** — no render, no network, no console, no fonts, no DOM geometry.

### 2 · The drift has already parked an implementation

`inventory/providers.js:190`:

```js
const ComponentProvider = { type: 'component', enumerate() { return []; } };
```

and `providers.js:6` says why:

> *"Component-level enumeration is **RESERVED** (needs the render-time element read)."*

Seven providers are registered; one is a permanent stub because the contract cannot carry what it
needs. This is not a missing feature — it is the contract refusing a legitimate provider.

### 3 · Multiple planned capabilities are blocked on the same wall

A Network Ledger, a Document Asset Inventory, a console inventory, a font inventory and any
render-derived provider all need acquisition data the current contract cannot pass. Without this ADR
each one either creates a special case around the provider layer, or ships its own collector — which
reproduces the exact duplicated acquisition that Part 6 exists to prevent.

### 4 · Acquisition data is being collected and discarded

`checks-render.js:382-395` attaches listeners to every request and response on every scan, then
retains only aggregates:

```js
pg.on('response', r => { …; if (cl > 0) totalBytes += cl; });   // record discarded
if (weigh) pg.on('request', () => { reqCount++; });             // URL discarded
```

`checks-static.js:322-335` (`render-blocking`) parses `<head>` for stylesheets and scripts with
`async`/`defer`/`module` filtering, extracts `href`/`src` — and discards all of it when `n < 4`.

The data required by several planned capabilities already flows through code that runs on every scan.
It has nowhere to be stored because there is no layer that owns acquisition.

### 5 · The current runtime flow does not separate acquisition from analysis

Measured, not asserted:

| File | Acquires | Analyses | Evidence |
|---|---|---|---|
| `checks-render.js` | browser events (`pg.on(...)` :383-395) | emits findings (`F(...)` :432, :448, :545, :547, :550, :556) | collector and rule engine in one function |
| `audit.js` | crawls (:472) | assembles rows, enriches (:840), scores (:872), builds coverage (:904) | four layers in one orchestrator |
| `visual-match.js` | crawls, captures, reads DOM | diffs, emits VIS findings | full stack in one module |
| `report.js` | — | renders | reads `data.shots` (:855), `data.pageCoverage` (:941), `data.crawl.pages` (:1008) — the report reaches past findings into collection facts and artifacts |

This is stated as fact, not blame: the engine grew check-first, and every one of these files is
correct and well-tested at what it does. But the layering this ADR adopts **is not what the code does
today**, and any claim otherwise would be false.

### 6 · Constitutional forces in tension

- **Determinism** (`CHARTER.md` §1) — external reference metrics (Lighthouse, PSI, CrUX) are wanted
  as *reference data* but must never reach the certification score.
- **Architecture Freeze** (`ARCHITECTURE.md` §13) — runtime-flow changes require an ADR. This is that ADR.
- **Additive growth** (ADR-0001 §4) — the change must not reshape the frozen core.
- **Reproducibility** — currently means "same site → same score", which is only testable while the site
  is unchanged. Certification needs a stronger, replayable form.

---

## Options

**A — Widen the provider contract additively, and formalise five layers. (recommended)**
`enumerate(collection, ctx)` where `collection` carries every acquisition channel. Existing providers
receive `collection.staticPages` and are byte-identical. New providers consume richer channels.
Layer invariants and boundary contracts become constitutional.

**B — Leave the contract; give each new capability its own collector.**
No ADR needed, fastest to first feature. Rejected: it is precisely the duplicated acquisition Part 6
forbids, and it converts a one-time contract change into permanent per-feature crawl logic. Seven
capabilities → seven crawls of the same site.

**C — Replace the provider contract outright (`enumerate(collection)`, no compatibility path).**
Cleanest end state. Rejected as sequencing, not as design: it invalidates golden parity on the seven
existing providers in the same change that introduces new ones, so a regression could not be
attributed. Option A reaches the same end state with an attributable path.

---

## Decision

Adopt **Option A**.

### D1 · The layer model

```
                    EXTERNAL WORLD
        browser · network · clock · OS · external APIs
                          │
                          ▼
  ┌───────────────────────────────────────────────────┐
  │  COLLECTORS          the ONLY layer permitted to  │
  │                      touch the external world     │
  └───────────────────────────────────────────────────┘
  ══════════════ DETERMINISM BOUNDARY ══════════════════
  ┌───────────────────────────────────────────────────┐
  │  COLLECTIONS (sealed, immutable, addressable)     │
  │        ▼                                          │
  │  PROVIDERS        →  INVENTORIES                  │
  │        ▼                                          │
  │  RULE ENGINE      →  FINDINGS                     │
  │        ▼                                          │
  │  VIEWS            →  VIEW MODELS                  │
  │        ▼                                          │
  │  REPORTS · CERTIFICATION                          │
  └───────────────────────────────────────────────────┘
              everything below the line is PURE
```

### D2 · The provider contract (additive)

```
enumerate(collection, ctx) → items[]

collection = {
  staticPages[],   // today's `pages` — unchanged
  documents[],     // parsed head+body asset inventory        (ADR-0006)
  network[],       // per-request records                     (ADR-0005)
  render[],        // per page×viewport DOM/geometry read     (unblocks ComponentProvider)
  console[], fonts[], shots[]
}
```

Existing providers are migrated by passing `collection.staticPages` where `pages` was passed. Golden
parity must hold byte-identically across that migration; the seven registered providers are the test.

### D3 · The determinism boundary (constitutional)

**Only collectors may touch the external world.** Every layer beneath the boundary is a pure function
of the layer above it.

Consequences, which are the point of stating it:

1. **External metrics get a legal home.** Lighthouse, PSI and CrUX are *collectors* tagged
   `deterministic: false`. Their output may be carried in a collection and rendered as reference data.
   It is **not eligible to feed a scored rule** unless a child ADR defines a deterministic
   transformation. §F of the product roadmap ("never blended into certification") stops being a
   discipline to remember and becomes a property of the architecture.
2. **Reproducibility gets a testable definition.** It becomes **"same collection → same score,
   forever"** — provable without the site being available, which is what certification requires.
3. **Replay becomes possible.** A sealed collection plus a pure stack can be re-executed with no crawl.

### D4 · The adjacency invariant (constitutional)

**Every layer may consume only the layer immediately beneath it.**

| Prohibited | |
|---|---|
| Rules inspecting browser events | Views executing providers |
| Reports inspecting collections | Providers computing findings |
| Collectors assigning severity | Any layer skipping the one beneath it |

This is enforceable in CI as a dependency check, and it is the rule that prevents the erosion the
current codebase already shows (§5 above).

### D5 · Versioned boundary contracts

Each boundary is an immutable data contract carrying its own schema version:

```
Collector → Collection      collectionSchemaVersion
Collection → Provider       providerContractVersion
Provider  → Inventory       inventorySchemaVersion
Inventory → Rule            (registry contract — FROZEN, ADR-0001)
Rule      → Finding         findingContractVersion   (ADR-0003, exists)
Finding   → View            viewModelVersion
View      → Report          reportVersion            (exists)
```

Future change to any boundary is an **additive versioned contract**, never a behavioural change hidden
inside an implementation.

### D6 · Single version authority (prerequisite for sealing)

> **The platform SHALL expose one authoritative source for all version streams used in manifests and
> replay compatibility. All derived metadata SHALL be generated from that authority.**

The invariant is constitutional. **The implementation is not prescribed here.**

*Why this is in scope rather than its own ADR:* version authority is not an independently useful
architectural capability. It exists solely to make sealing, replay, reproducibility, manifest
validation and compatibility checking sound — without it, those guarantees are unsound. It is a
dependency of this ADR, not a neighbour of it.

*Why it is a prerequisite and not a cleanup:* the drift already exists, and replay is unforgiving of
metadata drift — a replay failure caused by drift is indistinguishable from a genuine incompatibility.

| Source | Streams | Note |
|---|---|---|
| `version.js` | 3 — ENGINE, REPORT, REGISTRY | contract version **absent** |
| `release-metadata.json` | 5 — package, engine, registry, contract, report | `contractVersion: "1.0.0"` |
| `contract.js:16` | owns it | `CONTRACT_VERSION = '1.0'` |

`'1.0'` vs `'1.0.0'` — one stream, two values, two files. Inert while nothing compares them; a false
"not replayable" the moment a manifest seals it. **The invariant SHALL hold before any manifest is
sealed.**

### D7 · Fail-closed validators at every seam

Each boundary validates its own inputs and outputs and **throws** on violation — the pattern already
proven by `registry.validate()` (fail-fast at load) and `assertTransition()` (fail-closed lifecycle):

```
Collector → collection validator → Provider → inventory validator →
Rule → finding validator → View → view-model validator → Report
```

Rationale, from measured history: the platform's most serious defect class is a contract honoured in
one file and dropped in the next (`audit.js:872` declares the evaluated rule set;
`pipeline.js rescore()` calls `compute(suites)` and discards it). Five layers create four seams.
Seams are defended structurally, never by discipline.

### D8 · Store consolidation precedes new stores

Content-addressing, append-only semantics, rebuildable indexes and integrity verification are
**infrastructure concerns, not application concerns**. Four independent implementations exist:

| Store | Machinery |
|---|---|
| `scan-store/` | digest · integrity · store · record · diff · history |
| `finding-store/` | digest · integrity · store · record · diff · history |
| `regression/` | digest · integrity · store |
| `timeline/` | digest · integrity · snapshot |

They have already diverged (`integrity.js` 86 vs 101 lines; `store.js` 154 vs 220). Collection Store
and Evidence Ledger would make six. **The shared base is extracted first (ADR-0009)**, proven against
the four existing stores' regression evidence (E11 56/56 · E12 60/60 · E13 38/38 · E14 32/32), then
instantiated for the two new ones. Integrity guarantees that mean different things in different stores
are not integrity guarantees.

### D9 · Scope — what this ADR does NOT change

Unchanged and still frozen: the **registry contract** · the **finding, rule and report-summary
schemas** · the **event model** · the **scoring model** · rule identity (native `ruleId`, ADR-0002) ·
the Finding Contract (ADR-0003). No rule is rewritten. No deduction or weight moves. Golden parity is
the gate on every step.

---

## Acceptance

**This ADR remains PROPOSED until the core architectural change is demonstrated by implementation.**
After an Architecture Freeze, ACCEPTED must mean the organisation has committed to the architecture
**and** that its critical claims have been exercised — not intent alone. The programme need not be
finished.

| Status | Meaning |
|---|---|
| **PROPOSED** | architecture approved conceptually |
| **ACCEPTED** | architecture proven on at least one implementation path |
| child ADRs (0005–0009) | individual implementations, each governed by this ADR |

**Acceptance criteria — narrow, and deliberately so:**

1. The provider contract is widened **without breaking the seven existing providers**.
2. Existing provider outputs are **byte-identical** — golden parity holds (A1).
3. **One** new collector/provider pair — Network Ledger (ADR-0005) *or* Document Asset Inventory
   (ADR-0006) — flows end-to-end through the new architecture.
4. **No change** to the registry contract, finding schema, scoring model or event model beyond those
   explicitly permitted in D9.

ADR-0005 through ADR-0009 may remain OPEN at the point of acceptance.

**Procedure:**

```
leave PROPOSED
  → implement the provider-contract widening
  → prove parity (A1)
  → review the evidence
  → promote ADR-0004 to ACCEPTED
  → open ADR-0005..0009 as implementation ADRs, each referencing
    ADR-0004 as their governing architectural decision
```

This preserves the Architecture Freeze while keeping the governance record a statement of
*demonstrated* architecture rather than intent.

---

## Consequences

**Positive**
- Part 6's "one detection pass, many consumers" becomes structurally true rather than aspirational.
- `ComponentProvider` is unblocked; render-derived providers become possible at all.
- Acquisition data already collected stops being discarded.
- External reference metrics gain a home that cannot contaminate certification.
- Reproducibility strengthens from "same site" to "same collection", and replay enables certification
  dispute resolution and registry impact analysis.
- Future capabilities are consumers of shared collections; none introduces acquisition logic.

**Negative / trade-offs**
- The layer model **describes a target, not the current code** (§5). Migration debt is real and is
  recorded as such, not glossed: `checks-render.js` (collector+rule), `audit.js` (four layers),
  `visual-match.js` (full stack), `report.js` (reaches past findings into collection facts and
  artifacts). Each is retired under a child ADR, never in one sweep.
- Collections and evidence centralise storage growth. **Retention policy is decided here, not later:**
  sealed certification collections are exempt from pruning; all others are prunable on a configurable
  window; `ops/` (built, tested, currently zero callers) becomes the module that manages it.
- Five layers is more indirection than a check-first engine. Justified only because the seam validators
  (D7) make the indirection enforceable.

**Migration / version impact**
- Provider contract: additive; existing seven providers unchanged in behaviour.
- Engine version: minor bump when the contract widens. Registry: unchanged. Report: unchanged.
- Backward compatibility: an old `report.json` is unaffected — no consumed shape changes.

**Delivery constraint (binding on the child ADRs)**
Infrastructure ships interleaved with user-visible capability; no wave is infrastructure-only. The
dual-side audit depends on nothing in this ADR (it is `runAudit` twice plus a diff) and ships in the
first wave, so the programme's highest-value capability is not gated behind its foundations.

---

## Evidence (to attach on implementation)

| # | Evidence | Proves |
|---|---|---|
| A1 | Golden parity byte-identical after the contract widens | the seven existing providers are unaffected |
| A2 | `ComponentProvider` returns non-empty from a render collection | the drift is genuinely closed |
| A3 | Full suite green (`testing/run-all.js`) at each wave | no regression to the frozen core |
| A4 | Immutable-store extraction re-verified against E11/E12/E13/E14 | consolidation is behaviour-preserving |
| A5 | Version-authority test: one source, no `'1.0'`/`'1.0.0'` divergence | manifests can be sealed safely |
| A6 | Replay a sealed collection → byte-identical score, no network | "same collection → same score" holds |
| A7 | CI dependency check: no layer imports below its adjacent layer | D4 is enforced, not merely stated |
| A8 | Seam validators reject a malformed contract at each boundary | D7 fails closed |

---

## Related

- `QA-SPECIFICATION.md` Part 6 — the inventory-driven mandate this ADR reconciles with the implementation.
- **ADR-0001** — constitutional architecture; §4 additive-consumer rule this change relies on.
- **ADR-0002** — native rule IDs; identity is untouched here.
- **ADR-0003** — Finding Contract v1; becomes the Rule→Finding boundary contract in D5.
- **Prior art for D5/replay:** `regression/` already stores the full resolved policy in every verdict
  record so a gate decision reproduces exactly, while a new policy can be applied to the same data for
  comparison (E14, 32/32). Reproducibility-replay and impact-replay are the same pattern, generalised.
