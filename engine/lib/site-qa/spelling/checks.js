'use strict';
// checks.js — deterministic common-misspelling + doubled-word detector for FUNC-009. Pure function
// over a page context { url, html } (or { url, prose }). Reads only visible prose (reuses the
// content-artifacts prose extractor, so code/script/style are excluded). Zero false positives: it
// only flags words present in the curated misspelling map, plus obvious duplicated function words.
const { proseFromHtml } = require('../content-artifacts/checks');
const { MISSPELLINGS, DOUBLE_WORDS } = require('./data');

const DOUBLE_RE = new RegExp('\\b(' + DOUBLE_WORDS.join('|') + ')\\s+\\1\\b', 'gi');

function detect(ctx) {
  const prose = ctx.prose != null ? String(ctx.prose) : proseFromHtml(ctx.html);
  const items = [];
  const seen = new Set();

  // words: sequences of letters (apostrophes kept inside, then trimmed)
  const words = prose.toLowerCase().match(/[a-z][a-z']*[a-z]|[a-z]/g) || [];
  for (const w of words) {
    const key = w.replace(/^'+|'+$/g, '');
    const correct = MISSPELLINGS[key];
    if (correct && !seen.has('m|' + key)) {
      seen.add('m|' + key);
      items.push({ page: ctx.url || '', section: 'content', id: 'misspelling', value: `"${key}" → "${correct}"` });
    }
  }
  // doubled function words
  DOUBLE_RE.lastIndex = 0;
  let m;
  while ((m = DOUBLE_RE.exec(prose))) {
    const phrase = m[0].replace(/\s+/g, ' ').toLowerCase();
    if (seen.has('d|' + phrase)) continue;
    seen.add('d|' + phrase);
    items.push({ page: ctx.url || '', section: 'content', id: 'doubled-word', value: `repeated "${phrase}"` });
  }

  items.sort((a, b) => (a.id + a.value).localeCompare(b.id + b.value));
  return items;
}

module.exports = { detect, MISSPELLINGS };
