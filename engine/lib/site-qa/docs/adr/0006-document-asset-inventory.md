# ADR-0006 — Document Asset Inventory (Collector + Provider)

- **Status:** PROPOSED (2026-07-28) — promoted to ACCEPTED only on demonstrated implementation; criteria in §Acceptance
- **Date:** 2026-07-28
- **Deciders:** Jerome (product) · auditor
- **Governed by:** **ADR-0004 — Layered Acquisition Architecture** (§D2 · §D3 · §D4 · §D5 · §D7 · §D9)
- **Sibling of:** **ADR-0005 — Network Ledger** (same Collector+Provider pattern, different channel)
- **Affects:** acquisition layer (+1 collector) · inventory provider set (+1) · id-registry prefix map (+1) · `checks-static.js` (refactor, behaviour-preserving)
- **Does NOT affect:** registry contract · finding schema · report schema · event model · scoring model

---

## Context

### 1 · The engine already parses this and throws it away

`checks-static.js`'s render-blocking check (PERF-005) has parsed `<head>` for stylesheets and scripts on
every page of every scan since 2.0 — extracting their `href`/`src`, filtering by `media`, `async`,
`defer` and `type=module` — and then discarded all of it unless the count reached four:

```js
const css = (c.head.match(/<link\b[^>]*rel\s*=\s*["']stylesheet["'][^>]*>/gi) || [])…
const js  = (c.head.match(/<script\b[^>]*\ssrc\s*=[^>]*>/gi) || [])…
const n = css.length + js.length;
if (n < 4) return null;                     // ← everything parsed above is thrown away
```

Header/footer code inventory, technology fingerprinting, duplicate-tag detection, tag-ordering analysis
and unused-preload detection are all blocked on data the engine already parses. As with ADR-0005 this
is a **retention** change, not a new measurement.

### 2 · ADR-0004 created the channel; ADR-0005 proved the pattern

A1 widened the provider contract to `enumerate(collection, ctx)` and declared a `documents` channel.
ADR-0005 filled the `network` channel and established the pattern this ADR follows exactly: a pure
collector above the determinism boundary, a pure provider below it, evidence referenced by index rather
than copied, `collected[]` distinguishing "looked and saw nothing" from "never looked".

---

## Problem

Retain the document's asset structure as a deterministic inventory, **and** eliminate the duplicate
parse — without moving a single finding.

The hard part is the second half. PERF-005 is a live, scored check. Refactoring it onto a shared
tokenizer means its output must be provably identical, and its existing regexes carry **quirks**:

- `/<script\b[^>]*\ssrc\s*=[^>]*>/` demands **whitespace before `src`**.
- `/\b(async|defer)\b/i` is tested against the **whole tag string**, so `src="/vendor.async.min.js"`
  excludes that script from the blocking count — a filename changing a finding.
- `headSlice()` falls back to `html.slice(0, 8000)` when there is no `<head></head>` pair. Every
  head-based check in the engine inherits that behaviour.

A "correct" attribute parser reproduces none of these. Replacing the regexes with clean parsing would
silently move PERF-005 on real sites.

---

## Decision

### D1 · The Document Collector — `lib/site-qa/collectors/document.js`

Second inhabitant of the Collector layer. Above the determinism boundary; acquisition only. Beyond
ADR-0005's prohibitions it carries one more, because ADR-0006's brief is explicit: **no
classification**. It does not decide what is render-blocking, a tracker, duplicated or unused. It
records what the document contains, in the order it contains it.

`collectDocumentAssets(html, { documentUrl, source, now })` → `{ documentUrl, source, capturedAt,
assets[], counts }`.

### D2 · `raw` is load-bearing, not a convenience

Every asset record keeps the exact opening-tag text it was cut from. **That is what makes the refactor
safe by construction rather than by trust:** PERF-005 keeps its own original regexes and applies them to
the same strings it used to match itself. The quirks travel with the data instead of being lost in a
rewrite. This is the single most important decision in this ADR.

### D3 · The record

```
{ index, sectionIndex, section, tag, offset, raw, inline, external,
  href, src, rel, relTokens, type, media, integrity, crossorigin,
  async, defer, module, nomodule, inlineIndex, attrs }
```

