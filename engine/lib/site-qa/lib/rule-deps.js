'use strict';
// lib/rule-deps.js — rule dependency resolver. Kills the "one broken page → 30 secondary findings" noise
// by suppressing rules whose precondition failed. Pure + deterministic.
//
//   dependsOn: [ruleId]   — this rule is only meaningful if those ran (informational; ordering hint)
//   skipIf:    [ruleId]   — if any of those FIRED (as fail/warn) on the same page, skip this rule there
//
// Example: HTTP-500 fires on /x  →  every rule listing skipIf:[FUNC-001] is suppressed for /x, so we
// don't emit "missing title / meta / schema / a11y" for a page that never loaded.

// firedByPage: { url -> Set(ruleId) } of fail/warn findings already produced on that page.
// Returns { skip: boolean, reason } for a candidate rule on a given page.
function shouldSkip(rule, url, firedByPage) {
  const skipIf = (rule && rule.skipIf) || [];
  if (!skipIf.length) return { skip: false, reason: null };
  const fired = firedByPage && firedByPage[url];
  if (!fired) return { skip: false, reason: null };
  for (const gate of skipIf) {
    if (fired.has(gate)) return { skip: true, reason: `skipped: ${gate} fired on ${url}` };
  }
  return { skip: false, reason: null };
}

// Topological order by dependsOn so gate rules run before dependents (stable, cycle-safe).
function order(rules) {
  const byId = new Map(rules.map(r => [r.id, r]));
  const seen = new Set(), out = [], stack = new Set();
  function visit(r) {
    if (!r || seen.has(r.id)) return;
    if (stack.has(r.id)) return; // cycle guard — leave order as-is for the offender
    stack.add(r.id);
    for (const dep of (r.dependsOn || [])) if (byId.has(dep)) visit(byId.get(dep));
    stack.delete(r.id);
    seen.add(r.id); out.push(r);
  }
  for (const r of rules) visit(r);
  return out;
}

// Build the firedByPage index from a flat list of findings ({ ruleId, status, location/url }).
function indexFired(findings) {
  const idx = {};
  for (const f of findings || []) {
    if (f.status !== 'fail' && f.status !== 'warn') continue;
    const url = f.url || f.location;
    if (!url || !f.ruleId) continue;
    (idx[url] = idx[url] || new Set()).add(f.ruleId);
  }
  return idx;
}

module.exports = { shouldSkip, order, indexFired };
