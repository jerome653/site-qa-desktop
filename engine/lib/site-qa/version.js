'use strict';
// version.js — independent version streams (Phase 2 items 9 & 10). Every scan/report records all three
// so an old report is always reproducible against the exact rules + engine that produced it.
const { REGISTRY_VERSION } = require('./rules/registry');
module.exports = {
  ENGINE_VERSION: '2.3.0',   // V2 Phase 1: Finding Contract + Evidence Providers + Developer Locator Objects + 32 rules
  REPORT_VERSION: '1.4.0',   // merged findings list (Issues + per-section detail -> one filtered, section-grouped table)
  REGISTRY_VERSION,          // rule metadata version (owned by the registry)
};
