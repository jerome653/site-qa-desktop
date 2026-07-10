'use strict';
// contract.test.js — Run: node contract.test.js (exit 0 = 100% pass).
// Stage 0 gate: the Finding Contract v1 is frozen, deterministic, backward-compatible, and every
// engine finding projects onto it cleanly. NO scoring/behavior change — this proves the contract EXISTS
// and conforms, not that the engine emits it everywhere yet (that is Stage 2).
const fs = require('fs');
const path = require('path');
const { toContract, fingerprintOf, fiveQuestionGaps, CONTRACT_VERSION } = require('./contract');
const { enrichRow } = require('./finding');
const reg = require('./rules/registry');

let fails = 0, total = 0;
const ok = (c, m) => { total++; if (!c) { console.error('  FAIL:', m); fails++; } };

const SCHEMA = JSON.parse(fs.readFileSync(path.join(__dirname, 'schemas', 'finding-contract.schema.json'), 'utf8'));

// minimal structural validator (no ajv dep): checks required keys + enum membership, recursively.
function validate(obj, schema, pathStr = '') {
  const errs = [];
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const jsType = obj === null ? 'null' : Array.isArray(obj) ? 'array' : typeof obj === 'number' && Number.isInteger(obj) ? 'integer' : typeof obj;
    const match = types.some(t => t === jsType || (t === 'number' && jsType === 'integer') || (t === 'integer' && jsType === 'number' && Number.isInteger(obj)));
    if (!match) { errs.push(`${pathStr}: type ${jsType} not in ${types.join('|')}`); return errs; }
  }
  if (obj === null) return errs;
  if (schema.enum && !schema.enum.includes(obj)) errs.push(`${pathStr}: ${JSON.stringify(obj)} not in enum`);
  if (schema.pattern && typeof obj === 'string' && !new RegExp(schema.pattern).test(obj)) errs.push(`${pathStr}: "${obj}" fails /${schema.pattern}/`);
  if (schema.type === 'object' || (Array.isArray(schema.type) && schema.type.includes('object'))) {
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      for (const req of (schema.required || [])) if (!(req in obj)) errs.push(`${pathStr}: missing required "${req}"`);
      for (const [k, sub] of Object.entries(schema.properties || {})) if (k in obj) errs.push(...validate(obj[k], sub, `${pathStr}.${k}`));
    }
  }
  if ((schema.type === 'array' || (Array.isArray(schema.type) && schema.type.includes('array'))) && Array.isArray(obj) && schema.items) {
    obj.forEach((el, i) => errs.push(...validate(el, schema.items, `${pathStr}[${i}]`)));
  }
  return errs;
}

// ---- a representative element-level finding (as the engine emits today, pre-contract) ----
const rawFinding = enrichRow({
  ruleId: 'RESP-005', status: 'warn', name: 'Tap target < 44px',
  detail: '2 elements', value: '20x20', location: 'https://x.test/services',
  items: [{ page: 'https://x.test/services', section: 'Hero', id: 'a.btn.cta', value: '20x20' }],
}, 'responsive');

// ---- a page-level finding (no element) ----
const rawPageFinding = enrichRow({
  ruleId: 'SEO-003', status: 'warn', name: 'Missing meta description',
  detail: 'no <meta name=description>', location: 'https://x.test/about',
}, 'seo');

// 1) projects + schema-valid (element-level)
const c1 = toContract(rawFinding);
const e1 = validate(c1, SCHEMA, 'finding');
ok(e1.length === 0, 'element finding schema-valid: ' + e1.join(' · '));
ok(c1.contractVersion === CONTRACT_VERSION, 'contract version stamped');
ok(c1.locator && c1.locator.type === 'dom' && c1.locator.target === 'a.btn.cta', 'locator built from occurrence');
ok(c1.locator.sourceAvailability === 'requires-build-provenance' && c1.locator.source === null, 'source null + availability honest');

// 2) page-level: locator null, still valid + answers five questions via url/detail
const c2 = toContract(rawPageFinding);
const e2 = validate(c2, SCHEMA, 'finding');
ok(e2.length === 0, 'page finding schema-valid: ' + e2.join(' · '));
ok(c2.locator === null, 'page-level finding has null locator');

