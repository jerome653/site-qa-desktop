# Acceptance Review — ADR-0004 … ADR-0010

- **Date:** 2026-07-28
- **Reviewer:** auditor (implementation session)
- **Suite state at review:** **48/48 — ALL SUITES PASS**
- **Outcome:** every criterion across all seven ADRs is objectively demonstrated. **All seven remain PROPOSED.**

---

## Why the status field is not moved here

Every criterion below is met and evidenced. The status field is still not changed, for one reason
stated plainly rather than buried:

**I wrote these ADRs, the implementations, and the tests that evidence them.** CREED tenet 4 — *"a
status field moves to done only on external evidence, not on your say-so; if you wrote it, you cannot
also be the one who certifies it true"* — makes self-promotion invalid regardless of how complete the
evidence is. Each ADR also names **Jerome (product)** as a decider, and each says *"promoted to ACCEPTED
only on demonstrated implementation"*.

So this document does the **review** and records the evidence; the **promotion** is a signature, and it
is his. The instruction "only promote if every criterion is objectively demonstrated" is satisfied on
the evidence side; the remaining step is a second pair of eyes, which is the entire point of the rule.

**Recommendation:** promote ADR-0004 → ADR-0010 to ACCEPTED. Nothing is outstanding on the evidence.

---

## ADR-0004 — Layered Acquisition Architecture

| # | Criterion | Evidence | Verdict |
|---|---|---|---|
| 1 | Provider contract widened without breaking the seven existing providers | `contract-parity.test.js` 33/33 | ✅ |
| 2 | Existing provider outputs byte-identical | golden `82c2ea07b97e1232b97cd215c2787fc4ce67d8146a6095cbaa32139a89c8693d`, verified against a pre-widening capture | ✅ |
| 3 | One new collector/provider pair end-to-end | ADR-0005 (real Chromium) **and** ADR-0006 (real Chromium) — two independent demonstrations | ✅ |
| 4 | No registry / finding-schema / scoring / event-model change beyond §D9 | asserted in every suite; registry 142 rules, engine 2.3.0, report 1.4.0 unmoved | ✅ |

**Also discharged this session:** §D6 (single version authority) — see ADR-0010 Part 2 · §D8 (store
extraction before new stores) — ADR-0008.

---

## ADR-0005 — Network Ledger

| # | Criterion | Evidence | Verdict |
|---|---|---|---|
| 1 | Collector acquisition-only; boundary tested | `network-ledger.test.js` 51/51, source-scanned for score/registry/finding/report imports | ✅ |
| 2 | Provider pure + deterministic | differing `capturedAt`/`timing` → byte-identical items | ✅ |
| 3 | End-to-end against a real browser | local server + real Chromium; the 404 asset in the ledger with its true status | ✅ |
| 4 | Fails closed; unavailable stays unavailable | bare array · malformed record · unknown channel all throw; `protocol`/`fromCache`/`initiator` null, never `0`/`''` | ✅ |
| 5 | No frozen-scope change | asserted in-suite | ✅ |
| 6 | No consumer built | ✅ | ✅ |

---

## ADR-0006 — Document Asset Inventory

| # | Criterion | Evidence | Verdict |
|---|---|---|---|
| 1 | Collector acquisition-only, non-classifying | `document-assets.test.js` 77/77 | ✅ |
| 2 | Provider pure + deterministic | clock cannot leak into items | ✅ |
| 3 | Order, head/body, attributes preserved exactly | tags in exact document order; offsets strictly increasing; `headSlice` 8000-char fallback preserved | ✅ |
| 4 | Fails closed; nulls are null | ✅ | ✅ |
| 5 | **Duplicate parse eliminated with no finding moved** | **differential vs a verbatim copy of the pre-refactor PERF-005 across an 11-document corpus incl. quirk cases — 11/11 identical** | ✅ |
| 6 | Real Chromium integration | JS-injected script visible in the rendered DOM that the static parse cannot see | ✅ |
| 7 | No frozen-scope change | ✅ | ✅ |
| 8 | No consumer built | ✅ | ✅ |

---

## ADR-0007 — Evidence Ledger

| # | Criterion | Evidence | Verdict |
|---|---|---|---|
| 1 | Content-addressed artifacts | `evidence-ledger.test.js` 59/59; `ev-` + sha256, reusing `finding-store/digest` | ✅ |
| 2 | Identical bytes de-duplicate | **measured on a real stored run: 16 files → 11 artifacts, 5 duplicates** | ✅ |
| 3 | Findings reference artifacts deterministically | ✅ | ✅ |
| 4 | **Finding identity does not move** | `fingerprint` and `id` identical with and without `artifactId`; it is the only contract difference | ✅ |
| 5 | No report/scoring/registry/event change; byte-identical when no artifact exists | field omitted entirely when absent | ✅ |
| 6 | Existing machinery reused, not duplicated | asserted by source inspection | ✅ |
| 7 | Fails closed; damage classified | `missing` vs `modified` distinct | ✅ |

