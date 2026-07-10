'use strict';
// versions.js — version governance for Migration Certification (Phase 5). Every certification embeds
// these so an artifact is reproducible against the exact engine + schemas that produced it.
const { ENGINE_VERSION, REGISTRY_VERSION } = require('../version');

const SCHEMA = {
  migrationQaEngine: '1.0.0',
  ruleRegistry: REGISTRY_VERSION,
  inventorySchema: '1.0',
  evidenceSchema: '1.0',
  certificationSchema: '1.0',
  reportSchema: '1.0',
  auditEngine: ENGINE_VERSION,
};

// meta({ gitCommit, build, environment, at }) → the full metadata block (runtime-supplied fields default honestly)
function meta(o = {}) {
  return {
    versions: { ...SCHEMA },
    build: o.build || 'source',
    gitCommit: o.gitCommit || 'unknown',
    executionTimestamp: o.at || '',
    environment: o.environment || `node ${process.version} · ${process.platform}`,
  };
}

module.exports = { SCHEMA, meta };
