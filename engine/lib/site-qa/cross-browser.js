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

function pageSlug(u) { try { const x = new URL(u); return x.pathname === '/' ? 'home' : part(x.pathname, 'page'); } catch (e) { return 'page'; } }

async function renderIn(engine, url, screensDir) {
  let browser;
  try { browser = await pw[engine].launch({ headless: true }); }
  catch (e) { return { engine, available: false, note: String(e && e.message || e).split('\n')[0].slice(0, 100) }; }
  const errors = [];
  let ok = true, navErr = null, shot = null, capture = null;
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 160)); });
    page.on('pageerror', e => errors.push('[pageerror] ' + (e.message || '').slice(0, 160)));
    let nav = 'networkidle';
    try { await page.goto(url, { waitUntil: 'networkidle', timeout: 40000 }); }
    catch (e) { nav = 'load'; try { await page.goto(url, { waitUntil: 'load', timeout: 40000 }); } catch (e2) { ok = false; navErr = String(e2 && e2.message || e2).slice(0, 120); } }
    var consent = await dismissOverlays(page); // cookie banner / age gate / T&C — recorded, never silent
    try { shot = path.join(screensDir, evidenceName({ page: pageSlug(url), section: 'cross-browser', component: 'full', viewport: engine })); capture = await stableCapture(page, { fullPage: false, path: shot, engine, navigation: nav }); }
    catch (e) { shot = null; }
    await ctx.close();
  } catch (e) { ok = false; navErr = String(e && e.message || e).slice(0, 120); }
  await browser.close();
  return { engine, available: true, ok, navErr, errors: [...new Set(errors)], shot, capture, consent: consent || null };
}

// Test one representative URL (the entry page) in Firefox + WebKit.
async function crossBrowser(url, { screensDir, log = () => {} } = {}) {
  const out = [];
  for (const engine of ['firefox', 'webkit']) {
    log(`  cross-browser: ${engine} ...`);
    out.push(await renderIn(engine, url, screensDir));
  }
  return out;
}

module.exports = { crossBrowser };
