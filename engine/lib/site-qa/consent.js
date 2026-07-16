'use strict';
// site-qa/consent.js — deterministic dismissal of consent-class overlays (cookie banners, age gates,
// terms/conditions modals) so the audit sees the page a returning visitor sees. NO AI: a fixed,
// auditable ruleset — known consent-manager containers + an affirmative-button text matcher — with a
// bounded number of passes. Everything clicked is RECORDED and threaded into the capture metadata /
// report, so a dismissed gate is evidence, never a silent mutation. If nothing matches, the page is
// audited as-is (honest degrade — never guess-click arbitrary UI).

// Affirmative labels only. Deliberately narrow: "accept / agree / I am 21 / enter site" style.
// Never matches destructive or navigational text ("reject" is fine to skip — we take the ACCEPT path
// because the audit's job is to see the full site, and accept is what most real visitors click).
const AFFIRM_RX = /^(accept( all( cookies)?| cookies)?|allow( all)?( cookies)?|agree( (&|and) continue)?|i (agree|accept|understand|consent)|got it|ok(ay)?|enter( (the )?site)?|continue( to site)?|confirm|proceed|verify|(yes[,.!]? ?)?i(['’]?m| am)( over)? ?(18|19|21)\+?( or older| years? old| years? or older)?|yes)$/i;

// Known consent-manager / age-gate containers (id or class fragments, lowercase). Buttons inside these
// are trusted even when their label is short/generic ("OK", "Yes").
const CONTAINER_HINTS = [
  'onetrust', 'ot-sdk', 'cookiebot', 'cybot', 'cookieyes', 'cky-', 'osano', 'didomi', 'usercentrics',
  'truste', 'trustarc', 'quantcast', 'qc-cmp', 'sp_message', 'sp-message', 'iubenda', 'cmplz', 'complianz',
  'borlabs', 'klaro', 'cc-window', 'cc-banner', 'cookie-consent', 'cookieconsent', 'cookie-notice',
  'cookie-banner', 'cookie_banner', 'consent-banner', 'consent-manager', 'gdpr', 'agegate', 'age-gate',
  'age_gate', 'ageverify', 'age-verify', 'age-verification', 'av-overlay', 'nsfw-gate', 'terms-modal',
  'tcf-', 'fides-',
];

// Serialized into the page. Finds visible affirmative buttons inside (a) known consent containers, or
// (b) any high-z-index fixed/sticky overlay covering a meaningful share of the viewport. Clicks at most
// one per pass; returns what it clicked (text + a short selector) or null.
const DISMISS_ONE = `(function(hints, affirmSrc, affirmFlags){
  var AFFIRM = new RegExp(affirmSrc, affirmFlags);
  function vis(el){ if(!el) return false; var r=el.getBoundingClientRect(); if(r.width<8||r.height<8) return false; var s=getComputedStyle(el); return s.display!=='none'&&s.visibility!=='hidden'&&parseFloat(s.opacity||'1')>0.05; }
  function sel(el){ var p=[],n=el,i=0; while(n&&n.nodeType===1&&i<5){ var t=n.tagName.toLowerCase(); if(n.id){ p.unshift(t+'#'+n.id); break; } var c=(n.className&&typeof n.className==='string')?n.className.trim().split(/\\s+/)[0]:''; p.unshift(c?t+'.'+c:t); n=n.parentElement; i++; } return p.join('>'); }
  function label(el){ return (el.innerText||el.value||el.getAttribute('aria-label')||'').trim().replace(/\\s+/g,' ').slice(0,60); }
  function inKnownContainer(el){ var n=el,i=0; while(n&&n.nodeType===1&&i<8){ var idc=((n.id||'')+' '+((typeof n.className==='string'&&n.className)||'')).toLowerCase(); for(var h=0;h<hints.length;h++){ if(idc.indexOf(hints[h])!==-1) return hints[h]; } n=n.parentElement; i++; } return null; }
  function inOverlay(el){ var n=el,i=0; while(n&&n.nodeType===1&&i<8){ var s=getComputedStyle(n); if((s.position==='fixed'||s.position==='sticky'||s.position==='absolute')&&(parseInt(s.zIndex,10)||0)>=10){ var r=n.getBoundingClientRect(); var cover=(r.width*r.height)/(innerWidth*innerHeight); if(cover>0.05) return true; } n=n.parentElement; i++; } return false; }
  var cands = Array.prototype.slice.call(document.querySelectorAll('button, a[role=button], [role=button], input[type=button], input[type=submit], a'));
  for (var k=0;k<cands.length;k++){
    var el=cands[k]; if(!vis(el)) continue;
    var txt=label(el); if(!txt||txt.length>60||!AFFIRM.test(txt)) continue;
    var known=inKnownContainer(el);
    if(!known && !inOverlay(el)) continue;               // affirmative text alone is NOT enough — must sit in a consent container or a covering overlay
    var info={ text:txt, selector:sel(el), container:known||'overlay' };
    try{ el.click(); }catch(e){ return null; }
    return info;
  }
  return null;
})`;

// Dismiss up to `maxPasses` stacked overlays (age gate behind cookie banner is common).
// Returns { dismissed: [{text, selector, container}], passes } — empty array when nothing matched.
async function dismissOverlays(page, { maxPasses = 3, settleMs = 500 } = {}) {
  const dismissed = [];
  let passes = 0;
  for (let i = 0; i < maxPasses; i++) {
    passes++;
    let hit = null;
    try { hit = await page.evaluate(`${DISMISS_ONE}(${JSON.stringify(CONTAINER_HINTS)}, ${JSON.stringify(AFFIRM_RX.source)}, ${JSON.stringify(AFFIRM_RX.flags)})`); }
    catch (e) { break; }
    if (!hit) break;
    dismissed.push(hit);
    try { await page.waitForTimeout(settleMs); } catch (e) { break; } // let the overlay animate out / next gate render
  }
  return { dismissed, passes };
}

// After dismissal passes: is a blocking overlay STILL covering the page? If yes the audit is looking
// at a gate, not the site — callers surface this as a manual-review flag instead of silently auditing
// the overlay. This report is shown to a CLIENT as evidence, so a false "this page is gated" discredits
// every other finding on the page: geometry alone is not enough to earn it.
//
// Being fixed + high-z + big is NOT evidence of blocking. Three things must be true of a real gate:
// it is on-screen, it is on top, and the page is not reachable through it. The old check tested none
// of those and fired on every ordinary slide-out drawer:
//   • RAW rect area ignored the viewport, so a panel parked off-screen (`translateX`) still measured
//     "covers 68%" while covering nothing at all;
//   • no pointer-events test, so a click-through drawer host counted as a wall;
//   • no occlusion test, so a fully TRANSPARENT portal/drawer wrapper — geometry only, hiding nothing —
//     was reported as "covers 100% of the viewport".
// (All three fired together on sgen.com: div#dpzDrawer.dpz — transparent, pointer-events:none, with the
// real panel translated off-screen — was reported as a 100% gate on all 3 pages while the screenshots
// showed the complete, unobstructed page.)
async function detectBlockingOverlay(page) {
  try {
    return await page.evaluate(`(function(){
      var vw=innerWidth, vh=innerHeight, vArea=vw*vh;
      if(!vArea) return null;

      // Only the ON-SCREEN part of an element can gate the page. getBoundingClientRect keeps a
      // slide-out panel's full size while transform parks it outside the viewport, so raw area
      // reads as "covering" something no camera and no visitor can see.
      function clip(r){
        var x0=Math.max(0,r.left), y0=Math.max(0,r.top), x1=Math.min(vw,r.right), y1=Math.min(vh,r.bottom);
        var w=Math.max(0,x1-x0), h=Math.max(0,y1-y0);
        return { x0:x0, y0:y0, x1:x1, y1:y1, area:w*h };
      }

      // Does it actually paint a fill? A transparent wrapper (drawer host, portal root, click-catcher)
      // occupies the viewport in geometry only — nothing of the page is hidden behind it.
      function paints(s){
        if(s.backgroundImage && s.backgroundImage!=='none') return true;
        if(s.backdropFilter && s.backdropFilter!=='none') return true;
        var m=/^rgba?\\(([^)]+)\\)/.exec(s.backgroundColor||'');
        if(!m) return false;
        var p=m[1].split(',');
        return (p.length>3 ? parseFloat(p[3]) : 1) >= 0.5;
      }

      // Ask the browser what is on top instead of re-implementing compositing: elementFromPoint honours
      // z-order, clipping, transforms and pointer-events exactly as a visitor's click does. Sampling a
      // grid (not just the centre) stops a banner with a hole in the middle from reading as harmless.
      function intercepted(el, c){
        var hits=0, total=0;
        for(var gx=1; gx<=3; gx++) for(var gy=1; gy<=3; gy++){
          var px=c.x0+(c.x1-c.x0)*(gx/4), py=c.y0+(c.y1-c.y0)*(gy/4);
          if(px<0||py<0||px>=vw||py>=vh) continue;
          total++;
          var t=document.elementFromPoint(px,py);
          if(t && (t===el || el.contains(t))) hits++;
        }
        return total ? hits/total : 0;
      }

      var els=document.querySelectorAll('body *'), best=null;
      for(var i=0;i<els.length;i++){
        var el=els[i], s=getComputedStyle(el);
        if(s.display==='none'||s.visibility==='hidden'||parseFloat(s.opacity||'1')<0.5) continue;
        if(s.position!=='fixed'&&s.position!=='absolute') continue;
        var z=parseInt(s.zIndex,10)||0; if(z<10) continue;

        var c=clip(el.getBoundingClientRect());
        var cover=c.area/vArea;
        if(cover<0.3) continue;

        // Two independent ways to gate a page; EITHER is disqualifying (fail closed — losing a true
        // cookie wall is worse than a false alarm):
        //  1. it swallows interaction across the page (what every consent gate does by definition), or
        //  2. it is click-through yet still PAINTS an opaque fill over the page, so the audit's
        //     screenshot is a picture of the overlay even though clicks pass through.
        var hit=intercepted(el,c);
        var reason = hit>=0.5 ? 'intercepts' : (paints(s) ? 'opaque' : null);
        if(!reason) continue;   // transparent AND click-through: the page is fully visible and reachable

        if(!best||cover>best.cover){
          var id=el.id?('#'+el.id):'';
          var cl=(typeof el.className==='string'&&el.className)?('.'+el.className.trim().split(/\\s+/)[0]):'';
          best={ selector:el.tagName.toLowerCase()+id+cl, cover:+cover.toFixed(2), zIndex:z, reason:reason, intercepted:+hit.toFixed(2) };
        }
      }
      return best;
    })()`);
  } catch (e) { return null; }
}

module.exports = { dismissOverlays, detectBlockingOverlay, AFFIRM_RX, CONTAINER_HINTS };
