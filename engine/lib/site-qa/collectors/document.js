'use strict';
// collectors/document.js — THE DOCUMENT COLLECTOR (ADR-0006, governed by ADR-0004).
//
// The second inhabitant of the Collector layer, after ADR-0005's Network Ledger. Same law: it sits
// ABOVE the determinism boundary (ADR-0004 §D3), it acquires, and it does nothing else. No rule, no
// finding, no severity, no threshold, no score, no formatting — and, stated because ADR-0006's brief
// is explicit about it: NO CLASSIFICATION. It does not decide what is render-blocking, what is a
// tracker, what is duplicated or what is unused. It records what the document contains, in the order
// the document contains it. Every judgement belongs to a provider, a rule or a view.
//
// WHAT THIS REPLACES. `checks-static.js`'s render-blocking check (PERF-005) has parsed `<head>` for
// stylesheets and scripts on every page of every scan, extracted their href/src, counted them — and
// then discarded every one of them unless the count happened to reach 4:
//     const css = (c.head.match(/<link\b[^>]*rel\s*=\s*["']stylesheet["'][^>]*>/gi) || [])…
//     const js  = (c.head.match(/<script\b[^>]*\ssrc\s*=[^>]*>/gi) || [])…
//     if (n < 4) return null;                       // ← everything parsed above is thrown away
// The head/footer code inventory, technology detection, duplicate-tag detection and execution-order
// analysis are all blocked on data this engine already parses, once per page, on every scan. Like
// ADR-0005 this is a RETENTION change, not a new measurement.
//
// ── `raw` IS LOAD-BEARING, NOT A CONVENIENCE ─────────────────────────────────────────────────────
// Every asset record keeps the exact opening-tag text it was cut from. That is what lets PERF-005 be
// refactored onto this collector with ZERO risk of moving a finding: the check keeps its own original
// regexes and applies them to the same strings it used to match itself, so its result is identical BY
// CONSTRUCTION rather than by a re-implementation that has to be trusted. Those regexes carry real
// quirks — `\ssrc\s*=` demands whitespace before `src`, and `\b(async|defer)\b` matches ANYWHERE in
// the tag including inside a filename — and a "correct" attribute parser would silently not reproduce
// them. Keeping `raw` means the quirks travel with the data instead of being lost in a rewrite.

const { COLLECTION_SCHEMA_VERSION } = require('../version');

// headSlice — THE SINGLE DEFINITION, moved here from checks-static.js and imported back by it.
// The `html.slice(0, 8000)` fallback is not a rounding of "the head is probably up here": it is the
// literal behaviour every existing head-based check has always had on a document with no <head></head>
// pair, so it is preserved exactly. Changing it would move findings in checks that have nothing to do
// with this ADR.
function headSlice(html) { const m = String(html || '').match(/<head[\s\S]*?<\/head>/i); return m ? m[0] : String(html || '').slice(0, 8000); }

// The tags a document-asset inventory is about: resource references and head-level declarations.
// Deliberately NOT "every element" — this is an asset inventory, not a DOM dump.
const TAGS = ['script', 'link', 'style', 'meta', 'base', 'img', 'iframe', 'source', 'video', 'audio', 'track', 'object', 'embed'];
const TAG_RE = new RegExp('<(' + TAGS.join('|') + ')\\b[^>]*>', 'gi');

