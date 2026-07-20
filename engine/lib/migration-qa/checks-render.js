'use strict';
// migration-qa/checks-render.js — the headless Playwright pass.
//
// Covers the v2.0 checks that need a real render: console/JS errors, failed asset requests
// (missing CSS/fonts/images), Core Web Vitals (LCP/CLS), AA color-contrast, and responsive
// overflow / tap-targets / small-font across the device×orientation matrix — plus a screenshot
// per page×viewport as manual-review evidence.
//
// Reuse: browser+console+network capture mirrors W2 08-scripts/capture.js; the in-page sweep is
// a repo-local copy of the sgen-frontend-qa sweep pattern (kept in-repo for portability). INP is
// interaction-based and cannot be measured headlessly — it is left to the manual checklist.

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { stableCapture } = require('../site-qa/capture');
const { evidenceName } = require('../site-qa/evidence-name');
const { dismissOverlays, detectBlockingOverlay } = require('../site-qa/consent');
const { DESCRIBE_ELEMENTS } = require('../site-qa/lib/evidence-providers');
const { runFontChecks } = require('../site-qa/font-checks');

// axe-core (free, MIT) — the industry-standard WCAG engine. Loaded once if installed; if absent the
// render pass skips it and reports A11Y-001 as UNVERIFIED (see `unverified` below) — never a fake pass.
//
// NOT IN dependencies, DELIBERATELY. Measured 2026-07-16, do not "fix" this by adding it:
//   • userData/engines/<version>/node_modules is a JUNCTION to the desktop app's bundled
//     resources/engine/node_modules. That is where playwright and sharp actually resolve from
//     (verified with require.resolve from the installed 3.0.3 engine). A hot engine ships
//     sgen-qa-serve.js + lib/ + package.json ONLY and extracts to a NEW engines/<version>/ dir —
//     whose node_modules junction points at the SAME app bundle. A dependency added here therefore
//     never arrives on a desktop install; it would only be a promise package.json cannot keep.
//   • The git-install path (sgen-update.js) runs `npm ci` ONLY when package-lock.json's hash
//     changes. This repo HAS no package-lock.json, so that gate cannot fire there either.
// Adding axe-core to deps without an app-side install would leave this require failing on every
// machine exactly as it does now, while the manifest claimed otherwise. Honest absence beats that.
let AXE_SRC = null;
try { AXE_SRC = fs.readFileSync(require.resolve('axe-core')).toString(); } catch (e) { AXE_SRC = null; }

