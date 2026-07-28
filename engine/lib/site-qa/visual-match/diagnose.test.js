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

// ── 6 · reference RESOLVED but never answered (blackholed / timed out) ────────────────────────────
// The failure this group exists to kill. floraterraca.com resolves fine and serves 200 to the rest of
// the world, but every packet from this network is dropped — so the crawl timed out. The old wording
// ("DNS or connection failure … check the URL is correct") blamed the URL, which was never wrong, and
// sent the operator hunting a typo instead of a route. A timeout must say so, and must point OUTWARD
// at the network rather than at the address.
// Every code here was OBSERVED against the live host, not imagined. 'UND_ERR_CONNECT_TIMEOUT' is what
// undici actually emits when a host is blackholed and its own connect timeout fires before our
// AbortController — the real floraterraca.com case. An earlier cut of this fix matched only 'ETIMEDOUT',
// passed its unit test on that synthetic code, and STILL produced the useless generic message against
// the live site. Keep the real codes in this list; do not trim it to the tidy POSIX-looking ones.
(function refTimedOut() {
  for (const code of ['UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'ETIMEDOUT', 'EHOSTUNREACH']) {
    const d = diagnoseEmpty({
      aHtml: [], bHtml: [{}], refStatuses: [0], candStatuses: [200], pairs: [],
      refErrors: [code],
    });
    eq(d.reason, 'reference-unreachable', `ref-timeout[${code}]: reason is reference-unreachable`);
    ok(/timed out|unreachable/i.test(d.message), `ref-timeout[${code}]: message says timed out / unreachable`);
    ok(/network/i.test(d.message), `ref-timeout[${code}]: message points at THIS network as the suspect`);
    ok(!/DNS/i.test(d.message), `ref-timeout[${code}]: message does NOT blame DNS (the name resolved fine)`);
    ok(!/spelled/i.test(d.message), `ref-timeout[${code}]: message does NOT tell the operator to check spelling`);
  }
})();

// ── 7 · reference name did not resolve (real DNS failure) → blame DNS, and only here ──────────────
(function refDnsFail() {
  const d = diagnoseEmpty({
    aHtml: [], bHtml: [{}], refStatuses: [0], candStatuses: [200], pairs: [],
    refErrors: ['ENOTFOUND'],
  });
  eq(d.reason, 'reference-unreachable', 'ref-dns: reason is reference-unreachable');
  ok(/DNS|resolve/i.test(d.message), 'ref-dns: message names DNS / resolution as the cause');
  ok(/spelled|correct/i.test(d.message), 'ref-dns: message DOES tell the operator to check the address');
})();

// ── 8 · reference actively refused the connection → distinct from both silence and DNS ────────────
(function refRefused() {
  const d = diagnoseEmpty({
    aHtml: [], bHtml: [{}], refStatuses: [0], candStatuses: [200], pairs: [],
    refErrors: ['ECONNREFUSED'],
  });
  ok(/refused/i.test(d.message), 'ref-refused: message says the connection was refused');
  ok(!/DNS/i.test(d.message), 'ref-refused: message does NOT blame DNS');
})();

// ── 9 · candidate side gets the same treatment (wording rule is shared, not ref-only) ─────────────
(function candTimedOut() {
  const d = diagnoseEmpty({
    aHtml: [{}], bHtml: [], refStatuses: [200], candStatuses: [0], pairs: [],
    candErrors: ['ETIMEDOUT'],
  });
  eq(d.reason, 'candidate-unreachable', 'cand-timeout: reason is candidate-unreachable');
  ok(/timed out/i.test(d.message), 'cand-timeout: message says the connection timed out');
})();

// ── 10 · no error detail at all → the old generic wording still stands (back-compat, no over-claim) ─
// An older caller that never passes refErrors must keep working. It may say "connection", but with no
// evidence of WHICH failure it must not assert a specific cause it cannot know.
(function noErrorDetail() {
  const d = diagnoseEmpty({ aHtml: [], bHtml: [{}], refStatuses: [0], candStatuses: [200], pairs: [] });
  eq(d.reason, 'reference-unreachable', 'no-detail: reason is reference-unreachable');
  ok(/connection/i.test(d.message), 'no-detail: message still mentions a connection failure');
  ok(!/timed out/i.test(d.message), 'no-detail: message does not invent a timeout it cannot prove');
})();

console.log('\n' + (fail === 0 ? '✅ PASS' : '❌ FAIL') + ` — ${pass}/${pass + fail} assertions`);
if (fail) { console.log('Failures:\n' + failures.map(f => '  - ' + f).join('\n')); process.exit(1); }
