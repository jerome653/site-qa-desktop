'use strict';
// deadline.test.js — Run: node deadline.test.js  (exit 0 = 100% pass).
//
// Locks the behaviour whose ABSENCE stopped the app dead on 2026-07-21: two Site Audit runs of the same
// staging host wedged (4h and 28min) because Playwright never times out page.evaluate() or close(), so
// a browser that stopped answering took the whole scan with it — busy forever, no report, no error.
// These assertions are what "it can no longer hang" means in code.
const { withDeadline } = require('./deadline');

let fails = 0, total = 0;
const ok = (cond, msg) => { total++; if (!cond) { console.error('  FAIL:', msg); fails++; } };

// Any unhandled rejection here is a real defect, not noise: the whole point of withDeadline is that the
// LOSER of the race is never awaited again, so a late failure must be absorbed rather than crash the
// process minutes after the run moved on.
const unhandled = [];
process.on('unhandledRejection', (e) => unhandled.push(String(e && e.message || e)));

const never = () => new Promise(() => {});
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  // 1. the hang case — a promise that never settles resolves to the fallback, on time
  const t0 = Date.now();
  const wedged = await withDeadline(never(), 120, 'ABANDONED');
  const waited = Date.now() - t0;
  ok(wedged === 'ABANDONED', 'a promise that never settles resolves to the fallback');
  ok(waited >= 100 && waited < 2000, `the deadline is honoured (~120ms, waited ${waited}ms)`);

  // 2. the normal case — a promise that settles in time is untouched, value passed straight through
  ok(await withDeadline(Promise.resolve('real'), 5000, 'ABANDONED') === 'real', 'a fast value passes through');
  ok(await withDeadline(sleep(20).then(() => 42), 5000, -1) === 42, 'a slow-but-in-time value passes through');
  ok(await withDeadline(Promise.resolve(false), 5000, true) === false, 'falsy values are not confused with a miss');
  ok(await withDeadline(Promise.resolve(0), 5000, 99) === 0, 'zero is a value, not a timeout');

  // 3. a rejection is a miss, not a throw — every caller treats the fallback as "the step did not
  //    complete", and none of them are written to catch here
  ok(await withDeadline(Promise.reject(new Error('boom')), 5000, 'FELL-BACK') === 'FELL-BACK', 'a rejection yields the fallback');

  // 4. a rejection that arrives AFTER the deadline must not reach the process
  const late = withDeadline(sleep(40).then(() => { throw new Error('late boom'); }), 10, 'ABANDONED');
  ok(await late === 'ABANDONED', 'a slow rejection still yields the fallback');
  await sleep(120);
  ok(unhandled.length === 0, `no unhandled rejection escapes (saw: ${unhandled.join('; ') || 'none'})`);

  // 5. the timer must not keep the process alive past a fast success — a 3-minute engine budget that
  //    pinned the event loop open would turn every clean run into a 3-minute exit hang.
  const handles = typeof process._getActiveHandles === 'function' ? process._getActiveHandles().length : 0;
  await withDeadline(Promise.resolve('quick'), 180000, null);
  const after = typeof process._getActiveHandles === 'function' ? process._getActiveHandles().length : 0;
  ok(after <= handles, 'the deadline timer is cleared when the work wins the race');

  if (fails) { console.error(`❌ FAIL — ${total - fails}/${total} assertions`); process.exit(1); }
  console.log(`✅ PASS — ${total}/${total} assertions`);
})();
