'use strict';
// font-checks.js — webfont + icon-font integrity (registry v1.11.0: FONT-001..006, ICON-001..003).
//
// WHY THIS EXISTS: before v1.11.0 nothing in the registry checked fonts. The closest rules were
// RESP-006 (input font SIZE) and SEO-014/015 (favicon). Nothing verified a declared webfont
// actually rendered — so a rebuild could silently lose its typeface or its whole icon set and the
// audit stayed green.
//
// WIRING: migration-qa/checks-render.js calls runFontChecks() ONCE per page (these signals are
// viewport-independent — running them per-viewport would emit ~10x duplicate findings), guarded by
// try/catch exactly like the axe-core pass. Check name -> rule id is mapped there via FONT_RULE;
// identity lives in the registry, never in the sweep string.
//
// DESIGN RULE: deterministic signals only. Every check below is backed by a probe run against
// real broken fixtures in the engine's own Chromium — not by reading docs. Findings that can only
// be guessed at are deliberately NOT emitted.
//
// TESTS (two layers, both real):
//   • font-checks.test.js (this repo, runs in run-all) — unit-tests the PURE classify()/drift()
//     over in-code sweep fixtures, matching the repo's no-browser test convention.
//   • docs/sgen-site-qa/font-checker/font-checks.test.js — drives this module through real
//     Chromium against 10 broken HTML fixtures (17/17 assertions). Lives outside the shipped
//     engine because the engine has no browser/HTML-fixture test convention.
//
// VERIFIED API BEHAVIOUR (probe, 2026-07-15, playwright 1.60 / chromium):
//   • FontFace.status === 'error'  <- a 404/blocked font reliably lands here. DETERMINISTIC.
//   • document.fonts.check('16px "X"') === false when X failed. DETERMINISTIC for *loading*.
//   • document.fonts.check('700 16px "X"') === TRUE even when only weight 400 is declared —
//     it answers "can the browser paint this?", and the browser will SYNTHESISE the bold.
//     So check() must NEVER be used to detect synthetic bold. Use the CSSOM weight set.
//   • CDP CSS.getPlatformFontsForNode -> { fonts:[{familyName, postScriptName, isCustomFont,
//     glyphCount}] } = the fonts ACTUALLY used to paint a node. This is the oracle: on the
//     404 fixture an h1 declaring GhostFont reported familyName "Times New Roman".

