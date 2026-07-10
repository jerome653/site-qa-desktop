'use strict';
// migration-qa/verdict.js — severity bucketing + the production-ready gate.
//
// v2.0 Definition of Done: "No Critical or High severity issues remain open." So the automated
// gate is NOT-READY iff any critical|high finding survives; otherwise AUTOMATED-PASS. The tool
// never claims plain READY on its own — v2.0 also requires manual sign-off, so a clean automated
// run reports "AUTOMATED-PASS — awaiting manual sign-off". Mirrors gate-check.js bucket→exit shape.

const ORDER = { critical: 0, high: 1, medium: 2, low: 3 };

function tally(findings) {
  const t = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of findings) if (t[f.severity] != null) t[f.severity]++;
  return t;
}

function bySection(findings) {
  const map = {};
  for (const f of findings) {
    const s = f.section || 'other';
    (map[s] = map[s] || { section: s, critical: 0, high: 0, medium: 0, low: 0, findings: [] });
    if (map[s][f.severity] != null) map[s][f.severity]++;
    map[s].findings.push(f);
  }
  return Object.values(map).sort((a, b) => a.section.localeCompare(b.section));
}

function byCheck(findings) {
  const map = {};
  for (const f of findings) { (map[f.check] = map[f.check] || []).push(f); }
  return map;
}

function computeVerdict(findings) {
  const t = tally(findings);
  const blocking = t.critical + t.high;
  const automated = blocking === 0 ? 'AUTOMATED-PASS' : 'NOT-READY';
  return {
    automated,
    ready: blocking === 0,
    blockingCount: blocking,
    tally: t,
    // overall label surfaced in the report/CLI
    label: blocking === 0 ? 'AUTOMATED-PASS — awaiting manual sign-off' : 'NOT-READY',
  };
}

module.exports = { tally, bySection, byCheck, computeVerdict, ORDER };
