'use strict';
// run-all.js — the single command that runs every auditor test suite and aggregates the result.
// Deterministic discovery (sorted), bounded perf N so the full run stays fast, non-zero exit on any
// failure. This is the Testing pillar's gate: "all suites green" is provable in one command.
//
//   node testing/run-all.js
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..');
// Explicit, ordered suite list (foundation → history → advisory → self). Explicit beats globbing:
// the run fails loudly if a known suite file goes missing, instead of silently covering less.
const SUITES = [
  // REPOSITORY INTEGRITY — runs FIRST because every other suite in this list validates the WORKING
  // TREE, and this one validates what is actually COMMITTED. Those differed, and the difference was a
  // release blocker: two runtime sources were never committed while committed code required them.
  'testing/repo-integrity.test.js',
  // RELEASE PROVENANCE — the other half of integrity. repo-integrity asks whether every require()
  // RESOLVES to a tracked path; it passed throughout while ~1,005 lines of product work lived only in
  // the working tree, because a committed test asserting an uncommitted FEATURE resolves perfectly.
  // This gate compares SHIPPED against COMMITTED. Structural tier here; SGEN_RELEASE_GATE=1 adds the
  // clean-checkout requirement and re-runs this whole suite from the committed artifact.
  'testing/release-gate.js',
  // The security self-audit. It was written, then left out of this list, and spent the entire ADR
  // programme failing unnoticed on a false positive nobody was running. An unregistered gate is not a
  // gate. (D4)
  'testing/security-audit.js',
  'rules/registry.test.js',
  'evidence-name.test.js',
  // The no-hang gate. Registered here because the failure it covers is invisible to every other suite:
  // a wedged run produces no output to assert against, so nothing else in this list can fail on it.
  'deadline.test.js',
  'consent.test.js',
  'blocking-overlay.test.js',
  'contract.test.js',
  'readiness.test.js',
  'font-checks.test.js',
  // v5 reference-fidelity scorer + its background-image sensor. Pure functions, no browser: grade()
  // turns structural facts into tier-graded findings + a score; structDelta()'s bg axis is the only
  // sensor for backgrounds on a redesign-mode run, so both are gated here against fixtures.
  'visual-match/grade.test.js',
  'visual-match/structdelta-bg.test.js',
  // diagnoseEmpty(): a 0-pair comparison (blocked/unreachable reference or candidate, or no shared paths)
  // must report the REASON, never complete as a silent ok:true/pairs:0 "success". Pure, no browser.
  'visual-match/diagnose.test.js',
  'pass-label-reachability.test.js',
  // The render pass must never report a check it did not run as a check that passed. Real Chromium +
  // the real stored sgen.com runs — it re-derives the cost of axe-core's silence (a11y 66 vs an honest
  // 59) from report.json through the real scorer, so a fixture cannot agree with the bug.
  '../migration-qa/render-honesty.test.js',
  'score-evaluation.test.js',
  // "I looked and it is clean" vs "I never looked". Drives the REAL runAudit against a real
  // non-resolving host (37 green ticks, quality 98, before the fix) and through a REAL poisoned
  // module in the require cache, so no fixture can agree with the bug.
  'evaluation-ledger.test.js',
  // annotate.test.js (66 assertions) shipped in 3.0.0 but was left out of this list purely because
  // an earlier instruction pinned the suite count at 25 — a test that never runs is not a test.
  'annotate.test.js',
  'lib/infra.test.js',
  'lib/providers.test.js',
  'lib/interaction.test.js',
  'lib/security.test.js',
  'lib/seo.test.js',
  'lib/stability.test.js',
  'lib/lenses.test.js',
  // D6 (ADR-0004 §D6). Scans the WHOLE tree -- test files included -- for any file that re-declares a
  // version stream, and proves the scanner can catch one. A restated literal is a second authority;
  // that is exactly how foundation.test.js sat red for weeks on a stale REPORT_VERSION.
  'version-authority.test.js',
  'testing/foundation.test.js',
  // Boots the real server and parses the client script it SERVES. The dashboard is ~66 KB of JS
  // inside a template literal, so `node --check` passes while the emitted script is unparseable and
  // every tool on the page is dead. Nothing else in this list can see that.
  'testing/ui-script.test.js',
  // ADR-0008 infrastructure. Runs BEFORE the five stores that now depend on it: if the shared
  // primitives are broken, the store suites' failures would be symptoms and this one names the cause.
  // Asserts every store's digest resolves to the SAME function object, not merely an equal value.
  'immutable-store/immutable-store.test.js',
  'scan-store/scan-store.test.js',
  // ADR-0009. The Collection Store is a RecordStore SUBCLASS — the suite asserts inheritance by
  // prototype identity, so "configuration, not a sixth implementation" is measurable rather than a
  // claim. Placed after immutable-store so a broken primitive names itself first.
  'collection-store/collection-store.test.js',
  // ADR-0010. Replays sealed collections through the deterministic PROVIDER layer (not the rules
  // layer — that is still page-first, and the suite asserts the engine claims no findings/score).
  'replay/replay.test.js',
  // Phase 3 producer wiring. Drives the REAL runAudit against a REAL local server twice -- with and
  // without collection persistence -- and asserts the audit result is byte-identical. The only two
  // fields that ever differed were the run timestamp and a Date.now() duration, both normalised.
  'collection-store/producer.test.js',
  // D2 remediation. Spawns the REAL sgen-qa-serve.js and drives /api/run over HTTP -- the actual
  // production path -- to prove the app REACHES the producer. producer.test.js proved the producer
  // works; it called runAudit directly, so it could not have caught the app never passing collectionRoot.
  'collection-store/production-wiring.test.js',
  'finding-store/finding-store.test.js',
  'timeline/timeline.test.js',
  'regression/regression.test.js',
  'best-practices/best-practices.test.js',
  'content-artifacts/content-artifacts.test.js',
  'spelling/spelling.test.js',
  'copy-review/copy-review.test.js',
  // The content tab must see content problems: lorem ipsum could never reach Content & SEO (FUNC-004
  // lives in a suite that run is skipped), and duplicate detection was titles/descriptions only.
  'copy-review/duplicate-placeholder.test.js',
  'ops/ops.test.js',
  'reporting/reporting.test.js',
  'inventory/inventory.test.js',
  // ADR-0004 acceptance evidence A1. The provider contract widened to enumerate(collection, ctx); this
  // is the gate proving the seven existing providers produce byte-identical output through it. A golden
  // hash captured from the code BEFORE the widening — a fixture cannot agree with a regression here.
  'inventory/contract-parity.test.js',
  // ADR-0005 evidence. Collector -> Collection -> Provider, including a REAL Chromium end-to-end
  // against a local server: a fake page cannot demonstrate ADR-0004 acceptance criterion 3, and an
  // end-to-end that silently skips is worse than one that fails.
  'inventory/network-ledger.test.js',
  // ADR-0006 evidence. Collector -> Collection -> Provider, plus a DIFFERENTIAL of the refactored
  // PERF-005 against a verbatim copy of its pre-refactor implementation across an 11-document corpus
  // (quirk cases included). That differential is the only thing that makes the refactor safe.
  'inventory/document-assets.test.js',
  // ADR-0007 evidence. Content-addressing, dedup, references, tamper-evidence — with dedup MEASURED on
  // the repository's own stored screenshots rather than a fixture, and a proof that a run with no
  // artifacts emits a byte-identical finding contract.
  'evidence-ledger/evidence-ledger.test.js',
  'inventory/qualification.js',
  // buildPageCoverage(): the Site Audit report must LIST which pages were audited, which errored
  // (fetched but non-200/non-html), and which the sitemap listed but the crawl never reached (capped).
  // Pure, no browser — guarded so an old result without pageCoverage yields empty arrays, not a throw.
  'page-coverage.test.js',
  'pipeline.test.js',
  // ADR-0011 P0. THE DIFFERENTIAL ORACLE: pins honest 79 / inflated 90 / corrected 80 from a REAL
  // audit. It reconstructs the undeclared computation on demand, so the suite fails the moment any
  // change reproduces the inflated score.
  'score-declaration.test.js',
  // ADR-0011 Phase 4. Spawns the REAL server and reads the report.json the APP wrote. The defect only
  // existed on the production path (collectPages:true), so no unit test could ever have caught it.
  'collection-store/score-integrity-e2e.test.js',
  // D5 — these four were written, passed, and were never registered OR committed (0 commits in the
  // entire history). They cover the runtime work restored in the release-provenance commit: stratified
  // crawl discovery, audit->annotation model data, cross-browser evidence, and the merged findings
  // table that REPORT_VERSION 1.4.0 had been claiming since the 4.4.0 release.
  '../migration-qa/crawl-stratify.test.js',
  'annotate-audit.test.js',
  'cross-browser-evidence.test.js',
  'report-merged.test.js',
  // The SEO split. Asserts the SCORE CONTRACT over the real server, not the tab bar: Site Audit runs
  // nine suites and declares NO seo rule as evaluated (so seo risk leaves the denominator with the
  // suite and the split cannot buy points), the SEO tool runs the seo suite alone, and the two are
  // complementary — every scored suite covered exactly once across the product.
  'seo-split.test.js',
  // Did we see the site? A 403-only origin used to report quality 71 with the word "blocked" appearing
  // nowhere, and cross-browser scored the block page. This asserts the cause is NAMED and that a run
  // which read nothing publishes no number — ADR-0011's law applied to the whole run.
  'reachability.test.js',
  // The updater had NO committed coverage — it was verified once by a throwaway script, which is the
  // same as unverified: the next edit had nothing to fail against. The signal used to be in-app only,
  // so an update announced during a minimised scan reached nobody.
  'updater.test.js',
  // A bare "403" in the page list is evidence, not a finding — 403 and 404 land on different desks.
  'http-status.test.js',
  // "Analytics / tracking detected" knew the vendor and threw it away on every live run.
  'analytics-stack.test.js',
  // What is the deployed site BUILT on — a faithful copy is not proof of a production site.
  'tech-stack.test.js',
];

