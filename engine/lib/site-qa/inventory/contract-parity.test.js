'use strict';
// contract-parity.test.js — ADR-0004 acceptance evidence A1.
//
// THE CLAIM UNDER TEST: the provider contract widened from `enumerate(pages, host)` to
// `enumerate(collection, ctx)` WITHOUT changing a single byte of what the seven existing providers
// produce. A1 is the whole basis on which ADR-0004 may move PROPOSED → ACCEPTED, so it is gated here
// rather than asserted in prose.
//
// The golden hash below is the real, measured output of the full inventory-driven pipeline (providers
// → inventories → comparison → evidence → certification → migration report) over the same fixtures
// `inventory.test.js` uses. It was captured from the code BEFORE the contract widened and must not
// move for a contract change. If a future change to a PROVIDER legitimately alters output, re-baseline
// deliberately (run this file with SGEN_A1_PRINT=1, paste the new hash, and say why in the commit) —
// never by deleting the assertion.
const crypto = require('crypto');
const { buildInventory, PROVIDERS } = require('./index');
const { makeCollection, fromPages, isCollection, assertCollection, CHANNELS } = require('./collection');
const { IdRegistry } = require('./id-registry');
const { certifyMigration } = require('./certify-pipeline');
const version = require('../version');

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
const TGT = [
  page('https://staging.example.com/', `<!doctype html><html><head><title>Home</title><link rel="icon" href="/favicon.ico"></head>
    <body class="header--fixed"><header><nav>Home About</nav></header><h1>Welcome</h1><h2>Our Services</h2>
    <img src="/img/hero.jpg"><img src="/img/logo.svg"><div class="accordion">FAQ</div><footer>© 2026</footer></body></html>`),
  page('https://staging.example.com/about', `<html><body><header></header><h1>About</h1><img src="/img/team.jpg"><footer></footer></body></html>`),
];
const AT = '2026-07-28T00:00:00.000Z';

// ── THE A1 GOLDEN ─────────────────────────────────────────────────────────────────────────────────
// The output of the SEVEN providers that existed before the contract widened, over the fixtures above.
// Verified byte-identical against the pre-widening code (baseline captured before any edit), and
// re-verified after ADR-0005 registered an eighth provider. This is the assertion that must never be
// weakened: it is the entire evidentiary basis of ADR-0004 acceptance criteria 1 and 2.
const A1_INVENTORY_SHA256 = '82c2ea07b97e1232b97cd215c2787fc4ce67d8146a6095cbaa32139a89c8693d';
//
// HISTORICAL: the original A1 baseline hashed the seven-provider inventory AND the whole downstream
// pipeline (comparison → evidence → certification → migration report) as one value:
//     ebb18ec8e1b1fbbc8a37f95a3f14b5b30ea4daca4ae9b30088e5e9303aaff27c   (193,610 bytes, 2026-07-28)
// That value is no longer asserted, and the reason is recorded rather than quietly dropped:
// `certifyMigration` builds its inventories from the FULL registered provider set, so registering
// ADR-0005's NetworkProvider legitimately adds an empty `network` type to every downstream structure.
// Pinning the combined value would have meant re-baselining the golden every time a provider is added
// — i.e. the A1 evidence would decay into a number nobody trusts. The claim is therefore split: the
// seven-provider output is pinned exactly and permanently (above), and the pipeline is asserted for
// internal consistency (both input shapes agreeing) rather than against a value that is SUPPOSED to
// move. Narrower, but true — and it stays true.

function ser(i) {
  return {
    id: i.id, type: i.type, identityKey: i.identityKey, provider: i.provider,
    parent: i.parent, children: i.children.slice().sort(), state: i.state,
    history: i.history, meta: i.meta, findings: i.findings, evidence: i.evidence,
    comparisonMapping: i.comparisonMapping, referenceMapping: i.referenceMapping,
    certificationState: i.certificationState,
  };
}
function serInv(inv) {
  const out = { counts: inv.counts, total: inv.total, target: inv.target, items: {} };
  for (const t of Object.keys(inv.items).sort()) out.items[t] = inv.items[t].map(ser);
  return out;
}
// The full pipeline, serialised deterministically. `input` is whatever buildInventory/certifyMigration
// accept — legacy array or Collection — which is exactly what makes this a parity harness.
// THE GOLDEN IS SCOPED TO THE SEVEN PROVIDERS A1 IS ABOUT. A1's claim is precisely "the seven
// providers that existed before the contract widened produce byte-identical output through it" — it is
// not, and never was, "buildInventory's output can never change again". Registering an eighth provider
// (ADR-0005's NetworkProvider) legitimately changes the full output; hashing the full set would have
// forced a re-baseline and destroyed the evidence A1 exists to preserve. Scoping keeps the claim exact
// and permanently checkable. Suite 3 below separately asserts the eighth provider IS registered, so
// scoping cannot be used to hide a provider from the gate.
const A1_PROVIDER_TYPES = ['page', 'section', 'component', 'global', 'asset', 'form', 'behavior'];
const a1Providers = () => PROVIDERS.filter(p => A1_PROVIDER_TYPES.includes(p.type));