// 3) deterministic fingerprint — same input, same hash; different selector, different hash
const c1b = toContract(rawFinding);
ok(c1.fingerprint === c1b.fingerprint, 'fingerprint deterministic');
ok(/^[a-f0-9]{64}$/.test(c1.fingerprint), 'fingerprint is sha256');
ok(fingerprintOf({ ruleId: 'RESP-005', url: 'https://x.test/services', selector: 'a.btn.cta', evidence: '20x20' }) === c1.fingerprint, 'fingerprint reproducible from parts');
ok(fingerprintOf({ ruleId: 'RESP-005', url: 'https://x.test/services', selector: 'a.OTHER', evidence: '20x20' }) !== c1.fingerprint, 'different selector → different fingerprint');
// url normalization: trailing slash + fragment don't change identity
ok(fingerprintOf({ ruleId: 'A', url: 'https://x.test/p/', selector: 's', evidence: 'e' }) === fingerprintOf({ ruleId: 'A', url: 'https://x.test/p', selector: 's', evidence: 'e' }), 'url normalized for fingerprint');

// 4) five-question invariant — both findings answer all five
ok(fiveQuestionGaps(c1).length === 0, 'element finding answers 5 questions: ' + fiveQuestionGaps(c1).join(','));
ok(fiveQuestionGaps(c2).length === 0, 'page finding answers 5 questions: ' + fiveQuestionGaps(c2).join(','));

// 5) backward-compat — toContract does NOT mutate the input; old fields still present on the raw finding
ok(rawFinding.name === 'Tap target < 44px' && rawFinding.ruleId === 'RESP-005' && Array.isArray(rawFinding.items), 'raw finding unchanged (no mutation)');
ok(rawFinding.severity === 'medium' && rawFinding.suite === 'responsive', 'enrichRow fields intact');

// 6) golden — every scored registry rule projects to a schema-valid, 5-question-complete contract finding
let projFails = 0;
for (const r of reg.RULES) {
  if (r.manual) continue;
  const f = enrichRow({ ruleId: r.id, status: 'fail', name: r.title, detail: 'x', value: '1', location: 'https://x.test/', items: [{ page: 'https://x.test/', section: '-', id: 'el', value: '1' }] }, r.suite);
  const c = toContract(f);
  const ve = validate(c, SCHEMA, r.id);
  const qg = fiveQuestionGaps(c);
  if (ve.length || qg.length) { projFails++; if (projFails <= 3) console.error('   rule', r.id, 'gaps:', ve.concat(qg).join(',')); }
}
ok(projFails === 0, `all ${reg.RULES.filter(r => !r.manual).length} scored rules project clean (${projFails} failed)`);

// 7) impacts never carry an "affected users" axis (honesty invariant)
ok(!('affectedUsers' in c1.impacts) && !('affected_users' in c1.impacts), 'no affected-users axis in impacts');

// 8) CONTRACT COMPATIBILITY — round-trip: contract → JSON → contract, identical (interchange-stable)
const rt = JSON.parse(JSON.stringify(c1));
ok(JSON.stringify(rt) === JSON.stringify(c1), 'contract survives JSON round-trip byte-identical');
ok(rt.fingerprint === c1.fingerprint && rt.id === c1.id, 'fingerprint/id stable across round-trip');
// re-projecting the same raw finding yields an identical contract (deterministic, no hidden state)
ok(JSON.stringify(toContract(rawFinding)) === JSON.stringify(c1), 're-projection identical (deterministic)');

// 9) single-source projection: projectFindings + contractToMarkdown derive one canonical model
const { projectFindings, contractToMarkdown } = require('./lib/report-contract');
const suitesFixture = [{ key: 'responsive', name: 'Responsive', checks: [rawFinding, enrichRow({ ruleId: 'A11Y-003', status: 'fail', name: 'No <h1> on page', detail: 'x', location: 'https://x.test/p' }, 'a11y')] }];
const proj = projectFindings(suitesFixture, { host: 'x.test', generated: '2026-07-09' });
ok(proj.findings.length >= 2, 'projectFindings produced canonical findings');
ok(proj.metrics.contractVersion === CONTRACT_VERSION && typeof proj.metrics.projectionMs === 'number', 'contract metrics present');
ok(rawFinding.items[0]._md && rawFinding.items[0]._md.includes('QA issue'), 'occurrence annotated with precomputed contract markdown');
ok(rawFinding._md && rawFinding._md.includes('rule RESP-005'), 'check annotated with contract markdown (rule id from contract)');
ok(contractToMarkdown(c1).includes(c1.fingerprint.slice(0, 16)), 'markdown derives from contract (carries fingerprint)');

if (fails) { console.error(`❌ FAIL — ${total - fails}/${total} assertions`); process.exit(1); }
console.log(`✅ PASS — ${total}/${total} assertions`);
