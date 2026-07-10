'use strict';
// visual-match.js — real page/section/element visual + structural comparison of two sites.
//
// Given a REFERENCE url (e.g. the client's old live site) and a CANDIDATE url (the SGEN staging
// rebuild), it: crawls both, pairs pages by path, and for each pair × viewport captures a full-page
// screenshot + a per-element structural read (section → element with geometry + key computed styles),
// then reports pixel mismatch % (sharp) and structural deltas (missing / extra / moved / text / style).
// NO AI. Pure Node + Playwright + sharp (both already in the tree).

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
let sharp = null; try { sharp = require('sharp'); } catch (e) { sharp = null; }
const { discoverPages } = require('../migration-qa/crawl');
const { stableCapture } = require('./capture');
const { dismissOverlays } = require('./consent');
const { evidenceName } = require('./evidence-name');

// Industry-standard device widths (default, 2026), each tagged with the real device it stands for:
// desktop (1920), laptop (1440/1200), iPad landscape/portrait (1024/768), large phone (480), iPhone
// Pro Max (430), iPhone (390), mid Android (380), Galaxy S baseline (360). Dense across the 360–480
// phone band + the 1200 desktop breakpoint where most real-world breakage lives — commodity tools
// (Percy/Chromatic/Backstop) default to 2–4 of these. Override with opts.viewports (e.g. SG-Builder
// authoring breakpoints 1920/1199/991/767/575/480 for SGB-built candidates).
const VIEWPORTS = [
  { label: '1920 · desktop', width: 1920, height: 1080 },
  { label: '1440 · laptop', width: 1440, height: 900 },
  { label: '1200 · laptop-sm', width: 1200, height: 800 },
  { label: '1024 · iPad landscape', width: 1024, height: 768 },
  { label: '768 · iPad portrait', width: 768, height: 1024 },
  { label: '480 · mobile-lg', width: 480, height: 854 },
  { label: '430 · iPhone Pro Max', width: 430, height: 932 },
  { label: '390 · iPhone', width: 390, height: 844 },
  { label: '380 · Android', width: 380, height: 800 },
  { label: '360 · Galaxy S', width: 360, height: 780 },
];

// In-page: read the DOM as section -> element records. Returns visible elements with the info a
// human uses to judge "does this match": what it is, where it sits, what it says, how it looks.
const READ = `(function(){
  function vis(el){ if(!el.getClientRects().length) return false; var s=getComputedStyle(el); if(s.visibility==='hidden'||s.display==='none'||+s.opacity===0) return false; var r=el.getBoundingClientRect(); return r.width>1&&r.height>1; }
  function secOf(el){ var n=el,L={header:1,nav:1,main:1,footer:1,section:1,article:1,aside:1}; while(n&&n.nodeType===1){ if(L[n.tagName.toLowerCase()]) return n.tagName.toLowerCase(); n=n.parentElement; } return 'body'; }
  function nearestHeading(el){ var sc=el,L={header:1,nav:1,main:1,footer:1,section:1,article:1,aside:1}; while(sc&&sc.nodeType===1){ if(L[sc.tagName.toLowerCase()])break; sc=sc.parentElement; } sc=sc||document.body; var h='',all=sc.querySelectorAll('h1,h2,h3'); for(var i=0;i<all.length;i++){ if(all[i].compareDocumentPosition(el)&Node.DOCUMENT_POSITION_FOLLOWING) h=(all[i].textContent||'').trim().slice(0,50); } return h; }
  var TAGS='h1,h2,h3,h4,p,a,button,img,ul,ol,section,header,footer,nav,form,input,label,table,figure,blockquote,[role=button]';
  var out=[], seen=0;
  Array.prototype.forEach.call(document.querySelectorAll(TAGS),function(el){
    if(seen>1200||!vis(el))return; seen++;
    var r=el.getBoundingClientRect(), s=getComputedStyle(el);
    var txt=(el.tagName==='IMG')?(el.getAttribute('alt')||'').slice(0,60):(el.childElementCount?'' :(el.textContent||'').trim().slice(0,80));
    var href=(el.tagName==='A')?((el.getAttribute('href')||'').replace(location.origin,'').trim().slice(0,60)):'';
    var aria=(el.getAttribute('aria-label')||el.getAttribute('title')||'').trim().slice(0,60);
    var ialt='';if(!txt&&el.querySelector){var im=el.querySelector('img');if(im)ialt=(im.getAttribute('alt')||'').trim().slice(0,60);}
    out.push({
      tag: el.tagName.toLowerCase(),
      sec: secOf(el),
      head: nearestHeading(el),
      text: txt, href: href, aria: aria, ialt: ialt,
      x: Math.round(r.left), y: Math.round(r.top+window.scrollY), w: Math.round(r.width), h: Math.round(r.height),
      font: s.fontFamily.split(',')[0].replace(/["']/g,'').trim(),
      size: parseFloat(s.fontSize)||0,
      weight: s.fontWeight,
      color: s.color,
      bg: s.backgroundColor,
      src: el.tagName==='IMG'?((el.currentSrc||el.src||'').split('/').pop()||'').slice(0,60):''
    });
  });
  return { url: location.href, docHeight: document.documentElement.scrollHeight, count: out.length, els: out };
})();`;

