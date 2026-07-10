'use strict';
// lib/uri-validate.js — deterministic, offline per-scheme URI validation. One reusable primitive called
// by LINK / FORM / SEC / SEO rules so URI logic lives in exactly one place. No network, no guessing.
// Returns { scheme, valid, level, reason } — level ∈ {ok, warning, informational, invalid}.

const SCHEMES = ['http', 'https', 'mailto', 'tel', 'sms', 'ftp', 'blob', 'data', 'javascript'];

// RFC-5322-ish addr (pragmatic, not exhaustive) — one @, no consecutive dots, TLD present.
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;
const TEL_RE = /^\+?[0-9][0-9()\-.\s]{4,}$/;

function schemeOf(uri) {
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(String(uri || '').trim());
  return m ? m[1].toLowerCase() : null;
}

// Validate one URI. `context` (optional) = 'link' | 'form-action' | 'image' — lets a caller treat e.g.
// javascript: as invalid in a link but merely a warning elsewhere. Default is neutral.
function validateUri(uri, context) {
  const raw = String(uri == null ? '' : uri).trim();
  const scheme = schemeOf(raw);

  if (raw === '') return { scheme: null, valid: false, level: 'invalid', reason: 'empty URI' };
  if (raw === '#') return { scheme: null, valid: false, level: 'invalid', reason: 'fragment-only "#" (no target)' };

  // relative / root-relative / fragment links are valid targets (resolved against the page elsewhere)
  if (!scheme) {
    if (/^#\S+/.test(raw)) return { scheme: 'fragment', valid: true, level: 'ok', reason: 'in-page anchor' };
    return { scheme: 'relative', valid: true, level: 'ok', reason: 'relative URL' };
  }

  switch (scheme) {
    case 'http':
    case 'https':
    case 'ftp':
    case 'blob': {
      try { new URL(raw); return { scheme, valid: true, level: 'ok', reason: 'well-formed' }; }
      catch (_) { return { scheme, valid: false, level: 'invalid', reason: 'malformed ' + scheme + ' URL' }; }
    }
    case 'mailto': {
      const addr = raw.slice('mailto:'.length).split('?')[0];
      if (!addr) return { scheme, valid: false, level: 'invalid', reason: 'mailto with no address' };
      const bad = addr.split(',').map(a => a.trim()).filter(a => !EMAIL_RE.test(a));
      return bad.length
        ? { scheme, valid: false, level: 'invalid', reason: 'invalid email: ' + bad[0] }
        : { scheme, valid: true, level: 'ok', reason: 'valid mailto' };
    }
    case 'tel':
    case 'sms': {
      const num = raw.slice(scheme.length + 1).split('?')[0];
      return TEL_RE.test(num)
        ? { scheme, valid: true, level: 'ok', reason: 'valid ' + scheme }
        : { scheme, valid: false, level: 'invalid', reason: 'invalid phone number: ' + (num || '(empty)') };
    }
    case 'javascript': {
      const body = raw.slice('javascript:'.length).trim();
      // javascript:void(0) / javascript: / javascript:; == dead control
      if (body === '' || /^void\s*\(\s*0\s*\)$/.test(body) || body === ';') {
        return { scheme, valid: false, level: 'invalid', reason: 'javascript: no-op (dead control)' };
      }
      return { scheme, valid: true, level: 'warning', reason: 'javascript: URI — inline handler, prefer real handler' };
    }
    case 'data':
      return { scheme, valid: true, level: 'informational', reason: 'data: URI (inline payload)' };
    default:
      return { scheme, valid: false, level: 'invalid', reason: 'unsupported scheme: ' + scheme };
  }
}

// A "dead" interactive target — the highest-ROI check: empty / # / javascript-noop / missing.
function isDeadTarget(uri) {
  const r = validateUri(uri);
  return (r.scheme === null && !r.valid) || (r.scheme === 'javascript' && !r.valid);
}

module.exports = { validateUri, isDeadTarget, schemeOf, SCHEMES };
