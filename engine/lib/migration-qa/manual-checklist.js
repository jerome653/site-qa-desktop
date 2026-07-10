'use strict';
// migration-qa/manual-checklist.js — the human-judgment items that code cannot certify.
//
// v2.0 Standard §1 (design accuracy), §3 (form/interactive flows), §5 (cross-browser), §11 (CMS),
// plus the migration-preservation items that need the OLD site / Search Console (SOP Phase 10/11).
// Emitted as unchecked boxes in the report: the automated pass alone is never "READY" — v2.0 DoD
// also requires manual sign-off. Split by env so staging QA and launch/post-launch don't intermix.

const STAGING = [
  { section: '1 Visual', item: 'Every page matches the approved design (layout, spacing, typography, colors, hover/active states) vs live/Figma reference.' },
  { section: '2 Content', item: 'No missing or duplicated copy vs the content inventory; punctuation/capitalization correct; lists render.' },
  { section: '3 Functional', item: 'Every form submits → validation, success + error states, email notification received, CRM/webhook fires, spam protection active.' },
  { section: '3 Functional', item: 'Interactive components tested (accordions, tabs, sliders, carousels, popups/modals, search, filters, pagination, galleries, maps, video/audio, booking/calendars).' },
  { section: '4 Responsive', item: 'Multi-viewport eyeball pass in the Responsive Viewer extension (device frames), portrait + landscape — beyond the automated overflow sweep.' },
  { section: '5 Browser', item: 'Cross-browser parity: Chrome, Edge, Safari, Firefox + mobile browsers (automated render is Chromium only).' },
  { section: '11 CMS', item: 'Editable fields, dynamic collections, and CMS-driven images render; draft content is excluded from the build; editor permissions verified.' },
  { section: '12 Global Components', item: 'Announcement bar, cookie banner, floating CTAs, newsletter signup, mega-menu, mobile menu behave correctly (presence is auto-checked; behavior is not).' },
];

const LAUNCH = [
  { section: '8 SEO', item: 'Redirect map executed: every OLD url 301s (or 410s if removed) to the correct new url — spot-check a sample on the live domain. (Automate with --redirects <file>.)' },
  { section: '8 SEO', item: 'Existing rankings / indexed URLs preserved; noindex removed on production; canonical points to the prod domain.' },
  { section: '9 Analytics', item: 'GA4 / GTM / Search Console / Meta Pixel actually FIRING on the live domain (real-time report), not just present in markup.' },
  { section: '10 Technical', item: 'SSL certificate valid for the production domain; HTTPS enforced; no mixed content; error logs clean after cut-over.' },
  { section: '10 Technical', item: 'DNS cut-over correct; email delivery from the domain works; caching/CDN warmed.' },
  { section: '8 SEO', item: 'Updated XML sitemap submitted to Google Search Console + Bing Webmaster Tools.' },
  { section: '11 Monitoring', item: '2–4 week watch window: 404s, redirect issues, crawl errors, Core Web Vitals, rankings, organic traffic, conversions, form submissions, server logs.' },
];

function manualChecklist(env) {
  return env === 'live'
    ? { title: 'Launch & Post-Launch sign-off (SOP Phase 10–11)', items: LAUNCH }
    : { title: 'Staging QA sign-off (SOP Phase 9)', items: STAGING };
}

module.exports = { manualChecklist, STAGING, LAUNCH };
