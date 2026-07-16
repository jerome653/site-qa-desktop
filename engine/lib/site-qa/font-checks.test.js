'use strict';
// font-checks.test.js — deterministic suite for FONT-001..006 / ICON-001..003 (registry 1.11.0).
//
// Sweep fixtures are built as plain objects, matching this repo's no-browser test convention
// (content-artifacts.test.js builds its mojibake from char codes). That is deliberate: classify() is
// PURE — it takes the raw facts the in-page sweep collected and decides findings — so every rule is
// provable here without Chromium. The browser half (FONT_SWEEP running against 10 real broken HTML
// fixtures in the engine's own Chromium, 17/17) lives at docs/sgen-site-qa/font-checker/, outside the
// shipped engine, because the engine has no HTML-fixture convention to hang it on.
//
// Also locks the WIRING: a font check that is missing from audit.js's RENDER_SUITE is silently
// dropped from the audit (the fold iterates that map's keys), which would ship a check that can
// never fire. That failure mode is asserted against here, not assumed.
const REG = require('./rules/registry');
const { classify, drift, GENERIC } = require('./font-checks');
const { FONT_RULE } = require('../migration-qa/checks-render');
const { RENDER_SUITE } = require('./audit');

let pass = 0, fail = 0; const failures = [];
function ok(c, n) { if (c) pass++; else { fail++; failures.push(n); console.log('  ✗ ' + n); } }
function eq(a, b, n) { ok(JSON.stringify(a) === JSON.stringify(b), n + (JSON.stringify(a) === JSON.stringify(b) ? '' : ` (got ${JSON.stringify(a)})`)); }

// sweep builder — every field the real FONT_SWEEP returns, so fixtures can't drift from the contract
const sweep = (o = {}) => ({ faces: [], used: {}, samples: {}, icons: [], preloads: [], setStatus: 'loaded', ...o });
const face = (o = {}) => ({ family: 'Inter', status: 'loaded', weight: '400', style: 'normal', display: 'swap', unicodeRange: '', ...o });
const sample = (o = {}) => ({ selector: 'p', text: 'Hello', size: '16px', weight: '400', style: 'normal', hasBefore: false, beforeContent: '', w: 100, h: 20, ...o });
const icon = (o = {}) => ({ selector: 'i.icon', family: 'Material Icons', cls: 'material-icons', text: '', isWord: false, pua: false, loaded: false, w: 24, h: 24, ...o });
const checks = (s, actual) => classify(s, actual || {}).map(f => f.check);
const find = (s, check) => classify(s, {}).find(f => f.check === check);

console.log('FONT-001..006 / ICON-001..003 — font + icon integrity — test suite\n');

// ── 1 · registry integration ──
(function registry() {
  const want = {
    'FONT-001': ['a11y', 12], 'FONT-002': ['a11y', 6], 'FONT-003': ['a11y', 2],
    'FONT-004': ['performance', 3], 'FONT-005': ['performance', 2], 'FONT-006': ['a11y', 2],
    'ICON-001': ['functional', 10], 'ICON-002': ['functional', 10], 'ICON-003': ['functional', 8],
  };
  for (const [id, [suite, ded]] of Object.entries(want)) {
    const r = REG.getById(id);
    ok(!!r, `registry: ${id} exists`);
    if (!r) continue;
    eq(r.suite, suite, `registry: ${id} in ${suite} suite`);
    eq(r.deduction, ded, `registry: ${id} deducts ${ded}`);
    eq(r.method, 'render', `registry: ${id} is a render check`);
    ok(!r.manual && r.deterministic, `registry: ${id} is deterministic + scored`);
    ok([1, 2, 3].includes(r.tier), `registry: ${id} carries a launch tier`);
  }
  eq(REG.SUITES.reduce((a, s) => a + (REG.WEIGHTS[s] || 0), 0), 100, 'registry: weights still total 100');
  eq(REG.REGISTRY_VERSION, '1.13.0', 'registry: version bumped to 1.13.0');

  // VIS-003 (1.12.0) — drift()'s registry identity. It lives in the COMPARISON suite, not beside
  // FONT-001..006 in a11y: a font that changed vs the reference is not a defect in the candidate.
  const v3 = REG.getById('VIS-003');
  ok(!!v3, 'registry: VIS-003 exists');
  eq(v3.suite, 'visual', 'registry: VIS-003 is a comparison-lane rule (visual suite), not an a11y defect');
  eq(REG.WEIGHTS.visual, 0, 'registry: VIS-003 is advisory — visual suite carries weight 0, so it cannot move the overall score');
  eq(v3.method, 'render', 'registry: VIS-003 is a render check');
  ok(!v3.manual && v3.deterministic, 'registry: VIS-003 is deterministic + scored within its advisory suite');
})();

