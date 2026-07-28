# ADR-0010 — Replay Engine · D6 Single Version Authority · Producer Wiring

- **Status:** PROPOSED (2026-07-28) — promoted to ACCEPTED only on demonstrated implementation; criteria in §Acceptance
- **Date:** 2026-07-28
- **Deciders:** Jerome (product) · auditor
- **Governed by:** **ADR-0004** (§D3 determinism boundary · §D4 adjacency · §D6 version authority · §D9 frozen scope) · consumes **ADR-0007/0008/0009**
- **Affects:** new `replay/` · new `version-authority.js` · `version.js` · `contract.js` · `lib/report-contract.js` · `capture.js` (rename only) · `audit.js` (opt-in producer) · `release-metadata.json` (regenerated) · `testing/foundation.test.js`
- **Does NOT affect:** registry contract · finding schema · report rendering · scoring model · event model · provider contract · collection schema

---

## Part 1 — Replay Engine

### Context

ADR-0004 §D3 promised replay when it drew the determinism boundary. ADR-0009 sealed the collections.
This is the first reader of them.

### The scoping fact this ADR must state plainly

**No rule consumes a collection today.** `audit.js` and `checks-static.js` are page-first: they take
crawl pages and a live browser, not a collection. ADR-0004 §5 recorded this as known debt; ADR-0006
§Consequences recorded `render-blocking` as the surviving instance.

Therefore **finding-level replay is not implementable** without first migrating the rules layer to be
an inventory consumer — which no ADR in force authorises. What *is* deterministic today is the layer
ADR-0004 put below the boundary: **Providers → Inventories**.

This engine replays that, and **claims nothing more**. The limitation is asserted in the suite (§8:
the replay result is checked to contain no `findings`, `score` or `quality`) rather than left in prose,
so a future reader cannot mistake the scope.

### Decision

**Mode A · Reproducibility** — same collection + same provider set → byte-identical inventories,
content-addressed so two replays are compared by hash, not by eye. A **fresh `IdRegistry` per replay**,
deliberately: ids must be reproducible from the collection alone, and a shared registry would let a
previous run's mint order leak in.

**Mode B · Impact** — same collection + a different provider set → added / removed / changed /
unchanged. Diffed by **`identityKey`, never by minted id**: ids are assigned in enumeration order, so
including them would report positional churn as semantic change.

**Read-only, structurally.** The reconstructed collection is **deep-frozen** before any provider sees
it. Asserted by source scan: no `writeFileSync`/`appendFileSync`/`mkdirSync`/`renameSync`, no `Date`,
no `Math.random`, no browser.

**Fail closed, three distinct refusals** — unsupported schema · a provider sealed into the collection
that no longer exists · a damaged collection. Precedence is asserted: **integrity is checked first**,
so a tampered record is refused before its schema is even considered.

### Two design faults the tests caught, and the corrections

1. **`deepFreeze` early-returned on an already-frozen object.** `makeCollection` freezes the container
   and each channel *array*, so the guard short-circuited before reaching the records inside — every
   element stayed mutable while the collection *looked* sealed. Now: freeze, then always descend, with
   a `seen` set for cycles.
2. **The fail-closed provider guard made Mode B unreachable.** Refusing a missing provider is correct
   for Mode A (a missing provider invalidates a reproduction claim) but wrong for Mode B, where a
   *different* provider set is the entire purpose. The guard is now mode-aware: Mode A enforces it;
   Mode B allows divergence on **both** sides — because the caller has *named* both sets, so neither is
   silently pretending to be the sealed computation — and the divergence is **reported** in the result.

---

## Part 2 — D6 · Single Version Authority

### The drift, measured before the change

| Site | Declared | Note |
|---|---|---|
| `contract.js` | `CONTRACT_VERSION = '1.0'` | its own literal |
| `release-metadata.json` | `"contractVersion": "1.0.0"` | **same stream, different value** |
| `lib/report-contract.js` | `\|\| '1.0'` fallback | a **third** declaration |
| `testing/foundation.test.js` | asserted `REPORT_VERSION === '1.3.0'` | stale since the 4.4.0 release — **this is why the suite had been red** |
| `capture.js` | `let ENGINE_VERSION = '1.0.1'` | a **different stream wearing the authority's name** |

### Decision

**`version.js` is the authority.** It now declares `CONTRACT_VERSION` too; `contract.js` and
`report-contract.js` import it. `REGISTRY_VERSION` stays owned by the registry and imported — the
established single-declaration pattern D6 generalises.

**Authority resolution for the contract stream: `'1.0'` wins.** It is the value every stored contract
and every historical report already carries; `release-metadata.json` is the *derived* artifact and
follows. The other way round would have rewritten real output to satisfy a metadata file that **no
JavaScript in this engine reads**.

