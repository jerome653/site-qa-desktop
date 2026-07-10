'use strict';
// contract.js — the frozen Finding Contract v1 (ADR-0003). ONE canonical shape every finding conforms
// to. `toContract()` projects the engine's enriched finding (+ optional occurrence/locator data) into
// the contract WITHOUT changing scoring or any existing field — a pure, deterministic, additive
// projection. Rules never build this by hand: shared services (locator/fingerprint) supply the parts;
// this module assembles them into the canonical shape.
//
// Backward-compatible: today's de-facto finding (name/detail/value/items/…) maps in cleanly; fields the
// registry doesn't carry yet (inspector/interaction/fixability/impact/lastModified) default sensibly and
// enrich as Stage 1/2 populate them. Frozen scoring is untouched — the contract is a reporting/interop
// projection, not a scoring input.

const reg = require('./rules/registry');
const { fingerprintOf, normalizeUrl, normalizeEvidence } = require('./lib/fingerprint');

const CONTRACT_VERSION = '1.0';
const EVIDENCE_QUALITY = ['verified', 'derived', 'heuristic'];
const FIXABILITY = ['none', 'manual', 'guided', 'automatic'];
const LOCATOR_TYPES = ['dom', 'build-artifact', 'manifest', 'route', 'configuration', 'page'];
const IMPACT_AXES = ['seo', 'a11y', 'security', 'devEffort']; // NO "affected users" — not measurable offline

// Fingerprint + URL/evidence normalization come from the single fingerprint service (lib/fingerprint).

// evidenceQuality: rule declares it; default 'verified' (directly observed). derived/heuristic are opt-in
// per rule so a rule can't accidentally over-claim certainty.
function evidenceQualityOf(rule) {
  const q = rule && rule.evidenceQuality;
  return EVIDENCE_QUALITY.includes(q) ? q : 'verified';
}

// Assemble a contract-shaped finding. `f` is the engine's enriched finding; `opts` carries anything the
// flat finding doesn't have yet (locator strategies, bbox, copyAs, recommendation, observedAt).
function toContract(f, opts = {}) {
  const rule = f && f.ruleId ? reg.getById(f.ruleId) : null;
  const url = opts.url || f.location || (f.items && f.items[0] && f.items[0].page) || null;
  const selector = opts.selector || (f.items && f.items[0] && f.items[0].id) || null;

  const evidence = {
    observed: opts.observed || f.detail || '',
    expected: opts.expected || '',
    detail: f.detail || '',
    value: f.value != null ? String(f.value) : (opts.value != null ? String(opts.value) : ''),
    screenshot: f.evidence ? String(f.evidence).split(/[\\/]/).pop() : (opts.screenshot || null),
  };

  // Locator: null for page-level findings (no element). Generic + type-tagged so Build Integrity reuses
  // it. A provider-built locator (opts.locator, from the DOM/Render provider) wins; otherwise a single
  // css strategy is supplied from the raw selector.
  const locator = opts.locator ? opts.locator : selector ? {
    type: opts.locatorType || 'dom',
    target: selector,
    strategies: (opts.strategies && opts.strategies.length) ? opts.strategies : [{ kind: 'css', value: selector, stability: 'unknown' }],
    url,
    boundingBox: opts.boundingBox || null,
    copyAs: opts.copyAs || null,
    source: opts.source || null,
    sourceAvailability: opts.source ? 'available' : 'requires-build-provenance',
  } : null;

  // prefer the locator's most-stable strategy for the fingerprint so it survives DOM churn
  const fpSelector = (locator && Array.isArray(locator.strategies) && locator.strategies.length)
    ? locator.strategies[0].value : selector;
  const fingerprint = fingerprintOf({ ruleId: f.ruleId, url, selector: fpSelector, evidence });

  return {
    id: fingerprint,
    ruleId: f.ruleId || null,
    ruleVersion: rule ? (rule.lastModified || rule.introduced || '1.0') : null,
    inspector: rule ? (rule.inspector || null) : null,
    category: f.suite || (rule && rule.suite) || null,
    interaction: rule ? !!rule.interaction : false,
    severity: f.severity || (rule && rule.severity) || null,
    tier: (f.tier !== undefined && f.tier !== null) ? f.tier : (rule ? rule.tier : null),
    evidenceQuality: evidenceQualityOf(rule),
    fingerprint,
    locator,
    evidence,
    relationships: {
      rootCause: (rule && rule.rootCause) || null,
      relatesTo: (rule && Array.isArray(rule.relatesTo)) ? rule.relatesTo : [],
    },
    impacts: normalizeImpacts(rule && rule.impact),
    fix: {
      fixability: FIXABILITY.includes(rule && rule.fixability) ? rule.fixability : 'manual',
      recommendation: opts.recommendation || (rule && rule.recommendation) || '',
      actions: { openInBuilder: false, openSource: false, openComponent: false, applyFix: false, markFixed: false, rerunRule: false },
    },
    metadata: {
      status: f.status || null,
      name: f.name || (rule && rule.title) || null,
      deduction: f.deduction || 0,
      method: f.method || (rule && rule.method) || null,
      cost: (rule && rule.cost) || null,
      docs: f.docs || (rule && rule.docs) || null,
    },
    timestamps: { observedAt: opts.observedAt || null },
    contractVersion: CONTRACT_VERSION,
  };
}

function normalizeImpacts(impact) {
  const out = {};
  for (const ax of IMPACT_AXES) out[ax] = (impact && impact[ax]) || null;
  return out;
}

// The five-question invariant: a complete finding answers all five. Returns the list of unanswered
// questions (empty = complete). Manual/pass rows are exempt (no defect asserted).
function fiveQuestionGaps(c) {
  const gaps = [];
  if (!c.ruleId || !c.metadata.name || !c.evidence.observed) gaps.push('what');       // what is wrong
  if (!c.locator && !(c.evidence && c.evidence.detail) && !(c.locator && c.locator.url)) gaps.push('where'); // where (page-level ok if url/detail)
  if (!EVIDENCE_QUALITY.includes(c.evidenceQuality)) gaps.push('certainty');          // how certain
  if (c.severity == null && c.tier == null) gaps.push('why');                         // why it matters
  if (!c.fix || (!c.fix.recommendation && !c.fix.fixability)) gaps.push('how');        // how to fix
  return gaps;
}

module.exports = {
  CONTRACT_VERSION, EVIDENCE_QUALITY, FIXABILITY, LOCATOR_TYPES, IMPACT_AXES,
  toContract, fingerprintOf, fiveQuestionGaps, normalizeUrl, normalizeEvidence,
};
