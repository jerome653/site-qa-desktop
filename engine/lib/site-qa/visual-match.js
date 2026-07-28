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
const { withDeadline } = require('./deadline');
// Same class of hang as the Site Audit's cross-browser step (see deadline.js): page.evaluate and
// close() are the two calls Playwright never bounds, and a comparison that hits either stops dead with
// no report and no error. A capture that times out is reported as a failed read, which the caller
// already handles — it is never treated as a match.
const READ_BUDGET_MS = 60000;
const CLOSE_BUDGET_MS = 15000;
const READ_TIMED_OUT = { __timedOut: true };   // sentinel: READ legitimately returns an object, so the
                                               // deadline needs a value it can never collide with.
const { dismissOverlays } = require('./consent');
const { evidenceName } = require('./evidence-name');
const { FONT_SWEEP, drift, GENERIC } = require('./font-checks');

// ── COMPARISON MODE ───────────────────────────────────────────────────────────────────────────────
// The pixel pass answers ONE question: "does the candidate render the same pixels as the reference?"
// That question is only meaningful for a LIKE-FOR-LIKE replatform (same design, new platform). On a
// REDESIGN the two sites are SUPPOSED to differ, so every pixel number is noise — and it is noise that
// LIES, because pixelMismatchPct feeds visScore feeds matchScore feeds the headline overall %.
// Antialiasing and font rasterisation alone spend 1–3% before a single carousel, date, A/B bucket or
// lazy-load race is involved.
//
// So: 'redesign' SKIPS the pixel pass outright rather than emitting it as advisory. Skipping is not the
// lazy option, it is the SAFE one — `pct: null` is a path this engine has always had (it is what a
// missing `sharp` produces), so every downstream consumer already handles it correctly and identically:
//   • matchScore falls back to structScore alone (see the run loop) — a redesign scores on STRUCTURE,
//     which is the only axis that still means anything when the design changed on purpose.
//   • visual-match/fold.js gates VIS-001 on `px != null` → it cannot fire.
//   • report-visual.js already prints "pixel n/a"; annotate.js already treats shots.diff as optional.
// Emitting it as an "advisory number" instead would have meant a new half-live path through all four.
//
// DEFAULT IS like-for-like: today's behaviour, byte-for-byte, for every existing caller. Anything
// unrecognised (undefined / null / typo / garbage) also lands on like-for-like — this normalizer fails
// TOWARD the status quo, never silently into the quieter mode.
const MODES = ['like-for-like', 'redesign'];
function normalizeMode(m) { return MODES.includes(m) ? m : 'like-for-like'; }

// ── COMPARISON AXES — "what to compare" ─────────────────────────────────────────────────────────────
// STRUCTURE (element presence / geometry / text / colour) is the spine and is ALWAYS compared — it is
// the backbone the whole comparison hangs on and is never gated. On TOP of it sit three OPTIONAL sensors
// the operator can switch off in the pre-check:
//   • pixel      — the sharp pixel-diff pass (STILL also gated by mode: redesign => off regardless).
//   • background — the CSS background-image comparison inside structDelta (the rb!==cb block).
//   • typography — the font-drift sweep (FONT_SWEEP) + drift() compare.
// Fails TOWARD the status quo, exactly like normalizeMode: absent, non-object, garbage, or all-true =>
// byte-identical to today. Only an EXPLICIT `false` turns a sensor off — any other value reads as ON —
// so an old caller that passes no axes and a caller that passes { } are both "everything on".
function normalizeAxes(a) {
  const o = (a && typeof a === 'object') ? a : {};
  return { pixel: o.pixel !== false, background: o.background !== false, typography: o.typography !== false };
}

