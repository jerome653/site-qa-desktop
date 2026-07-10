'use strict';
// pipeline.js — the integration layer. Wires the whole auditor together into ONE flow:
//
//   live scan (runAudit)
//     → merge advisory passes: FUNC-008 content-artifacts (into Functional) + Best Practices (Suite 11)
//     → re-score deterministically (registry-driven)
//     → persist to the immutable Scan Store (WP-003)
//     → drive the Finding lifecycle (WP-004)
//     → build the Timeline (WP-005)
//     → run the Regression gate vs the baseline (WP-006)
//
// Freeze-safe (ADR-0001 §4): it CONSUMES the frozen engine's result + the public store APIs. It changes
// no rule, schema, event, or scoring math — merging FUNC-008 uses the same registry-driven compute().
// runAudit is injectable (opts.auditFn) so the flow is testable offline without a live crawl.
const { runAudit } = require('./audit');
const { compute } = require('./score');
const { runBestPractices } = require('./best-practices');
const { scanContentArtifacts } = require('./content-artifacts');
const { scanSpelling } = require('./spelling');
const { foldVisual } = require('./visual-match/fold');
const visualMatch = require('./visual-match');
const scanStore = require('./scan-store');
const findingStore = require('./finding-store');
const timeline = require('./timeline');
const regression = require('./regression');
const path = require('path');

// Re-derive tally + score + verdict + quality after the advisory passes change the suites.
// Uses the SAME formulas as audit.js (pass/graded ratio + registry-driven compute()).
function rescore(suites) {
  for (const s of suites) {
    const c = { pass: 0, warn: 0, fail: 0, manual: 0 };
    for (const r of s.checks) c[r.status] = (c[r.status] || 0) + 1;
    s.pass = c.pass; s.warn = c.warn; s.fail = c.fail; s.manual = c.manual;
  }
  const tally = suites.reduce((a, s) => { a.pass += s.pass; a.warn += s.warn; a.fail += s.fail; a.manual += s.manual; return a; }, { pass: 0, warn: 0, fail: 0, manual: 0 });
  const graded = tally.pass + tally.warn + tally.fail;
  const score = graded ? Math.round(tally.pass / graded * 100) : 0;
  const verdict = tally.fail > 0 ? 'NEEDS ATTENTION' : (tally.warn > 0 ? 'PASSED WITH WARNINGS' : 'ALL PASSING');
  const ready = tally.fail === 0;
  const quality = compute(suites);
  return { tally, graded, score, verdict, ready, quality };
}

// Merge the advisory passes into a raw runAudit result. Returns a NEW result (does not mutate input).
// Re-scores only when the suites actually change (FUNC-008 / Best Practices added, or a visual suite
// already folded in) — otherwise it's a pure pass-through so the base case stays byte-for-byte.
function applyAdvisory(result, opts = {}) {
  const pages = result.pages || [];
  const suites = result.suites.map(s => ({ ...s, checks: s.checks.slice() }));
  let changed = suites.some(s => s.key === 'visual'); // a folded visual suite already counts as a change

  if (pages.length && opts.advisory !== false) {
    // FUNC-008 → Functional suite (scored). One row aggregating all content artifacts across pages.
    const func = suites.find(s => s.key === 'functional');
    const pushRow = r => { if (func) func.checks.push({ status: r.status, name: r.name, target: r.target, detail: r.detail, meta: r.ruleId, items: r.items.length ? r.items : undefined, ruleId: r.ruleId, severity: r.severity, suite: 'functional', deduction: r.deduction }); };
    pushRow(scanContentArtifacts(pages)); // FUNC-008 loose symbols / tokens / mojibake
    pushRow(scanSpelling(pages));          // FUNC-009 common misspellings / doubled words
    // Best Practices → advisory suite (weight 0, never moves the score).
    if (!suites.some(s => s.key === 'best-practices')) {
      const bp = runBestPractices(pages);
      suites.push({ key: 'best-practices', name: 'Best Practices', desc: 'Advisory · modern web hygiene', icon: 'cursor', advisory: true, checks: bp.checks });
    }
    changed = true;
  }

  if (!changed) { const m = { ...result, suites }; delete m.pages; return m; }
  const scored = rescore(suites);
  const merged = { ...result, suites, ...scored };
  delete merged.pages; // don't persist raw HTML into the immutable record
  return merged;
}

// The full flow. Returns everything wired together.
async function runFullAudit(url, opts = {}) {
  const dataRoot = opts.dataRoot || path.resolve(process.cwd(), '.auditor-data');
  const auditFn = opts.auditFn || runAudit;
  const environment = opts.environment || 'production';
  const project = opts.project || 'default';

  // 1) live scan (advisory passes need page HTML)
  const raw = await auditFn(url, { ...opts, collectPages: true });
  // 1b) optional visual match: reference (old/live) vs candidate (this target/staging)
  let visualSummary = null;
  if (opts.compareUrl) {
    const visualFn = opts.visualFn || visualMatch.run;
    const visual = await visualFn(opts.compareUrl, url, { maxPages: opts.maxPages, urlMap: opts.urlMap, outDir: opts.visualOutDir, log: opts.log });
    const suite = foldVisual(visual, opts);
    visualSummary = suite.summary;
    (raw.suites = raw.suites || []).push(suite); // fold into the suites before advisory re-score
  }
  // 2) merge advisory passes + re-score
  const result = applyAdvisory(raw, opts);

  // 3) persist to the immutable stores
  const scans = new scanStore.ScanStore(path.join(dataRoot, 'scans'));
  const findings = new findingStore.FindingStore(path.join(dataRoot, 'findings'));
  const prev = scanStore.latestForTarget(scans, result.target); // BEFORE saving (for lineage + finding diff)
  const saved = scanStore.persist(scans, result, { environment, project });
  const scanRecord = scans.get(saved.scanId);
  // 4) finding lifecycle
  const ingest = findings.ingestScan(scanRecord, { prevScanRecord: prev || null });
  // 5) timeline
  const tl = timeline.buildTimeline(scans, result.target, { findingStore: findings });
  // 6) regression gate vs baseline (if one is set)
  let gate = null;
  const baselines = new regression.BaselineStore(dataRoot);
  const base = baselines.current(result.target);
  if (base && base.scanId !== saved.scanId && scans.has(base.scanId)) {
    gate = regression.buildRegression(scans, findings, { baselineScanId: base.scanId, candidateScanId: saved.scanId, generatedAt: result.generated });
  }

  return {
    result,
    scanId: saved.scanId,
    fingerprint: saved.fingerprint,
    quality: result.quality,
    verdict: result.verdict,
    findingEvents: ingest.events.length,
    visual: visualSummary,
    timeline: tl,
    regression: gate,
    stores: { scans, findings, baselines },
    setBaseline: () => baselines.set(scanRecord, { setAt: result.generated, reason: 'pipeline' }),
  };
}

module.exports = { runFullAudit, applyAdvisory, rescore };
