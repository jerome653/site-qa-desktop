'use strict';
// reachability.js — DID WE ACTUALLY SEE THE SITE?
//
// THE DEFECT THIS EXISTS TO PREVENT. Measured on a fixture that answers 403 to every path
// (2026-07-30), which is what a WAF or an IP allowlist does to this scanner in the field:
//
//     verdict NEEDS ATTENTION · score 50% · QUALITY 71 · htmlPages 0 · 87 of 97 rules not evaluated
//     the word "blocked" appears 0 times in the report · the word "unreachable" 0 times
//     cross-browser: 1 pass, 1 warn — scored against the 403 error page
//     one screenshot, of the 403, presented in the report as the site
//
// A site the tool never saw scored 71 and nothing on the report said why. That is the platform's
// oldest law broken in the worst direction: "I never looked" presented as a measurement. And with
// nothing listening at all the same run reports quality 0 — also a measurement, of nothing, and
// indistinguishable from a genuinely terrible site.
//
// So: one pure function that answers "did we see the site, and if not, WHY", in operator language.
// No I/O, no clock, no browser — every input is evidence the crawl already collected.
//
// The wording rules are SHARED with visual-match's diagnoseEmpty(), which had the only good version of
// this taxonomy in the codebase. It now imports explainUnreachable() from here rather than keeping a
// second copy: the same failure must not get two different explanations depending on which tool the
// operator happened to open.

// A response that means "something answered, but it is not the site's content".
const BLOCKED = [401, 403, 407, 451];
const isBlocked = (s) => BLOCKED.includes(s);

// ── THE WORDING RULES ────────────────────────────────────────────────────────────────────────────
// statuses = the DISTINCT HTTP statuses seen (0 = the fetch threw). codes = the distinct low-level
// failure codes behind those zeros (http.js failureCode) — a status of 0 says the fetch failed but not
// why, and these causes need different actions from the operator, so they must not share one message.
function explainUnreachable(statuses = [], codes = [], site = 'site', urlNoun = 'target') {
  const blocked = statuses.find(isBlocked);
  if (blocked != null) return `The ${site} blocked this scanner (HTTP ${blocked}). It is likely blocking this scanner's IP — ask the site owner to allowlist it, or point at a source this tool can reach.`;
  if (statuses.includes(0) || statuses.length === 0) {
    const has = (re) => codes.some(c => re.test(String(c)));
    // Only an unresolvable NAME makes the address itself the suspect. The old single message read
    // "DNS or connection failure - check the URL is correct", which blames the ADDRESS for what is
    // usually a ROUTE, and cost a real investigation: a site that resolved fine, served 200 to the
    // rest of the world, and was simply blackholed from the operator's own network.
    if (has(/ENOTFOUND|EAI_AGAIN|ERR_NAME/i))
      return `The ${site}'s domain could not be resolved (DNS). Check the ${urlNoun} URL is spelled correctly.`;
    // Resolved, then silence. The address is fine; the path to it is not — so point outward, and say
    // plainly that "unreachable from here" is a weaker claim than "down". UND_ERR_* are undici's own
    // codes and are what actually turn up: its connect timeout fires before ours, so a blackholed host
    // reports UND_ERR_CONNECT_TIMEOUT and never ETIMEDOUT. Matching only POSIX names misses the single
    // most common real-world failure.
    if (has(/ETIMEDOUT|ETIMEOUT|EHOSTUNREACH|ENETUNREACH|ECONNRESET|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT|UND_ERR_SOCKET/i))
      return `The ${site} resolved, but never answered — the connection timed out. The site may well be up and simply unreachable from THIS network (an ISP route, a firewall, or a VPN that needs switching on). Confirm it loads from another network before treating it as down.`;
    if (has(/ECONNREFUSED/i))
      return `The ${site} refused the connection — something is answering at that address but rejecting the request (wrong port, or the service is stopped).`;
    if (has(/CERT|TLS|SSL|EPROTO|ERR_SSL/i))
      return `The ${site} failed its TLS handshake — a certificate or protocol problem, not a missing page.`;
    // No usable evidence. Stay vague on purpose rather than assert a cause we cannot prove.
    return `Could not connect to the ${site} (connection failure). Check the ${urlNoun} URL is reachable.`;
  }
  const server = statuses.find(s => s >= 500);
  if (server != null) return `The ${site} is erroring (HTTP ${server}). The server was reached but could not serve the page — this is the site's own failure, not a scanner problem.`;
  const notFound = statuses.find(s => s === 404 || s === 410);
  if (notFound != null) return `The ${site} returned HTTP ${notFound} for the URL given. The host is up, so check the path — an audit needs a page that exists, not the 404 handler.`;
  const redirect = statuses.find(s => s >= 300 && s < 400);
  if (redirect != null && statuses.every(s => s >= 300 && s < 400)) return `Every response was a redirect (HTTP ${redirect}) and none of them landed on a page. Follow the chain by hand — it either loops or ends somewhere this tool cannot fetch.`;
  return `The ${site} returned no auditable HTML (statuses seen: ${statuses.join(', ')}).`;
}

// ── SOFT STATUS PAGES ────────────────────────────────────────────────────────────────────────────
// A 200 that is really an error page. WAFs, CDNs and some frameworks serve their block/not-found page
// with a 200, so the status line says everything is fine while the body says "Access denied". Auditing
// that as the site produces a full set of confident findings about a page the visitor never sees.
//
// Deliberately CONSERVATIVE — a false positive here would refuse to audit a real page, which is worse
// than auditing an error page. Both conditions must hold:
//   1. the visible copy matches a status-page signature, AND
//   2. the page is THIN (a real page about HTTP 403 — a docs page, a blog post — has body copy).
// The title/h1 are checked rather than the whole body so that a page merely MENTIONING "404" is safe.
const STATUS_SIGNATURE = /\b(40[0-9]|41[0-9]|42[0-9]|45[0-9]|50[0-9]|51[0-9])\b|\b(forbidden|unauthorized|access denied|not found|page not found|service unavailable|bad gateway|gateway timeout|temporarily unavailable|attention required|checking your browser|enable javascript and cookies)\b/i;
const THIN_WORDS = 120;