function pathOf(u) { try { const x = new URL(u); return (x.pathname.replace(/\/+$/, '') || '/'); } catch (e) { return u; } }

// pair pages by normalized path (default). urlMap = { '/old':'/new' } overrides.
function pairByPath(aPages, bPages, urlMap) {
  const bByPath = {}; bPages.forEach(p => { bByPath[pathOf(p.url)] = p.url; });
  const pairs = [];
  for (const a of aPages) {
    const ap = pathOf(a.url);
    const target = (urlMap && urlMap[ap]) ? urlMap[ap] : ap;
    if (bByPath[target]) pairs.push({ path: ap, a: a.url, b: bByPath[target] });
  }
  return pairs;
}

// pixel mismatch % between two PNG files (candidate resized to reference size). Needs sharp.
async function pixelDiff(refPng, candPng, outDiff) {
  if (!sharp) return { pct: null, note: 'sharp not available' };
  const ref = sharp(refPng); const meta = await ref.metadata();
  const W = meta.width, H = meta.height;
  const refBuf = await ref.ensureAlpha().raw().toBuffer();
  const candBuf = await sharp(candPng).resize(W, H, { fit: 'fill' }).ensureAlpha().raw().toBuffer();
  const n = Math.min(refBuf.length, candBuf.length); let diffPx = 0; const total = W * H;
  const outRaw = Buffer.alloc(W * H * 4);
  for (let i = 0; i < n; i += 4) {
    const dr = Math.abs(refBuf[i] - candBuf[i]), dg = Math.abs(refBuf[i + 1] - candBuf[i + 1]), db = Math.abs(refBuf[i + 2] - candBuf[i + 2]);
    const j = i;
    if (dr + dg + db > 60) { diffPx++; outRaw[j] = 255; outRaw[j + 1] = 0; outRaw[j + 2] = 60; outRaw[j + 3] = 255; }
    else { outRaw[j] = refBuf[i]; outRaw[j + 1] = refBuf[i + 1]; outRaw[j + 2] = refBuf[i + 2]; outRaw[j + 3] = 60; }
  }
  if (outDiff) { try { await sharp(outRaw, { raw: { width: W, height: H, channels: 4 } }).png().toFile(outDiff); } catch (e) {} }
  return { pct: +(diffPx / total * 100).toFixed(2), width: W, height: H };
}

// structural delta: match elements by (section + tag + text|head), report unmatched + moved + restyled.
function structDelta(refEls, candEls) {
  const key = e => `${e.sec}|${e.tag}|${(e.text || e.head || e.src || '').toLowerCase().slice(0, 40)}`;
  const candBy = {}; candEls.forEach(e => { (candBy[key(e)] = candBy[key(e)] || []).push(e); });
  const missing = [], moved = [], restyled = [], matched = [];
  const usedCand = new Set();
  for (const r of refEls) {
    const bucket = candBy[key(r)] || [];
    const c = bucket.find(x => !usedCand.has(x));
    if (!c) { missing.push(r); continue; }
    usedCand.add(c); matched.push(r);
    const dy = Math.abs(r.y - c.y), dx = Math.abs(r.x - c.x);
    if (dy > 60 || dx > 60) moved.push({ el: r, from: [r.x, r.y], to: [c.x, c.y] });
    const styleDiffs = [];
    if (r.font && c.font && r.font.toLowerCase() !== c.font.toLowerCase()) styleDiffs.push(`font ${r.font}→${c.font}`);
    if (r.size && c.size && Math.abs(r.size - c.size) > 2) styleDiffs.push(`size ${r.size}→${c.size}px`);
    if (r.color !== c.color) styleDiffs.push(`color ${r.color}→${c.color}`);
    if (styleDiffs.length) restyled.push({ el: r, diffs: styleDiffs });
  }
  let extra = candEls.filter(e => !usedCand.has(e));
  // Relocation pass: an element that went "missing" from one landmark but reappears (same tag + identity)
  // in a DIFFERENT landmark is not removed — the page was restructured. Move it out of missing + extra
  // into `moved` (flagged relocated), so a nav→header restructure stops reading as a false removal+addition.
  const idOf = e => (e.text || e.aria || e.ialt || e.src || e.href || '').toLowerCase().slice(0, 40);
  const usedExtra = new Set(), stillMissing = [];
  for (const r of missing) {
    const rid = idOf(r);
    const c = rid ? extra.find(x => !usedExtra.has(x) && x.tag === r.tag && idOf(x) === rid && x.sec !== r.sec) : null;
    if (c) { usedExtra.add(c); moved.push({ el: r, from: [r.x, r.y], to: [c.x, c.y], fromSec: r.sec, toSec: c.sec }); }
    else stillMissing.push(r);
  }
  extra = extra.filter(e => !usedExtra.has(e));
  const structScore = refEls.length ? matched.length / refEls.length : (candEls.length ? 0 : 1);
  return { refCount: refEls.length, candCount: candEls.length, matched: matched.length, missing: stillMissing, extra, moved, restyled, structScore: +(structScore * 100).toFixed(1) };
}

