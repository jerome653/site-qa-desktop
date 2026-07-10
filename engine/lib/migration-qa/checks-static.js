'use strict';
// migration-qa/checks-static.js — the deterministic static-HTML + header check registry.
//
// STATIC_CHECKS runs per page on raw HTML + response headers; SITE_CHECKS runs once for the origin.
// Runtime identity is the native ruleId (WP-001 / ADR-0002): each finding names its registry rule ID;
// severity + title are resolved from the Rule Registry (single source of truth). `check` (family) and
// `section` (v2.0 Standard label) are preserved as presentation/grouping metadata for downstream
// consumers (qa-site suites, qa-migration section verdict) — they are NOT identity.
//
// ENV GATING: dev/QA happens on staging (noindex expected); live is post-cutover verification.
// `opts.env` is 'staging' | 'live'.

const REG = require('../site-qa/rules/registry');

// ---------- shared HTML extraction ----------
function headSlice(html) { const m = html.match(/<head[\s\S]*?<\/head>/i); return m ? m[0] : html.slice(0, 8000); }
function mainSlice(html) { const m = html.match(/<main[\s\S]*?<\/main>/i) || html.match(/<article[\s\S]*?<\/article>/i); return m ? m[0] : html; }
function stripTags(s) { return s.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); }
function attr(tag, name) { const m = tag.match(new RegExp('\\s' + name + '\\s*=\\s*["\']([^"\']*)["\']', 'i')); return m ? m[1] : null; }

// ---------- on-page location ("which section") ----------
const LANDMARKS = ['footer', 'header', 'nav', 'main', 'article', 'aside', 'section'];
function regionAt(html, idx) {
  const seg = html.slice(0, idx); let best = null, bestPos = -1;
  for (const t of LANDMARKS) {
    const openRe = new RegExp('<' + t + '\\b', 'gi'); let m, lastOpen = -1;
    while ((m = openRe.exec(seg))) lastOpen = m.index;
    if (lastOpen < 0 || lastOpen <= bestPos) continue;
    const closeRe = new RegExp('</' + t + '>', 'gi'); let c, lastClose = -1;
    while ((c = closeRe.exec(seg))) lastClose = c.index;
    if (lastOpen > lastClose) { best = t; bestPos = lastOpen; } // opened and not yet closed = we're inside it
  }
  return best;
}
function headingAt(html, idx) {
  const seg = html.slice(0, idx);
  const hs = [...seg.matchAll(/<h[1-4]\b[^>]*>([\s\S]*?)<\/h[1-4]>/gi)];
  if (!hs.length) return null;
  const t = stripTags(hs[hs.length - 1][1]).slice(0, 60);
  return t || null;
}
// human label for a page location, e.g.  “Our Services” (main)  ·  header  ·  —
function sectionAt(html, idx) {
  const h = headingAt(html, idx), r = regionAt(html, idx);
  if (h) return '“' + h + '”' + (r ? ' (' + r + ')' : '');
  return r || '—';
}
// short readable identifier for an image tag
function imgId(tag) {
  const s = attr(tag, 'src') || attr(tag, 'data-src') || (attr(tag, 'srcset') || '').split(/[ ,]/)[0] || '';
  if (s) { try { const u = new URL(s, 'http://x/'); return (u.pathname.split('/').pop() || s).slice(0, 80); } catch (e) { return s.slice(0, 80); } }
  const a = attr(tag, 'alt'); return a ? '[alt="' + a.slice(0, 40) + '"]' : tag.slice(0, 60);
}
// attach an items[] list to a finding (page is added later at aggregation from f.location)
function withItems(finding, items) { if (finding && items && items.length) finding.items = items; return finding; }

function metaContent(head, nameOrProp) {
  const re = new RegExp('<meta\\b[^>]*(?:name|property)\\s*=\\s*["\']' + nameOrProp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '["\'][^>]*>', 'i');
  const m = head.match(re);
  if (!m) return null;
  return attr(m[0], 'content');
}
function xRobots(headers) { return (headers['x-robots-tag'] || '').toLowerCase(); }

