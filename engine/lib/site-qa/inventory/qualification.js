'use strict';
// qualification.js — GA qualification harness (Phase 3 stress + Phase 9 resilience). Runnable, real
// execution, measured. Exit 0 = qualified, 1 = a genuine failure.
//   node inventory/qualification.js
const { certifyMigration } = require('./certify-pipeline');
const { IdRegistry } = require('./id-registry');

let fail = 0; const note = [];
function ok(c, n) { if (!c) { fail++; note.push('✗ ' + n); console.log('  ✗ ' + n); } else console.log('  ✓ ' + n); }
const page = (url, body) => ({ url, status: 200, contentType: 'text/html', headers: {}, body });

console.log('GA QUALIFICATION — stress + resilience\n');

// ── Phase 9 · RESILIENCE — malformed / hostile inputs must not crash; report stays valid ──
console.log('Phase 9 · resilience');
(function resilience() {
  const cases = [
    ['empty body', [page('https://x/', '')]],
    ['no html', [page('https://x/', 'just text no tags')]],
    ['truncated html', [page('https://x/', '<html><head><title>x</title><body><div class="cookie')]],
    ['malformed DOM', [page('https://x/', '<div><span><p>unclosed <img src=<form><<>')]],
    ['huge page', [page('https://x/', '<html><body>' + '<div class="x">z</div>'.repeat(50000) + '</body></html>')]],
    ['non-200 pages', [{ url: 'https://x/a', status: 404, contentType: 'text/html', headers: {}, body: 'Not found' }, { url: 'https://x/b', status: 500, headers: {}, body: '' }]],
    ['empty crawl', []],
  ];
  for (const [name, pages] of cases) {
    let r, threw = false;
    try { r = certifyMigration(pages, pages, { idRegistry: new IdRegistry(), source: 's', target: 't', at: '' }); } catch (e) { threw = true; note.push('resilience threw on ' + name + ': ' + e.message); }
    ok(!threw, 'resilience: no crash on "' + name + '"');
    if (r) {
      ok(['PASS', 'PASS WITH MINOR ISSUES', 'FAIL'].includes(r.cert.verdict), 'resilience: valid verdict on "' + name + '"');
      ok(r.report && r.report.json && r.report.html && !/undefined/.test(r.report.html), 'resilience: valid report on "' + name + '"');
    }
  }
  // audit-stage with a malformed audit result must not crash
  let threw = false; try { certifyMigration([page('https://x/', '<html><body><h1>h</h1></body></html>')], [page('https://x/', '<html><body><h1>h</h1></body></html>')], { idRegistry: new IdRegistry(), auditResult: { suites: [{ key: 'seo', checks: [{ status: 'fail', ruleId: null, target: null }] }] }, source: 's', target: 't', at: '' }); } catch (e) { threw = true; note.push('audit-stage crash: ' + e.message); }
  ok(!threw, 'resilience: malformed audit result (null ruleId/target) handled');
})();

// ── Phase 3 · STRESS — hundreds of pages, thousands of assets; integrity + stable IDs + performance ──
console.log('\nPhase 3 · stress');
(function stress() {
  const N = Number(process.env.QUAL_N || 400);
  const src = []; const tgt = [];
  for (let i = 0; i < N; i++) {
    const imgs = Array.from({ length: 12 }, (_, k) => `<img src="/img/p${i}-${k}.jpg" alt="a">`).join('');
    const body = `<!doctype html><html lang=en><head><title>Page ${i}</title><link rel="icon" href="/favicon.ico"></head><body class="header--fixed"><header><nav>n</nav></header><h1>Page ${i}</h1><h2>Sub ${i}</h2>${imgs}<div class="cookie-consent">c</div><form action="/c${i}"><input name="e" required></form><footer>f</footer></body></html>`;
    src.push(page(`https://old.example.com/p${i}`, body));
    if (i % 20 !== 0) tgt.push(page(`https://new.example.com/p${i}`, body)); // target drops 5% of pages
  }
  const t0 = process.hrtime.bigint(); const m0 = process.memoryUsage().heapUsed;
  const r = certifyMigration(src, tgt, { idRegistry: new IdRegistry(), source: 'old', target: 'new', at: '2026-07-08T00:00:00Z' });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6; const mb = (process.memoryUsage().heapUsed - m0) / 1048576;

  const allItems = Object.values(r.refInv.items).flat();
  ok(r.refInv.counts.page === N, `stress: ${N} pages inventoried`);
  ok(r.refInv.counts.asset > N * 5, `stress: ${r.refInv.counts.asset} assets inventoried (thousands)`);
  ok(allItems.every(i => /^[A-Z]+-\d{3,}$/.test(i.id)), 'stress: all inventory IDs well-formed (stable-ID integrity)');
  ok(new Set(allItems.map(i => i.id)).size === allItems.length, 'stress: no duplicate inventory IDs');
  ok(allItems.every(i => i.state && i.history.length), 'stress: no orphan inventory — every item has state + lifecycle');
  ok(r.cert.tally.failed > 0, 'stress: dropped pages detected (completeness FAIL)');
  ok(r.report.json && r.report.json.findings.every(f => f.id), 'stress: large report generated, findings intact');
  const total = r.refInv.total + r.diff.added.length;
  console.log(`  · scale: ${total} inventory items · ${ms.toFixed(0)} ms · ${mb.toFixed(1)} MB heap · verdict ${r.cert.verdict}`);
  ok(ms < 20000, 'stress: completes in < 20s');
})();

console.log('\n' + (fail === 0 ? '✅ QUALIFIED — stress + resilience pass' : '❌ ' + fail + ' failure(s)'));
if (fail) { console.log(note.join('\n')); process.exit(1); }
