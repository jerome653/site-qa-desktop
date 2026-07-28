'use strict';
// release-gate.js — "A PASSING FILESYSTEM IS NOT A RELEASABLE ARTIFACT."
//
// THE DEFECT THIS EXISTS TO KILL, measured 2026-07-29. The working tree passed 52/52. The committed
// tree passed 48/52. ~1,005 lines of product work — report.js allRows(), visual-match.js diagnoseEmpty()
// and the background-restyle axis — existed ONLY in the working tree, while the tests asserting them
// were committed. Every green number in nine sessions of certification was TRUE of a tree that no clone
// could ever obtain.
//
// repo-integrity.test.js already asks git whether every require() RESOLVES to a tracked path. It passed
// throughout, correctly: a committed test asserting an uncommitted FEATURE resolves perfectly — the
// module exists, the function inside it does not. Resolution is not completeness. This gate closes that
// half: it compares what is SHIPPED against what is COMMITTED, and at release time it runs the suite
// from the committed artifact rather than from the directory you happen to be standing in.
//
// TWO TIERS, deliberately:
//   always (registered in run-all.js)  — structural invariants that must hold in a healthy repo at all
//                                        times, and that are cheap: version agreement, registered
//                                        suites tracked, no untracked runtime source.
//   SGEN_RELEASE_GATE=1                — the release-time tier: the checkout must be CLEAN, and the
//                                        full suite is extracted and run from committed state.
// A dirty tree is normal during development and is only fatal when you are cutting a release.
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0; const failures = [];
function ok(c, n) { if (c) pass++; else { fail++; failures.push(n); console.log('  ✗ ' + n); } }
function eq(a, b, n) { const g = JSON.stringify(a), w = JSON.stringify(b); ok(g === w, n + (g === w ? '' : ` (got ${g}, want ${w})`)); }

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const RELEASE_TIER = process.env.SGEN_RELEASE_GATE === '1';
const git = (args, opts) => cp.execSync('git ' + args, Object.assign({ cwd: REPO, maxBuffer: 1 << 28 }, opts)).toString();

console.log('Release gate — the shipped application must equal the certified git artifact — test suite\n');
console.log('  tier: ' + (RELEASE_TIER ? 'RELEASE (SGEN_RELEASE_GATE=1) — clean checkout required, suite re-run from committed state'
  : 'STRUCTURAL (set SGEN_RELEASE_GATE=1 for the full release tier)') + '\n');

// ── 1 · NO UNTRACKED RUNTIME SOURCE ───────────────────────────────────────────────────────────────
// The first instance of this programme's blocker: deadline.js and visual-match/grade.js were required
// by committed code and had never been committed in any branch. The second instance: four test files
// with 0 commits in the entire history. An untracked .js under engine/ is not "work in progress" as far
// as a release is concerned — it is a file the customer will never receive.
const untracked = git('ls-files --others --exclude-standard')
  .split('\n').filter(Boolean)
  .filter(f => f.startsWith('engine/') && f.endsWith('.js') && !f.includes('node_modules/'));
ok(untracked.length === 0,
  `provenance: no untracked .js under engine/ — every runtime source and suite is in git${untracked.length ? '\n      ' + untracked.join('\n      ') : ''}`);

// ── 2 · EVERY REGISTERED SUITE EXISTS IN THE COMMITTED TREE ───────────────────────────────────────
// run-all.js exits non-zero on a missing suite, so a suite that is registered but not committed breaks
// the gate for every clone but never for the author.
(function suitesCommitted() {
  const tracked = new Set(git('ls-tree -r --name-only HEAD').split('\n').filter(Boolean));
  const runAll = git('show HEAD:engine/lib/site-qa/testing/run-all.js');
  const suites = [...runAll.matchAll(/^\s*'([^']+\.js)',/gm)].map(m => m[1]);
  ok(suites.length > 20, `run-all: ${suites.length} suites registered`);
  const missing = suites.filter(s => !tracked.has(s.startsWith('../') ? 'engine/lib/' + s.slice(3) : 'engine/lib/site-qa/' + s));
  ok(missing.length === 0, `provenance: every suite run-all.js registers is COMMITTED${missing.length ? ' — ABSENT: ' + missing.join(', ') : ''}`);
})();

