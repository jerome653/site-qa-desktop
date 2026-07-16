'use strict';
// lib/report-contract.js — the SINGLE finding-level projection + serialization point (Stage 2).
// Every finding-level output (JSON, Markdown, Copy-MD, CI, future API) derives from here. Reporters
// consume the canonical Finding Contract; they do NOT reconstruct finding fields independently.
//
//   suites → projectFindings() → [contract findings] → { markdown, json, … }
//
// Scoring aggregates (quality/readiness/tally) stay suite-based — those are not per-finding. This module
// owns the per-finding canonical model and its serializations.

const { toContract } = require('../contract');
const { domProvider } = require('./evidence-providers');

// ---- CHANGE C: plain-language "what it means" sentence ------------------------------------------
// One deterministic, non-hyperbolic sentence that makes a finding self-explanatory to someone who
// does NOT know the app: what it impacts + how hard it is to fix. Derived ONLY from contract fields
// (title/suite/severity/impacts/fix) — no AI. Rules carry NO prose (`docs` is a URL path; there is no
// description/why field in the registry), so the sentence is SYNTHESIZED: a rule's explicit
// `impact:{seo,a11y,security,devEffort}` object drives the impact clause when present; rules without
// one fall back to the finding's suite + severity. Same template for every rule → consistent by
// construction. Used by BOTH the report card (as check._why) and the Copy-MD ticket.
const AXIS_PHRASE = { seo: 'search visibility', a11y: 'accessibility for assistive-tech users', security: 'site security' };
const SUITE_PHRASE = {
  functional: 'core page functionality', links: 'working links and navigation',
  forms: 'forms and submissions', responsive: 'the mobile / responsive layout',
  a11y: 'accessibility for assistive-tech users', seo: 'search-engine visibility',
  performance: 'page performance and load speed', security: 'site security',
  crossbrowser: 'cross-browser consistency', console: 'runtime stability (browser console)',
  'best-practices': 'code best-practice', visual: 'visual fidelity',
};
const RATING_WORD = { high: 'high', med: 'medium', medium: 'medium', low: 'low' };
const RATING_RANK = { high: 3, med: 2, medium: 2, low: 1 };
const SEV_TO_RATING = { critical: 'high', high: 'high', medium: 'medium', low: 'low' };

function joinList(arr) {
  if (arr.length <= 1) return arr.join('');
  if (arr.length === 2) return arr[0] + ' and ' + arr[1];
  return arr.slice(0, -1).join(', ') + ', and ' + arr[arr.length - 1];
}

function explainFinding(c) {
  if (!c) return '';
  const impacts = c.impacts || {};
  // 1) impact clause — prefer the rule's explicit non-null axes (worst rating first); else suite+severity.
  const axes = ['a11y', 'seo', 'security']
    .filter((k) => impacts[k])
    .map((k) => ({ phrase: AXIS_PHRASE[k], rating: impacts[k] }))
    .sort((x, y) => (RATING_RANK[y.rating] || 0) - (RATING_RANK[x.rating] || 0));
  let clause, worstRating;
  if (axes.length) {
    worstRating = axes[0].rating;
    clause = joinList(axes.map((a) => `${a.phrase} (${RATING_WORD[a.rating] || a.rating})`));
  } else {
    const phrase = SUITE_PHRASE[c.category] || 'the site';
    worstRating = SEV_TO_RATING[c.severity] || null;
    clause = worstRating ? `${phrase} (${RATING_WORD[worstRating]})` : phrase;
  }
  const verb = worstRating === 'high' ? 'Hurts' : 'Affects';
  // 2) fix clause — a real recommendation if the rule ever carries one; else effort + fixability.
  const rec = c.fix && c.fix.recommendation ? String(c.fix.recommendation).trim().replace(/\.+$/, '') : '';
  let fixClause;
  if (rec) {
    fixClause = 'fix: ' + rec.charAt(0).toLowerCase() + rec.slice(1);
  } else {
    const eff = impacts.devEffort;
    const fx = c.fix && c.fix.fixability;
    if (eff) {
      fixClause = `${RATING_WORD[eff] || eff} dev effort to fix`;
      if (fx === 'guided' || fx === 'automatic') fixClause += ` (${fx})`;
    } else if (fx === 'automatic') fixClause = 'can be fixed automatically';
    else if (fx === 'guided') fixClause = 'guided fix available';
    else if (fx === 'none') fixClause = 'not auto-fixable — manual change needed';
    else fixClause = 'requires a manual fix';
  }
  return `${verb} ${clause}; ${fixClause}.`;
}

