'use strict';
// readiness.js — Launch-Readiness verdict layer (1.5.0, ADDITIVE).
// The SGEN Quality Score is a weighted average, so one catastrophic finding can hide inside an
// otherwise-green report (a NOINDEX'd live site can still average 83). This layer adds the veto the
// average lacks: any open tier-1 rule (site broken / launch killer) → NOT LAUNCH-READY, stated next
// to the score. It reads the enriched suites and touches NOTHING in the frozen scoring — historical
// reports stay byte-reproducible.

// tiers come from the rule registry (rule.tier via enrichRow): 1 blocker · 2 major · 3 polish
function compute(suitesOut) {
  const blockers = [], counts = { blockers: 0, majors: 0, polish: 0 };
  for (const s of suitesOut) {
    for (const row of s.checks) {
      if (row.status !== 'fail' && row.status !== 'warn') continue;
      if (row.tier === 1) { counts.blockers++; blockers.push({ name: row.name, ruleId: row.ruleId, suite: s.name, occurrences: (row.items || []).length || 1 }); }
      else if (row.tier === 2) counts.majors++;
      else if (row.tier === 3) counts.polish++;
    }
  }
  return {
    launchReady: counts.blockers === 0,
    verdict: counts.blockers === 0 ? 'LAUNCH-READY' : `NOT LAUNCH-READY — ${counts.blockers} blocker${counts.blockers > 1 ? 's' : ''}`,
    blockers, counts, model: 'sgen-readiness-v1',
  };
}

module.exports = { compute };
