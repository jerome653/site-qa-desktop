'use strict';
// readiness.js — Launch-Readiness verdict layer (1.5.0, ADDITIVE).
// The SGEN Quality Score is a weighted average, so one catastrophic finding can hide inside an
// otherwise-green report (a NOINDEX'd live site can still average 83). This layer adds the veto the
// average lacks: any open tier-1 rule (site broken / launch killer) → NOT LAUNCH-READY, stated next
// to the score. It reads the enriched suites and touches NOTHING in the frozen scoring — historical
// reports stay byte-reproducible.
//
// 1.5.1 — THE GATE IS NARROW; IT MUST NOT BE PRESENTED AS A BROAD ALL-CLEAR.
// This layer vetoes on tier-1 rules ONLY, and SEVEN of the twelve suites in rules/registry.js carry
// no tier-1 rule at all (links, a11y, performance, forms, console, best-practices, visual — verify
// with a tier tally over the registry). So every check in all seven can fail while blockers === 0.
// Until 1.5.1 that emitted the literal string "LAUNCH-READY", which the report painted as a green
// pill beside the overall verdict. The real sgen.com run (score 49, verdict "NEEDS ATTENTION",
// ready:false, 4 fails / 30 warns incl. 51 broken asset requests and 4 JS errors) rendered
// "NEEDS ATTENTION" and a green "LAUNCH-READY" side by side. This tool is handed to a client as
// evidence a rebuild is sound; a green pill that is not backed by a check that actually ran is a lie
// told in writing, on the agency's letterhead.
//
// The fix is NOT to weaken the veto — a tier-1 blocker must still hard-fail, and `launchReady` keeps
// its exact original meaning (blockers === 0) so no caller's gate silently loosens. The fix is that
// the layer now states its own SCOPE. Three states, not two:
//   blockers > 0                       → tone 'no'   red    "NOT LAUNCH-READY — N blockers"
//   blockers === 0, nothing else open  → tone 'ok'   green  "LAUNCH-READY"          (genuinely clean)
//   blockers === 0, other issues open  → tone 'part' amber  "NO LAUNCH BLOCKERS — N issues outstanding"
// Green is now EARNED BY THE WHOLE RESULT, not by the narrow gate. The middle state is the entire
// point: it says exactly what was checked and what is still open, so a client who reads nothing else
// on the page cannot read it as "ready to launch".
//
// Why the string itself changed, and not just the pill's colour in report.js: report.json is a
// deliverable and is read by other tooling. Fixing only the renderer would leave `verdict:
// "LAUNCH-READY"` sitting in the JSON of a 49% run for the next consumer to repeat.

// tiers come from the rule registry (rule.tier via enrichRow): 1 blocker · 2 major · 3 polish
function compute(suitesOut) {
  const blockers = [], counts = { blockers: 0, majors: 0, polish: 0, untiered: 0 };
  for (const s of suitesOut) {
    for (const row of s.checks) {
      if (row.status !== 'fail' && row.status !== 'warn') continue;
      if (row.tier === 1) { counts.blockers++; blockers.push({ name: row.name, ruleId: row.ruleId, suite: s.name, occurrences: (row.items || []).length || 1 }); }
      else if (row.tier === 2) counts.majors++;
      else if (row.tier === 3) counts.polish++;
      // A failing row whose tier is null/undefined used to fall through all three arms and vanish.
      // Real audits emit ruleId:null summary rows (that gap is why the engine once scored every real
      // site quality 0 while 25/25 unit tests were green), and an unclassified row is exactly the
      // kind of damage that must not be able to silently shrink "issues outstanding" back to zero
      // and re-earn a green pill. Count it as outstanding; unknown severity is never "clean".
      else counts.untiered++;
    }
  }

  const outstanding = counts.majors + counts.polish + counts.untiered;
  const noBlockers = counts.blockers === 0;   // the veto itself — UNCHANGED semantics
  const clean = noBlockers && outstanding === 0;

  let verdict, tone, scope;
  if (!noBlockers) {
    tone = 'no';
    verdict = `NOT LAUNCH-READY — ${counts.blockers} blocker${counts.blockers > 1 ? 's' : ''}`;
    scope = `${counts.blockers} launch-blocking (tier-1) fault${counts.blockers > 1 ? 's' : ''} open. Do not launch.`;
  } else if (clean) {
    tone = 'ok';
    verdict = 'LAUNCH-READY';
    scope = 'No launch-blocking (tier-1) faults, and no other checks failing.';
  } else {
    tone = 'part';
    verdict = `NO LAUNCH BLOCKERS — ${outstanding} issue${outstanding > 1 ? 's' : ''} outstanding`;
    scope = `Checked for launch-blocking (tier-1) faults only — none found. ${outstanding} other check${outstanding > 1 ? 's are' : ' is'} still failing (accessibility, performance, links, forms and console carry no tier-1 rules, so this gate cannot see them). This is NOT an all-clear.`;
  }

  return {
    launchReady: noBlockers,  // UNCHANGED: blockers === 0. The tier-1 veto. Do not widen — callers gate on it.
    noBlockers,               // explicit alias: says what launchReady actually measures, for new callers
    clean,                    // the honest broad read: nothing failing anywhere, any tier
    tone,                     // 'ok' | 'part' | 'no' — presentation state; green requires `clean`
    scope,                    // plain-English statement of what this gate did and did not check
    verdict, blockers, counts, outstanding, model: 'sgen-readiness-v1',
  };
}

module.exports = { compute };
