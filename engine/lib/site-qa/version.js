'use strict';
// version.js — independent version streams (Phase 2 items 9 & 10). Every scan/report records all three
// so an old report is always reproducible against the exact rules + engine that produced it.
const { REGISTRY_VERSION } = require('./rules/registry');
module.exports = {
  ENGINE_VERSION: '2.3.0',   // V2 Phase 1: Finding Contract + Evidence Providers + Developer Locator Objects + 32 rules
  REPORT_VERSION: '1.3.0',   // + Phase 2 Inspector Lenses (per-lens sub-scores + Interaction Integrity views)
  REGISTRY_VERSION,          // rule metadata version (owned by the registry)
};
