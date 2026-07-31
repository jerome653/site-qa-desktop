'use strict';
// sweep-truth.test.js — the in-page sweep must not report a defect the page does not have.
//
// TWO DEFECTS, both found by re-measuring a real client build (SGEN dental landing page) by hand
// after the engine failed it, and both of the same shape: a check reads ONE property, concludes from
// it, and never asks whether that property is the whole story.
//
//   A11Y-002  bg() walks ancestors reading background-color ONLY. A gradient button reports
//             `transparent`, so the walk continues to the page ground — and white button text on a
//             red gradient is scored against white paper: ratio 1.00:1, "invisible". The real
//             range on that button is 7.4:1 → 4.2:1. The engine did not find a contrast bug; it
//             found its own blind spot, and reported it at the loudest severity it has.
//
//   RESP-004  fires on any element wider than the viewport, with no regard for whether an ancestor
//             clips or scrolls it. A marquee track inside overflow-x:hidden and a comparison table
//             inside overflow-x:auto are both intentional and neither can push the page sideways —
//             the same page measured document.scrollWidth === innerWidth at 390, 768 and 1440 while
//             the engine reported 48 high-severity "element wider than viewport" findings.
//
// Why a real browser, no fixtures-of-the-fix: both bugs live in getComputedStyle and layout. A
// JSDOM stand-in would return whatever the test author believed, which is exactly how a blind spot
// survives its own test suite.
//
//   node sweep-truth.test.js

const { chromium } = require('playwright');
const { SWEEP } = require('./checks-render');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '\n      → ' + extra : '')); }
}