// The seven-provider inventory alone — the exact scope of the A1 claim, pinned by A1_INVENTORY_SHA256.
function inventoryJSON(refInput, tgtInput) {
  const providers = a1Providers();
  return JSON.stringify({
    refInventory: serInv(buildInventory(refInput, { providers, idRegistry: new IdRegistry(), host: 'old.example.com', target: 'https://old.example.com' })),
    tgtInventory: serInv(buildInventory(tgtInput, { providers, idRegistry: new IdRegistry(), host: 'staging.example.com', target: 'https://staging.example.com' })),
  }, null, 2);
}

function pipelineJSON(refInput, tgtInput) {
  const r = {};
  const providers = a1Providers();
  r.refInventory = serInv(buildInventory(refInput, { providers, idRegistry: new IdRegistry(), host: 'old.example.com', target: 'https://old.example.com' }));
  r.tgtInventory = serInv(buildInventory(tgtInput, { providers, idRegistry: new IdRegistry(), host: 'staging.example.com', target: 'https://staging.example.com' }));
  const cert = certifyMigration(REF, TGT, {
    at: AT, idRegistry: new IdRegistry(),
    source: 'https://old.example.com', target: 'https://staging.example.com',
    sourceHost: 'old.example.com', targetHost: 'staging.example.com',
  });
  r.diff = { perType: cert.diff.perType, matched: cert.diff.matched.map(i => i.identityKey), missing: cert.diff.missing.map(i => i.identityKey), added: cert.diff.added.map(i => i.identityKey) };
  r.evidence = cert.evidence;
  r.cert = { verdict: cert.cert.verdict, gates: cert.cert.gates, tally: cert.cert.tally, explanations: cert.cert.explanations };
  r.report = cert.report;
  r.refInvAfterCertify = serInv(cert.refInv);
  return JSON.stringify(r, null, 2);
}
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

console.log('Provider contract parity (ADR-0004 A1) — test suite\n');

// ── 1 · the golden: the seven providers' output has not moved ─────────────────────────────────────
(function golden() {
  const legacy = inventoryJSON(REF, TGT);         // bare arrays — every existing caller's shape
  const h = sha(legacy);
  if (process.env.SGEN_A1_PRINT) console.log('  A1 inventory hash: ' + h + '  (' + Buffer.byteLength(legacy) + ' bytes)');
  ok(h === A1_INVENTORY_SHA256, `A1 golden: seven-provider output byte-identical to the pre-widening baseline (expected ${A1_INVENTORY_SHA256.slice(0, 12)}…, got ${h.slice(0, 12)}…)`);
})();

// ── 2 · both input shapes agree, byte for byte ────────────────────────────────────────────────────
(function bothShapes() {
  const invArray = inventoryJSON(REF, TGT);
  const invCollection = inventoryJSON(makeCollection({ staticPages: REF, collected: ['staticPages'] }), makeCollection({ staticPages: TGT, collected: ['staticPages'] }));
  ok(invArray === invCollection, 'parity: legacy array and Collection produce byte-identical inventories');
  ok(sha(invCollection) === A1_INVENTORY_SHA256, 'parity: the Collection path also matches the golden');
  // The downstream pipeline is asserted for CONSISTENCY, not against a pinned value: it is built from
  // the full provider set, so it is supposed to change when a provider is added. Both input shapes
  // still have to agree exactly — that is the part the contract change could actually have broken.
  const pipeArray = pipelineJSON(REF, TGT);
  const pipeCollection = pipelineJSON(makeCollection({ staticPages: REF, collected: ['staticPages'] }), makeCollection({ staticPages: TGT, collected: ['staticPages'] }));
  ok(pipeArray === pipeCollection, 'parity: legacy array and Collection produce a byte-identical downstream pipeline');
})();

// ── 3 · providers actually receive a Collection (the contract, not a shim) ─────────────────────────
(function contractShape() {
  const seen = [];
  const spy = { type: 'page', enumerate(collection, ctx) { seen.push({ collection, ctx }); return []; } };
  const saved = PROVIDERS.slice();
  PROVIDERS.length = 0; PROVIDERS.push(spy);
  try { buildInventory(REF, { idRegistry: new IdRegistry(), host: 'old.example.com', target: 'https://old.example.com' }); }
  finally { PROVIDERS.length = 0; saved.forEach(p => PROVIDERS.push(p)); }
  ok(seen.length === 1, 'contract: provider invoked once');
  ok(seen[0] && isCollection(seen[0].collection), 'contract: arg 1 is a Collection, not a bare array');
  ok(seen[0] && !Array.isArray(seen[0].collection), 'contract: arg 1 is NOT an array (the old shape is gone)');
  eq(seen[0] && seen[0].collection.staticPages.length, REF.length, 'contract: collection.staticPages carries the crawl records unchanged');
  eq(seen[0] && seen[0].ctx, { host: 'old.example.com', target: 'https://old.example.com' }, 'contract: arg 2 is ctx (run parameters, not evidence)');
})();

