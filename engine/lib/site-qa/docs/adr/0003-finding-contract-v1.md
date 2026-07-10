# ADR-0003 — The Finding Contract v1 (frozen)

- **Status:** ACCEPTED (2026-07-09) — Jerome approved Phase 1 as an engine evolution; contract frozen before any V2 rule/infra is written.
- **Date:** 2026-07-09
- **Deciders:** Jerome (product) · auditor
- **Affects:** finding model · emission layer · scoring · reporting (HTML/JSON/MD) · finding-store/regression · future API / IDE / Builder / Auto-Fix

## Context

V2 adds infrastructure every future rule will depend on (Developer Locator Objects, fingerprints,
evidence quality, dependencies, per-rule metadata). Before a single V2 rule is written we freeze **one
canonical Finding shape** every rule MUST emit, so no rule can invent its own output format. This is the
foundation for HTML/JSON/MD reports, CI, scan diffing, and every future integration.

Today findings are emitted ad hoc (`F(...)` rows + `enrichRow` adds ruleId/severity/tier/suite/…). That
de-facto shape is a **subset** of this contract; the contract extends it additively — old JSON still
parses, historical certs stay reproducible.

## Decision

### The Finding Contract v1 — every rule emits exactly this shape
```jsonc
{
  "id":            "string",        // deterministic finding-instance id (= fingerprint)
  "ruleId":        "LINK-006",      // registry identity (permanent)
  "ruleVersion":   "2.0",           // rule's lastModified version (historical-cert clarity)
  "inspector":     "seo|security|stability|null",   // audience lens
  "category":      "links",         // suite (grouping)
  "interaction":   false,           // feeds Interaction Integrity score if true
  "severity":      "critical|high|medium|low|manual",
  "tier":          1,               // launch-readiness: 1 blocker / 2 major / 3 polish / null
  "evidenceQuality":"verified|derived|heuristic",
  "fingerprint":   "sha256…",       // rule + normalizedUrl + stableSelector + normalizedEvidence
  "locator":       { /* generic Locator, see below — null for page-level findings */ },
  "evidence":      { "observed": "…", "expected": "…", "detail": "…", "value": "…", "screenshot": "…" },
  "relationships": { "rootCause": "ruleId|null", "relatesTo": ["ruleId", …] },
  "impacts":       { "seo": "low|med|high", "a11y": "…", "security": "…", "devEffort": "…" },
  "fix":           { "fixability": "none|manual|guided|automatic",
                     "recommendation": "…",
                     "actions": { "openInBuilder": false, "openSource": false, "openComponent": false,
                                  "applyFix": false, "markFixed": false, "rerunRule": false } },
  "metadata":      { "deduction": 12, "method": "network", "cost": "cheap", "docs": "/docs/rules/link-006" },
  "timestamps":    { "observedAt": "ISO-8601" }
}
```
- **`impacts`** are rule-declared classifications, NOT measurements. There is deliberately **no
  "affected users"** field — it is not measurable offline and must never be faked.
- **`sourceMapping`** lives inside `locator.source`; it is `null` off-SGEN with an explicit availability
  note (see below). Never fabricated.
- Page-level findings (no element, e.g. missing meta description) set `locator: null` and populate
  `evidence` + URL only. `impacts`/`fix` still required.

### Generic Locator (type-tagged — reused by DOM *and* Build Integrity)
Not HTML-specific, so Build Integrity reuses the same abstraction instead of forking:
```jsonc
{
  "type":   "dom|build-artifact|manifest|route|configuration|page",
  "target": "section.hero a.cta-primary",     // primary human-readable target
  "strategies": [                              // ranked by stability, best-available wins
    { "kind": "id",            "value": "#quote-btn",               "stability": "high" },
    { "kind": "data-testid",   "value": "[data-testid='quote']",    "stability": "high" },
    { "kind": "unique-class",  "value": ".cta-primary",             "stability": "medium" },
    { "kind": "structural-css","value": "section.hero a:nth-of-type(1)", "stability": "low" },
    { "kind": "xpath",         "value": "/html/body/main/section[1]/div/a", "stability": "low" }
  ],
  "url": "/services",
  "boundingBox": { "x": 412, "y": 268, "width": 184, "height": 52 },  // dom type, render mode
  "copyAs": { "css": "…", "xpath": "…", "querySelector": "…", "playwright": "…", "cypress": "…" },
  "source": null   // or { file, line, component, template, route, manifestRef }; see availability
}
```
For non-DOM types the same shape holds: a `manifest` locator's `target` is the manifest key, its
`strategies` the lookup paths; a `route` locator's `target` is the route path. **One locator model,
every domain.**

### The Five-Question invariant (finding quality gate)
Every finding MUST answer all five, or the rule is incomplete:
| Question | Answered by |
|---|---|
| **What is wrong?** | `ruleId` + rule title + `evidence.observed` |
| **Where is it?** | `locator` (+ `url`) |
| **How certain are we?** | `evidenceQuality` |
| **Why does it matter?** | `severity` + `tier` + `impacts` |
| **How do I fix it?** | `fix.recommendation` + `fix.fixability` |
A registry test asserts every non-manual rule can populate all five (fail closed).

### Build provenance availability (explicit, never faked)
```jsonc
"locator": { …, "source": null, "sourceAvailability": "requires-build-provenance" }
```
`source` is non-null only for SGEN-built sites once the build emits element→source provenance (Phase 3).

## Consequences
- **Positive:** one shape → every output (HTML/JSON/MD/API) and every future integration read the same
  contract; scan-diffing/regression key on `fingerprint`; Build Integrity reuses the locator model;
  Auto-Fix has a stable target. No per-rule format drift, ever.
- **Negative / trade-offs:** a heavier finding object (mitigated — populated lazily; page-level findings
  stay light). Every existing emitter must be lifted to the contract (additive, mechanical).
- **Migration / version impact:** contract v1 is a **superset** of today's de-facto finding; existing
  fields map in (name→rule title, detail→evidence.detail, value→evidence.value, section→category,
  location→locator.url, items→per-occurrence findings). Report version bumps; frozen scoring formula
  **unchanged** → historical certs reproduce byte-identically. Fingerprint extends `finding-store/digest.js`.

## Evidence
- Contract JSON-schema at `schemas/finding.schema.json` (extend existing) — validated in the test suite.
- Registry test: five-question completeness per rule; fingerprint determinism (same input → same hash).
- Golden parity: existing findings re-emitted through the contract produce identical scores + verdicts.
- Reproducibility: `finding-store/diff.js` scan-to-scan diff still passes on contract-shaped findings.

## Freeze
After this ADR, **no rule invents its own output format.** New fields require a contract version bump
(v1.1) documented here; removals require a superseding ADR. The shape above is the stable interface every
V2 rule, report, and integration builds on.
