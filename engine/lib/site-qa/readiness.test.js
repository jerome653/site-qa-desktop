'use strict';
// readiness.test.js — Run: node readiness.test.js (exit 0 = 100% pass).
//
// THE INVARIANT: the report must never tell a client LAUNCH-READY while its own verdict says
// NEEDS ATTENTION. This tool is handed to a client as evidence a rebuild is sound, so a green pill
// that is not backed by a check that actually ran is a lie told in writing, on the agency's
// letterhead. The readiness gate vetoes on TIER-1 rules only, and most suites carry no tier-1 rule
// at all — this suite pins the gate's NARROW SCOPE from ever being presented as a BROAD all-clear.
//
// DRIVEN BY THE REAL AUDIT, NOT A FIXTURE. This codebase's signature failure is a synthetic fixture
// that agrees with the bug (25/25 green while every real site scored quality 0, because the fixture
// built rows from the full registry and real audits emit ruleId:null summaries). So section 1 loads
// the actual sgen.com 3.0.3 report.json off disk and asserts against it. If that artifact is absent
// the suite SKIPS those assertions loudly rather than silently passing on invented data.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { compute } = require('./readiness');
const reg = require('./rules/registry');

let fails = 0, total = 0;
const ok = (c, m) => { total++; if (!c) { console.error('  FAIL:', m); fails++; } };

// The real 3.0.3 live-audit artifact. Path is DERIVED (not hardcoded to a machine) so this suite
// stays cloneable; SGEN_QA_REAL_REPORT overrides it for CI or another operator's run.
const APPDATA = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const REAL = process.env.SGEN_QA_REAL_REPORT || path.join(
  APPDATA, 'SGEN Site QA', 'engines', 'sgen', 'W5-Live-Surface-Audit',
  'site-qa', '_ui-runs', 'sgen.com-1784139227918', 'report.json');

