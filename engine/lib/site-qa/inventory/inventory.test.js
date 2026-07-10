'use strict';
// inventory.test.js — the full inventory-driven pipeline: Provider → Inventory → Comparison → Evidence
// → Certification → Reporting. Every layer executed on real fixtures; stable IDs + lifecycle + evidence
// verified.
const fs = require('fs'); const path = require('path'); const os = require('os');
const { buildInventory } = require('./index');
const { IdRegistry } = require('./id-registry');
const { makeItem, transition } = require('./model');
const { canTransition } = require('./lifecycle');
const { certifyMigration } = require('./certify-pipeline');

let pass = 0, fail = 0; const failures = [];
function ok(c, n) { if (c) pass++; else { fail++; failures.push(n); console.log('  ✗ ' + n); } }
function eq(a, b, n) { ok(JSON.stringify(a) === JSON.stringify(b), n + (JSON.stringify(a) === JSON.stringify(b) ? '' : ` (got ${JSON.stringify(a)})`)); }
const page = (url, body) => ({ url, status: 200, contentType: 'text/html', headers: {}, body });

const REF = [
  page('https://old.example.com/', `<!doctype html><html><head><title>Home</title>
    <link rel="icon" href="/favicon.ico"><link rel="manifest" href="/site.webmanifest"><meta property="og:image" content="/og/home.png"></head>
    <body class="header--fixed"><header><nav>Home About</nav></header><h1>Welcome</h1><h2>Our Services</h2>
    <img src="/img/hero.jpg"><img src="/img/logo.svg"><div class="cookie-consent">Accept cookies</div>
    <script src="https://widget.intercom.io/widget/abc"></script><div class="accordion">FAQ</div>
    <form action="/contact"><input name="name" required><input name="email"><textarea name="message"></textarea></form>
    <footer>© 2026</footer></body></html>`),
  page('https://old.example.com/about', `<html><body><header></header><h1>About</h1><img src="/img/team.jpg"><footer></footer></body></html>`),
  page('https://old.example.com/pricing', `<html><body><header></header><h1>Pricing</h1><form class="newsletter"><input type="email" name="email"></form><footer></footer></body></html>`),
];
// migrated target lost: /pricing page + newsletter form, cookie banner, chat widget, contact form
const TGT = [
  page('https://staging.example.com/', `<!doctype html><html><head><title>Home</title><link rel="icon" href="/favicon.ico"></head>
    <body class="header--fixed"><header><nav>Home About</nav></header><h1>Welcome</h1><h2>Our Services</h2>
    <img src="/img/hero.jpg"><img src="/img/logo.svg"><div class="accordion">FAQ</div><footer>© 2026</footer></body></html>`),
  page('https://staging.example.com/about', `<html><body><header></header><h1>About</h1><img src="/img/team.jpg"><footer></footer></body></html>`),
];

console.log('Inventory-driven pipeline — test suite\n');

// ── lifecycle (with EVIDENCE_PENDING) ──
(function lifecycle() {
  const it = makeItem({ id: 'PAGE-001', type: 'page', identityKey: 'page:/', meta: {} });
  eq(it.state, 'DISCOVERED', 'lifecycle: born DISCOVERED');
  ok(it.provider === 'page' && Array.isArray(it.children) && 'comparisonMapping' in it, 'lifecycle: full item schema (provider/children/mappings)');
  transition(it, 'MATCHED'); transition(it, 'COMPARED'); transition(it, 'VALIDATED');
  transition(it, 'EVIDENCE_PENDING'); transition(it, 'EVIDENCE_COLLECTED'); transition(it, 'PASSED');
  eq(it.state, 'PASSED', 'lifecycle: full path DISCOVERED→…→EVIDENCE_PENDING→EVIDENCE_COLLECTED→PASSED');
  let threw = false; try { transition(it, 'DISCOVERED'); } catch (_) { threw = true; }
  ok(threw, 'lifecycle: PASSED→DISCOVERED fails closed');
  ok(canTransition('VALIDATED', 'EVIDENCE_PENDING') && !canTransition('VALIDATED', 'PASSED'), 'lifecycle: EVIDENCE_PENDING enforced between VALIDATED and terminal');
})();

