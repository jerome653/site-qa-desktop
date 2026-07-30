'use strict';
// tech-stack.js — what is this site BUILT on? Deterministic, offline, signature-based.
//
// WHY. A post-deployment check that only proves the new site is a faithful COPY has not proved it is a
// production site. "Is this really WordPress behind Cloudflare, or did the staging build go to
// production?" is a question the crawl already holds the evidence for — HTML fingerprints and response
// headers, both already fetched — and never asked.
//
// WHAT THIS IS NOT. It is not a certainty engine. A generator meta tag can be removed, a header can be
// spoofed or stripped by a proxy, and a headless setup legitimately shows a CMS and a framework at
// once. So this reports SIGNATURES SEEN, and absence is never "not WordPress" — it is "no signature
// seen". Every surface that renders this must carry SIGNATURE_ONLY_NOTE; the distinction between "we
// looked and found nothing" and "there is nothing" is the same distinction the whole product exists to
// keep straight (see reachability.js, and ADR-0011).
//
// No I/O, no dependencies, no network — pure functions over (html, headers).

const SIGNATURE_ONLY_NOTE =
  'Signatures seen in the page and its response headers. A generator tag can be removed and a header '
  + 'can be spoofed or stripped by a proxy, so an empty list means no signature was seen — not that the '
  + 'technology is absent.';

// Each entry: [name, regex over HTML]. Order is fixed so two runs over one site produce one string.
const CMS = [
  ['WordPress', /<meta[^>]+name=["']generator["'][^>]+content=["']WordPress|\/wp-content\/|\/wp-includes\/|wp-json/i],
  ['Shopify', /cdn\.shopify\.com|Shopify\.theme|\/cdn\/shop\//i],
  ['Wix', /wixBiSession|static\.wixstatic\.com|X-Wix-/i],
  ['Squarespace', /squarespace\.com|Static\.SQUARESPACE_CONTEXT/i],
  ['Webflow', /data-wf-site|data-wf-page|assets\.website-files\.com/i],
  ['Drupal', /<meta[^>]+name=["']generator["'][^>]+content=["']Drupal|\/sites\/default\/files\/|drupal-settings-json/i],
  ['Joomla', /<meta[^>]+name=["']generator["'][^>]+content=["']Joomla|\/media\/jui\//i],
  ['Ghost', /<meta[^>]+name=["']generator["'][^>]+content=["']Ghost|ghost-sdk/i],
  ['HubSpot', /hs-scripts\.com|hubspot\.net\/hub\//i],
];

const FRAMEWORK = [
  ['Next.js', /__NEXT_DATA__|\/_next\/static\//i],
  ['Nuxt', /id=["']__nuxt["']|\/_nuxt\//i],
  ['SvelteKit', /__sveltekit|\/_app\/immutable\//i],
  ['Gatsby', /___gatsby|\/page-data\/[^"']*\/page-data\.json/i],
  ['Angular', /ng-version=|<app-root/i],
  ['Vue', /data-v-app|__VUE_/i],
  ['React', /data-reactroot|__REACT_DEVTOOLS_GLOBAL_HOOK__|react-dom/i],
];

const ECOMMERCE = [
  ['WooCommerce', /woocommerce|wc-ajax/i],
  ['Shopify', /Shopify\.checkout|\/cart\/add\.js|cdn\.shopify\.com/i],
  ['Magento', /Magento_|mage\/cookies/i],
  ['BigCommerce', /bigcommerce\.com|stencil-utils/i],
];

// Header-derived. [name, header, regex over its value] — value regex null = presence is enough.
const CDN_HEADERS = [
  ['Cloudflare', 'cf-ray', null],
  ['Cloudflare', 'server', /cloudflare/i],
  ['Vercel', 'x-vercel-id', null],
  ['Netlify', 'x-nf-request-id', null],
  ['CloudFront', 'x-amz-cf-id', null],
  ['Fastly', 'x-served-by', /cache-|fastly/i],
  ['Akamai', 'x-akamai-transformed', null],
];

const SERVERS = [
  ['nginx', /^nginx/i],
  ['Apache', /^apache/i],
  ['LiteSpeed', /litespeed/i],
  ['Microsoft-IIS', /iis|microsoft/i],
  ['Caddy', /^caddy/i],
  ['Google Frontend', /gse|google frontend/i],
];

// Header names arrive lowercased from node, but a stored record or another client may not have done
// that. Normalising here costs one pass and removes a whole class of "works live, fails on replay".
function lowerKeys(headers) {
  const out = {};
  if (headers && typeof headers === 'object') {
    for (const k of Object.keys(headers)) out[String(k).toLowerCase()] = headers[k];
  }
  return out;
}

const matchAll = (list, text) => list.filter(([, re]) => re.test(text)).map(([name]) => name);
const uniq = (a) => [...new Set(a)];

// detectStack(html, headers) -> { cms, framework, ecommerce, server, cdn }
// Every key is ALWAYS an array. An empty array means "looked, saw no signature".
function detectStack(html, headers) {
  const b = typeof html === 'string' ? html : '';
  const h = lowerKeys(headers);
  const serverHeader = String(h['server'] || '');
  const cdn = uniq(CDN_HEADERS
    .filter(([, name, re]) => (h[name] != null) && (re ? re.test(String(h[name])) : true))
    .map(([name]) => name));
  // A pure-CDN Server header ("cloudflare") is the CDN, not the origin server, and reporting it as
  // both would invent an origin the scan never saw.
  const server = cdn.length && /^(cloudflare|vercel|netlify)$/i.test(serverHeader.trim())
    ? [] : matchAll(SERVERS, serverHeader);
  return {
    cms: matchAll(CMS, b),
    framework: matchAll(FRAMEWORK, b),
    ecommerce: matchAll(ECOMMERCE, b),
    server,
    cdn,
  };
}

// Fold per-page results into one site-level view, keeping the page count per signature: a CMS seen on
// 1 of 40 pages is a different fact from one seen on all 40, and usually means a part-migrated site.
function mergeStack(list) {
  const keys = ['cms', 'framework', 'ecommerce', 'server', 'cdn'];
  const counts = {}; const out = {};
  for (const k of keys) counts[k] = new Map();
  for (const s of (Array.isArray(list) ? list : [])) {
    if (!s) continue;
    for (const k of keys) for (const v of (s[k] || [])) counts[k].set(v, (counts[k].get(v) || 0) + 1);
  }
  for (const k of keys) out[k] = [...counts[k].keys()];
  out.pageCounts = Object.fromEntries(keys.map(k => [k, Object.fromEntries(counts[k])]));
  return out;
}

module.exports = { detectStack, mergeStack, SIGNATURE_ONLY_NOTE };
