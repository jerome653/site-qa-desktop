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

// axe-core (free, MIT) — the industry-standard WCAG engine. Loaded once if installed; if absent the
// render pass simply skips it and the auditor emits an honest "not installed" note (never a fake pass).
let AXE_SRC = null;
try { AXE_SRC = fs.readFileSync(require.resolve('axe-core')).toString(); } catch (e) { AXE_SRC = null; }

// device × width matrix (aligned to site-qa/visual-match VIEWPORTS — same 10 real-device widths).
// `contrast:true` marks the single entry that runs the (viewport-independent) AA contrast sweep once.
const VIEWPORTS = [
  { label: '1920 · desktop', width: 1920, height: 1080, mobile: false, contrast: true },
  { label: '1440 · laptop', width: 1440, height: 900, mobile: false },
  { label: '1200 · laptop-sm', width: 1200, height: 800, mobile: false },
  { label: '1024 · iPad landscape', width: 1024, height: 768, mobile: false },
  { label: '768 · iPad portrait', width: 768, height: 1024, mobile: true },
  { label: '480 · mobile-lg', width: 480, height: 854, mobile: true },
  { label: '430 · iPhone Pro Max', width: 430, height: 932, mobile: true },
  { label: '390 · iPhone', width: 390, height: 844, mobile: true },
  { label: '380 · Android', width: 380, height: 800, mobile: true },
  { label: '360 · Galaxy S', width: 360, height: 780, mobile: true },
];

