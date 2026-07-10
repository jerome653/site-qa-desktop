'use strict';
// spelling — public entry for FUNC-009. Additive module: emits a registry-native FUNC-009 finding row
// (into the Functional suite) for common misspellings + doubled words found in visible copy. Does not
// touch the frozen runtime; the pipeline merges it like FUNC-008.
const REG = require('../rules/registry');
const { detect } = require('./checks');

const RULE_ID = 'FUNC-009';

function statusFor(ruleId) {
  const r = REG.getById(ruleId);
  return (r && (r.severity === 'critical' || r.severity === 'high')) ? 'fail' : 'warn';
}

function scanSpelling(pageContexts = []) {
  const rule = REG.getById(RULE_ID);
  const items = [];
  for (const ctx of pageContexts.filter(Boolean)) for (const it of detect(ctx)) items.push(it);
  items.sort((a, b) => (a.page + a.id + a.value).localeCompare(b.page + b.id + b.value));
  const kinds = [...new Set(items.map(i => i.id))];
  return {
    name: rule.title, ruleId: RULE_ID, ruleSlug: rule.slug, suite: rule.suite,
    severity: rule.severity, deduction: rule.deduction,
    status: items.length ? statusFor(RULE_ID) : 'pass',
    target: pageContexts.length === 1 ? (pageContexts[0] || {}).url || '' : '',
    detail: items.length ? `${items.length} issue(s): ${kinds.join(', ')}` : 'clean',
    items,
  };
}

module.exports = { scanSpelling, detect, RULE_ID };
