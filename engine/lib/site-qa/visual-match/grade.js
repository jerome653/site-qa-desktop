'use strict';
// grade.js — turn a visual-match run() result into SEVERITY-GRADED findings and a reference-fidelity
// score, per Jerome's four tiers. Pure, deterministic, no I/O.
//
// THE MODEL — reference fidelity, not a raw deduction total:
//   score = 100 × (1 − Σ penalty(kept findings) / Σ reference weight)
// The denominator is the reference-element budget (a bounded worst case: every reference element could
// be missing). Each finding subtracts a fraction of ONE reference element, by tier. So the number means
// "the share of the reference the candidate faithfully reproduced, penalty-weighted by severity":
//   • bounded [0,100] — all-faithful = 100, everything-missing = 0, and it CANNOT floor (it is a ratio,
//     not v1's `100 − Σded`; see score.js header for why the absolute form was abandoned).
//   • count-sensitive — 5 missing elements cost 5× one missing element (unlike the audit's per-rule
//     model, which is deliberately count-agnostic). "5 missing is worse than 1" is the whole point here.
//   • keep/ignore honest — an ignored finding contributes 0 to the numerator, so the score recomputes
//     upward by exactly that finding's weight and nothing else. De-scoping a MISSING lifts the score;
//     de-scoping an IMPROVEMENT (penalty 0) never moves it. Not a discount dial.
//   • generalises structScore — which is this model with {MISSING:1, everything else:0}.
//
// Jerome's four tiers → detected source (visual-match.js structDelta + run()):
//   MISSING     (high)       — reference element/page absent on candidate   (structDelta.missing, unmatchedRef)
//   DEFECT      (issue)      — matched but wrong: font/size/colour/BACKGROUND restyle, or font drift
//   SPACING     (tolerable)  — matched but moved > threshold                 (structDelta.moved)
//   IMPROVEMENT (acceptable) — candidate has something the reference did not (structDelta.extra) — penalty 0

// Strictness profiles = the "how strict" dial (selectable per run). Penalties are fractions of ONE
// reference element. Owner-tunable — this is the ONLY place the numbers live.
const PROFILES = {
  strict:   { MISSING: 1.0, DEFECT: 0.6,  SPACING: 0.25, IMPROVEMENT: 0 },
  balanced: { MISSING: 1.0, DEFECT: 0.4,  SPACING: 0.1,  IMPROVEMENT: 0 },
  lenient:  { MISSING: 0.8, DEFECT: 0.25, SPACING: 0.05, IMPROVEMENT: 0 },
};
const DEFAULT_PROFILE = 'balanced';
const PROFILE_NAMES = Object.keys(PROFILES);
function profileOf(name) { return PROFILES[name] || PROFILES[DEFAULT_PROFILE]; }
function normalizeProfile(name) { return PROFILES[name] ? name : DEFAULT_PROFILE; }

const TIERS = ['MISSING', 'DEFECT', 'SPACING', 'IMPROVEMENT'];
const TIER_LABEL = { MISSING: 'Missing', DEFECT: 'Design defect', SPACING: 'Spacing / padding', IMPROVEMENT: 'Improvement' };

function idOf(el) { el = el || {}; return (el.text || el.aria || el.ialt || el.src || el.href || el.head || '').toString().toLowerCase().slice(0, 40); }
function elemKey(el) { el = el || {}; return `${el.sec || ''}|${el.tag || ''}|${idOf(el)}`; }

// Stable finding id: page + kind + element-key, hashed. Stable across re-runs of the SAME comparison so a
// keep/ignore decision survives a re-rate. djb2, base36 — deterministic, no crypto dep.
function findingId(page, kind, el) {
  const raw = `${page}::${kind}::${elemKey(el)}`;
  let h = 5381; for (let i = 0; i < raw.length; i++) h = ((h << 5) + h + raw.charCodeAt(i)) >>> 0;
  return kind.slice(0, 4) + '-' + h.toString(36);
}

function labelFor(kind, el, detail) {
  const who = (el && (el.text || el.head || el.ialt || el.aria)) ? `“${(el.text || el.head || el.ialt || el.aria).slice(0, 40)}”` : (el && el.tag ? `<${el.tag}>` : 'element');
  switch (kind) {
    case 'missing-page': return `Reference page not found on candidate`;
    case 'missing-element': return `Missing ${el.tag || 'element'} ${who}`;
    case 'background': return `Background changed on ${el.tag || 'element'} ${who}`;
    case 'restyle': return `Restyled ${el.tag || 'element'} ${who}`;
    case 'font-drift': return `Font changed${detail ? ` (${detail})` : ''}`;
    case 'moved': return `Moved ${el.tag || 'element'} ${who}`;
    case 'extra': return `New ${el.tag || 'element'} ${who} (not on reference)`;
    default: return `${kind} ${who}`;
  }
}

// Primary viewport for a page = the FIRST recorded (widest by default, where the full design is present).
// Grading the widest avoids counting intentional responsive hides as "missing" on narrow widths. Per-
// viewport occurrence is still recorded on each finding for the report.
function primaryVp(pg) { const v = (pg && pg.viewports) || []; return v[0] || null; }

