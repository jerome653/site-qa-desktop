'use strict';
// policy.js — the deterministic regression policy. A policy is EXPLICIT DATA (thresholds + severity
// sets), never a heuristic. evaluate() applies it to a classified diff and returns the fired rules
// plus a verdict (worst effect wins: FAIL > WARN > PASS). Same diff + same policy → same verdict.
const SEV_RANK = { critical: 4, high: 3, medium: 2, low: 1, none: 0 };
function sevRank(s) { return SEV_RANK[s] || 0; }

// The default gate: no new high/critical, no reopens, no escalation into high/critical, and a bounded
// score drop. Everything is a named, tunable field — nothing implicit.
const DEFAULT_POLICY = {
  name: 'default',
  version: '1.0.0',
  failOnNewSeverities: ['critical', 'high'],
  warnOnNewSeverities: ['medium', 'low'],
  failOnReopen: true,
  failOnEscalationTo: ['critical', 'high'],
  failScoreDropAtLeast: 10,
  warnScoreDropAtLeast: 1,
};

function resolvePolicy(p) { return Object.assign({}, DEFAULT_POLICY, p || {}); }

// diff = { created:[{ruleId,severity}], reopened:[...], severityChanges:[{ruleId,from,to}], scoreDelta }
function evaluate(diff, policyIn) {
  const policy = resolvePolicy(policyIn);
  const violations = [];
  const add = (effect, rule, detail) => violations.push({ effect, rule, detail });

  for (const f of diff.created || []) {
    if (policy.failOnNewSeverities.includes(f.severity)) add('FAIL', 'new-finding', `new ${f.severity} finding ${f.ruleId}`);
    else if (policy.warnOnNewSeverities.includes(f.severity)) add('WARN', 'new-finding', `new ${f.severity} finding ${f.ruleId}`);
  }
  if (policy.failOnReopen) for (const f of diff.reopened || []) add('FAIL', 'reopened', `reopened finding ${f.ruleId}`);
  for (const s of diff.severityChanges || []) {
    if (sevRank(s.to) > sevRank(s.from) && policy.failOnEscalationTo.includes(s.to)) add('FAIL', 'severity-escalation', `${s.ruleId} ${s.from}→${s.to}`);
  }
  const drop = diff.scoreDelta != null ? -diff.scoreDelta : 0; // positive = a drop
  if (drop >= policy.failScoreDropAtLeast) add('FAIL', 'score-drop', `overall dropped ${drop}`);
  else if (drop >= policy.warnScoreDropAtLeast) add('WARN', 'score-drop', `overall dropped ${drop}`);

  // Deterministic order.
  const rank = { FAIL: 0, WARN: 1 };
  violations.sort((a, b) => (rank[a.effect] - rank[b.effect]) || a.rule.localeCompare(b.rule) || a.detail.localeCompare(b.detail));

  const verdict = violations.some(v => v.effect === 'FAIL') ? 'FAIL' : violations.some(v => v.effect === 'WARN') ? 'WARN' : 'PASS';
  return { verdict, violations, policy: { name: policy.name, version: policy.version } };
}

module.exports = { DEFAULT_POLICY, resolvePolicy, evaluate, sevRank };
