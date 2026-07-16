'use strict';
// pipeline.test.js — end-to-end test of the integration layer, offline. Injects a synthetic runAudit
// result (with page HTML) via opts.auditFn, then verifies the WHOLE wired flow: advisory merge
// (FUNC-008 + Best Practices) → re-score → persist → finding lifecycle → timeline → regression gate.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { runFullAudit, applyAdvisory } = require('./pipeline');
const { getById } = require('./rules/registry');

let pass = 0, fail = 0; const failures = [];
function ok(c, n) { if (c) pass++; else { fail++; failures.push(n); console.log('  ✗ ' + n); } }
function eq(a, b, n) { ok(JSON.stringify(a) === JSON.stringify(b), n + (JSON.stringify(a) === JSON.stringify(b) ? '' : ` (got ${JSON.stringify(a)})`)); }

const T = 'https://demo-site.example.com';
function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'pipe-')); }

// A minimal runAudit-shaped result. `pages` carries HTML for the advisory passes.
function fakeResult({ ts, pages, funcFail = false }) {
  const funcChecks = [{ status: 'pass', name: 'All pages return a successful status', ruleId: null }];
  if (funcFail) funcChecks.push({ status: 'fail', name: 'Placeholder / lorem text in visible copy', ruleId: 'FUNC-004', target: T + '/x', items: [] });
  return {
    target: T, host: 'demo-site.example.com', generated: ts,
    versions: { engine: '2.1.0', report: '1.1.0', registry: '1.2.1' },
    verdict: 'ALL PASSING', ready: true, score: 100,
    quality: { overall: 100, categories: [] }, tally: { pass: 1, warn: 0, fail: 0, manual: 0 },
    crawl: { pages: pages.length }, render: { rendered: pages.length, total: pages.length },
    suites: [
      { key: 'functional', name: 'Functional', desc: '', icon: 'cursor', checks: funcChecks },
      { key: 'seo', name: 'SEO', desc: '', icon: 'search', checks: [{ status: 'pass', name: 'Every page has a title', ruleId: null }] },
    ],
    shots: {}, pages,
  };
}
// injectable auditFn
const auditFnFor = res => async () => res;

console.log('Pipeline integration — test suite\n');

// ── advisory merge (pure) ──
(function merge() {
  const dirty = fakeResult({ ts: '2026-07-01T00:00:00.000Z', pages: [
    { url: T + '/', html: '<h1>Hi {{customer.name}}</h1><p>Welcome</p>' },              // FUNC-008 token leak
    { url: T + '/about', html: '<html><body><a target="_blank" href="/x">go</a></body></html>' }, // BP-004
  ] });
  const merged = applyAdvisory(dirty);
  const func = merged.suites.find(s => s.key === 'functional');
  const f8 = func.checks.find(c => c.ruleId === 'FUNC-008');
  ok(!!f8, 'merge: FUNC-008 row added to Functional suite');
  eq(f8.status, 'fail', 'merge: FUNC-008 high → fail');
  ok(f8.items.some(i => i.id === 'unresolved-token'), 'merge: FUNC-008 caught the {{token}} leak');
  const bp = merged.suites.find(s => s.key === 'best-practices');
  ok(bp && bp.advisory, 'merge: Best Practices advisory suite appended');
  ok(bp.checks.some(c => c.ruleId === 'BP-004' && c.status !== 'pass'), 'merge: BP-004 target_blank flagged');
  ok(!merged.pages, 'merge: raw page HTML stripped from the merged result (not persisted)');
  // re-score: functional now has a fail → tally.fail ≥ 1, verdict changed
  ok(merged.tally.fail >= 1, 'merge: re-score picked up the new fail');
  eq(merged.verdict, 'NEEDS ATTENTION', 'merge: verdict recomputed');
  // deterministic
  eq(applyAdvisory(dirty), merged, 'merge: deterministic');
  // best-practices weight 0 → overall score unaffected by BP findings (only FUNC-008 counts)
  ok(getById('BP-004') && getById('BP-004').deduction > 0, 'merge: BP rule scored within its own suite');
})();

