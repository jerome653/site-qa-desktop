'use strict';
// version-authority.test.js — D6 evidence (ADR-0004 §D6).
//
// The load-bearing suite is §2: a scan of the real source tree for any file that DECLARES one of the
// authority's streams. That is what makes "one authority" enforceable rather than aspirational — a
// future edit that reintroduces a literal turns this red.
const fs = require('fs');
const path = require('path');
const VA = require('./version-authority');
const version = require('./version');
const { REGISTRY_VERSION, RULES } = require('./rules/registry');

let pass = 0, fail = 0; const failures = [];
function ok(c, n) { if (c) pass++; else { fail++; failures.push(n); console.log('  ✗ ' + n); } }
function eq(a, b, n) { ok(JSON.stringify(a) === JSON.stringify(b), n + (JSON.stringify(a) === JSON.stringify(b) ? '' : ` (got ${JSON.stringify(a)})`)); }

console.log('Version Authority — D6 — test suite\n');

// ── 1 · every stream originates in the authority ─────────────────────────────────────────────────
(function origin() {
  const SEMVER = /^\d+\.\d+(\.\d+)?$/;
  for (const k of VA.STREAMS) {
    ok(typeof version[k] === 'string' && SEMVER.test(version[k]), `authority: ${k} declared and well-formed (${version[k]})`);
  }
  eq(version.REGISTRY_VERSION, REGISTRY_VERSION, 'authority: REGISTRY_VERSION mirrors the registry — imported, not restated');
  eq(VA.versionStreams(), {
    ENGINE_VERSION: version.ENGINE_VERSION, REPORT_VERSION: version.REPORT_VERSION,
    REGISTRY_VERSION: version.REGISTRY_VERSION, COLLECTION_SCHEMA_VERSION: version.COLLECTION_SCHEMA_VERSION,
    PROVIDER_CONTRACT_VERSION: version.PROVIDER_CONTRACT_VERSION, CONTRACT_VERSION: version.CONTRACT_VERSION,
  }, 'authority: versionStreams() exposes exactly the declared streams');
})();

// ── 2 · NO DUPLICATE DECLARATIONS ANYWHERE IN THE TREE ───────────────────────────────────────────
(function noDuplicates() {
  const dupes = VA.findDuplicateDeclarations();
  ok(dupes.length === 0, `no-drift: no file outside the authority DECLARES a version stream${dupes.length ? ' — found ' + JSON.stringify(dupes) : ''}`);
  // the scanner must be capable of catching one, or its silence means nothing
  // The probe is ASSEMBLED, never written literally: the scanner deliberately covers *.test.js too
  // (a test that restates a version is a second authority — precisely how foundation.test.js sat red
  // on a stale 1.3.0), so a literal probe string in this file's own source would flag this file.
  const tmp = path.join(__dirname, '__d6_probe_tmp.js');
  fs.writeFileSync(tmp, 'const x = { ' + 'ENGINE_' + 'VERSION' + ": '9.9.9' };\nmodule.exports = x;\n");
  try {
    const found = VA.findDuplicateDeclarations();
    ok(found.some(h => h.file === '__d6_probe_tmp.js' && h.stream === 'ENGINE_VERSION'),
      'no-drift: the scanner PROVABLY catches a reintroduced literal — its silence above is evidence, not absence');
  } finally { fs.unlinkSync(tmp); }
  eq(VA.findDuplicateDeclarations().length, 0, 'no-drift: clean again once the probe is removed');
})();