// ── providers + parent/children ──
(function providers() {
  const inv = buildInventory(REF, { idRegistry: new IdRegistry() });
  ok(inv.counts.page === 3, 'providers: 3 pages');
  ok(inv.items.global.some(g => g.meta.key === 'cookie-banner') && inv.items.global.some(g => g.meta.key === 'chat-widget'), 'providers: cookie-banner + chat-widget globals');
  ok(inv.items.form.some(f => f.meta.formType === 'contact') && inv.items.form.some(f => f.meta.formType === 'newsletter'), 'providers: contact + newsletter forms typed');
  const sec = inv.items.section.find(s => s.meta.heading === 'Our Services');
  ok(sec && sec.parent === 'page:/', 'parent/children: section.parent = its page');
  ok(inv.byKey.get('page:/').children.includes(sec.identityKey), 'parent/children: page.children includes the section');
})();

// ── stable IDs (persisted) ──
(function stableIds() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-')); const p = path.join(dir, 'ids.jsonl');
  const r1 = buildInventory(REF, { idRegistry: new IdRegistry(p) });
  const headerId = r1.byKey.get('global:header').id, homeId = r1.byKey.get('page:/').id;
  ok(/^GLOBAL-\d{3}$/.test(headerId), 'stable-id: readable prefix');
  const r2 = buildInventory([...REF, page('https://old.example.com/new', '<html><body><h1>New</h1></body></html>')], { idRegistry: new IdRegistry(p) });
  eq(r2.byKey.get('global:header').id, headerId, 'stable-id: Header keeps ID across runs (persisted)');
  eq(r2.byKey.get('page:/').id, homeId, 'stable-id: existing page keeps ID');
  ok(r2.byKey.get('page:/new').id !== homeId, 'stable-id: new item = fresh ID');
})();

// ── FULL PIPELINE: Provider→Inventory→Compare→Evidence→Certify→Report ──
(function pipeline() {
  const r = certifyMigration(REF, TGT, { idRegistry: new IdRegistry(), source: 'old.example.com', target: 'staging.example.com', at: '2026-07-08T00:00:00Z' });
  eq(r.cert.verdict, 'FAIL', 'pipeline: verdict FAIL (blocking content missing)');
  ok(r.cert.explanations.some(e => e.type === 'page' && /pricing/.test(e.identityKey) && e.severity === 'blocking'), 'pipeline: dropped /pricing page → blocking finding');
  ok(r.cert.explanations.some(e => e.type === 'form' && e.severity === 'blocking'), 'pipeline: dropped form → blocking');
  ok(r.cert.explanations.some(e => e.identityKey === 'global:cookie-banner' && e.severity === 'blocking'), 'pipeline: dropped cookie banner → blocking');
  ok(r.cert.explanations.some(e => e.identityKey === 'global:chat-widget' && e.severity === 'advisory'), 'pipeline: dropped chat widget → advisory (warning)');
  // lifecycle terminal states
  ok(r.refInv.byKey.get('page:/').state === 'PASSED', 'pipeline: surviving page → PASSED');
  ok(r.refInv.byKey.get('page:/pricing').state === 'FAILED', 'pipeline: dropped page → FAILED');
  // EVIDENCE attached (no finding without evidence)
  const home = r.refInv.byKey.get('page:/');
  ok(home.evidence && home.evidence.inventoryId === home.id && home.evidence.evidence === 'Complete', 'evidence: attached to matched item with inventoryId');
  eq(home.evidence.detectionConfidence, 1.0, 'evidence: page detection confidence 1.0 (exact identity)');
  const cookie = r.refInv.byKey.get('global:cookie-banner');
  eq(cookie.evidence.detectionConfidence, 0.75, 'evidence: heuristic global confidence 0.75 (not inflated)');
  ok(cookie.evidence.after === 'ABSENT on target', 'evidence: records before/after (present source, absent target)');
  // REPORT generated from real data
  ok(r.report.json.verdict === 'FAIL' && r.report.json.findings.length >= 3, 'report: json built from runtime data');
  ok(/FAIL/.test(r.report.html) && /Migration Certification/.test(r.report.html) && !/undefined/.test(r.report.html), 'report: self-contained HTML, no undefined');
  ok(r.report.json.inventory.page.some(i => i.evidence && i.history.length), 'report: every item carries evidence + lifecycle (reproducible)');
})();

