'use strict';
// indexability/discovery.js — the machine-readable surface a site publishes about itself.
//
// THE QUESTION. Classic SEO asks "can Googlebot crawl and index this page". That is necessary and no
// longer sufficient: the same content is now consumed by answer engines and by agents that read
// declared files rather than crawling HTML. This module probes the well-known paths where a site
// states its terms to those readers — llms.txt, ai.txt, security.txt, machine-readable API descriptions
// (the YAML/JSON surface), app-association files — and reports what is there.
//
// NONE OF THIS IS SCORED, AND THAT IS THE POINT. `llms.txt` is a 2024 convention with no registrar
// behind it; `ai.txt` is one vendor's proposal; publishing an OpenAPI document is a product decision.
// Deducting points for their absence would be this tool inventing a standard and then failing sites
// against it — the same error class as calling an AI-training opt-out a crawlability defect. So every
// row here is advisory (Suite 14, weight 0, severity `manual`): an INVENTORY an operator reads, not a
// verdict. What IS asserted is narrow and checkable: if a file is present, does it parse, and does it
// contradict something else the site says.
//
// SOFT-404 IS THE TRAP THIS MODULE EXISTS TO AVOID. A large share of sites answer `/llms.txt` with
// HTTP 200 and their HTML 404 page. A probe that trusts the status code reports "llms.txt present" on
// a site that has none — a false green, on a file whose whole purpose is to be read by a machine that
// will not notice. Every probe below therefore validates SHAPE, not status.

const { getText } = require('../../migration-qa/http');

// [path, key, label, kind]. `kind` selects the shape validator — a status code proves nothing here.
const PROBES = [
  ['/llms.txt', 'llmsTxt', 'llms.txt', 'llms'],
  ['/llms-full.txt', 'llmsFullTxt', 'llms-full.txt', 'text'],
  ['/ai.txt', 'aiTxt', 'ai.txt', 'directives'],
  ['/.well-known/security.txt', 'securityTxt', 'security.txt', 'directives'],
  ['/security.txt', 'securityTxtRoot', 'security.txt (root)', 'directives'],
  ['/humans.txt', 'humansTxt', 'humans.txt', 'text'],
  ['/openapi.yaml', 'openapiYaml', 'openapi.yaml', 'yaml'],
  ['/openapi.json', 'openapiJson', 'openapi.json', 'json'],
  ['/.well-known/ai-plugin.json', 'aiPlugin', 'ai-plugin.json', 'json'],
  ['/.well-known/assetlinks.json', 'assetLinks', 'assetlinks.json (Android app indexing)', 'json'],
  ['/.well-known/apple-app-site-association', 'appleAppSite', 'apple-app-site-association (iOS app indexing)', 'json'],
];

const isHtml = (body, ct) => /text\/html/i.test(ct || '') || /^\s*(<!doctype html|<html[\s>])/i.test(String(body || ''));

// ---- shape validators. Each returns { valid, note, meta? } -------------------------------------