- **Order is the product.** `index` is document-wide, `sectionIndex` within head/body, `offset` is the
  source position. Never sorted, never grouped, never classified.
- **`section` is positional, never inferred** — an asset is `head` only when its whole opening tag lies
  inside the head region, which is exactly what matching against the head substring does.
- **`headSlice` now has ONE definition**, moved here from `checks-static.js` and imported back by it.
  The implementation moved unchanged, `slice(0, 8000)` fallback included.
- **`relTokens`** splits `rel="preconnect dns-prefetch"` into tokens. Splitting an attribute is
  acquisition; deciding what a preload *means* is not, and does not happen here. `preload`, `prefetch`,
  `dns-prefetch` and `preconnect` are therefore captured as data, not as categories.
- **Absent attributes are `null`, never `''`.** Boolean attributes (`async`/`defer`/`nomodule`) are
  `true`/`false` — presence *is* observable, so `false` is measured. This is deliberately different
  from ADR-0005's `protocol`/`fromCache`, which are `null` because they cannot be seen at all.

### D4 · The DocumentAssetProvider

Registered ninth. Pure: no browser, no filesystem, no Playwright, no clock, no scoring, no formatting,
no classification.

- **Identity is document-scoped**: `docasset:<path>|<section>|<tag>|<url or inline#n>`. The same
  stylesheet referenced from two pages is two items — a document asset belongs to its document, unlike
  a network request, which is one logical request however many pages ask for it. That asymmetry with
  ADR-0005 is intentional.
- **The item carries less than the record.** `raw` and `capturedAt` do not travel into items;
  `recordIndexes: [{ document, asset }]` points back. Same index-not-copy seam as ADR-0005, and the
  shape ADR-0007 will formalise.
- **Undeclared channel → zero items, no claim.** Fails closed on a non-Collection, a document entry
  with no `assets` array, and an asset with no `tag`.

### D5 · The refactor, and why it cannot move a finding

`checks-static.js` no longer parses the head itself. `render-blocking` calls the collector and applies
its **original regexes to `a.raw`**. Identical by construction — and verified by a **differential test**
that keeps a verbatim copy of the pre-refactor implementation as an oracle and diffs it across an
11-document corpus chosen to hit the quirks (filename containing "async", filename containing "defer",
no `<head>` element, unquoted `rel`, body-only assets, exactly-at-threshold, below-threshold).

### D6 · Rendered-DOM acquisition

`checks-render.js` calls the collector once per page on `page.content()` after consent overlays are
dismissed, and returns a `documents` channel. The rendered DOM is a **different document** from the raw
HTML the static pass parses — a JS-injected script exists in one and not the other — and `source`
(`'static'` | `'rendered'`) records which. Guarded: a page torn down mid-scan yields no record rather
than a fake one.

### D7 · No consumer

No rule, view, report or score reads `collection.documents`. Tracking Audit, Header/Footer Audit,
Technology Inventory, duplicate detection, execution-order analysis, unused-preload detection,
unknown-script detection and performance advice are **consumers** and are explicitly out of scope.

---

## Consequences

**Positive**
- Data parsed and discarded on every page of every scan is retained, at no additional browser cost.
- The duplicate parse is gone: one tokenizer, one `headSlice`, used by the check and the inventory.
- A second collector/provider pair proves ADR-0004's pattern generalises rather than fitting one case.
- Header/footer inventory, technology detection, duplicate-tag and tag-order analysis become **views
  over existing data** instead of new acquisition systems.
- The rendered-vs-static distinction is now captured, which is a prerequisite for any honest JavaScript-
  SEO or rendering-parity work later.

**Negative / trade-offs**
- **`render-blocking` still runs as a page-first check that reaches *up* to a collector**, which is an
  ADR-0004 §D4 adjacency violation. It is a smaller one than the duplicate parse it replaces, but it is
  real: making PERF-005 a true consumer of the document inventory changes which layer the rule lives in
  and belongs to a later ADR. Recorded here so it does not become invisible debt (ADR-0004 §5 already
  lists this file among the known violations).
