'use strict';
// inventory/compare.js — the Comparison layer. Diffs a REFERENCE inventory against a TARGET inventory
// by identity key and advances each source item through its lifecycle to VALIDATED, recording the
// comparison mapping. It does NOT assign terminal verdicts (that is the Certification layer) and never
// touches pages directly — it operates only on inventory items.
const { transition, addFinding } = require('./model');
const { isBlockingMissing } = require('./index');

// compare(ref, tgt, { allowRemoved:[identityKey], at }) → diff over inventory items.
function compare(refInv, tgtInv, opts = {}) {
  const allow = new Set(opts.allowRemoved || []);
  const at = opts.at || '';
  const perType = {};
  const matched = [], missing = [], added = [];
  const types = new Set([...Object.keys(refInv.items), ...Object.keys(tgtInv.items)]);

  for (const type of types) {
    const refItems = refInv.items[type] || [];
    const tgtItems = tgtInv.items[type] || [];
    const tgtByKey = new Map(tgtItems.map(i => [i.identityKey, i]));
    const refKeys = new Set(refItems.map(i => i.identityKey));
    let m = 0, miss = 0, add = 0;

    for (const it of refItems) {
      const hit = tgtByKey.get(it.identityKey);
      if (hit) {
        transition(it, 'MATCHED', 'target counterpart found', at);
        transition(it, 'COMPARED', 'compared to target', at);
        it.comparisonMapping = { result: 'present', targetId: hit.id, similarity: 1 };
        hit.referenceMapping = it.id;
        matched.push(it); m++;
      } else if (allow.has(it.identityKey)) {
        transition(it, 'COMPARED', 'no target counterpart (allow-listed)', at);
        it.comparisonMapping = { result: 'approved-removed', targetId: null, similarity: 0 };
      } else {
        const blocking = isBlockingMissing(it);
        // DEFECT-1 fix: a CAPPED crawl discovers only a subset of pages, so "absent from the target's
        // crawled subset" does NOT prove the item is missing. When capped, a missing item is
        // Manual-Verification (honest), never an asserted blocking/advisory failure. Uncapped =
        // authoritative. Globals/behaviors are still crawl-scope-dependent, so they follow the same rule.
        const capped = !!opts.capped;
        const sev = capped ? 'manual' : (blocking ? 'blocking' : 'advisory');
        transition(it, 'COMPARED', 'present on source, absent on target', at);
        it.comparisonMapping = { result: 'missing', targetId: null, similarity: 0, blocking, capped };
        addFinding(it, { axis: 'completeness', severity: sev, confidence: capped ? 0.5 : 1,
          detail: capped ? 'present on source; target crawl was CAPPED — cannot confirm absence, verify manually' : 'present on source, missing on target' });
        missing.push(it); miss++;
      }
      transition(it, 'VALIDATED', 'comparison validated', at);
    }
    // target-only items participate in the pipeline (Phase 6): they flow through the lifecycle, receive
    // production findings (Audit layer), and are certified — never ignored.
    for (const it of tgtItems) if (!refKeys.has(it.identityKey)) {
      it.meta.addedOnTarget = true;
      transition(it, 'COMPARED', 'exists only on target', at);
      it.comparisonMapping = { result: 'added', targetId: it.id, similarity: null };
      if (it.type === 'page') addFinding(it, { axis: 'completeness', severity: 'advisory', detail: 'page exists only on the migrated site — review whether intentional', confidence: 1 });
      transition(it, 'VALIDATED', 'target-only validated', at);
      added.push(it); add++;
    }
    perType[type] = { ref: refItems.length, target: tgtItems.length, matched: m, missing: miss, added: add };
  }
  return { perType, matched, missing, added };
}

module.exports = { compare };