// ---- in-page sweep (no CDP needed) -------------------------------------------------------
// Returns raw facts. Classification happens in Node so it stays testable.
const FONT_SWEEP = `(async function(){
  try { await document.fonts.ready; } catch(e){}

  function sel(el){ if(!el||el.nodeType!==1) return '(?)'; var p=[],d=0;
    while(el&&el.nodeType===1&&d<4){ var t=el.tagName.toLowerCase();
      if(el.id){p.unshift(t+'#'+el.id);break;}
      var c=(el.className&&typeof el.className==='string')?el.className.trim().split(/\\s+/)[0]:'';
      if(c)t+='.'+c; p.unshift(t); el=el.parentElement; d++; } return p.join('>'); }
  function vis(el){ if(!el.getClientRects().length) return false; var s=getComputedStyle(el);
    if(s.visibility==='hidden'||s.display==='none'||+s.opacity===0) return false;
    var r=el.getBoundingClientRect(); return r.width>0&&r.height>0; }
  function fam1(s){ return (s.split(',')[0]||'').trim().replace(/^["']|["']$/g,''); }

  // 1. every @font-face the page declared, with its real load status
  var faces=[];
  document.fonts.forEach(function(f){
    faces.push({ family:f.family.replace(/^["']|["']$/g,''), status:f.status, weight:f.weight,
                 style:f.style, display:f.display, unicodeRange:f.unicodeRange });
  });

  // 2. which families does the page actually USE (first family of each visible text element)
  var used={}, samples={};
  var all=document.body.getElementsByTagName('*');
  for(var i=0;i<all.length&&i<4000;i++){
    var el=all[i];
    if(!vis(el)) continue;
    // only elements with their own text, or icon-ish empties with ::before content
    var ownText=''; for(var n=el.firstChild;n;n=n.nextSibling){ if(n.nodeType===3) ownText+=n.nodeValue; }
    var before=''; try{ before=getComputedStyle(el,'::before').content||''; }catch(e){}
    var hasBefore = before && before!=='none' && before!=='normal' && before!=='""';
    if(!ownText.trim() && !hasBefore) continue;
    var cs=getComputedStyle(el);
    var f=fam1(cs.fontFamily);
    if(!f) continue;
    used[f]=(used[f]||0)+1;
    // keep the first ITALIC sample too — otherwise a page whose first hit is upright hides
    // every faux-italic on the page behind that one sample.
    var isIt=/^(italic|oblique)/.test(cs.fontStyle||'');
    if(isIt && (!samples[f] || !/^(italic|oblique)/.test(samples[f].style||''))){
      samples[f]={ selector:sel(el), text:ownText.trim().slice(0,40), size:cs.fontSize,
        weight:cs.fontWeight, style:cs.fontStyle, hasBefore:!!hasBefore,
        beforeContent: hasBefore ? before.slice(0,12) : '',
        w:Math.round(el.getBoundingClientRect().width), h:Math.round(el.getBoundingClientRect().height) };
      continue;
    }
    if(!samples[f]) samples[f]={ selector:sel(el), text:ownText.trim().slice(0,40),
      size:cs.fontSize, weight:cs.fontWeight, style:cs.fontStyle, hasBefore:!!hasBefore,
      beforeContent: hasBefore ? before.slice(0,12) : '',
      w:Math.round(el.getBoundingClientRect().width), h:Math.round(el.getBoundingClientRect().height) };
  }

  // 3. icon-ish elements: family that looks like an icon set, OR a PUA ::before codepoint.
  //    If its face errored AND the element carries a word, the LIGATURE TEXT is showing.
  // Icon-set matching. ANCHORED + word-boundaried, NOT substring.
  // An adversarial pass caught the naive /icon|material|fa-|glyph|feather/ version falsely
  // matching ordinary families: Silicon, Lexicon, Iconic, Materialize, Feathery, Glyphic Sans.
  // A real site using any of those would get bogus ICON-001/002/003 findings — worse than no
  // check at all, because a false blocker destroys trust in every other finding.
  // Families: match known icon sets from the START of the name.
  var ICON_FAM=/^(material[ -]?(icons|symbols)|font ?awesome|fa[ -]?(solid|regular|brands|light)|glyphicons?|ionicons|feather ?icons|bootstrap[ -]?icons|remixicon|boxicons|themify|typicons|octicons|simple[ -]?line[ -]?icons)\b/i;
  // Classes: whole-token only, so "iconic-hero" / "material-card" don't match.
  var ICON_CLS=/(^|\s)(fa|fas|far|fab|fal|fad|material-icons|material-symbols(-\w+)?|glyphicon|bi|icon|ion-icon|feather)(\s|-|$)/i;
  function isIconish(fam, cls){ return ICON_FAM.test(fam||'') || ICON_CLS.test(cls||''); }
  var icons=[];
  for(var j=0;j<all.length&&j<4000;j++){
    var e2=all[j]; if(!vis(e2)) continue;
    var cs2=getComputedStyle(e2), f2=fam1(cs2.fontFamily);
    var cls=(e2.className&&typeof e2.className==='string')?e2.className:'';
    var b2=''; try{ b2=getComputedStyle(e2,'::before').content||''; }catch(e){}
    var pua=/[\\uE000-\\uF8FF]/.test(b2);
    if(!isIconish(f2, cls) && !pua) continue;
    var t2=(e2.textContent||'').trim();
    icons.push({ selector:sel(e2), family:f2, cls:cls.slice(0,40), text:t2.slice(0,24),
      isWord:/^[a-z][a-z_ ]{1,20}$/i.test(t2), pua:pua,
      loaded: f2 ? document.fonts.check((cs2.fontSize||'16px')+' "'+f2+'"') : true,
      w:Math.round(e2.getBoundingClientRect().width), h:Math.round(e2.getBoundingClientRect().height) });
    if(icons.length>60) break;
  }

  // 4. <link rel=preload as=font> — the ONLY font decl that always costs bytes (@font-face is lazy).
  var preloads=[];
  Array.prototype.forEach.call(document.querySelectorAll('link[rel~="preload"][as="font"]'), function(l){
    var href=l.getAttribute('href')||'';
    // best-effort family match: a preload has no family, so match the file stem against used families
    var stem=(href.split('/').pop()||'').replace(/[.?#].*$/,'').toLowerCase();
    var match=null;
    Object.keys(used).forEach(function(u){
      var norm=u.toLowerCase().replace(/[^a-z0-9]/g,'');
      if(norm && stem.replace(/[^a-z0-9]/g,'').indexOf(norm)>=0) match=u;
    });
    preloads.push({ href:href, family:match, usedFamily:!!match });
  });

  return { faces:faces, used:used, samples:samples, icons:icons, preloads:preloads, setStatus:document.fonts.status };
})()`;

