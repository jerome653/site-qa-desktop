'use strict';
// providers.test.js — Stage 3 Evidence Provider tests: DOM provider builds a deterministic, stable
// locator + locatorId from element facts; render descriptor shapes correctly; screenshots stay lazy.
// Run: node lib/providers.test.js
const { domProvider, locatorIdOf, DESCRIBE_ELEMENTS } = require('./evidence-providers');
const { toContract } = require('../contract');

let fails = 0, total = 0;
const ok = (c, m) => { total++; if (!c) { console.error('  FAIL:', m); fails++; } };

const facts = {
  tag: 'a', id: 'quote-btn', classes: ['btn', 'cta'],
  attributes: { href: '#', 'data-testid': 'quote', role: 'button' },
  text: 'Get a Quote', outerHTML: '<a id="quote-btn" class="btn cta" href="#">Get a Quote</a>',
  xpath: "//*[@id='quote-btn']", structuralCss: 'main > a:nth-of-type(1)',
  boundingBox: { x: 412, y: 268, width: 184, height: 52 }, visible: true, url: 'https://x.test/services',
};

// 1) DOM provider builds full locator + locatorId + carries text/outerHTML/visibility/bbox
const loc = domProvider.enrich(facts);
ok(loc.type === 'dom', 'dom locator');
ok(loc.strategies[0].kind === 'id' && loc.strategies[0].stability === 'high', 'id strategy ranked first');
ok(loc.strategies.some(s => s.kind === 'data-testid'), 'data-testid strategy present');
ok(loc.copyAs && loc.copyAs.playwright === 'page.locator("#quote-btn")', 'copyAs playwright');
ok(/^[a-f0-9]{64}$/.test(loc.locatorId), 'locatorId is sha256');
ok(loc.text === 'Get a Quote' && loc.outerHTML.startsWith('<a') && loc.visible === true, 'text/outerHTML/visible carried');
ok(loc.boundingBox && loc.boundingBox.width === 184, 'bbox carried');
ok(loc.sourceAvailability === 'requires-build-provenance', 'source honest-null');

// 2) locatorId is deterministic + selector-stable: same page+preferred+tag → same id; DOM position change
//    (structuralCss/xpath) does NOT change it (that's the whole point — a stable handle)
ok(domProvider.enrich(facts).locatorId === loc.locatorId, 'locatorId deterministic');
const moved = { ...facts, structuralCss: 'main > a:nth-of-type(9)', xpath: '/html/body/main/a[9]' };
ok(domProvider.enrich(moved).locatorId === loc.locatorId, 'locatorId stable when only DOM position changes');
const renamed = { ...facts, id: 'other-btn' };
ok(domProvider.enrich(renamed).locatorId !== loc.locatorId, 'locatorId changes when the stable anchor changes');
ok(locatorIdOf('https://x.test/services/', '#quote-btn', 'A') === locatorIdOf('https://x.test/services', '#quote-btn', 'a'), 'locatorId: url normalized + tag case-insensitive');

// 3) contract consumes the provider locator (opts.locator wins; fingerprint uses stable strategy)
const c = toContract({ ruleId: 'RESP-005', status: 'warn', name: 'Tap target < 44px', detail: '20x20', suite: 'responsive' },
  { url: facts.url, selector: 'a.btn.cta', value: '20x20', locator: loc });
ok(c.locator.locatorId === loc.locatorId, 'contract carries provider locator + locatorId');
ok(c.locator.strategies[0].kind === 'id', 'contract locator is the ranked one, not raw selector');
// fingerprint should be based on the STABLE selector (#quote-btn), not the raw item selector
const { fingerprintOf } = require('./fingerprint');
ok(c.fingerprint === fingerprintOf({ ruleId: 'RESP-005', url: facts.url, selector: '#quote-btn', evidence: '20x20' }), 'fingerprint uses stable selector');

// 4) render provider serializer is a valid function string (parses)
ok(typeof DESCRIBE_ELEMENTS === 'string' && DESCRIBE_ELEMENTS.trim().startsWith('(function'), 'DESCRIBE_ELEMENTS is an IIFE string');
ok(!(() => { try { new Function('return ' + DESCRIBE_ELEMENTS); return false; } catch (e) { return true; } })(), 'DESCRIBE_ELEMENTS parses');

// 5) screenshots stay lazy — provider does not fabricate one
ok(loc.screenshot === undefined || loc.screenshot === null, 'no screenshot fabricated by DOM provider');

if (fails) { console.error(`❌ FAIL — ${total - fails}/${total} assertions`); process.exit(1); }
console.log(`✅ PASS — ${total}/${total} assertions`);
