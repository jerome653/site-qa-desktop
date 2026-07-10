'use strict';
// providers.js — the Provider layer (frozen spec). Each provider enumerates ONE inventory type from a
// crawl result (pages carry { url, body, headers, status }). Providers implement a stable interface —
// `enumerate(pages, host) → [{ identityKey, meta }]` — so new inventory types (ecommerce/LMS/booking)
// plug in without touching the engine. Detection is deterministic + conservative (reuses existing
// signal patterns). Component-level enumeration is RESERVED (needs the render-time element read).
//
// identityKey is the STABLE logical identity (→ id-registry mints the stable ID). It must not depend on
// discovery order or run — it is derived from the object's nature (path, role+filename, component key).

function pathOf(u) { try { const x = new URL(u); return (x.pathname.replace(/\/+$/, '') || '/'); } catch (_) { return u; } }
function basename(u) { try { const x = new URL(u, 'http://x/'); return (x.pathname.split('/').pop() || u).toLowerCase().slice(0, 80); } catch (_) { return String(u).split('/').pop().toLowerCase().slice(0, 80); } }
function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50); }
function htmlPages(pages) { return pages.filter(p => p.status === 200 && (/text\/html/i.test(p.contentType || '') || /<html[\s>]/i.test(p.body || ''))); }
function stripText(s) { return String(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); }
// does ANY html page match re? returns {url} of the first, or null
function anyPage(pages, re) { for (const p of htmlPages(pages)) if (re.test(p.body || '')) return { url: p.url }; return null; }

const PageProvider = {
  type: 'page',
  enumerate(pages) {
    return htmlPages(pages).map(p => ({ identityKey: 'page:' + pathOf(p.url), meta: { url: p.url, path: pathOf(p.url), status: p.status } }));
  },
};

const SectionProvider = {
  type: 'section',
  enumerate(pages) {
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
  enumerate(pages) {
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
  enumerate(pages) {
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
  enumerate(pages) {
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
  enumerate(pages) {
    const out = [];
    for (const [key, re] of Object.entries(BEHAVIOR_SIGNALS)) {
      const hit = anyPage(pages, re);
      if (hit) out.push({ identityKey: 'behavior:' + key, meta: { key, firstPage: hit.url } });
    }
    return out;
  },
};

// Component-level enumeration is reserved (needs the render-time element read); interface honoured.
const ComponentProvider = { type: 'component', enumerate() { return []; } };

const PROVIDERS = [PageProvider, SectionProvider, ComponentProvider, GlobalProvider, AssetProvider, FormProvider, BehaviorProvider];

module.exports = {
  PROVIDERS, PageProvider, SectionProvider, ComponentProvider, GlobalProvider, AssetProvider, FormProvider, BehaviorProvider,
  pathOf, basename, htmlPages,
};