// ── 3 · VERSION CONSISTENCY ACROSS THE PACKAGE AND THE AUTHORITY ──────────────────────────────────
// version.js is the single authority for the ENGINE schema streams; engine/package.json carries the
// npm/app stream. release-metadata.json is DERIVED from both and is what the update feed publishes, so
// a disagreement between them ships a lie about what the customer is running. This is not a bump — it
// asserts that the numbers already chosen agree with each other.
(function versions() {
  const V = require('../version.js');
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'engine', 'package.json'), 'utf8'));
  const meta = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'release-metadata.json'), 'utf8'));
  eq(meta.engineVersion, V.ENGINE_VERSION, 'version: release-metadata engineVersion agrees with version.js');
  eq(meta.reportVersion, V.REPORT_VERSION, 'version: release-metadata reportVersion agrees with version.js');
  eq(meta.registryVersion, V.REGISTRY_VERSION, 'version: release-metadata registryVersion agrees with the registry');
  eq(meta.packageVersion, pkg.version, 'version: release-metadata packageVersion agrees with engine/package.json — the committed tree once said 4.2.0 while the metadata said 4.5.0');
  // No SECOND authority may restate the package version. sgen-qa-serve.js carried a hand-maintained
  // '3.1.0' fallback bearing the instruction "BUMP IT EVERY RELEASE — it has already gone stale twice";
  // it had by then gone stale a third time. It is now derived. Assert no literal creeps back in.
  const serve = fs.readFileSync(path.join(REPO, 'engine', 'sgen-qa-serve.js'), 'utf8');
  const at = serve.indexOf('const SELF_VER');
  const decl = at === -1 ? '' : serve.slice(at, at + 400);   // fixed window — a lazy /;\n/ is CRLF-blind
  ok(at !== -1 && !/\|\|\s*\[\s*'\d+\.\d+\.\d+'\s*\]/.test(decl) && /package\.json/.test(decl),
    'version: SELF_VER derives its fallback from package.json — no restated version literal, no second authority to keep in sync');
})();

// ── 4 · RELEASE TIER ──────────────────────────────────────────────────────────────────────────────
if (!RELEASE_TIER) {
  console.log('\n  · release tier skipped — clean-checkout and committed-state suite run only under SGEN_RELEASE_GATE=1');
} else {
  // 4a · the checkout must be CLEAN. git diff already normalises line endings under core.autocrlf, so a
  // CRLF-only difference (engine/lib/manual.html was one) correctly does not count as dirty.
  const dirty = git('diff --name-only HEAD').split('\n').filter(Boolean);
  ok(dirty.length === 0, `release: the checkout is CLEAN — nothing shipped exists only on this disk${dirty.length ? '\n      ' + dirty.join('\n      ') : ''}`);

  // 4b · extract the committed artifact and run the suite THERE. This is the whole point: the numbers
  // that certify a release must come from the tree a customer can obtain, not from this directory.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sgen-release-'));
  const head = git('rev-parse --short HEAD').trim();
  try {
    cp.execSync(`git archive HEAD | tar -x -C ${JSON.stringify(tmp)}`, { cwd: REPO, maxBuffer: 1 << 28, shell: 'bash' });
    const env = Object.assign({}, process.env, { NODE_PATH: path.join(REPO, 'engine', 'node_modules') });
    delete env.SGEN_RELEASE_GATE;   // the child must not recurse into this tier
    const out = cp.execSync('node testing/run-all.js', {
      cwd: path.join(tmp, 'engine', 'lib', 'site-qa'), env, maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'],
    }).toString();
    const m = out.match(/ALL SUITES PASS — (\d+)\/(\d+)/);
    ok(!!m, `release: the suite passes from the COMMITTED artifact ${head}${m ? ` (${m[1]}/${m[2]})` : '\n' + out.split('\n').filter(l => l.includes('✗')).map(l => '      ' + l.trim()).join('\n')}`);
  } catch (e) {
    const out = ((e.stdout && e.stdout.toString()) || '') + ((e.stderr && e.stderr.toString()) || '');
    ok(false, `release: the suite passes from the COMMITTED artifact ${head}\n`
      + out.split('\n').filter(l => l.includes('✗') || l.includes('SUITE FAILURE')).map(l => '      ' + l.trim()).join('\n'));
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
}

console.log('\n' + (fail === 0 ? '✅ PASS' : '❌ FAIL') + ` — ${pass}/${pass + fail} assertions`);
if (fail) { console.log('Failures:\n' + failures.map(f => '  - ' + f).join('\n')); process.exit(1); }
