'use strict';
// lib/fingerprint.js — the SINGLE fingerprint service. Rules never hash directly; they hand facts to
// this service, which produces the deterministic finding fingerprint used for scan-diff / regression /
// suppress-unchanged / CI history. Extends the existing content-addressed digest (finding-store/digest.js)
// so historical certs stay reproducible. Same logical finding → same fingerprint on any machine, forever.
const { sha256 } = require('../finding-store/digest');

function normalizeUrl(u) {
  if (!u) return '';
  try { const x = new URL(u); return (x.origin + x.pathname).replace(/\/+$/, '') || x.origin; }
  catch (_) { return String(u).trim(); }
}
function normalizeEvidence(e) {
  if (e == null) return '';
  if (typeof e === 'string') return e.trim().slice(0, 300);
  return String(e.value != null ? e.value : (e.detail || '')).trim().slice(0, 300);
}

// fingerprint = sha256(ruleId + normalizedUrl + stableSelector + normalizedEvidence)
function fingerprintOf({ ruleId, url, selector, evidence } = {}) {
  return sha256({
    ruleId: ruleId || null,
    url: normalizeUrl(url),
    selector: selector || '',
    evidence: normalizeEvidence(evidence),
  });
}

module.exports = { fingerprintOf, normalizeUrl, normalizeEvidence };
