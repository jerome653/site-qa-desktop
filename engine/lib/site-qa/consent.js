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

// After dismissal passes: is a blocking overlay STILL covering the page? (cover ≥30% of viewport,
// fixed/absolute, z-index ≥10). If yes the audit is looking at a gate, not the site — callers surface
// this as a manual-review flag instead of silently auditing the overlay.
async function detectBlockingOverlay(page) {
  try {
    return await page.evaluate(`(function(){
      var els=document.querySelectorAll('body *'); var best=null;
      for(var i=0;i<els.length;i++){ var el=els[i]; var s=getComputedStyle(el);
        if(s.display==='none'||s.visibility==='hidden'||parseFloat(s.opacity||'1')<0.5) continue;
        if(s.position!=='fixed'&&s.position!=='absolute') continue;
        var z=parseInt(s.zIndex,10)||0; if(z<10) continue;
        var r=el.getBoundingClientRect(); var cover=(r.width*r.height)/(innerWidth*innerHeight);
        if(cover>=0.3&&(!best||cover>best.cover)){ var id=el.id?('#'+el.id):''; var c=(typeof el.className==='string'&&el.className)?('.'+el.className.trim().split(/\\s+/)[0]):''; best={ selector:el.tagName.toLowerCase()+id+c, cover:+cover.toFixed(2), zIndex:z }; }
      }
      return best;
    })()`);
  } catch (e) { return null; }
}

module.exports = { dismissOverlays, detectBlockingOverlay, AFFIRM_RX, CONTAINER_HINTS };