const STAGING_HOST_RE = /\b(?:[\w-]+\.)*(?:staging|qa\d?|dev|preview|test)\.[a-z0-9-]+\.[a-z]{2,}\b/i;

function buildCtx(page, host) {
  const html = page.body || '';
  const head = headSlice(html);
  const main = mainSlice(html);
  const titleM = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const imgs = [...html.matchAll(/<img\b[^>]*>/gi)].map(m => m[0]);
  return {
    url: page.url, host, status: page.status, headers: page.headers || {},
    contentType: page.contentType || '', location: page.location, error: page.error,
    html, head, main,
    title: titleM ? stripTags(titleM[1]) : '',
    text: stripTags(main),
    prose: stripTags(main.replace(/<pre[\s\S]*?<\/pre>/gi, ' ').replace(/<code[\s\S]*?<\/code>/gi, ' ').replace(/<textarea[\s\S]*?<\/textarea>/gi, ' ')),
    imgs,
    isHtml: /text\/html/i.test(page.contentType || '') || /<html[\s>]/i.test(html),
  };
}

// F(ruleId, check, section, detail, url, value)
//   ruleId  — native runtime identity (must exist in the registry)
//   check   — check-family (grouping key, presentation)
//   section — v2.0 Standard section label (presentation / migration verdict grouping)
//   severity + title are resolved from the registry — NOT hardcoded here.
function F(ruleId, check, section, detail, url, value) {
  const r = REG.getById(ruleId);
  return { ruleId, check, section, severity: r ? r.severity : null, title: r ? r.title : ruleId, detail: detail || '', location: url, value: value == null ? '' : String(value) };
}

