'use strict';
// infra.test.js — Stage 1 core-infrastructure unit tests: uri-validate · locator · fingerprint · rule-deps.
// Run: node lib/infra.test.js  (exit 0 = 100% pass).
const { validateUri, isDeadTarget, schemeOf } = require('./uri-validate');
const { domLocator, genericLocator, stableSelector, domStrategies } = require('./locator');
const { fingerprintOf } = require('./fingerprint');
const { shouldSkip, order, indexFired } = require('./rule-deps');

let fails = 0, total = 0;
const ok = (c, m) => { total++; if (!c) { console.error('  FAIL:', m); fails++; } };

// ---- uri-validate ----
ok(validateUri('https://x.test/a').level === 'ok', 'https ok');
ok(validateUri('/services').valid && validateUri('/services').scheme === 'relative', 'relative ok');
ok(validateUri('#section').valid, 'in-page anchor ok');
ok(validateUri('#').level === 'invalid', 'bare # invalid');
ok(validateUri('').level === 'invalid', 'empty invalid');
ok(validateUri('javascript:void(0)').level === 'invalid', 'javascript:void(0) invalid (dead)');
ok(validateUri('javascript:').level === 'invalid', 'javascript: invalid (dead)');
ok(validateUri('javascript:doThing()').level === 'warning', 'javascript:realcall = warning');
ok(validateUri('mailto:support@x.test').valid, 'valid mailto');
ok(!validateUri('mailto:user@@x.test').valid, 'double-@ mailto invalid');
ok(!validateUri('mailto:').valid, 'empty mailto invalid');
ok(validateUri('tel:+639171234567').valid, 'valid tel');
ok(!validateUri('tel:abc123').valid, 'alpha tel invalid');
ok(validateUri('data:text/html,x').level === 'informational', 'data: informational');
ok(schemeOf('MAILTO:a@b.co') === 'mailto', 'scheme lowercased');
ok(isDeadTarget('#') && isDeadTarget('') && isDeadTarget('javascript:void(0)') && !isDeadTarget('/ok'), 'isDeadTarget correct');

// ---- locator: ranked strategies + copy-as + stability ----
const loc = domLocator({ tag: 'a', id: 'quote-btn', classes: ['btn', 'cta'], attributes: { href: '#', 'data-testid': 'quote' }, xpath: '/html/body/main/a', structuralCss: 'main > a:nth-of-type(1)', url: '/services', boundingBox: { x: 1, y: 2, width: 3, height: 4 } });
ok(loc.type === 'dom', 'dom locator type');
ok(loc.strategies[0].kind === 'id' && loc.strategies[0].stability === 'high', 'id ranked first');
ok(loc.strategies.some(s => s.kind === 'data-testid'), 'data-testid captured');
ok(loc.strategies.some(s => s.kind === 'xpath' && s.stability === 'low'), 'xpath low stability');
ok(loc.copyAs.playwright === "page.locator(\"#quote-btn\")", 'playwright copyAs: ' + loc.copyAs.playwright);
ok(loc.copyAs.cypress === "cy.get(\"#quote-btn\")", 'cypress copyAs');
ok(loc.copyAs.querySelector.startsWith('document.querySelector('), 'querySelector copyAs');
ok(loc.sourceAvailability === 'requires-build-provenance' && loc.source === null, 'source honest-null');
ok(stableSelector(loc) === '#quote-btn', 'stableSelector picks most-stable');
// no id/testid → falls back through class → structural → xpath
const loc2 = domLocator({ tag: 'button', classes: [], attributes: {}, xpath: '/html/body/button', structuralCss: 'body > button' });
ok(loc2.strategies[0].stability === 'low', 'no stable anchor → low first');

// generic locator (build integrity reuse)
const gl = genericLocator('manifest', 'chunk.hero.a1b2', { url: '/build/manifest.json' });
ok(gl.type === 'manifest' && gl.target === 'chunk.hero.a1b2' && gl.strategies[0].kind === 'manifest', 'generic manifest locator');

// ---- fingerprint: deterministic + normalized ----
const fpA = fingerprintOf({ ruleId: 'LINK-006', url: 'https://x.test/p/', selector: '#a', evidence: 'href=#' });
const fpB = fingerprintOf({ ruleId: 'LINK-006', url: 'https://x.test/p', selector: '#a', evidence: 'href=#' });
ok(fpA === fpB, 'url trailing-slash normalized in fingerprint');
ok(/^[a-f0-9]{64}$/.test(fpA), 'fingerprint sha256');
ok(fpA !== fingerprintOf({ ruleId: 'LINK-006', url: 'https://x.test/p', selector: '#b', evidence: 'href=#' }), 'selector changes fingerprint');

// ---- rule-deps: skip + order + index ----
const fired = indexFired([{ ruleId: 'FUNC-001', status: 'fail', location: 'https://x.test/broken' }]);
ok(shouldSkip({ id: 'SEO-003', skipIf: ['FUNC-001'] }, 'https://x.test/broken', fired).skip === true, 'skip meta on broken page');
ok(shouldSkip({ id: 'SEO-003', skipIf: ['FUNC-001'] }, 'https://x.test/ok', fired).skip === false, 'do not skip on healthy page');
ok(shouldSkip({ id: 'SEO-003' }, 'https://x.test/broken', fired).skip === false, 'no skipIf → never skip');
const ordered = order([{ id: 'B', dependsOn: ['A'] }, { id: 'A' }, { id: 'C', dependsOn: ['B'] }]);
ok(ordered.map(r => r.id).join('') === 'ABC', 'topological order by dependsOn: ' + ordered.map(r => r.id).join(''));
ok(order([{ id: 'X', dependsOn: ['Y'] }, { id: 'Y', dependsOn: ['X'] }]).length === 2, 'cycle-safe (no crash)');

if (fails) { console.error(`❌ FAIL — ${total - fails}/${total} assertions`); process.exit(1); }
console.log(`✅ PASS — ${total}/${total} assertions`);