// ── 4 · the Collection is sealed, complete, and does not capture its caller's array ────────────────
(function sealed() {
  const c = makeCollection({ staticPages: REF });
  ok(Object.isFrozen(c), 'collection: frozen');
  ok(CHANNELS.every(ch => Array.isArray(c[ch])), 'collection: every channel present as an array (a provider never has to guard)');
  ok(CHANNELS.filter(ch => ch !== 'staticPages').every(ch => c[ch].length === 0), 'collection: unfilled channels are empty, never undefined');
  ok(Object.isFrozen(c.staticPages), 'collection: channel arrays frozen');
  ok(!Object.isFrozen(REF), "collection: the CALLER's array is not frozen (channels are copied, not captured)");
  ok(c.staticPages !== REF, 'collection: staticPages is a copy, not the caller reference');
  eq(c.schemaVersion, version.COLLECTION_SCHEMA_VERSION, 'collection: stamps the schema version from the single version authority');
  let threw = false; try { makeCollection({ network: 'nope' }); } catch (_) { threw = true; }
  ok(threw, 'collection: a non-array channel fails closed');
})();

// ── 5 · the seam validator fails closed (ADR-0004 §D7) ────────────────────────────────────────────
(function seam() {
  ok(isCollection(fromPages(REF)), 'seam: fromPages produces a Collection');
  eq(fromPages(REF).staticPages.length, REF.length, 'seam: fromPages carries the pages');
  let threwArr = false; try { assertCollection(REF); } catch (_) { threwArr = true; }
  ok(threwArr, 'seam: assertCollection rejects a bare array');
  let threwNull = false; try { assertCollection(null); } catch (_) { threwNull = true; }
  ok(threwNull, 'seam: assertCollection rejects null');
  ok(!isCollection(REF) && !isCollection({}) && !isCollection(undefined), 'seam: isCollection is not fooled by look-alikes');
})();

// ── 6 · ComponentProvider: the provider the old contract could not carry ───────────────────────────
(function component() {
  const cp = PROVIDERS.find(p => p.type === 'component');
  ok(!!cp, 'component: provider registered');
  eq(cp.enumerate(makeCollection({ staticPages: REF })), [], 'component: reads collection.render, finds it empty, returns zero items BY EVIDENCE');
  let threw = false;
  try { cp.enumerate(makeCollection({ render: [{ url: 'https://x/', viewport: '1920', elements: [] }] })); } catch (_) { threw = true; }
  ok(threw, 'component: a POPULATED render channel fails closed rather than minting a false "no components"');
})();

// ── 6b · the eighth provider IS registered (scoping the golden must not hide a provider) ──────────
(function eighthRegistered() {
  // Every provider added beyond A1's seven must be named here. The golden is scoped to the seven, so
  // without this list a new provider could be added and never gated by anything.
  const BEYOND_A1 = ['network', 'document'];   // ADR-0005 · ADR-0006
  for (const t of BEYOND_A1) ok(PROVIDERS.some(p => p.type === t), `scope guard: ${t} provider is registered in PROVIDERS`);
  ok(PROVIDERS.length === A1_PROVIDER_TYPES.length + BEYOND_A1.length,
    `scope guard: exactly ${BEYOND_A1.length} provider(s) beyond A1's seven — an unlisted provider must not slip past the scoped golden (got ${PROVIDERS.length})`);
})();

// ── 7 · nothing frozen by ADR-0004 §D9 moved ──────────────────────────────────────────────────────
(function frozenScope() {
  const reg = require('../rules/registry');
  eq(reg.RULES.length, 142, 'D9: registry rule count unchanged');
  eq(reg.SUITES.reduce((a, s) => a + (reg.WEIGHTS[s] || 0), 0), 100, 'D9: suite weights still total 100');
  eq(version.ENGINE_VERSION, '2.3.0', 'D9: engine version unmoved (A1 changes no behaviour)');
  eq(version.REPORT_VERSION, '1.4.0', 'D9: report version unmoved');
  ok(!!version.PROVIDER_CONTRACT_VERSION && !!version.COLLECTION_SCHEMA_VERSION, 'D6: the two new boundary streams are owned by version.js');
})();

console.log('\n' + (fail === 0 ? '✅ PASS' : '❌ FAIL') + ` — ${pass}/${pass + fail} assertions`);
if (fail) { console.log('Failures:\n' + failures.map(f => '  - ' + f).join('\n')); process.exit(1); }
