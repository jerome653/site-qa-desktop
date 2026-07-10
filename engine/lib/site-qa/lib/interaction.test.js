'use strict';
// interaction.test.js — Batch 1 Interaction Integrity rules. Run: node lib/interaction.test.js
const { interactionCheck } = require('./checks-interaction');

let fails = 0, total = 0;
const ok = (c, m) => { total++; if (!c) { console.error('  FAIL:', m); fails++; } };
const run = html => interactionCheck({ html, url: 'https://x.test/p', isHtml: true });
const ids = html => run(html).map(f => f.ruleId);

// LINK-006 empty href
ok(ids('<a href="">x</a>').includes('LINK-006'), 'LINK-006 empty href');
// LINK-007 href="#"
ok(ids('<a href="#">x</a>').includes('LINK-007'), 'LINK-007 hash href');
// LINK-008 javascript:void(0) / javascript:
ok(ids('<a href="javascript:void(0)">x</a>').includes('LINK-008'), 'LINK-008 void(0)');
ok(ids('<a href="javascript:">x</a>').includes('LINK-008'), 'LINK-008 bare javascript:');
// LINK-009 missing href
ok(ids('<a>x</a>').includes('LINK-009'), 'LINK-009 no href');
// a real link is clean
ok(run('<a href="/services">x</a>').length === 0, 'valid link → no finding');
ok(run('<a href="https://x.test/a">x</a>').length === 0, 'absolute link → clean');
ok(run('<a href="#section">x</a>').length === 0, 'in-page anchor → clean');

// DOM-010 submit button outside form / inside form
ok(ids('<button type="submit">Go</button>').includes('DOM-010'), 'DOM-010 submit outside form');
ok(!ids('<form><button type="submit">Go</button></form>').includes('DOM-010'), 'submit inside form → clean');
// DOM-011 empty onclick
ok(ids('<button onclick="">Go</button>').includes('DOM-011'), 'DOM-011 empty onclick');
ok(!ids('<button onclick="doThing()">Go</button>').includes('DOM-011'), 'real onclick → clean');
// DOM-012 nested interactive
ok(ids('<a href="/x"><button>Go</button></a>').includes('DOM-012'), 'DOM-012 button in anchor');
ok(ids('<button><a href="/x">Go</a></button>').includes('DOM-012'), 'DOM-012 anchor in button');
ok(ids('<a href="/x"><a href="/y">Go</a></a>').includes('DOM-012'), 'DOM-012 nested anchors');
ok(!ids('<a href="/x">ok</a><a href="/y">ok</a>').includes('DOM-012'), 'siblings not nested → clean');
// DOM-013 disabled but active
ok(ids('<button disabled onclick="go()">Go</button>').includes('DOM-013'), 'DOM-013 disabled+onclick');
ok(ids('<a href="/x" aria-disabled="true">Go</a>').includes('DOM-013'), 'DOM-013 aria-disabled active link');

// findings carry a descriptor for the DOM provider (Developer Evidence in static mode)
const f = run('<a href="#" id="cta" class="btn primary">Go</a>')[0];
ok(f.items[0].descriptor && f.items[0].descriptor.tag === 'a' && f.items[0].descriptor.id === 'cta', 'descriptor carries id/tag');
ok(f.items[0].descriptor.classes.includes('btn'), 'descriptor carries classes');
ok(f.title === 'Link goes nowhere (href="#")', 'title from registry, not ruleId');

// non-html ctx → nothing
ok(interactionCheck({ html: '{"json":1}', url: 'x', isHtml: false }).length === 0, 'non-html → no findings');

if (fails) { console.error(`❌ FAIL — ${total - fails}/${total} assertions`); process.exit(1); }
console.log(`✅ PASS — ${total}/${total} assertions`);
