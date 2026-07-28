'use strict';
// structdelta-bg.test.js — deterministic suite for structDelta()'s BACKGROUND-IMAGE sensor (visual-match.js).
//
// The background axis is the one the structural comparison was blind to before v5, and it is the ONLY
// sensor for backgrounds on a redesign-mode run (pixel pass off). A matched element that lost, gained, or
// swapped its CSS background is a real design difference — tagged bg:true so grade() can weight it as a
// DEFECT distinctly from a text-colour tweak. structDelta() is pure over the element arrays READ emits, so
// this is fully provable without Chromium (font-checks.test.js builds its fixtures the same way).
//
// Locks three behaviours: a CHANGED background surfaces a restyled entry (diffs mention "background",
// bg:true), a REMOVED background reads as "background removed", and matching backgrounds raise NO false
// positive (a false blocker here destroys trust in every real finding).
const { structDelta } = require('../visual-match');

let pass = 0, fail = 0; const failures = [];
function ok(c, n) { if (c) pass++; else { fail++; failures.push(n); console.log('  ✗ ' + n); } }
function eq(a, b, n) { const p = JSON.stringify(a) === JSON.stringify(b); ok(p, n + (p ? '' : ` (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`)); }

// element builder — the shape READ emits. Same sec/tag/text on both sides keys them as the SAME element
// (so any diff is a restyle, never a missing+extra pair); same x/y keeps them from reading as "moved".
// bgImg is the file-name a url() background reduces to (READ's bgUrl), '' means no background image.
const el = (o = {}) => ({ sec: 'main', tag: 'section', text: 'hero', x: 0, y: 0, w: 800, h: 400, color: 'rgb(0,0,0)', bgImg: '', ...o });

console.log('structDelta() — background-image detection — test suite\n');

// ── 1 · a CHANGED background → one restyled entry, diffs mention "background", bg:true ──
(function changed() {
  const sd = structDelta([el({ bgImg: 'old-hero.jpg' })], [el({ bgImg: 'new-hero.jpg' })]);
  eq(sd.restyled.length, 1, 'changed: exactly one restyled element');
  ok(sd.restyled.length && sd.restyled[0].bg === true, 'changed: the restyle is tagged bg:true');
  ok(sd.restyled.length && sd.restyled[0].diffs.some(d => d.includes('background')), 'changed: the diff names the "background" axis');
  eq(sd.missing.length, 0, 'changed: nothing reads as missing (matched by identity)');
  eq(sd.extra.length, 0, 'changed: nothing reads as extra (matched by identity)');
  eq(sd.matched, 1, 'changed: the element still matches — a swapped background is a restyle, not a removal');
})();

// ── 2 · a REMOVED background → diffs say "background removed", bg:true ──
(function removed() {
  const sd = structDelta([el({ bgImg: 'hero.jpg' })], [el({ bgImg: '' })]);
  eq(sd.restyled.length, 1, 'removed: exactly one restyled element');
  ok(sd.restyled.length && sd.restyled[0].bg === true, 'removed: the restyle is tagged bg:true');
  ok(sd.restyled.length && sd.restyled[0].diffs.some(d => d.includes('background removed')), 'removed: the diff reads "background removed"');
})();

// ── 3 · a GAINED background → diffs say "background added", bg:true (the mirror of removal) ──
(function added() {
  const sd = structDelta([el({ bgImg: '' })], [el({ bgImg: 'hero.jpg' })]);
  eq(sd.restyled.length, 1, 'added: exactly one restyled element');
  ok(sd.restyled.length && sd.restyled[0].bg === true, 'added: the restyle is tagged bg:true');
  ok(sd.restyled.length && sd.restyled[0].diffs.some(d => d.includes('background added')), 'added: the diff reads "background added"');
})();

// ── 4 · MATCHING backgrounds → NO false positive (a false blocker destroys trust) ──
(function noFalsePositive() {
  const sd = structDelta([el({ bgImg: 'hero.jpg' })], [el({ bgImg: 'hero.jpg' })]);
  eq(sd.restyled.length, 0, 'match: identical backgrounds raise no restyle');
  eq(sd.matched, 1, 'match: the element matches cleanly');
  eq(sd.missing.length, 0, 'match: nothing missing');
  eq(sd.extra.length, 0, 'match: nothing extra');
  // and an element with no background on either side must likewise stay silent
  const none = structDelta([el({ bgImg: '' })], [el({ bgImg: '' })]);
  eq(none.restyled.length, 0, 'match: no background on either side raises no restyle');
})();

console.log('\n' + (fail === 0 ? '✅ PASS' : '❌ FAIL') + ` — ${pass}/${pass + fail} assertions`);
if (fail) { console.log('Failures:\n' + failures.map(f => '  - ' + f).join('\n')); process.exit(1); }
