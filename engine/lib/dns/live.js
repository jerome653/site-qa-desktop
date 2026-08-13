'use strict';
// dns/live.js — "the record points somewhere; does that somewhere actually serve this site?"
//
// A resolved A record proves a ZONE was edited. It proves nothing about a running server. The gap
// between the two is exactly the window a migration lives in: the record is right, the origin is
// not ready, and the site is down for everyone whose resolver already picked up the change.
//
// THE PROBE IS ADDRESSED TO THE IP, NOT THE NAME. Every request here connects to a specific
// address and supplies the hostname separately (Host header + TLS SNI). Fetching https://host/
// instead would just repeat whatever the OS resolver believes and would collapse a multi-IP
// answer into whichever one happened to be tried — so a two-record rollout with one dead origin
// would read as fully healthy. Per-IP is the only form of this check that can find that.
//
// TLS VERIFICATION IS DISABLED ON PURPOSE (rejectUnauthorized:false), and this is not a weakening:
// we are not trusting the connection, we are INSPECTING the certificate. With verification on, a
// wrong/expired cert aborts the socket and the tool reports "unreachable" — the one diagnosis
// guaranteed to send someone to look at the firewall while the real fault is the certificate. We
// take the cert and grade it ourselves, so a bad cert is reported AS a bad cert.

const https = require('node:https');
const http = require('node:http');
const crypto = require('node:crypto');

const UA = 'Mozilla/5.0 (SGEN-migration-QA dns-live check)';
const TIMEOUT = 10000;
const MAX_IPS_PER_NAME = 4; // bounded: a big round-robin set must not turn one check into a scan
const MAX_BODY = 200000;

// ---------------------------------------------------------------------------------------------
// one request, to one IP, for one hostname
// ---------------------------------------------------------------------------------------------
function probeIp(ip, hostname, { scheme = 'https', path = '/', timeout = TIMEOUT } = {}) {
  return new Promise((resolve) => {
    const isTls = scheme === 'https';
    const lib = isTls ? https : http;
    const v6 = ip.includes(':');
    const opts = {
      host: ip,
      family: v6 ? 6 : 4,
      port: isTls ? 443 : 80,
      path,
      method: 'GET',
      // Host header = name-based vhost selection. SNI = which certificate the server presents.
      // Both are required: set only one and a multi-tenant origin answers for the wrong site.
      headers: { Host: hostname, 'User-Agent': UA, Accept: 'text/html,*/*' },
      ...(isTls ? { servername: hostname, rejectUnauthorized: false } : {}),
      timeout,
    };
    const started = Date.now();
    const req = lib.request(opts, (res) => {
      let cert = null;
      if (isTls && res.socket && res.socket.getPeerCertificate) {
        const c = res.socket.getPeerCertificate(false);
        if (c && Object.keys(c).length) {
          cert = {
            subject: (c.subject && c.subject.CN) || null,
            issuer: (c.issuer && (c.issuer.O || c.issuer.CN)) || null,
            altNames: c.subjectaltname || '',
            validFrom: c.valid_from || null,
            validTo: c.valid_to || null,
          };
        }
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { if (body.length < MAX_BODY) body += chunk; });
      res.on('end', () => resolve({
        ip, scheme, ok: true, status: res.statusCode,
        location: res.headers.location || null,
        server: res.headers.server || null,
        ms: Date.now() - started,
        cert, body: body.slice(0, MAX_BODY),
      }));
      res.on('error', (e) => resolve({ ip, scheme, ok: false, error: e.code || String(e), ms: Date.now() - started }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ ip, scheme, ok: false, error: 'ETIMEDOUT', ms: Date.now() - started }); });
    req.on('error', (e) => resolve({ ip, scheme, ok: false, error: e.code || String(e), ms: Date.now() - started }));
    req.end();
  });
}

// ---------------------------------------------------------------------------------------------
// certificate grading
// ---------------------------------------------------------------------------------------------
// RFC 6125 wildcard matching: *.example.com covers www.example.com and NOT example.com itself, and
// NOT a.b.example.com. Both exclusions are real migration bugs — a cert issued only for the
// wildcard leaves the apex broken, and everyone assumes "the cert is installed" means covered.
function nameMatches(pattern, host) {
  const p = pattern.toLowerCase().replace(/\.$/, '');
  const h = host.toLowerCase().replace(/\.$/, '');
  if (p === h) return true;
  if (!p.startsWith('*.')) return false;
  const suffix = p.slice(1);            // "*.example.com" -> ".example.com"
  if (!h.endsWith(suffix)) return false;
  return !h.slice(0, h.length - suffix.length).includes('.'); // exactly one extra label
}

