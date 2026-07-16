'use strict';
// fold.js — turn a visual-match run() result into the advisory "visual" suite (Suite 12) so it flows
// through the same pipeline as everything else: registry-native VIS findings → scoring (weight 0, no
// overall impact) → report → Scan Store → Finding lifecycle → Timeline → Regression gate. Deterministic.
//
// visual-match run() shape (see ../visual-match.js):
//   { pairs, unmatchedRef:[url], viewports:[label], mode, pixelPass, sharp, pages:[ { path, ref, cand,
//       fontDrift:[{check:'font-drift',family,selector,value,detail}], fontDriftAt,
//       viewports:[ { label, pixelMismatchPct, matchScore, struct:{missing,extra,moved,restyled} } ] } ] }
const REG = require('../rules/registry');

// structDelta() reports missing/extra/moved/restyled as ARRAYS OF ELEMENTS (matched/refCount are the
// only counts on that object). Both consumers of the shape — this fold and inventory/visual-stage.js —
// independently assumed they were numbers, so every real VIS-001 evidence string since 1.3 has read:
//
//   "86.04% px · 57/100 match ·  missing,  extra,  moved, [object Object],[object Object] restyled"
//
// Two faults in one line: `[]` is truthy, so empty categories were listed with a blank count; and
// interpolating an array of elements yields [object Object]. It survived because the fold fixtures in
// pipeline.test.js / inventory.test.js pass NUMBERS (`struct:{moved:2}`) — a shape the engine has never
// emitted — so the suites were green against data that could not occur. Tolerates both shapes (arrays
// from the engine, numbers from those fixtures and any stored pre-fix result) and drops empty ones.
function structDeltaLabels(st) {
  return ['missing', 'extra', 'moved', 'restyled'].map((k) => {
    const v = (st || {})[k];
    const n = Array.isArray(v) ? v.length : (typeof v === 'number' ? v : 0);
    return n ? `${n} ${k}` : null;
  }).filter(Boolean);
}

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
  const driftItems = [];
  // The mode is read off the RESULT, so a fold is correct without the caller having to remember to
  // re-supply it (pipeline.js forwards its own opts here, which never carried the run's mode). A result
  // from before 1.12.0 has no `mode` → like-for-like → folds exactly as it always did.
  const redesign = visual.mode === 'redesign';

  for (const pg of visual.pages || []) {
    for (const vp of pg.viewports || []) {
      const px = vp.pixelMismatchPct, ms = vp.matchScore;
      // Second gate on the pixel pass, independent of the engine's. run() already returns pct:null in
      // redesign mode so this is belt-and-braces — it fails CLOSED if a pct ever reaches a redesign
      // fold by another route (a hand-built result, a re-fold of an edited JSON, a future caller that
      // computes pixels itself). VIS-001 asserts "mismatch vs reference exceeds threshold"; on a
      // redesign that assertion is not false, it is meaningless — so it must not be made at all.
      const overPixel = !redesign && px != null && px > pixelThreshold;
      const underMatch = ms != null && ms < matchThreshold;
      if (overPixel || underMatch) {
        const st = vp.struct || {};
        const bits = [];
        // Quote the pixel number only where it is evidence. On a redesign VIS-001 can still fire — but
        // only ever on the STRUCTURAL axis (see overPixel above), so citing a pixel % in its evidence
        // would credit a measurement that played no part in the finding. run() returns pct:null in
        // redesign mode, so this only bites a hand-built or re-folded result — which is exactly the
        // case this second gate exists for.
        if (!redesign && px != null) bits.push(px + '% px');
        if (ms != null) bits.push(ms + '/100 match');
        const deltas = structDeltaLabels(st);
        if (deltas.length) bits.push(deltas.join(', '));
        mismatchItems.push({ page: pg.path || pg.cand || '', section: vp.label, id: 'viewport', value: bits.join(' · ').slice(0, 80) });
      }
    }
    // VIS-003 — font drift. Page-level: run() swept ONE viewport per pair, so one item per drifted
    // family per page. Item shape mirrors the font findings checks-render.js emits for FONT-001..006
    // (id = selector, section = "font: <family>"), so a font row reads the same in either lane.
    for (const d of pg.fontDrift || []) {
      driftItems.push({ page: pg.path || pg.cand || '', section: d.family ? `font: ${d.family}` : '—',
        id: d.selector || '(element)', value: String(d.value == null ? '' : d.value).slice(0, 80) });
    }
  }
  for (const u of visual.unmatchedRef || []) {
    unmatchedItems.push({ page: u, section: 'page', id: 'no-match', value: 'present on reference, missing on candidate' });
  }

  const sortI = a => a.sort((x, y) => (x.page + x.section).localeCompare(y.page + y.section));
  sortI(mismatchItems); sortI(unmatchedItems); sortI(driftItems);

  return {
    key: 'visual', name: 'Visual Match', desc: 'Advisory · live vs staging, per breakpoint', icon: 'device', advisory: true,
    checks: [ruleRow('VIS-001', mismatchItems), ruleRow('VIS-002', unmatchedItems), ruleRow('VIS-003', driftItems)],
    summary: {
      pairs: visual.pairs || 0,
      viewports: (visual.viewports || []).length,
      mismatches: mismatchItems.length,
      unmatched: unmatchedItems.length,
      fontDrift: driftItems.length,
      mode: visual.mode || 'like-for-like',
      pixelPass: !redesign,
      sharp: !!visual.sharp,
      thresholds: { pixel: pixelThreshold, match: matchThreshold },
    },
  };
}

module.exports = { foldVisual, structDeltaLabels };
