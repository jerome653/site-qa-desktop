'use strict';
// checks.js — deterministic detector for FUNC-008 (content-artifacts): loose/broken symbols,
// unresolved template tokens, and mojibake in VISIBLE copy. Pure function over a page context
// { url, html } (or { url, prose }). It reads only visible prose — script/style/pre/code/template are
// removed first, so a documented `{{ handlebars }}` example inside <code> never false-positives. No AI.
//
// Patterns are built with RegExp() from ASCII \u strings (no raw high/control bytes in source) and are
// deliberately CONSERVATIVE: they must not fire on legitimate accented text or normal punctuation.

function proseFromHtml(html) {
  return String(html || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<pre\b[\s\S]*?<\/pre>/gi, ' ')
    .replace(/<code\b[\s\S]*?<\/code>/gi, ' ')
    .replace(/<template\b[\s\S]*?<\/template>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

const DETECTORS = [
  // {{token}} / {% liquid %} / ${templateLiteral} left unrendered in visible copy
  { id: 'unresolved-token', label: 'unresolved template token',
    re: new RegExp('\\{\\{\\s*[^{}]{1,60}?\\s*\\}\\}|\\{%\\s*[^%]{1,60}?%\\}|\\$\\{\\s*[^{}]{1,60}?\\}', 'g') },
  // U+FFFD replacement character
  { id: 'replacement-char', label: 'replacement character', re: new RegExp('\\uFFFD', 'g') },
  // UTF-8-decoded-as-Latin-1/CP1252 mojibake:
  //   C3 + [80-BF]  -> accented letter (e-acute etc.)
  //   C2 + [A0-BF]  -> nbsp / copyright / degree
  //   E2 + (20AC|0080) -> smart quotes / dashes
  { id: 'mojibake', label: 'mojibake (encoding artifact)',
    re: new RegExp('\\u00c3[\\u0080-\\u00bf]|\\u00c2[\\u00a0-\\u00bf]|\\u00e2(?:\\u20ac|\\u0080)', 'g') },
  // an entity escaped twice (&amp;amp; renders the literal "&amp;")
  { id: 'double-escaped-entity', label: 'double-escaped HTML entity',
    re: new RegExp('&amp;(?:amp|lt|gt|quot|nbsp|#\\d{1,6}|[a-z]{2,8});', 'gi') },
  // stray C0 control characters (tab \\u0009, LF \\u000a, CR \\u000d excluded)
  { id: 'stray-control-char', label: 'stray control character',
    re: new RegExp('[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f]', 'g') },
];

// Detect artifacts for one page. Returns items: { page, section, id, value }.
function detect(ctx) {
  const prose = ctx.prose != null ? String(ctx.prose) : proseFromHtml(ctx.html);
  const items = [];
  const seen = new Set();
  for (const d of DETECTORS) {
    d.re.lastIndex = 0;
    let m, n = 0;
    while ((m = d.re.exec(prose)) && n < 20) {
      n++;
      const raw = m[0];
      const at = m.index;
      const snippet = prose.slice(Math.max(0, at - 18), at + raw.length + 18).trim();
      if (seen.has(d.id + '|' + raw)) continue; // de-dupe identical artifact on the same page
      seen.add(d.id + '|' + raw);
      items.push({ page: ctx.url || '', section: 'content', id: d.id,
        value: (d.id === 'unresolved-token' ? raw : snippet).slice(0, 80) });
    }
  }
  items.sort((a, b) => (a.id + a.value).localeCompare(b.id + b.value));
  return items;
}

module.exports = { detect, proseFromHtml, DETECTORS };
