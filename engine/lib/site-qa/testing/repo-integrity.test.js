'use strict';
// repo-integrity.test.js — THE REPOSITORY INTEGRITY GATE.
//
// Every other suite in this repository runs against the WORKING TREE. This one runs against what is
// COMMITTED, because those are not the same thing and the difference shipped a release blocker.
//
// THE DEFECT THIS EXISTS TO KILL, measured 2026-07-29:
//   `engine/lib/site-qa/deadline.js` and `engine/lib/site-qa/visual-match/grade.js` were UNTRACKED —
//   never committed, in any branch, in the entire history — while COMMITTED files required them:
//       engine/sgen-qa-serve.js:36   require('./lib/site-qa/visual-match/grade')   ← the app entrypoint
//       engine/lib/site-qa/capture.js:19   require('./deadline')
//   A fresh clone of main, adr-0010 or adr-0011 could not load the application. The require sits at
//   module scope, so it fails before the server starts.
//
//   Nine sessions of increasingly rigorous verification never caught it. 51/51 suites, 97.9% coverage
//   and every golden were all TRUE — and all measured against a tree that had never been committed.
//   Five suites listed in run-all.js were absent from the commit too, so a fresh clone's gate would
//   have reported `✗ MISSING` five times and exited non-zero.
//
// SO THIS GATE ASKS GIT, NEVER THE FILESYSTEM. `git ls-files` for what is tracked, `git show` for
// content. `fs.existsSync` is exactly the question that produced the false confidence.
const cp = require('child_process');
const path = require('path');

let pass = 0, fail = 0; const failures = [];
function ok(c, n) { if (c) pass++; else { fail++; failures.push(n); console.log('  ✗ ' + n); } }
function eq(a, b, n) { ok(JSON.stringify(a) === JSON.stringify(b), n + (JSON.stringify(a) === JSON.stringify(b) ? '' : ` (got ${JSON.stringify(a)})`)); }

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const REF = process.env.SGEN_INTEGRITY_REF || 'HEAD';
const git = (args) => cp.execSync('git ' + args, { cwd: REPO, maxBuffer: 1 << 28 }).toString();

// Files that are legitimately absent from git and must NOT be flagged. Empty today, and deliberately
// EXPLICIT: an exclusion has to be written down and justified, never inferred from a build step.
const GENERATED_OR_EXCLUDED = new Set([]);

