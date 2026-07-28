'use strict';
// site-qa/cross-browser.js — REAL cross-browser rendering via Playwright's free Firefox + WebKit
// engines (WebKit is the Safari engine). Loads the page in each, captures console/page errors and a
// screenshot. Makes "Cross-Browser" a real automated suite instead of a manual note.
//
// Honest degrade: if an engine's binary isn't installed, the row is 'manual' with the exact install
// command — never a fake pass. (Install once: npx playwright install firefox webkit)

const path = require('path');
const pw = require('playwright');
const { stableCapture } = require('./capture');
const { evidenceName, part } = require('./evidence-name');
const { dismissOverlays } = require('./consent');
const { withDeadline } = require('./deadline');

// Nothing in here may wedge the run. Measured 2026-07-21 (the two runs are recorded in deadline.js):
// WebKit's helper processes went defunct while our awaits never settled, and the whole scan stopped —
// no report, no error, ACTIVE_SCANS pinned at 1. Playwright bounds navigation and screenshots; it does
// not bound close(), so these two budgets are ours to set.
const CLOSE_BUDGET_MS = 15000;    // context/browser teardown, once the work is already done
const ENGINE_BUDGET_MS = 180000;  // one engine end-to-end. The honest worst case is ~110s (40s
                                  // networkidle + 15s load + capture); past 180s it is a wedge, not a
                                  // slow site, and waiting longer buys nothing.

function pageSlug(u) { try { const x = new URL(u); return x.pathname === '/' ? 'home' : part(x.pathname, 'page'); } catch (e) { return 'page'; } }

async function renderIn(engine, url, screensDir) {
  let browser;
  try { browser = await pw[engine].launch({ headless: true }); }
  catch (e) { return { engine, available: false, note: String(e && e.message || e).split('\n')[0].slice(0, 100) }; }
  const errors = [];
  let ok = true, navErr = null, shot = null, capture = null;
  // WHY THIS EVIDENCE EXISTS. A nav failure used to report one truncated string ("page.goto: Timeout
  // 40000ms exceeded") and NOTHING else — the report's evidence table for the row came out empty, so
  // the finding said an engine failed and could not say what it was waiting on. Measured on a real
  // staging run 2026-07-20: WebKit "failed to load", while the SAME page's Chromium pass had already
  // recorded a request timing out, an icon font that never loaded and a 30s LCP. The cause was in the
  // run the whole time and the row that needed it did not carry it.
  const failedReq = [];        // requests the engine itself reported as failed/aborted
  const pending = new Map();   // url -> started-at, for requests still in flight when we gave up
  const attempts = [];         // every goto we tried, what we waited for, how long it took
  let domReady = false;
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 160)); });
    page.on('pageerror', e => errors.push('[pageerror] ' + (e.message || '').slice(0, 160)));
    page.on('request', (r) => { try { pending.set(r.url(), Date.now()); } catch (_) {} });
    page.on('requestfinished', (r) => { try { pending.delete(r.url()); } catch (_) {} });
    page.on('requestfailed', (r) => {
      try {
        pending.delete(r.url());
        const why = (r.failure() && r.failure().errorText) || 'failed';
        if (failedReq.length < 25) failedReq.push({ url: r.url(), why });
      } catch (_) {}
    });
    // domcontentloaded is recorded separately because it splits the two very different diagnoses the
    // old single error could not tell apart: DOM ready but load never fired = the document is fine and
    // a SUBRESOURCE is hanging (fix the resource); DOM never ready = the page itself never arrived.
    page.once('domcontentloaded', () => { domReady = true; });
    let nav = 'networkidle';
    const t1 = Date.now();
    try { await page.goto(url, { waitUntil: 'networkidle', timeout: 40000 }); attempts.push({ waitUntil: 'networkidle', ms: Date.now() - t1, ok: true }); }
    catch (e) {
      attempts.push({ waitUntil: 'networkidle', ms: Date.now() - t1, ok: false, err: String(e && e.message || e).split('\n')[0].slice(0, 120) });
      nav = 'load';
      // 15s, not another 40s. `networkidle` fails on any page holding a connection open (analytics,
      // chat widget, websocket) while the document is long since loaded — in that case `load` resolves
      // almost instantly, so a generous timeout buys nothing. A page that cannot fire `load` within
      // 15s of a 40s networkidle attempt is not about to. Worst case drops 80s -> 55s per engine.
      const t2 = Date.now();
      try { await page.goto(url, { waitUntil: 'load', timeout: 15000 }); attempts.push({ waitUntil: 'load', ms: Date.now() - t2, ok: true }); }
      catch (e2) {
        attempts.push({ waitUntil: 'load', ms: Date.now() - t2, ok: false, err: String(e2 && e2.message || e2).split('\n')[0].slice(0, 120) });
        ok = false; navErr = String(e2 && e2.message || e2).split('\n')[0].slice(0, 160);
      }
    }
    // Both of these only make sense on a page that LOADED. Measured 2026-07-20 against a page with a
    // hanging subresource: the two goto attempts cost 55s and the run still took 102s — the missing
    // 47s was spent here, hunting for a cookie banner and waiting for a screenshot to stabilise on a
    // page that never arrived. Skipping them on a nav failure is the real saving (~110s -> ~55s per
    // failing engine); nothing is lost, because a shot of a page that did not load is not evidence of
    // anything, and the failure evidence we DO want is the request lists gathered above.
    var consent = null;
    if (ok) {
      consent = await dismissOverlays(page); // cookie banner / age gate / T&C — recorded, never silent
      try { shot = path.join(screensDir, evidenceName({ page: pageSlug(url), section: 'cross-browser', component: 'full', viewport: engine })); capture = await stableCapture(page, { fullPage: false, path: shot, engine, navigation: nav }); }
      catch (e) { shot = null; }
    }
    // Teardown is deadlined, not awaited outright: a browser that has stopped answering (or has already
    // exited without saying so) makes close() wait forever, and the evidence gathered above would be
    // lost with the run. Leaking a browser process is the strictly better trade.
    await withDeadline(ctx.close(), CLOSE_BUDGET_MS, null);
  } catch (e) { ok = false; navErr = String(e && e.message || e).split('\n')[0].slice(0, 160); }
  await withDeadline(browser.close(), CLOSE_BUDGET_MS, null);
  // Still-in-flight requests at the moment we gave up. On a nav timeout these ARE the answer — the
  // thing the engine was waiting for — so they are ranked slowest-first and carried on the result.
  const stalled = [...pending.entries()]
    .map(([u, t]) => ({ url: u, waitedMs: Date.now() - t }))
    .sort((a, b) => b.waitedMs - a.waitedMs).slice(0, 15);
  return { engine, available: true, ok, navErr, errors: [...new Set(errors)], shot, capture, consent: consent || null,
    attempts, domReady, failedReq, stalled };
}