// ── REAL DEVICES ──────────────────────────────────────────────────────────────────────────────────
// Verified against each vendor's published spec (native px ÷ scale factor), 2026-07-15. Sourcing:
// docs/sgen-site-qa/VIEWPORT-MATRIX-FIX-SPEC.md §7. Aligned to site-qa/visual-match — same table.
//
// `touch` REPLACES the old `mobile:` flag. `mobile:` was dead config: it appeared only inside these
// literals and was never read anywhere in the tree. `touch` IS read — it becomes the context's
// hasTouch, which decides real touch emulation AND gates tap-targets in SWEEP (see the gate below).
// `height` is the panel height; SWEEP is width-driven, so height is presentational — kept truthful anyway.
// `contrast:true` marks the single entry that runs the (viewport-independent) AA contrast sweep once.
// Ordered so the (dpr, touch, ua) context grouping in renderPass falls out as contiguous runs.
const DEVICES = [
  { label: '1920 · Desktop',          width: 1920, height: 1080, dpr: 1,    touch: false, ua: null,      contrast: true },
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
// Framework boundaries (Tailwind/Bootstrap). They earn their place — layouts break exactly ON a
// boundary — but they are labeled for what they are, and emulate nothing: width only, no dpr, no
// touch, no UA. That is why they carry no `dpr`/`touch`/`ua`: they fall into the same (1, false, none)
// context as `1920 · Desktop`, so all three probes cost ZERO extra navigations.
const BREAKPOINTS = [
  { label: '1280 · xl boundary', width: 1280, height: 900  },
  { label: '1024 · lg boundary', width: 1024, height: 1366 }, // also real: iPad Air 13 portrait
  { label: '768 · md boundary',  width: 768,  height: 1024 }, // NOT an iPad — none since 2021-09-14
];

// UA override policy. The render pass runs Chromium (Blink). Handing Blink an iOS Safari UA yields
// Blink rendering behind a Safari UA — a different lie from the one being fixed. Override only where
// the pairing is truthful:
//   'android'    -> Chrome-on-Android UA (Blink + Android UA is a real, shipping pairing)
//   'ios'/'ipad' -> NO override. Real iOS rendering needs the WebKit engine; cross-engine emulation of
//                   the responsive matrix is a larger change and is deliberately out of scope here.
// KNOWN LIMITATION, stated plainly: because the iOS lane gets no UA override, a UA-SNIFFING site still
// serves the desktop variant to the iPhone/iPad entries. Only the Android lane closes that gap. Touch
// and DPR are engine-independent and DO apply to every touch entry — that is where most of the value is.
const UA = {
  android: 'Mozilla/5.0 (Linux; Android 15; SM-S931B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
  ios: null, ipad: null,
};

// The full ordered matrix: devices first, then the honestly-labeled probes. This is the order findings
// and screenshots are emitted in, and the set opts.viewports filters against.
const VIEWPORTS = [...DEVICES, ...BREAKPOINTS];

// Context identity = every emulation option that CANNOT be changed after a context is created.
// deviceScaleFactor + hasTouch survive setViewportSize() (measured), so entries sharing an identity
// collapse onto ONE context and ONE navigation, resized between sweeps.
//
// NOTE — deliberate deviation from spec §4.5, which keys on (dpr, touch) ONLY. `userAgent` is a
// context-creation option too (Playwright has no page.setUserAgent — verified: it is undefined). Keying
// without it puts `360 · Galaxy S` (android UA) in the same group as 440/393 (ios lane, NO override);
// the group's options come from one member, so the Android UA — the ONLY override §4.2 argues for —
// is silently dropped. Measured: the 360 entry then renders with the desktop HeadlessChrome UA.
// Keyed on (dpr, touch, ua) the matrix is 6 groups = 6 navigations per URL, still the spec's headline
// number, because `1920 · Desktop` + all 3 probes share the metrics context.
const groupKeyOf = v => `${v.dpr || 1}|${v.touch ? 1 : 0}|${(v.ua && UA[v.ua]) || '-'}`;

// hasTouch / deviceScaleFactor / userAgent are BrowserContext-creation options; setViewportSize()
// cannot set them. This is the ONLY place emulation is configured.
function contextOptionsFor(d) {
  return {
    viewport: { width: d.width, height: d.height },
    deviceScaleFactor: d.dpr || 1,
    hasTouch: !!d.touch,                  // -> 'ontouchstart', pointer:coarse, hover:none
    // isMobile: DELIBERATELY OMITTED — see SPEC §3.2. isMobile switches Chromium to the dual-viewport
    // mobile model, and window.innerWidth then reports the LAYOUT viewport: it expands to fit
    // overflowing content, or falls back to 980 on a page with no viewport meta. SWEEP reads
    // `var W = window.innerWidth`, so isMobile SILENTLY DISABLES RESP-002/003/004 on exactly the broken
    // pages they exist to catch — the tool reports green on a broken site. Measured on a 600px block at
    // 430: innerWidth 616 (with meta) / 980 (without), overflow MISSED in both. It buys nothing hasTouch
    // does not already give (touch, pointer:coarse and hover:none are identical either way) and is the
    // only option that breaks anything. DO NOT "fix" this by adding it.
    ...(d.ua && UA[d.ua] ? { userAgent: UA[d.ua] } : {}),
  };
}

// LCP + CLS accumulator, installed before any page script runs.
//
// `lcpSeen` / `clsObserved` EXIST TO SEPARATE "measured, and it is good" FROM "never measured".
// The old shape seeded {lcp:0, cls:0} and the grader only ever asked `lcp > 4000` / `lcp > 2500`.
// lcp===0 is precisely what LCP reads when NOTHING WAS MEASURED (observer unsupported, navigation
// failed, context torn down before the read) — so the unmeasured case fell through every threshold,
// emitted no finding, and audit.js's "no cwv-lcp finding ⇒ pass" rule printed "Largest Contentful
// Paint within target". Across all 72 stored runs not one passing speed row carries a real
// measurement. A zero that means "unknown" must never be graded against a threshold that means "fast".
//
// The two flags are NOT symmetrical, on purpose:
//   • lcpSeen     — set only when an actual LCP entry arrives. LCP has no meaningful zero: a page
//                   that painted has a non-zero LCP, so "no entry" == "not measured".
//   • clsObserved — set when .observe() is ACCEPTED, not when an entry arrives. cls===0 IS a real,
//                   meaningful measurement ("nothing shifted") on a stable page, so gating CLS on
//                   entries arriving would throw away the good news and call a perfect page unknown.
const CWV_INIT = `(function(){
  window.__cwv = { lcp: 0, cls: 0, lcpSeen: false, clsObserved: false };
  try {
    new PerformanceObserver(function(l){ for (const e of l.getEntries()) { window.__cwv.lcpSeen = true; window.__cwv.lcp = Math.max(window.__cwv.lcp, e.renderTime || e.loadTime || e.startTime || 0); } })
      .observe({ type: 'largest-contentful-paint', buffered: true });
  } catch(e){}
  try {
    new PerformanceObserver(function(l){ for (const e of l.getEntries()) { if (!e.hadRecentInput) window.__cwv.cls += e.value; } })
      .observe({ type: 'layout-shift', buffered: true });
    window.__cwv.clsObserved = true;
  } catch(e){}
})();`;

// In-page responsive + contrast sweep. Returns findings with selector + measured value.
const SWEEP = `(function(){
  var W = window.innerWidth, CAP = 10, out = [];
  function vis(el){ if(!el||!el.getClientRects||!el.getClientRects().length) return false; var s=getComputedStyle(el); if(s.visibility==='hidden'||s.display==='none'||+s.opacity===0) return false; var r=el.getBoundingClientRect(); return r.width>0&&r.height>0; }
  function sel(el){ if(!el||el.nodeType!==1) return '(?)'; var p=[],d=0; while(el&&el.nodeType===1&&d<4){ var t=el.tagName.toLowerCase(); if(el.id){p.unshift(t+'#'+el.id);break;} var c=(el.className&&typeof el.className==='string')?el.className.trim().split(/\\s+/)[0]:''; if(c)t+='.'+c; p.unshift(t); el=el.parentElement; d++; } return p.join('>'); }
  // on-page location: nearest enclosing landmark + nearest preceding heading text
  function secOf(el){ if(!el||el.nodeType!==1) return 'whole page'; var n=el,land=''; var L={header:1,nav:1,main:1,footer:1,section:1,article:1,aside:1}; while(n&&n.nodeType===1){ var tg=n.tagName.toLowerCase(); if(L[tg]){land=tg;break;} n=n.parentElement; } var h=''; try{ var all=document.querySelectorAll('h1,h2,h3,h4'); for(var i=0;i<all.length;i++){ var pos=all[i].compareDocumentPosition(el); if(pos&Node.DOCUMENT_POSITION_FOLLOWING) h=(all[i].textContent||'').trim().slice(0,60); } }catch(e){} return h?('\\u201c'+h+'\\u201d'+(land?' ('+land+')':'')):(land||'\\u2014'); }
  // horizontal overflow
  var docW = document.documentElement.scrollWidth;
  if (docW > W + 2){
    out.push({check:'horizontal-overflow',severity:'high',title:'Page scrolls horizontally',detail:'doc width '+docW+'px > viewport '+W+'px',selector:'html',section:'whole page',value:docW+'px'});
    var off=[]; Array.prototype.forEach.call(document.body.getElementsByTagName('*'),function(el){ if(!vis(el))return; var r=el.getBoundingClientRect(); if(r.right>W+1&&r.width<=W*1.5&&r.width>4) off.push([el,Math.round(r.right-W)]); });
    off.sort(function(a,b){return b[1]-a[1];}); off.slice(0,CAP).forEach(function(x){ out.push({check:'overflow-element',severity:'high',title:'Element bleeds past right edge',detail:'',selector:sel(x[0]),section:secOf(x[0]),value:'+'+x[1]+'px'}); });
  }
  // element wider than viewport
  var wc=0; Array.prototype.forEach.call(document.body.getElementsByTagName('*'),function(el){ if(wc>=CAP||!vis(el))return; var r=el.getBoundingClientRect(); if(r.width>W+1){ out.push({check:'element-wider-than-viewport',severity:'high',title:'Element wider than viewport',detail:'',selector:sel(el),section:secOf(el),value:Math.round(r.width)+'px'}); wc++; } });
  // tap targets + input font — ask the PLATFORM, not the width.
  // Was: if (W <= 834) — an arbitrary width standing in for "is this a touch device?" (834 is the iPad
  // Pro 11's CSS width, which the old matrix never even rendered). Touch is really emulated now
  // (hasTouch, per context), so the page can just be asked. Two consequences, both intended:
  //   + tap-targets/input-font now ALSO evaluate on iPad landscape (1180) and every touch entry above
  //     834, which the width gate silently skipped — an iPad is a touch device at any rotation.
  //   - they NO LONGER evaluate on the 768/1024/1280 breakpoint PROBES, which emulate no device by
  //     design. Real tablets at 744 / 820 / 1180 now cover that band with genuine touch instead.
  // NOTE: window.innerWidth (W) above is untouched — see contextOptionsFor()'s isMobile warning.
  // DO NOT add "|| navigator.maxTouchPoints > 0" (SPEC §4.4 proposes it — it is WRONG). Measured on
  // this engine's own Chromium: maxTouchPoints is 10 on a NON-touch context (the host OS's touch
  // capability leaks through) and Playwright's hasTouch:true LOWERS it to 1. So that clause is always
  // true and would fire tap-targets on 1920 desktop and on the width-only probes — and, being read off
  // the host, it makes the gate depend on whether the QA machine has a touchscreen. ontouchstart and
  // pointer:coarse each discriminate perfectly (false/false/true); both are used, belt and braces.
  if ('ontouchstart' in window || matchMedia('(pointer: coarse)').matches){
    var tc=0; Array.prototype.slice.call(document.querySelectorAll('a,button,input,select,textarea,[role=button]')).filter(vis).forEach(function(el){ var r=el.getBoundingClientRect(); if((r.width<44||r.height<44)&&tc<CAP){ out.push({check:'tap-target-small',severity:'medium',title:'Tap target < 44px',detail:'hard to tap on touch',selector:sel(el),section:secOf(el),value:Math.round(r.width)+'x'+Math.round(r.height)}); tc++; } });
    var ic=0; Array.prototype.slice.call(document.querySelectorAll('input,select,textarea')).filter(vis).forEach(function(el){ var f=parseFloat(getComputedStyle(el).fontSize); if(f<16&&ic<CAP){ out.push({check:'input-font-small',severity:'low',title:'Input font < 16px',detail:'iOS zooms on focus',selector:sel(el),section:secOf(el),value:f+'px'}); ic++; } });
  }
  // AA color contrast (sampled visible text) — viewport-independent, run once (desktop caller only)
  if (window.__runContrast){
    function lum(c){ c=c.map(function(v){v/=255; return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4);}); return 0.2126*c[0]+0.7152*c[1]+0.0722*c[2]; }
    function parse(s){ var m=s&&s.match(/rgba?\\(([^)]+)\\)/); if(!m)return null; var p=m[1].split(',').map(function(x){return parseFloat(x);}); if(p.length>=4&&p[3]===0) return null; return [p[0],p[1],p[2]]; }
    function bg(el){ var n=el; while(n&&n.nodeType===1){ var c=parse(getComputedStyle(n).backgroundColor); if(c) return c; n=n.parentElement; } return [255,255,255]; }
    var cc=0, seen={};
    Array.prototype.slice.call(document.querySelectorAll('p,li,span,a,h1,h2,h3,h4,td,label,button')).forEach(function(el){
      if(cc>=CAP||!vis(el))return;
      if(!Array.prototype.some.call(el.childNodes,function(n){return n.nodeType===3&&n.textContent.trim();}))return;
      var st=getComputedStyle(el), fg=parse(st.color); if(!fg)return; var b=bg(el);
      var L1=lum(fg)+0.05, L2=lum(b)+0.05, ratio=L1>L2?L1/L2:L2/L1;
      var fs=parseFloat(st.fontSize), bold=(+st.fontWeight)>=700, large=(fs>=24||(fs>=18.66&&bold));
      var min=large?3:4.5;
      if(ratio<min){ var k=sel(el); if(seen[k])return; seen[k]=1; out.push({check:'low-contrast',severity:'medium',title:'Text below AA contrast',detail:'ratio '+ratio.toFixed(2)+':1 (min '+min+':1)',selector:k,section:secOf(el),value:ratio.toFixed(2)}); cc++; }
    });
  }
  return out;
})();`;

function slug(u) { try { const x = new URL(u); return (x.pathname === '/' ? 'home' : x.pathname).replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'page'; } catch (e) { return 'page'; } }

const ISSUE_SHOT_CAP = 8; // max per-issue element close-ups per page×viewport

const REG = require('../site-qa/rules/registry');
// sweep check-id → native rule id (identity lives in the registry, not the sweep string)
const SWEEP_RULE = {
  'horizontal-overflow': 'RESP-002', 'overflow-element': 'RESP-003', 'element-wider-than-viewport': 'RESP-004',
  'tap-target-small': 'RESP-005', 'input-font-small': 'RESP-006', 'low-contrast': 'A11Y-002',
};
// font/icon check name → native rule id (registry 1.11.0). Same contract as SWEEP_RULE: identity lives
// in the registry, never in the check string. An unmapped check is DROPPED, never guessed at a rule —
// font-checks.js also exports drift() ('font-drift'), which belongs to the comparison lane, not here.
const FONT_RULE = {
  'font-not-loaded': 'FONT-001', 'font-undeclared': 'FONT-002', 'synthetic-bold': 'FONT-003',
  'font-display-missing': 'FONT-004', 'font-preloaded-unused': 'FONT-005', 'synthetic-italic': 'FONT-006',
  'icon-font-not-loaded': 'ICON-001', 'icon-ligature-visible': 'ICON-002', 'icon-tofu': 'ICON-003',
};
// v2.0 report section per check (migration-qa/report.js groups findings by section), aligned to the
// suite each rule scores in: a11y → 7 Accessibility, performance → 6 Performance, icons → 1 Visual
// (a missing icon set is a visual defect, same section sgen-qa-migration gives a broken image).
const FONT_SECTION = {
  'font-not-loaded': '7 Accessibility', 'font-undeclared': '7 Accessibility',
  'synthetic-bold': '7 Accessibility', 'synthetic-italic': '7 Accessibility',
  'font-display-missing': '6 Performance', 'font-preloaded-unused': '6 Performance',
  'icon-font-not-loaded': '1 Visual', 'icon-ligature-visible': '1 Visual', 'icon-tofu': '1 Visual',
};
// F(ruleId, check, section, detail, url, value, over) — identity = ruleId; severity/title from the
// registry unless `over` supplies a per-finding value (axe = dynamic help text; CWV = threshold variants).
function F(ruleId, check, section, detail, url, value, over = {}) {
  const r = REG.getById(ruleId);
  return { ruleId, check, section, severity: over.severity || (r ? r.severity : null), title: over.title || (r ? r.title : ruleId), detail: detail || '', location: url, value: value == null ? '' : String(value) };
}

// The page-level signals — axe, webfont/icon integrity, console, network, CWV — are viewport-INDEPENDENT
// (this file has said so since 2.0) and are measured exactly ONCE per page, on a context pinned to
// 1440x900 @dpr1, no touch, no UA override. That is byte-for-byte the environment they were measured in
// BEFORE this matrix change, deliberately: the responsive matrix moves, those signals do not. Every
// (dpr1, no-touch, no-UA) entry — `1920 · Desktop` and all three BREAKPOINT probes — rides this same
// context, so hosting them costs no extra navigation.
const METRICS_VIEWPORT = { width: 1440, height: 900 };
const PRIMARY_GROUP = groupKeyOf({ dpr: 1, touch: false, ua: null });

// Split the selected entries into one bucket per context identity, preserving matrix order within each.
function groupViewports(list) {
  const groups = new Map();
  for (const v of list) {
    const k = groupKeyOf(v);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(v);
  }
  return groups;
}

// Sweep ONE viewport entry on an already-navigated page whose context already carries that entry's
// emulation (dpr/touch/UA). Findings + shots are buffered into `out` instead of being pushed straight
// through, so the caller can emit them in MATRIX order no matter what order the context groups ran in.
//
// RETURNS true ONLY IF THE SWEEP ACTUALLY RAN. The caller counts a viewport as swept on this return
// value alone — never on the fact that it was requested. This is the whole point: the old body was
// wrapped in one try that swallowed EVERYTHING (resize, evaluate, capture) and returned nothing, so a
// viewport that never rendered was indistinguishable from one that rendered clean. The run then
// reported `activeViewports.map(v => v.label)` — what was ASKED FOR — and the report printed "no
// horizontal overflow across 13 viewports — clean" for a page that broke by 186px on all five phones
// and rendered on none of them. A viewport that did not sweep must not be counted as swept.
async function sweepViewport(page, v, { url, screensDir, runContrast, out, log = () => {} }) {
  try {
    await page.setViewportSize({ width: v.width, height: v.height });
    await page.waitForTimeout(350);
    await page.evaluate(`window.__runContrast = ${!!runContrast};`);
    const res = await page.evaluate(SWEEP);
    // Render Provider: gather rich DOM facts for the FLAGGED selectors only (cost ∝ findings, not DOM).
    let descBySel = {};
    try {
      const sels = [...new Set(res.map(r => r.selector).filter(s => s && s !== 'html' && s !== '(?)'))];
      if (sels.length) descBySel = await page.evaluate(`${DESCRIBE_ELEMENTS}(${JSON.stringify(sels)})`);
    } catch (e) { descBySel = {}; }
    let issueShots = 0;
    for (const r of res) {
      const desc = descBySel[r.selector] || null;
      const finding = { ...F(SWEEP_RULE[r.check], r.check, r.check === 'low-contrast' ? '7 Accessibility' : '4 Responsive', `${r.detail}${r.selector ? ` — ${r.selector}` : ''} [${v.label}]`, url, r.value), items: [{ id: r.selector || '(element)', section: r.section || '—', viewport: v.label, value: `${r.value}${r.detail ? ' · ' + r.detail : ''}`, descriptor: desc ? { ...desc, url } : null }] };
      // per-issue element evidence: page--section--component--issue-<check>--viewport.png
      // (capped per page×viewport so a noisy page can't flood the evidence dir)
      if (r.selector && r.selector !== 'html' && issueShots < ISSUE_SHOT_CAP) {
        const issueFile = path.join(screensDir, evidenceName({ page: slug(url), section: r.section, component: r.selector, issue: r.check, viewport: v.label }));
        try {
          // scale:'css' for the same reason as capture.js: the matrix now emulates real device DPR
          // (2/3/3.75), and the default scale:'device' bakes that multiplier into every evidence
          // shot. A dpr-3 element shot is ~9x the pixels of a dpr-1 one for zero extra information.
          // The emulation itself is untouched — only the capture density changes.
          await page.locator(r.selector).first().screenshot({ path: issueFile, timeout: 2500, scale: 'css' });
          finding.evidence = issueFile;
          out.shots.push({ label: `${v.label} · ${r.check}`, file: issueFile, issue: r.check, section: r.section || '', component: r.selector });
          issueShots++;
        } catch (e) { /* element gone/off-screen — finding stands without its close-up */ }
      }
      out.findings.push(finding);
    }
    // The measurement is DONE at this point: the sweep ran and its findings are buffered. The
    // screenshot below is evidence FOR that measurement, not the measurement itself, so it gets its
    // own guard — a capture that fails (timeout on a huge fullPage shot, disk error) must not
    // retract a sweep that genuinely happened and genuinely found what it found.
    try {
      const file = path.join(screensDir, evidenceName({ page: slug(url), section: 'page', component: 'full', viewport: v.label }));
      // canonical capture: fonts + image-decode + deterministic lazy-load scroll pass before the shot,
      // so below-the-fold images/404s load and surface in the network + broken-asset checks.
      const cap = await stableCapture(page, { fullPage: true, path: file, engine: 'chromium' });
      out.shots.push({ label: v.label, file, capture: cap });
    } catch (e) {
      log(`    ! ${v.label}: swept, but full-page capture failed (${(e.message || e).toString().slice(0, 120)}) — findings stand without the shot`);
    }
    return true;
  } catch (e) {
    // LOUD, and reported as NOT SWEPT. Silence here is the defect: this catch used to swallow the
    // failure whole and leave the caller to claim the viewport as evidence anyway.
    log(`    ! ${v.label}: sweep FAILED (${(e.message || e).toString().slice(0, 120)}) — NOT counted as swept`);
    out.failed.push({ label: v.label, error: (e.message || e).toString().slice(0, 160) });
    return false;
  }
}

async function renderPass(pageUrls, { screensDir, sampleN = 12, viewports = null, log = () => {}, progress = () => {} } = {}) {
  const targets = pageUrls.slice(0, sampleN);
  if (!targets.length) return { findings: [], shots: {}, rendered: 0, sampled: 0, total: pageUrls.length };
  fs.mkdirSync(screensDir, { recursive: true });

  // Viewport picker: filter the matrix (devices + breakpoint probes) to the requested labels (mirrors
  // visual-match's opts.viewports). Absent / empty / no-known-label ⇒ the full VIEWPORTS matrix.
  let activeViewports = VIEWPORTS;
  if (Array.isArray(viewports) && viewports.length) {
    const want = new Set(viewports);
    const filtered = VIEWPORTS.filter(v => want.has(v.label));
    if (filtered.length) activeViewports = filtered;
  }
  // The AA-contrast sweep is viewport-independent and must run exactly ONCE. Normally it is pinned to
  // the entry flagged contrast:true (1920 · Desktop). If the user deselected that viewport, fall back
  // to the FIRST selected viewport so contrast is never silently dropped from the audit.
  const contrastLabel = (activeViewports.find(v => v.contrast) || activeViewports[0] || {}).label;
  // One bucket per context identity. The metrics group is always visited (it carries axe/fonts/CWV/
  // console/network), even when the picker leaves it with no viewport of its own to sweep.
  const groups = groupViewports(activeViewports);

  const findings = [];
  const shots = {}; // url -> [{label, file}]
  const consentByPage = {}; // url -> {dismissed:[{text,selector,container}], stillBlocked}
  let axeRan = false;
  // Labels swept on EVERY rendered page so far (running intersection; null = no page rendered yet).
  // Intersection, not union, because of the exact claim the report makes off this list: audit.js
  // prints "N page(s) × M viewports · clean". That sentence is only true for viewports that swept on
  // ALL N pages — a union would let one page's success vouch for another page's failure.
  let sweptEveryPage = null;
  const sweepFailures = []; // {url, label, error} — every viewport that was asked for and did not run
  const cwvUnmeasured = { lcp: 0, cls: 0 }; // pages where the metric never produced a real reading
  let browser;
  try { browser = await chromium.launch({ headless: true }); }
  catch (e) { log(`Playwright launch failed (${e.message}) — skipping render pass. Run: npx playwright install chromium`); return { findings: [], shots: {}, rendered: 0, sampled: 0, total: pageUrls.length, error: e.message }; }

  let rendered = 0;
  // Pages where the PRIMARY (Chromium) navigation did not complete. See the push site below.
  const navFailures = [];
  for (const url of targets) {
    // Per-label buffers. Context groups run in group order; findings and screenshots are EMITTED in
    // matrix order below, so the report ordering is identical to the single-context version.
    const swept = new Map(activeViewports.map(v => [v.label, { findings: [], shots: [], failed: [] }]));
    // Labels this PAGE actually swept. Intersected across pages into `sweptEveryPage` below.
    const sweptThisPage = new Set();
    shots[url] = [];
    const consoleErr = [], failed = [];
    let totalBytes = 0, reqCount = 0;
    const seenErr = new Set();
    // A JS error thrown only under touch, or only at a phone width, WAS caught before this change —
    // because every viewport shared one page. With one context per emulation group it would be lost, so
    // device contexts report console/network too. Console strings are UNION-ed against what the metrics
    // context already saw (`raw:false`), so re-observing the same error across 6 navigations cannot
    // inflate CON-001's count; the metrics context still pushes raw, duplicates and all, exactly as before.
    const addErr = (s, raw) => { if (raw) { consoleErr.push(s); seenErr.add(s); } else if (!seenErr.has(s)) { consoleErr.push(s); seenErr.add(s); } };
    function watchPage(pg, { raw, weigh }) {
      pg.on('console', m => { if (m.type() === 'error') addErr(m.text().slice(0, 200), raw); });
      pg.on('pageerror', e => addErr('[pageerror] ' + (e.message || '').slice(0, 200), raw));
      pg.on('requestfailed', r => failed.push(`${r.method()} ${r.url().slice(0, 120)} — ${r.failure()?.errorText || '?'}`));
      pg.on('response', r => {
        const s = r.status(); if (s >= 400) failed.push(`${s} ${r.url().slice(0, 120)}`);
        // Page weight is a property of the PAGE, not of how many devices we happen to test it on — so
        // bytes/requests are counted on the metrics context ONLY. `failed` is de-duplicated at use
        // (CON-002), so every context can safely contribute there: that is how a 404 which only a
        // retina or phone-width srcset ever asks for reaches the report.
        if (!weigh) return;
        const cl = parseInt((r.headers()['content-length'] || '0'), 10); if (cl > 0) totalBytes += cl;
      });
      if (weigh) pg.on('request', () => { reqCount++; });
    }

    // ── metrics context (also sweeps `1920 · Desktop` + the breakpoint probes) ──────────────────────
    const ctx = await browser.newContext({ viewport: { ...METRICS_VIEWPORT } });
    await ctx.addInitScript(CWV_INIT);
    const page = await ctx.newPage();
    watchPage(page, { raw: true, weigh: true });

    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
      await page.waitForTimeout(1200);
    } catch (e) {
      consoleErr.push('[navigation] ' + (e.message || '').slice(0, 160));
      // ALSO recorded structurally. Buried in consoleErr this was invisible as what it is: the PRIMARY
      // engine failing to finish navigating. Measured 2026-07-20 — the same page timed out here and was
      // swallowed into a console line, while the cross-browser suite turned the identical timeout into
      // a tier-1 LAUNCH BLOCKER against WebKit. Same failure, two verdicts, and the loud one blamed the
      // wrong thing: a slow page read as a Safari incompatibility. audit.js uses this to attribute the
      // cross-browser row honestly. Additive — no finding, no rule, no scoring change.
      navFailures.push({ url, err: (e.message || '').split('\n')[0].slice(0, 160) });
    }

    // consent-class overlays (cookie banner / age gate / T&C modal): dismiss deterministically so the
    // audit sees the real page. Everything clicked is recorded; a STILL-blocking overlay is flagged —
    // never silently audit a gate screen.
    const consent = await dismissOverlays(page);
    const blocked = await detectBlockingOverlay(page);
    if (consent.dismissed.length || blocked) consentByPage[url] = { dismissed: consent.dismissed, stillBlocked: blocked || null };
    // Say HOW it gates, not just how big it is: "covers N%" was the old wording and it was the lie —
    // a transparent click-through drawer "covers" the viewport while blocking nothing. detectBlockingOverlay
    // now only returns an element that is on-screen AND either intercepts input or paints over the page,
    // so the reason it reports is the measured evidence for the claim this finding makes to the client.
    if (blocked) {
      const how = blocked.reason === 'intercepts'
        ? `blocks interaction across ${Math.round(blocked.cover * 100)}% of the viewport`
        : `paints over ${Math.round(blocked.cover * 100)}% of the viewport`;
      findings.push(F('CON-003', 'blocking-overlay', '10 Technical', `overlay ${blocked.selector} ${how} and could not be auto-dismissed — findings + screenshots for this page reflect the gated view; review manually`, url, blocked.selector));
    }

    // axe-core deep WCAG pass (once per page, at desktop viewport)
    if (AXE_SRC) {
      try {
        await page.addScriptTag({ content: AXE_SRC });
        const violations = await page.evaluate(async () => {
          try { const r = await axe.run(document, { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } }); return r.violations; }
          catch (e) { return null; }
        });
        if (Array.isArray(violations)) {
          axeRan = true;
          for (const v of violations.slice(0, 10)) {
            const sev = (v.impact === 'critical' || v.impact === 'serious') ? 'high' : (v.impact === 'moderate' ? 'medium' : 'low');
            const eg = v.nodes && v.nodes[0] && v.nodes[0].target ? ` · e.g. ${String(v.nodes[0].target[0]).slice(0, 60)}` : '';
            findings.push({ ...F('A11Y-001', 'axe', '7 Accessibility', `${v.id} · ${v.nodes.length} element(s)${eg}`, url, v.impact || '', { severity: sev, title: v.help }), items: (v.nodes || []).slice(0, 25).map(n => ({ id: String((n.target && n.target[0]) || '(element)').slice(0, 90), section: v.id, value: v.impact || '' })) });
          }
        }
      } catch (e) { /* axe injection non-fatal */ }
    }

    // webfont + icon-font integrity (FONT-001..006 / ICON-001..003) — ONCE per page, at the context's
    // 1440x900 viewport, before the viewport loop resizes anything. These signals are viewport-
    // INDEPENDENT (a @font-face either loaded or it didn't), so running them inside the loop would
    // emit the same finding once per device width. Guarded like axe: a font-check failure (CDP
    // unavailable, page torn down mid-sweep) must never break the audit.
    try {
      const { findings: fontFindings } = await runFontChecks(page, ctx);
      for (const ff of fontFindings) {
        const ruleId = FONT_RULE[ff.check];
        if (!ruleId) continue;
        const rule = REG.getById(ruleId);
        // Registry title + severity win by default (the SWEEP precedent). `over` carries a genuine
        // per-finding VARIANT only: FONT-001 downgrades itself to low with its own title when the
        // dead webfont is unused by any element — the same way CWV emits its threshold variants.
        const over = (rule && ff.severity && ff.severity !== rule.severity) ? { severity: ff.severity, title: ff.title } : {};
        // `actual` is the CDP oracle (CSS.getPlatformFontsForNode) — the font that ACTUALLY painted.
        // It turns "it fell back" from inference into evidence, so it belongs in the detail.
        const detail = `${ff.detail || ''}${ff.selector ? ` — ${ff.selector}` : ''}${ff.actual ? ` [actually rendered: ${ff.actual}]` : ''}`;
        findings.push({
          ...F(ruleId, ff.check, FONT_SECTION[ff.check] || '1 Visual', detail, url, ff.value, over),
          items: [{ id: ff.selector || '(element)', section: ff.family ? `font: ${ff.family}` : '—', value: ff.value == null ? '' : String(ff.value) }],
        });
      }
    } catch (e) { /* font checks non-fatal — never break the audit */ }

    // Entries that need no emulation (1920 · Desktop + every breakpoint probe) sweep right here, on the
    // metrics context — same options, so they are free.
    for (const v of (groups.get(PRIMARY_GROUP) || [])) {
      if (await sweepViewport(page, v, { url, screensDir, runContrast: v.label === contrastLabel, out: swept.get(v.label), log })) sweptThisPage.add(v.label);
    }
    // CWV has to be READ while this context is still open; it is EMITTED further down, in its original
    // position relative to the other findings.
    //
    // Seeded to the UNMEASURED state, not to zero-the-value: if this evaluate throws (context torn
    // down, navigation failed) we know nothing about this page's vitals, and "we know nothing" must
    // not decay into "lcp is 0" — which grades as a perfect pass. See CWV_INIT.
    let cwv = { lcp: 0, cls: 0, lcpSeen: false, clsObserved: false };
    try { cwv = await page.evaluate('window.__cwv || {lcp:0,cls:0,lcpSeen:false,clsObserved:false}'); } catch (e) {
      log(`  ! ${url}: Core Web Vitals could not be read (${(e.message || e).toString().slice(0, 120)}) — reported as NOT MEASURED`);
    }
    try { await ctx.close(); } catch (e) {}

    // ── one context per remaining emulation group ───────────────────────────────────────────────────
    // hasTouch/deviceScaleFactor/userAgent can only be set at context creation, so each group costs one
    // navigation. dpr and touch survive setViewportSize(), so every member of a group is swept by
    // resizing this one page — 6 navigations per URL instead of one per device.
    for (const [key, entries] of groups) {
      if (key === PRIMARY_GROUP) continue;
      let gctx = null;
      try {
        gctx = await browser.newContext(contextOptionsFor(entries[0]));
        const gpage = await gctx.newPage();
        watchPage(gpage, { raw: false, weigh: false });
        try {
          await gpage.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
          await gpage.waitForTimeout(1200);
        } catch (e) { addErr('[navigation] ' + (e.message || '').slice(0, 160), false); }
        // Every context is a fresh browser profile, so the consent gate the metrics context already
        // dismissed is back up. Re-dismiss with the same deterministic ruleset — the sweep must see the
        // real page, not the gate. Reporting (consentByPage / CON-003) stays on the metrics context so
        // it is still emitted exactly once per page.
        try { await dismissOverlays(gpage); } catch (e) {}
        for (const v of entries) {
          if (await sweepViewport(gpage, v, { url, screensDir, runContrast: v.label === contrastLabel, out: swept.get(v.label), log })) sweptThisPage.add(v.label);
        }
      } catch (e) {
        // Non-fatal, but NEVER silent. This catch was empty: a context that failed to create (or a
        // navigation that threw) killed an ENTIRE emulation group — on the default matrix that is up
        // to five phones at once — with no finding, no log and no trace. The group's viewports simply
        // never enter sweptThisPage, so they are reported as not swept rather than presumed clean,
        // and the reason is on the record.
        const labels = entries.map(v => v.label);
        log(`  ! ${url}: emulation group [${labels.join(', ')}] FAILED (${(e.message || e).toString().slice(0, 120)}) — NOT counted as swept`);
        for (const v of entries) if (!sweptThisPage.has(v.label)) swept.get(v.label).failed.push({ label: v.label, error: (e.message || e).toString().slice(0, 160) });
      }
      if (gctx) { try { await gctx.close(); } catch (e) {} }
    }

    // Emit every sweep in MATRIX order — independent of the order the groups above happened to run in.
    for (const v of activeViewports) {
      const buf = swept.get(v.label);
      if (!buf) continue;
      for (const f of buf.findings) findings.push(f);
      for (const s of buf.shots) shots[url].push(s);
      for (const f of buf.failed) sweepFailures.push({ url, label: f.label, error: f.error });
    }
    // Running intersection: a viewport keeps its place in the reported matrix only while it has swept
    // on every page rendered so far.
    sweptEveryPage = sweptEveryPage === null ? sweptThisPage : new Set([...sweptEveryPage].filter(l => sweptThisPage.has(l)));

    // console + failed requests + CWV (viewport-independent)
    if (consoleErr.length) findings.push({ ...F('CON-001', 'console-errors', '10 Technical', `${consoleErr.length} error(s); e.g. ${consoleErr[0]}`, url, consoleErr.length), items: consoleErr.slice(0, 25).map(e => ({ id: String(e).slice(0, 120), section: 'console', value: 'error' })) });
    const uniqFailed = [...new Set(failed)];
    if (uniqFailed.length) findings.push({ ...F('CON-002', 'failed-requests', '10 Technical', `${uniqFailed.length} request(s) ≥400 or failed; e.g. ${uniqFailed[0]}`, url, uniqFailed.length), items: uniqFailed.slice(0, 25).map(u => ({ id: String(u).slice(0, 140), section: 'network', value: '' })) });
    // page-weight / request-count budget (content-length is a floor — compressed/chunked responses under-count)
    const mb = totalBytes / 1048576;
    if (reqCount > 120 || mb > 4) findings.push(F('PERF-006', 'page-weight', '6 Performance', `${reqCount} requests${mb > 0.2 ? ` · ~${mb.toFixed(1)}MB (content-length floor)` : ''} — trim to speed load`, url, `${reqCount}req`));
    // GRADE ONLY WHAT WAS MEASURED. Each metric is graded behind its own measurement flag, so an
    // unmeasured metric is counted as unmeasured instead of silently taking the "within target" arm
    // of a threshold it only cleared by being absent.
    try {
      if (cwv && cwv.lcpSeen) {
        if (cwv.lcp > 4000) findings.push(F('PERF-001', 'cwv-lcp', '6 Performance', `LCP ${Math.round(cwv.lcp)}ms (>4000ms poor)`, url, Math.round(cwv.lcp), { title: 'Slow Largest Contentful Paint' }));
        else if (cwv.lcp > 2500) findings.push(F('PERF-001', 'cwv-lcp', '6 Performance', `LCP ${Math.round(cwv.lcp)}ms (>2500ms)`, url, Math.round(cwv.lcp), { title: 'LCP needs improvement' }));
      } else {
        cwvUnmeasured.lcp++;
        log(`  ! ${url}: LCP NOT MEASURED (no largest-contentful-paint entry) — PERF-001 unverified, not graded`);
      }
      if (cwv && cwv.clsObserved) {
        if (cwv.cls > 0.25) findings.push(F('PERF-002', 'cwv-cls', '6 Performance', `CLS ${cwv.cls.toFixed(3)} (>0.25 poor)`, url, cwv.cls.toFixed(3), { title: 'High Cumulative Layout Shift' }));
        else if (cwv.cls > 0.1) findings.push(F('PERF-002', 'cwv-cls', '6 Performance', `CLS ${cwv.cls.toFixed(3)} (>0.1)`, url, cwv.cls.toFixed(3), { title: 'CLS needs improvement' }));
      } else {
        cwvUnmeasured.cls++;
        log(`  ! ${url}: CLS NOT MEASURED (layout-shift observer unavailable) — PERF-002 unverified, not graded`);
      }
    } catch (e) {}

    rendered++;
    log(`  rendered ${rendered}/${targets.length}: ${url}`);
    progress(rendered, targets.length);
  }
  await browser.close();

  // `viewports` IS THE SWEPT SET, NOT THE REQUESTED SET. audit.js reads this list to print
  // "N page(s) × M viewports · clean", so it has to answer "where did we actually look?" — it used to
  // answer "where did we intend to look?" (activeViewports.map(v => v.label)), which is how a page
  // that rendered on none of the five phones still certified them as clean. Requested/failed are kept
  // alongside so the delta is auditable rather than merely absent.
  const sweptLabels = activeViewports.map(v => v.label).filter(l => (sweptEveryPage || new Set()).has(l));

  // ── THE "I NEVER LOOKED" CHANNEL ────────────────────────────────────────────────────────────────
  // The root defect this engine keeps re-committing: a check that DID NOT RUN is subtracted from the
  // numerator only. score.js builds each suite's denominator from the REGISTRY (every rule that COULD
  // fire) while the numerator accrues from rows that actually ran — so silence pays out as credit, and
  // the worse the target, the better the report.
  //
  // score.js already owns the ONLY honest resolution: opts.excludeRules drops a rule from openRisk AND
  // totalRisk together — "this suite has no opinion on this rule" — which is the truthful answer for a
  // check that never executed. Deducting for it would assert a defect nobody measured; crediting it
  // asserts a pass nobody measured. Both are lies; exclusion is not.
  //
  // This list is that signal, emitted as data. It is deliberately NOT wired into the score here:
  // audit.js:436 calls computeQuality(suites) with no opts, and audit.js/score.js belong to the
  // scoring wave. Measured on the REAL 3-page sgen.com run (report.json, quality 72): a11y carries
  // openRisk 26 / totalRisk 76 -> 66. axe-core has never run in any of 72 stored runs, so A11Y-001's
  // 12 points are pure free credit; excluding it gives openRisk 26 / totalRisk 64 -> 59. The engine's
  // silence about axe is worth +7 a11y points to every client it has ever reported on.
  const unverified = [];
  if (!axeRan) {
    unverified.push({
      ruleId: 'A11Y-001',
      reason: AXE_SRC ? 'axe-core failed to inject or run on every sampled page' : 'axe-core is not installed (require.resolve failed)',
      // Even with axe installed it can still fail to inject — so this is keyed on axeRan (did it
      // actually produce results?), never on axeAvailable (could it have, in principle?).
      measured: false,
    });
  }
  if (rendered > 0 && cwvUnmeasured.lcp === rendered) unverified.push({ ruleId: 'PERF-001', reason: `LCP produced no measurement on any of ${rendered} rendered page(s)`, measured: false });
  if (rendered > 0 && cwvUnmeasured.cls === rendered) unverified.push({ ruleId: 'PERF-002', reason: `CLS produced no measurement on any of ${rendered} rendered page(s)`, measured: false });
  // Responsive rules are render-only: with nothing swept anywhere, RESP-002..006 were never evaluated.
  // A PARTIAL sweep is deliberately NOT listed — those rules did run, on a smaller matrix, and
  // `viewports` already states truthfully how small. Only "we never looked at all" belongs here.
  if (!sweptLabels.length) for (const id of ['RESP-002', 'RESP-003', 'RESP-004', 'RESP-005', 'RESP-006']) {
    unverified.push({ ruleId: id, reason: 'no viewport completed a sweep on every rendered page', measured: false });
  }

  return {
    findings, shots, consentByPage, rendered, sampled: targets.length, total: pageUrls.length,
    viewports: sweptLabels,
    viewportsRequested: activeViewports.map(v => v.label),
    sweepFailures,
    axeRan, axeAvailable: !!AXE_SRC,
    unverified,
    navFailures,
  };
}

// sweepViewport + CWV_INIT are exported for render-honesty.test.js: the "did it actually run?"
// contract is the thing under test, so it has to be reachable without driving a whole audit.
module.exports = { renderPass, VIEWPORTS, DEVICES, BREAKPOINTS, UA, contextOptionsFor, groupKeyOf, FONT_RULE, sweepViewport, CWV_INIT, AXE_AVAILABLE: !!AXE_SRC };
