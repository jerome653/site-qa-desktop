'use strict';
// duplicates.js — near-duplicate BODY COPY across pages. The product's first body-level duplicate
// detection: SEO-009/010 compare <title> and <meta description> only, so two pages with word-for-word
// identical text passed clean.
//
// Deterministic, offline, no dependencies: word shingles + Jaccard similarity. No AI, no network, no
// third-party service — same constraints as every other detector in this engine.
//
// TWO DELIBERATE LIMITS, both there to keep the signal readable:
//   · MIN_DUP_WORDS — pages below the floor are not compared at all. A "Contact us." stub trivially
//     matches every other stub, and a report where every thin page pairs with every other thin page
//     buries the one real case.
//   · Each PAIR is reported once. a~b and b~a are the same finding; reporting both doubles the count
//     and makes a site look twice as duplicated as it is.

const MIN_DUP_WORDS = 40;     // below this a page is a stub, not content worth comparing
const DUP_THRESHOLD = 0.80;   // Jaccard over 5-word shingles; identical copy scores 1.0
const SHINGLE = 5;

// Normalise hard: duplicate copy that differs only in casing, punctuation or whitespace is still
// duplicate copy, and the operator does not care which.
function normalise(text) {
  return String(text == null ? '' : text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function shingles(text, n = SHINGLE) {
  const words = normalise(text).split(' ').filter(Boolean);
  if (words.length < n) return { set: new Set(), words: words.length };
  const set = new Set();
  for (let i = 0; i + n <= words.length; i++) set.add(words.slice(i, i + n).join(' '));
  return { set, words: words.length };
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const s of small) if (large.has(s)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

// duplicatePairs([{ url, prose }]) -> [{ a, b, similarity }] sorted most-similar first.
// Pages under the word floor are excluded, and each pair appears once.
function duplicatePairs(pages, { threshold = DUP_THRESHOLD, minWords = MIN_DUP_WORDS } = {}) {
  const usable = [];
  for (const p of (Array.isArray(pages) ? pages : [])) {
    if (!p) continue;
    const s = shingles(p.prose);
    if (s.words >= minWords && s.set.size) usable.push({ url: p.url || '', ...s });
  }
  const out = [];
  for (let i = 0; i < usable.length; i++) {
    for (let j = i + 1; j < usable.length; j++) {   // j > i => each pair exactly once
      const sim = jaccard(usable[i].set, usable[j].set);
      if (sim >= threshold) out.push({ a: usable[i].url, b: usable[j].url, similarity: sim });
    }
  }
  out.sort((x, y) => (y.similarity - x.similarity) || (x.a + x.b).localeCompare(y.a + y.b));
  return out;
}

module.exports = { duplicatePairs, shingles, jaccard, normalise, MIN_DUP_WORDS, DUP_THRESHOLD };