// Strip comments AND string/template literals before looking for require(). A doc-header example like
//     //   const { runBestPractices } = require('./best-practices');
// is not a runtime dependency — three of those cost a detour during the original investigation. The
// client dashboard inside sgen-qa-serve.js is one enormous template literal, so those must go too.
function stripNonCode(src) {
  let out = '', i = 0, n = src.length;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; i++;
      while (i < n && src[i] !== q) { if (src[i] === '\\') i++; i++; }
      i++; out += '""'; continue;   // placeholder keeps token boundaries intact
    }
    out += c; i++;
  }
  return out;
}
// require('…') survives stripNonCode only if we capture the specifier first — so match on the ORIGINAL
// source, then confirm the same offset is code (not comment/string) using the stripped map.
function relativeRequires(src) {
  const specs = [];
  const code = stripNonCode(src);
  // In `code`, every literal is now `""`. Find require("") occurrences and map back by counting order.
  const codeHits = [...code.matchAll(/\brequire\(\s*""\s*\)/g)].length;
  const all = [...src.matchAll(/\brequire\(\s*['"`]([^'"`]+)['"`]\s*\)/g)];
  // Walk the original, tracking whether each hit's index is inside code, by re-scanning with the same
  // state machine and recording code-region offsets.
  const codeMask = new Uint8Array(src.length);
  {
    let i = 0; const n = src.length;
    while (i < n) {
      const c = src[i], d = src[i + 1];
      if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }
      if (c === '/' && d === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
      if (c === '"' || c === "'" || c === '`') { const q = c; i++; while (i < n && src[i] !== q) { if (src[i] === '\\') i++; i++; } i++; continue; }
      codeMask[i] = 1; i++;
    }
  }
  for (const m of all) if (codeMask[m.index]) specs.push({ spec: m[1], index: m.index });
  return { specs, codeHits };
}

console.log('Repository integrity — committed-tree dependency gate — test suite\n');

// ── 1 · the gate reads GIT, not the filesystem ────────────────────────────────────────────────────
const tracked = new Set(git(`ls-tree -r --name-only ${JSON.stringify(REF)}`).split('\n').filter(Boolean));
ok(tracked.size > 100, `git: ${tracked.size} paths tracked at ${REF}`);
const src = require('fs').readFileSync(__filename, 'utf8');
ok(!/fs\.existsSync/.test(src.replace(/^\s*\/\/.*$/gm, '')), 'gate: this suite never asks the FILESYSTEM whether a file exists — that question is what produced the false confidence');

// ── 2 · EVERY relative runtime require resolves to a TRACKED path ─────────────────────────────────
const jsFiles = [...tracked].filter(f => f.startsWith('engine/') && f.endsWith('.js') && !f.includes('node_modules/'));
let checked = 0, falsePositives = 0;
const unresolved = [], dynamic = [];
for (const f of jsFiles) {
  let content;
  try { content = git(`show ${JSON.stringify(REF + ':' + f)}`); } catch (_) { continue; }
  const { specs } = relativeRequires(content);
  const allSpecs = [...content.matchAll(/\brequire\(\s*['"`](\.[^'"`]+)['"`]\s*\)/g)].length;
  falsePositives += Math.max(0, allSpecs - specs.filter(s => s.spec.startsWith('.')).length);
  for (const { spec } of specs) {
    if (!spec.startsWith('.')) continue;                 // package deps are npm's problem, not git's
    // A DYNAMIC specifier — require(`../${s}/digest`) — cannot be resolved statically. Counted and
    // reported rather than silently skipped: "we could not check this" is a different fact from
    // "this is fine", and collapsing the two is the mistake this whole gate exists to prevent.
    if (spec.includes('${')) { dynamic.push({ from: f, spec }); continue; }
    checked++;
    const base = path.posix.join(path.posix.dirname(f), spec);
    if (GENERATED_OR_EXCLUDED.has(base)) continue;
    const cands = [base, base + '.js', base + '.json', base + '/index.js'];
    if (!cands.some(c => tracked.has(c))) unresolved.push({ from: f, spec, resolved: base });
  }
}
console.log(`  · ${jsFiles.length} tracked engine .js files · ${checked} static relative requires · ${dynamic.length} dynamic (unresolvable by design) · ${falsePositives} comment/string false positive(s) eliminated`);
for (const d of dynamic) console.log(`    dynamic: ${d.from} -> ${d.spec}  (reported, not silently skipped)`);
ok(unresolved.length === 0,
  `INTEGRITY: every relative runtime require resolves to a TRACKED path${unresolved.length ? '\n      ' + unresolved.map(u => `${u.from} -> ${u.spec} (missing ${u.resolved}.js)`).join('\n      ') : ''}`);

// ── 3 · the comment/string stripper provably works ────────────────────────────────────────────────
// Its silence above means nothing unless it can be shown to discriminate. These are the exact shapes
// that produced three false positives in the original investigation.
(function stripper() {
  const probe = [
    "// const x = require('./doc-example');",
    "/* const y = require('./block-example'); */",
    "const tpl = `stuff require('./inside-template') more`;",
    "const real = require('./genuinely-required');",
  ].join('\n');
  const { specs } = relativeRequires(probe);
  eq(specs.map(s => s.spec), ['./genuinely-required'],
    'stripper: line comments, block comments and template literals are all excluded; only the real require survives');
})();

// ── 4 · every suite the gate runs is itself TRACKED ───────────────────────────────────────────────
// run-all.js exits non-zero on a missing suite, so an untracked suite breaks a fresh clone's gate.
(function suitesTracked() {
  const runAll = git(`show ${JSON.stringify(REF + ':engine/lib/site-qa/testing/run-all.js')}`);
  const listed = [...stripNonCode(runAll).matchAll(/""/g)].length ? null : null; // (literals stripped; parse the raw list below)
  const suites = [...runAll.matchAll(/^\s*'([^']+\.js)',/gm)].map(m => m[1]);
  ok(suites.length > 20, `run-all: ${suites.length} suites registered`);
  const missing = [];
  for (const s of suites) {
    const p = s.startsWith('../') ? 'engine/lib/' + s.slice(3) : 'engine/lib/site-qa/' + s;
    if (!tracked.has(p)) missing.push(s);
  }
  ok(missing.length === 0, `INTEGRITY: every suite run-all.js registers is TRACKED${missing.length ? ' — ABSENT: ' + missing.join(', ') : ''}`);
})();

// ── 5 · the two files this gate was written for ───────────────────────────────────────────────────
for (const f of ['engine/lib/site-qa/deadline.js', 'engine/lib/site-qa/visual-match/grade.js']) {
  ok(tracked.has(f), `regression: ${f} is tracked — the original release blocker cannot recur silently`);
}

// ── 6 · exclusions are explicit ───────────────────────────────────────────────────────────────────
ok(GENERATED_OR_EXCLUDED.size === 0 || [...GENERATED_OR_EXCLUDED].every(x => typeof x === 'string'),
  'exclusions: the generated/excluded set is an explicit list, never inferred');

console.log('\n' + (fail === 0 ? '✅ PASS' : '❌ FAIL') + ` — ${pass}/${pass + fail} assertions`);
if (fail) { console.log('Failures:\n' + failures.map(f => '  - ' + f).join('\n')); process.exit(1); }