// ── 2 · wiring — check → rule → suite, end to end ──
(function wiring() {
  eq(Object.keys(FONT_RULE).length, 9, 'wiring: 9 font/icon checks mapped to rules');
  for (const [check, ruleId] of Object.entries(FONT_RULE)) {
    const rule = REG.getById(ruleId);
    ok(!!rule, `wiring: ${check} → ${ruleId} is a real registry rule`);
    // the fold in audit.js iterates RENDER_SUITE's keys — absent here = silently dropped from the audit
    ok(!!RENDER_SUITE[check], `wiring: ${check} is in audit RENDER_SUITE (else dropped from the audit)`);
    if (rule && RENDER_SUITE[check]) eq(RENDER_SUITE[check], rule.suite, `wiring: ${check} folds into its registry suite (${rule.suite})`);
  }
})();

// ── 3 · every rule fires on the failure it exists for ──
(function fires() {
  // FONT-001 — a declared face errored and elements ask for it
  const dead = sweep({ faces: [face({ family: 'GhostFont', status: 'error' })], used: { GhostFont: 3 }, samples: { GhostFont: sample({ selector: 'h1' }) } });
  ok(checks(dead).includes('font-not-loaded'), 'FONT-001: errored @font-face that the page uses fires');
  eq(find(dead, 'font-not-loaded').severity, 'high', 'FONT-001: used → high');
  eq(find(dead, 'font-not-loaded').family, 'GhostFont', 'FONT-001: names the right family');

  // FONT-002 — used, never declared
  const undecl = sweep({ used: { 'Brandon Grotesque': 2 }, samples: { 'Brandon Grotesque': sample({ selector: 'h2' }) } });
  ok(checks(undecl).includes('font-undeclared'), 'FONT-002: used-but-never-declared family fires');

  // FONT-003 — wants 700, only a 400 face loaded
  const faux = sweep({ faces: [face({ family: 'Inter', weight: '400' })], used: { Inter: 1 }, samples: { Inter: sample({ selector: 'h1.title', weight: '700' }) } });
  ok(checks(faux).includes('synthetic-bold'), 'FONT-003: faux bold (700 requested, 400 declared) fires');

  // FONT-004 — font-display defaults to auto
  const foit = sweep({ faces: [face({ family: 'Inter', display: 'auto' })], used: { Inter: 1 }, samples: { Inter: sample() } });
  ok(checks(foit).includes('font-display-missing'), 'FONT-004: font-display:auto fires');

  // FONT-005 — preloaded, nothing renders it
  const pre = sweep({ preloads: [{ href: '/fonts/ghost.woff2', family: null, usedFamily: false }] });
  ok(checks(pre).includes('font-preloaded-unused'), 'FONT-005: preloaded-but-unused font fires');

  // FONT-006 — italic requested, only an upright face loaded
  const ital = sweep({ faces: [face({ family: 'Merriweather', style: 'normal' })], used: { Merriweather: 1 }, samples: { Merriweather: sample({ selector: 'em', style: 'italic' }) } });
  ok(checks(ital).includes('synthetic-italic'), 'FONT-006: faux italic (no italic face) fires');
  ok(!checks(ital).includes('synthetic-bold'), 'FONT-006: faux italic is NOT double-reported as faux bold');

  // ICON-001 / ICON-002 / ICON-003
  const iconDead = sweep({ icons: [icon({ family: 'Font Awesome 6 Free', loaded: false })] });
  ok(checks(iconDead).includes('icon-font-not-loaded'), 'ICON-001: unloaded icon font fires');
  const lig = sweep({ icons: [icon({ family: 'Material Icons', loaded: false, isWord: true, text: 'home' })] });
  ok(checks(lig).includes('icon-ligature-visible'), 'ICON-002: ligature name showing as a word fires');
  ok(find(lig, 'icon-ligature-visible').value.includes('home'), 'ICON-002: quotes the word a visitor actually reads');
  const tofu = sweep({ icons: [icon({ family: 'Glyphicons Halflings', loaded: false, pua: true })] });
  ok(checks(tofu).includes('icon-tofu'), 'ICON-003: PUA codepoint with no font fires');
})();

