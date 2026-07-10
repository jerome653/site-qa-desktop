'use strict';
// checks.js — deterministic Best-Practices detectors (Suite 11). Pure functions over a page context
// { url, html }, mirroring how checks-static.js works (string/regex over collected HTML — no live
// browser needed). Each detector emits registry-native findings by ruleId; no title matching, no AI.
// This suite is ADVISORY (registry weight 0): it produces its own sub-score and NEVER affects the
// SGEN Quality Score.
const REG = require('../rules/registry');

const GENERIC_LINK_TEXT = new Set(['click here', 'read more', 'here', 'more', 'learn more', 'link', 'this', 'read', 'go', 'click']);
const DEPRECATED_TAGS = ['center', 'font', 'marquee', 'blink', 'big', 'tt', 'strike'];

function firstDoctype(html) {
  const head = String(html || '').replace(/^﻿/, '').trimStart();
  const m = head.match(/^<!doctype[^>]*>/i);
  return m ? m[0] : null;
}

// Each detector: (ctx) -> [{ page, section, id, value }]
const DETECTORS = {
  'BP-001': ctx => firstDoctype(ctx.html) ? [] : [{ page: ctx.url, section: 'document', id: 'doctype', value: 'missing' }],
  'BP-008': ctx => {
    const dt = firstDoctype(ctx.html);
    if (!dt) return []; // BP-001 owns "missing"; this rule is only for a PRESENT but legacy doctype
    return /^<!doctype\s+html\s*>$/i.test(dt) ? [] : [{ page: ctx.url, section: 'document', id: 'doctype', value: dt.slice(0, 80) }];
  },
  'BP-002': ctx => {
    const html = String(ctx.html || '');
    const has = /<meta\s+charset=/i.test(html) || /<meta[^>]+http-equiv=["']?content-type["'][^>]*charset=/i.test(html);
    return has ? [] : [{ page: ctx.url, section: 'head', id: 'charset', value: 'missing' }];
  },
  'BP-003': ctx => {
    const html = String(ctx.html || '');
    const items = [];
    for (const t of DEPRECATED_TAGS) if (new RegExp(`<${t}[\\s>/]`, 'i').test(html)) items.push({ page: ctx.url, section: 'body', id: t, value: '<' + t + '>' });
    return items;
  },
  'BP-004': ctx => {
    const items = [];
    for (const tag of String(ctx.html || '').match(/<a\b[^>]*>/gi) || []) {
      if (!/target\s*=\s*["']?_blank/i.test(tag)) continue;
      const rel = (tag.match(/rel\s*=\s*["']([^"']*)["']/i) || [])[1] || '';
      if (!/noopener|noreferrer/i.test(rel)) items.push({ page: ctx.url, section: 'body', id: 'anchor', value: tag.slice(0, 100) });
    }
    return items;
  },
  'BP-005': ctx => {
    const items = [];
    for (const m of String(ctx.html || '').matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)) {
      const text = m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
      if (text && GENERIC_LINK_TEXT.has(text)) items.push({ page: ctx.url, section: 'body', id: 'link-text', value: text });
    }
    return items;
  },
  'BP-006': ctx => {
    const m = String(ctx.html || '').match(/<meta\s+name=["']generator["'][^>]*content=["']([^"']*)["']/i);
    return m ? [{ page: ctx.url, section: 'head', id: 'generator', value: m[1] }] : [];
  },
  'BP-007': ctx => {
    const found = new Set();
    for (const m of String(ctx.html || '').matchAll(/\son([a-z]+)\s*=\s*["']/gi)) found.add('on' + m[1].toLowerCase());
    return [...found].sort().map(h => ({ page: ctx.url, section: 'body', id: h, value: h }));
  },
};

module.exports = { DETECTORS, firstDoctype, GENERIC_LINK_TEXT, DEPRECATED_TAGS };
