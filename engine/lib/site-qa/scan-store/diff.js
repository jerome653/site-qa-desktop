'use strict';
// diff.js — deterministic diff between two immutable scan records. Given identical inputs it always
// produces identical output (sorted, stable keys). Classifies the change as regression / improvement
// / unchanged from the delta in findings and score.
const { ScanStore } = require('./store');

function asStore(s) { return s instanceof ScanStore ? s : new ScanStore(s); }

// A finding's identity within a scan = ruleId + page + normalized evidence (so the same rule firing
// on two different elements are two distinct findings).
function findingKey(f) {
  const ev = (f.evidenceNormalized || []).map(e => `${e.page}#${e.section}#${e.id}#${e.value}`).join('|');
  return `${f.ruleId || ''}::${f.page || ''}::${ev}`;
}

// Diff two records: a = OLDER (baseline), b = NEWER (candidate).
function diffRecords(a, b) {
  if (!a || !b) throw new Error('diffRecords requires two records');
  const am = new Map((a.findings || []).map(f => [findingKey(f), f]));
  const bm = new Map((b.findings || []).map(f => [findingKey(f), f]));

  const introduced = [], resolved = [], changed = [], unchanged = [];
  for (const [k, f] of bm) {
    if (!am.has(k)) { introduced.push(f); continue; }
    const o = am.get(k);
    if (o.severity !== f.severity || o.status !== f.status || o.deduction !== f.deduction) {
      changed.push({ key: k, ruleId: f.ruleId, page: f.page, from: { severity: o.severity, status: o.status, deduction: o.deduction }, to: { severity: f.severity, status: f.status, deduction: f.deduction } });
    } else {
      unchanged.push(f);
    }
  }
  for (const [k, f] of am) if (!bm.has(k)) resolved.push(f);

  const sortF = arr => arr.sort((x, y) => findingKey(x).localeCompare(findingKey(y)));
  sortF(introduced); sortF(resolved); sortF(unchanged);
  changed.sort((x, y) => x.key.localeCompare(y.key));

  // Score delta (overall + per suite).
  const ao = a.quality ? a.quality.overall : null;
  const bo = b.quality ? b.quality.overall : null;
  const scoreDiff = { from: ao, to: bo, delta: (ao != null && bo != null) ? +(bo - ao).toFixed(2) : null };
  const suiteDiff = {};
  const aS = (a.quality && a.quality.suites) || {}, bS = (b.quality && b.quality.suites) || {};
  for (const key of new Set([...Object.keys(aS), ...Object.keys(bS)])) {
    const from = aS[key] != null ? aS[key] : null, to = bS[key] != null ? bS[key] : null;
    suiteDiff[key] = { from, to, delta: (from != null && to != null) ? +(to - from).toFixed(2) : null };
  }

  // Rule-level counts.
  const ruleDiff = {};
  const bump = (id, field) => { (ruleDiff[id] || (ruleDiff[id] = { introduced: 0, resolved: 0, changed: 0 }))[field]++; };
  for (const f of introduced) if (f.ruleId) bump(f.ruleId, 'introduced');
  for (const f of resolved) if (f.ruleId) bump(f.ruleId, 'resolved');
  for (const c of changed) if (c.ruleId) bump(c.ruleId, 'changed');

  const worseSeverity = changed.some(c => sevRank(c.to.severity) > sevRank(c.from.severity));
  const betterSeverity = changed.some(c => sevRank(c.to.severity) < sevRank(c.from.severity));
  const regression = introduced.length > 0 || worseSeverity || (scoreDiff.delta != null && scoreDiff.delta < 0);
  const improvement = resolved.length > 0 || betterSeverity || (scoreDiff.delta != null && scoreDiff.delta > 0);
  let classification = 'unchanged';
  if (regression && improvement) classification = 'mixed';
  else if (regression) classification = 'regression';
  else if (improvement) classification = 'improvement';

  return {
    from: { scanId: a.scanId, timestamp: a.timestamp, fingerprint: a.fingerprint },
    to: { scanId: b.scanId, timestamp: b.timestamp, fingerprint: b.fingerprint },
    identical: a.fingerprint === b.fingerprint,
    introduced, resolved, changed, unchanged,
    counts: { introduced: introduced.length, resolved: resolved.length, changed: changed.length, unchanged: unchanged.length },
    scoreDiff, suiteDiff, ruleDiff,
    regression, improvement, classification,
  };
}

function sevRank(s) { return { critical: 4, high: 3, medium: 2, low: 1 }[s] || 0; }

function diff(store, aId, bId) {
  store = asStore(store);
  return diffRecords(store.get(aId), store.get(bId));
}

module.exports = { diff, diffRecords, findingKey };
