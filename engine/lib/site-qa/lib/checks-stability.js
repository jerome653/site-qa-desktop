'use strict';
// lib/checks-stability.js — Stability Batch 4 (V2). Per-page, static, deterministic. Duplicate IDs +
// form-field semantics + mailto/tel validity are Verified; DOM size is Derived. Broken-markup +
// broken-fonts are DEFERRED (need render/network; fragile statically) — tracked in the roadmap.
const REG = require('../rules/registry');
const { validateUri } = require('./uri-validate');

const DOM_BUDGET = 1500; // element count over which the DOM is "excessive" (Google Lighthouse uses ~1400)

function F(ruleId, check, section, detail, url, value, items) {
  const r = REG.getById(ruleId);
  return { ruleId, check, section, severity: r ? r.severity : null, title: r ? r.title : ruleId,
    detail: detail || '', location: url, value: value == null ? '' : String(value), items: items || undefined };
}

function stabilityPageChecks(ctx) {
  const out = [];
  if (!ctx.isHtml || !ctx.html) return out;
  const html = ctx.html;

  // DOM-003 duplicate ids
  const idCounts = {};
  for (const m of html.matchAll(/\bid\s*=\s*("([^"]+)"|'([^']+)')/gi)) {
    const id = (m[2] || m[3] || '').trim(); if (!id) continue;
    idCounts[id] = (idCounts[id] || 0) + 1;
  }
  const dups = Object.entries(idCounts).filter(([, n]) => n > 1);
  if (dups.length) out.push(F('DOM-003', 'stb-dup-id', '4 Structure', `${dups.length} id(s) used more than once — breaks label/for, anchors, and scripts`, ctx.url, dups.length,
    dups.slice(0, 25).map(([id, n]) => ({ id: `#${id}`, section: 'duplicate id', value: `×${n}`, descriptor: { tag: '*', id, classes: [], attributes: {}, url: ctx.url } }))));

  // DOM-004 excessive DOM size (Derived) — count element open tags
  const els = (html.match(/<[a-zA-Z][^>]*>/g) || []).length;
  if (els > DOM_BUDGET) out.push(F('DOM-004', 'stb-dom', '6 Performance', `~${els} elements (> ${DOM_BUDGET}) — large DOM slows rendering + interaction`, ctx.url, els));

  // FORM-002 field semantics — email/tel/url inputs with the wrong type; password without autocomplete
  const inputs = [...html.matchAll(/<input\b[^>]*>/gi)].map(m => m[0]);
  const semProblems = [];
  for (const inp of inputs) {
    const type = (inp.match(/type\s*=\s*["']([^"']+)["']/i) || [, ''])[1].toLowerCase();
    const name = (inp.match(/(?:name|id|autocomplete)\s*=\s*["']([^"']+)["']/i) || [, ''])[1].toLowerCase();
    if (/e-?mail/.test(name) && type !== 'email') semProblems.push({ id: 'input[email]', section: 'field semantics', value: `type="${type || 'text'}" should be email` });
    else if (/(^|_|-)(tel|phone)/.test(name) && type !== 'tel') semProblems.push({ id: 'input[tel]', section: 'field semantics', value: `type="${type || 'text'}" should be tel` });
    else if (/url|website/.test(name) && type !== 'url') semProblems.push({ id: 'input[url]', section: 'field semantics', value: `type="${type || 'text'}" should be url` });
    if (type === 'password' && !/autocomplete\s*=/i.test(inp)) semProblems.push({ id: 'input[password]', section: 'field semantics', value: 'missing autocomplete (current-/new-password)' });
  }
  if (semProblems.length) out.push(F('FORM-002', 'stb-form', '3 Forms', `${semProblems.length} field(s) with the wrong input type or missing autocomplete`, ctx.url, semProblems.length, semProblems.slice(0, 25)));

  // LINK-010 malformed mailto:/tel:
  const bad = [];
  for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*["'](mailto:|tel:)([^"']*)["']/gi)) {
    const uri = m[1] + m[2];
    const r = validateUri(uri);
    if (!r.valid) bad.push({ id: uri.slice(0, 60), section: 'link', value: r.reason });
  }
  if (bad.length) out.push(F('LINK-010', 'stb-uri', '2 Links', `${bad.length} malformed mailto:/tel: link(s)`, ctx.url, bad.length, bad.slice(0, 25)));

  return out;
}

module.exports = { stabilityPageChecks };