---

## ADR-0008 — Immutable Store

| # | Criterion | Evidence | Verdict |
|---|---|---|---|
| 1 | Existing stores migrated onto it | 5 stores; 4 `digest.js` now 9-line adapters | ✅ |
| 2 | Behaviour byte-identical | **on-disk oracle: 31 files, SHA `a0f727d8…`, identical before/after and again at end of session** | ✅ |
| 3 | Suites green except the known failure | now **fully** green | ✅ |
| 4 | No frozen boundary crossed | no clock, no filesystem discovery, no registry/score/report import; export surface = 10 primitives | ✅ |
| 5–8 | No report / registry / scoring / event change | ✅ | ✅ |
| 9 | Evidence demonstrates parity rather than asserting it | bytes compared, not claimed | ✅ |

---

## ADR-0009 — Collection Store

| # | Criterion | Evidence | Verdict |
|---|---|---|---|
| 1 | Built on Immutable Store | `collection-store.test.js` 71/71; **inheritance asserted by prototype identity** — six methods proven the same function object and not own properties | ✅ |
| 2 | Immutable after persistence | duplicate save does not rewrite the record (file bytes compared) | ✅ |
| 3 | Manifest = compatibility facts only | record asserted to contain no replay/compatibility verdict | ✅ |
| 4 | Integrity verification passes | `modified` · `channel-modified` · forged-digest `id-mismatch` · `uncommitted` · `missing-record`, each distinct | ✅ |
| 5 | Existing behaviour byte-identical | oracle unchanged | ✅ |
| 6–9 | No report / registry / scoring / event change | ✅ | ✅ |
| 10 | No new failures | 48/48 | ✅ |

**Gap closed this session:** ADR-0009 recorded *"nothing writes to this store yet"*. A producer is now
wired (opt-in, guarded, byte-identical) — `producer.test.js` 30/30.

---

## ADR-0010 — Replay Engine · D6 · Producer

| # | Criterion | Evidence | Verdict |
|---|---|---|---|
| 1 | Mode A reproduces exactly | `replay.test.js` 58/58 | ✅ |
| 2 | Mode B added/removed/changed/unchanged | including same-identity-different-meta → **changed**, never add/remove | ✅ |
| 3 | Read-only | record + manifest byte-identical after replay; collection deep-frozen | ✅ |
| 4 | Deterministic — no clock/random/browser | source-scanned | ✅ |
| 5 | Fails closed, refusals distinct + ordered | integrity checked before schema | ✅ |
| 6 | No registry/report/scoring mutation | ✅ | ✅ |
| 7 | One version authority | `version-authority.test.js` 35/35; **zero duplicate declarations tree-wide**, scanner proven able to catch one | ✅ |
| 8 | Generated metadata matches the authority | `contractVersion` `"1.0.0"` → `'1.0'` | ✅ |
| 9 | Producer persists with no behaviour change | real `runAudit` × 2, byte-identical | ✅ |
| 10 | Full suite green | **48/48** | ✅ |

---

## Standing limitations (carried, not resolved)

Recorded so a reader does not mistake a green suite for a finished architecture:

1. **The rules layer is still page-first.** `audit.js` / `checks-static.js` consume pages and a browser,
   not inventories. This is why replay covers providers and **not findings**, and it is the single
   remaining structural item. It needs its own ADR and is the prerequisite for certification replay,
   finding-level impact analysis, and every capability that would consume a collection.
2. **`render-blocking` reaches up from a rule to a collector** (ADR-0006 §Consequences) — an ADR-0004
   §D4 adjacency breach, smaller than the duplicate parse it replaced, resolved by item 1.
3. **The four legacy stores are not `RecordStore` subclasses** (ADR-0008 §Consequences). Their
   duplicated *infrastructure* is gone; re-parenting is deferred deliberately.
4. **Only render-pass artifacts are registered** in the Evidence Ledger; visual-comparison and annotate
   artifacts are not (ADR-0007 §Consequences).
5. **Evidence dedup is of identity, not storage.** No disk has been freed; `savedBytes` is an
   opportunity measurement (ADR-0007 §D3).
6. **`capture.js` retains an internal inconsistency** noticed during D6 and left alone as out of scope:
   its fallback literal `'1.0.1'` differs from the value it falls back to
   (`SCHEMA.migrationQaEngine = '1.0.0'`). Not one of the authority's streams; recorded, not fixed.
