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
  ENGINE_VERSION: '2.3.0',   // V2 Phase 1: Finding Contract + Evidence Providers + Developer Locator Objects + 32 rules
  REPORT_VERSION: '1.4.0',   // merged findings list (Issues + per-section detail -> one filtered, section-grouped table)
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