function gradeCert(cert, hostname, now = Date.now()) {
  if (!cert) return { present: false, covers: false, expired: null, daysLeft: null, names: [] };
  const names = String(cert.altNames || '')
    .split(/,\s*/).filter((s) => s.startsWith('DNS:')).map((s) => s.slice(4).trim());
  if (!names.length && cert.subject) names.push(cert.subject);
  const covers = names.some((n) => nameMatches(n, hostname));
  const to = cert.validTo ? Date.parse(cert.validTo) : NaN;
  const from = cert.validFrom ? Date.parse(cert.validFrom) : NaN;
  const daysLeft = Number.isFinite(to) ? Math.floor((to - now) / 86400000) : null;
  return {
    present: true, covers, names,
    issuer: cert.issuer || null, subject: cert.subject || null,
    notYetValid: Number.isFinite(from) ? now < from : null,
    expired: Number.isFinite(to) ? now > to : null,
    daysLeft, validTo: cert.validTo || null,
  };
}

// ---------------------------------------------------------------------------------------------
// content fingerprint
// ---------------------------------------------------------------------------------------------
// Purpose: tell "the new origin is serving the site" apart from "the old origin is still serving
// it". Hash of normalised VISIBLE text — not of the raw bytes, because a byte hash changes on every
// nonce, timestamp, cache-buster and CSRF token, and a fingerprint that never matches proves
// nothing twice.
//
// A MATCH IS AMBIGUOUS AND IS REPORTED AS SUCH. A faithful migration is SUPPOSED to serve identical
// copy, so "same fingerprint" can mean either "cutover worked perfectly" or "you are still on the
// old box". This function therefore only produces the fact; the unambiguous signal — whether the
// OLD IP still answers for this hostname — comes from probeLegacy() below, and that is what the
// rules layer leans on.
function fingerprint(html) {
  if (!html) return null;
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [, ''])[1].trim().slice(0, 200);
  const generator = (html.match(/<meta[^>]+name=["']generator["'][^>]+content=["']([^"']+)/i) || [, null])[1];
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, 20000);
  return {
    title, generator,
    bytes: html.length,
    hash: crypto.createHash('sha256').update(text).digest('hex').slice(0, 32),
  };
}

// ---------------------------------------------------------------------------------------------
// per-name verdict
// ---------------------------------------------------------------------------------------------
// VERDICT VOCABULARY — five values, deliberately distinct:
//   online       · at least one address answered 2xx (or redirected within the same site to a 2xx)
//                  with a certificate that is valid and covers this name
//   tls-invalid  · the server answered, the certificate is wrong/expired — the site is broken in a
//                  browser even though every socket-level probe here succeeded
//   redirect-off · answers, but every path leads off this hostname (parked domain, forwarder)
//   degraded     · some addresses serve and others do not — a partial rollout, which reads as
//                  healthy to anyone who tests once and gets lucky
//   unreachable  · resolved, nothing answered
//
// `unreachable` is NOT `absent`. The name resolves; the origin is silent. Those demand different
// fixes (server/firewall vs. zone), and merging them sends people to the wrong place.
async function checkName(hostname, addresses, opts = {}) {
  const ips = (addresses || []).slice(0, MAX_IPS_PER_NAME);
  if (!ips.length) return { hostname, verdict: 'unreachable', reason: 'no A/AAAA address to probe', ips: [] };

  const results = [];
  for (const ip of ips) {
    let r = await probeIp(ip, hostname, { scheme: 'https', ...opts });
    // Plain-HTTP fallback only when TLS could not be established at all. If HTTPS answered with a
    // bad cert we keep THAT result — retrying on port 80 would hide the certificate fault behind a
    // cheerful 200.
    if (!r.ok && (r.error === 'ECONNREFUSED' || r.error === 'EPROTO' || r.error === 'ECONNRESET')) {
      const alt = await probeIp(ip, hostname, { scheme: 'http', ...opts });
      if (alt.ok) r = { ...alt, note: 'https unavailable on this address; answered over http' };
    }
    const cert = r.ok ? gradeCert(r.cert, hostname) : { present: false, covers: false };
    const fp = r.ok && r.status >= 200 && r.status < 300 ? fingerprint(r.body) : null;
    const offSite = (() => {
      if (!r.location) return false;
      try { return new URL(r.location, `https://${hostname}`).hostname.replace(/^www\./, '') !== hostname.replace(/^www\./, ''); }
      catch (_) { return false; }
    })();
    results.push({
      ip, ok: r.ok, status: r.status || null, error: r.error || null, ms: r.ms,
      server: r.server || null, scheme: r.scheme, note: r.note || null,
      location: r.location || null, offSite, cert, fingerprint: fp,
    });
  }

  // A LIMIT OF THE MACHINE RUNNING THIS IS NOT A DEFECT OF THE SITE. On a host with no IPv6
  // route, every AAAA probe fails with ENETUNREACH — and the first live run duly reported
  // example.com as "degraded, 2 of 4 addresses not serving, blocks cutover". The site was fine;
  // the laptop had no IPv6. Reporting that as a fault would put a launch-blocking finding on
  // essentially every modern site, which is both wrong and the fastest way to make people stop
  // reading the report. These probes are excluded from the verdict and reported as untested.
  const UNTESTABLE = new Set(['ENETUNREACH', 'EAFNOSUPPORT', 'EHOSTUNREACH', 'EADDRNOTAVAIL']);
  results.forEach((r) => { if (!r.ok && UNTESTABLE.has(r.error)) { r.untestable = true; r.untestableReason = r.ip.includes(':') ? 'no IPv6 route from this machine' : 'no route from this machine'; } });

  const testable = results.filter((r) => !r.untestable);
  const untested = results.filter((r) => r.untestable);
  const answered = testable.filter((r) => r.ok);
  const serving = answered.filter((r) => r.status >= 200 && r.status < 400);
  const certBad = answered.some((r) => r.scheme === 'https' && r.cert.present && (!r.cert.covers || r.cert.expired));
  const allOffSite = serving.length > 0 && serving.every((r) => r.offSite);

  let verdict;
  if (!testable.length) verdict = 'untested';           // nothing here could be reached from this host at all
  else if (!answered.length) verdict = 'unreachable';
  else if (certBad) verdict = 'tls-invalid';
  else if (allOffSite) verdict = 'redirect-off';
  else if (!serving.length) verdict = 'unreachable';
  else if (serving.length < testable.length) verdict = 'degraded';
  else verdict = 'online';

  return {
    hostname, verdict, ips: results,
    untested: untested.map((r) => ({ ip: r.ip, reason: r.untestableReason })),
    fingerprint: (serving.find((r) => r.fingerprint) || {}).fingerprint || null,
  };
}

// ---------------------------------------------------------------------------------------------
// legacy-origin probe — the unambiguous half of "did the cutover really happen"
// ---------------------------------------------------------------------------------------------
// Ask the addresses recorded in the BASELINE whether they still serve this hostname. This is the
// finding a fingerprint comparison cannot give you: if the old origin still answers, then every
// resolver, browser and corporate cache still holding the old A record is still being served a
// live copy of the site — writes, form posts and logins are landing on a machine everybody has
// stopped watching. It stays true even when old and new serve byte-identical HTML.
async function probeLegacy(hostname, baselineIps, currentIps, opts = {}) {
  const stale = (baselineIps || []).filter((ip) => !(currentIps || []).includes(ip)).slice(0, MAX_IPS_PER_NAME);
  if (!stale.length) return { checked: [], stillServing: [] };
  const checked = [];
  for (const ip of stale) {
    const r = await probeIp(ip, hostname, { scheme: 'https', ...opts });
    checked.push({
      ip, ok: r.ok, status: r.status || null, error: r.error || null,
      fingerprint: r.ok && r.status >= 200 && r.status < 300 ? fingerprint(r.body) : null,
    });
  }
  return { checked, stillServing: checked.filter((c) => c.ok && c.status >= 200 && c.status < 400).map((c) => c.ip) };
}

module.exports = { probeIp, checkName, probeLegacy, fingerprint, gradeCert, nameMatches };
