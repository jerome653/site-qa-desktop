'use strict';
// copy-review — public entry for Suite 13 "Copy Review" (COPY-001..004). Registered in
// rules/registry.js as suite:'copy' (WEIGHTS.copy = 0), every rule severity:'manual'/deduction:0.
// Additive, self-contained module — same shape as content-artifacts/index.js for FUNC-008: it detects
// assistant-boilerplate leaks, unresolved authoring placeholders, AI-tell phrasing, and uniform
// paragraph rhythm in VISIBLE copy, and emits one registry-native row per COPY-00N rule. It does not
// modify the frozen runtime or any other module — a caller wires it up itself.
//
// SCORE-NEUTRAL: every row below carries status 'manual' UNCONDITIONALLY (never 'pass'/'warn'/'fail'),
// regardless of how many items were found — these are flags for a HUMAN reviewer, never a verdict. See
// checks.js and rules/registry.js's Suite 13 comment for the full "why" (never claims a page IS
// AI-written). No AI, no network — pure deterministic regex/statistics over visible prose only.
const REG = require('../rules/registry');
const { detect, wordCount } = require('./checks');
const { proseFromHtml } = require('../content-artifacts/checks');

const RULE_IDS = ['COPY-001', 'COPY-002', 'COPY-003', 'COPY-004'];

// checks.js emits items keyed by detector id; map each to the COPY-00N rule it feeds.
const DETECTOR_ID_BY_RULE = {
  'COPY-001': 'llm-boilerplate-leak',
  'COPY-002': 'unresolved-authoring-placeholder',
  'COPY-003': 'ai-tell-phrasing',
  'COPY-004': 'uniform-paragraph-rhythm',
};

function totalWords(pageContexts) {
  return pageContexts.reduce((sum, ctx) => sum + wordCount(ctx.prose != null ? ctx.prose : proseFromHtml(ctx.html)), 0);
}

// Build the single COPY-00N row for one rule id across all page contexts.
function rowFor(ruleId, pageContexts) {
  const rule = REG.getById(ruleId);
  if (!rule) throw new Error(`copy-review: ${ruleId} not found in rules/registry.js`);
  const detectorId = DETECTOR_ID_BY_RULE[ruleId];
  const items = [];
  for (const ctx of pageContexts.filter(Boolean)) {
    for (const it of detect(ctx)) if (it.id === detectorId) items.push(it);
  }
  items.sort((a, b) => (a.page + a.id + a.value).localeCompare(b.page + b.id + b.value));

  let detail;
  if (!items.length) {
    detail = 'clean — nothing flagged for review';
  } else if (ruleId === 'COPY-003') {
    const words = totalWords(pageContexts.filter(Boolean));
    const density = words > 0 ? (items.length / words) * 1000 : 0;
    detail = `${items.length} phrase(s) flagged for review — ${density.toFixed(1)} per 1000 words (informational; does not affect score)`;
  } else {
    detail = `${items.length} item(s) flagged for review (does not affect score)`;
  }

  return {
    name: rule.title,
    ruleId,
    ruleSlug: rule.slug,
    suite: rule.suite,
    severity: rule.severity,
    deduction: rule.deduction,
    status: 'manual', // unconditional — advisory rows never assert pass/warn/fail; see header comment
    target: pageContexts.length === 1 ? (pageContexts[0] || {}).url || '' : '',
    detail,
    items,
  };
}

// Scan page contexts and return the four Copy Review advisory rows (always status 'manual', deduction 0).
function scanCopyReview(pageContexts = []) {
  return RULE_IDS.map(id => rowFor(id, pageContexts));
}

module.exports = { scanCopyReview, detect, RULE_IDS };