// ── full flow: two scans → persist, lineage, timeline, regression ──
(async function flow() {
  const dataRoot = tmp();
  const clean = [{ url: T + '/', html: '<!doctype html><html lang=en><head><meta charset=utf-8><title>Home</title></head><body><h1>Welcome</h1></body></html>' }];
  const dirty = [{ url: T + '/', html: '<h1>Hi {{name}}</h1>' }]; // FUNC-008 leak

  // scan 1 — clean
  const r1 = await runFullAudit(T, { dataRoot, auditFn: auditFnFor(fakeResult({ ts: '2026-07-01T00:00:00.000Z', pages: clean })) });
  ok(/^[0-9a-f]{32}$/.test(r1.scanId), 'flow: scan 1 persisted (content-addressed id)');
  ok(r1.findingEvents >= 0, 'flow: scan 1 finding lifecycle ran');
  eq(r1.timeline.scanCount, 1, 'flow: timeline has 1 point');
  eq(r1.regression, null, 'flow: no gate yet (no baseline)');
  // pin scan 1 as the baseline
  r1.setBaseline();

  // scan 2 — a {{token}} leak appears
  const r2 = await runFullAudit(T, { dataRoot, auditFn: auditFnFor(fakeResult({ ts: '2026-07-02T00:00:00.000Z', pages: dirty })) });
  ok(r2.scanId !== r1.scanId, 'flow: scan 2 is a distinct record');
  eq(r2.timeline.scanCount, 2, 'flow: timeline now has 2 points');
  ok(r2.result.suites.find(s => s.key === 'functional').checks.some(c => c.ruleId === 'FUNC-008' && c.status === 'fail'), 'flow: scan 2 FUNC-008 fired on the leak');
  ok(r2.regression, 'flow: regression gate ran vs baseline');
  eq(r2.regression.verdict, 'FAIL', 'flow: gate FAILs — a new high finding (FUNC-008) regressed the site');
  ok(r2.regression.diff.counts.created >= 1, 'flow: gate saw a newly created finding');

  // scan 3 — leak fixed again → improvement
  const r3 = await runFullAudit(T, { dataRoot, auditFn: auditFnFor(fakeResult({ ts: '2026-07-03T00:00:00.000Z', pages: clean })) });
  eq(r3.timeline.scanCount, 3, 'flow: timeline 3 points');
  eq(r3.regression.verdict, 'PASS', 'flow: gate PASSes again after the fix (vs baseline)');

  // stores are real + intact (verify is a module function)
  ok(require('./scan-store').verify(r3.stores.scans).ok, 'flow: scan store verifies');
  ok(require('./finding-store').verify(r3.stores.findings).ok, 'flow: finding store verifies');
  eq(r3.stores.scans.count(), 3, 'flow: 3 scans stored');

  // ── visual match folded into the pipeline ──
  const dr2 = tmp();
  // struct's missing/extra/moved/restyled are ARRAYS OF ELEMENTS — that is what visual-match's
  // structDelta() really returns. This fixture used to pass counts (`{moved:2,restyled:1}`), a shape
  // the engine has never emitted, and the fold read them straight into the evidence string. So the
  // suite was green while every real run wrote "[object Object]" into VIS-001. Fixtures that do not
  // match the producer do not test the consumer.
  const el = (tag, text) => ({ sec: 'main', tag, text, x: 0, y: 0, w: 100, h: 20, font: 'Inter', size: 16, color: 'rgb(0,0,0)' });
  const visualResult = {
    pairs: 3, unmatchedRef: [T + '/press'], viewports: ['1920 · desktop-xl', '480 · mobile'],
    pages: [
      { path: '/', cand: T + '/', viewports: [ { label: '1920 · desktop-xl', pixelMismatchPct: 1.2, matchScore: 98, struct: { missing: [], extra: [], moved: [], restyled: [] } }, { label: '480 · mobile', pixelMismatchPct: 14.5, matchScore: 71, struct: { missing: [], extra: [], moved: [{ el: el('h1', 'Hi'), from: [0, 0], to: [0, 90] }, { el: el('p', 'Yo'), from: [0, 10], to: [0, 100] }], restyled: [{ el: el('a', 'Buy'), diffs: ['color rgb(0,0,0)→rgb(9,9,9)'] }] } } ] },
      { path: '/about', cand: T + '/about', viewports: [ { label: '1920 · desktop-xl', pixelMismatchPct: 0.4, matchScore: 99, struct: {} } ] },
    ], sharp: true,
  };
  const visualFn = async () => visualResult;
  const rv = await runFullAudit(T, { dataRoot: dr2, auditFn: auditFnFor(fakeResult({ ts: '2026-07-01T00:00:00.000Z', pages: clean })), compareUrl: T.replace('demo-site', 'old-site'), visualFn });
  const vsuite = rv.result.suites.find(s => s.key === 'visual');
  ok(vsuite && vsuite.advisory, 'visual: advisory Visual Match suite folded in');
  const vis1 = vsuite.checks.find(c => c.ruleId === 'VIS-001');
  ok(vis1 && vis1.status !== 'pass', 'visual: VIS-001 fires (mobile home over threshold)');
  ok(vis1.items.some(i => i.section === '480 · mobile'), 'visual: mismatch attributed to the 480 breakpoint');
  // The evidence string is what a human reads on the report. Assert it is HUMAN-READABLE, not merely
  // present — the [object Object] defect passed every "does VIS-001 fire" check ever written.
  const mob = vis1.items.find(i => i.section === '480 · mobile');
  ok(!/\[object Object\]/.test(mob.value), 'visual: VIS-001 evidence contains no [object Object]');
  ok(/2 moved/.test(mob.value) && /1 restyled/.test(mob.value), 'visual: VIS-001 evidence counts the structural deltas (2 moved, 1 restyled)');
  ok(!/(^|\s)(missing|extra)\b/.test(mob.value.replace(/\d+ (missing|extra)/g, '')), 'visual: VIS-001 evidence omits empty delta categories (an empty array is truthy — the other half of the bug)');
  const { structDeltaLabels } = require('./visual-match/fold');
  eq(structDeltaLabels({ missing: [], extra: [{}, {}], moved: 3, restyled: undefined }), ['2 extra', '3 moved'],
    'visual: structDeltaLabels counts arrays (engine) and numbers (stored/legacy results), drops empties');
  const vis2 = vsuite.checks.find(c => c.ruleId === 'VIS-002');
  ok(vis2 && vis2.items && vis2.items.length === 1, 'visual: VIS-002 flags the unmatched /press page');
  eq(rv.visual.mismatches, 1, 'visual: summary counts 1 mismatch');
  eq(rv.visual.unmatched, 1, 'visual: summary counts 1 unmatched');
  // score-neutral: visual suite is weight 0 → overall unaffected
  ok(rv.result.quality.categories.find(c => c.key === 'visual').weight === 0, 'visual: suite weight 0 (no overall impact)');
  // persisted + gate still runs
  ok(require('./scan-store').verify(rv.stores.scans).ok, 'visual: scan with visual findings persists + verifies');

  // ── comparison mode: the pixel pass is only meaningful on a like-for-like replatform ──
  // The result above carries no `mode` (exactly like every result written before 1.12.0) and VIS-001
  // fired off its 14.5% pixel diff — so the default path is provably unchanged. A REDESIGN is a
  // different question: the sites are meant to differ, so a pixel mismatch is not a finding.
  const { foldVisual } = require('./visual-match/fold');
  eq(foldVisual(visualResult).summary.mode, 'like-for-like', 'mode: a result with no mode folds as like-for-like (pre-1.12.0 results unchanged)');
  ok(foldVisual(visualResult).checks.find(c => c.ruleId === 'VIS-001').status !== 'pass', 'mode: like-for-like → the 14.5% pixel diff still fires VIS-001');

  // Same numbers, mode=redesign. The engine returns pct:null in redesign mode, but fold gates
  // independently — so even a result that somehow carries a pct cannot produce a pixel failure.
  const redesigned = { ...visualResult, mode: 'redesign' };
  const rdFold = foldVisual(redesigned);
  eq(rdFold.summary.mode, 'redesign', 'mode: redesign is recorded in the fold summary');
  eq(rdFold.summary.pixelPass, false, 'mode: redesign reports the pixel pass as off');
  const rdVis1 = rdFold.checks.find(c => c.ruleId === 'VIS-001');
  ok(!rdVis1.items || !rdVis1.items.some(i => /% px/.test(i.value || '')), 'mode: redesign → no finding is raised on the pixel axis');

  // The structural axis SURVIVES the mode gate. "The old site had a phone number and the new one
  // doesn't" is a real finding on a redesign too — only the PIXEL axis is meaningless there.
  const structOnly = foldVisual({ ...visualResult, mode: 'redesign',
    pages: [{ path: '/', viewports: [{ label: '480 · mobile', pixelMismatchPct: null, matchScore: 60, struct: { missing: 4 } }] }] });
  ok(structOnly.checks.find(c => c.ruleId === 'VIS-001').status !== 'pass', 'mode: redesign still reports a STRUCTURAL mismatch (only the pixel axis is gated)');

  // engine-side normalizer: unknown/absent mode must fail toward today's behaviour, never into silence
  const vmm = require('./visual-match');
  eq(vmm.normalizeMode(undefined), 'like-for-like', 'mode: absent → like-for-like (existing users keep the pixel pass)');
  eq(vmm.normalizeMode('REDESIGN'), 'like-for-like', 'mode: unrecognised value → like-for-like, never silently quieter');
  eq(vmm.normalizeMode('redesign'), 'redesign', 'mode: redesign is honoured');

  console.log('\n' + (fail === 0 ? '✅ PASS' : '❌ FAIL') + ` — ${pass}/${pass + fail} assertions`);
  if (fail) { console.log('Failures:\n' + failures.map(f => '  - ' + f).join('\n')); process.exit(1); }
})();
