'use strict';
// lib/lenses.js — Inspector Lenses (Phase 2). Re-views the SAME findings through focused sub-scores by
// the `inspector` facet (seo / security / stability) plus the cross-cutting `interaction` facet
// (Interaction Integrity — "can every control be used?"). Additive: reads the canonical findings, changes
// nothing in the frozen Quality Score or the engine. A finding can appear in more than one lens (e.g. a
// dead link is both SEO and Interaction) — that is the point of facets.

const LENSES = [
  { key: 'seo', name: 'SEO', question: 'Will search engines crawl, index, and rank this correctly?' },
  { key: 'security', name: 'Security', question: 'Is the site hardened against common web attacks + exposure?' },
  { key: 'stability', name: 'Stability', question: 'Will the page render reliably and stay maintainable?' },
  { key: 'interaction', name: 'Interaction Integrity', question: 'Can a visitor actually use every control — every link, button, menu, form?', interaction: true, isNew: true },
];

function inLens(f, lens) {
  if (lens.interaction) return !!f.interaction;
  return f.inspector === lens.key;
}

// score = clamp(0..100, 100 − Σ deductions of the lens's findings). Deterministic; deductions come from
// the registry (via the contract finding's metadata). Pages/counts are informational.
function computeLenses(findings) {
  const out = {};
  for (const lens of LENSES) {
    const fs = (findings || []).filter(f => inLens(f, lens));
    const deduction = fs.reduce((a, f) => a + ((f.metadata && f.metadata.deduction) || 0), 0);
    const score = Math.max(0, Math.min(100, 100 - deduction));
    const pages = new Set(fs.map(f => (f.locator && f.locator.url) || null).filter(Boolean)).size;
    out[lens.key] = { key: lens.key, name: lens.name, question: lens.question, interaction: !!lens.interaction, isNew: !!lens.isNew, score, count: fs.length, pages };
  }
  return { lenses: LENSES.map(l => l.key), scores: out, model: 'sgen-lenses-v1' };
}

module.exports = { computeLenses, LENSES };