// LCP + CLS accumulator, installed before any page script runs.
const CWV_INIT = `(function(){
  window.__cwv = { lcp: 0, cls: 0 };
  try {
    new PerformanceObserver(function(l){ for (const e of l.getEntries()) window.__cwv.lcp = Math.max(window.__cwv.lcp, e.renderTime || e.loadTime || e.startTime || 0); })
      .observe({ type: 'largest-contentful-paint', buffered: true });
  } catch(e){}
  try {
    new PerformanceObserver(function(l){ for (const e of l.getEntries()) { if (!e.hadRecentInput) window.__cwv.cls += e.value; } })
      .observe({ type: 'layout-shift', buffered: true });
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
  // tap targets + input font (mobile only)
  if (W <= 834){
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
// F(ruleId, check, section, detail, url, value, over) — identity = ruleId; severity/title from the
// registry unless `over` supplies a per-finding value (axe = dynamic help text; CWV = threshold variants).
function F(ruleId, check, section, detail, url, value, over = {}) {
  const r = REG.getById(ruleId);
  return { ruleId, check, section, severity: over.severity || (r ? r.severity : null), title: over.title || (r ? r.title : ruleId), detail: detail || '', location: url, value: value == null ? '' : String(value) };
}

async function renderPass(pageUrls, { screensDir, sampleN = 12, log = () => {}, progress = () => {} } = {}) {
  const targets = pageUrls.slice(0, sampleN);
  if (!targets.length) return { findings: [], shots: {}, rendered: 0, sampled: 0, total: pageUrls.length };
  fs.mkdirSync(screensDir, { recursive: true });

  const findings = [];
  const shots = {}; // url -> [{label, file}]
  const consentByPage = {}; // url -> {dismissed:[{text,selector,container}], stillBlocked}
  let axeRan = false;
  let browser;
  try { browser = await chromium.launch({ headless: true }); }
  catch (e) { log(`Playwright launch failed (${e.message}) — skipping render pass. Run: npx playwright install chromium`); return { findings: [], shots: {}, rendered: 0, sampled: 0, total: pageUrls.length, error: e.message }; }

  let rendered = 0;
  for (const url of targets) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript(CWV_INIT);
    const page = await ctx.newPage();
    const consoleErr = [], failed = [];
    let totalBytes = 0, reqCount = 0;
    page.on('console', m => { if (m.type() === 'error') consoleErr.push(m.text().slice(0, 200)); });
    page.on('pageerror', e => consoleErr.push('[pageerror] ' + (e.message || '').slice(0, 200)));
    page.on('request', () => { reqCount++; });
    page.on('requestfailed', r => failed.push(`${r.method()} ${r.url().slice(0, 120)} — ${r.failure()?.errorText || '?'}`));
    page.on('response', r => { const s = r.status(); if (s >= 400) failed.push(`${s} ${r.url().slice(0, 120)}`); const cl = parseInt((r.headers()['content-length'] || '0'), 10); if (cl > 0) totalBytes += cl; });

    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
      await page.waitForTimeout(1200);
    } catch (e) { consoleErr.push('[navigation] ' + (e.message || '').slice(0, 160)); }

    // consent-class overlays (cookie banner / age gate / T&C modal): dismiss deterministically so the
    // audit sees the real page. Everything clicked is recorded; a STILL-blocking overlay is flagged —
    // never silently audit a gate screen.
    const consent = await dismissOverlays(page);
    const blocked = await detectBlockingOverlay(page);
    if (consent.dismissed.length || blocked) consentByPage[url] = { dismissed: consent.dismissed, stillBlocked: blocked || null };
    if (blocked) findings.push(F('CON-003', 'blocking-overlay', '10 Technical', `overlay ${blocked.selector} covers ${Math.round(blocked.cover * 100)}% of the viewport and could not be auto-dismissed — findings + screenshots for this page reflect the gated view; review manually`, url, blocked.selector));

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

    shots[url] = [];
    for (let i = 0; i < VIEWPORTS.length; i++) {
      const v = VIEWPORTS[i];
      try {
        await page.setViewportSize({ width: v.width, height: v.height });
        await page.waitForTimeout(350);
        await page.evaluate(`window.__runContrast = ${!!v.contrast};`);
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
          const finding = { ...F(SWEEP_RULE[r.check], r.check, r.check === 'low-contrast' ? '7 Accessibility' : '4 Responsive', `${r.detail}${r.selector ? ` — ${r.selector}` : ''} [${v.label}]`, url, r.value), items: [{ id: r.selector || '(element)', section: r.section || '—', value: `${r.value}${r.detail ? ' · ' + r.detail : ''} [${v.label}]`, descriptor: desc ? { ...desc, url } : null }] };
          // per-issue element evidence: page--section--component--issue-<check>--viewport.png
          // (capped per page×viewport so a noisy page can't flood the evidence dir)
          if (r.selector && r.selector !== 'html' && issueShots < ISSUE_SHOT_CAP) {
            const issueFile = path.join(screensDir, evidenceName({ page: slug(url), section: r.section, component: r.selector, issue: r.check, viewport: v.label }));
            try {
              await page.locator(r.selector).first().screenshot({ path: issueFile, timeout: 2500 });
              finding.evidence = issueFile;
              shots[url].push({ label: `${v.label} · ${r.check}`, file: issueFile, issue: r.check, section: r.section || '', component: r.selector });
              issueShots++;
            } catch (e) { /* element gone/off-screen — finding stands without its close-up */ }
          }
          findings.push(finding);
        }
        const file = path.join(screensDir, evidenceName({ page: slug(url), section: 'page', component: 'full', viewport: v.label }));
        // canonical capture: fonts + image-decode + deterministic lazy-load scroll pass before the shot,
        // so below-the-fold images/404s load and surface in the network + broken-asset checks.
        const cap = await stableCapture(page, { fullPage: true, path: file, engine: 'chromium' });
        shots[url].push({ label: v.label, file, capture: cap });
      } catch (e) { /* per-viewport failure is non-fatal */ }
    }

    // console + failed requests + CWV (viewport-independent)
    if (consoleErr.length) findings.push({ ...F('CON-001', 'console-errors', '10 Technical', `${consoleErr.length} error(s); e.g. ${consoleErr[0]}`, url, consoleErr.length), items: consoleErr.slice(0, 25).map(e => ({ id: String(e).slice(0, 120), section: 'console', value: 'error' })) });
    const uniqFailed = [...new Set(failed)];
    if (uniqFailed.length) findings.push({ ...F('CON-002', 'failed-requests', '10 Technical', `${uniqFailed.length} request(s) ≥400 or failed; e.g. ${uniqFailed[0]}`, url, uniqFailed.length), items: uniqFailed.slice(0, 25).map(u => ({ id: String(u).slice(0, 140), section: 'network', value: '' })) });
    // page-weight / request-count budget (content-length is a floor — compressed/chunked responses under-count)
    const mb = totalBytes / 1048576;
    if (reqCount > 120 || mb > 4) findings.push(F('PERF-006', 'page-weight', '6 Performance', `${reqCount} requests${mb > 0.2 ? ` · ~${mb.toFixed(1)}MB (content-length floor)` : ''} — trim to speed load`, url, `${reqCount}req`));
    try {
      const cwv = await page.evaluate('window.__cwv || {lcp:0,cls:0}');
      if (cwv.lcp > 4000) findings.push(F('PERF-001', 'cwv-lcp', '6 Performance', `LCP ${Math.round(cwv.lcp)}ms (>4000ms poor)`, url, Math.round(cwv.lcp), { title: 'Slow Largest Contentful Paint' }));
      else if (cwv.lcp > 2500) findings.push(F('PERF-001', 'cwv-lcp', '6 Performance', `LCP ${Math.round(cwv.lcp)}ms (>2500ms)`, url, Math.round(cwv.lcp), { title: 'LCP needs improvement' }));
      if (cwv.cls > 0.25) findings.push(F('PERF-002', 'cwv-cls', '6 Performance', `CLS ${cwv.cls.toFixed(3)} (>0.25 poor)`, url, cwv.cls.toFixed(3), { title: 'High Cumulative Layout Shift' }));
      else if (cwv.cls > 0.1) findings.push(F('PERF-002', 'cwv-cls', '6 Performance', `CLS ${cwv.cls.toFixed(3)} (>0.1)`, url, cwv.cls.toFixed(3), { title: 'CLS needs improvement' }));
    } catch (e) {}

    await ctx.close();
    rendered++;
    log(`  rendered ${rendered}/${targets.length}: ${url}`);
    progress(rendered, targets.length);
  }
  await browser.close();
  return { findings, shots, consentByPage, rendered, sampled: targets.length, total: pageUrls.length, viewports: VIEWPORTS.map(v => v.label), axeRan, axeAvailable: !!AXE_SRC };
}

module.exports = { renderPass, VIEWPORTS };
