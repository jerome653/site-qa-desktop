'use strict';
// inventory/certification.js — the Certification layer. Consumes ONLY inventory items and their
// cross-axis findings (completeness · visual · production · SEO · a11y · responsive · assets · forms ·
// behaviors · globals). Assigns each item a terminal lifecycle state and produces the three-state
// verdict. Honors Approved Exceptions. Every decision cites inventory ID · rule ID · axis · evidence ·
// viewport · detection confidence · lifecycle state.
const { transition } = require('./model');

// certify(refInv, { at, exceptions }) — exceptions = [{ relatedIds:[id], reason, approver, date, evidence }]
function certify(refInv, opts = {}) {
  const at = opts.at || '';
  const exceptions = opts.exceptions || [];
  const excusedIds = new Set(exceptions.flatMap(e => e.relatedIds || []));
  // certify source items AND target-only items (Phase 6 — target-only pages are never ignored)
  const allItems = [...Object.values(refInv.items).flat(), ...(opts.extraItems || [])];
  const gates = {};       // type → { total, passed, warning, failed, manual, gate }
  const explanations = [];
  const tally = { passed: 0, warning: 0, failed: 0, manual: 0, approved: 0 };

  for (const it of allItems) {
    const g = gates[it.type] = gates[it.type] || { total: 0, passed: 0, warning: 0, failed: 0, manual: 0, approved: 0, gate: 'PASS' };
    g.total++;
    const cm = it.comparisonMapping || {};

    // approved exception (intentionally removed, or item explicitly excused)
    if (cm.result === 'approved-removed' || (excusedIds.has(it.id) && it.state !== 'MANUAL_VERIFICATION_REQUIRED')) {
      if (it.state === 'EVIDENCE_COLLECTED' || it.state === 'VALIDATED' || it.state === 'COMPARED') {
        // move to APPROVED_EXCEPTION through a valid path
        if (it.state === 'COMPARED') transition(it, 'VALIDATED', 'approved exception', at);
        if (it.state === 'VALIDATED') transition(it, 'EVIDENCE_COLLECTED', 'approved exception (evidence waived)', at);
        transition(it, 'APPROVED_EXCEPTION', 'approved exception', at);
      }
      it.certificationState = 'APPROVED'; tally.approved++; g.approved++; continue;
    }

    if (it.state === 'MANUAL_VERIFICATION_REQUIRED') { it.certificationState = 'MANUAL'; tally.manual++; g.manual++; continue; }
    if (it.state !== 'EVIDENCE_COLLECTED') continue; // not eligible for a verdict

    const active = (it.findings || []).filter(f => f.severity !== 'excused');
    const hasManual = active.some(f => f.severity === 'manual');
    const hasBlocking = active.some(f => f.severity === 'blocking');
    const hasAdvisory = active.some(f => f.severity === 'advisory');

    let state, cs;
    if (hasBlocking) { state = 'FAILED'; cs = 'FAIL'; tally.failed++; g.failed++; g.gate = 'FAIL'; }
    else if (hasManual) { state = 'MANUAL_VERIFICATION_REQUIRED'; cs = 'MANUAL'; tally.manual++; g.manual++; }
    else if (hasAdvisory) { state = 'WARNING'; cs = 'WARNING'; tally.warning++; g.warning++; }
    else { state = 'PASSED'; cs = 'PASS'; tally.passed++; g.passed++; }
    transition(it, state, cs === 'PASS' ? 'all axes pass' : (active[0] ? active[0].axis + ': ' + active[0].detail : cs), at);
    it.certificationState = cs;

    for (const f of active) if (f.severity === 'blocking' || f.severity === 'advisory' || f.severity === 'manual') {
      explanations.push({
        id: it.id, type: it.type, identityKey: it.identityKey, axis: f.axis, ruleId: f.ruleId || null,
        severity: f.severity, detail: f.detail, viewport: f.viewport || null,
        confidence: f.confidence != null ? f.confidence : 1, lifecycle: it.state,
        evidenceId: (f.evidence && f.evidence.inventoryId) || it.id,
      });
    }
  }

  const verdict = tally.failed > 0 ? 'FAIL' : (tally.warning > 0 || tally.manual > 0) ? 'PASS WITH MINOR ISSUES' : 'PASS';
  return { verdict, gates, explanations, tally, exceptions };
}

module.exports = { certify };
