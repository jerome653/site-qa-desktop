# SGEN Site QA — Developer Guide: Finding Contract, Locator Objects & Evidence Providers

> The V2 platform interfaces every rule and every consumer share. Read this before adding a rule or a
> consumer. Authority: ADR-0003 (contract) + `contract.js` + `lib/evidence-providers.js`.

## The Finding Contract (frozen, v1)

Every finding — from any rule, any suite — is projected to ONE shape by `contract.js#toContract()`. No
rule builds this by hand; shared services fill the parts. Consumers (JSON / Markdown / HTML / CI / future
API) read the contract, never the raw finding.

Top-level fields: `id` (=fingerprint) · `ruleId` · `ruleVersion` · `inspector` · `category` (suite) ·
`interaction` · `severity` · `tier` · `evidenceQuality` · `fingerprint` · `locator` · `evidence` ·
`relationships` · `impacts` · `fix` · `metadata` · `timestamps` · `contractVersion`.

**Five-question invariant** (a rule that can't answer all five is incomplete — `fiveQuestionGaps()`):
what (`ruleId`+name+`evidence.observed`) · where (`locator`/url) · how-certain (`evidenceQuality`) ·
why (`severity`+`tier`+`impacts`) · how-to-fix (`fix`).

**Evidence quality** — `verified` (observed directly) · `derived` (computed from observed facts) ·
`heuristic` (pattern-based, rendered as "likely"). Declared per rule; defaults to `verified`.

**`impacts`** are rule-declared classifications (`seo`/`a11y`/`security`/`devEffort` ∈ low|med|high). There
is deliberately **no "affected users"** axis — not measurable offline, never faked.

## Developer Locator Object (generic, type-tagged)

Built by the DOM provider; the same shape serves Build Integrity (`manifest`/`route`/`build-artifact`
types) so nothing forks a parallel model.

```jsonc
{ "type": "dom|build-artifact|manifest|route|configuration|page",
  "target": "<preferred selector / key / path>",
  "strategies": [ { "kind": "id|data-testid|unique-class|attr|structural-css|xpath", "value": "…",
                    "stability": "high|medium|low|unknown" } ],   // ranked; best-available wins
  "url": "…", "boundingBox": {…}|null, "copyAs": { "css","xpath","querySelector","playwright","cypress" },
  "locatorId": "sha256(page + preferredSelector + tag)",   // stable handle, survives DOM churn
  "text": "…", "outerHTML": "…", "visible": true,
  "source": null, "sourceAvailability": "requires-build-provenance" }  // Tier-2 (Phase 3), never faked
```

The **fingerprint** keys on the most-stable strategy (not the raw selector), so scan-to-scan diffing,
suppress-unchanged, and regression stay reliable across markup churn.

## Evidence Providers

Each provider contributes to the same contract; none owns the finding. `lib/evidence-providers.js`:
- **DOMProvider** — `enrich(facts)` → locator + ranked strategies + `locatorId`. Facts come from the
  render pass's `DESCRIBE_ELEMENTS` serializer (run only for flagged selectors — cost ∝ findings, not DOM),
  or from a static parser's descriptor.
- **RenderProvider** — the in-page `DESCRIBE_ELEMENTS` serializer (bbox/visibility/facts). Screenshots stay
  lazy (render mode + on request).
- **NetworkProvider / BuildProvider** — registered stubs; Phase 1 security + Phase 3 build integrity plug in
  here with no new plumbing.

## Adding a rule (the contract you must honor)

1. Add it to `rules/registry.js` with full metadata (`inspector`, `cost`, `evidenceQuality`, `impact`,
   `fixability`, and `interaction: true` if it feeds Interaction Integrity). IDs are permanent + immutable.
2. Emit a finding record with `items[]` carrying a `descriptor` (tag/id/classes/attributes) so the DOM
   provider can build a locator — **do not build locators or fingerprints yourself** (services do that).
3. Map its `check` family → suite in `audit.js` (`STATIC_SUITE`) and add a `PASS_LABEL` if it should show a
   clean-pass row.
4. Add a unit test; bump the frozen rule-count assertions; run `testing/run-all.js` (must stay green).
5. Bump `REGISTRY_VERSION`.

## Consuming findings (for CI / IDE / API)

Read `data.findings` — the canonical contract array. Diff two scans by `fingerprint`. `data.contractMetrics`
carries `{contractVersion, count, projectionMs}`. Everything else (scores, tally, readiness) is aggregate
and separate from the per-finding model.
