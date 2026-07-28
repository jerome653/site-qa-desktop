# ADR-0007 — Evidence Ledger (content-addressed artifacts)

- **Status:** PROPOSED (2026-07-28) — promoted to ACCEPTED only on demonstrated implementation; criteria in §Acceptance
- **Date:** 2026-07-28
- **Deciders:** Jerome (product) · auditor
- **Governed by:** **ADR-0004 — Layered Acquisition Architecture** (§D3 · §D4 · §D7 · §D8 · §D9)
- **Siblings:** **ADR-0005** (Network Ledger) · **ADR-0006** (Document Asset Inventory)
- **Affects:** new `evidence-ledger/` store · `contract.js` (additive field) · `checks-render.js` (registration) · `audit.js` + `lib/report-contract.js` (pass-through)
- **Does NOT affect:** registry contract · finding schema (additive per ADR-0003's own `additionalProperties: true`) · report rendering · scoring model · event model

---

## Context

### 1 · Evidence exists; addressing does not

The engine already produces evidence and already has most of a ledger — pointed at the wrong objects:

| Existing | Where | What it addresses |
|---|---|---|
| `sha256()` + canonical serialisation | `finding-store/digest.js` | scans and findings, **not artifacts** |
| `evidenceName()` | `evidence-name.js` | the canonical `page--section--component--issue--viewport.png` name |
| `packageFor()` / `collectEvidence()` | `inventory/evidence.js` | the evidence *package* (detection confidence, Complete/Partial/Unavailable), fail-closed to `MANUAL_VERIFICATION_REQUIRED` |
| `stableCapture()` | `capture.js` | capture provenance (fontsLoaded, lazyLoadPass, imageDecode, documentHeight) |

What was missing was never the hashing. It was **addressing**. `contract.js` stored a finding's evidence as a bare basename:

```js
screenshot: f.evidence ? String(f.evidence).split(/[\\/]/).pop() : (opts.screenshot || null),
```

A basename is not an identity. It cannot be verified, cannot be de-duplicated, and stops resolving the moment a report directory is copied — a bug this product has already paid for once, recorded in the 4.5.0 release note about annotate showing every screenshot as broken after a run was moved.

### 2 · The duplication is real, and measured

Registering the screenshots of one **actual stored run** from this repository:

```
127.0.0.1-62658-1783648667329:  16 files → 11 artifacts, 5 duplicates, 1940 bytes deduplicable
```

31% of the files in a real run are byte-identical to another file in the same run. That is measured on stored output, not on a fixture — a fixture can be built to agree with whatever the code does.

### 3 · `report.js` already hit the consequence

`report.js` carries its own note about a self-contained report reaching **62.27 MB of base64**, and a JPEG-preview fallback added to work around it. Single-copy evidence is the structural answer to that; this ADR is its prerequisite.

---

## Problem

Give artifacts stable, verifiable, content-based identities and let findings reference them —
**without** changing report rendering, scoring, the registry, the event model, or the bytes of
`report.json` for any run that has no artifacts.

Two specific hazards:

1. **Adding a field to the frozen finding contract.** ADR-0003 froze the contract. Any new evidence
   field risks either violating the freeze or silently changing every stored report's shape.
2. **Changing finding identity.** `fingerprintOf()` is computed *from* the evidence object. If an
   artifact reference leaked into the fingerprint, every finding id in the product would move, and
   history, regression baselines and certification replay would all break at once.

---

## Decision

### D1 · A content-addressed ledger — `lib/site-qa/evidence-ledger/`

`artifactId = 'ev-' + sha256(bytes)`. The id **is** the integrity check: identical pixels on two
machines produce the same id; one changed byte produces a different one. Filename-safe by construction
(no colons), because these ids end up in paths.

### D2 · Wire, do not duplicate

- Hashing is **imported** from `finding-store/digest.js`, so an artifact hashes the way a scan and a
  finding hash. Not reimplemented — asserted in test.
- Naming is **imported** from `evidence-name.js`, so a ledger record and the file on disk describe
  themselves identically. Not reimplemented — asserted in test.
- `stableCapture()` provenance is **carried** into the record, not recomputed.
- `inventory/evidence.js` is **untouched**: it describes what a finding *means*; this describes what an
  artifact *is*. They compose; neither replaces the other.

### D3 · Deduplication of IDENTITY, not yet of STORAGE

Two paths with identical bytes collapse onto **one** artifactId carrying both paths. Nothing is copied,
moved or deleted — files stay exactly where `checks-render.js` wrote them and `report.js` reads them
from there, which is why there is no report change.

`manifest().bytes.savedBytes` measures the saving that single-copy storage **would** realise. It is
labelled as an opportunity, not as disk freed. Physical single-copy storage belongs to ADR-0008, when
the ledger owns storage. Claiming it now would be claiming a saving that has not been made.

### D4 · Findings reference artifacts — additively, and without moving identity

`contract.js` gains `evidence.artifactId`, **present only when an artifact was registered**. Two
consequences, both verified rather than asserted:

- A run with no ledger — every static-only scan, and every historical report — emits a
  **byte-identical** contract. The field cannot appear as a `null` and quietly change `report.json`.
- **Finding identity does not move.** `lib/fingerprint.js normalizeEvidence()` reads only
  `evidence.value` / `evidence.detail`, so an artifact reference cannot enter the fingerprint. The test
  asserts `fingerprint` and `id` are identical with and without the field, and that the artifactId is
  the *only* difference anywhere in the contract.

No schema change is required or made: ADR-0003's contract declares `"additionalProperties": true` and
describes itself as "additive + backward-compatible". The test asserts that permission rather than
assuming it.

### D5 · Registration happens in the collector layer

`checks-render.js` registers each artifact as it writes it — full-page captures (carrying their
`stableCapture` provenance) and per-issue element shots — and stamps `finding.evidenceArtifactId`.
`renderPass` returns `evidence: ledger.manifest()`. Every call is guarded: a ledger failure must never
retract a measurement that genuinely happened.

The ledger reads bytes from disk, so it is only ever driven **from** the collector layer, which already
owns filesystem access. It is persistence infrastructure alongside `scan-store`/`finding-store` — not a
step in the Collector→Provider→Rule→View chain — so it does not bend ADR-0004 §D4.

### D6 · Fail-closed, and damage is classified

- An unreadable artifact **throws** rather than registering a hollow record. A ledger entry that cannot
  be verified is worse than no entry, because it looks like evidence.
- Linking an **unknown** artifact throws — a dangling reference is not evidence.
- `verify()` re-reads and re-hashes every recorded path and classifies damage as `missing` or
  `modified`, the same discipline as the other stores' integrity passes — never a bare boolean.

---

## Consequences

**Positive**
- Evidence acquires a verifiable identity that survives a report being copied or moved.
- Duplication is quantified on real output (16 → 11 artifacts on a stored run) instead of assumed.
- `verify()` gives the product tamper-evidence over artifacts it previously could say nothing about.
- The prerequisite for single-copy storage — and therefore for retiring the 62 MB base64 problem — now
  exists.
- Findings can be traced to bytes, which is what certification dispute-resolution will need.

**Negative / trade-offs**
- **No storage saving is realised yet.** Only identity is de-duplicated; `savedBytes` is an opportunity
  measurement. Stated in the code, the manifest and here, so it cannot be mistaken for a claim.
- The ledger is in-memory per run. Persistence, retention and sealing are ADR-0008.
- **This is store #5 by ADR-0004 §D8's count, hand-built**, because the immutable-store extraction is
  explicitly deferred. It is deliberately small — index, hash, verify — so it can sit on the extracted
  base later without its callers changing. Recorded as debt, not hidden.
- Only artifacts written by the **render pass** are registered. Visual-comparison and annotate artifacts
  are not yet, and are a follow-up rather than a claim.
- `putFile` reads every artifact once more to hash it. Bounded by the per-page shot caps already in
  force; not measured as significant, and not claimed to be free.

**Migration / version impact**
- **No version stream moved.** No user-visible behaviour changed: report rendering is untouched, and a
  run with no artifacts is byte-identical. `COLLECTION_SCHEMA_VERSION` and `PROVIDER_CONTRACT_VERSION`
  are unaffected — this ADR touches neither the collection nor the provider contract.
- **No release is due.**

---

## Evidence

| # | Evidence | Result |
|---|---|---|
| E1 | `evidence-ledger/evidence-ledger.test.js` | ✅ **58/58** |
| E2 | **Dedup measured on the repository's own stored run** (not a fixture): 16 files → 11 artifacts, 5 duplicates, 1940 bytes deduplicable | ✅ in E1 |
| E3 | Content addressing reuses `finding-store/digest.sha256` — asserted by equality *and* by source inspection | ✅ in E1 |
| E4 | Naming reuses `evidenceName()` — asserted by equality *and* by source inspection | ✅ in E1 |
| E5 | Determinism: differing first-seen clocks → byte-identical manifests (clock is provenance, never identity) | ✅ in E1 |
| E6 | **Finding identity unmoved:** `fingerprint` and `id` identical with and without `artifactId`; artifactId is the ONLY contract difference | ✅ in E1 |
| E7 | **Byte-identical when absent:** no `artifactId` key at all when no artifact was registered | ✅ in E1 |
| E8 | Frozen schema permits the addition (`additionalProperties: true`) — asserted, not assumed | ✅ in E1 |
| E9 | Fail-closed: unreadable artifact throws · non-Buffer throws · dangling link throws | ✅ in E1 |
| E10 | Tamper-evidence: `modified` and `missing` classified distinctly; every stored artifact verifies | ✅ in E1 |
| E11 | Boundary: no score/registry/report/Playwright import; no severity/deduction/verdict logic | ✅ in E1 |
| E12 | Frozen scope: 142 rules · registry 1.13.0 · engine 2.3.0 · report 1.4.0 unmoved | ✅ in E1 |
| E13 | Full suite before vs after | see §Acceptance |

---

## Acceptance

**PROPOSED until the evidence above is reviewed.** ACCEPTED means demonstrated, not intended.

**Acceptance criteria:**

1. Artifacts are content-addressed with stable ids. — **met (E3)**
2. Identical bytes de-duplicate onto one artifact. — **met (E2)**
3. Findings reference artifacts by id, deterministically. — **met (E1, E5)**
4. **Finding identity does not move.** — **met (E6)**
5. **No report, scoring, registry or event-model change; byte-identical when no artifact exists.** — **met (E7, E8, E12)**
6. Existing machinery reused, not duplicated. — **met (E3, E4)**
7. Fails closed; damage classified. — **met (E9, E10)**

**Not claimed:** storage deduplication, persistence, replay, sealing. Those are ADR-0008.

**ADR-0004, ADR-0005, ADR-0006 and ADR-0007 all remain PROPOSED.** None promotes itself or its parent.

---

## Related

- **ADR-0003** — Finding Contract v1; its `additionalProperties: true` is what makes `evidence.artifactId` additive rather than a freeze violation.
- **ADR-0004 §D8** — immutable-store extraction; this is store #5, hand-built by explicit deferral.
- **ADR-0008** (Collection Store & Replay) — will own artifact storage, retention and sealing, and is where `savedBytes` becomes bytes actually freed.
- **Follow-ups, not claims:** register visual-comparison and annotate artifacts; single-copy storage; artifact references in the HTML report.
