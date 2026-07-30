'use strict';
// version.js — independent version streams (Phase 2 items 9 & 10). Every scan/report records all three
// so an old report is always reproducible against the exact rules + engine that produced it.
// ── D6 · SINGLE VERSION AUTHORITY (ADR-0004 §D6) ─────────────────────────────────────────────────
// THIS FILE IS THE AUTHORITY. Every version stream used in manifests, replay compatibility or derived
// metadata originates here exactly once; everything else imports it. Nothing restates a version
// literal — a restated literal IS a second authority, and replay cannot tell a drift-induced mismatch
// from a genuine incompatibility.
//
// The drift this closes, measured before the change:
//   • contract.js declared its own `CONTRACT_VERSION = '1.0'`
//   • release-metadata.json declared `"contractVersion": "1.0.0"`   <- same stream, two values
//   • lib/report-contract.js hardcoded a THIRD `'1.0'` as a fallback
//   • testing/foundation.test.js asserted `REPORT_VERSION === '1.3.0'` while it had been 1.4.0 since
//     the 4.4.0 release — a test restating a literal is a second authority that goes stale silently,
//     and it had been red for exactly that reason.
//
// AUTHORITY RESOLUTION for the contract stream: **'1.0' wins.** It is the value actually emitted into
// every finding contract and every stored report; release-metadata.json is the DERIVED artifact and
// follows. Choosing the other way would have rewritten output for a metadata file that no JavaScript
// in this engine even reads.
//
// REGISTRY_VERSION is imported, not restated — the registry owns its own version, and that established
// pattern is what the rest of this file now follows.
const { REGISTRY_VERSION } = require('./rules/registry');
module.exports = {
  // 2.4.0 (ADR-0011) — SCORE DECLARATION INTEGRITY. The first user-visible behavioural change since
  // 2.3.0: the Quality Score on the report now reflects only what was actually evaluated, so scores
  // FALL on sites where rules did not run. Measured across the stored corpus: 9/9 runs were inflated,
  // mean -8.1, median -10. Minor, not major: the score's shape, model tag and every other stream are
  // unchanged — only the number is corrected.
  // 2.5.0 — CONTENT SURFACE + ROW IDENTITY. Two additive behavioural changes, no scoring change:
  //   • the SEO tool now runs the Copy Review advisory pass (COPY-001..004, WEIGHTS.copy = 0, every row
  //     status 'manual'), so an SEO report says something about the WORDS. Score-neutral by two
  //     mechanisms and asserted as such by recomputing with the suite removed (seo-split.test.js).
  //   • every static row now names the CHECK that produced it. A passing row carries ruleId null by
  //     design, so a clean check was anonymous — and the SEO tool's graded summary printed NOT RUN for
  //     all 8 of its PASSING checks on sgen.com. Minor, not major: nothing is rescored, and identity
  //     (WP-001) is unmoved — `check` names the check, `ruleId` still names the rule.
  // 3.0.0 — MAJOR, and the reason is a SCORING SEMANTICS change, not a feature: a run that never read a
  // page no longer publishes a number. score and quality.overall come back null and the verdict is
  // COULD NOT AUDIT. Measured before the change on a fixture answering 403 to every path: verdict NEEDS
  // ATTENTION, score 50%, QUALITY 71, htmlPages 0, 87 of 97 rules never evaluated, and the words
  // "blocked" and "unreachable" appearing zero times in the report. A site the tool never saw scored 71.
  // Anything comparing scores across this boundary must know that a previously-numeric result can now be
  // null — which is exactly what a major version is for.
  // 3.1.0 — additive, no scoring change. The audit result now carries links.totalInternal /
  // totalExternal / capped as their own fields: they were summed into `checked` and the components
  // discarded, and a total cannot be split back apart — measured on a fixture with 4 internal + 1
  // external links, the report read "5 internal, 0 external". Nothing is rescored; a consumer that
  // only reads `checked` is unaffected.
  // 3.2.0 — Copy Review (COPY-001..004) runs ONLY in the Content & SEO tool. It ran in Site Audit too,
  // by default rather than by intent (applyAdvisory with no `passes` runs all four), so a technical
  // report carried a copy section. A Site Audit report no longer contains a 'copy' suite and no longer
  // declares COPY-* as evaluated. NOT a scoring change and not a major: WEIGHTS.copy = 0 and every
  // COPY-* row is status 'manual', proven by adding the suite back to a shipped result and recomputing
  // to the same number (seo-split.test.js). Scores remain comparable across this boundary.
  // 3.3.0 — additive. The analytics pass row names the tracking stack it found ("Analytics / tracking
  // detected — GA4, GTM") with per-page counts, and the result carries techStack.analytics +
  // analyticsPageCounts for consumers. The vendor list already existed and was discarded on live runs,
  // where present-means-pass returned null; staging named them all along. No rule added or rescored.
  // 3.4.0 — additive. result.techStack now also carries cms / framework / ecommerce / server / cdn with
  // per-signature page counts, detected offline from responses the crawl already made. Signatures only:
  // techStack.note travels with the data so no surface can present a signature as certainty.
  ENGINE_VERSION: '3.4.0',   // + tech stack: cms/framework/server/cdn (was 3.3.0)
  // 1.6.0 — the report's SHAPE changed, which is what this stream is for. Out: the verdict card, the
  // score ring, the readiness pill and the seven stat tiles (redundant — every number was restated
  // below). In: a status breakdown that says what each HTTP code MEANS, and a link count strip. A
  // consumer scraping the HTML for .verdict / .tile will find nothing; report.json is unchanged and
  // remains the contract for anything automated.
  REPORT_VERSION: '1.7.0',   // + "Built on" tech-stack panel (was 1.6.0)
  REGISTRY_VERSION,          // rule metadata version (owned by the registry)

  // ── Acquisition-boundary streams (ADR-0004 §D5/§D6) ────────────────────────────────────────────
  // Declared HERE and nowhere else. ADR-0004 §D6 makes it constitutional that one authoritative source
  // owns every version stream used in manifests and replay compatibility, because replay cannot tell a
  // drift-induced mismatch from a genuine incompatibility. These two are new streams introduced with
  // the widened provider contract; they are NOT behaviour, so no existing stream moves for A1.
  // 1.1 (ADR-0005) added `collected[]` — the explicit record of WHICH channels a collector actually
  // populated. Additive: a 1.0 collection has no declaration and every consumer treats that as
  // "undeclared", which is the safe reading. The distinction it buys is the platform's oldest law —
  // "I looked and it is clean" must never be indistinguishable from "I never looked".
  COLLECTION_SCHEMA_VERSION: '1.1',  // shape of a Collection (the Collector -> Provider boundary)
  PROVIDER_CONTRACT_VERSION: '1.0',  // enumerate(collection, ctx) -> items[]  (the Provider contract)
  // Finding Contract v1 (ADR-0003). Moved here from contract.js by D6: it is a version stream, and
  // version streams live in one place. contract.js now imports it.
  CONTRACT_VERSION: '1.0',
};