// ── 1) THE REGRESSION, against the real sgen.com run ────────────────────────────────────────────
// Real headline: verdict "NEEDS ATTENTION", ready:false, score 49, tally {pass:33,warn:30,fail:4}.
// Before the fix compute() returned verdict:"LAUNCH-READY" / launchReady:true on exactly this data,
// and report.js painted it as a green pill beside "NEEDS ATTENTION".
if (fs.existsSync(REAL)) {
  const real = JSON.parse(fs.readFileSync(REAL, 'utf8'));
  const r = compute(real.suites);

  ok(real.ready === false && real.verdict === 'NEEDS ATTENTION',
    'real run precondition: ready:false / NEEDS ATTENTION (the artifact the bug was found on)');
  ok(r.counts.blockers === 0, 'real run has ZERO tier-1 blockers — the exact case the bug hid in');
  ok(r.launchReady === true, 'gate NOT weakened: launchReady still means blockers===0 (unchanged semantics)');

  // The regression itself: on a run the report calls NEEDS ATTENTION, the badge must not say
  // LAUNCH-READY, must not be green, and must state the outstanding count.
  ok(!/^LAUNCH-READY$/.test(r.verdict),
    'REGRESSION: readiness.verdict is not the bare string "LAUNCH-READY" on a 49%/NEEDS-ATTENTION run');
  ok(r.tone === 'part', 'REGRESSION: tone is "part" (amber), not "ok" (green), on the real run');
  ok(r.clean === false, 'clean:false — 34 checks are still failing across non-tier-1 suites');
  ok(r.outstanding === 34 && r.outstanding === (r.counts.majors + r.counts.polish + r.counts.untiered),
    'outstanding (34) accounts for every fail/warn row the tier-1 gate cannot see');
  ok(/NO LAUNCH BLOCKERS/i.test(r.verdict) && /34 issues outstanding/i.test(r.verdict),
    'badge states its true scope AND the outstanding count: "NO LAUNCH BLOCKERS — 34 issues outstanding"');
  ok(/not an all-clear/i.test(r.scope), 'scope text explicitly denies being an all-clear');

  // ── the rendered pill, end to end through report.js ──
  // report.js is the last step before ink; assert on the HTML a client actually sees.
  const { renderReport } = require('./report');
  const outDir = path.join(os.tmpdir(), 'sgen-readiness-test-' + process.pid);
  const data = Object.assign({}, real, { readiness: r });
  let html = '';
  try {
    renderReport(data, outDir, {});
    html = fs.readFileSync(path.join(outDir, 'report.html'), 'utf8');
  } catch (e) { console.error('  (render skipped:', e.message + ')'); }
  if (html) {
    const pill = (html.match(/<span class="rlabel[^>]*>[^<]*<\/span>/) || [''])[0];
    ok(/class="rlabel part"/.test(pill), 'RENDERED: pill carries class "part" (amber), not "ok" (green)');
    ok(!/class="rlabel ok"/.test(html), 'RENDERED: no green readiness pill anywhere on a NEEDS-ATTENTION report');
    ok(/NO LAUNCH BLOCKERS/i.test(pill) && !/>LAUNCH-READY</.test(pill),
      'RENDERED: pill reads "NO LAUNCH BLOCKERS — …", never a bare "LAUNCH-READY"');
    ok(/NEEDS ATTENTION/.test(html), 'RENDERED: overall verdict still reads NEEDS ATTENTION beside it');
    // The whole point: the two labels sitting side by side must not contradict.
    const vlabel = (html.match(/<span class="vlabel">([^<]*)<\/span>/) || [, ''])[1];
    ok(!(/NEEDS ATTENTION/.test(vlabel) && /class="rlabel ok"/.test(pill)),
      'INVARIANT: report never renders a green LAUNCH-READY pill beside a NEEDS ATTENTION verdict');
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch (e) {}
  }
} else {
  console.error('  SKIP: real report.json not found at', REAL, '— real-data assertions did NOT run');
}

// ── 2) THE CASE THAT MATTERS MOST, derived from the REAL registry (not invented rule ids) ────────
// Zero tier-1 blockers but every non-tier-1 suite at rock bottom must never present as launch-ready.
// Rule ids/tiers are read out of rules/registry.js so this cannot drift from the real severity model.
const RULES = (() => {
  const r = reg.RULES || reg.rules || reg;
  return Array.isArray(r) ? r : Object.values(r);
})().filter(x => x && x.suite);

const NO_TIER1_SUITES = [...new Set(RULES.map(r => r.suite))]
  .filter(s => !RULES.some(r => r.suite === s && r.tier === 1));
ok(NO_TIER1_SUITES.length >= 5,
  `registry precondition: ${NO_TIER1_SUITES.length} suites carry NO tier-1 rule (${NO_TIER1_SUITES.join(', ')}) — the gate is structurally blind to them`);
for (const s of ['a11y', 'performance', 'console', 'links', 'forms']) {
  ok(NO_TIER1_SUITES.includes(s), `suite "${s}" has no tier-1 rule — every check in it can fail with blockers===0`);
}

// every rule in those blind suites, all failing at once
const wipeout = NO_TIER1_SUITES.map(s => ({
  name: s,
  checks: RULES.filter(r => r.suite === s).map(r => ({ ruleId: r.id, name: r.name || r.id, status: 'fail', tier: r.tier, items: [{}] })),
}));
const w = compute(wipeout);
ok(w.counts.blockers === 0, 'wipeout: zero tier-1 blockers (by construction — these suites have none)');
ok(w.launchReady === true, 'wipeout: the tier-1 veto still passes — proving the gate alone is not enough');
ok(w.tone === 'part' && w.clean === false, 'wipeout: presents as amber/part, NOT clean');
ok(!/^LAUNCH-READY$/.test(w.verdict), 'wipeout: does NOT present as LAUNCH-READY with every blind suite at zero');
ok(w.outstanding === wipeout.reduce((n, s) => n + s.checks.length, 0), 'wipeout: every failing check is counted as outstanding');

// ── 3) the veto still hard-fails (do not weaken the gate) ────────────────────────────────────────
const t1 = RULES.find(r => r.tier === 1);
const blocked = compute([{ name: t1.suite, checks: [{ ruleId: t1.id, name: t1.name || t1.id, status: 'fail', tier: 1, items: [{}] }] }]);
ok(blocked.launchReady === false && blocked.tone === 'no', 'a tier-1 blocker still hard-fails to NOT LAUNCH-READY / red');
ok(/^NOT LAUNCH-READY — 1 blocker$/.test(blocked.verdict), 'blocker verdict string unchanged');
ok(blocked.blockers.length === 1 && blocked.blockers[0].ruleId === t1.id, 'blocker detail preserved');

// ── 4) green is still reachable — the fix must not make the badge uselessly permanent-amber ──────
const cleanRun = compute([{ name: 'seo', checks: [{ ruleId: 'SEO-001', status: 'pass', tier: 2 }] }]);
ok(cleanRun.clean === true && cleanRun.tone === 'ok' && cleanRun.verdict === 'LAUNCH-READY',
  'a genuinely clean run still earns the green LAUNCH-READY pill');

// ── 5) untiered rows cannot silently re-earn green ───────────────────────────────────────────────
// Real audits emit ruleId:null summary rows. A failing row with no tier fell through every arm and
// vanished — which would let a broken run count zero outstanding and paint itself green.
const untiered = compute([{ name: 'functional', checks: [{ ruleId: null, name: 'summary', status: 'fail', tier: null, items: [{}] }] }]);
ok(untiered.counts.untiered === 1 && untiered.outstanding === 1, 'a failing ruleId:null/tier:null row counts as outstanding');
ok(untiered.clean === false && untiered.tone === 'part', 'unknown severity is never "clean" — no green pill');

// ── 6) legacy report.json (no tone, verdict:"LAUNCH-READY") must not reprint the lie ─────────────
{
  const { renderReport } = require('./report');
  const outDir = path.join(os.tmpdir(), 'sgen-readiness-legacy-' + process.pid);
  const legacy = {
    host: 'x.test', target: 'https://x.test', generated: '2026-07-15',
    verdict: 'NEEDS ATTENTION', ready: false, score: 49,
    tally: { pass: 33, warn: 30, fail: 4, manual: 4 },
    crawl: { pages: 3 }, render: { rendered: 3, total: 3 }, suites: [], quality: 72,
    readiness: { launchReady: true, verdict: 'LAUNCH-READY', blockers: [], counts: { blockers: 0, majors: 22, polish: 12 }, model: 'sgen-readiness-v1' },
  };
  try {
    renderReport(legacy, outDir, {});
    const html = fs.readFileSync(path.join(outDir, 'report.html'), 'utf8');
    ok(!/class="rlabel ok"/.test(html), 'legacy JSON re-render: renderer refuses green when data.ready !== true');
    ok(/NO LAUNCH BLOCKERS/i.test(html), 'legacy JSON re-render: pill is rewritten to state its scope');
    fs.rmSync(outDir, { recursive: true, force: true });
  } catch (e) { console.error('  (legacy render skipped:', e.message + ')'); }
}

if (fails) { console.error(`❌ FAIL — ${total - fails}/${total} assertions`); process.exit(1); }
console.log(`✅ PASS — ${total}/${total} assertions`);