// Single dev-ticket generator for ONE contract finding. Canonical Markdown — used by Copy-MD + MD export.
function contractToMarkdown(c, ctx = {}) {
  const L = [`## QA issue: ${c.metadata.name || c.ruleId || 'finding'}`];
  const bits = [];
  if (c.severity) bits.push(`severity ${c.severity}`);
  if (c.tier != null) bits.push(`launch-tier ${c.tier}`);
  if (c.ruleId) bits.push(`rule ${c.ruleId}`);
  bits.push(`certainty ${c.evidenceQuality}`);
  L.push(`- **Status:** ${bits.join(' · ')}`);
  const url = (c.locator && c.locator.url) || ctx.url || '';
  if (url) L.push(`- **Page:** ${url}`);
  if (c.section) L.push(`- **Section:** ${c.section}`);
  if (c.viewport) L.push(`- **Viewport:** ${c.viewport}`);
  if (c.locator) L.push(`- **Element:** \`${c.locator.target}\``);
  if (c.evidence.value) L.push(`- **Measured:** ${c.evidence.value}`);
  if (c.evidence.detail) L.push(`- **Details:** ${c.evidence.detail}`);
  const impacts = Object.entries(c.impacts || {}).filter(([, v]) => v).map(([k, v]) => `${k}:${v}`);
  if (impacts.length) L.push(`- **Impact:** ${impacts.join(' · ')}`);
  const why = explainFinding(c);
  if (why) L.push(`- **Impact / why:** ${why}`);
  if (c.fix && (c.fix.recommendation || c.fix.fixability)) {
    L.push(`- **Fix:** ${c.fix.recommendation || ''}${c.fix.fixability ? ` (${c.fix.fixability})` : ''}`.trim());
  }
  if (c.evidence.screenshot) L.push(`- **Evidence screenshot:** \`${c.evidence.screenshot}\``);
  if (c.locator && c.locator.copyAs) {
    const cp = c.locator.copyAs;
    if (cp.css) L.push(`- **Locate (CSS):** \`${cp.css}\``);
    if (cp.playwright) L.push(`- **Playwright:** \`${cp.playwright}\``);
  }
  // 2.5.11 — Developer details: surface exactly WHERE the flagged element is. Rendered ONLY for element
  // findings that carry a locator (dom-context or outerHTML). Page-level / static findings have no
  // locator → the whole block is skipped (clean degrade). Every field is guarded.
  if (c.locator && (c.locator.dom || c.locator.outerHTML)) {
    const dom = c.locator.dom || {};
    L.push('- **Developer details:**');
    if (dom.structuralCss) L.push(`  - **DOM path:** \`${dom.structuralCss}\``);
    const xp = (c.locator.copyAs && c.locator.copyAs.xpath) || dom.xpath;
    if (xp) L.push(`  - **XPath:** \`${xp}\``);
    if (Array.isArray(dom.classes) && dom.classes.length) L.push(`  - **Classes:** \`.${dom.classes.join('.')}\``);
    const attrs = (dom.attributes && typeof dom.attributes === 'object')
      ? Object.entries(dom.attributes).filter(([, v]) => v != null && v !== '') : [];
    if (attrs.length) L.push(`  - **Attributes:** ${attrs.map(([k, v]) => `${k}="${v}"`).join(' · ')}`);
    const bb = dom.boundingBox;
    if (bb && (bb.width != null || bb.height != null)) L.push(`  - **Element box:** ${bb.width}x${bb.height} at (${bb.x}, ${bb.y})`);
    if (Array.isArray(c.locator.strategies) && c.locator.strategies.length) {
      L.push(`  - **Selectors (by stability):** ${c.locator.strategies.map((s) => `${s.kind}:\`${s.value}\` (${s.stability})`).join(' · ')}`);
    }
    if (c.locator.outerHTML) L.push('', '```html', c.locator.outerHTML, '```');
  }
  L.push(`- **Fingerprint:** \`${c.fingerprint.slice(0, 16)}\``);
  L.push('', `_Source: SGEN Site QA · ${ctx.host || ''} · ${ctx.generated || ''}_`);
  return L.join('\n');
}