// ── REAL DEVICES ──────────────────────────────────────────────────────────────────────────────────
// Verified against each vendor's published spec (native px ÷ scale factor), 2026-07-15. Sourcing:
// docs/sgen-site-qa/VIEWPORT-MATRIX-FIX-SPEC.md §7. Dense across the phone band where most real-world
// breakage lives — commodity tools (Percy/Chromatic/Backstop) default to 2–4 widths. Override with
// opts.viewports (e.g. SG-Builder authoring breakpoints 1920/1199/991/767/575/480 for SGB candidates);
// an override entry carrying only {label,width,height} degrades safely to width-only, as before.
//
// KEEP IN SYNC with lib/migration-qa/checks-render.js — same table, same labels, same UA policy. The
// labels are the contract: sgen-qa-serve.js maps its viewport chips to these strings, and they end up
// in evidence filenames. (Both files carrying their own copy is the pre-existing shape; a shared
// device-matrix module would be the real cure for the duplication.)
const DEVICES = [
  { label: '1920 · Desktop',          width: 1920, height: 1080, dpr: 1,    touch: false, ua: null      },
  { label: '1440 · MacBook Air',      width: 1440, height: 900,  dpr: 2,    touch: false, ua: null      },
  { label: '1180 · iPad Air 11 (LS)', width: 1180, height: 820,  dpr: 2,    touch: true,  ua: 'ipad'    },
  { label: '820 · iPad Air 11',       width: 820,  height: 1180, dpr: 2,    touch: true,  ua: 'ipad'    },
  { label: '744 · iPad mini',         width: 744,  height: 1133, dpr: 2,    touch: true,  ua: 'ipad'    },
  { label: '414 · iPhone XR/11',      width: 414,  height: 896,  dpr: 2,    touch: true,  ua: 'ios'     }, // #1 real mobile traffic
  { label: '440 · iPhone 17 Pro Max', width: 440,  height: 956,  dpr: 3,    touch: true,  ua: 'ios'     },
  { label: '393 · iPhone 16',         width: 393,  height: 852,  dpr: 3,    touch: true,  ua: 'ios'     },
  { label: '360 · Galaxy S',          width: 360,  height: 800,  dpr: 3,    touch: true,  ua: 'android' }, // #1 real Android traffic
  { label: '384 · Galaxy S Ultra',    width: 384,  height: 832,  dpr: 3.75, touch: true,  ua: 'android' },
];

// ── BREAKPOINT PROBES — NOT devices ───────────────────────────────────────────────────────────────
// Framework boundaries (Tailwind/Bootstrap). Worth comparing — layouts break exactly ON a boundary —
// but labeled for what they are, and emulating nothing: width only.
const BREAKPOINTS = [
  { label: '1280 · xl boundary', width: 1280, height: 900  },
  { label: '1024 · lg boundary', width: 1024, height: 1366 }, // also real: iPad Air 13 portrait
  { label: '768 · md boundary',  width: 768,  height: 1024 }, // NOT an iPad — none since 2021-09-14
];

// Blink renders this comparison, so only the Android UA is a truthful pairing; iOS/iPadOS need WebKit
// and are deliberately left on the default UA rather than lying twice. See checks-render.js for the
// full policy note.
const UA = {
  android: 'Mozilla/5.0 (Linux; Android 15; SM-S931B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
  ios: null, ipad: null,
};

const VIEWPORTS = [...DEVICES, ...BREAKPOINTS];

// hasTouch / deviceScaleFactor / userAgent are BrowserContext-creation options — this tool already
// builds one context per viewport, so real emulation is free here.
function contextOptionsFor(d) {
  return {
    viewport: { width: d.width, height: d.height },
    deviceScaleFactor: d.dpr || 1,
    hasTouch: !!d.touch,
    // isMobile: DELIBERATELY OMITTED — it makes window.innerWidth report the LAYOUT viewport (which
    // expands to fit overflow, or falls back to 980 with no viewport meta). The READ sweep below
    // measures element geometry against the real viewport; isMobile would silently distort every
    // structural x/y/w/h it records. See VIEWPORT-MATRIX-FIX-SPEC.md §3.2. Do not add it.
    ...(d.ua && UA[d.ua] ? { userAgent: UA[d.ua] } : {}),
  };
}

