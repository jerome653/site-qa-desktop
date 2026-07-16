'use strict';
// checks.js — deterministic detector for COPY-001..004 (copy-review / Suite 13 "Copy Review"): flags
// copy for a HUMAN reviewer — literal assistant-boilerplate leaks, unresolved authoring placeholders,
// AI-tell cliche phrasing, and uniform paragraph rhythm. Pure function over a page context
// { url, html } (or { url, prose }). It reads only visible prose — script/style/pre/code/template are
// removed first (same convention as content-artifacts/checks.js), so a documented example inside
// <code> never false-positives. No AI, no network, no LLM call — same input -> same output, always.
//
// These are ADVISORY signals only. Nothing here — nor its caller, copy-review/index.js — ever claims a
// page IS AI-written; that is not deterministically knowable and a false "your copy is AI-generated" in
// front of a client is worse than missing one. Every emitted row is stamped status 'manual' by
// index.js regardless of what fires here. This file only detects; it does not judge.
//
// Patterns are plain-ASCII regex literals (no raw high/control bytes in source), deliberately
// CONSERVATIVE: COPY-001/002 are meant to be near-zero-FP, and COPY-003/004 are tuned so ordinary
// marketing copy does not trip them.

const { proseFromHtml } = require('../content-artifacts/checks');

// ---------------------------------------------------------------------------------------------------
// COPY-001 llm-boilerplate-leak — literal assistant text left in copy. HIGH CONFIDENCE, near-zero FP.
const LLM_BOILERPLATE = [
  /as an AI language model/gi,
  /I'm sorry,? but (I can'?t|as an AI)/gi,
  /as of my last (knowledge )?(update|training)/gi,
  /I cannot browse the internet/gi,
  /^(certainly|sure)[!,]\s+here('s| is)\b/gim,
  /here('s| is) (a|the) (rewritten|revised) version/gi,
];

// COPY-002 unresolved-authoring-placeholder — an unfilled slot the author never replaced.
// NOTE: lorem ipsum is already covered by FUNC-004 'placeholder-content' — deliberately NOT duplicated.
const AUTHORING_PLACEHOLDER = [
  /\[INSERT[^\]]{0,40}\]/gi,
  /\[YOUR [^\]]{0,40}\]/gi,
  /\[COMPANY[^\]]{0,30}\]/gi,
  /\[TODO[^\]]{0,30}\]/gi,
  /\bTK\b/g,
  /\bTODO:/g,
  /\bFIXME\b/g,
  /XXXX+/g,
];

// COPY-003 ai-tell-phrasing — cliches statistically common in LLM copy. INFORMATIONAL ONLY.
const AI_TELL_PHRASES = [
  /\bdelve into\b/gi,
  /in today's (fast-paced|digital) world/gi,
  /it'?s (important|worth) (to )?not(e|ing)/gi,
  /unlock the (power|potential)/gi,
  /elevate your\b/gi,
  /navigate the (complex|ever-)/gi,
  /a testament to\b/gi,
  /in the realm of\b/gi,
  /seamlessly integrat/gi,
  /robust (solution|framework)/gi,
];

const DETECTORS = [
  ...LLM_BOILERPLATE.map(re => ({ id: 'llm-boilerplate-leak', re })),
  ...AUTHORING_PLACEHOLDER.map(re => ({ id: 'unresolved-authoring-placeholder', re })),
  ...AI_TELL_PHRASES.map(re => ({ id: 'ai-tell-phrasing', re })),
];

// COPY-004 uniform-paragraph-rhythm — INFORMATIONAL. Only meaningful with enough text: >= 8 paragraphs
// AND >= 300 words. Flags when the coefficient of variation (stdev / mean) of paragraph word-counts is
// very low (< 0.18) — paragraphs read as machine-cadenced rather than naturally varied.
const MIN_PARAGRAPHS = 8;
const MIN_WORDS = 300;
const MAX_CV = 0.18;