// ---------- per-page checks ----------
const STATIC_CHECKS = [
  // §13/§10 — page status
  { id: 'page-status', section: '10 Technical', fn(c) {
    if (c.status >= 500) return F('FUNC-001', 'page-status', '10 Technical', `HTTP ${c.status}`, c.url, c.status);
    if (c.status >= 400) return F('FUNC-002', 'page-status', '10 Technical', `HTTP ${c.status}`, c.url, c.status);
    if (c.status >= 300) return F('FUNC-003', 'page-status', '10 Technical', `HTTP ${c.status} → ${c.location || '?'}`, c.url, c.status);
    return null;
  } },

  // §1/§4 — viewport meta
  { id: 'viewport-meta', section: '1 Visual / 4 Responsive', fn(c) {
    if (!c.isHtml) return null;
    return /<meta\b[^>]*name\s*=\s*["']viewport["']/i.test(c.head) ? null
      : F('RESP-001', 'viewport-meta', '4 Responsive', 'Mobile browsers render at desktop width — page cannot be responsive.', c.url);
  } },

  // §8 — title
  { id: 'title', section: '8 SEO', fn(c) {
    if (!c.isHtml) return null;
    if (!c.title) return F('SEO-001', 'title', '8 SEO', 'Every page needs a unique title tag.', c.url);
    const n = c.title.length;
    if (n < 10 || n > 70) return F('SEO-002', 'title', '8 SEO', `${n} chars: "${c.title.slice(0, 70)}"`, c.url, n);
    return null;
  } },

  // §8 — meta description
  { id: 'meta-description', section: '8 SEO', fn(c) {
    if (!c.isHtml) return null;
    const d = metaContent(c.head, 'description');
    if (!d) return F('SEO-003', 'meta-description', '8 SEO', 'No <meta name="description">.', c.url);
    const n = d.length;
    if (n < 50 || n > 170) return F('SEO-004', 'meta-description', '8 SEO', `${n} chars`, c.url, n);
    return null;
  } },

  // §8 — canonical (host-match enforced on live only)
  { id: 'canonical', section: '8 SEO', fn(c, o) {
    if (!c.isHtml) return null;
    const m = c.head.match(/<link\b[^>]*rel\s*=\s*["']canonical["'][^>]*>/i);
    if (!m) return F('SEO-005', 'canonical', '8 SEO', 'No <link rel="canonical">.', c.url);
    const href = attr(m[0], 'href');
    if (o.env === 'live' && href) {
      let ch = ''; try { ch = new URL(href, c.url).host; } catch (e) {}
      if (ch && STAGING_HOST_RE.test(ch)) return F('SEO-006', 'canonical', '8 SEO', `canonical host "${ch}" looks like a staging/preview host — leaks staging into the live index`, c.url, ch);
    }
    return null;
  } },

  // §8/§13 — indexability. INVERTS by env.
  { id: 'indexability', section: '8 SEO', fn(c, o) {
    if (!c.isHtml) return null;
    const robots = (metaContent(c.head, 'robots') || '').toLowerCase();
    const noindex = /noindex/.test(robots) || /noindex/.test(xRobots(c.headers));
    if (o.env === 'live') {
      return noindex ? F('SEO-007', 'indexability', '8 SEO', 'Production page carries noindex (robots meta or X-Robots-Tag) — it will be dropped from search. Classic "forgot to remove staging noindex" failure.', c.url, robots || xRobots(c.headers)) : null;
    }
    return noindex ? null : F('SEO-008', 'indexability', '8 SEO', 'Staging should be noindex until launch to avoid premature/duplicate indexing (SOP Phase 2 §09).', c.url);
  } },

  // §8 — staging-URL leak on live. LIVE only.
  { id: 'staging-leak', section: '8 SEO', fn(c, o) {
    if (o.env !== 'live' || !c.isHtml) return null;
    const hits = [...new Set((c.html.match(new RegExp(STAGING_HOST_RE.source, 'gi')) || []))].filter(h => {
      try { return new URL('https://' + h.replace(/^https?:\/\//, '')).host !== c.host; } catch (e) { return true; }
    });
    return hits.length ? F('SEO-030', 'staging-leak', '8 SEO', `references: ${hits.slice(0, 4).join(', ')}`, c.url, hits.length) : null;
  } },

  // §1/§7 — single H1 + heading hierarchy
  { id: 'headings', section: '7 Accessibility', fn(c) {
    if (!c.isHtml) return null;
    const out = [];
    const hs = [...c.html.matchAll(/<h([1-6])\b/gi)].map(m => +m[1]);
    const h1 = hs.filter(l => l === 1).length;
    if (h1 === 0) out.push(F('A11Y-003', 'headings', '7 Accessibility', 'Exactly one top-level heading expected.', c.url, '0 h1'));
    else if (h1 > 1) out.push(F('A11Y-004', 'headings', '7 Accessibility', `${h1} h1 elements`, c.url, h1));
    let prev = 0;
    for (const l of hs) { if (prev && l > prev + 1) { out.push(F('A11Y-005', 'headings', '7 Accessibility', `jumps h${prev} → h${l}`, c.url)); break; } prev = l; }
    return out;
  } },

  // §1/§7 — images: alt coverage + dimensions
  { id: 'images', section: '1 Visual', fn(c) {
    if (!c.isHtml || !c.imgs.length) return null;
    const out = [];
    const tags = [...c.html.matchAll(/<img\b[^>]*>/gi)];
    const item = (m) => ({ id: imgId(m[0]), section: sectionAt(c.html, m.index), value: (attr(m[0], 'src') || attr(m[0], 'data-src') || '').slice(0, 120) });
    const noSrc = tags.filter(m => !/\ssrc\s*=/i.test(m[0]) && !/\sdata-src\s*=/i.test(m[0]) && !/\ssrcset\s*=/i.test(m[0]));
    const noAlt = tags.filter(m => !/\salt\s*=/i.test(m[0]));
    const noDim = tags.filter(m => !/\swidth\s*=/i.test(m[0]) && !/\sheight\s*=/i.test(m[0]));
    if (noSrc.length) out.push(withItems(F('A11Y-007', 'images', '1 Visual', `${noSrc.length} of ${c.imgs.length} images have no src/srcset`, c.url, noSrc.length), noSrc.map(item)));
    if (noAlt.length) out.push(withItems(F('A11Y-006', 'images', '1 Visual', `${noAlt.length} of ${c.imgs.length} images lack alt (a11y + SEO)`, c.url, noAlt.length), noAlt.map(item)));
    if (noDim.length) out.push(withItems(F('A11Y-008', 'images', '1 Visual', `${noDim.length} of ${c.imgs.length} — causes layout shift (CLS)`, c.url, noDim.length), noDim.map(item)));
    return out;
  } },

  // §6 — perf hints: lazy-loading + modern formats
  { id: 'image-perf', section: '6 Performance', fn(c) {
    if (!c.isHtml || c.imgs.length < 4) return null;
    const out = [];
    const tags = [...c.html.matchAll(/<img\b[^>]*>/gi)];
    const hasModernPicture = /<source[^>]*type=["']image\/(webp|avif)/i.test(c.html);
    const item = (m) => ({ id: imgId(m[0]), section: sectionAt(c.html, m.index), value: (attr(m[0], 'src') || attr(m[0], 'data-src') || '').slice(0, 120) });
    const notLazy = tags.filter(m => !/loading\s*=\s*["']lazy["']/i.test(m[0]));
    const notModern = tags.filter(m => !/\.(webp|avif)\b/i.test(m[0]) && !hasModernPicture);
    if ((c.imgs.length - notLazy.length) / c.imgs.length < 0.5) out.push(withItems(F('PERF-003', 'image-perf', '6 Performance', `${c.imgs.length - notLazy.length}/${c.imgs.length} images use loading="lazy"`, c.url, notLazy.length), notLazy.map(item)));
    if (!hasModernPicture && notModern.length === c.imgs.length) out.push(withItems(F('PERF-004', 'image-perf', '6 Performance', 'Modern formats cut payload / improve LCP.', c.url, notModern.length), notModern.map(item)));
    return out;
  } },

  // §8/§2 — Open Graph + Twitter
  { id: 'social-meta', section: '8 SEO', fn(c) {
    if (!c.isHtml) return null;
    const out = [];
    const missingOg = ['og:title', 'og:description', 'og:image'].filter(p => !metaContent(c.head, p));
    if (missingOg.length) out.push(withItems(F('SEO-011', 'social-meta', '8 SEO', `missing: ${missingOg.join(', ')}`, c.url), missingOg.map(p => ({ id: '<meta property="' + p + '">', section: '<head>', value: 'absent' }))));
    if (!metaContent(c.head, 'twitter:card')) out.push(F('SEO-012', 'social-meta', '8 SEO', 'No Twitter card meta.', c.url));
    return out;
  } },

  // §8 — favicon
  { id: 'favicon', section: '8 SEO', fn(c) {
    if (!c.isHtml) return null;
    return /<link\b[^>]*rel\s*=\s*["'][^"']*icon[^"']*["']/i.test(c.head) ? null
      : F('SEO-014', 'favicon', '8 SEO', 'No <link rel="icon">.', c.url);
  } },

  // §8 — structured data
  { id: 'schema', section: '8 SEO', fn(c) {
    if (!c.isHtml) return null;
    const blocks = [...c.html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
    if (!blocks.length) return F('SEO-016', 'schema', '8 SEO', 'No schema.org markup found (advisory).', c.url);
    for (const b of blocks) {
      let j; try { j = JSON.parse(b.trim()); } catch (e) { return F('SEO-017', 'schema', '8 SEO', `does not parse: ${String(e.message).slice(0, 60)}`, c.url); }
      const items = Array.isArray(j) ? j : (Array.isArray(j['@graph']) ? j['@graph'] : [j]);
      for (const it of items) if (it && typeof it === 'object' && !it['@type']) return F('SEO-018', 'schema', '8 SEO', 'a structured-data item has no @type — engines can’t classify it', c.url);
      if (!Array.isArray(j) && !/schema\.org/i.test(JSON.stringify(j['@context'] || ''))) return F('SEO-019', 'schema', '8 SEO', 'declare "@context":"https://schema.org"', c.url);
    }
    return null;
  } },

  // §2 — placeholder / lorem / TODO in visible copy
  { id: 'placeholder-content', section: '2 Content', fn(c) {
    if (!c.isHtml) return null;
    const p = c.prose;
    const hits = [];
    if (/lorem ipsum|lipsum/i.test(p)) hits.push('lorem ipsum');
    if (/\byour (?:text|content|headline|title|image|logo) here\b/i.test(p)) hits.push('"…here" placeholder');
    if (/\b(?:sample|dummy|placeholder) (?:text|content|copy)\b/i.test(p)) hits.push('sample/dummy text');
    if (/\b(?:TODO|FIXME|TBD|coming soon\.\.\.|insert .* here)\b/i.test(p)) hits.push('TODO/TBD/insert marker');
    return hits.length ? F('FUNC-004', 'placeholder-content', '2 Content', hits.join(', '), c.url) : null;
  } },

  // §2 — empty code blocks / broken tables
  { id: 'broken-rich-content', section: '2 Content', fn(c) {
    if (!c.isHtml) return null;
    const out = [];
    const codes = [...(c.main.match(/<pre\b[\s\S]*?<\/pre>/gi) || []), ...(c.main.match(/<code\b[\s\S]*?<\/code>/gi) || [])];
    const empty = codes.filter(x => x.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim().length === 0).length;
    if (empty) out.push(F('FUNC-006', 'broken-rich-content', '2 Content', `${empty} empty <pre>/<code>`, c.url));
    const tables = c.main.match(/<table\b[\s\S]*?<\/table>/gi) || [];
    const broken = tables.filter(t => (t.match(/<tr\b/gi) || []).length === 0 || (t.match(/<t[dh]\b/gi) || []).length === 0).length;
    if (broken) out.push(F('FUNC-007', 'broken-rich-content', '2 Content', `${broken} broken <table>`, c.url));
    return out;
  } },

  // §10 — mixed content
  { id: 'mixed-content', section: '10 Technical', fn(c) {
    if (!c.isHtml || !/^https:/i.test(c.url)) return null;
    const hits = [...new Set((c.html.match(/(?:src|href)\s*=\s*["']http:\/\/[^"']+/gi) || []).map(s => s.replace(/^[^h]*/, '')))].filter(u => !/http:\/\/(?:www\.)?w3\.org|schema\.org|purl\.org/i.test(u));
    return hits.length ? withItems(F('SEC-009', 'mixed-content', '10 Technical', `${hits.length} insecure subresource ref(s): ${hits[0].slice(0, 80)}`, c.url, hits.length), hits.map(u => ({ id: u.slice(0, 100), section: sectionAt(c.html, c.html.indexOf(u)), value: 'http://' }))) : null;
  } },

  // §5/§10 — security headers
  { id: 'security-headers', section: '10 Technical', fn(c) {
    if (!c.isHtml) return null;
    const h = c.headers;
    const missing = [];
    if (!h['strict-transport-security']) missing.push('HSTS');
    if (!h['content-security-policy']) missing.push('CSP');
    if (!/nosniff/i.test(h['x-content-type-options'] || '')) missing.push('X-Content-Type-Options');
    if (!h['x-frame-options'] && !/frame-ancestors/i.test(h['content-security-policy'] || '')) missing.push('X-Frame-Options/frame-ancestors');
    if (!h['referrer-policy']) missing.push('Referrer-Policy');
    return missing.length >= 3 ? withItems(F('SEC-010', 'security-headers', '10 Technical', `absent: ${missing.join(', ')}`, c.url, missing.length), missing.map(m => ({ id: m, section: 'response headers', value: 'absent' }))) : null;
  } },

  // §6/§10 — compression
  { id: 'compression', section: '6 Performance', fn(c) {
    if (!c.isHtml) return null;
    return /(gzip|br|zstd|deflate)/i.test(c.headers['content-encoding'] || '') ? null
      : F('PERF-007', 'compression', '6 Performance', 'No gzip/br Content-Encoding on the HTML response.', c.url);
  } },

  // §9 — analytics / tracking presence. INVERTS by env.
  { id: 'analytics', section: '9 Analytics', fn(c, o) {
    if (!c.isHtml) return null;
    const b = c.html;
    const found = [];
    if (/gtag\(|googletagmanager\.com\/gtag|\bG-[A-Z0-9]{6,}\b/.test(b)) found.push('GA4');
    if (/googletagmanager\.com\/gtm|GTM-[A-Z0-9]{4,}/.test(b)) found.push('GTM');
    if (/connect\.facebook\.net|fbq\(/.test(b)) found.push('Meta Pixel');
    if (/snap\.licdn\.com|_linkedin_partner_id/.test(b)) found.push('LinkedIn');
    if (o.env === 'live') {
      return found.length ? null : F('SEO-025', 'analytics', '9 Analytics', 'Expected GA4/GTM/pixel after migration (SOP Phase 7 §25). Verify firing manually.', c.url);
    }
    return found.length ? F('SEO-026', 'analytics', '9 Analytics', `detected ${found.join(', ')}; confirm it does NOT fire into the production analytics property`, c.url) : null;
  } },

  // §12 — global components presence (heuristic)
  { id: 'global-components', section: '12 Global Components', fn(c) {
    if (!c.isHtml) return null;
    const missing = [];
    if (!/<header[\s>]|role\s*=\s*["']banner["']/i.test(c.html)) missing.push('header');
    if (!/<nav[\s>]|role\s*=\s*["']navigation["']/i.test(c.html)) missing.push('nav');
    if (!/<footer[\s>]|role\s*=\s*["']contentinfo["']/i.test(c.html)) missing.push('footer');
    return missing.length ? F('FUNC-005', 'global-components', '12 Global Components', `no ${missing.join('/')} landmark — confirm the global component renders`, c.url, missing.join(',')) : null;
  } },

  // §7 — html lang
  { id: 'html-lang', section: '7 Accessibility', fn(c) {
    if (!c.isHtml) return null;
    return /<html\b[^>]*\slang\s*=\s*["'][a-z]/i.test(c.html) ? null
      : F('A11Y-009', 'html-lang', '7 Accessibility', 'Hurts a11y + SEO.', c.url);
  } },

  // §6 — render-blocking resources in <head>
  { id: 'render-blocking', section: '6 Performance', fn(c) {
    if (!c.isHtml) return null;
    const css = (c.head.match(/<link\b[^>]*rel\s*=\s*["']stylesheet["'][^>]*>/gi) || []).filter(t => !/\smedia\s*=\s*["']print/i.test(t));
    const js = (c.head.match(/<script\b[^>]*\ssrc\s*=[^>]*>/gi) || []).filter(t => !/\b(async|defer)\b/i.test(t) && !/type\s*=\s*["']module["']/i.test(t));
    const n = css.length + js.length;
    if (n < 4) return null;
    const items = [
      ...css.map(t => ({ id: (attr(t, 'href') || 'stylesheet').split('/').pop().slice(0, 80), section: '<head> · blocking CSS', value: attr(t, 'href') || '' })),
      ...js.map(t => ({ id: (attr(t, 'src') || 'script').split('/').pop().slice(0, 80), section: '<head> · blocking JS', value: attr(t, 'src') || '' })),
    ];
    return withItems(F('PERF-005', 'render-blocking', '6 Performance', `${css.length} blocking CSS + ${js.length} blocking JS in <head> — defer/async or inline critical CSS to speed first paint`, c.url, n), items);
  } },

  // §8 — in-page anchor targets exist
  { id: 'anchor-target', section: '2 Links', fn(c) {
    if (!c.isHtml) return null;
    const esc2 = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const frags = [...new Set([...c.html.matchAll(/href\s*=\s*["']#([A-Za-z][\w:.-]*)["']/gi)].map(m => m[1]))];
    if (!frags.length) return null;
    const missing = frags.filter(id => !new RegExp('\\sid\\s*=\\s*["\']' + esc2(id) + '["\']', 'i').test(c.html) && !new RegExp('\\sname\\s*=\\s*["\']' + esc2(id) + '["\']', 'i').test(c.html));
    return missing.length ? withItems(F('LINK-005', 'anchor-target', '2 Links', `${missing.length} dead #fragment(s): ${missing.slice(0, 4).map(x => '#' + x).join(', ')}`, c.url, missing.length), missing.map(f => ({ id: 'href="#' + f + '"', section: sectionAt(c.html, (c.html.search(new RegExp('href\\s*=\\s*["\']#' + esc2(f))) || 0)), value: 'no matching id' }))) : null;
  } },

  // §6/§1 — mobile web-app metadata
  { id: 'mobile-web', section: '6 Performance', fn(c) {
    if (!c.isHtml) return null;
    const miss = [];
    if (!/<link\b[^>]*rel\s*=\s*["']manifest["']/i.test(c.head)) miss.push('web app manifest');
    if (!/<link\b[^>]*rel\s*=\s*["']apple-touch-icon["']/i.test(c.head)) miss.push('apple-touch-icon');
    if (!/<meta\b[^>]*name\s*=\s*["']theme-color["']/i.test(c.head)) miss.push('theme-color');
    return miss.length >= 2 ? F('SEO-027', 'mobile-web', '6 Performance', `absent: ${miss.join(', ')} — affects add-to-home-screen + mobile browser chrome`, c.url) : null;
  } },

  // §15 — privacy / terms / cookie signals
  { id: 'privacy-links', section: '8 SEO', fn(c) {
    if (!c.isHtml) return null;
    const foot = (c.html.match(/<footer[\s\S]*?<\/footer>/i) || [c.html])[0];
    const miss = [];
    if (!/privacy/i.test(foot)) miss.push('privacy policy link');
    if (!/terms|conditions/i.test(foot)) miss.push('terms link');
    const noCookie = !/cookie/i.test(c.html);
    return (miss.length || noCookie) ? F('SEO-028', 'privacy-links', '8 SEO', `${miss.join(', ') || 'footer links ok'}${noCookie ? ' · no cookie-consent mechanism detected' : ''}`, c.url) : null;
  } },
];

// ---------- site-level checks (run once for the origin) ----------
const SITE_CHECKS = [
  // §8/§10 — robots.txt
  { id: 'robots-txt', section: '8 SEO', async fn({ origin, env, http }) {
    const r = await http.getText(origin + '/robots.txt');
    if (!r.ok || r.status >= 400) return F('SEO-029', 'robots-txt', '8 SEO', `GET /robots.txt → ${r.status || r.error}`, origin + '/robots.txt');
    const hasSitemap = /^\s*sitemap:/im.test(r.body);
    const blanketDisallow = /^\s*disallow:\s*\/\s*$/im.test(r.body);
    if (env === 'live') {
      if (blanketDisallow) return F('SEO-020', 'robots-txt', '8 SEO', 'Disallow: / on production blocks all crawling — classic staging-config leak.', origin + '/robots.txt');
      if (!hasSitemap) return F('SEO-021', 'robots-txt', '8 SEO', 'Add a Sitemap: reference for crawlers.', origin + '/robots.txt');
    }
    return null;
  } },

  // §8 — sitemap presence
  { id: 'sitemap', section: '8 SEO', async fn({ origin, env, crawl }) {
    return crawl.hadSitemap ? null : F('SEO-022', 'sitemap', '8 SEO', `checked robots.txt + common paths on ${origin}; none resolved to page URLs`, origin);
  } },

  // §10 — 404 page configured
  { id: '404-config', section: '10 Technical', async fn({ origin, http }) {
    const probe = origin + '/__sgen_qa_nonexistent_' + '404probe';
    const r = await http.getText(probe);
    if (r.status === 200) return F('LINK-004', '404-config', '10 Technical', 'A non-existent path returns HTTP 200 instead of 404 — breaks crawl-error signals.', probe, r.status);
    return null;
  } },

  // §10 — HTTPS enforced
  { id: 'https-enforce', section: '10 Technical', async fn({ origin, host, http }) {
    if (!/^https:/i.test(origin)) return F('SEC-007', 'https-enforce', '10 Technical', `${origin} is served over http`, origin);
    const httpUrl = origin.replace(/^https:/i, 'http:');
    const r = await http.getText(httpUrl);
    if (r.status >= 200 && r.status < 300) return F('SEC-008', 'https-enforce', '10 Technical', `${httpUrl} answered ${r.status} instead of redirecting to https`, httpUrl, r.status);
    return null;
  } },
];

module.exports = { STATIC_CHECKS, SITE_CHECKS, buildCtx, F, STAGING_HOST_RE };
