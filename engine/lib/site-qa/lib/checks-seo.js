'use strict';
// lib/checks-seo.js — SEO Batch 3 (V2). Per-page, static, deterministic. hreflang validity +
// indexability-signal conflicts are Verified; thin-content + readability are Derived (computed from
// observed text, flagged conservatively). Image/video/news sitemap validation is DEFERRED (needs
// sitemap-XML fetch/parse) — tracked in the roadmap, not shipped in this batch.
const REG = require('../rules/registry');

function F(ruleId, check, detail, url, value) {
  const r = REG.getById(ruleId);
  return { ruleId, check, section: '8 SEO', severity: r ? r.severity : null, title: r ? r.title : ruleId,
    detail: detail || '', location: url, value: value == null ? '' : String(value) };
}

const HREFLANG_RE = /^([a-z]{2,3}(-[A-Za-z]{2,4})?|x-default)$/;

function metaRobots(html) {
  const m = html.match(/<meta\b[^>]*name\s*=\s*["']robots["'][^>]*content\s*=\s*["']([^"']*)["']/i);
  return m ? m[1].toLowerCase() : '';
}
function canonicalHref(html) {
  const m = html.match(/<link\b[^>]*rel\s*=\s*["']canonical["'][^>]*href\s*=\s*["']([^"']+)["']/i);
  return m ? m[1].trim() : '';
}
function samePath(a, b) {
  try { const x = new URL(a), y = new URL(b, a); return (x.pathname.replace(/\/+$/, '')) === (y.pathname.replace(/\/+$/, '')); } catch (_) { return a === b; }
}
function countSyllables(w) {
  w = w.toLowerCase().replace(/[^a-z]/g, ''); if (w.length <= 3) return w ? 1 : 0;
  w = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '');
  const m = w.match(/[aeiouy]{1,2}/g); return m ? m.length : 1;
}
function flesch(text) {
  const sentences = (text.match(/[.!?]+/g) || []).length || 1;
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < 30) return null; // too short to score meaningfully
  const syll = words.reduce((a, w) => a + countSyllables(w), 0);
  return 206.835 - 1.015 * (words.length / sentences) - 84.6 * (syll / words.length);
}

function seoPageChecks(ctx) {
  const out = [];
  if (!ctx.isHtml || !ctx.html) return out;
  const html = ctx.html;

  // SEO-031 hreflang — validate codes + require x-default when a cluster is declared
  const hreflangs = [...html.matchAll(/<link\b[^>]*rel\s*=\s*["']alternate["'][^>]*hreflang\s*=\s*["']([^"']+)["']/gi)].map(m => m[1].trim());
  if (hreflangs.length) {
    const invalid = hreflangs.filter(h => !HREFLANG_RE.test(h));
    const hasDefault = hreflangs.some(h => h.toLowerCase() === 'x-default');
    if (invalid.length) out.push(F('SEO-031', 'seo-hreflang', `invalid hreflang value(s): ${invalid.slice(0, 4).join(', ')}`, ctx.url, invalid.length));
    else if (!hasDefault) out.push(F('SEO-031', 'seo-hreflang', `${hreflangs.length} hreflang alternates but no x-default — search engines have no fallback locale`, ctx.url, 'no x-default'));
  }

  // indexability signals
  const mRobots = metaRobots(html);
  const xRobots = String((ctx.headers && ctx.headers['x-robots-tag']) || '').toLowerCase();
  const canon = canonicalHref(html);
  const metaNoindex = /noindex/.test(mRobots);
  const xNoindex = /noindex/.test(xRobots);

  // SEO-035 noindex + a canonical pointing to a DIFFERENT url — contradictory (noindex says "drop me",
  // canonical says "consolidate onto that other url"): pick one signal.
  if ((metaNoindex || xNoindex) && canon && !samePath(ctx.url, canon)) {
    out.push(F('SEO-035', 'seo-index', `page is noindex yet canonical → ${canon.slice(0, 80)} — conflicting indexing signals`, ctx.url, 'noindex+canonical'));
  }
  // SEO-036 meta robots and X-Robots-Tag disagree on index/noindex
  if (mRobots && xRobots && (metaNoindex !== xNoindex)) {
    out.push(F('SEO-036', 'seo-index', `meta robots ("${mRobots}") and X-Robots-Tag ("${xRobots}") disagree`, ctx.url, 'robots-conflict'));
  }

  // Derived — thin content / readability, only on pages that look like content (have main/article text)
  const prose = (ctx.prose || ctx.text || '').replace(/\s+/g, ' ').trim();
  const words = prose ? prose.split(/\s+/).filter(Boolean) : [];
  const looksContent = /<(main|article)\b/i.test(html);
  if (looksContent) {
    if (words.length > 0 && words.length < 100) out.push(F('SEO-037', 'seo-content', `only ${words.length} words of body copy — likely thin content`, ctx.url, `${words.length}w`));
    const fre = flesch(prose);
    if (fre != null && fre < 30) out.push(F('SEO-038', 'seo-content', `Flesch reading ease ${Math.round(fre)} (<30 = very hard) — dense/complex copy`, ctx.url, Math.round(fre)));
  }
  return out;
}

module.exports = { seoPageChecks, flesch };
