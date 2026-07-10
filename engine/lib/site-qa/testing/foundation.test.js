'use strict';
// foundation.test.js — direct unit coverage for the two foundation modules the higher-level suites
// only reach through the live-scan runtime: the lifecycle event bus (events.js) and the version
// streams (version.js). Keeps the deterministic layer fully unit-covered.
const { createBus, AuditBus, EVENTS } = require('../events');
const version = require('../version');
const { REGISTRY_VERSION } = require('../rules/registry');

let pass = 0, fail = 0; const failures = [];
function ok(c, n) { if (c) pass++; else { fail++; failures.push(n); console.log('  ✗ ' + n); } }
function eq(a, b, n) { ok(JSON.stringify(a) === JSON.stringify(b), n); }

console.log('Foundation (events + version) — test suite\n');

// events.js
eq(EVENTS.length, 7, 'events: 7 lifecycle events defined');
ok(Object.isFrozen(EVENTS), 'events: EVENTS list is frozen');
const bus = createBus();
ok(bus instanceof AuditBus, 'events: createBus() returns an AuditBus');
let seen = null;
bus.on('scan.started', p => { seen = p; });
bus.fire('scan.started', { url: 'x' });
eq(seen, { url: 'x' }, 'events: fire delivers payload to listeners');
// guarded emit — a throwing listener must not break the fire()
bus.on('finding.created', () => { throw new Error('listener boom'); });
let survived = true;
try { bus.fire('finding.created', { ruleId: 'SEC-001' }); } catch (_) { survived = false; }
ok(survived, 'events: a throwing listener is non-fatal (guarded fire)');
ok(bus.fire('page.completed', {}) === bus, 'events: fire() is chainable (returns the bus)');
// firing with no listener is a safe no-op
ok(createBus().fire('scan.completed', {}) instanceof AuditBus, 'events: fire with no listener is a no-op');

// version.js
eq(version.ENGINE_VERSION, '2.3.0', 'version: engine 2.3.0');
eq(version.REPORT_VERSION, '1.3.0', 'version: report 1.3.0');
eq(version.REGISTRY_VERSION, REGISTRY_VERSION, 'version: registry version mirrors the registry');

console.log('\n' + (fail === 0 ? '✅ PASS' : '❌ FAIL') + ` — ${pass}/${pass + fail} assertions`);
if (fail) { console.log('Failures:\n' + failures.map(f => '  - ' + f).join('\n')); process.exit(1); }