// In-page: read the DOM as section -> element records. Returns visible elements with the info a
// human uses to judge "does this match": what it is, where it sits, what it says, how it looks.
const READ = `(function(){
  function vis(el){ if(!el.getClientRects().length) return false; var s=getComputedStyle(el); if(s.visibility==='hidden'||s.display==='none'||+s.opacity===0) return false; var r=el.getBoundingClientRect(); return r.width>1&&r.height>1; }
  function secOf(el){ var n=el,L={header:1,nav:1,main:1,footer:1,section:1,article:1,aside:1}; while(n&&n.nodeType===1){ if(L[n.tagName.toLowerCase()]) return n.tagName.toLowerCase(); n=n.parentElement; } return 'body'; }
  function nearestHeading(el){ var sc=el,L={header:1,nav:1,main:1,footer:1,section:1,article:1,aside:1}; while(sc&&sc.nodeType===1){ if(L[sc.tagName.toLowerCase()])break; sc=sc.parentElement; } sc=sc||document.body; var h='',all=sc.querySelectorAll('h1,h2,h3'); for(var i=0;i<all.length;i++){ if(all[i].compareDocumentPosition(el)&Node.DOCUMENT_POSITION_FOLLOWING) h=(all[i].textContent||'').trim().slice(0,50); } return h; }
  // background-image identity: the file name from a url(...) background, 'gradient' for a gradient, or ''
  // for none. Mirrors how <img> src is reduced to a filename below, so a CSS background and an <img> read
  // comparably. String-only parse (no backslash-escaped regex) so the READ template stays literal-safe.
  // This is the field the structural comparison was blind to before v5 ("ignores background images").
  function bgUrl(cs){ var b=cs.backgroundImage; if(!b||b==='none') return ''; var i=b.indexOf('url('); if(i>=0){ var s2=b.slice(i+4); var c=s2.indexOf(')'); var inner=(c<0?s2:s2.slice(0,c)).trim().replace(/^["']+|["']+$/g,''); return (inner.split('/').pop()||'').slice(0,60); } return /gradient/i.test(b)?'gradient':''; }
  var TAGS='h1,h2,h3,h4,p,a,button,img,ul,ol,section,header,footer,nav,form,input,label,table,figure,blockquote,[role=button]';
  var out=[], seen=0, capEls=new Set();
  Array.prototype.forEach.call(document.querySelectorAll(TAGS),function(el){
    if(seen>1200||!vis(el))return; seen++;
    var r=el.getBoundingClientRect(), s=getComputedStyle(el);
    var txt=(el.tagName==='IMG')?(el.getAttribute('alt')||'').slice(0,60):(el.childElementCount?'' :(el.textContent||'').trim().slice(0,80));
    var href=(el.tagName==='A')?((el.getAttribute('href')||'').replace(location.origin,'').trim().slice(0,60)):'';
    var aria=(el.getAttribute('aria-label')||el.getAttribute('title')||'').trim().slice(0,60);
    var ialt='';if(!txt&&el.querySelector){var im=el.querySelector('img');if(im)ialt=(im.getAttribute('alt')||'').trim().slice(0,60);}
    capEls.add(el);
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
      bgImg: bgUrl(s),
      src: el.tagName==='IMG'?((el.currentSrc||el.src||'').split('/').pop()||'').slice(0,60):''
    });
  });
  // Supplementary sweep — elements carrying a real url() BACKGROUND IMAGE that the semantic TAGS set
  // above misses (hero <div>s, CSS-art panels). Bounded: visible, >=40x40, deduped against the main set,
  // capped at 300 records / 6000 elements examined so it can never dominate capture runtime. Without this
  // a redesign that drops or swaps a hero background stays invisible to the structural comparison.
  var bgSeen=0, examined=0;
  Array.prototype.forEach.call(document.querySelectorAll('*'),function(el){
    if(bgSeen>=300||examined>=6000) return; examined++;
    if(capEls.has(el)) return;
    var cs=getComputedStyle(el); var fn=bgUrl(cs);
    if(!fn||fn==='gradient') return;                 // only real image backgrounds carry section art
    if(!vis(el)) return;
    var r=el.getBoundingClientRect(); if(r.width<40||r.height<40) return;
    bgSeen++;
    out.push({ tag: el.tagName.toLowerCase(), sec: secOf(el), head: nearestHeading(el),
      text:'', href:'', aria:(el.getAttribute('aria-label')||'').trim().slice(0,60), ialt:'',
      x: Math.round(r.left), y: Math.round(r.top+window.scrollY), w: Math.round(r.width), h: Math.round(r.height),
      font:'', size:0, weight:'', color:cs.backgroundColor, bg:cs.backgroundColor, bgImg:fn, src:'', isBg:1 });
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

// Explain an EMPTY comparison. A visual comparison that yields zero page pairs otherwise completes as a
// silent "success" (pairs:0, no report) and the operator cannot tell WHY — most often because the
// REFERENCE returned non-200 (a WAF 403, or a connection failure) so aHtml came back empty. Pure + total
// over the shape run() already computes: returns null when the comparison is healthy (pairs.length > 0),
// else { ok:false, reason, message } naming the cause in operator language. refStatuses / candStatuses are
// the DISTINCT HTTP status numbers seen crawling each side (0 = a fetch/connection failure). refErrors /
// candErrors are the distinct low-level failure CODES behind those zeros (see http.js failureCode) — a
// status of 0 says the fetch threw but not why, and the causes below need different actions. No browser,
// no I/O — unit-testable, and additive: an existing caller that ignores the field is unaffected.
function diagnoseEmpty({ aHtml = [], bHtml = [], refStatuses = [], candStatuses = [], refErrors = [], candErrors = [], pairs = [] } = {}) {
  if (pairs.length > 0) return null;
  // one wording rule, applied to whichever side came back empty (site = the noun, urlNoun = the URL label)
  const explain = (statuses, errors, site, urlNoun) => {
    const blocked = statuses.find(s => s === 401 || s === 403);
    if (blocked != null) return `The ${site} blocked this scanner (HTTP ${blocked}). It is likely blocking this scanner's IP — ask the site owner to allowlist it, or point at a source this tool can reach.`;
    if (statuses.includes(0) || statuses.length === 0) {
      // Splitting these four apart matters. The old single message read "DNS or connection failure …
      // check the URL is correct", which blames the ADDRESS for what is usually a ROUTE — and cost a
      // real investigation: a reference site that resolved fine, served 200 to the rest of the world,
      // and was simply blackholed from the operator's own network.
      const has = re => errors.some(c => re.test(String(c)));
      // Only an unresolvable name makes the address itself the suspect.
      if (has(/ENOTFOUND|EAI_AGAIN|ERR_NAME/i))
        return `The ${site}'s domain could not be resolved (DNS). Check the ${urlNoun} URL is spelled correctly.`;
      // Resolved, then silence. The address is fine; the path to it is not — so point outward, and say
      // plainly that "unreachable from here" is a weaker claim than "down".
      // UND_ERR_* are undici's own codes, and are what actually turn up in practice: its internal
      // connect timeout fires before our AbortController does, so a blackholed host reports
      // UND_ERR_CONNECT_TIMEOUT and never ETIMEDOUT. Matching only the POSIX-looking names silently
      // misses the single most common real-world failure.
      if (has(/ETIMEDOUT|ETIMEOUT|EHOSTUNREACH|ENETUNREACH|ECONNRESET|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT|UND_ERR_SOCKET/i))
        return `The ${site} resolved, but never answered — the connection timed out. The site may well be up and simply unreachable from THIS network (an ISP route, a firewall, or a VPN that needs switching on). Confirm it loads from another network before treating it as down.`;
      if (has(/ECONNREFUSED/i))
        return `The ${site} refused the connection — something is answering at that address but rejecting the request (wrong port, or the service is stopped).`;
      if (has(/CERT|TLS|SSL|EPROTO|ERR_SSL/i))
        return `The ${site} failed its TLS handshake — a certificate or protocol problem, not a missing page.`;
      // No usable evidence. Stay vague on purpose rather than assert a cause we cannot prove.
      return `Could not connect to the ${site} (connection failure). Check the ${urlNoun} URL is reachable.`;
    }
    return `The ${site} returned no crawlable pages (statuses: ${statuses.join(', ')}).`;
  };
  if (aHtml.length === 0) return { ok: false, reason: 'reference-unreachable', message: explain(refStatuses, refErrors, 'reference site', 'reference') };
  if (bHtml.length === 0) return { ok: false, reason: 'candidate-unreachable', message: explain(candStatuses, candErrors, 'candidate (staging) site', 'candidate') };
  if (pairs.length === 0) return { ok: false, reason: 'no-common-pages', message: 'Both sites were reachable, but they share no matching page paths — check the reference and target URLs line up (same paths on live vs staging).' };
  return null;
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
// opts.background = compare CSS background-image (the rb!==cb block below). Default (no opt / anything not
// === false) = compare, i.e. v5 behaviour byte-for-byte. axes.background:false threads through here to
// SKIP only that block; structure/text/font/size/colour comparison is untouched. Fails toward the status
// quo — an existing caller with no third arg keeps comparing backgrounds.
function structDelta(refEls, candEls, opts = {}) {
  const compareBg = opts.background !== false;
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
    // background-image: the axis the structural comparison was blind to before v5. A matched element that
    // lost, gained, or swapped its CSS background is a real design difference — and it is the ONLY sensor
    // for backgrounds on a redesign-mode run (pixel pass off). Tagged bg:true so the grader can weight a
    // background change (DEFECT) distinctly from a text-colour tweak.
    const rb = r.bgImg || '', cb = c.bgImg || '';
    const bgChanged = compareBg && rb !== cb;   // axes.background:false => never flag a bg diff (block skipped)
    if (bgChanged) {
      if (rb && !cb) styleDiffs.push(`background removed (${rb})`);
      else if (!rb && cb) styleDiffs.push(`background added (${cb})`);
      else styleDiffs.push(`background ${rb}→${cb}`);
    }
    if (styleDiffs.length) restyled.push({ el: r, diffs: styleDiffs, bg: bgChanged });
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

// warmLoads = TOTAL page loads to run before the capture (first goto + reloads). Default 3, clamped to
// [1,5] so it can't blow up runtime; non-numeric (undefined/NaN/garbage) → default 3. One shared clamp so
// readAndShoot and run always agree.
function clampWarmLoads(n) {
  let v = Math.round(Number(n));
  if (!Number.isFinite(v)) v = 3;
  return Math.max(1, Math.min(5, v));
}

// opts.fontSweep = also run font-checks' FONT_SWEEP on this load and hang the raw facts on
// `read.fontSweep`. OFF by default and requested by run() for ONE viewport per page pair only — see the
// call site. It piggybacks on a page this function already navigated + warmed, so it costs no extra
// load; a failure is swallowed into read.fontSweepError and can never cost the caller its capture.
async function readAndShoot(browser, url, vp, shotPath, warmLoads = 3, opts = {}) {
  const loads = clampWarmLoads(warmLoads);
  const ctx = await browser.newContext(contextOptionsFor(vp));
  const page = await ctx.newPage();
  let read = { count: 0, els: [] };
  try {
    // Warm-load: prime lazy / CDN-cold assets + fonts by loading the page `loads` times before capture,
    // so a cold first paint doesn't read as a false diff. The FIRST navigation is load-bearing — a
    // genuinely dead URL still throws here and is reported exactly as before. The extra reloads are
    // best-effort warm-ups: a transient reload failure is swallowed so it can't abort a good capture.
    await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
    for (let i = 1; i < loads; i++) {
      try {
        await page.reload({ waitUntil: 'networkidle', timeout: 45000 });
        await page.waitForTimeout(400);          // brief settle (~300–500ms) between warm loads
      } catch (_) { /* transient reload failure — keep the last good load and continue to capture */ }
    }
    await page.waitForTimeout(900);
    // Dismiss consent-class overlays (cookie banner / age gate / T&C) so the comparison sees the real
    // page — not the gate — using the same deterministic ruleset the Site Audit + render pass use.
    let consentHit = null;
    try { const c = await dismissOverlays(page); if (c && c.dismissed.length) { consentHit = c.dismissed; await page.waitForTimeout(300); } } catch (e) {}
    // Deadlined for the same reason capture.js is: page.evaluate never times out on its own, so a page
    // that stops answering takes the whole comparison with it. The budget is far above any real read
    // (READ walks the DOM once), so the comparison algorithm and its timing are unchanged — this only
    // decides how long a DEAD page is waited on. A blown budget throws, which the catch below already
    // records as read.error, exactly like any other failed read.
    const structural = await withDeadline(page.evaluate(READ), READ_BUDGET_MS, READ_TIMED_OUT);
    if (structural === READ_TIMED_OUT) throw new Error(`the page stopped responding — the structural read exceeded ${Math.round(READ_BUDGET_MS / 1000)}s`);
    read = structural;
    read.warmLoads = loads;             // additive evidence: how many loads primed this capture
    if (consentHit) read.consent = consentHit;
    // Font facts for the drift comparison. Read HERE — right after READ, before stableCapture's
    // lazy-load scroll pass touches anything — mirroring checks-render.js, which takes its font
    // reading before its viewport loop resizes anything. Both sides of a pair run this identical
    // code at the identical viewport, so the two sweeps are always directly comparable.
    if (opts.fontSweep) {
      try { read.fontSweep = await page.evaluate(FONT_SWEEP); }
      catch (e) { read.fontSweepError = (e.message || '').slice(0, 140); }
    }
    read.capture = await stableCapture(page, { fullPage: true, path: shotPath, engine: 'chromium' });
  } catch (e) { read.error = (e.message || '').slice(0, 140); }
  // close() has no timeout of its own and waits forever on a browser that has stopped answering. The
  // capture and the read are already done at this point, so waiting past the budget can only cost the
  // comparison — never improve it.
  await withDeadline(ctx.close(), CLOSE_BUDGET_MS, null);
  return read;
}

async function run(refUrl, candUrl, { maxPages = 20, urlMap = null, outDir, viewports = null, warmLoads = 3, mode = 'like-for-like', axes = null, log = () => {}, progress = () => {} } = {}) {
  const VPS = (Array.isArray(viewports) && viewports.length) ? viewports : VIEWPORTS;
  const warm = clampWarmLoads(warmLoads);   // total loads per capture, clamped to [1,5]
  const MODE = normalizeMode(mode);
  const AXES = normalizeAxes(axes);         // "what to compare" — absent/all-true => today's behaviour
  const pixelOn = (MODE === 'like-for-like') && AXES.pixel;   // pixel gated by BOTH mode and the axis
  log(`Warm-up loads per capture: ${warm} (applied to reference + candidate, every viewport).`);
  log(pixelOn
    ? 'Comparison mode: like-for-like — pixel pass ON (same design, new platform).'
    : 'Comparison mode: redesign — pixel pass OFF. The sites are meant to look different, so a pixel diff would only measure that intent. Match scores below are STRUCTURAL only; screenshots are still captured for both sides.');
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
  // Distinct HTTP statuses seen on each crawl (0 = fetch/connection failure), and the diagnosis of an
  // EMPTY pairing — so a blocked/unreachable reference reports the REASON instead of a silent 0-pair run.
  const refStatuses = [...new Set((A.pages || []).map(p => p.status))];
  const candStatuses = [...new Set((B.pages || []).map(p => p.status))];
  // The failure CODES behind any status-0 pages — this is what separates "you typed the domain wrong"
  // from "this network cannot reach an otherwise healthy site". Empty when nothing threw.
  const refErrors = [...new Set((A.pages || []).map(p => p.errorCode).filter(Boolean))];
  const candErrors = [...new Set((B.pages || []).map(p => p.errorCode).filter(Boolean))];
  const diagnostic = diagnoseEmpty({ aHtml, bHtml, refStatuses, candStatuses, refErrors, candErrors, pairs });
  log(`Paired ${pairs.length} page(s) by path (${unmatchedRef.length} reference page(s) with no candidate match).`);

  const browser = await chromium.launch({ headless: true });
  const slug = s => s.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'home';
  const pageResults = [];
  let done = 0;
  for (const pr of pairs) {
    const vps = [];
    let fontDrift = null, fontDriftAt = null, fontsMatched = null;
    for (const vp of VPS) {
      const nameOf = component => evidenceName({ page: slug(pr.path), section: 'visual-match', component, viewport: vp.label });
      const refShot = path.join(shotsDir, nameOf('reference'));
      const candShot = path.join(shotsDir, nameOf('candidate'));
      const diffShot = path.join(shotsDir, nameOf('diff'));
      // Font drift is a PAGE-level fact, not a viewport-level one — a family the reference renders is
      // either used somewhere on the candidate or it is not, and that answer does not change with the
      // window width. So sweep ONCE per page pair, on the first viewport in play (by default
      // `1920 · Desktop`: dpr1, no touch, no UA — the nearest thing this engine has to the pinned
      // metrics context checks-render.js uses for the same reason). Running it inside this loop would
      // emit the identical finding once per viewport — 13x duplicates on the default matrix.
      // typography axis: OFF => never run FONT_SWEEP and never call drift(); fontDrift stays null, so the
      // page result simply omits the fontDrift block (same shape as a pair whose sweep didn't complete).
      const sweepHere = (vps.length === 0) && AXES.typography;
      const refRead = await readAndShoot(browser, pr.a, vp, refShot, warm, { fontSweep: sweepHere });
      const candRead = await readAndShoot(browser, pr.b, vp, candShot, warm, { fontSweep: sweepHere });
      if (sweepHere && refRead.fontSweep && candRead.fontSweep) {
        // Belt-and-braces: drift() is pure and total over the sweep shape, but a comparison run must
        // NEVER die because a font sweep surprised us. Worst case we report no drift for this page.
        try {
          fontDrift = drift(refRead.fontSweep, candRead.fontSweep); fontDriftAt = vp.label;
          // Name the families that DID carry over. drift() only returns what was LOST, so on a clean pair
          // it returns [] and the report could only ever say "no drift" — an absence. The reader cannot
          // tell that from "the sweep found nothing to compare". Recording the matched families makes a
          // font PASS checkable: it names what was compared, not just what failed. Same GENERIC filter
          // drift() applies, imported rather than re-typed so the two lists cannot disagree.
          const rUsed = Object.keys(refRead.fontSweep.used || {}).filter(x => !GENERIC.test(x));
          const cUsed = Object.keys(candRead.fontSweep.used || {});
          fontsMatched = rUsed.filter(x => cUsed.includes(x));
        }
        catch (e) { fontDrift = null; fontsMatched = null; log(`  font drift skipped on ${pr.path}: ${(e.message || '').slice(0, 80)}`); }
      }
      // mode gate: on a redesign the pixel pass is skipped, not softened — see MODES above.
      let pix = { pct: null };
      if (pixelOn) {
        try { if (fs.existsSync(refShot) && fs.existsSync(candShot)) pix = await pixelDiff(refShot, candShot, diffShot); } catch (e) { pix = { pct: null, note: e.message }; }
      } else pix = { pct: null, note: 'pixel pass off — redesign mode' };
      const sd = structDelta(refRead.els || [], candRead.els || [], { background: AXES.background });
      const visScore = pix.pct == null ? null : Math.max(0, +(100 - pix.pct).toFixed(1));
      const matchScore = (visScore == null) ? sd.structScore : +(((sd.structScore + visScore) / 2)).toFixed(1);
      vps.push({ label: vp.label, pixelMismatchPct: pix.pct, visScore, struct: sd, matchScore,
        shots: { ref: path.relative(outDir, refShot), cand: path.relative(outDir, candShot), diff: fs.existsSync(diffShot) ? path.relative(outDir, diffShot) : null },
        capture: { ref: refRead.capture || null, cand: candRead.capture || null },
        errors: [refRead.error, candRead.error].filter(Boolean) });
    }
    const pageScore = +(vps.reduce((a, v) => a + (v.matchScore || 0), 0) / vps.length).toFixed(1);
    // fontDrift sits on the PAGE, next to pageScore — not on a viewport — because that is the shape of
    // the fact. `[]` means "swept, no drift"; absent means "the sweep did not complete on this pair".
    pageResults.push({ path: pr.path, ref: pr.a, cand: pr.b, pageScore, viewports: vps,
      ...(fontDrift ? { fontDrift, fontDriftAt, fontsMatched: fontsMatched || [] } : {}) });
    done++; progress(20 + Math.round(done / pairs.length * 76), `compared ${done}/${pairs.length}`);
    log(`  ${pr.path} — ${pageScore}% match${fontDrift && fontDrift.length ? ` · ${fontDrift.length} font drift: ${fontDrift.map(d => d.family).join(', ')}` : ''}`);
  }
  await browser.close();
  const overall = pageResults.length ? +(pageResults.reduce((a, p) => a + p.pageScore, 0) / pageResults.length).toFixed(1) : 0;
  // `mode` is recorded IN the result, not just accepted as an argument: it is a fact about HOW this
  // run was performed, so every downstream consumer (fold, report, stored JSON re-read months later)
  // can read it off the artifact instead of being re-told out of band.
  return { reference: refUrl, candidate: candUrl, generated: new Date().toISOString(), overall,
    pairs: pairs.length, unmatchedRef, viewports: VPS.map(v => v.label), warmLoads: warm, mode: MODE,
    axes: AXES, pixelPass: pixelOn, pages: pageResults, sharp: !!sharp,
    refStatuses, candStatuses, refErrors, candErrors, diagnostic };
}

module.exports = { run, readAndShoot, clampWarmLoads, normalizeMode, normalizeAxes, MODES, VIEWPORTS, DEVICES, BREAKPOINTS, UA, contextOptionsFor, structDelta, pixelDiff, pairByPath, pathOf, diagnoseEmpty };
