'use strict';
// lib/evidence-providers.js — Evidence Providers (Stage 3). Each provider contributes evidence to the
// SAME Finding Contract; none owns the finding. This is the architecture that makes Build Integrity
// (Phase 3) just another provider, not a special case.
//
//   DOMProvider     → stable locator + ranked strategies + locatorId   (from element facts)
//   RenderProvider  → bounding box · visibility · (lazy) element screenshot   (render mode only)
//   NetworkProvider → headers · cookies · redirects            (stub — Phase 1 security rules wire it)
//   BuildProvider   → manifest · component · source            (stub — Phase 3)
//
// Providers are pure/composable: DOMProvider shapes facts already gathered; RenderProvider supplies the
// in-page serializer the render pass runs for FLAGGED elements only (cost proportional to findings).

const { domLocator, stableSelector } = require('./locator');
const { sha256 } = require('../finding-store/digest');

// stable, mutable-selector-independent handle: sha256(page + preferredLocator + tag)
function locatorIdOf(page, preferred, tag) {
  return sha256({ page: normalizePage(page), preferred: preferred || '', tag: (tag || '').toLowerCase() });
}
function normalizePage(u) {
  if (!u) return '';
  try { const x = new URL(u); return (x.origin + x.pathname).replace(/\/+$/, '') || x.origin; } catch (_) { return String(u).trim(); }
}

// ── DOM provider ── builds the generic Locator from element facts + assigns a deterministic locatorId.
const domProvider = {
  name: 'dom',
  // facts: { tag,id,classes[],attributes{},text,outerHTML,xpath,structuralCss,boundingBox,visible,url,screenshot,source }
  enrich(facts) {
    if (!facts) return null;
    const loc = domLocator(facts);
    const preferred = stableSelector(loc);
    loc.locatorId = locatorIdOf(facts.url, preferred, facts.tag);
    if (facts.text) loc.text = String(facts.text).slice(0, 120);
    if (facts.outerHTML) loc.outerHTML = String(facts.outerHTML).slice(0, 400);
    if (facts.visible !== undefined) loc.visible = !!facts.visible;
    return loc;
  },
};

// ── Render provider ── the in-page element serializer. Runs ONLY for flagged selectors (not the whole
// DOM). Deterministic: same element → same descriptor. Screenshots stay lazy (captured separately, only
// when a rule requests them) — this returns screenshot:null and lets the caller fill it.
const DESCRIBE_ELEMENTS = `(function(selectors){
  function xpathOf(el){ if(!el||el.nodeType!==1) return ''; if(el.id) return "//*[@id='"+el.id+"']"; var parts=[],n=el;
    while(n&&n.nodeType===1&&n.tagName.toLowerCase()!=='html'){ var i=1,s=n.previousElementSibling; while(s){ if(s.tagName===n.tagName)i++; s=s.previousElementSibling; } parts.unshift(n.tagName.toLowerCase()+'['+i+']'); n=n.parentElement; }
    return '/html/'+parts.join('/'); }
  function structural(el){ var p=[],n=el,d=0; while(n&&n.nodeType===1&&n.tagName.toLowerCase()!=='body'&&d<5){ var t=n.tagName.toLowerCase(),i=1,s=n.previousElementSibling; while(s){ if(s.tagName===n.tagName)i++; s=s.previousElementSibling; } p.unshift(t+':nth-of-type('+i+')'); n=n.parentElement; d++; } return p.join(' > '); }
  function vis(el){ if(!el||!el.getClientRects||!el.getClientRects().length) return false; var s=getComputedStyle(el); return !(s.visibility==='hidden'||s.display==='none'||+s.opacity===0); }
  var out={};
  (selectors||[]).forEach(function(sel){ if(!sel||out[sel])return; var el; try{ el=document.querySelector(sel); }catch(e){ el=null; }
    if(!el){ out[sel]=null; return; }
    var r=el.getBoundingClientRect(); var attrs={};
    Array.prototype.slice.call(el.attributes||[]).forEach(function(a){ if(['id','class','style'].indexOf(a.name)<0) attrs[a.name]=String(a.value).slice(0,120); });
    out[sel]={ tag:el.tagName.toLowerCase(), id:el.id||null,
      classes:(el.className&&typeof el.className==='string')?el.className.trim().split(/\\s+/).filter(Boolean):[],
      attributes:attrs, text:(el.textContent||'').trim().slice(0,120),
      outerHTML:(el.outerHTML||'').slice(0,400), xpath:xpathOf(el), structuralCss:structural(el),
      boundingBox:{ x:Math.round(r.left), y:Math.round(r.top+(window.scrollY||0)), width:Math.round(r.width), height:Math.round(r.height) },
      visible:vis(el) };
  });
  return out;
})`;

const renderProvider = { name: 'render', DESCRIBE_ELEMENTS };

// stubs — registered so Phase 1 security rules + Phase 3 build integrity plug in without new plumbing
const networkProvider = { name: 'network', enrich() { return null; } };
const buildProvider = { name: 'build', enrich() { return null; } };

const PROVIDERS = { dom: domProvider, render: renderProvider, network: networkProvider, build: buildProvider };

module.exports = { PROVIDERS, domProvider, renderProvider, networkProvider, buildProvider, DESCRIBE_ELEMENTS, locatorIdOf };
