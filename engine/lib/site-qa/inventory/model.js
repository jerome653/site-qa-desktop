'use strict';
// model.js — the InventoryItem: one logical object (a page, section, asset, global, form, behavior)
// with a stable ID, an identity key, a lifecycle state + history, its metadata, and its evidence.
// Every audit/comparison/certification operates on these — the inventory-driven source of truth.
const { assertTransition } = require('./lifecycle');

// makeItem({ id, type, identityKey, meta }) → item at DISCOVERED
// Full inventory-item schema (frozen constitution): stable id · identity key · parent · children ·
// provider · lifecycle · metadata · evidence · history · comparison mapping · reference mapping ·
// certification state.
function makeItem({ id, type, identityKey, provider, parent = null, meta = {} }) {
  const item = {
    id, type, identityKey,
    provider: provider || type,
    parent,                 // parent identityKey (e.g. a section's page), or null
    children: [],           // child identityKeys (e.g. a page's sections)
    state: null,
    history: [],            // [{ from, to, reason, at }]
    meta,                   // type-specific fields (url, role, filename, fields, behaviorKey…)
    findings: [],           // cross-axis findings mapped onto this item: {axis, ruleId, severity, detail, viewport, evidence, confidence}
    evidence: null,         // primary evidence package (Evidence layer)
    comparisonMapping: null,// { result:'present'|'missing', targetId, similarity } (Comparison layer)
    referenceMapping: null, // for a target item: its source counterpart id (Comparison layer)
    certificationState: null,// PASS|PASS_WITH_MINOR|FAIL|MANUAL contribution (Certification layer)
  };
  transition(item, 'DISCOVERED', 'discovered', meta.at || '');
  return item;
}

// Fail-closed lifecycle transition; records history with a reason (so certification can explain "why").
function transition(item, to, reason = '', at = '') {
  assertTransition(item.state, to);
  item.history.push({ from: item.state, to, reason: reason || '', at: at || '' });
  item.state = to;
  return item;
}

function attachEvidence(item, evidence) { item.evidence = evidence; return item; }

// addFinding — any axis (completeness/visual/production/seo/a11y/responsive) attaches a finding to an
// inventory item. severity: 'blocking' | 'advisory' | 'manual'. No finding without evidence (or manual).
function addFinding(item, finding) {
  item.findings.push({
    axis: finding.axis, ruleId: finding.ruleId || null, severity: finding.severity || 'advisory',
    detail: finding.detail || '', viewport: finding.viewport || null,
    evidence: finding.evidence || null, confidence: finding.confidence != null ? finding.confidence : 1,
  });
  return item;
}

module.exports = { makeItem, transition, attachEvidence, addFinding };