async function readAndShoot(browser, url, vp, shotPath) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
  const page = await ctx.newPage();
  let read = { count: 0, els: [] };
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForTimeout(900);
    // Dismiss consent-class overlays (cookie banner / age gate / T&C) so the comparison sees the real
    // page — not the gate — using the same deterministic ruleset the Site Audit + render pass use.
    let consentHit = null;
    try { const c = await dismissOverlays(page); if (c && c.dismissed.length) { consentHit = c.dismissed; await page.waitForTimeout(300); } } catch (e) {}
    read = await page.evaluate(READ);   // structural read timing unchanged → visual-comparison algorithm identical
    if (consentHit) read.consent = consentHit;
    read.capture = await stableCapture(page, { fullPage: true, path: shotPath, engine: 'chromium' });
  } catch (e) { read.error = (e.message || '').slice(0, 140); }
  await ctx.close();
  return read;
}

async function run(refUrl, candUrl, { maxPages = 20, urlMap = null, outDir, viewports = null, log = () => {}, progress = () => {} } = {}) {
  const VPS = (Array.isArray(viewports) && viewports.length) ? viewports : VIEWPORTS;
  fs.mkdirSync(outDir, { recursive: true });
  const shotsDir = path.join(outDir, 'shots'); fs.mkdirSync(shotsDir, { recursive: true });
  log(`Crawling reference ${refUrl} ...`); progress(6, 'crawling reference');
  const A = await discoverPages(refUrl, { maxPages, concurrency: 6, log: () => {} });
  log(`Crawling candidate ${candUrl} ...`); progress(16, 'crawling candidate');
  const B = await discoverPages(candUrl, { maxPages, concurrency: 6, log: () => {} });
  const aHtml = A.pages.filter(p => p.status === 200);
  const bHtml = B.pages.filter(p => p.status === 200);
  const pairs = pairByPath(aHtml, bHtml, urlMap);
  const unmatchedRef = aHtml.map(p => pathOf(p.url)).filter(pp => !pairs.find(x => x.path === pp));
  log(`Paired ${pairs.length} page(s) by path (${unmatchedRef.length} reference page(s) with no candidate match).`);

  const browser = await chromium.launch({ headless: true });
  const slug = s => s.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'home';
  const pageResults = [];
  let done = 0;
  for (const pr of pairs) {
    const vps = [];
    for (const vp of VPS) {
      const nameOf = component => evidenceName({ page: slug(pr.path), section: 'visual-match', component, viewport: vp.label });
      const refShot = path.join(shotsDir, nameOf('reference'));
      const candShot = path.join(shotsDir, nameOf('candidate'));
      const diffShot = path.join(shotsDir, nameOf('diff'));
      const refRead = await readAndShoot(browser, pr.a, vp, refShot);
      const candRead = await readAndShoot(browser, pr.b, vp, candShot);
      let pix = { pct: null };
      try { if (fs.existsSync(refShot) && fs.existsSync(candShot)) pix = await pixelDiff(refShot, candShot, diffShot); } catch (e) { pix = { pct: null, note: e.message }; }
      const sd = structDelta(refRead.els || [], candRead.els || []);
      const visScore = pix.pct == null ? null : Math.max(0, +(100 - pix.pct).toFixed(1));
      const matchScore = (visScore == null) ? sd.structScore : +(((sd.structScore + visScore) / 2)).toFixed(1);
      vps.push({ label: vp.label, pixelMismatchPct: pix.pct, visScore, struct: sd, matchScore,
        shots: { ref: path.relative(outDir, refShot), cand: path.relative(outDir, candShot), diff: fs.existsSync(diffShot) ? path.relative(outDir, diffShot) : null },
        capture: { ref: refRead.capture || null, cand: candRead.capture || null },
        errors: [refRead.error, candRead.error].filter(Boolean) });
    }
    const pageScore = +(vps.reduce((a, v) => a + (v.matchScore || 0), 0) / vps.length).toFixed(1);
    pageResults.push({ path: pr.path, ref: pr.a, cand: pr.b, pageScore, viewports: vps });
    done++; progress(20 + Math.round(done / pairs.length * 76), `compared ${done}/${pairs.length}`);
    log(`  ${pr.path} — ${pageScore}% match`);
  }
  await browser.close();
  const overall = pageResults.length ? +(pageResults.reduce((a, p) => a + p.pageScore, 0) / pageResults.length).toFixed(1) : 0;
  return { reference: refUrl, candidate: candUrl, generated: new Date().toISOString(), overall,
    pairs: pairs.length, unmatchedRef, viewports: VPS.map(v => v.label), pages: pageResults, sharp: !!sharp };
}

module.exports = { run, VIEWPORTS, structDelta, pixelDiff, pairByPath, pathOf };
