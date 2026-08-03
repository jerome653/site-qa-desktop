'use strict';
// setup-readiness.js — "can this machine actually run a FULL site audit?"
//
// WHY THIS EXISTS. The installer bundles Chromium, but Firefox and WebKit are fetched on first
// launch (measured 2026-08-03: a fresh install is 983 MB and 1,474 MB after the first run — 325 MB
// firefox-1522 + 166 MB webkit-2287). If that fetch never happens — offline, proxy, disk full — the
// audit STILL RUNS and still prints a Quality Score. cross-browser.js:30 catches the launch failure
// and returns { available:false }, which audit.js reads as "engine not installed". So the run is
// INCOMPLETE, not wrong, and nothing on the operator's screen says so before they hand the report
// to a client.
//
// This module is the statement of what a full audit needs, checked rather than asserted.
//
// THE INVARIANT IT MUST NEVER BREAK — this is the same failure readiness.js was built to stop, one
// layer up. A green "ready" that is not backed by a check that actually ran is a lie told in
// writing. So `verdict` is earned by the WHOLE result: any missing engine downgrades it. There is
// no arrangement of inputs where a browser engine is absent and this module still says 'full'.
//
// Pure/IO split is deliberate: compute() is a pure function over a probe snapshot so the test can
// drive it with engines missing, which is precisely the state that cannot be reproduced on a
// developer machine that has already downloaded them.

// What a full audit depends on. `impact` is what the operator LOSES — not a restatement of the
// requirement, because "Firefox is missing" is not information, "the cross-browser suite will
// report 'engine not installed'" is.
const REQUIREMENTS = [
  {
    key: 'playwright',
    label: 'Browser automation runtime',
    severity: 'blocked',
    impact: 'No audit can run at all. Every suite drives a real browser.',
    fix: 'Reinstall the app — the runtime ships inside the installer and is not downloaded.',
  },
  {
    key: 'chromium',
    label: 'Chromium engine',
    severity: 'blocked',
    impact: 'No audit can run. Every suite renders the page in Chromium first.',
    fix: 'Reinstall the app — Chromium is bundled in the installer, not fetched.',
  },
  {
    key: 'firefox',
    label: 'Firefox engine',
    severity: 'degraded',
    impact: 'Cross-browser suite reports "engine not installed" instead of a result. The audit still runs and still scores, but it has not been checked in Firefox.',
    fix: 'Connect to the network and restart the app — it fetches Firefox on launch. Manual: npx playwright install firefox',
  },
  {
    key: 'webkit',
    label: 'WebKit engine (Safari)',
    severity: 'degraded',
    impact: 'Cross-browser suite reports "engine not installed" instead of a result. Safari-specific rendering and console faults will not be seen.',
    fix: 'Connect to the network and restart the app — it fetches WebKit on launch. Manual: npx playwright install webkit',
  },
  {
    key: 'sharp',
    label: 'Image processing',
    severity: 'degraded',
    impact: 'Screenshot evidence and visual comparison may be unavailable or unprocessed.',
    fix: 'Reinstall the app — this ships inside the installer.',
  },
];

// Reference only — never downgrades the verdict. Being offline does not stop an audit of a
// reachable target, and a check that punishes a state the operator may have chosen would train
// people to ignore this panel.
const ADVISORY = [
  {
    key: 'feed',
    label: 'Update feed',
    impact: 'The engine cannot tell you a newer version exists. Auditing is unaffected.',
    fix: 'Allow outbound HTTPS to github.com.',
  },
];

/**
 * Pure. `state` maps each key to true (present) / false (absent).
 * Unknown or missing keys are treated as ABSENT — an unchecked dependency is never "ready",
 * for the same reason readiness.js counts an untiered failing row as outstanding.
 */
function compute(state) {
  const s = state || {};
  const rows = REQUIREMENTS.map((r) => {
    const present = s[r.key] === true;
    return {
      key: r.key,
      label: r.label,
      status: present ? 'ready' : r.severity,   // 'ready' | 'degraded' | 'blocked'
      present,
      impact: present ? null : r.impact,
      fix: present ? null : r.fix,
      note: present ? null : (s[r.key + 'Note'] || null),
    };
  });

  const advisory = ADVISORY.map((a) => {
    const present = s[a.key] === true;
    return { key: a.key, label: a.label, status: present ? 'ready' : 'info', present,
             impact: present ? null : a.impact, fix: present ? null : a.fix };
  });

  const blocked = rows.filter((r) => r.status === 'blocked');
  const degraded = rows.filter((r) => r.status === 'degraded');

  let verdict, tone, headline, scope;
  if (blocked.length) {
    verdict = 'blocked'; tone = 'no';
    headline = 'CANNOT RUN AN AUDIT — ' + blocked.length + ' missing';
    scope = 'A dependency every suite needs is absent. Fix the red rows before running anything.';
  } else if (degraded.length) {
    verdict = 'partial'; tone = 'part';
    headline = 'PARTIAL — ' + degraded.length + ' capabilit' + (degraded.length > 1 ? 'ies' : 'y') + ' unavailable';
    // Naming the lost suites here is the whole point: an audit that skipped cross-browser looks
    // identical on the score strip to one that passed it.
    scope = 'An audit will run and score, but these checks will not happen: ' +
            degraded.map((d) => d.label).join(', ') + '. Reports produced now are incomplete.';
  } else {
    verdict = 'full'; tone = 'ok';
    headline = 'READY — full audit available';
    scope = 'Every engine a full audit depends on is present on this machine.';
  }

  return { verdict, tone, headline, scope, rows, advisory,
           counts: { blocked: blocked.length, degraded: degraded.length, ready: rows.length - blocked.length - degraded.length } };
}

/**
 * IO. Resolves real state the same way an audit does — via playwright's own executablePath(),
 * so PLAYWRIGHT_BROWSERS_PATH (set by the shell to resources/browsers) is honoured. Existence of
 * the binary is checked rather than launching all three: launching costs ~10s per engine and this
 * panel is opened casually. A binary that exists but fails to launch is reported by the audit
 * itself as available:false, which is the correct place for that failure.
 */
function probe(deps) {
  const fs = (deps && deps.fs) || require('fs');
  const state = {};

  let pw = null;
  try { pw = (deps && deps.playwright) || require('playwright'); state.playwright = true; }
  catch (e) { state.playwright = false; state.playwrightNote = String((e && e.message) || e).split('\n')[0].slice(0, 120); }

  for (const eng of ['chromium', 'firefox', 'webkit']) {
    if (!pw || !pw[eng]) { state[eng] = false; state[eng + 'Note'] = 'runtime unavailable'; continue; }
    try {
      const p = pw[eng].executablePath();
      state[eng] = !!p && fs.existsSync(p);
      if (!state[eng]) state[eng + 'Note'] = 'not downloaded yet';
    } catch (e) {
      state[eng] = false;
      state[eng + 'Note'] = String((e && e.message) || e).split('\n')[0].slice(0, 120);
    }
  }

  try { (deps && deps.sharp) || require('sharp'); state.sharp = true; }
  catch (e) { state.sharp = false; state.sharpNote = String((e && e.message) || e).split('\n')[0].slice(0, 120); }

  state.feed = !!(deps && deps.feedReachable);
  return state;
}

module.exports = { compute, probe, REQUIREMENTS, ADVISORY };
