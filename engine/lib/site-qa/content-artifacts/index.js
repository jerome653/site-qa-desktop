'use strict';
// content-artifacts — public entry for FUNC-008. Additive module (like best-practices/): it detects
// loose symbols / unresolved tokens / mojibake in visible copy and emits a registry-native FUNC-008
// finding row that drops into the Functional suite. It does NOT modify the frozen runtime, so golden
// parity is unaffected until a caller opts to run it.
const REG = require('../rules/registry');
const { detect, proseFromHtml } = require('./checks');

const RULE_ID = 'FUNC-008';

function statusFor(ruleId) {
  const r = REG.getById(ruleId);
  if (!r) return 'warn';
  return (r.severity === 'critical' || r.severity === 'high') ? 'fail' : 'warn';
}

// Scan page contexts and return a single FUNC-008 check row (pass when clean).
function scanContentArtifacts(pageContexts = []) {
  const rule = REG.getById(RULE_ID);
  const items = [];
  for (const ctx of pageContexts.filter(Boolean)) for (const it of detect(ctx)) items.push(it);
  items.sort((a, b) => (a.page + a.id + a.value).localeCompare(b.page + b.id + b.value));
  const kinds = [...new Set(items.map(i => i.id))];
  return {
    name: rule.title,
    ruleId: RULE_ID,
    ruleSlug: rule.slug,
    suite: rule.suite,
    severity: rule.severity,
    deduction: rule.deduction,
    status: items.length ? statusFor(RULE_ID) : 'pass',
    target: pageContexts.length === 1 ? (pageContexts[0] || {}).url || '' : '',
    detail: items.length ? `${items.length} artifact(s): ${kinds.join(', ')}` : 'clean',
    items,
  };
}

module.exports = { scanContentArtifacts, detect, proseFromHtml, RULE_ID };