- The static path parses the document once per page even when PERF-005 would have returned early. One
  regex scan; negligible beside what `buildCtx` already does, and it is what removes the duplicate.
- Only `NetworkProvider` and `DocumentAssetProvider` validate their input. Generalising the seam
  validator to all nine providers remains deferred (carried over from ADR-0005).
- `TAGS` is a fixed list. A resource-bearing element outside it is not inventoried; extending the list
  is additive and cheap, but the limit is real and stated rather than implied.

**Migration / version impact**
- `COLLECTION_SCHEMA_VERSION` unchanged at **1.1** — the `documents` channel and `collected[]` were
  already declared by ADR-0004/0005; this ADR fills the channel, it does not reshape the collection.
- `PROVIDER_CONTRACT_VERSION` unchanged — the contract shape did not move.
- **No engine / registry / report / package version moved. No user-visible behaviour changed, so no
  release is due.**

---

## Evidence

| # | Evidence | Result |
|---|---|---|
| D1 | `inventory/document-assets.test.js` | ✅ **77/77** |
| D2 | **Differential:** refactored PERF-005 vs a verbatim copy of the original, 11-document corpus incl. quirk cases | ✅ 11/11 identical |
| D3 | Order: tags in exact document order, offsets strictly increasing, never grouped or sorted | ✅ in D1 |
| D4 | head/body positional; `headSlice` 8000-char fallback preserved exactly | ✅ in D1 |
| D5 | Attributes preserved: rel tokens, media, integrity, crossorigin, async/defer/module/nomodule, full attr map | ✅ in D1 |
| D6 | Nulls: absent attributes `null` not `''`; no field uses an empty string for unknown | ✅ in D1 |
| D7 | Determinism: differing capture clocks → byte-identical items; no `raw`/`capturedAt` in any item | ✅ in D1 |
| D8 | Fails closed: bare array · document with no assets array · asset with no tag · empty/null document handled | ✅ in D1 |
| D9 | Boundary: collector imports no score/registry/finding/report/Playwright module and holds no severity/deduction/verdict logic; provider touches neither Playwright nor fs | ✅ in D1 |
| D10 | Frozen scope: 142 rules · registry 1.13.0 · engine 2.3.0 · report 1.4.0 unmoved | ✅ in D1 |
| D11 | **Real Chromium integration**: rendered DOM inventoried; a JS-injected script present that the static parse cannot see | ✅ in D1 |
| D12 | ADR-0004 A1 golden still holds with nine providers registered | ✅ `contract-parity.test.js` |
| D13 | Full suite before vs after | see §Acceptance |

---

## Acceptance

**PROPOSED until the evidence above is reviewed.** ACCEPTED means demonstrated, not intended.

**Acceptance criteria:**

1. Collector exists, is acquisition-only and non-classifying; boundary tested, not asserted. — **met (D1, D9)**
2. Provider consumes `collection.documents`, is pure and deterministic. — **met (D1, D7)**
3. Document order, head/body and attributes preserved exactly. — **met (D3, D4, D5)**
4. Fails closed; empty handled; nulls are null. — **met (D6, D8)**
5. **The duplicate parse is eliminated with no finding moved.** — **met (D2)**
6. Real Chromium integration. — **met (D11)**
7. No registry, finding-schema, scoring, report or event-model change. — **met (D10, D12)**
8. No consumer built. — **met (D7)**

**On the parent:** ADR-0004 criterion 3 was already satisfied by ADR-0005. This ADR is the independent
second demonstration the criterion offered as an alternative, so the parent's evidence is now
redundant rather than singular. **ADR-0004, ADR-0005 and ADR-0006 all remain PROPOSED**; none promotes
itself or its parent.

---

## Related

- **ADR-0004** — governing architectural decision.
- **ADR-0005** — sibling collector/provider pair; same pattern, `network` channel.
- **ADR-0007** (Evidence Ledger) — will formalise the index-not-copy seam both children use.
- **Future consumers** (each its own ADR): Tracking Audit · Header/Footer Audit · Technology Inventory ·
  duplicate-tag detection · execution-order analysis · unused-preload detection. None of them may
  introduce acquisition logic; all read `collection.documents`.
