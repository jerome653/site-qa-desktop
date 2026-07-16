'use strict';
// content-artifacts.test.js — deterministic suite for FUNC-008. Mojibake/control fixtures are built
// from char codes (ASCII-safe source). Verifies each detector fires, clean copy stays silent, code
// examples don't false-positive, determinism, registry integration, and frozen score parity.
const cp = require('child_process');
const REG = require('../rules/registry');
const { scanContentArtifacts, detect, proseFromHtml, RULE_ID } = require('./index');

let pass = 0, fail = 0; const failures = [];
function ok(c, n) { if (c) pass++; else { fail++; failures.push(n); console.log('  ✗ ' + n); } }
function eq(a, b, n) { ok(JSON.stringify(a) === JSON.stringify(b), n + (JSON.stringify(a) === JSON.stringify(b) ? '' : ` (got ${JSON.stringify(a)})`)); }

const U = 'https://demo-site.example.com/';
const cc = String.fromCharCode;
const ids = prose => new Set(detect({ url: U, prose }).map(i => i.id));
const has = (prose, id) => ids(prose).has(id);

console.log('FUNC-008 — content-artifacts — test suite\n');

// ── registry integration ──
(function registry() {
  const r = REG.getById('FUNC-008');
  ok(!!r, 'registry: FUNC-008 exists');
  eq(r.suite, 'functional', 'registry: FUNC-008 in functional suite');
  ok(!r.manual && r.deduction > 0, 'registry: FUNC-008 is scored (non-manual, deducts)');
  eq(REG.SUITES.reduce((a, s) => a + (REG.WEIGHTS[s] || 0), 0), 100, 'registry: weights still total 100');
})();

// ── detectors fire on bad copy ──
(function detectors() {
  ok(has('Hello {{customer.name}}, order {{order_id}} is ready', 'unresolved-token'), 'token: {{ }} handlebars fires');
  ok(has('Total due: {% cart.total %}', 'unresolved-token'), 'token: {% %} liquid fires');
  ok(has('Welcome ${user.firstName} to the store', 'unresolved-token'), 'token: ${ } literal fires');
  ok(has('Our caf' + cc(0x00c3) + cc(0x00a9) + ' is open', 'mojibake'), 'mojibake: C3 A9 (garbled e-acute) fires');
  ok(has('Copyright' + cc(0x00c2) + cc(0x00a0) + '2026', 'mojibake'), 'mojibake: C2 A0 (garbled nbsp) fires');
  ok(has('We' + cc(0x00e2) + cc(0x20ac) + cc(0x2122) + 're open', 'mojibake'), 'mojibake: E2 20AC (garbled smart-quote) fires');
  ok(has('Price ' + cc(0xFFFD) + ' 50', 'replacement-char'), 'replacement char (U+FFFD) fires');
  ok(has('Tom &amp;amp; Jerry', 'double-escaped-entity'), 'double-escaped entity fires');
  ok(has('Line one' + cc(0x07) + 'bell', 'stray-control-char'), 'stray control char fires');
})();

// ── clean copy stays silent (no false positives) ──
(function clean() {
  const clean1 = 'Welcome to our store. Prices start at $20. Email us at hi@demo.example.';
  eq([...ids(clean1)], [], 'clean: normal copy with $20 and @ produces no artifacts');
  const clean2 = 'Our menu features fresh pasta, salads, and coffee. Open 9-5, Mon-Fri.';
  eq([...ids(clean2)], [], 'clean: plain prose is silent');
  // $20 must NOT trip the ${} token detector
  ok(!has('It costs $20 or $30', 'unresolved-token'), 'clean: "$20" is not a template token');
})();

// ── code examples are excluded (prose-only) ──
(function codeExcluded() {
  const html = '<h1>Docs</h1><p>Use the tag like this:</p><pre><code>{{ user.name }}</code></pre><p>All good.</p>';
  const items = detect({ url: U, html });
  eq(items.length, 0, 'code: {{ }} inside <code> does NOT false-positive');
  const html2 = '<p>Hi {{name}}</p><code>{{ ignored }}</code>';
  ok(detect({ url: U, html: html2 }).some(i => i.id === 'unresolved-token'), 'code: a real {{name}} leak in prose still fires (code ignored)');
})();

// ── suite row + status + determinism ──
(function row() {
  const bad = scanContentArtifacts([{ url: U, prose: 'Hi {{name}}, caf' + cc(0x00c3) + cc(0x00a9) }]);
  eq(bad.ruleId, 'FUNC-008', 'row: ruleId FUNC-008');
  eq(bad.suite, 'functional', 'row: in functional suite');
  eq(bad.status, 'fail', 'row: high severity -> fail status');
  ok(bad.items.length >= 2, 'row: aggregates all artifacts');
  const good = scanContentArtifacts([{ url: U, prose: 'A perfectly clean sentence.' }]);
  eq(good.status, 'pass', 'row: clean -> pass');
  eq(scanContentArtifacts([{ url: U, prose: 'Hi {{name}}' }]), scanContentArtifacts([{ url: U, prose: 'Hi {{name}}' }]), 'row: deterministic');
})();

// ── frozen score parity (registry grew, but existing output must be byte-identical) ──
(function frozen() {
  const dir = __dirname + '/..';
  const run = (cmd, needle) => { try { return needle.test(cp.execSync(cmd, { cwd: dir }).toString()); } catch (_) { return false; } };
  ok(run('node rules/registry.test.js', /PASS · 138 rules/), 'frozen: registry 138 rules, invariants hold');
})();

console.log('\n' + (fail === 0 ? '✅ PASS' : '❌ FAIL') + ` — ${pass}/${pass + fail} assertions`);
if (fail) { console.log('Failures:\n' + failures.map(f => '  - ' + f).join('\n')); process.exit(1); }