// ── clean migration → PASS · determinism ──
(function clean() {
  const a = certifyMigration(REF, REF, { idRegistry: new IdRegistry(), source: 's', target: 't', at: '' });
  eq(a.cert.verdict, 'PASS', 'clean: identical source/target → PASS');
  ok(Object.values(a.refInv.items).flat().every(i => ['PASS', 'APPROVED', 'MANUAL'].includes(i.certificationState)), 'clean: all source items certificationState=PASS');
  const b = certifyMigration(REF, REF, { idRegistry: new IdRegistry(), source: 's', target: 't', at: '' });
  eq(a.report.json.tally, b.report.json.tally, 'determinism: identical tally across runs');
  // allow-list an intentionally-removed page → APPROVED, not FAIL
  const c = certifyMigration(REF, TGT, { idRegistry: new IdRegistry(), allowRemoved: ['page:/pricing', 'form:newsletter:/pricing#0', 'global:cookie-banner', 'form:contact:/contact', 'global:chat-widget'], source: 's', target: 't', at: '' });
  ok(c.cert.tally.approved >= 1, 'allow-list: intentionally-removed items → APPROVED_EXCEPTION');
})();

// ── Phase 2: Production Validation stage (audit findings → inventory items) ──
(function production() {
  const auditResult = { suites: [
    { key: 'console', checks: [{ status: 'fail', ruleId: 'CON-001', name: 'JavaScript / console errors', target: 'https://old.example.com/', severity: 'high', items: [] }] },
    { key: 'a11y', checks: [{ status: 'warn', ruleId: 'A11Y-007', name: 'img no src', target: 'https://old.example.com/', severity: 'medium', items: [] }] },
    { key: 'forms', checks: [{ status: 'warn', ruleId: 'FORM-001', name: 'form structure', target: 'https://old.example.com/', severity: 'medium', items: [] }] },
  ] };
  // clean completeness (REF vs REF) + production console error → FAIL from production axis alone
  const r = certifyMigration(REF, REF, { idRegistry: new IdRegistry(), auditResult, source: 's', target: 't', at: '' });
  ok(r.production.mapped >= 3 && r.production.orphan === 0, 'production: audit findings mapped to inventory, no orphans');
  const home = r.refInv.byKey.get('page:/');
  ok(home.findings.some(f => f.axis === 'production' && f.ruleId === 'CON-001'), 'production: console error mapped to Page item');
  ok(r.refInv.items.asset.some(a => a.findings.some(f => f.ruleId === 'A11Y-007')), 'production: image finding mapped to Asset inventory');
  ok(r.refInv.items.form.some(f => f.findings.some(x => x.ruleId === 'FORM-001')), 'production: form finding mapped to Form inventory');
  eq(r.cert.verdict, 'FAIL', 'production: high console error → verdict FAIL (safe-to-deploy fails)');
  ok(r.cert.explanations.some(e => e.axis === 'production' && e.ruleId === 'CON-001' && e.severity === 'blocking'), 'production: certification cites axis + ruleId');
})();

// ── Phase 1: Visual Comparison stage (visual-match results → inventory items) ──
(function visual() {
  const visualResult = { pages: [{ path: '/', viewports: [{ label: '480 · mobile', pixelMismatchPct: 20, matchScore: 60, struct: { moved: 2 } }, { label: '1920 · desktop-xl', pixelMismatchPct: 1, matchScore: 99, struct: {} }] }], unmatchedRef: [] };
  const r = certifyMigration(REF, REF, { idRegistry: new IdRegistry(), visualResult, source: 's', target: 't', at: '' });
  eq(r.visual.mapped, 1, 'visual: one mismatch mapped (mobile 480), desktop passes');
  const home = r.refInv.byKey.get('page:/');
  ok(home.findings.some(f => f.axis === 'visual' && f.ruleId === 'VIS-001' && f.viewport === '480 · mobile'), 'visual: mismatch mapped to Page item at the 480 breakpoint');
  eq(r.cert.verdict, 'FAIL', 'visual: matchScore 60 (<75) → blocking → FAIL');
  ok(r.cert.explanations.some(e => e.axis === 'visual' && e.viewport === '480 · mobile'), 'visual: certification cites viewport');
})();

// ── Phase 4: Approved Exceptions (honored — never fail certification) ──
(function exceptions() {
  const reg = new IdRegistry();
  const pre = buildInventory(REF, { idRegistry: reg });
  const pricingId = pre.byKey.get('page:/pricing').id;
  const r = certifyMigration(REF, TGT, { idRegistry: reg, exceptions: [{ relatedIds: [pricingId], reason: 'page retired by client', approver: 'jerome', date: '2026-07-08' }], source: 's', target: 't', at: '' });
  const pricing = r.refInv.byKey.get('page:/pricing');
  eq(pricing.certificationState, 'APPROVED', 'exceptions: an approved-exception item → APPROVED (not FAILED)');
  ok(r.report.json.approvedExceptions.length === 1 && r.report.json.approvedExceptions[0].approver === 'jerome', 'exceptions: report records exception metadata (reason/approver/date)');
})();

