'use strict';
// providers.js — the Provider layer (frozen spec). Each provider enumerates ONE inventory type from a
// crawl result (pages carry { url, body, headers, status }). Providers implement a stable interface —
// `enumerate(collection, ctx) → [{ identityKey, meta }]` (ADR-0004 §D2; widened from the shipped
// `enumerate(pages, host)`, which could carry static HTML only) — so new inventory types (ecommerce/LMS/booking)
// plug in without touching the engine. Detection is deterministic + conservative (reuses existing
// signal patterns). Component-level enumeration is RESERVED (needs the render-time element read).
//
// identityKey is the STABLE logical identity (→ id-registry mints the stable ID). It must not depend on
// discovery order or run — it is derived from the object's nature (path, role+filename, component key).

const { wasCollected, assertCollection } = require('./collection');

function pathOf(u) { try { const x = new URL(u); return (x.pathname.replace(/\/+$/, '') || '/'); } catch (_) { return u; } }
function basename(u) { try { const x = new URL(u, 'http://x/'); return (x.pathname.split('/').pop() || u).toLowerCase().slice(0, 80); } catch (_) { return String(u).split('/').pop().toLowerCase().slice(0, 80); } }
function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50); }
function htmlPages(pages) { return pages.filter(p => p.status === 200 && (/text\/html/i.test(p.contentType || '') || /<html[\s>]/i.test(p.body || ''))); }
function stripText(s) { return String(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); }
// does ANY html page match re? returns {url} of the first, or null
function anyPage(pages, re) { for (const p of htmlPages(pages)) if (re.test(p.body || '')) return { url: p.url }; return null; }

const PageProvider = {
  type: 'page',
  enumerate(collection) {
    const pages = collection.staticPages;
    return htmlPages(pages).map(p => ({ identityKey: 'page:' + pathOf(p.url), meta: { url: p.url, path: pathOf(p.url), status: p.status } }));
  },
};

const SectionProvider = {
  type: 'section',
  enumerate(collection) {
    const pages = collection.staticPages;
    const out = [];
    for (const p of htmlPages(pages)) {
      const path = pathOf(p.url);
      const heads = [...(p.body || '').matchAll(/<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/gi)];
      let i = 0;
      for (const m of heads) {
        const text = stripText(m[2]).slice(0, 60);
        if (!text) continue;
        i++;
        out.push({ identityKey: 'section:' + path + '#' + (slug(text) || 'h' + i), meta: { url: p.url, path, heading: text, level: +m[1] } });
      }
    }
    return out;
  },
};