**`capture.js`'s local renamed to `CAPTURE_ENGINE_VERSION`.** It never held the engine version — it
holds the capture pipeline's own — but the name collided with the authority's stream, misleading
readers and defeating drift detection. **Local rename only**; the emitted `engineVersion` field is
unchanged, so capture provenance is byte-identical.

**`foundation.test.js` no longer restates literals.** A test that re-declares a version *is* a second
authority — which is exactly how it sat red on a stale `1.3.0`. It now asserts stream *shape* and that
consumers agree with the authority.

**`version-authority.js`** derives `release-metadata.json` and **scans the whole tree — test files
included — for any file that re-declares a stream**. The scanner is proven capable of catching one (a
probe is written, detected, removed), so its silence is evidence rather than absence.

---

## Part 3 — Producer Wiring

`runAudit(url, { collectionRoot })` seals the acquisition. **Opt-in**: with no root, nothing is
constructed, nothing is written, and the run is byte-identical. It runs **last, after the result is
fully built**, so it cannot influence what it records, and it is **fully guarded** — an unpersistable
collection must never fail an audit that genuinely succeeded.

**No consumer.** `audit.js` is asserted to neither import nor call `replay()`.

---

## Evidence

| # | Evidence | Result |
|---|---|---|
| R1 | `replay/replay.test.js` | ✅ **58/58** |
| R2 | Mode A byte-identical across two replays, and across a separately sealed copy of the same acquisition | ✅ in R1 |
| R3 | Read-only: record + manifest byte-identical after replay; collection deep-frozen; no clock/random/browser/write in source | ✅ in R1 |
| R4 | Mode B: identical sets → no drift · dropped provider → exactly its items removed · re-added → added · same identity + different meta → **changed**, never add/remove · diff deterministic | ✅ in R1 |
| R5 | Fail-closed, each distinct: unknown schema (on an intact record) · missing sealed provider · damaged collection · **precedence — integrity refused before schema** | ✅ in R1 |
| R6 | Scope: replay returns no `findings`/`score`/`quality` | ✅ in R1 |
| V1 | `version-authority.test.js` | ✅ **35/35** |
| V2 | **Zero duplicate stream declarations tree-wide**, and the scanner proven able to catch one | ✅ in V1 |
| V3 | `release-metadata.json` agrees with the authority (`contractVersion` was `"1.0.0"` vs `'1.0'`) | ✅ in V1 |
| V4 | `foundation.test.js` — **was 9/10 red, now 15/15** | ✅ |
| P1 | `collection-store/producer.test.js` | ✅ **30/30** |
| P2 | **Real `runAudit` against a real local server, with and without persistence → byte-identical result.** Only two fields ever differed: the run timestamp and `projectionMs` (a `Date.now()` duration), both normalised | ✅ in P1 |
| P3 | Collection written · verified · rebuilt byte-identically · replayable; `audit.js` neither imports nor calls replay | ✅ in P1 |
| S1 | **Full suite: 48/48 — ALL SUITES PASS** (was 45 suites / 1 known failure) | ✅ |
| S2 | ADR-0008 on-disk oracle re-run: 31 files, SHA `a0f727d8ca5028834cdc922d63387bbbb557addf20c445e760c13a0fd60246d3` unchanged | ✅ |

---

## Acceptance

**PROPOSED until reviewed.** ACCEPTED means demonstrated, not intended.

| # | Criterion | State |
|---|---|---|
| 1 | Mode A reproduces a sealed collection exactly | **met (R2)** |
| 2 | Mode B produces added/removed/changed/unchanged | **met (R4)** |
| 3 | Replay never modifies the collection; read-only | **met (R3)** |
| 4 | Deterministic — no clock, no random, no browser | **met (R3)** |
| 5 | Fails closed on unknown schema / provider / damage | **met (R5)** |
| 6 | No registry, report or scoring mutation | **met (R1 §7, S1)** |
| 7 | One version authority; consumers import, never restate | **met (V1, V2)** |
| 8 | Generated metadata matches the authority | **met (V3)** |
| 9 | Producer persists with no behaviour change | **met (P2)** |
| 10 | Full suite green | **met (S1)** |

**NOT claimed — stated as a limitation, not an omission:** finding-level replay, certification replay,
historical comparison, rule execution over stored collections, impact analysis on *findings*, storage
optimisation, report consumers. All require the rules layer to become an inventory consumer, which is
the next architectural decision and belongs to its own ADR.

**ADR-0004 through ADR-0010 all remain PROPOSED.** See `ACCEPTANCE-REVIEW.md` for the per-criterion
review and why the status field itself is not mine to move.

---

## Related

- **ADR-0004 §D3/§D6** — the promises this ADR discharges.
- **ADR-0009** — supplies the sealed collections replay reads.
- **Next (own ADR):** migrate the rules layer to consume inventories. That single change is what makes
  finding-level replay, certification replay and impact-on-findings possible — and it is the last
  structural item before capability work.
