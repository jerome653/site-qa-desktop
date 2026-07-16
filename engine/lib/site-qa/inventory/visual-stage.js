'use strict';
// inventory/visual-stage.js — the Visual Comparison integration. Reuses the EXISTING visual-match
// engine (site-qa/visual-match.js) — never rewrites it — and maps every visual result onto an
// Inventory Item (page/section), inventory-aware, per canonical SGEN breakpoint. Each mismatch attaches
// a complete evidence package (pixel %, match score, viewport, screenshots when present).
const { addFinding } = require('./model');
const { pathOf } = require('./providers');
// Shared with visual-match/fold.js on purpose: this line existed here AND there as two independent
// copies, and both got structDelta's shape wrong the same way ([object Object] in the evidence — see
// the helper's note). One copy, one shape contract, one place to fix it next time.
const { structDeltaLabels } = require('../visual-match/fold');

// visualStage(refInv, tgtInv, visualResult, { at, matchThreshold=90, pixelThreshold=8 })
// visualResult = visual-match run() output: { pages:[{ path, viewports|vps:[{label,pixelMismatchPct,matchScore,struct,shots}] }], unmatchedRef:[url] }
function visualStage(refInv, tgtInv, visualResult, opts = {}) {
  const at = opts.at || '';
  const matchThreshold = opts.matchThreshold != null ? opts.matchThreshold : 90;
  const pixelThreshold = opts.pixelThreshold != null ? opts.pixelThreshold : 8;
  let mapped = 0;

  for (const pg of (visualResult && visualResult.pages) || []) {
    const key = 'page:' + pathOf(pg.path || pg.cand || pg.url || '');
    const item = refInv.byKey.get(key) || tgtInv.byKey.get(key);
    if (!item) continue;
    let worst = 100;
    for (const vp of (pg.viewports || pg.vps || [])) {
      const px = vp.pixelMismatchPct, ms = vp.matchScore;
      if (ms != null) worst = Math.min(worst, ms);
      const over = (px != null && px > pixelThreshold) || (ms != null && ms < matchThreshold);
      if (!over) continue;
      const sev = (ms != null && ms < 75) ? 'blocking' : 'advisory'; // <75 = rebuild (blocking); 75–90 = warning
      const st = vp.struct || {};
      const deltas = structDeltaLabels(st).join(', ');
      addFinding(item, {
        axis: 'visual', ruleId: 'VIS-001', severity: sev, viewport: vp.label, confidence: 1,
        detail: `${px != null ? px + '% px · ' : ''}${ms != null ? ms + '/100 match' : ''}${deltas ? ' · ' + deltas : ''} [${vp.label}]`,
        evidence: { inventoryId: item.id, ruleId: 'VIS-001', method: 'automated', detectionConfidence: 1, evidence: 'Complete',
          viewport: vp.label, similarityScore: ms, pixelDiff: px, before: 'reference', after: 'target',
          shots: vp.shots || null, timestamp: at },
      });
      mapped++;
    }
    item.comparisonMapping = Object.assign({}, item.comparisonMapping, { visualSimilarity: worst });
  }
  for (const u of (visualResult && visualResult.unmatchedRef) || []) {
    const item = refInv.byKey.get('page:' + pathOf(u));
    if (!item) continue;
    addFinding(item, {
      axis: 'visual', ruleId: 'VIS-002', severity: 'blocking', confidence: 1,
      detail: 'reference page has no visual match on target',
      evidence: { inventoryId: item.id, ruleId: 'VIS-002', method: 'automated', detectionConfidence: 1, evidence: 'Complete', pageUrl: u, before: 'reference', after: 'no target match', timestamp: at },
    });
    mapped++;
  }
  return { mapped };
}

module.exports = { visualStage };
