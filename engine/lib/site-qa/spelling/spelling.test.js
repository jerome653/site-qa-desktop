'use strict';
// spelling.test.js — deterministic suite for FUNC-009. Verifies common misspellings + doubled words
// fire, correctly-spelled text stays silent (zero false positives), code is excluded, determinism,
// registry integration, and frozen parity.
const cp = require('child_process');
const REG = require('../rules/registry');
const { scanSpelling, detect } = require('./index');

let pass = 0, fail = 0; const failures = [];
function ok(c, n) { if (c) pass++; else { fail++; failures.push(n); console.log('  ✗ ' + n); } }
function eq(a, b, n) { ok(JSON.stringify(a) === JSON.stringify(b), n + (JSON.stringify(a) === JSON.stringify(b) ? '' : ` (got ${JSON.stringify(a)})`)); }

const U = 'https://demo-site.example.com/';
const ids = prose => detect({ url: U, prose }).map(i => i.value);
const fires = (prose, needle) => ids(prose).some(v => v.includes(needle));

console.log('FUNC-009 — spelling — test suite\n');

// registry
(function registry() {
  const r = REG.getById('FUNC-009');
  ok(!!r, 'registry: FUNC-009 exists');
  eq(r.suite, 'functional', 'registry: in functional suite');
  ok(!r.manual && r.deduction > 0, 'registry: scored (non-manual)');
  eq(REG.SUITES.reduce((a, s) => a + (REG.WEIGHTS[s] || 0), 0), 100, 'registry: weights still total 100');
})();

// misspellings fire
(function misspell() {
  ok(fires('Please recieve the seperate document.', 'receive'), 'fires: recieve → receive');
  ok(fires('Please recieve the seperate document.', 'separate'), 'fires: seperate → separate');
  ok(fires('This is definately a good enviroment.', 'definitely'), 'fires: definately');
  ok(fires('This is definately a good enviroment.', 'environment'), 'fires: enviroment');
  ok(fires('It occured on Wensday... occassion.', 'occurred'), 'fires: occured');
  ok(fires('teh quick brown fox', 'the'), 'fires: teh → the');
  ok(fires('We wich to acheive alot here.', 'which'), 'fires: wich → which');
})();

// zero false positives on correct text
(function clean() {
  const correct = 'Please receive the separate document. This is definitely a good environment for our business, and we recommend it because it is necessary and professional.';
  eq(ids(correct), [], 'clean: correctly spelled paragraph produces zero findings');
  // proper nouns / jargon are not in the map → not flagged
  eq(ids('SGEN GraphQL Kubernetes Playwright webhooks OAuth'), [], 'clean: names/jargon not flagged (no dictionary false-positives)');
})();

// doubled words
(function doubled() {
  ok(fires('This is is a test', 'is'), 'fires: doubled "is is"');
  ok(fires('Go to the the store', 'the the'), 'fires: doubled "the the"');
  eq(ids('I had had lunch and that that idea'), [], 'clean: "had had" / "that that" (had not in double set) — no over-flag');
})();

// code excluded + suite row + determinism
(function rowAndCode() {
  const html = '<p>We recieve orders.</p><pre><code>var seperate = 1; // recieve</code></pre>';
  ok(detect({ url: U, html }).some(i => i.value.includes('receive')), 'code: prose typo fires');
  ok(!detect({ url: U, html }).some(i => i.value.includes('separate')), 'code: typo inside <code> is NOT flagged');
  const row = scanSpelling([{ url: U, prose: 'recieve seperate' }]);
  eq(row.ruleId, 'FUNC-009', 'row: ruleId');
  eq(row.status, 'warn', 'row: medium → warn');
  ok(row.items.length === 2, 'row: aggregates both typos');
  eq(scanSpelling([{ url: U, prose: 'recieve' }]), scanSpelling([{ url: U, prose: 'recieve' }]), 'row: deterministic');
  eq(scanSpelling([{ url: U, prose: 'all good here' }]).status, 'pass', 'row: clean → pass');
})();

// frozen parity
(function frozen() {
  const dir = __dirname + '/..';
  const run = (cmd, needle) => { try { return needle.test(cp.execSync(cmd, { cwd: dir }).toString()); } catch (_) { return false; } };
  ok(run('node rules/registry.test.js', /PASS · 128 rules/), 'frozen: registry 96 rules, invariants hold');
})();

console.log('\n' + (fail === 0 ? '✅ PASS' : '❌ FAIL') + ` — ${pass}/${pass + fail} assertions`);
if (fail) { console.log('Failures:\n' + failures.map(f => '  - ' + f).join('\n')); process.exit(1); }
