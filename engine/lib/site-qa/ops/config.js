'use strict';
// config.js — deterministic operational configuration. All operational knobs in one explicit place
// with safe defaults; loadConfig() merges overrides (env or object) over the defaults. No hidden
// state, no I/O beyond an optional JSON file the caller points at.
const fs = require('fs');

const DEFAULTS = Object.freeze({
  // store locations (relative to a data root the caller chooses)
  scanStoreDir: '.scan-store',
  findingStoreDir: '.finding-store',
  timelineStoreDir: '.timeline',
  regressionStoreDir: '.regression',
  backupDir: '.backups',
  // quality gates
  coverageGate: 95,
  // regression policy defaults (mirrors regression/policy.js DEFAULT_POLICY intent)
  regressionPolicy: 'default',
  // performance budgets (ms/op) — advisory ceilings surfaced by the benchmark
  perfBudgets: { scanSave: 12, findingIngest: 15, verify: 0.5, timelineBuild: 1 },
  // integrity: verify on restore
  verifyOnRestore: true,
});

function loadConfig(overrides) {
  let fromFile = {};
  if (typeof overrides === 'string') {
    if (fs.existsSync(overrides)) fromFile = JSON.parse(fs.readFileSync(overrides, 'utf8'));
    overrides = undefined;
  }
  return Object.assign({}, DEFAULTS, fromFile, overrides || {});
}

module.exports = { DEFAULTS, loadConfig };