function median(nums) {
  const a = nums.filter(n => n > 0).sort((x, y) => x - y);
  if (!a.length) return 0;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2);
}

// grade(visual, opts) — opts.profile: 'strict'|'balanced'|'lenient'; opts.excludeIds: string[] of finding
// ids the operator chose to IGNORE (post-check re-rate). Returns the graded model + score.
function grade(visual, opts = {}) {
  const profile = normalizeProfile(opts.profile);
  const P = profileOf(profile);
  const excluded = new Set(Array.isArray(opts.excludeIds) ? opts.excludeIds : []);
  const pages = visual.pages || [];

  // A missing whole page is modelled as `medianRef` missing elements, so pages and elements share ONE
  // unit (reference elements) in the ratio instead of being bolted on as an incomparable second scale.
  const refCounts = pages.map(pg => { const v = primaryVp(pg); return (v && v.struct && v.struct.refCount) || 0; });
  const medianRef = median(refCounts) || 1;

  const byId = new Map();
  const add = (page, section, kind, tier, el, detail, vpLabel, refWeight) => {
    const id = findingId(page, kind, el);
    let f = byId.get(id);
    if (!f) {
      f = { id, page, section: section || (el && el.sec) || '', tier, kind,
        label: labelFor(kind, el, detail), detail: detail || '',
        element: idOf(el) || (el && el.tag) || '', viewports: [],
        penalty: P[tier] || 0, refWeight: refWeight != null ? refWeight : 1 };
      byId.set(id, f);
    }
    if (vpLabel && !f.viewports.includes(vpLabel)) f.viewports.push(vpLabel);
    return f;
  };

  for (const pg of pages) {
    const page = pg.path || pg.cand || '';
    const vp = primaryVp(pg);
    const st = (vp && vp.struct) || {};
    const vpl = vp && vp.label;
    for (const el of (st.missing || [])) add(page, el.sec, 'missing-element', 'MISSING', el, '', vpl);
    for (const m of (st.moved || [])) { const el = m.el || m; add(page, el.sec, 'moved', 'SPACING', el, (m.fromSec && m.toSec) ? `${m.fromSec}→${m.toSec}` : '', vpl); }
    for (const rs of (st.restyled || [])) {
      const el = rs.el || rs;
      const isBg = !!rs.bg;
      add(page, el.sec, isBg ? 'background' : 'restyle', 'DEFECT', el, (rs.diffs || []).join('; '), vpl);
    }
    for (const el of (st.extra || [])) add(page, el.sec, 'extra', 'IMPROVEMENT', el, '', vpl);
    for (const d of (pg.fontDrift || [])) add(page, 'typography', 'font-drift', 'DEFECT', { tag: 'font', text: d.family || '', sec: 'typography' }, d.family || '', pg.fontDriftAt || (vp && vp.label));
  }
  // Unmatched reference pages — MISSING, page-weighted (≈ one whole page of elements).
  for (const u of (visual.unmatchedRef || [])) {
    add(u, 'page', 'missing-page', 'MISSING', { tag: 'page', head: u, sec: 'page' }, '', null, medianRef);
  }

  const findings = [...byId.values()];
  // Denominator = reference-element budget: matched pages' element counts + a page's worth per missing page.
  const pageBudget = refCounts.reduce((a, n) => a + n, 0);
  const missingPageBudget = (visual.unmatchedRef || []).length * medianRef;
  const denominator = pageBudget + missingPageBudget;

  // Numerator = Σ penalty × refWeight over KEPT (non-excluded) findings.
  let numerator = 0;
  const tiers = {}; TIERS.forEach(t => tiers[t] = { count: 0, ignored: 0, penalty: 0, label: TIER_LABEL[t] });
  for (const f of findings) {
    const ignored = excluded.has(f.id);
    f.ignored = ignored;
    const contrib = (f.penalty || 0) * (f.refWeight || 1);
    tiers[f.tier].count += 1;
    if (ignored) { tiers[f.tier].ignored += 1; continue; }
    tiers[f.tier].penalty += contrib;
    numerator += contrib;
  }

  const score = denominator > 0 ? Math.max(0, Math.min(100, Math.round(100 * (1 - numerator / denominator)))) : null;

  // sort findings worst-first: tier order, then penalty contribution, then page
  const tierRank = { MISSING: 0, DEFECT: 1, SPACING: 2, IMPROVEMENT: 3 };
  findings.sort((a, b) => (tierRank[a.tier] - tierRank[b.tier]) || ((b.penalty * b.refWeight) - (a.penalty * a.refWeight)) || a.page.localeCompare(b.page));

  return {
    model: 'sgen-visual-fidelity-v1',
    profile,
    score,
    numerator: +numerator.toFixed(2),
    denominator,
    findings,
    tiers,
    counts: { total: findings.length, ignored: findings.filter(f => f.ignored).length },
    excludeIds: [...excluded],
  };
}

module.exports = { grade, PROFILES, PROFILE_NAMES, DEFAULT_PROFILE, normalizeProfile, profileOf, findingId, TIERS, TIER_LABEL };