// Every colour below is measured, not asserted: white on #B00000 is 7.38:1 and white on #E53935 is
// 4.23:1 by the WCAG 2.1 relative-luminance formula. #D93025 is 4.77:1 — the same gradient, past AA.
const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"><style>
  body{margin:0;background:#fff;font:16px/1.5 system-ui}
  .grad{background-image:linear-gradient(135deg,#B00000,#E53935);color:#fff;border:0;
        padding:14px 20px;font-size:15px;font-weight:600}
  .grad-ok{background-image:linear-gradient(135deg,#B00000,#D93025);color:#fff;border:0;
           padding:14px 20px;font-size:15px;font-weight:600}
  .photo{background-image:url("data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==");
         color:#fff;padding:14px 20px}
  .faint{color:#bbb;background:#fff}
  /* glassmorphism: a 3%-white tint over a near-black card. The tint is not the ground. */
  .card{background:#0d0d0f;padding:16px}
  .glass{background:rgba(255,255,255,.03);padding:12px}
  .glass span{color:rgba(255,255,255,.82)}
  /* the same trick where it really does fail: a 30%-white separator on white paper */
  .onwhite{background:#fff;padding:10px}
  .onwhite span{color:rgba(255,255,255,.3)}
  /* a dark section lit by a translucent radial wash — the wash is ON the dark colour, not on paper */
  .washed{background-color:#0d0d0f;
          background-image:radial-gradient(1200px 600px at 50% -10%, rgba(255,42,56,.10), rgba(0,0,0,0) 60%);
          padding:20px}
  .washed h2{color:#f4f2ee;margin:0;font-size:15px}
  .clip{overflow-x:hidden;width:300px}
  .scroller{overflow-x:auto;width:300px}
  .track{width:5000px;height:30px;background:#eee}
  .table{width:900px;height:30px;background:#ddd}
  .loose{width:5000px;height:30px;background:#cfc}
</style></head><body>
  <button class="grad" id="gradfail">Apply to grow your practice</button>
  <button class="grad-ok" id="gradpass">Apply to grow your practice</button>
  <p class="photo" id="photo">White text over a photographic background</p>
  <p class="faint" id="faint">Genuinely unreadable grey on white</p>
  <div class="clip"><div class="track" id="marquee"></div></div>
  <div class="scroller"><div class="table" id="scrolltable"></div></div>
  <div class="loose" id="loose"></div>
  <div class="card"><div class="glass"><span id="glassy">Google · Local pack</span></div></div>
  <div class="onwhite"><span id="ghost">· separator ·</span></div>
  <div class="washed"><h2 id="washedh2">Dental sites we&rsquo;ve built &amp; ranked</h2></div>
  <p style="font-size:13px">Read the <a id="inlinelink" href="/terms">terms and conditions</a> before applying.</p>
  <div><button id="tinybtn" type="button" style="width:20px;height:20px;padding:0">x</button></div>
  <input type="range" id="slider" style="font-size:11px" min="1" max="10">
  <input type="text" id="typed" style="font-size:11px" placeholder="name">
  <select id="picker" style="font-size:11px"><option>one</option></select>
</body></html>`;

(async () => {
  const browser = await chromium.launch();
  // hasTouch, because the tap-target and input-font branches are gated on the platform being a touch
  // device — a desktop context skips them entirely and every assertion about them would pass blind.
  const page = await browser.newPage({ viewport: { width: 390, height: 800 }, hasTouch: true, isMobile: true });
  await page.setContent(FIXTURE, { waitUntil: 'load' });
  await page.evaluate('window.__runContrast = true;');
  const out = await page.evaluate(SWEEP);

  const of = (check) => out.filter(r => r.check === check);
  const hit = (check, needle) => of(check).some(r => (r.selector || '').includes(needle));
  const dump = JSON.stringify(out.map(r => [r.check, r.selector, r.value]));

  // ── A11Y-002 · contrast must read the background it is actually drawn on ─────────────────────
  console.log('\n  — contrast against gradients —');

  ok(!hit('low-contrast', 'gradpass'), 'a gradient whose worst stop clears AA does not fire', dump);

  const gradHits = of('low-contrast').filter(r => (r.selector || '').includes('gradfail'));
  ok(gradHits.length === 1, 'a gradient whose lightest stop misses AA still fires — the miss is real', dump);
  if (gradHits.length === 1) {
    const ratio = parseFloat(gradHits[0].value);
    ok(ratio > 4 && ratio < 4.5,
      `and it reports the true worst-stop ratio (${ratio}:1), not the page ground`,
      'expected ~4.23:1 — white on #E53935. 1.00:1 means bg() still walked past the gradient to the white body.');
  } else { fail++; console.log('  ✗ ratio assertion skipped — the gradient row was not produced as expected'); }

  ok(!hit('low-contrast', 'photo'),
    'a background-image the engine cannot sample is skipped, not scored against an ancestor',
    'guessing here produces a confident wrong answer; the sweep has no way to read a photo, so it must not pretend to');

  ok(hit('low-contrast', 'faint'), 'genuinely low-contrast text still fires — the fix must not blind the check', dump);

  // A translucent tint is a LAYER, not a ground. Reading rgba(255,255,255,.03) as solid white is how
  // ten readable labels on a near-black dashboard card all reported exactly 1.00:1 on a real build.
  console.log('\n  — translucent layers are composited, not mistaken for the ground —');

  ok(!hit('low-contrast', 'glassy'),
    'white text under a 3% white tint over a near-black card does not fire',
    'stopping at the first non-zero alpha treats a 3% tint as solid white — ' + dump);

  const ghost = of('low-contrast').filter(r => (r.selector || '').includes('ghost'));
  ok(ghost.length === 1, 'the same technique on white paper DOES fire — 30% white on white is invisible', dump);

  // A gradient's stops paint ON the element's own background-color, not on the page. Reading the
  // stops alone flattens a 10%-red wash over white and calls a near-black section "pale pink", which
  // then fails its off-white heading. Acting on that reading would darken the heading to near-black
  // ON near-black — the checker would go quiet and the page would become unreadable.
  ok(!hit('low-contrast', 'washedh2'),
    'off-white heading on a dark section lit by a translucent radial wash does not fire', dump);

  // ── RESP-004 · a wide element only matters if something can actually see it ──────────────────
  console.log('\n  — wide elements inside clipping and scrolling ancestors —');

  ok(!hit('element-wider-than-viewport', 'marquee'),
    'a wide track inside overflow-x:hidden does not fire — it cannot widen the page', dump);
  ok(!hit('element-wider-than-viewport', 'scrolltable'),
    'a wide table inside overflow-x:auto does not fire — the scroll is the design', dump);
  ok(hit('element-wider-than-viewport', 'loose'),
    'a wide element with no clipping ancestor still fires — the rule keeps its teeth', dump);

  // ── RESP-006 · iOS zooms when a TEXT field under 16px takes focus ────────────────────────────
  // A range slider has no text and no keyboard, so its font-size cannot trigger the zoom this rule
  // exists to prevent. Two decorative sliders produced 16 findings across the viewport matrix on a
  // real build while the fields a visitor actually types into were already correct.
  console.log('\n  — input font size, on controls that can be typed into —');

  // WCAG 2.5.8 exempts a target "in a sentence or block of text" — a link inside running copy is
  // sized by the line-height around it, and padding it to 44px would break the paragraph. A real
  // build produced 64 findings this way, every one of them a link in a paragraph or a footer line.
  console.log('\n  — tap targets, with the WCAG inline exception —');

  ok(!hit('tap-target-small', 'inlinelink'), 'a link inside a sentence is exempt', dump);
  ok(hit('tap-target-small', 'tinybtn'), 'a small standalone control still fires', dump);

  ok(!hit('input-font-small', 'slider'), 'a range input under 16px does not fire — there is nothing to zoom', dump);
  ok(hit('input-font-small', 'typed'), 'a text input under 16px still fires', dump);
  ok(hit('input-font-small', 'picker'), 'a select under 16px still fires — iOS zooms on those too', dump);

  const docOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2);
  ok(docOverflow, 'the fixture really does overflow (via #loose), so the page-level rule is doing its job',
    'if this is false the fixture is wrong, not the engine');

  await browser.close();
  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
