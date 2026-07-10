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
  if (c.locator) L.push(`- **Where:** \`${c.locator.target}\``);
  if (c.evidence.value) L.push(`- **Measured:** ${c.evidence.value}`);
  if (c.evidence.detail) L.push(`- **Details:** ${c.evidence.detail}`);
  const impacts = Object.entries(c.impacts || {}).filter(([, v]) => v).map(([k, v]) => `${k}:${v}`);
  if (impacts.length) L.push(`- **Impact:** ${impacts.join(' · ')}`);
  if (c.fix && (c.fix.recommendation || c.fix.fixability)) {
    L.push(`- **Fix:** ${c.fix.recommendation || ''}${c.fix.fixability ? ` (${c.fix.fixability})` : ''}`.trim());
  }
  if (c.evidence.screenshot) L.push(`- **Evidence screenshot:** \`${c.evidence.screenshot}\``);
  if (c.locator && c.locator.copyAs) {
    const cp = c.locator.copyAs;
    if (cp.css) L.push(`- **Locate:** \`${cp.css}\``);
    if (cp.playwright) L.push(`- **Playwright:** \`${cp.playwright}\``);
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
    L.push('', '| Page | Where | Measured | Evidence |', '|---|---|---|---|');
    rows.forEach(c => L.push(`| ${(c.locator && c.locator.url) || '—'} | ${c.locator ? '`' + c.locator.target + '`' : '—'} | ${c.evidence.value || ''} | ${c.evidence.screenshot ? '`' + c.evidence.screenshot + '`' : '—'} |`));
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
            url: it.page, selector: it.id && it.id !== '(whole page)' ? it.id : null,
            value: it.value, screenshot: it.evidence || null, locator,
            observed: check.detail, observedAt: ctx.generated || null,
          });
          it._md = contractToMarkdown(c, ctx);
          c.markdown = it._md; // the finding carries its own dev ticket (lens views + API consume it)
          findings.push(c); checkFindings.push(c);
        }
      } else {
        const c = toContract(check, { url: check.target || null, observed: check.detail, observedAt: ctx.generated || null });
        c.markdown = contractToMarkdown(c, ctx);
        findings.push(c); checkFindings.push(c);
      }
      check._md = checkMarkdown(check, checkFindings, ctx);
    }
  }
  const projectionMs = Date.now() - t0;
  return {
    findings,
    metrics: { contractVersion: (findings[0] && findings[0].contractVersion) || '1.0', count: findings.length, projectionMs },
  };
}

module.exports = { projectFindings, contractToMarkdown, checkMarkdown };
