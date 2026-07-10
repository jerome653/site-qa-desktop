'use strict';
// fold.js — turn a visual-match run() result into the advisory "visual" suite (Suite 12) so it flows
// through the same pipeline as everything else: registry-native VIS findings → scoring (weight 0, no
// overall impact) → report → Scan Store → Finding lifecycle → Timeline → Regression gate. Deterministic.
//
// visual-match run() shape (see ../visual-match.js):
//   { pairs, unmatchedRef:[url], viewports:[label], pages:[ { path, ref, cand, viewports:[
//       { label, pixelMismatchPct, matchScore, struct:{missing,extra,moved,restyled} } ] } ], sharp }
const REG = require('../rules/registry');

function statusFor(ruleId) {
  const r = REG.getById(ruleId);
  return (r && (r.severity === 'critical' || r.severity === 'high')) ? 'fail' : 'warn';
}
function ruleRow(ruleId, items, targetPath) {
  const r = REG.getById(ruleId);
  return { name: r.title, ruleId, ruleSlug: r.slug, suite: 'visual', severity: r.severity, deduction: r.deduction,
    status: items.length ? statusFor(ruleId) : 'pass', target: targetPath || '',
    detail: items.length ? `${items.length} occurrence(s)` : 'clean', items: items.length ? items : undefined };
}

// threshold: a page-pair FAILS a viewport when pixelMismatchPct > pixelThreshold OR matchScore < matchThreshold.
function foldVisual(visual, opts = {}) {
  const pixelThreshold = opts.pixelThreshold != null ? opts.pixelThreshold : 8;   // %
  const matchThreshold = opts.matchThreshold != null ? opts.matchThreshold : 90;  // /100 (SG-Builder rule)
  const mismatchItems = [];
  const unmatchedItems = [];

  for (const pg of visual.pages || []) {
    for (const vp of pg.viewports || []) {
      const px = vp.pixelMismatchPct, ms = vp.matchScore;
      const overPixel = px != null && px > pixelThreshold;
      const underMatch = ms != null && ms < matchThreshold;
      if (overPixel || underMatch) {
        const st = vp.struct || {};
        const bits = [];
        if (px != null) bits.push(px + '% px');
        if (ms != null) bits.push(ms + '/100 match');
        const deltas = ['missing', 'extra', 'moved', 'restyled'].filter(k => st[k]).map(k => `${st[k]} ${k}`);
        if (deltas.length) bits.push(deltas.join(', '));
        mismatchItems.push({ page: pg.path || pg.cand || '', section: vp.label, id: 'viewport', value: bits.join(' · ').slice(0, 80) });
      }
    }
  }
  for (const u of visual.unmatchedRef || []) {
    unmatchedItems.push({ page: u, section: 'page', id: 'no-match', value: 'present on reference, missing on candidate' });
  }

  const sortI = a => a.sort((x, y) => (x.page + x.section).localeCompare(y.page + y.section));
  sortI(mismatchItems); sortI(unmatchedItems);

  return {
    key: 'visual', name: 'Visual Match', desc: 'Advisory · live vs staging, per breakpoint', icon: 'device', advisory: true,
    checks: [ruleRow('VIS-001', mismatchItems), ruleRow('VIS-002', unmatchedItems)],
    summary: {
      pairs: visual.pairs || 0,
      viewports: (visual.viewports || []).length,
      mismatches: mismatchItems.length,
      unmatched: unmatchedItems.length,
      sharp: !!visual.sharp,
      thresholds: { pixel: pixelThreshold, match: matchThreshold },
    },
  };
}

module.exports = { foldVisual };