// ── 4 · clean pages stay silent (a false blocker destroys trust in every other finding) ──
(function clean() {
  const good = sweep({
    faces: [face({ family: 'Inter', weight: '400', display: 'swap' }), face({ family: 'Inter', weight: '700', display: 'swap' })],
    used: { Inter: 5, 'sans-serif': 2 },
    samples: { Inter: sample({ weight: '700', selector: 'h1' }), 'sans-serif': sample({ selector: 'small' }) },
  });
  eq(classify(good, {}), [], 'clean: loaded font, real 700 face, generic fallback → NOTHING');

  // a system-font-only page declares no @font-face and must not be nagged
  eq(classify(sweep({ used: { Georgia: 3, 'system-ui': 1 }, samples: { Georgia: sample(), 'system-ui': sample() } }), []), [], 'clean: system fonts are not "undeclared"');
  ok(GENERIC.test('Georgia') && GENERIC.test('sans-serif') && !GENERIC.test('Brandon Grotesque'), 'clean: GENERIC matches system stacks, not brand fonts');

  // a variable font declaring a 100..900 range covers 700 — must not report faux bold
  const varFont = sweep({ faces: [face({ family: 'Inter var', weight: '100 900' })], used: { 'Inter var': 1 }, samples: { 'Inter var': sample({ weight: '700' }) } });
  ok(!checks(varFont).includes('synthetic-bold'), 'clean: variable font covering 100–900 is not faux bold');

  // preload that IS used costs nothing to flag → must stay silent
  ok(!checks(sweep({ preloads: [{ href: '/f/inter.woff2', family: 'Inter', usedFamily: true }] })).includes('font-preloaded-unused'), 'clean: a preload that is actually used stays silent');

  // an errored face nothing uses is a real but LOW finding, never a high one
  const unused = sweep({ faces: [face({ family: 'GhostFont', status: 'error' })], used: {}, samples: {} });
  eq(find(unused, 'font-not-loaded').severity, 'low', 'clean: dead-but-unused webfont downgrades to low');
})();

// ── 5 · CDP oracle evidence + drift + determinism ──
(function evidence() {
  const dead = sweep({ faces: [face({ family: 'GhostFont', status: 'error' })], used: { GhostFont: 1 }, samples: { GhostFont: sample({ selector: 'h1' }) } });
  const withActual = classify(dead, { h1: [{ family: 'Times New Roman', ps: 'TimesNewRomanPSMT', custom: false, glyphs: 100 }] });
  eq(withActual[0].actual, 'Times New Roman', 'evidence: the ACTUAL painted font is attached (inference → proof)');
  ok(classify(dead, {})[0].actual === null, 'evidence: no CDP → actual is null, finding still stands');

  const ref = sweep({ used: { 'Brand Sans': 4 }, samples: { 'Brand Sans': sample({ selector: 'h1' }) } });
  const cand = sweep({ used: { Arial: 4 }, samples: { Arial: sample({ selector: 'h1' }) } });
  ok(drift(ref, cand).some(d => d.check === 'font-drift'), 'drift: reference font missing on the candidate fires');
  eq(drift(ref, ref), [], 'drift: identical sites drift nothing');

  eq(classify(dead, {}), classify(dead, {}), 'determinism: same sweep → identical findings');
})();

