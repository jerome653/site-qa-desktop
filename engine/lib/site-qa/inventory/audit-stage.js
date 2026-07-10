'use strict';
// inventory/audit-stage.js — the Audit (Production Validation) integration. Reuses the EXISTING Site
// Audit engine (audit.js / pipeline) — never re-detects — and MAPS every finding onto an Inventory
// Item. No orphan findings: an image finding → Asset item on that page (else the Page), a form finding
// → Form item, a global finding → Global item, everything else → the Page item. Findings attach to the
// SOURCE item for matched content (same identity key), else the target item.
const REG = require('../rules/registry');
const { addFinding } = require('./model');
const { pathOf } = require('./providers');

const SUITE_AXIS = {
  functional: 'production', links: 'production', console: 'production', security: 'production',
  crossbrowser: 'production', 'best-practices': 'production', audit: 'production',
  forms: 'forms', responsive: 'responsive', a11y: 'accessibility', seo: 'seo', performance: 'performance', visual: 'visual',
};
function sevOf(row) {
  if (row.status === 'manual') return 'manual';
  const r = row.ruleId ? REG.getById(row.ruleId) : null;
  const s = row.severity || (r && r.severity);
  return (s === 'critical' || s === 'high') ? 'blocking' : 'advisory';
}
function ruleType(ruleId) {
  if (/^A11Y-00[678]$/.test(ruleId)) return 'asset';   // image findings
  if (/^FORM-/.test(ruleId)) return 'form';
  if (ruleId === 'FUNC-005') return 'global';
  return 'page';
}
// resolve the inventory item a finding maps to (source preferred, then target), never orphan.
function resolve(refInv, tgtInv, type, url) {
  const key = 'page:' + pathOf(url || '');
  const page = refInv.byKey.get(key) || tgtInv.byKey.get(key) || null;
  if (type === 'page' || !page) return page;
  const inv = refInv.byKey.has(key) ? refInv : tgtInv;
  const typed = (inv.items[type] || []).find(i => i.meta.firstPage === url || i.meta.page === url || i.meta.url === url);
  return typed || page;
}

// productionStage(refInv, tgtInv, auditResult, { at }) → maps audit findings onto inventory items.
function productionStage(refInv, tgtInv, auditResult, opts = {}) {
  const at = opts.at || '';
  let mapped = 0, orphan = 0;
  for (const suite of (auditResult && auditResult.suites) || []) {
    const axis = SUITE_AXIS[suite.key] || 'production';
    for (const row of suite.checks || []) {
      if (row.status === 'pass') continue;
      const type = ruleType(row.ruleId || '');
      const item = resolve(refInv, tgtInv, type, row.target);
      if (!item) { orphan++; continue; }
      const sev = sevOf(row);
      addFinding(item, {
        axis, ruleId: row.ruleId || null, severity: sev, detail: row.detail || row.name || '',
        confidence: 1,
        evidence: { inventoryId: item.id, ruleId: row.ruleId || null, method: sev === 'manual' ? 'manual' : 'automated',
          detectionConfidence: 1, evidence: 'Complete', pageUrl: row.target || '', detail: row.detail || row.name || '',
          items: (row.items || []).slice(0, 25), timestamp: at },
      });
      mapped++;
    }
  }
  return { mapped, orphan };
}

module.exports = { productionStage, ruleType, SUITE_AXIS };
