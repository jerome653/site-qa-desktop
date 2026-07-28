'use strict';
// version-authority.js — D6 (ADR-0004 §D6). The derivation layer above `version.js`.
//
// `version.js` DECLARES the streams. This module DERIVES everything else from them, so no artifact
// ever restates a version. It is deliberately separate from version.js so the authority itself stays a
// plain, dependency-light constant file that anything can require without pulling in derivation logic.
//
// The invariant, in one line:
//
//     The platform SHALL expose one authoritative source for all version streams used in manifests and
//     replay compatibility. All derived metadata SHALL be generated from that authority.
//
// Why this is worth a module rather than a convention: replay is unforgiving of metadata drift. A
// replay that fails because two files disagree about a version is indistinguishable from one that
// fails because the collection genuinely is incompatible — so the second kind of failure becomes
// unreadable the moment the first kind is possible.

const fs = require('fs');
const path = require('path');
const version = require('./version');
const { RULES, REGISTRY_VERSION } = require('./rules/registry');

// The streams the authority owns. Anything outside version.js that states one of these is drift.
const STREAMS = [
  'ENGINE_VERSION', 'REPORT_VERSION', 'REGISTRY_VERSION',
  'COLLECTION_SCHEMA_VERSION', 'PROVIDER_CONTRACT_VERSION', 'CONTRACT_VERSION',
];

function versionStreams() {
  const out = {};
  for (const k of STREAMS) out[k] = version[k];
  return out;
}

// The version-derived fields of release-metadata.json. Deliberately NOT the whole file: that file also
// carries human-authored release notes and a deferred list, which no generator should own. This
// returns only what the authority can prove, and `verifyReleaseMetadata` checks exactly those keys.
function derivedReleaseMetadata() {
  return {
    engineVersion: version.ENGINE_VERSION,
    registryVersion: REGISTRY_VERSION,
    reportVersion: version.REPORT_VERSION,
    contractVersion: version.CONTRACT_VERSION,
    ruleCount: RULES.length,
  };
}

const RELEASE_METADATA_PATH = path.join(__dirname, 'release-metadata.json');

function readReleaseMetadata(file = RELEASE_METADATA_PATH) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// verifyReleaseMetadata — does the derived artifact agree with the authority?
// Returns FACTS (per-key expected/actual), never a fix. Regenerating is a deliberate act by a human or
// a build step; a verifier that silently rewrote the file would hide the drift it exists to expose.
function verifyReleaseMetadata(file = RELEASE_METADATA_PATH) {
  const actual = readReleaseMetadata(file);
  const expected = derivedReleaseMetadata();
  const mismatches = [];
  for (const [k, v] of Object.entries(expected)) {
    if (actual[k] !== v) mismatches.push({ key: k, expected: v, actual: actual[k] === undefined ? null : actual[k] });
  }
  return { ok: mismatches.length === 0, mismatches, expected, actual };
}

// generateReleaseMetadata — merge the authority's fields over the human-authored file. Pure: returns
// the object, writes nothing unless a caller asks.
function generateReleaseMetadata(file = RELEASE_METADATA_PATH) {
  return Object.assign({}, readReleaseMetadata(file), derivedReleaseMetadata());
}
function writeReleaseMetadata(file = RELEASE_METADATA_PATH) {
  const next = generateReleaseMetadata(file);
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n');
  return next;
}

// ── DRIFT DETECTION ──────────────────────────────────────────────────────────────────────────────
// Scans the source tree for any file OTHER than version.js that DECLARES one of the authority's
// streams. Deliberately matches declarations (`X = '…'`, `X: '…'`), not usages — importing a stream is
// the correct behaviour and must never be flagged. This is what makes "one authority" enforceable
// instead of aspirational: a future edit that reintroduces a literal fails the suite.
const SKIP_DIRS = new Set(['node_modules', '_ui-runs', '_records', '_auditor-data', '_baselines', '.git']);
function findDuplicateDeclarations(root = __dirname) {
  const re = new RegExp('(?:^|[^.\\w])(' + STREAMS.join('|') + ')\\s*[:=]\\s*[\'"]', 'g');
  const hits = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (SKIP_DIRS.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith('.js')) continue;
      if (p === path.join(root, 'version.js')) continue;               // the authority itself
      // The registry OWNS its own version and version.js imports it -- that is the established
      // single-declaration pattern D6 generalises, not a violation of it.
      if (p === path.join(root, 'rules', 'registry.js')) continue;
      if (p === __filename) continue;                                   // this file names the streams
      const src = fs.readFileSync(p, 'utf8').replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      let m; re.lastIndex = 0;
      while ((m = re.exec(src))) hits.push({ file: path.relative(root, p).replace(/\\/g, '/'), stream: m[1] });
    }
  })(root);
  return hits;
}

module.exports = {
  STREAMS, versionStreams, derivedReleaseMetadata,
  readReleaseMetadata, verifyReleaseMetadata, generateReleaseMetadata, writeReleaseMetadata,
  findDuplicateDeclarations, RELEASE_METADATA_PATH,
};