// Aggregate ticket for a whole check (rule) across its occurrences — for the check-level "Copy for dev".
function checkMarkdown(check, findings, ctx = {}) {
  const L = [`## QA issue: ${check.name || (findings[0] && findings[0].ruleId) || 'finding'}`];
  const f0 = findings[0];
  const meta = [];
  if (check.status) meta.push(check.status.toUpperCase());
  if (f0 && f0.severity) meta.push(`severity ${f0.severity}`);
  if (f0 && f0.ruleId) meta.push(`rule ${f0.ruleId}`);
  if (f0) meta.push(`certainty ${f0.evidenceQuality}`);
  L.push(`- **Status:** ${meta.join(' · ')}`);
  if (check.target) L.push(`- **Target:** ${check.target}`);
  if (check.detail) L.push(`- **Details:** ${check.detail}`);
  const rows = findings.slice(0, 30);
  if (rows.length) {
    // Viewport column only when at least one occurrence carries a viewport (responsive/contrast findings);
    // static findings (SEO/links/security) render the original 4-column table unchanged.
    const hasVp = rows.some(c => c.viewport);
    if (hasVp) {
      L.push('', '| Page | Where | Viewport | Measured | Evidence |', '|---|---|---|---|---|');
      rows.forEach(c => L.push(`| ${(c.locator && c.locator.url) || '—'} | ${c.locator ? '`' + c.locator.target + '`' : '—'} | ${c.viewport || '—'} | ${c.evidence.value || ''} | ${c.evidence.screenshot ? '`' + c.evidence.screenshot + '`' : '—'} |`));
    } else {
      L.push('', '| Page | Where | Measured | Evidence |', '|---|---|---|---|');
      rows.forEach(c => L.push(`| ${(c.locator && c.locator.url) || '—'} | ${c.locator ? '`' + c.locator.target + '`' : '—'} | ${c.evidence.value || ''} | ${c.evidence.screenshot ? '`' + c.evidence.screenshot + '`' : '—'} |`));
    }
    if (findings.length > 30) L.push('', `+${findings.length - 30} more in report.json`);
  }
  L.push('', `_Source: SGEN Site QA · ${ctx.host || ''} · ${ctx.generated || ''}_`);
  return L.join('\n');
}

// THE projection point. Walks the enriched suites, projects every occurrence (or the check itself if it
// enumerates none) into a contract finding, and annotates checks/items with precomputed contract-derived
// markdown so the HTML Copy-MD copies it verbatim (no client-side reconstruction). Returns the canonical
// findings array + timing metrics. Mutates checks additively (adds `_md`); never touches scoring fields.
function projectFindings(suites, ctx = {}) {
  const t0 = Date.now();
  const findings = [];
  for (const su of suites || []) {
    for (const check of su.checks || []) {
      if (check.status !== 'fail' && check.status !== 'warn') continue; // findings = actual problems
      const checkFindings = [];
      const items = check.items && check.items.length ? check.items : null;
      if (items) {
        for (const it of items) {
          // DOM provider: when the render pass gathered element facts, build the full stable locator
          // (ranked strategies + locatorId + bbox/text/outerHTML). Else fall back to the raw selector.
          const locator = it.descriptor ? domProvider.enrich(it.descriptor) : null;
          const c = toContract(check, {
            url: it.page, section: it.section, viewport: it.viewport, selector: it.id && it.id !== '(whole page)' ? it.id : null,
            value: it.value, screenshot: it.evidence || null, locator,
            observed: check.detail, observedAt: ctx.generated || null,
          });
          it._md = contractToMarkdown(c, ctx);
          c.markdown = it._md; // the finding carries its own dev ticket (lens views + API consume it)
          // 2.5.11 — compact dev-context for the report UI (element findings only; non-element items get
          // NO _dev). Also carries data-fp/data-sel/data-url hooks the 2.5.12 Inspect wiring will consume.
          if (c.locator && (c.locator.dom || c.locator.outerHTML)) {
            it._dev = {
              fp: c.fingerprint,
              sel: (c.locator && c.locator.target) || null,
              url: it.page || null,
              tag: (c.locator && c.locator.dom && c.locator.dom.tag) || null,
              domPath: (c.locator && c.locator.dom && c.locator.dom.structuralCss) || null,
              xpath: (c.locator && c.locator.copyAs && c.locator.copyAs.xpath) || (c.locator && c.locator.dom && c.locator.dom.xpath) || null,
              classes: (c.locator && c.locator.dom && c.locator.dom.classes) || [],
              attrs: (c.locator && c.locator.dom && c.locator.dom.attributes) || {},
              outerHTML: (c.locator && c.locator.outerHTML) || null,
              bbox: (c.locator && c.locator.dom && c.locator.dom.boundingBox) || null,
              strategies: (c.locator && c.locator.strategies) || [],
              // 2.5.12 — text snippet feeds the Inspect signature fallback (nearest text match) when
              // selector/xpath/structuralCss all miss on a re-rendered page. Additive; may be null.
              text: (c.locator && c.locator.text) || null,
            };
          }
          findings.push(c); checkFindings.push(c);
        }
      } else {
        const c = toContract(check, { url: check.target || null, observed: check.detail, observedAt: ctx.generated || null });
        c.markdown = contractToMarkdown(c, ctx);
        findings.push(c); checkFindings.push(c);
      }
      check._md = checkMarkdown(check, checkFindings, ctx);
      // CHANGE C: the plain-language sentence for the report card (muted sub-line under the title).
      // Rule-derived, so identical for every occurrence of a check — computed once from the first.
      if (checkFindings[0]) check._why = explainFinding(checkFindings[0]);
    }
  }
  const projectionMs = Date.now() - t0;
  return {
    findings,
    metrics: { contractVersion: (findings[0] && findings[0].contractVersion) || '1.0', count: findings.length, projectionMs },
  };
}

module.exports = { projectFindings, contractToMarkdown, checkMarkdown, explainFinding };