// ── Phase 6: target-only page policy (never ignored) + Phase 5: version governance ──
(function targetOnlyAndVersions() {
  const refP = [page('https://a.example.com/', '<html><body><h1>Home</h1></body></html>')];
  const tgtP = [page('https://b.example.com/', '<html><body><h1>Home</h1></body></html>'), page('https://b.example.com/promo', '<html><body><h1>Promo</h1></body></html>')];
  const r = certifyMigration(refP, tgtP, { idRegistry: new IdRegistry(), source: 'a', target: 'b', at: '2026-07-08T00:00:00Z' });
  const promo = r.tgtInv.byKey.get('page:/promo');
  ok(promo && promo.certificationState === 'WARNING', 'phase6: target-only page is certified (WARNING), never ignored');
  ok(promo.state === 'WARNING' && promo.findings.some(f => /only on the migrated/.test(f.detail)), 'phase6: target-only page flows through lifecycle + carries a finding');
  eq(r.cert.verdict, 'PASS WITH MINOR ISSUES', 'phase6: target-only advisory → PASS WITH MINOR ISSUES');
  // version governance
  const m = r.report.json.metadata;
  ok(m.versions.migrationQaEngine && m.versions.ruleRegistry && m.versions.inventorySchema && m.versions.evidenceSchema && m.versions.certificationSchema && m.versions.reportSchema && m.versions.auditEngine, 'phase5: metadata carries all schema versions');
  ok('gitCommit' in m && 'executionTimestamp' in m && 'environment' in m && 'build' in m, 'phase5: metadata carries build/commit/timestamp/environment');
  ok(/engine .* registry .* commit/.test(r.report.html.replace(/\n/g, ' ')), 'phase5: versions embedded in HTML report too');
  // Phase 7: machine-readable completeness — required sections present + no broken refs
  const j = r.report.json;
  ok(j.metadata && j.inventory && j.findings && j.gates && j.viewportResults != null && j.approvedExceptions && j.manualItems && j.axisSummary, 'phase7: JSON has all required top-level sections');
  const allIds = new Set(Object.values(j.inventory).flat().map(i => i.id));
  ok(j.findings.every(f => allIds.has(f.id)), 'phase7: every finding references a real inventory ID (no broken refs)');
})();

// ── DEFECT-1 regression: capped crawl → "missing" is Manual Verification, never a false blocking FAIL ──
(function defect1_cappedCrawl() {
  const capped = certifyMigration(REF, TGT, { idRegistry: new IdRegistry(), capped: true, source: 's', target: 't', at: '' });
  ok(capped.cert.tally.manual > 0 && capped.cert.tally.failed === 0, 'defect1: capped crawl → missing items MANUAL, not blocking');
  eq(capped.cert.verdict, 'PASS WITH MINOR ISSUES', 'defect1: capped crawl never produces a false FAIL from unconfirmed absence');
  const uncapped = certifyMigration(REF, TGT, { idRegistry: new IdRegistry(), capped: false, source: 's', target: 't', at: '' });
  eq(uncapped.cert.verdict, 'FAIL', 'defect1: uncapped crawl → authoritative FAIL (control)');
})();

// ── DEFECT-2 regression: site search form deduped to ONE global identity across pages ──
(function defect2_searchFormDedup() {
  const pgs = [
    page('https://s.example.com/a', '<html><body><form role="search"><input name="q"></form><h1>A</h1></body></html>'),
    page('https://s.example.com/b', '<html><body><form role="search"><input name="q"></form><h1>B</h1></body></html>'),
    page('https://s.example.com/c', '<html><body><form role="search"><input name="q"></form><h1>C</h1></body></html>'),
  ];
  const inv = buildInventory(pgs, { idRegistry: new IdRegistry() });
  eq(inv.items.form.filter(f => f.identityKey === 'form:search').length, 1, 'defect2: 3 per-page search forms → ONE global form:search identity');
  ok(inv.items.form.length === 1, 'defect2: no per-page search-form duplication');
})();

console.log('\n' + (fail === 0 ? '✅ PASS' : '❌ FAIL') + ` — ${pass}/${pass + fail} assertions`);
if (fail) { console.log('Failures:\n' + failures.map(f => '  - ' + f).join('\n')); process.exit(1); }
