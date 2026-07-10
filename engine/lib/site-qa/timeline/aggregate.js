'use strict';
// aggregate.js — deterministic rollups over a built timeline: milestones (best/worst/first-clean),
// streaks (consecutive improving/regressing/clean scans), score trajectory, and — when a finding
// store is supplied — longest-open and most-reopened findings. Pure function of its inputs.
const { lineage } = require('../finding-store');

function milestones(timeline) {
  const pts = timeline.points;
  if (!pts.length) return { firstScan: null, latestScan: null, best: null, worst: null, firstClean: null };
  let best = pts[0], worst = pts[0], firstClean = null;
  for (const p of pts) {
    if (p.overall != null) {
      if (best.overall == null || p.overall > best.overall) best = p;
      if (worst.overall == null || p.overall < worst.overall) worst = p;
    }
    if (firstClean == null && p.findingCount === 0) firstClean = p;
  }
  const pick = p => p && { index: p.index, scanId: p.scanId, timestamp: p.timestamp, overall: p.overall, findingCount: p.findingCount };
  return { firstScan: pick(pts[0]), latestScan: pick(pts[pts.length - 1]), best: pick(best), worst: pick(worst), firstClean: pick(firstClean) };
}

function streaks(timeline) {
  const pts = timeline.points;
  // trailing streak of the same delta direction, and longest clean run.
  let improving = 0, regressing = 0;
  for (let i = pts.length - 1; i >= 1; i--) {
    const d = pts[i].delta ? pts[i].delta.overall : null;
    if (d == null) break;
    if (d > 0 && regressing === 0) improving++;
    else if (d < 0 && improving === 0) regressing++;
    else break;
  }
  let curClean = 0, longestClean = 0;
  for (const p of pts) {
    if (p.findingCount === 0) { curClean++; longestClean = Math.max(longestClean, curClean); }
    else curClean = 0;
  }
  return { improvingTrailing: improving, regressingTrailing: regressing, currentCleanRun: curClean, longestCleanRun: longestClean };
}

function trajectory(timeline) {
  const scores = timeline.points.filter(p => p.overall != null).map(p => p.overall);
  if (!scores.length) return { start: null, end: null, net: null, min: null, max: null };
  return { start: scores[0], end: scores[scores.length - 1], net: +(scores[scores.length - 1] - scores[0]).toFixed(2), min: Math.min(...scores), max: Math.max(...scores) };
}

// Finding-level rollups from the immutable finding chain (optional).
function findingRollups(findingStore, target) {
  if (!findingStore) return null;
  const findings = findingStore.byTarget(target).map(id => lineage(findingStore, id)).filter(Boolean);
  let longestOpen = null, mostReopened = null;
  for (const f of findings) {
    const reopenCount = f.timeline.filter(t => t.to === 'REOPENED').length;
    if (!mostReopened || reopenCount > mostReopened.reopens) mostReopened = { findingId: f.findingId, ruleId: f.ruleId, reopens: reopenCount };
    // "open span" = firstSeen → last non-resolved observation (lexicographic ISO compare is chronological)
    const openObs = f.timeline.filter(t => t.to !== 'RESOLVED' && t.to !== 'DUPLICATE' && t.to !== 'SUPERSEDED');
    const lastOpen = openObs.length ? openObs[openObs.length - 1].timestamp : f.firstSeen;
    const span = { findingId: f.findingId, ruleId: f.ruleId, firstSeen: f.firstSeen, lastOpen, currentState: f.currentState };
    if (!longestOpen || (lastOpen || '') > (longestOpen.lastOpen || '') || ((lastOpen === longestOpen.lastOpen) && f.firstSeen < longestOpen.firstSeen)) {
      // longest = earliest firstSeen that is still open latest; deterministic tiebreak by findingId
      longestOpen = span;
    }
  }
  // choose longest strictly by (lastOpen - firstSeen) duration, deterministic
  let best = null;
  for (const f of findings) {
    const openObs = f.timeline.filter(t => t.to !== 'RESOLVED' && t.to !== 'DUPLICATE' && t.to !== 'SUPERSEDED');
    const lastOpen = openObs.length ? openObs[openObs.length - 1].timestamp : f.firstSeen;
    const durMs = Date.parse(lastOpen) - Date.parse(f.firstSeen);
    const cand = { findingId: f.findingId, ruleId: f.ruleId, firstSeen: f.firstSeen, lastOpen, durationMs: isNaN(durMs) ? 0 : durMs, currentState: f.currentState };
    if (!best || cand.durationMs > best.durationMs || (cand.durationMs === best.durationMs && cand.findingId < best.findingId)) best = cand;
  }
  return { totalFindings: findings.length, longestOpen: best, mostReopened };
}

function aggregate(timeline, findingStore) {
  return {
    milestones: milestones(timeline),
    streaks: streaks(timeline),
    trajectory: trajectory(timeline),
    findings: findingStore ? findingRollups(findingStore, timeline.target) : null,
  };
}

module.exports = { aggregate, milestones, streaks, trajectory, findingRollups };