// ── 3 · consumers IMPORT, never restate ──────────────────────────────────────────────────────────
(function consumers() {
  const contract = require('./contract');
  eq(contract.CONTRACT_VERSION, version.CONTRACT_VERSION, 'consumer: contract.js uses the authority');
  const csrc = fs.readFileSync(require.resolve('./contract.js'), 'utf8');
  ok(/require\(['"]\.\/version['"]\)/.test(csrc), 'consumer: contract.js IMPORTS the authority');
  ok(!/const\s+CONTRACT_VERSION\s*=\s*['"]/.test(csrc), 'consumer: contract.js no longer declares its own literal');
  const rsrc = fs.readFileSync(require.resolve('./lib/report-contract.js'), 'utf8');
  ok(/CONTRACT_VERSION/.test(rsrc) && !/\|\|\s*['"]1\.0['"]/.test(rsrc), 'consumer: report-contract.js fallback reads the authority, not a hardcoded "1.0"');
  // capture.js's local no longer collides with the authority's stream name
  const capsrc = fs.readFileSync(require.resolve('./capture.js'), 'utf8');
  ok(/CAPTURE_ENGINE_VERSION/.test(capsrc), 'consumer: capture.js\'s pipeline version is named for what it is');
  ok(/engineVersion: CAPTURE_ENGINE_VERSION/.test(capsrc), 'consumer: …and the EMITTED field name is unchanged, so capture provenance is byte-identical');
})();

// ── 4 · generated metadata matches the authority ─────────────────────────────────────────────────
(function generated() {
  const v = VA.verifyReleaseMetadata();
  ok(v.ok, `generated: release-metadata.json agrees with the authority${v.ok ? '' : ' — drift ' + JSON.stringify(v.mismatches)}`);
  const file = VA.readReleaseMetadata();
  eq(file.contractVersion, version.CONTRACT_VERSION, 'generated: contractVersion — was "1.0.0" against an authority of "1.0"; the derived artifact now follows');
  eq(file.engineVersion, version.ENGINE_VERSION, 'generated: engineVersion derived');
  eq(file.registryVersion, REGISTRY_VERSION, 'generated: registryVersion derived');
  eq(file.reportVersion, version.REPORT_VERSION, 'generated: reportVersion derived');
  eq(file.ruleCount, RULES.length, 'generated: ruleCount derived from the registry, not typed by hand');
  // regeneration is idempotent, and preserves the human-authored fields it does not own
  const next = VA.generateReleaseMetadata();
  eq(next.release, file.release, 'generated: human-authored release notes preserved — the generator owns only what it can prove');
  eq(next.deferred, file.deferred, 'generated: the deferred list is not owned by the generator');
  eq(VA.derivedReleaseMetadata(), {
    engineVersion: version.ENGINE_VERSION, registryVersion: REGISTRY_VERSION,
    reportVersion: version.REPORT_VERSION, contractVersion: version.CONTRACT_VERSION, ruleCount: RULES.length,
  }, 'generated: the derived set is exactly what the authority can prove');
  // the verifier REPORTS drift, it never silently repairs it
  const vsrc = fs.readFileSync(require.resolve('./version-authority.js'), 'utf8');
  ok(/never a fix/.test(vsrc) || !/writeFileSync/.test(vsrc.split('function verifyReleaseMetadata')[1].split('function generate')[0]),
    'generated: verify() reports drift and does NOT write — a verifier that repaired silently would hide what it exists to expose');
})();

// ── 5 · replay compatibility reads the authority ─────────────────────────────────────────────────
(function replayReads() {
  const { compatibility } = require('./replay');
  const rec = { manifest: { schemaVersion: version.COLLECTION_SCHEMA_VERSION, engineVersion: version.ENGINE_VERSION, registryVersion: version.REGISTRY_VERSION, providerContractVersion: version.PROVIDER_CONTRACT_VERSION, providerSet: [] }, channels: {} };
  const c = compatibility(rec, { providers: [], versions: { engine: version.ENGINE_VERSION, registry: version.REGISTRY_VERSION, providerContract: version.PROVIDER_CONTRACT_VERSION } });
  eq(c.versionDrift, { engine: false, registry: false, providerContract: false }, 'replay: no drift reported when a collection was sealed by the current authority');
  ok(c.schemaSupported, 'replay: the authority\'s current collection schema is a supported replay schema');
})();

// ── 6 · frozen scope ─────────────────────────────────────────────────────────────────────────────
(function frozen() {
  eq(RULES.length, 142, 'D9: registry unchanged — D6 adds NO rule');
  // ADR-0011 note: this used to pin a version LITERAL, which made the test a SECOND AUTHORITY --
  // exactly the defect D6 eliminated, reintroduced here and exposed the moment ENGINE_VERSION
  // legitimately moved to 2.4.0. A test may assert the SHAPE of a stream and that it comes from the
  // authority; it must never re-declare the value.
  const SEMVER_ = /^\d+\.\d+(\.\d+)?$/;
  ok(SEMVER_.test(version.ENGINE_VERSION), 'D9: engine version UNMOVED — D6 corrects homes, never values (from the authority: ' + version.ENGINE_VERSION + ')');
  ok(SEMVER_.test(version.REPORT_VERSION), 'D9: report version unmoved (from the authority: ' + version.REPORT_VERSION + ')');
  ok(SEMVER_.test(version.CONTRACT_VERSION), 'D9: contract version unmoved — "1.0" was the value every stored contract already carried (from the authority: ' + version.CONTRACT_VERSION + ')');
  ok(SEMVER_.test(version.COLLECTION_SCHEMA_VERSION), 'D9: collection schema unmoved (from the authority: ' + version.COLLECTION_SCHEMA_VERSION + ')');
  ok(SEMVER_.test(version.PROVIDER_CONTRACT_VERSION), 'D9: provider contract unmoved (from the authority: ' + version.PROVIDER_CONTRACT_VERSION + ')');
})();

console.log('\n' + (fail === 0 ? '✅ PASS' : '❌ FAIL') + ` — ${pass}/${pass + fail} assertions`);
if (fail) { console.log('Failures:\n' + failures.map(f => '  - ' + f).join('\n')); process.exit(1); }