function textOf(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function headlineOf(html) {
  const s = String(html || '');
  const t = (s.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
  const h = (s.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || '';
  return textOf(t + ' ' + h);
}
// Exported so a caller can label a single page; also the unit under test.
function softStatusPage(page) {
  const html = (page && page.body) || '';
  if (!html) return null;
  const headline = headlineOf(html);
  if (!headline || !STATUS_SIGNATURE.test(headline)) return null;
  const words = textOf(html).split(/\s+/).filter(Boolean).length;
  if (words > THIN_WORDS) return null;                 // a real page that happens to discuss an error
  return { url: (page && page.url) || '', headline: headline.slice(0, 120), words };
}

// ── THE DIAGNOSIS ────────────────────────────────────────────────────────────────────────────────
// pages = every crawl response (crawl.pages). htmlPages = the subset the audit would actually read.
// Returns null when the site WAS seen — an absent field means "no problem", so a caller that ignores
// this is unaffected and older reports stay valid.
function diagnoseReachability({ pages = [], htmlPages = [], target = '' } = {}) {
  const statuses = [...new Set(pages.map(p => (typeof p.status === 'number' ? p.status : 0)))].sort((a, b) => a - b);
  const codes = [...new Set(pages.map(p => p.errorCode).filter(Boolean))];
  const entry = pages[0] || null;
  const evidence = { pagesFetched: pages.length, htmlPages: htmlPages.length, statuses, errorCodes: codes, entryStatus: entry ? entry.status : null };

  // 1 · NOTHING AUDITABLE AT ALL. The hard case, and the one that was scoring 71.
  if (htmlPages.length === 0) {
    let reason = 'no-html';
    if (statuses.some(isBlocked)) reason = 'blocked';
    else if (statuses.includes(0) || !statuses.length) {
      const has = (re) => codes.some(c => re.test(String(c)));
      reason = has(/ENOTFOUND|EAI_AGAIN|ERR_NAME/i) ? 'dns'
        : has(/ECONNREFUSED/i) ? 'refused'
        : has(/CERT|TLS|SSL|EPROTO|ERR_SSL/i) ? 'tls'
        : has(/ETIMEDOUT|ETIMEOUT|EHOSTUNREACH|ENETUNREACH|ECONNRESET|UND_ERR/i) ? 'route'
        : 'unreachable';
    } else if (statuses.some(s => s >= 500)) reason = 'server-error';
    else if (statuses.some(s => s === 404 || s === 410)) reason = 'not-found';
    else if (statuses.length && statuses.every(s => s >= 300 && s < 400)) reason = 'redirect-dead-end';
    return {
      ok: false, audited: false, reason,
      message: explainUnreachable(statuses, codes, 'site', 'target'),
      // What the operator should DO differs per cause, so it is stated per cause rather than left as
      // one generic "check the URL" that is wrong for most of them.
      action: reason === 'blocked' ? 'Ask the site owner to allowlist this scanner, or run the audit from a network the site accepts.'
        : reason === 'dns' ? 'Check the spelling of the URL, and that the domain resolves from this machine.'
        : reason === 'route' ? 'Confirm the site loads from another network before treating it as down.'
        : reason === 'refused' ? 'Check the port and that the service is running.'
        : reason === 'tls' ? 'Inspect the certificate chain — the audit cannot proceed over a failed handshake.'
        : reason === 'server-error' ? 'The site itself is failing. Fix the server error, then re-run.'
        : reason === 'not-found' ? 'Point the audit at a page that exists (usually the homepage).'
        : reason === 'redirect-dead-end' ? 'Follow the redirect chain by hand and audit the URL it should land on.'
        : 'Confirm the URL serves HTML to an anonymous visitor.',
      target, evidence,
    };
  }

  // 2 · WE GOT HTML — but is it the site, or its block page served with a 200? Advisory: the audit
  // still runs (the pages ARE fetchable), and the report says the findings may describe an error page.
  const soft = htmlPages.map(softStatusPage).filter(Boolean);
  if (soft.length && soft.length === htmlPages.length) {
    return {
      ok: false, audited: true, reason: 'soft-status-page',
      message: `Every page fetched looks like a status or block page served with a success code — the first is titled “${soft[0].headline}” and carries ${soft[0].words} words. The audit below may describe an error page rather than the site.`,
      action: 'Open the URL in a normal browser. If you see the real site, this scanner is being served a different page (a WAF, a bot rule, or geo-blocking) — ask for it to be allowlisted.',
      target, evidence: { ...evidence, softPages: soft.slice(0, 10) },
    };
  }
  if (soft.length) {
    return {
      ok: true, audited: true, reason: 'some-soft-status-pages',
      message: `${soft.length} of ${htmlPages.length} pages fetched look like status or block pages served with a success code (e.g. “${soft[0].headline}”). Their findings describe those pages, not real content.`,
      action: 'Check whether those URLs should exist. A status page served as 200 is also an SEO defect in its own right — search engines will index it.',
      target, evidence: { ...evidence, softPages: soft.slice(0, 10) },
    };
  }
  return null;   // the site was seen. Absent field = no problem.
}

module.exports = { diagnoseReachability, explainUnreachable, softStatusPage, BLOCKED };
