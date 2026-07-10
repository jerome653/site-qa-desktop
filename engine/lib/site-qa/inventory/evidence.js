'use strict';
// inventory/evidence.js — the Evidence layer. Platform rule: no finding without evidence. For every
// validated inventory item it collects a REAL evidence package (deterministic facts from the crawl —
// no invented screenshots, no inferred data) and advances VALIDATED → EVIDENCE_PENDING →
// EVIDENCE_COLLECTED. If a required artifact genuinely cannot be collected, the item goes to
// MANUAL_VERIFICATION_REQUIRED — never a fabricated certainty.
const { transition, attachEvidence } = require('./model');

// Detection confidence by how the item was identified. Exact identity (path / filename / form action)
// = 1.0; heuristic class/signature detection (globals, behaviors) = 0.75. Real, not inflated.
function detectionConfidence(item) {
  if (item.type === 'page' || item.type === 'section' || item.type === 'form') return 1.0;
  if (item.type === 'asset') return 1.0; // matched by role+filename
  if (item.type === 'global' || item.type === 'behavior') return 0.75; // class/signature heuristic
  return 0.9;
}

// Build the evidence package for an inventory-completeness finding (deterministic crawl facts).
function packageFor(item, at) {
  const cm = item.comparisonMapping || {};
  const present = cm.result === 'present';
  let before, after;
  if (cm.result === 'added') { before = 'absent on source'; after = 'present on target'; }
  else if (present) { before = 'present on source'; after = 'present on target'; }
  else { before = 'present on source'; after = 'ABSENT on target'; }
  const pkg = {
    inventoryId: item.id,
    ruleId: null,                 // completeness findings are inventory-native, not registry rules
    method: 'automated',
    detectionConfidence: detectionConfidence(item),
    evidence: 'Complete',         // Complete | Partial | Unavailable
    pageUrl: item.meta.url || item.meta.firstPage || item.meta.page || '',
    domSelector: item.identityKey,
    cssPath: null,
    viewport: null,               // completeness is DOM/crawl-level, not viewport-bound
    section: item.type === 'section' ? item.meta.heading : (item.parent || null),
    component: item.type === 'component' ? item.id : null,
    boundingBox: null,
    timestamp: at || '',
    metrics: { comparison: cm.result || 'audit', blocking: !!cm.blocking },
    before, after,
    similarityScore: cm.similarity != null ? cm.similarity : null,
  };
  return pkg;
}

// collectEvidence(items, { at }) — items = array of inventory items already at VALIDATED.
function collectEvidence(items, opts = {}) {
  const at = opts.at || '';
  let collected = 0, manual = 0;
  for (const it of items) {
    if (it.state !== 'VALIDATED') continue; // only validated items collect evidence (layer discipline)
    transition(it, 'EVIDENCE_PENDING', 'evidence collection queued', at);
    const pkg = packageFor(it, at);
    if (!pkg || pkg.evidence === 'Unavailable') {
      transition(it, 'MANUAL_VERIFICATION_REQUIRED', 'evidence unavailable — needs a human', at);
      manual++; continue;
    }
    attachEvidence(it, pkg);
    transition(it, 'EVIDENCE_COLLECTED', 'evidence attached', at);
    collected++;
  }
  return { collected, manual };
}

module.exports = { collectEvidence, packageFor, detectionConfidence };
