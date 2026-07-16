'use strict';
// blocking-overlay.test.js — CON-003 must only fire when something GENUINELY gates the page.
//
// Why a real browser and not a fixture: this check's inputs are layout, stacking and hit-testing —
// getBoundingClientRect vs the viewport, pointer-events, transforms, elementFromPoint. A stubbed DOM
// would be me asserting my own beliefs about compositing back at myself; only a real engine can say
// whether a page is actually reachable through an overlay. Every case below is a page Chromium lays out.
//
// The bug this pins: on the live sgen.com run (3.0.3, 3 pages) CON-003 fired on ALL 3 pages against
// `div#dpzDrawer.dpz` claiming "covers 100% of the viewport ... review manually", while the captured
// screenshots showed the complete, unobstructed page. The drawer host is transparent + pointer-events:none
// with the real panel translated off-screen. A green tick that isn't backed by a real check is bad; a
// RED flag that isn't backed by a real check discredits every honest finding beside it.
//
//   node blocking-overlay.test.js

const { chromium } = require('playwright');
const { detectBlockingOverlay } = require('./consent');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '\n      → ' + extra : '')); }
}

// Shared page furniture: real content the overlay is meant to be hiding.
const CONTENT = `<h1 id="headline">The real page headline</h1>
  <p id="body">Body copy a visitor can read and a screenshot can capture.</p>`;

// A closed slide-out drawer, modelled on sgen.com's #dpzDrawer: a transparent, click-through host that
// spans the viewport, with the actual panel transformed off-screen. Blocks nothing.
const DRAWER_OFFSCREEN = `<!doctype html><html><body style="margin:0">
  ${CONTENT}
  <div id="dpzDrawer" class="dpz" style="position:fixed;inset:0;z-index:10001;pointer-events:none;background:rgba(0,0,0,0)">
    <div class="sg-drawer-overlay" style="position:absolute;inset:0;opacity:0;background:rgba(15,23,42,.5);pointer-events:none"></div>
    <aside class="sg-drawer" style="position:absolute;top:0;right:0;width:440px;height:100%;background:#fff;transform:translateX(440px);pointer-events:none">
      <h3>Drawer</h3>
    </aside>
  </div>
</body></html>`;

// A panel parked off-screen by transform but with pointer-events:auto and an OPAQUE background —
// sgen.com's #pdPanel. Raw rect area says "covers 68%"; its on-screen area is zero.
const PANEL_OFFSCREEN = `<!doctype html><html><body style="margin:0">
  ${CONTENT}
  <aside id="pdPanel" class="pd-panel" style="position:fixed;top:0;left:0;width:980px;height:100%;z-index:91;background:rgb(13,13,15);transform:translateX(1460px)">
    <p>Slide-out details panel, closed.</p>
  </aside>
</body></html>`;

// A transparent full-viewport click-catcher that is click-through. Geometry only.
const POINTER_EVENTS_NONE = `<!doctype html><html><body style="margin:0">
  ${CONTENT}
  <div id="ghost" style="position:fixed;inset:0;z-index:9999;pointer-events:none;background:transparent"></div>
</body></html>`;

// THE TRUE POSITIVE. A genuine cookie wall: on-screen, on top, opaque, and it eats every click.
// If this ever stops being caught, the check has lost its whole purpose.
const COOKIE_WALL = `<!doctype html><html><body style="margin:0">
  ${CONTENT}
  <div id="cookieWall" class="cookie-consent" style="position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.92)">
    <div style="margin:20vh auto;width:60%;background:#fff;padding:2rem">
      <p>We use cookies.</p><button>Accept all cookies</button>
    </div>
  </div>
</body></html>`;

// A scrim that is opaque but CLICK-THROUGH. Not a consent gate (you cannot click it), yet it still
// paints over the page, so the audit's screenshot is a picture of the scrim. Fail closed: flag it.
const OPAQUE_CLICK_THROUGH = `<!doctype html><html><body style="margin:0">
  ${CONTENT}
  <div id="splash" style="position:fixed;inset:0;z-index:500;pointer-events:none;background:rgb(255,255,255)"></div>
</body></html>`;

// An OPEN drawer: the scrim faded in and taking pointer events. The same component as the first case,
// in the state that genuinely does gate the page — proves the fix keys on state, not on the selector.
const DRAWER_OPEN = `<!doctype html><html><body style="margin:0">
  ${CONTENT}
  <div id="dpzDrawer" class="dpz" style="position:fixed;inset:0;z-index:10001;background:rgba(0,0,0,0)">
    <div class="sg-drawer-overlay" style="position:absolute;inset:0;opacity:1;background:rgba(15,23,42,.5)"></div>
    <aside class="sg-drawer" style="position:absolute;top:0;right:0;width:440px;height:100%;background:#fff;transform:translateX(0)"></aside>
  </div>
</body></html>`;

(async () => {
  console.log('CON-003 blocking-overlay — real-browser detection\n');
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  async function detect(html) {
    await page.setContent(html, { waitUntil: 'load' });
    return detectBlockingOverlay(page);
  }

  console.log('  — must NOT fire (page is visible and reachable) —');

  let r = await detect(DRAWER_OFFSCREEN);
  ok(r === null, 'closed drawer (transparent + pointer-events:none + panel off-screen) is not a blocker',
    r && `fired: ${r.selector} cover=${r.cover} reason=${r.reason}`);

  r = await detect(PANEL_OFFSCREEN);
  ok(r === null, 'opaque panel parked off-screen by transform is not a blocker (rect ∩ viewport = 0)',
    r && `fired: ${r.selector} cover=${r.cover} reason=${r.reason}`);

  r = await detect(POINTER_EVENTS_NONE);
  ok(r === null, 'transparent click-through full-viewport layer is not a blocker',
    r && `fired: ${r.selector} cover=${r.cover} reason=${r.reason}`);

  console.log('\n  — MUST fire (the page really is gated) —');

  r = await detect(COOKIE_WALL);
  ok(r !== null, 'genuine full-screen cookie wall IS caught', 'returned null — a real gate went unreported');
  ok(r !== null && /cookieWall/.test(r.selector), 'cookie wall is named in the finding', r && r.selector);
  ok(r !== null && r.reason === 'intercepts', 'cookie wall is reported as intercepting input', r && r.reason);
  ok(r !== null && r.cover >= 0.9, 'cookie wall cover is measured near-full-viewport', r && String(r.cover));

  r = await detect(OPAQUE_CLICK_THROUGH);
  ok(r !== null, 'opaque click-through splash IS caught (screenshot would be of the splash)', 'returned null');
  ok(r !== null && r.reason === 'opaque', 'opaque splash is reported as painting over the page', r && r.reason);

  r = await detect(DRAWER_OPEN);
  ok(r !== null, 'the SAME drawer, opened, IS caught — detection keys on state, not selector', 'returned null');

  // Regression guard on the reported number itself. The old check divided raw rect area by the viewport,
  // so an off-screen element reported "100%". Cover must never exceed the viewport it is measured against.
  console.log('\n  — the reported number must be true —');
  r = await detect(COOKIE_WALL);
  ok(r !== null && r.cover <= 1, 'cover is a real viewport fraction, never >1', r && String(r.cover));

  await browser.close();

  const total = pass + fail;
  console.log('\n' + (fail === 0 ? '✅ PASS' : '❌ FAIL') + ` · ${pass}/${total} assertions`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('❌ FAIL · harness error\n', e); process.exit(1); });