const env = Object.assign({}, process.env, {
  SCANSTORE_PERF_N: process.env.SCANSTORE_PERF_N || '300',
  FINDINGSTORE_PERF_N: process.env.FINDINGSTORE_PERF_N || '300',
});

function extractCount(out) {
  const m = out.match(/(\d+)\/(\d+)\s+assertions/) || out.match(/PASS · (\d+) rules/) || (/QUALIFIED/.test(out) ? ['qualified'] : null);
  return m ? m[0] : '';
}

console.log('SGEN Site Auditor — full test run\n');
let allOk = true;
const rows = [];
for (const rel of SUITES) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) { console.log('  ✗ MISSING ' + rel); allOk = false; rows.push({ rel, ok: false, note: 'missing' }); continue; }
  const t0 = process.hrtime.bigint();
  let ok = false, note = '';
  try {
    const out = cp.execSync('node ' + JSON.stringify(rel), { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
    ok = /✅ (PASS|QUALIFIED)|PASS ·/.test(out) && !/❌/.test(out);
    note = extractCount(out);
  } catch (e) {
    ok = false;
    note = extractCount(((e.stdout || '') + (e.stderr || '')).toString()) || 'exit ' + (e.status != null ? e.status : '?');
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  allOk = allOk && ok;
  rows.push({ rel, ok, note, ms });
  console.log('  ' + (ok ? '✓' : '✗') + ' ' + rel.padEnd(42) + ' ' + note.padEnd(18) + ' ' + ms.toFixed(0) + ' ms');
}

const passed = rows.filter(r => r.ok).length;
console.log('\n' + (allOk ? '✅ ALL SUITES PASS' : '❌ SUITE FAILURE') + ` — ${passed}/${rows.length} suites`);
process.exit(allOk ? 0 : 1);