// ── 6 · drift WIRING — the half that was missing ──
// Everything in §5 passed for two releases (3.0.0, 3.0.1) while drift() was DEAD CODE: nothing called
// it, and the settings UI advertised "font drift vs reference" the whole time. Testing a pure function
// proves the function; it does not prove the product does anything with it. These assertions walk the
// path drift() actually travels — engine → registry identity → fold → suite row — so the export cannot
// go dark again without a red test.
(function wiringDrift() {
  const vm = require('./visual-match');
  const { foldVisual } = require('./visual-match/fold');

  // engine side: run() is what calls drift(). It cannot execute here (needs a browser + two live
  // sites — that half is proven by a real run), but the collaborators it must hold are assertable.
  ok(typeof vm.run === 'function' && typeof vm.readAndShoot === 'function', 'drift-wiring: visual-match exposes the comparison entry points');
  // The 3.0.1 diagnosis was literally `grep -rE '\bdrift\(' visual-match.js` returning nothing. That
  // grep is the regression lock — but ONLY with comments stripped and only in CALL position. Both
  // qualifiers are load-bearing and neither is hypothetical: the first draft of this assertion matched
  // the word "drift()" inside the explanatory comment three lines above the call, so it passed with the
  // call deleted. A test that cannot fail is worse than no test — it is a green light wired to nothing.
  // The behavioural half (run() really emitting fontDrift from two live pages) needs a browser and two
  // sites, so it lives in the real comparison run, not here.
  const vmSrc = require('fs').readFileSync(require.resolve('./visual-match'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok(/=\s*drift\(/.test(vmSrc), 'drift-wiring: visual-match.js CALLS drift() in code, not just in a comment (the grep that was empty in 3.0.1)');
  ok(/fontSweep/.test(vmSrc) && /FONT_SWEEP/.test(vmSrc), 'drift-wiring: visual-match.js runs the FONT_SWEEP that feeds drift()');

  // identity: the registry maps by TITLE, and drift() bakes its own title into every finding. If those
  // two strings ever part company the finding silently loses its rule.
  const d = drift(sweep({ used: { 'Brand Sans': 4 }, samples: { 'Brand Sans': sample({ selector: 'h1' }) } }),
                  sweep({ used: { Arial: 4 }, samples: { Arial: sample({ selector: 'h1' }) } }))[0];
  eq(d.check, REG.getById('VIS-003').slug, 'drift-wiring: drift()\'s check name IS the VIS-003 slug');
  eq(d.title, REG.getById('VIS-003').title, 'drift-wiring: drift()\'s title matches the registry title verbatim (the engine maps by it)');

  // fold side: a page-level fontDrift array must surface as a VIS-003 row carrying real items.
  const folded = foldVisual({ pairs: 1, pages: [{ path: '/', fontDrift: [d], fontDriftAt: '1920 · Desktop', viewports: [] }] });
  const row = folded.checks.find(c => c.ruleId === 'VIS-003');
  ok(!!row, 'drift-wiring: foldVisual emits a VIS-003 row');
  ok(row.status !== 'pass' && row.items && row.items.length === 1, 'drift-wiring: the drifted font surfaces as a real VIS-003 finding, not a pass');
  ok(row.items[0].section.includes('Brand Sans'), 'drift-wiring: the VIS-003 item names the drifted family');
  eq(folded.summary.fontDrift, 1, 'drift-wiring: the fold summary counts the drift');

  // and a clean pair stays a pass — VIS-003 must not become a rule that always fires
  const clean = foldVisual({ pairs: 1, pages: [{ path: '/', fontDrift: [], viewports: [] }] });
  eq(clean.checks.find(c => c.ruleId === 'VIS-003').status, 'pass', 'drift-wiring: no drift → VIS-003 passes');

  // page-level, not viewport-level: one drifted family on a 13-viewport page = ONE item, not 13.
  const many = foldVisual({ pairs: 1, viewports: new Array(13).fill('vp'),
    pages: [{ path: '/', fontDrift: [d], viewports: new Array(13).fill({ label: 'vp', pixelMismatchPct: 0, matchScore: 100, struct: {} }) }] });
  eq(many.checks.find(c => c.ruleId === 'VIS-003').items.length, 1, 'drift-wiring: font drift is emitted ONCE per page, not once per viewport');
})();

console.log('\n' + (fail === 0 ? '✅ PASS' : '❌ FAIL') + ` — ${pass}/${pass + fail} assertions`);
if (fail) { console.log('Failures:\n' + failures.map(f => '  - ' + f).join('\n')); process.exit(1); }