// Test one representative URL (the entry page) in Firefox + WebKit.
async function crossBrowser(url, { screensDir, log = () => {} } = {}) {
  const out = [];
  for (const engine of ['firefox', 'webkit']) {
    log(`  cross-browser: ${engine} ...`);
    const started = Date.now();
    const row = await withDeadline(renderIn(engine, url, screensDir), ENGINE_BUDGET_MS, null);
    if (row) { out.push(row); continue; }
    // Budget blown = the engine stopped answering. The row is still written, as a real failure: an
    // ABSENT row is read downstream as "engine not installed" (audit.js:781), which is a different and
    // untrue claim, and dropping it silently is what made this hang invisible in the first place.
    log(`  cross-browser: ${engine} did not return within ${Math.round(ENGINE_BUDGET_MS / 1000)}s — abandoned`);
    out.push({
      engine, available: true, ok: false,
      navErr: `${engine} did not respond within ${Math.round(ENGINE_BUDGET_MS / 1000)}s and was abandoned — the browser stopped answering (its process may have exited without reporting). This browser is UNVERIFIED for this run.`,
      errors: [], shot: null, capture: null, consent: null,
      attempts: [{ waitUntil: 'engine-budget', ms: Date.now() - started, ok: false, err: 'the engine never returned' }],
      domReady: false, failedReq: [], stalled: [], abandoned: true,
    });
  }
  return out;
}

// renderIn is exported for cross-browser-evidence.test.js — a nav-failure takes ~55s per engine, so
// the test drives ONE engine directly rather than paying for both through crossBrowser().
module.exports = { crossBrowser, renderIn };
