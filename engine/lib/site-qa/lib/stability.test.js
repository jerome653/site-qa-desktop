'use strict';
// stability.test.js — Batch 4 Stability rules. Run: node lib/stability.test.js
const { stabilityPageChecks } = require('./checks-stability');

let fails = 0, total = 0;
const ok = (c, m) => { total++; if (!c) { console.error('  FAIL:', m); fails++; } };
const run = (html) => stabilityPageChecks({ url: 'https://x.test/p', isHtml: true, html });
const ids = (html) => run(html).map(f => f.ruleId);

// DOM-003 duplicate ids
ok(ids('<div id="a"></div><span id="a"></span>').includes('DOM-003'), 'DOM-003 duplicate id');
ok(!ids('<div id="a"></div><span id="b"></span>').includes('DOM-003'), 'unique ids → clean');
const dupF = run('<div id="a"></div><span id="a"></span>').find(f => f.ruleId === 'DOM-003');
ok(dupF.items[0].descriptor && dupF.items[0].descriptor.id === 'a', 'DOM-003 carries descriptor for locator');

// DOM-004 excessive DOM (Derived) — over budget
ok(ids('<div></div>'.repeat(1600)).includes('DOM-004'), 'DOM-004 large DOM');
ok(!ids('<div></div>'.repeat(50)).includes('DOM-004'), 'small DOM → clean');

// FORM-002 field semantics
ok(ids('<input name="email" type="text">').includes('FORM-002'), 'FORM-002 email as text');
ok(ids('<input name="phone" type="text">').includes('FORM-002'), 'FORM-002 phone as text');
ok(ids('<input type="password">').includes('FORM-002'), 'FORM-002 password without autocomplete');
ok(!ids('<input name="email" type="email"><input type="password" autocomplete="current-password">').includes('FORM-002'), 'correct types → clean');

// LINK-010 malformed mailto/tel
ok(ids('<a href="mailto:user@@x.test">x</a>').includes('LINK-010'), 'LINK-010 bad mailto');
ok(ids('<a href="tel:abc">x</a>').includes('LINK-010'), 'LINK-010 bad tel');
ok(!ids('<a href="mailto:ok@x.test">x</a><a href="tel:+15551234567">y</a>').includes('LINK-010'), 'valid mailto/tel → clean');

// non-html → nothing
ok(stabilityPageChecks({ url: 'x', isHtml: false, html: '{}' }).length === 0, 'non-html → no findings');

if (fails) { console.error(`❌ FAIL — ${total - fails}/${total} assertions`); process.exit(1); }
console.log(`✅ PASS — ${total}/${total} assertions`);
