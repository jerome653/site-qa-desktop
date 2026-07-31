'use strict';
// real-runs.js — locate the stored live-audit artifacts three suites assert against.
//
// WHY THIS EXISTS. readiness.test.js, render-honesty.test.js and score-evaluation.test.js pin their
// numbers to REAL stored runs rather than fixtures, deliberately: a fixture agrees with whatever the
// code currently does, and every one of those suites exists because a fixture agreed with a bug. Each
// guards its artifact with existsSync and SKIPS when it is missing, which is the right instinct — an
// absent artifact must not fail a fresh clone.
//
// THE HAZARD THAT INSTINCT CREATES. A skip is invisible. The suite still prints green while covering
// strictly less, and "a suite that silently excludes work is the most expensive kind of pass". That
// became concrete at 6.2.0: the product was renamed SGEN Site QA -> Site Audit, Electron derives
// userData from productName, so the installer migration MOVES the directory all three paths were
// hardcoded to. Nothing would have failed. Three suites would simply have stopped asserting, on the
// exact artifacts that catch score-inflation regressions, and the run would still have said 66/66.
//
// So the path is resolved rather than hardcoded, both product names are tried, and callers get a
// `describe()` string to print so a skip is stated out loud instead of inferred from silence.
const fs = require('fs');
const path = require('path');
const os = require('os');

const APPDATA = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
// Newest name first. Both are tried because a machine can hold either: one that has taken the
// installer carrying the migration, and one still on the pre-rename shell.
const PRODUCT_NAMES = ['Site Audit', 'SGEN Site QA'];
const SUBPATH = ['engines', 'sgen', 'W5-Live-Surface-Audit', 'site-qa', '_ui-runs'];

// SGEN_QA_RUNS_DIR wins outright — that is the CI / another-operator escape hatch, and it must not be
// second-guessed by a name probe.
function runsDir() {
  if (process.env.SGEN_QA_RUNS_DIR) {
    return fs.existsSync(process.env.SGEN_QA_RUNS_DIR) ? process.env.SGEN_QA_RUNS_DIR : null;
  }
  for (const name of PRODUCT_NAMES) {
    const p = path.join(APPDATA, name, ...SUBPATH);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// Absolute path to a stored run's report.json, or null when it is not on this machine.
function realRun(runId) {
  const dir = runsDir();
  if (!dir) return null;
  const f = path.join(dir, runId, 'report.json');
  return fs.existsSync(f) ? f : null;
}

// One line a suite prints so the reader knows whether those assertions ran. Never returns ''.
//
// TAKES THE RUN IDS, and this is the whole point. The first version reported only whether the
// DIRECTORY existed, and printed "real-run artifacts: <dir>" on a machine where the directory was
// present and both pinned runs had been deleted — an instrument reporting green over the exact
// condition it was built to expose. Presence of the folder is not presence of the artifact.
function describe(runIds = []) {
  const dir = runsDir();
  if (!dir) {
    return 'real-run artifacts NOT PRESENT (no _ui-runs directory) — those assertions are SKIPPED, '
      + 'not passing. Set SGEN_QA_RUNS_DIR to enable them.';
  }
  const missing = runIds.filter(id => !realRun(id));
  if (!runIds.length) return `real-run directory: ${dir}`;
  if (!missing.length) return `real-run artifacts present (${runIds.length}): ${dir}`;
  return `real-run artifacts MISSING ${missing.length}/${runIds.length} [${missing.join(', ')}] in ${dir} `
    + '— those assertions are SKIPPED, not passing.';
}

module.exports = { runsDir, realRun, describe, PRODUCT_NAMES, APPDATA };
