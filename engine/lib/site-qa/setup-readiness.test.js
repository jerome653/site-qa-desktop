'use strict';
// setup-readiness.test.js — Run: node setup-readiness.test.js (exit 0 = 100% pass).
//
// THE INVARIANT: the Setup panel must never tell an operator the machine is READY while an engine a
// full audit depends on is absent. This is readiness.js's LAUNCH-READY bug one layer up — there, a
// green pill sat beside "NEEDS ATTENTION" because the gate's narrow scope was rendered as a broad
// all-clear. Here the danger is worse, because the missing capability is SILENT: cross-browser.js:30
// catches a launch failure and returns available:false, audit.js reads that as "engine not
// installed", and the run still prints a Quality Score. A report with the cross-browser suite
// skipped looks identical on the score strip to one that passed it.
//
// So section 3 is exhaustive rather than illustrative: it enumerates ALL 2^5 presence combinations
// and asserts the green verdict is unreachable unless every requirement is present. A hand-picked
// example set would let a future edit introduce a lenient branch that no case happens to hit.
//
// Driving compute() with a synthetic state is deliberate and is the only honest option: the state
// that matters — engines absent — cannot be reproduced on a machine that has already downloaded
// them, and probe()'s own resolution was verified separately against the real install (all three
// true with the real browsers path, all three false against an empty one).
const { compute, probe, REQUIREMENTS } = require('./setup-readiness');

let fails = 0, total = 0;
const ok = (c, m) => { total++; if (!c) { console.error('  FAIL:', m); fails++; } };

const KEYS = REQUIREMENTS.map((r) => r.key);
const all = (v) => KEYS.reduce((o, k) => (o[k] = v, o), {});

// ---------------------------------------------------------------- 1 · the healthy case
{
  const r = compute(Object.assign(all(true), { feed: true }));
  ok(r.verdict === 'full', 'everything present → verdict full, got ' + r.verdict);
  ok(r.tone === 'ok', 'everything present → tone ok');
  ok(r.counts.blocked === 0 && r.counts.degraded === 0, 'everything present → no blocked/degraded');
  ok(r.rows.every((x) => x.status === 'ready'), 'everything present → every row ready');
  ok(r.rows.every((x) => x.impact === null && x.fix === null), 'a ready row carries no impact/fix noise');
}

// ---------------------------------------------------------------- 2 · the silent-loss cases
for (const eng of ['firefox', 'webkit']) {
  const r = compute(Object.assign(all(true), { [eng]: false, feed: true }));
  ok(r.verdict === 'partial', eng + ' missing → partial, got ' + r.verdict);
  ok(r.verdict !== 'full', eng + ' missing must NEVER read as full');
  const row = r.rows.find((x) => x.key === eng);
  ok(row && row.status === 'degraded', eng + ' row is degraded');
  ok(!!(row && row.impact), eng + ' row states what is lost');
  ok(!!(row && row.fix), eng + ' row states how to fix it');
  // The operator must be able to read WHICH check will not happen, from the headline area alone.
  ok(r.scope.indexOf(row.label) !== -1, eng + ' scope names the lost capability');
  ok(/incomplete/i.test(r.scope), eng + ' scope says reports produced now are incomplete');
}

// ---------------------------------------------------------------- 3 · green is unreachable while anything is missing
{
  let checked = 0, leaks = [];
  for (let mask = 0; mask < (1 << KEYS.length); mask++) {
    const st = {};
    KEYS.forEach((k, i) => { st[k] = !!(mask & (1 << i)); });
    // feed is advisory — vary it too, to prove it cannot rescue OR sink the verdict
    for (const feed of [true, false]) {
      const r = compute(Object.assign({}, st, { feed }));
      checked++;
      const complete = KEYS.every((k) => st[k]);
      if (r.verdict === 'full' && !complete) leaks.push(JSON.stringify(st));
      if (complete && r.verdict !== 'full') leaks.push('false-negative ' + JSON.stringify(st));
    }
  }
  ok(leaks.length === 0, 'green verdict leaked on ' + leaks.length + ' incomplete state(s): ' + leaks.slice(0, 3).join(' | '));
  ok(checked === (1 << KEYS.length) * 2, 'enumerated every combination, got ' + checked);
}

// ---------------------------------------------------------------- 4 · blockers outrank degradation
{
  const r = compute({ playwright: false, chromium: false, firefox: false, webkit: false, sharp: false, feed: true });
  ok(r.verdict === 'blocked', 'nothing present → blocked, got ' + r.verdict);
  ok(/CANNOT RUN/i.test(r.headline), 'blocked headline says an audit cannot run');
  const mixed = compute(Object.assign(all(true), { chromium: false, firefox: false, feed: true }));
  ok(mixed.verdict === 'blocked', 'a blocker outranks a degradation, got ' + mixed.verdict);
}

// ---------------------------------------------------------------- 5 · unchecked is never ready
{
  const r = compute({});
  ok(r.verdict !== 'full', 'empty state must not read as full');
  ok(r.verdict === 'blocked', 'empty state → blocked (unknown severity is never clean), got ' + r.verdict);
  const r2 = compute(undefined);
  ok(r2.verdict !== 'full', 'undefined state must not read as full');
  // guard against truthiness bugs — only a real boolean true counts as present
  const r3 = compute(Object.assign(all(true), { firefox: 'yes' }));
  ok(r3.verdict === 'partial', "a non-boolean truthy value must not count as present, got " + r3.verdict);
}

// ---------------------------------------------------------------- 6 · advisory never changes the verdict
{
  const on = compute(Object.assign(all(true), { feed: true }));
  const off = compute(Object.assign(all(true), { feed: false }));
  ok(on.verdict === off.verdict, 'feed reachability must not change the verdict');
  ok(off.advisory.some((a) => a.key === 'feed' && a.status === 'info'), 'unreachable feed is reported as info');
}

// ---------------------------------------------------------------- 7 · probe() degrades safely
{
  const st = probe({ playwright: null, fs: { existsSync: () => false }, sharp: null });
  ok(st.playwright === false || st.playwright === true, 'probe returns a boolean for playwright');
  ok(st.chromium === false, 'probe reports chromium absent when the runtime is unavailable');
  const r = compute(st);
  ok(r.verdict !== 'full', 'a probe that found nothing must not produce a full verdict');
}

// Output format is load-bearing, not cosmetic. testing/run-all.js:194 decides pass/fail by
// `/✅ (PASS|QUALIFIED)|PASS ·/.test(out) && !/❌/.test(out)` — the exit code is not consulted on
// the success path. A suite that passes 33/33 and exits 0 still reports as a SUITE FAILURE unless
// it prints this exact line, which is precisely what happened on the first run here.
if (fails) { console.error(`❌ FAIL — ${total - fails}/${total} assertions`); process.exit(1); }
console.log(`✅ PASS — ${total}/${total} assertions`);