// Rough word count over a plain string — good enough for density/CV, not linguistics.
function wordCount(str) {
  const m = String(str || '').match(/[A-Za-z0-9]+(?:['-][A-Za-z0-9]+)*/g);
  return m ? m.length : 0;
}

// Paragraph-preserving text extraction. proseFromHtml() (content-artifacts) deliberately collapses ALL
// whitespace to single spaces, which destroys paragraph boundaries — needed here for COPY-004's
// per-paragraph word counts. Strips the same non-prose elements as proseFromHtml, then converts
// block-level closers into paragraph breaks before stripping the remaining tags.
function paragraphsFromHtml(html) {
  const withBreaks = String(html || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<pre\b[\s\S]*?<\/pre>/gi, ' ')
    .replace(/<code\b[\s\S]*?<\/code>/gi, ' ')
    .replace(/<template\b[\s\S]*?<\/template>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n\n')
    .replace(/<\/(p|div|li|h[1-6]|blockquote|tr|section|article|td)\s*>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ');
  return withBreaks.split(/\n\s*\n+/).map(s => s.replace(/[ \t]+/g, ' ').trim()).filter(Boolean);
}

// Paragraphs for a page context: if the caller already supplied extracted prose (ctx.prose), respect
// any blank-line boundaries it contains; otherwise derive paragraphs from ctx.html.
function paragraphsOf(ctx) {
  if (ctx.prose != null) {
    return String(ctx.prose).split(/\n\s*\n+/).map(s => s.replace(/[ \t]+/g, ' ').trim()).filter(Boolean);
  }
  return paragraphsFromHtml(ctx.html);
}

function paragraphRhythm(ctx) {
  const counts = paragraphsOf(ctx).map(wordCount).filter(n => n > 0);
  const words = counts.reduce((a, n) => a + n, 0);
  if (counts.length < MIN_PARAGRAPHS || words < MIN_WORDS) return null;
  const mean = words / counts.length;
  if (mean <= 0) return null;
  const variance = counts.reduce((a, n) => a + (n - mean) * (n - mean), 0) / counts.length;
  const cv = Math.sqrt(variance) / mean;
  if (cv >= MAX_CV) return null;
  return { paragraphs: counts.length, words, mean, cv };
}

// Detect copy-review signals for one page. Returns items: { page, section, id, value }. Every id is
// one of: llm-boilerplate-leak | unresolved-authoring-placeholder | ai-tell-phrasing |
// uniform-paragraph-rhythm. Advisory only — see the header comment and index.js.
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
      const key = d.id + '|' + raw.toLowerCase();
      // COPY-003 (ai-tell-phrasing) must report a real occurrence COUNT + density, so every match
      // counts even when the same cliche repeats. COPY-001/002 dedupe identical repeats on the same
      // page (same convention as content-artifacts) since those are artifact FLAGS, not a frequency
      // signal.
      if (d.id !== 'ai-tell-phrasing' && seen.has(key)) { if (d.re.lastIndex === at) d.re.lastIndex++; continue; }
      seen.add(key);
      const snippet = prose.slice(Math.max(0, at - 24), at + raw.length + 24).trim();
      items.push({ page: ctx.url || '', section: 'content', id: d.id, value: snippet.slice(0, 100) });
      if (d.re.lastIndex === at) d.re.lastIndex++; // guard against zero-width loops
    }
  }
  const rhythm = paragraphRhythm(ctx);
  if (rhythm) {
    items.push({
      page: ctx.url || '',
      section: 'content',
      id: 'uniform-paragraph-rhythm',
      value: `${rhythm.paragraphs} paragraphs, ${rhythm.words} words, mean ${rhythm.mean.toFixed(1)} words/paragraph, CV ${rhythm.cv.toFixed(3)} (threshold < ${MAX_CV})`,
    });
  }
  items.sort((a, b) => (a.id + a.value).localeCompare(b.id + b.value));
  return items;
}

module.exports = {
  detect, wordCount, paragraphsOf, DETECTORS,
  MIN_PARAGRAPHS, MIN_WORDS, MAX_CV,
};