const ASSET_RULES = [
  { role: 'image', re: /<img\b[^>]*?\ssrc\s*=\s*["']([^"']+)["']/gi },
  { role: 'image', re: /<img\b[^>]*?\sdata-src\s*=\s*["']([^"']+)["']/gi },
  { role: 'bg-image', re: /url\(\s*["']?([^"')]+\.(?:png|jpe?g|webp|avif|gif|svg))["']?\s*\)/gi },
  { role: 'svg-file', re: /\ssrc\s*=\s*["']([^"']+\.svg)["']/gi },
  { role: 'favicon', re: /<link\b[^>]*rel\s*=\s*["'][^"']*icon[^"']*["'][^>]*href\s*=\s*["']([^"']+)["']/gi },
  { role: 'app-icon', re: /<link\b[^>]*rel\s*=\s*["']apple-touch-icon["'][^>]*href\s*=\s*["']([^"']+)["']/gi },
  { role: 'manifest', re: /<link\b[^>]*rel\s*=\s*["']manifest["'][^>]*href\s*=\s*["']([^"']+)["']/gi },
  { role: 'font', re: /["']([^"']+\.(?:woff2?|ttf|otf|eot))["']/gi },
  { role: 'video', re: /<(?:video|source)\b[^>]*\ssrc\s*=\s*["']([^"']+\.(?:mp4|webm|ogg))["']/gi },
  { role: 'document', re: /<a\b[^>]*\shref\s*=\s*["']([^"']+\.(?:pdf|docx?|xlsx?|pptx?|zip|csv))(?:["'?#])/gi },
  { role: 'og-image', re: /<meta\b[^>]*property\s*=\s*["']og:image["'][^>]*content\s*=\s*["']([^"']+)["']/gi },
];
const AssetProvider = {
  type: 'asset',
  enumerate(collection) {
    const pages = collection.staticPages;
    const seen = new Map();
    for (const p of htmlPages(pages)) {
      const body = p.body || '';
      for (const rule of ASSET_RULES) {
        rule.re.lastIndex = 0; let m;
        while ((m = rule.re.exec(body))) {
          const src = m[1]; const fn = basename(src);
          if (!fn) continue;
          const key = 'asset:' + rule.role + ':' + fn;
          if (!seen.has(key)) seen.set(key, { identityKey: key, meta: { role: rule.role, filename: fn, src: src.slice(0, 160), firstPage: p.url } });
        }
      }
    }
    return [...seen.values()];
  },
};

// global component key → detection signal (regex over page body/head)
const GLOBAL_SIGNALS = {
  'header': /<header[\s>]|role\s*=\s*["']banner["']/i,
  'footer': /<footer[\s>]|role\s*=\s*["']contentinfo["']/i,
  'nav': /<nav[\s>]|role\s*=\s*["']navigation["']/i,
  'mobile-nav': /class\s*=\s*["'][^"']*(?:hamburger|menu-toggle|mobile-menu|navbar-toggle|nav-toggle)[^"']*["']|aria-label\s*=\s*["'][^"']*menu[^"']*["']/i,
  'mega-menu': /class\s*=\s*["'][^"']*(?:mega-?menu)[^"']*["']/i,
  'sticky-header': /class\s*=\s*["'][^"']*(?:sticky|fixed-header|header--fixed|is-sticky|is-fixed)[^"']*["']/i,
  'announcement-bar': /class\s*=\s*["'][^"']*(?:announce|announcement|top-?bar|promo-?bar|notification-?bar|utility-?bar)[^"']*["']/i,
  'cookie-banner': /class\s*=\s*["'][^"']*(?:cookie|consent)[^"']*["']|id\s*=\s*["'][^"']*(?:cookie|onetrust|cookiebot|termly|osano|iubenda)[^"']*["']/i,
  'newsletter-popup': /class\s*=\s*["'][^"']*newsletter[^"']*["'][\s\S]{0,400}(?:popup|modal)|class\s*=\s*["'][^"']*(?:popup|modal)[^"']*["'][\s\S]{0,400}newsletter/i,
  'chat-widget': /intercom|drift\.com|tawk\.to|crisp\.chat|zendesk|livechat|hubspot-messages|tidio|widget\.freshworks/i,
  'whatsapp': /wa\.me\/|api\.whatsapp\.com/i,
  'messenger': /m\.me\/|facebook\.com\/messages|fb-customerchat/i,
  'phone-button': /href\s*=\s*["']tel:/i,
  'email-button': /href\s*=\s*["']mailto:/i,
  'back-to-top': /class\s*=\s*["'][^"']*(?:back-to-top|scroll-to-top|scrolltop|to-top)[^"']*["']/i,
  'a11y-widget': /userway|accessibe|acsb|class\s*=\s*["'][^"']*accessibility-widget[^"']*["']/i,
  'language-switcher': /class\s*=\s*["'][^"']*(?:lang-switch|language-select|lang-selector)[^"']*["']|rel\s*=\s*["']alternate["'][^>]*hreflang/i,
  'theme-toggle': /class\s*=\s*["'][^"']*(?:theme-toggle|dark-mode|color-scheme-toggle)[^"']*["']/i,
  'search-overlay': /class\s*=\s*["'][^"']*(?:search-overlay|search-modal)[^"']*["']/i,
  'account-menu': /class\s*=\s*["'][^"']*(?:my-account|account-menu)[^"']*["']/i,
  'mini-cart': /class\s*=\s*["'][^"']*(?:mini-?cart|cart-drawer)[^"']*["']/i,
  'wishlist': /class\s*=\s*["'][^"']*wishlist[^"']*["']/i,
  'currency-selector': /class\s*=\s*["'][^"']*currency[^"']*["']/i,
  // tracking
  'analytics-ga4': /gtag\(|googletagmanager\.com\/gtag|\bG-[A-Z0-9]{6,}\b/,
  'tag-manager': /googletagmanager\.com\/gtm|GTM-[A-Z0-9]{4,}/,
  'facebook-pixel': /connect\.facebook\.net|fbq\(/,
  'linkedin': /snap\.licdn\.com|_linkedin_partner_id/,
  'tiktok': /analytics\.tiktok\.com|ttq\./,
};
const GlobalProvider = {
  type: 'global',
  enumerate(collection) {
    const pages = collection.staticPages;
    const out = [];
    for (const [key, re] of Object.entries(GLOBAL_SIGNALS)) {
      const hit = anyPage(pages, re);
      if (hit) out.push({ identityKey: 'global:' + key, meta: { key, firstPage: hit.url } });
    }
    return out;
  },
};

const FormProvider = {
  type: 'form',
  enumerate(collection) {
    const pages = collection.staticPages;
    const out = []; const seen = new Set();
    for (const p of htmlPages(pages)) {
      const forms = [...(p.body || '').matchAll(/<form\b[\s\S]*?<\/form>/gi)];
      forms.forEach((m, i) => {
        const f = m[0];
        const action = (f.match(/\saction\s*=\s*["']([^"']*)["']/i) || [])[1] || '';
        const inputs = [...f.matchAll(/<(input|select|textarea)\b[^>]*>/gi)];
        const fieldCount = inputs.length;
        const hasPw = /type\s*=\s*["']password["']/i.test(f);
        const hasValidation = /\brequired\b|\spattern\s*=/i.test(f);
        const lc = (f + ' ' + action).toLowerCase();
        let type = 'form';
        if (hasPw && /(register|signup|sign-up|create.account)/.test(lc)) type = 'registration';
        else if (hasPw) type = 'login';
        else if (/(checkout|payment|billing|card-number)/.test(lc)) type = 'checkout';
        else if (/(booking|appointment|reserve|schedule)/.test(lc)) type = 'booking';
        else if (/(quote|estimate)/.test(lc)) type = 'quote';
        else if (/(newsletter|subscribe)/.test(lc) || (fieldCount <= 2 && /email/.test(lc))) type = 'newsletter';
        else if (/type\s*=\s*["']search["']|role\s*=\s*["']search["']|name\s*=\s*["'][qs]["']/i.test(f)) type = 'search';
        else if (/(message|comment|enquir|inquir|contact)/.test(lc)) type = 'contact';
        // DEFECT-2 fix: site search is a GLOBAL form (in the header, on every page) — one identity,
        // deduped across pages. Actionless/javascript forms fall back to page-scoped identity.
        const globalAction = action && !/^\s*(javascript:|#|void)/i.test(action) ? pathOf(action) : null;
        const key = type === 'search' ? 'form:search'
          : 'form:' + type + ':' + (globalAction || pathOf(p.url) + '#' + i);
        if (seen.has(key)) return; seen.add(key);
        out.push({ identityKey: key, meta: { formType: type, action, fieldCount, hasValidation, page: p.url } });
      });
    }
    return out;
  },
};

const BEHAVIOR_SIGNALS = {
  'sticky-header': GLOBAL_SIGNALS['sticky-header'],
  'accordion': /class\s*=\s*["'][^"']*accordion[^"']*["']|<details[\s>]/i,
  'tabs': /class\s*=\s*["'][^"']*\btabs?\b[^"']*["']|role\s*=\s*["']tab["']/i,
  'carousel': /class\s*=\s*["'][^"']*(?:carousel|slider|swiper|slick|splide|glide|flickity)[^"']*["']/i,
  'modal': /class\s*=\s*["'][^"']*modal[^"']*["']|role\s*=\s*["']dialog["']/i,
  'drawer': /class\s*=\s*["'][^"']*(?:drawer|offcanvas|off-canvas)[^"']*["']/i,
  'search-overlay': GLOBAL_SIGNALS['search-overlay'],
  'video-playback': /<video[\s>]|youtube\.com\/embed|player\.vimeo\.com/i,
  'dropdown': /class\s*=\s*["'][^"']*dropdown[^"']*["']/i,
  'mega-menu': GLOBAL_SIGNALS['mega-menu'],
  'infinite-scroll': /class\s*=\s*["'][^"']*infinite[^"']*["']|data-infinite/i,
  'pagination': /class\s*=\s*["'][^"']*(?:pagination|pager)[^"']*["']|rel\s*=\s*["']next["']/i,
  'lazy-load': /loading\s*=\s*["']lazy["']|data-lazy/i,
  'back-to-top': GLOBAL_SIGNALS['back-to-top'],
  'cookie-banner': GLOBAL_SIGNALS['cookie-banner'],
  'theme-switch': GLOBAL_SIGNALS['theme-toggle'],
  'language-switch': GLOBAL_SIGNALS['language-switcher'],
};
const BehaviorProvider = {
  type: 'behavior',
  enumerate(collection) {
    const pages = collection.staticPages;
    const out = [];
    for (const [key, re] of Object.entries(BEHAVIOR_SIGNALS)) {
      const hit = anyPage(pages, re);
      if (hit) out.push({ identityKey: 'behavior:' + key, meta: { key, firstPage: hit.url } });
    }
    return out;
  },
};

// Component-level enumeration is reserved (needs the render-time element read); interface honoured.
// ComponentProvider — THE PROVIDER THE OLD CONTRACT COULD NOT CARRY, and the A1 demonstration that the
// widened one can. It has been a stub since it was written for exactly one reason, recorded at the top
// of this file: component enumeration needs the render-time element read, and `enumerate(pages, host)`
// could only ever hand it static HTML. It is not a missing feature — it is the contract refusing a
// legitimate provider (ADR-0004 §Context/2).
//
// It now reads `collection.render`, a channel no collector fills yet (that is ADR-0005/0006 work,
// explicitly out of A1 scope). So it still returns zero items — BY EVIDENCE, not by hard-coding: the
// channel is read, found empty, and reported empty.
//
// The throw is deliberate and matches this codebase's oldest discipline (`registry.validate()`,
// `assertTransition()`, `notRunRow`): if a render channel ever IS populated, returning [] would mint
// "this site has no components" out of an unimplemented code path — the exact green-tick-from-nothing
// defect the engine has spent several releases eliminating. Fail closed instead, and name the ADR that
// owns the missing half.
const ComponentProvider = {
  type: 'component',
  enumerate(collection) {
    const render = collection.render;
    if (!render.length) return [];
    throw new Error('inventory: component enumeration over a populated render channel is not implemented (out of ADR-0004 A1 scope — see ADR-0005/ADR-0006)');
  },
};

// ── NetworkProvider (ADR-0005) — the first provider over a NON-staticPages channel ────────────────
// Reads `collection.network` (the Network Collector's records) and enumerates one inventory item per
// logical request. Pure: no browser, no filesystem, no clock, no scoring, no formatting.
//
// DETERMINISM IS THE WHOLE POINT, so the item deliberately carries LESS than the record does. A record
// holds `timing` and `capturedAt` — real, wanted, and different on every run. Copying them into an
// inventory item would make the inventory non-reproducible and quietly destroy replay ("same
// collection → same score, forever", ADR-0004 §D3). They stay in the collection as evidence, and the
// item points back at them by index. That index-not-copy seam is what ADR-0007's Evidence Ledger will
// formalise.
//
// IDENTITY = method + URL, fragment stripped, QUERY PRESERVED. A cache-busted asset really is a
// different request, so this is intentionally NOT the aggressive page-URL normalisation in
// lib/fingerprint.js. Repeat requests for the same URL collapse onto one item and are counted.
const NetworkProvider = {
  type: 'network',
  enumerate(collection) {
    // Seam validator (ADR-0004 §D7). Handed anything that is not a Collection — a bare array, null, a
    // look-alike — this throws instead of quietly returning []. Without it, `wasCollected` on a bare
    // array is simply false and the provider reports "no network items" for input it never understood:
    // a wrong answer dressed as a clean one. Caught by network-ledger.test.js, not by inspection.
    assertCollection(collection, 'network provider');
    // "Never looked" and "looked, saw nothing" are different facts. If no collector declared this
    // channel, the provider contributes NOTHING and claims nothing — it does not throw, because a
    // static-only crawl legitimately has no network channel and every existing caller is exactly that.
    // The distinction survives for consumers via `wasCollected(collection, 'network')`; a rule or view
    // that means to make a CLAIM about network must consult it. That duty is the consumer's, and
    // consumers are out of ADR-0005 scope.
    if (!wasCollected(collection, 'network')) return [];
    const recs = collection.network;
    const byKey = new Map();
    recs.forEach((r, idx) => {
      // Fail closed on a malformed record. A ledger that silently drops unreadable rows under-reports
      // while looking complete, which is the failure mode this engine keeps having to un-ship.
      if (!r || typeof r !== 'object' || typeof r.url !== 'string' || !r.url) {
        throw new Error(`network provider: malformed record at index ${idx} (a record must carry a url) — the collector produced something this contract cannot read`);
      }
      const method = r.method || 'GET';
      const key = 'network:' + method + ' ' + r.url;
      let m = byKey.get(key);
      if (!m) {
        let origin = null, path = null;
        try { const u = new URL(r.url); origin = u.origin; path = u.pathname; } catch (_) { /* non-absolute (data:, blob:) — stay null, never guess */ }
        m = {
          identityKey: key,
          meta: {
            url: r.url, method, origin, path,
            resourceType: r.resourceType != null ? r.resourceType : null,
            status: r.status != null ? r.status : null,
            mimeType: r.mimeType != null ? r.mimeType : null,
            sizeBytes: r.sizeBytes != null ? r.sizeBytes : null,
            // Preserved as recorded — null here means the collector could not observe it, which is a
            // different claim from `false`/`0` and must stay different.
            fromCache: r.fromCache != null ? r.fromCache : null,
            protocol: r.protocol != null ? r.protocol : null,
            initiator: r.initiator != null ? r.initiator : null,
            failure: r.failure != null ? r.failure : null,
            occurrences: 0,
            recordIndexes: [],   // -> collection.network; evidence stays in the collection, not copied
          },
        };
        byKey.set(key, m);
      }
      m.meta.occurrences++;
      m.meta.recordIndexes.push(idx);
    });
    return [...byKey.values()];
  },
};

// ── DocumentAssetProvider (ADR-0006) — the second provider over a non-staticPages channel ─────────
// Reads `collection.documents` (the Document Collector's per-document asset lists) and enumerates one
// inventory item per logical document asset. Pure: no browser, no filesystem, no Playwright, no clock,
// no scoring, no formatting — and, per ADR-0006's brief, NO CLASSIFICATION. It does not decide what
// blocks rendering, what is a tracker, what is duplicated or what is unused. Those are rules and views.
//
// DOCUMENT ORDER IS PRESERVED, NOT IMPOSED. Items come back in the order the collector recorded them
// (documents in collection order, assets in document order). Nothing here sorts. `buildInventory` DOES
// sort by identityKey before minting IDs — that is a pre-existing, deliberate property of the inventory
// layer (deterministic mint order) and is unrelated to asset order, which is preserved inside
// `meta.index` / `meta.sectionIndex` where an order-dependent consumer will read it.
//
// IDENTITY. External assets key on their URL, so the same stylesheet referenced from two pages is two
// items (a document asset belongs to its document — unlike a network request, which is one logical
// request however many pages ask for it). Inline assets have no URL, so they key on their ordinal
// within (document, section, tag) — stable for a stable document, which is the most that can honestly
// be claimed for a thing with no identity of its own.
const DocumentAssetProvider = {
  type: 'document',
  enumerate(collection) {
    assertCollection(collection, 'document-asset provider');
    // Same rule as NetworkProvider: an undeclared channel yields no items and makes NO claim. A
    // static-only crawl legitimately has no document channel. `wasCollected` keeps the distinction
    // available to any consumer that means to assert something about document assets.
    if (!wasCollected(collection, 'documents')) return [];
    const docs = collection.documents;
    const out = [];
    docs.forEach((d, di) => {
      // Fail closed on a malformed document entry rather than skipping it: an inventory that silently
      // drops what it cannot read under-reports while looking complete.
      if (!d || typeof d !== 'object' || !Array.isArray(d.assets)) {
        throw new Error(`document-asset provider: malformed document entry at index ${di} (needs an assets array) — the collector produced something this contract cannot read`);
      }
      const docUrl = typeof d.documentUrl === 'string' ? d.documentUrl : '';
      let docPath = docUrl;
      try { const u = new URL(docUrl); docPath = u.pathname; } catch (_) { /* relative or absent — keep as given, never guess */ }
      d.assets.forEach((a, ai) => {
        if (!a || typeof a !== 'object' || typeof a.tag !== 'string' || !a.tag) {
          throw new Error(`document-asset provider: malformed asset at document ${di} index ${ai} (needs a tag)`);
        }
        const url = a.src || a.href || null;
        const who = url != null ? url : `inline#${a.inlineIndex != null ? a.inlineIndex : ai}`;
        out.push({
          identityKey: `docasset:${docPath}|${a.section}|${a.tag}|${who}`,
          meta: {
            documentUrl: docUrl || null,
            path: docPath || null,
            source: typeof d.source === 'string' ? d.source : null,
            // position — the whole point of a document inventory
            index: typeof a.index === 'number' ? a.index : ai,
            sectionIndex: typeof a.sectionIndex === 'number' ? a.sectionIndex : null,
            section: a.section || null,
            tag: a.tag,
            inline: !!a.inline,
            external: !!a.external,
            href: a.href != null ? a.href : null,
            src: a.src != null ? a.src : null,
            rel: a.rel != null ? a.rel : null,
            relTokens: a.relTokens != null ? a.relTokens : null,
            type: a.type != null ? a.type : null,
            media: a.media != null ? a.media : null,
            integrity: a.integrity != null ? a.integrity : null,
            crossorigin: a.crossorigin != null ? a.crossorigin : null,
            async: !!a.async,
            defer: !!a.defer,
            module: !!a.module,
            nomodule: !!a.nomodule,
            attrs: a.attrs && typeof a.attrs === 'object' ? a.attrs : null,
            // Evidence stays in the collection; the item points back at it. Same index-not-copy seam
            // as ADR-0005, and the shape ADR-0007 will formalise. `raw` and `capturedAt` deliberately
            // do NOT travel into the item.
            recordIndexes: [{ document: di, asset: ai }],
          },
        });
      });
    });
    return out;
  },
};

const PROVIDERS = [PageProvider, SectionProvider, ComponentProvider, GlobalProvider, AssetProvider, FormProvider, BehaviorProvider, NetworkProvider, DocumentAssetProvider];

module.exports = {
  PROVIDERS, PageProvider, SectionProvider, ComponentProvider, GlobalProvider, AssetProvider, FormProvider, BehaviorProvider,
  pathOf, basename, htmlPages,
};
