'use strict';
// lib/checks-interaction.js — static, deterministic Interaction Integrity checks (Batch 1, all Verified).
// Parses the raw HTML for interactive elements and flags controls a user cannot actually use. No render
// needed — every signal is directly observable in the markup. Each finding carries a descriptor so the
// DOM provider builds a real locator (id/class/attr strategies) even in static mode.
//
//   LINK-006 dead link href=""      LINK-008 javascript:void(0)/javascript:      DOM-010 button submits nothing
//   LINK-007 href="#"               LINK-009 <a> with no href                    DOM-011 empty onclick=""
//   DOM-012 nested interactive controls                                         DOM-013 disabled shown active

const { isDeadTarget } = require('./uri-validate');
const REG = require('../rules/registry');

const CAP = 25; // max interaction findings per page (noise guard)

function attrs(tagText) {
  const a = {};
  for (const m of tagText.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
    a[m[1].toLowerCase()] = m[3] !== undefined ? m[3] : (m[4] !== undefined ? m[4] : m[5]);
  }
  // boolean attrs (disabled, hidden) with no value
  for (const m of tagText.matchAll(/(?:^|\s)(disabled|hidden)(?=\s|$|\/)/gi)) a[m[1].toLowerCase()] = a[m[1].toLowerCase()] || '';
  return a;
}
function descriptorOf(tag, at, url) {
  return {
    tag, id: at.id || null,
    classes: at.class ? String(at.class).trim().split(/\s+/).filter(Boolean) : [],
    attributes: Object.fromEntries(Object.entries(at).filter(([k]) => ['id', 'class', 'style'].indexOf(k) < 0).map(([k, v]) => [k, String(v).slice(0, 120)])),
    text: '', url,
  };
}
function selOf(tag, at) {
  if (at.id) return `${tag}#${at.id}`;
  if (at.class) return `${tag}.${String(at.class).trim().split(/\s+/)[0]}`;
  if (at.href) return `${tag}[href="${String(at.href).slice(0, 40)}"]`;
  return tag;
}

// One finding record (shape the audit's itemsOf/projection understand): carries items[] with descriptor.
function mk(ruleId, check, section, detail, url, value, tag, at) {
  const sel = selOf(tag, at);
  const rule = REG.getById(ruleId);
  return { ruleId, check, section, severity: rule ? rule.severity : null, title: rule ? rule.title : ruleId, detail: detail || '', location: url, value: value == null ? '' : String(value),
    items: [{ page: url, section, id: sel, value: value == null ? '' : String(value), descriptor: descriptorOf(tag, at, url) }] };
}

// Parse interactive elements with a stack (reliable nesting + form membership; regex-per-tag for attrs).
function interactionCheck(ctx) {
  const html = ctx.html || '';
  if (!ctx.isHtml || !html) return [];
  const out = [];
  const push = (f) => { if (out.length < CAP) out.push(f); };
  const iStack = []; // open interactive elements (a/button)
  let formDepth = 0;
  const TAG = /<(\/?)(a|button|form)\b([^>]*?)(\/?)>/gi;
  let m;
  while ((m = TAG.exec(html))) {
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    const body = m[3] || '';
    const selfClose = m[4] === '/';
    if (tag === 'form') { if (closing) formDepth = Math.max(0, formDepth - 1); else if (!selfClose) formDepth++; continue; }
    if (closing) { for (let i = iStack.length - 1; i >= 0; i--) { if (iStack[i] === tag) { iStack.splice(i, 1); break; } } continue; }
    const at = attrs(body);

    // DOM-012 nested interactive controls (an interactive element opened inside another)
    if (iStack.length) push(mk('DOM-012', 'interactive-nesting', '7 Accessibility', `<${tag}> nested inside <${iStack[iStack.length - 1]}> — nested interactive controls are not usable/accessible`, ctx.url, `${iStack[iStack.length - 1]}>${tag}`, tag, at));

    if (tag === 'a') {
      if (!('href' in at)) push(mk('LINK-009', 'interactive-link', '2 Links', 'anchor has no href — not a working link', ctx.url, 'no href', tag, at));
      else {
        const href = String(at.href);
        if (href.trim() === '') push(mk('LINK-006', 'interactive-link', '2 Links', 'empty href="" — link goes nowhere', ctx.url, 'href=""', tag, at));
        else if (href.trim() === '#') push(mk('LINK-007', 'interactive-link', '2 Links', 'href="#" — link goes nowhere', ctx.url, 'href="#"', tag, at));
        else if (/^javascript:\s*(void\s*\(\s*0\s*\)|;?)\s*$/i.test(href.trim())) push(mk('LINK-008', 'interactive-link', '2 Links', 'javascript: no-op href — dead link', ctx.url, href.slice(0, 40), tag, at));
      }
    }
    if (tag === 'button') {
      const type = (at.type || '').toLowerCase();
      if (type === 'submit' && formDepth === 0) push(mk('DOM-010', 'interactive-control', '10 Technical', 'type="submit" button is not inside a <form> — it submits nothing', ctx.url, 'submit-no-form', tag, at));
    }
    // DOM-011 empty onclick (any element handled here for a/button)
    if ('onclick' in at && String(at.onclick).trim() === '') push(mk('DOM-011', 'interactive-control', '10 Technical', 'empty onclick="" — control does nothing on click', ctx.url, 'onclick=""', tag, at));
    // DOM-013 disabled but presented as active (has a click handler or href while disabled/aria-disabled)
    const disabled = ('disabled' in at) || String(at['aria-disabled'] || '').toLowerCase() === 'true';
    if (disabled && (('onclick' in at && String(at.onclick).trim() !== '') || (tag === 'a' && at.href && !isDeadTarget(at.href)))) {
      push(mk('DOM-013', 'interactive-nesting', '7 Accessibility', 'element is disabled/aria-disabled yet still wired to act — presented as active but unusable', ctx.url, 'disabled+active', tag, at));
    }

    if (!selfClose) iStack.push(tag);
  }
  return out;
}

module.exports = { interactionCheck };
