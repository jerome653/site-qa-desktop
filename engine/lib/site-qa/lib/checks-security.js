'use strict';
// lib/checks-security.js — Security Batch 2 (V2). Granular header split, cookie flags, dangerous-JS
// scan, password/login transport (per-page, static) + exposure probes (.git / backup / config / dir
// listing, site-level network). qa-site owns headers granularly here; qa-migration keeps the SEC-010
// roll-up (shared checks-static.js untouched). All Verified except SEC-023 (heuristic pattern scan).
const REG = require('../rules/registry');

function F(ruleId, check, detail, url, value, items) {
  const r = REG.getById(ruleId);
  return { ruleId, check, section: '10 Technical', severity: r ? r.severity : null, title: r ? r.title : ruleId,
    detail: detail || '', location: url, value: value == null ? '' : String(value), items: items || undefined };
}

// ── per-page (ctx: {html, headers, url, isHtml}) ──
function securityPageChecks(ctx) {
  const out = [];
  const h = ctx.headers || {};
  const isHttps = /^https:/i.test(ctx.url || '');

  if (ctx.isHtml) {
    // header split (SEC-011..015) — each missing header its own finding
    if (!h['content-security-policy']) out.push(F('SEC-011', 'sec-header', 'no Content-Security-Policy — XSS/injection defense-in-depth missing', ctx.url, 'absent'));
    if (!h['x-frame-options'] && !/frame-ancestors/i.test(h['content-security-policy'] || '')) out.push(F('SEC-012', 'sec-header', 'no X-Frame-Options / frame-ancestors — clickjacking risk', ctx.url, 'absent'));
    if (!h['referrer-policy']) out.push(F('SEC-013', 'sec-header', 'no Referrer-Policy — referrer leakage', ctx.url, 'absent'));
    if (!h['permissions-policy'] && !h['feature-policy']) out.push(F('SEC-014', 'sec-header', 'no Permissions-Policy — feature access unrestricted', ctx.url, 'absent'));
    if (!/nosniff/i.test(h['x-content-type-options'] || '')) out.push(F('SEC-015', 'sec-header', 'no X-Content-Type-Options: nosniff — MIME sniffing', ctx.url, 'absent'));
  }

  // cookies (SEC-016..018) — Set-Cookie may be a string or array
  const sc = h['set-cookie'];
  const cookies = Array.isArray(sc) ? sc : (sc ? [sc] : []);
  const missSecure = [], missHttp = [], missSame = [];
  for (const ck of cookies) {
    const name = (String(ck).split('=')[0] || '').trim().slice(0, 40);
    if (!/;\s*secure/i.test(ck) && isHttps) missSecure.push(name);
    if (!/;\s*httponly/i.test(ck)) missHttp.push(name);
    if (!/;\s*samesite=/i.test(ck)) missSame.push(name);
  }
  if (missSecure.length) out.push(F('SEC-016', 'sec-cookie', `${missSecure.length} cookie(s) without Secure`, ctx.url, missSecure.length, missSecure.map(n => ({ id: n || '(cookie)', section: 'set-cookie', value: 'no Secure' }))));
  if (missHttp.length) out.push(F('SEC-017', 'sec-cookie', `${missHttp.length} cookie(s) without HttpOnly`, ctx.url, missHttp.length, missHttp.map(n => ({ id: n || '(cookie)', section: 'set-cookie', value: 'no HttpOnly' }))));
  if (missSame.length) out.push(F('SEC-018', 'sec-cookie', `${missSame.length} cookie(s) without SameSite`, ctx.url, missSame.length, missSame.map(n => ({ id: n || '(cookie)', section: 'set-cookie', value: 'no SameSite' }))));

  if (ctx.isHtml && ctx.html) {
    // dangerous JS (SEC-023, heuristic) — scan inline <script> bodies only
    const scripts = [...ctx.html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]).join('\n');
    const hits = [];
    if (/\beval\s*\(/.test(scripts)) hits.push('eval(');
    if (/document\.write\s*\(/.test(scripts)) hits.push('document.write(');
    if (/\.innerHTML\s*=/.test(scripts)) hits.push('innerHTML=');
    if (hits.length) out.push(F('SEC-023', 'sec-js', `inline script uses ${hits.join(', ')} — injection-prone`, ctx.url, hits.join(',')));

    // password transport (SEC-024/025)
    const hasPw = /<input\b[^>]*type\s*=\s*["']password["']/i.test(ctx.html);
    if (hasPw && !isHttps) out.push(F('SEC-024', 'sec-transport', 'password field on a non-HTTPS page — credentials sent in the clear', ctx.url, 'http+password'));
    if (hasPw) {
      for (const fm of ctx.html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
        if (/method\s*=\s*["']?get/i.test(fm[1]) && /type\s*=\s*["']password["']/i.test(fm[2])) { out.push(F('SEC-025', 'sec-transport', 'login form uses method=GET — credentials land in the URL/history/logs', ctx.url, 'get+password')); break; }
      }
    }
  }
  return out;
}

// ── site-level exposure probes (one bounded GET each; honest-degrade on network error) ──
// A soft-404 / SPA / catch-all commonly returns 200 with the site's HTML for ANY path. So an exposure
// is only real when the body is NOT HTML *and* matches the file's own signature. isHtml() guards every
// probe → no false positives from servers that 200 everything.
function looksHtml(b) { return /<!doctype html|<html[\s>]|<head[\s>]|<body[\s>]/i.test(b || ''); }
const PROBES = [
  { path: '/.git/config', rule: 'SEC-019', check: 'sec-exposure', ok: (b) => !looksHtml(b) && /\[core\]/i.test(b) && /repositoryformatversion|bare\s*=/i.test(b), detail: '.git/config is publicly served — full source history is downloadable' },
  { path: '/.env', rule: 'SEC-021', check: 'sec-exposure', ok: (b) => !looksHtml(b) && /^[A-Z][A-Z0-9_]*\s*=\s*\S/m.test(b), detail: '.env is publicly served — secrets/keys exposed' },
  { path: '/backup.zip', rule: 'SEC-020', check: 'sec-exposure', ok: (b, s, ct) => /application\/(zip|octet-stream|x-zip)/i.test(ct || '') && !looksHtml(b), detail: 'a backup archive is publicly served' },
  { path: '/wp-config.php.bak', rule: 'SEC-020', check: 'sec-exposure', ok: (b) => !looksHtml(b) && /DB_PASSWORD|DB_NAME|define\s*\(\s*['"]DB_/i.test(b), detail: 'a config backup is publicly served' },
];
async function securitySiteProbes(origin, http, log = () => {}) {
  const out = [];
  if (!origin || !http) return out;
  for (const p of PROBES) {
    try {
      const url = origin.replace(/\/+$/, '') + p.path;
      const r = await http.getText(url);
      const ct = (r.headers && (r.headers['content-type'] || '')) || '';
      if (r.status === 200 && p.ok((r.body || '').slice(0, 2000), r.status, ct)) {
        out.push(F(p.rule, p.check, p.detail, url, 'exposed', [{ id: p.path, section: 'exposure', value: 'HTTP 200' }]));
      }
    } catch (e) { /* probe failed → treat as not-exposed (honest: absence of proof, not a fake pass) */ }
  }
  // directory listing (SEC-022) on origin root
  try {
    const r = await http.getText(origin);
    if (r.status === 200 && /<title>\s*Index of\s*\/|Directory listing for/i.test(r.body || '')) out.push(F('SEC-022', 'sec-exposure', 'server returns an auto-generated directory listing', origin, 'dir-listing'));
  } catch (e) {}
  return out;
}

module.exports = { securityPageChecks, securitySiteProbes };