// llmstxt.org: an H1 title, an OPTIONAL `>` blockquote summary, then `##` sections whose bodies are
// markdown link lists. The H1 is the only hard requirement — a file without one is not the format.
function validateLlms(body) {
  const text = String(body || '');
  const lines = text.split(/\r?\n/);
  const h1 = lines.find(l => /^#\s+\S/.test(l));
  if (!h1) return { valid: false, note: 'no H1 title line — llms.txt must open with "# Title"' };
  const sections = lines.filter(l => /^##\s+\S/.test(l)).map(l => l.replace(/^##\s+/, '').trim());
  const links = [...text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map(m => m[1]);
  const summary = /^\s*>\s+\S/m.test(text);
  return {
    valid: true,
    note: `${sections.length} section(s), ${links.length} link(s)${summary ? ', summary present' : ', no summary blockquote'}`,
    meta: { title: h1.replace(/^#\s+/, '').trim(), sections, links: links.slice(0, 100), linkCount: links.length, summary },
  };
}

// robots-style `Field: value` files (ai.txt, security.txt). One valid directive line is the bar.
function validateDirectives(body) {
  const lines = String(body || '').split(/\r?\n/).map(l => l.replace(/#.*$/, '').trim()).filter(Boolean);
  const fields = lines.map(l => { const i = l.indexOf(':'); return i > 0 ? l.slice(0, i).trim().toLowerCase() : null; }).filter(Boolean);
  if (!fields.length) return { valid: false, note: 'no "Field: value" directive lines' };
  return { valid: true, note: `${fields.length} directive(s): ${[...new Set(fields)].slice(0, 8).join(', ')}`, meta: { fields: [...new Set(fields)] } };
}

function validateJson(body) {
  try { const o = JSON.parse(body); return { valid: true, note: `valid JSON (${Array.isArray(o) ? o.length + ' entries' : Object.keys(o).length + ' keys'})`, meta: { keys: Array.isArray(o) ? [] : Object.keys(o).slice(0, 20) } }; }
  catch (e) { return { valid: false, note: 'present but not valid JSON — ' + String(e.message).slice(0, 80) }; }
}

// YAML without a YAML parser. This engine takes no runtime dependencies for a check that is advisory,
// so the assertion is deliberately weak and STATED as weak: does this look like a mapping document
// (`key:` lines / `---` document markers) rather than HTML or prose. It never claims the YAML is valid.
function validateYaml(body) {
  const text = String(body || '');
  const lines = text.split(/\r?\n/).filter(l => l.trim() && !/^\s*#/.test(l));
  if (!lines.length) return { valid: false, note: 'empty' };
  const mapping = lines.filter(l => /^[\w".'-][^:]*:(\s|$)/.test(l) || /^\s*-\s+/.test(l) || /^---\s*$/.test(l)).length;
  const ratio = mapping / lines.length;
  if (ratio < 0.5) return { valid: false, note: 'does not read as a YAML mapping document' };
  const version = /^\s*openapi:\s*["']?([\d.]+)/m.exec(text);
  return {
    valid: true,
    // Say what was and was not checked, on the row, so nobody reads this as schema validation.
    note: `looks like YAML${version ? ` · OpenAPI ${version[1]}` : ''} — shape only, not schema-validated`,
    meta: version ? { openapi: version[1] } : {},
  };
}

function validateText(body) {
  const t = String(body || '').trim();
  return t.length ? { valid: true, note: `${t.length} bytes` } : { valid: false, note: 'empty' };
}

const VALIDATORS = { llms: validateLlms, directives: validateDirectives, json: validateJson, yaml: validateYaml, text: validateText };

// ---- feeds + declared alternates, read from HTML the crawl already fetched (no extra request) ----
function feedsFromHtml(html, pageUrl) {
  const out = [];
  for (const m of String(html || '').matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/rel\s*=\s*["']?alternate/i.test(tag)) continue;
    const type = (/type\s*=\s*["']([^"']+)["']/i.exec(tag) || [])[1] || '';
    if (!/rss|atom|feed\+json/i.test(type)) continue;
    const href = (/href\s*=\s*["']([^"']+)["']/i.exec(tag) || [])[1];
    if (!href) continue;
    try { out.push({ type, url: new URL(href, pageUrl).href }); } catch (e) { /* unresolvable href — not a feed we can report */ }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
async function probeDiscovery(origin, { homeHtml = '', homeUrl = '' } = {}) {
  const found = {};
  const results = await Promise.all(PROBES.map(async ([p, key, label, kind]) => {
    const url = origin + p;
    let r;
    try { r = await getText(url); } catch (e) { r = { error: String(e && e.message || e) }; }
    const rec = { key, label, path: p, url, status: r.status || null, present: false, valid: false, note: '' };
    if (r.error || !r.status) { rec.note = 'not reachable'; return rec; }
    if (r.status >= 400) { rec.note = `HTTP ${r.status}`; return rec; }
    // ── ABSENT ARRIVES IN THREE SHAPES, AND ONLY ONE OF THEM IS A 404 ────────────────────────────
    // Each of these was a live false positive, MEASURED on sgen.com, where every unknown path answers
    // `301 → /404?from=…` with an empty body. The report claimed the site published openapi.json,
    // ai-plugin.json, assetlinks.json and apple-app-site-association — and that all four were INVALID.
    // Four files it does not have, each with a defect it does not have.
    //   • a REDIRECT is the site routing the path away: no file here.
    //   • an EMPTY body is not a document, whatever the status line says.
    //   • an HTML body is the site's own page shell — the classic soft 404. This gate now covers JSON
    //     probes too; exempting them is what let the HTML shell reach JSON.parse and come back
    //     "present but not valid JSON", which reads as a broken file rather than a missing one.
    if (r.status >= 300) { rec.note = `HTTP ${r.status} → ${r.location || 'elsewhere'} — this path is redirected away, so no such file is published here`; return rec; }
    if (!String(r.body || '').trim()) { rec.note = `HTTP ${r.status} with an empty body — no file published here`; return rec; }
    if (isHtml(r.body, r.contentType)) { rec.note = `HTTP ${r.status} but served HTML — this path has no such file (soft 404)`; rec.softHtml = true; return rec; }
    const v = (VALIDATORS[kind] || validateText)(r.body);
    rec.present = true; rec.valid = v.valid; rec.note = v.note;
    if (v.meta) rec.meta = v.meta;
    return rec;
  }));
  for (const r of results) found[r.key] = r;

  return {
    files: results,
    present: results.filter(r => r.present).map(r => r.label),
    invalid: results.filter(r => r.present && !r.valid).map(r => ({ label: r.label, url: r.url, note: r.note })),
    feeds: feedsFromHtml(homeHtml, homeUrl || origin),
    byKey: found,
  };
}

module.exports = { probeDiscovery, feedsFromHtml, validateLlms, validateDirectives, validateYaml, validateJson, PROBES };