// Attribute reader. Same shape as checks-static's `attr()` (leading \s, quoted value) so an attribute
// this collector reports is the same string that file would have read.
function attrOf(tag, name) {
  const m = String(tag).match(new RegExp('\\s' + name + '\\s*=\\s*["\']([^"\']*)["\']', 'i'));
  return m ? m[1] : null;
}
// Valueless (boolean) attributes: `async`, `defer`, `nomodule` are present-or-absent, and may also be
// written `async=""`. Presence IS observable, so `false` here is a measurement, not a guess — unlike
// ADR-0005's protocol/fromCache, which are null because they cannot be seen at all.
function boolAttr(tag, name) {
  return new RegExp('\\s' + name + '(\\s|=|>|/)', 'i').test(String(tag));
}
// Full attribute map, in source order. Valueless attributes map to `true`.
function attrsOf(tag) {
  const inner = String(tag).replace(/^<[a-z0-9-]+/i, '').replace(/\/?>$/, '');
  const out = {};
  const re = /([a-zA-Z_:@][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m;
  while ((m = re.exec(inner))) {
    const k = m[1].toLowerCase();
    if (k in out) continue;                       // first wins, mirroring HTML parsing
    const v = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : true;
    out[k] = v;
  }
  return out;
}

// collectDocumentAssets(html, opts) — pure over the document text. `now` is injectable for the same
// reason as ADR-0005: the collector is the layer allowed to read a clock, and injecting it keeps the
// layer testable without anything below the boundary becoming impure.
//
// ORDER IS THE PRODUCT. Assets come back in exact document order and are never sorted, grouped or
// classified. `index` is document-wide; `sectionIndex` is within head or body. Both are recorded
// because the questions this inventory exists to answer ("what runs before what", "what is in the
// head") are order questions, and an inventory that reorders its own contents cannot answer them.
function collectDocumentAssets(html, { documentUrl = null, source = 'static', now = () => new Date().toISOString() } = {}) {
  const doc = String(html == null ? '' : html);
  const capturedAt = now();

  // Head bounds, derived from the SAME slice every existing head check uses. An asset counts as head
  // only when its whole opening tag lies inside the region — which is what matching against the head
  // SUBSTRING does, and therefore what PERF-005 has always done.
  const headText = headSlice(doc);
  const headStart = headText ? doc.indexOf(headText) : -1;
  const headEnd = headStart >= 0 ? headStart + headText.length : -1;

  const assets = [];
  const perSection = { head: 0, body: 0 };
  const inlineOrdinal = new Map();               // `${section}|${tag}` -> running count of inline ones
  TAG_RE.lastIndex = 0;
  let m;
  while ((m = TAG_RE.exec(doc))) {
    const raw = m[0];
    const offset = m.index;
    const tag = m[1].toLowerCase();
    const section = (headStart >= 0 && offset >= headStart && offset + raw.length <= headEnd) ? 'head' : 'body';

    const href = attrOf(raw, 'href');
    const src = attrOf(raw, 'src');
    const rel = attrOf(raw, 'rel');
    const external = !!(href || src);
    const inline = !external;
    const inlineKey = `${section}|${tag}`;
    let inlineIndex = null;
    if (inline) { inlineIndex = inlineOrdinal.get(inlineKey) || 0; inlineOrdinal.set(inlineKey, inlineIndex + 1); }

    const type = attrOf(raw, 'type');
    assets.push({
      index: assets.length,
      sectionIndex: perSection[section]++,
      section,                                    // 'head' | 'body' — never inferred, always positional
      tag,
      offset,
      raw,                                        // load-bearing — see the header
      inline,
      external,
      href, src,
      rel,
      // Tokenised, not classified: `rel="preload dns-prefetch"` becomes ['preload','dns-prefetch'].
      // Splitting a space-separated attribute is acquisition. Deciding what a preload MEANS is not,
      // and does not happen here.
      relTokens: rel ? rel.trim().split(/\s+/).filter(Boolean).map(s => s.toLowerCase()) : null,
      type,
      media: attrOf(raw, 'media'),
      integrity: attrOf(raw, 'integrity'),
      crossorigin: attrOf(raw, 'crossorigin'),
      // Boolean attributes: presence is observable, so false is measured, not assumed.
      async: boolAttr(raw, 'async'),
      defer: boolAttr(raw, 'defer'),
      nomodule: boolAttr(raw, 'nomodule'),
      module: !!(type && type.toLowerCase() === 'module'),
      inlineIndex,
      attrs: attrsOf(raw),
    });
  }

  return {
    documentUrl: documentUrl || null,
    source,                                       // 'static' (raw HTML) | 'rendered' (post-JS DOM)
    capturedAt,
    assets,
    counts: { total: assets.length, head: perSection.head, body: perSection.body },
  };
}

module.exports = {
  collectDocumentAssets, headSlice,
  attrOf, boolAttr, attrsOf,
  TAGS, COLLECTION_SCHEMA_VERSION,
};