// ---- CDP oracle: which font ACTUALLY painted each node ------------------------------------
// Optional. If CDP is unavailable the checker still runs (it just loses ACTUAL-font evidence).
async function actualFonts(page, context, selectors) {
  const out = {};
  let cdp;
  try {
    cdp = await context.newCDPSession(page);
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
    const { root } = await cdp.send('DOM.getDocument');
    for (const s of selectors) {
      try {
        const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: s });
        if (!nodeId) continue;
        const r = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
        out[s] = (r.fonts || []).map(f => ({
          family: f.familyName, ps: f.postScriptName, custom: !!f.isCustomFont, glyphs: f.glyphCount,
        }));
      } catch (e) { /* node vanished / bad selector — skip, never fail the audit */ }
    }
  } catch (e) { return { unavailable: true, reason: e.message }; }
  finally { try { await cdp.detach(); } catch (e) {} }
  return out;
}

// ---- classification (pure, unit-testable) -------------------------------------------------
// A generic stack the browser falls back to. Used to tell "declared a webfont, got a system
// font" apart from "declared a system font, got that system font".
const GENERIC = /^(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-|-apple-|blinkmac|segoe|roboto|helvetica|arial|georgia|times|courier|tahoma|verdana|inherit|initial)/i;

function classify(sweep, actual) {
  const f = [];
  const faces = sweep.faces || [];
  const used = sweep.used || {};
  const byFamily = {};
  for (const face of faces) (byFamily[face.family] = byFamily[face.family] || []).push(face);

  // FONT-001 — a declared @font-face failed to load (404 / CORS / CSP). DETERMINISTIC.
  for (const [family, fs] of Object.entries(byFamily)) {
    if (!fs.some(x => x.status === 'error')) continue;
    const isUsed = !!used[family];
    const s = sweep.samples[family];
    f.push({
      check: 'font-not-loaded', severity: isUsed ? 'high' : 'low',
      title: isUsed ? 'Webfont failed to load — text is silently falling back' : 'Declared webfont failed to load (unused)',
      family, selector: s ? s.selector : 'head > style',
      value: `@font-face "${family}" status=error`,
      detail: isUsed
        ? `${used[family]} element(s) ask for "${family}"; it never loaded, so the browser painted a fallback.`
        : `"${family}" failed to load but nothing uses it.`,
      actual: s && actual && actual[s.selector] ? actual[s.selector].map(a => a.family).join(', ') : null,
    });
  }

  // FONT-002 — a family is used but no face for it loaded (never declared, or all errored).
  for (const [family, count] of Object.entries(used)) {
    if (GENERIC.test(family)) continue;
    const fs = byFamily[family];
    if (fs && fs.some(x => x.status === 'loaded')) continue;   // fine
    if (fs && fs.some(x => x.status === 'error')) continue;    // already FONT-001
    const s = sweep.samples[family];
    f.push({
      check: 'font-undeclared', severity: 'medium',
      title: 'Font used but never declared — always falls back',
      family, selector: s ? s.selector : '(?)',
      value: `font-family: "${family}" · no @font-face`,
      detail: `${count} element(s) request "${family}" but the page declares no @font-face for it. Renders in a fallback for every visitor without it installed locally.`,
      actual: s && actual && actual[s.selector] ? actual[s.selector].map(a => a.family).join(', ') : null,
    });
  }

  // FONT-003 — synthetic (faux) BOLD: the requested weight has no declared face, so Chromium
  // emboldens the regular outline. Nothing errors, status is 'loaded', and the advance width is
  // UNCHANGED — so every conventional check passes while the page is visibly wrong.
  //
  // Why the CSSOM weight-set is the signal here:
  //   • document.fonts.check('700 16px Fam') returns TRUE with only a 400 face — PROVEN by probe.
  //     It answers "can the browser paint this", and the browser will fake it. Never use it.
  //   • Width/measureText is identical — synthesis doesn't change advance width. Useless.
  //   • CDP postScriptName is a good cross-check (returns the REGULAR face name while computed
  //     weight says 700) and is attached below as `actual` evidence when available.
  for (const [family, s] of Object.entries(sweep.samples || {})) {
    const fs = byFamily[family];
    if (!fs || !fs.some(x => x.status === 'loaded')) continue;
    const want = parseInt(s.weight, 10);
    if (!want || want < 600) continue;
    const covers = fs.some(face => {
      const w = String(face.weight || '400');
      if (/\s/.test(w)) { const [lo, hi] = w.split(/\s+/).map(Number); return want >= lo && want <= hi; }
      if (w === 'bold') return want >= 600;
      if (w === 'normal') return want <= 500;
      return Math.abs(Number(w) - want) < 50;
    });
    if (covers) continue;
    f.push({
      check: 'synthetic-bold', severity: 'low',
      title: 'Faux bold — the requested weight was never loaded',
      family, selector: s.selector,
      value: `wants ${want}, declared: ${fs.map(x => x.weight).join('/')}`,
      detail: `"${family}" has no face at weight ${want}, so Chromium synthesises it by smearing the ${fs.map(x => x.weight).join('/')} outline. It renders heavier and blurrier than the real cut, and nothing errors.`,
      actual: actual && actual[s.selector] ? actual[s.selector].map(a => a.ps).join(', ') : null,
    });
  }

  // FONT-006 — synthetic (faux) ITALIC. A real italic is a DIFFERENT SET OF GLYPHS, not a slant:
  // a true italic 'a' is drawn differently. Chromium fakes it by shearing the upright face.
  // Worst for serif brands, and for CJK/Arabic a shear is illegible-to-meaning-changing.
  //
  // This is a genuinely separate check, not a variant of faux-bold: a shear REDISTRIBUTES ink
  // rather than thickening it, so it moves total ink by ~0.1% where faux-bold moves it ~44%.
  // Any ink/pixel THRESHOLD tuned on bold silently misses italic entirely.
  for (const [family, s] of Object.entries(sweep.samples || {})) {
    const fs = byFamily[family];
    if (!fs || !fs.some(x => x.status === 'loaded')) continue;
    if (!/^(italic|oblique)/.test(String(s.style || ''))) continue;
    if (fs.some(face => /^(italic|oblique)/.test(String(face.style || '')))) continue;  // real italic exists
    f.push({
      check: 'synthetic-italic', severity: 'low',
      title: 'Faux italic — no real italic face was loaded',
      family, selector: s.selector,
      value: `font-style: ${s.style}, declared styles: ${[...new Set(fs.map(x => x.style || 'normal'))].join('/')}`,
      detail: `"${family}" ships no italic face, so Chromium shears the upright one. A true italic has different letterforms, not a slant — this reads as wrong rather than merely different.`,
      actual: actual && actual[s.selector] ? actual[s.selector].map(a => a.ps).join(', ') : null,
    });
  }

  // FONT-004 — font-display not set: Chromium's default (auto≈block) hides text up to 3s.
  for (const [family, fs] of Object.entries(byFamily)) {
    if (!used[family]) continue;
    if (fs.every(x => x.display && x.display !== 'auto')) continue;
    if (!fs.some(x => x.status === 'loaded')) continue;
    f.push({
      check: 'font-display-missing', severity: 'low',
      title: 'font-display not set (FOIT risk)',
      family, selector: 'head > style',
      value: `@font-face "${family}" font-display: ${fs[0].display || 'auto'}`,
      detail: `Defaults to auto — Chromium blocks text paint for up to 3s while the font fetches, hurting LCP and flashing invisible text.`,
    });
  }

  // FONT-005 — PRELOADED but unused. NOT "declared but unused".
  // Probe result (2026-07-15): @font-face is LAZY — an unused face stays status 'unloaded' and
  // fires ZERO network requests, so it costs nothing and is NOT worth flagging. The premise of a
  // "declared but unused = dead weight" check is simply false in a modern browser.
  // <link rel=preload as=font> is the opposite: it FORCES the fetch at high priority. Preloading
  // a font nothing renders is real wasted bytes AND steals bandwidth from the LCP image.
  for (const pl of (sweep.preloads || [])) {
    if (pl.usedFamily) continue;
    f.push({
      check: 'font-preloaded-unused', severity: 'low',
      title: 'Font preloaded but never used',
      family: pl.family || '(unknown)', selector: `link[href="${pl.href}"]`,
      value: `rel=preload as=font · ${pl.href}`,
      detail: `This font is preloaded at high priority — forcing the download — but no visible element renders it. Unlike a plain @font-face (which is lazy and free), a preload always costs the bytes and competes with the LCP image.`,
    });
  }

  // ICON-001 — the icon font didn't load. Everything below it is a symptom of this.
  const iconFails = (sweep.icons || []).filter(i => !i.loaded && i.family && !GENERIC.test(i.family));
  const iconFamilies = [...new Set(iconFails.map(i => i.family))];
  for (const family of iconFamilies) {
    const hits = iconFails.filter(i => i.family === family);
    f.push({
      check: 'icon-font-not-loaded', severity: 'high',
      title: 'Icon font failed to load — icons are not rendering',
      family, selector: hits[0].selector,
      value: `${hits.length} icon element(s) · "${family}"`,
      detail: `The icon font never loaded, so every icon using it is showing a fallback: either a tofu box (□) or, for ligature sets, the raw word.`,
    });
  }

  // ICON-002 — the money check: ligature text is VISIBLE as words. This is what a visitor
  // literally reads on the page ("home menu search") instead of icons.
  const lig = (sweep.icons || []).filter(i => !i.loaded && i.isWord && i.text);
  if (lig.length) {
    f.push({
      check: 'icon-ligature-visible', severity: 'high',
      title: 'Icon names are rendering as literal words',
      family: lig[0].family, selector: lig[0].selector,
      value: lig.slice(0, 6).map(i => `"${i.text}"`).join(' '),
      detail: `${lig.length} icon(s) are painting their ligature name as text. A visitor sees the words ${lig.slice(0, 3).map(i => `"${i.text}"`).join(', ')} where the icons should be.`,
    });
  }

  // ICON-003 — PUA codepoint with no font = guaranteed tofu.
  const tofu = (sweep.icons || []).filter(i => i.pua && !i.loaded);
  if (tofu.length) {
    f.push({
      check: 'icon-tofu', severity: 'high',
      title: 'Icons rendering as tofu boxes (□)',
      family: tofu[0].family, selector: tofu[0].selector,
      value: `${tofu.length} element(s) with a private-use codepoint and no font`,
      detail: `These use private-use-area codepoints, which have no meaning in any fallback font — so they paint as notdef boxes.`,
    });
  }

  return f;
}

// ---- comparison lane: font drift reference vs candidate -----------------------------------
function drift(refSweep, candSweep) {
  const out = [];
  const rUsed = Object.keys(refSweep.used || {}).filter(x => !GENERIC.test(x));
  const cUsed = Object.keys(candSweep.used || {});
  for (const fam of rUsed) {
    if (cUsed.includes(fam)) continue;
    out.push({
      check: 'font-drift', severity: 'medium',
      title: 'Font changed vs the reference site',
      family: fam, selector: (refSweep.samples[fam] || {}).selector || '(?)',
      value: `reference: "${fam}" → candidate: ${cUsed.slice(0, 3).map(x => `"${x}"`).join(', ') || '(none)'}`,
      detail: `The reference renders "${fam}" here; the candidate does not use it at all.`,
    });
  }
  return out;
}

async function runFontChecks(page, context) {
  const sweep = await page.evaluate(FONT_SWEEP);
  const sels = [...new Set(Object.values(sweep.samples || {}).map(s => s.selector))].slice(0, 25);
  const actual = await actualFonts(page, context, sels);
  return { sweep, actual, findings: classify(sweep, actual) };
}

module.exports = { FONT_SWEEP, runFontChecks, classify, drift, actualFonts, GENERIC };
