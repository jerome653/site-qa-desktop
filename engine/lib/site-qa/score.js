'use strict';
// score.js — SGEN Quality Score. Deterministic, explainable, no AI, no hidden math.
//
// Constitutional: this file hardcodes NO deductions and NO weights. Both come from the Rule
// Registry (rules/registry.js) — the single source of truth. Change a number there, re-run, done.
//
// Model:
//   • All 10 suites are scored categories (0–100). One check lives in exactly one suite.
//   • Each finding's deduction = its rule's registry value (severity classifies; the number = impact).
//   • category_score = clamp(0..100, 100 − Σ deductions of its non-manual, non-pass findings)
//   • overall = Σ(category_score × weight) / Σ(weight)
//   • Every deduction is line-itemed WITH its rule id ("SEO-006 · −18 · Canonical points off").
//   Manual + pass rows never deduct. Same input → same score, always.

const { WEIGHTS, getById } = require('./rules/registry');

// Native identity: deduction resolves ONLY by the row's ruleId (WP-001). No title lookup.
function deductionFor(row) {
  const rule = row.ruleId ? getById(row.ruleId) : null;
  if (rule) return { points: rule.manual ? 0 : rule.deduction, ruleId: rule.id };
  return { points: 0, ruleId: null };
}

function compute(suitesOut) {
  const categories = suitesOut.map(s => {
    const deductions = [];
    for (const row of s.checks) {
      if (row.status === 'pass' || row.status === 'manual') continue;
      const d = deductionFor(row);
      if (d.points > 0) deductions.push({ label: row.name, points: d.points, ruleId: d.ruleId, status: row.status });
    }
    deductions.sort((a, b) => b.points - a.points);
    const raw = deductions.reduce((a, d) => a + d.points, 0);
    const score = Math.max(0, 100 - raw);
    return { key: s.key, name: s.name, weight: WEIGHTS[s.key] || 0, score, deductions };
  });
  const wsum = categories.reduce((a, c) => a + c.weight, 0) || 1;
  const overall = Math.round(categories.reduce((a, c) => a + c.score * c.weight, 0) / wsum);
  return { overall, categories, model: 'sgen-quality-v1' };
}

module.exports = { compute, WEIGHTS, deductionFor };
