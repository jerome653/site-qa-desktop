'use strict';
// diagnose.test.js — deterministic suite for diagnoseEmpty() (visual-match.js).
//
// diagnoseEmpty is PURE — it turns the facts run() already computed (aHtml/bHtml/pairs + the distinct HTTP
// statuses seen on each crawl) into the REASON a comparison produced zero page pairs — so every branch is
// provable here without Chromium, matching this repo's no-browser test convention (grade.test.js builds
// its run fixtures the same way). Locks the failure mode this fix exists to kill: a reference that returns
// non-200 (WAF 403, connection failure) used to complete as a silent ok:true / pairs:0 "success" with no
// report and no explanation. Now each empty-pairing cause maps to a distinct reason + operator message.
const { diagnoseEmpty } = require('../visual-match');

let pass = 0, fail = 0; const failures = [];
function ok(c, n) { if (c) pass++; else { fail++; failures.push(n); console.log('  ✗ ' + n); } }
function eq(a, b, n) { const p = JSON.stringify(a) === JSON.stringify(b); ok(p, n + (p ? '' : ` (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`)); }

console.log('diagnoseEmpty() — empty-comparison diagnosis — test suite\n');

// ── 1 · reference blocked by a WAF (HTTP 403) → reference-unreachable, names the status + the fix ──
(function refBlocked() {
  const d = diagnoseEmpty({ aHtml: [], bHtml: [{}], refStatuses: [403], candStatuses: [200], pairs: [] });
  eq(d.ok, false, 'ref-403: ok is false');
  eq(d.reason, 'reference-unreachable', 'ref-403: reason is reference-unreachable');
  ok(d.message.includes('403'), 'ref-403: message names the 403 status');
  ok(d.message.includes('allowlist'), 'ref-403: message tells the operator to ask for an allowlist');
})();

// ── 2 · reference connection failure (status 0) → reference-unreachable, connection wording ──
(function refConnFail() {
  const d = diagnoseEmpty({ aHtml: [], bHtml: [{}], refStatuses: [0], candStatuses: [200], pairs: [] });
  eq(d.reason, 'reference-unreachable', 'ref-0: reason is reference-unreachable');
  ok(d.message.includes('connection'), 'ref-0: message mentions a connection failure');
})();

// ── 3 · candidate (staging) blocked → candidate-unreachable ──
(function candBlocked() {
  const d = diagnoseEmpty({ aHtml: [{}], bHtml: [], refStatuses: [200], candStatuses: [403], pairs: [] });
  eq(d.reason, 'candidate-unreachable', 'cand-403: reason is candidate-unreachable');
  ok(d.message.includes('403'), 'cand-403: message names the 403 status');
})();

// ── 4 · both reachable but no shared paths → no-common-pages ──
(function noCommon() {
  const d = diagnoseEmpty({ aHtml: [{}], bHtml: [{}], refStatuses: [200], candStatuses: [200], pairs: [] });
  eq(d.reason, 'no-common-pages', 'no-common: reason is no-common-pages');
  ok(d.message.includes('matching page paths'), 'no-common: message explains no matching paths');
})();

// ── 5 · healthy comparison (has pairs) → null, never a false alarm ──
(function healthy() {
  const d = diagnoseEmpty({ aHtml: [{}], bHtml: [{}], refStatuses: [200], candStatuses: [200], pairs: [{ path: '/' }] });
  eq(d, null, 'healthy: a comparison with ≥1 pair returns null');
})();

console.log('\n' + (fail === 0 ? '✅ PASS' : '❌ FAIL') + ` — ${pass}/${pass + fail} assertions`);
if (fail) { console.log('Failures:\n' + failures.map(f => '  - ' + f).join('\n')); process.exit(1); }
