'use strict';
// http-status.js — ONE plain-English vocabulary for HTTP status codes, for the whole product.
//
// WHY. The page-coverage list rendered a bare number: a URL and "403". The number is the evidence, not
// the finding. 403 and 404 land on completely different desks — one is a WAF or an IP allowlist and the
// site is fine, the other is a real dead page someone has to create or unlink — and the report made the
// reader supply that knowledge themselves. A status code the reader has to look up is a code that gets
// skipped.
//
// Same rule as reachability.js: the wording lives in ONE place and every surface imports it, so the same
// status cannot get two different explanations depending on which panel it appears in.
//
// No I/O, no dependencies — pure functions, unit-testable.

// Exact codes worth their own words. Anything not listed falls back to its class (see CLASS below).
const EXACT = {
  200: ['OK', 'The page was served normally.'],
  201: ['Created', 'The request created something — unusual for a page fetch.'],
  204: ['No Content', 'The server answered successfully but sent no body, so there is nothing to audit.'],
  301: ['Moved Permanently', 'This URL is a permanent redirect. It is not a page in its own right — the destination is what users and search engines get.'],
  302: ['Found (temporary redirect)', 'A temporary redirect. If this is permanent in practice it should be a 301, or engines will keep indexing the old URL.'],
  303: ['See Other', 'A redirect to a different resource, normally after a form submission.'],
  304: ['Not Modified', 'The cached copy is still current. Not an error.'],
  307: ['Temporary Redirect', 'A temporary redirect that preserves the request method.'],
  308: ['Permanent Redirect', 'A permanent redirect that preserves the request method — the modern 301.'],
  400: ['Bad Request', 'The server rejected the request as malformed. Often a broken or mis-encoded URL in a link or sitemap.'],
  401: ['Unauthorized', 'The page needs credentials. This scanner has none, so the content behind it was never seen — it is unaudited, not clean.'],
  403: ['Forbidden', 'The server refused the request. Usually a WAF, a bot filter, or an IP allowlist rather than a missing page — the site may be perfectly healthy and simply closed to this scanner.'],
  404: ['Not Found', 'There is no page at this URL. If something links here or it sits in the sitemap, that reference is broken.'],
  405: ['Method Not Allowed', 'The server rejected the HTTP method used. Usually an endpoint rather than a page.'],
  408: ['Request Timeout', 'The server gave up waiting for the request.'],
  410: ['Gone', 'The page was deliberately removed and is not coming back. Unlike a 404 this is intentional — but links to it are still broken.'],
  418: ["I'm a teapot", 'A joke status. In the wild it usually means a bot filter is turning the scanner away.'],
  429: ['Too Many Requests', 'Rate limited. The crawl was too fast for this origin — lower the concurrency and re-run before treating the result as complete.'],
  451: ['Unavailable For Legal Reasons', 'Blocked for legal or regional reasons.'],
  500: ['Internal Server Error', 'The server crashed handling this URL. This is a fault on the site, not in the link.'],
  501: ['Not Implemented', 'The server does not support what was asked of it.'],
  502: ['Bad Gateway', 'An upstream server gave a bad response — commonly an application behind a proxy that is down.'],
  503: ['Service Unavailable', 'The server is overloaded or in maintenance. Often transient — re-run before reporting it as a defect.'],
  504: ['Gateway Timeout', 'An upstream server did not answer in time.'],
  520: ['Unknown Error (Cloudflare)', 'Cloudflare reached the origin but got an invalid response.'],
  521: ['Web Server Is Down (Cloudflare)', 'Cloudflare could not reach the origin at all.'],
  522: ['Connection Timed Out (Cloudflare)', 'Cloudflare could not establish a connection to the origin.'],
  523: ['Origin Is Unreachable (Cloudflare)', 'Cloudflare could not route to the origin — often a DNS or firewall problem.'],
  525: ['SSL Handshake Failed (Cloudflare)', 'Cloudflare and the origin could not agree a TLS connection.'],
};

// Class fallback, so an unlisted code is still explained rather than shown bare.
const CLASS = {
  1: ['Informational', 'An interim response. Rare for a page fetch.'],
  2: ['Success', 'The server answered successfully.'],
  3: ['Redirect', 'This URL redirects elsewhere — the destination is the real page.'],
  4: ['Client error', 'The server rejected the request. The URL, the credentials, or the scanner itself was refused.'],
  5: ['Server error', 'The server failed handling this URL. A fault on the site, not in the link.'],
};

// What the operator should DO. Only where the answer is genuinely actionable — an "action" that just
// restates the problem trains people to skip the column.
const ACTION = {
  401: 'Give the scanner credentials, or accept that this URL is out of scope and exclude it.',
  403: 'Ask the site owner to allowlist this scanner, or run the audit from a network the origin accepts.',
  404: 'Fix or remove whatever links here, and drop the URL from the sitemap.',
  410: 'Remove the remaining links and the sitemap entry — the page is gone on purpose.',
  429: 'Lower the crawl concurrency and re-run. These pages are unaudited, not clean.',
  500: 'Send the URL to whoever owns the application — this is a server-side fault.',
  502: 'Check the application behind the proxy is running.',
  503: 'Re-run once the site is out of maintenance before treating this as a defect.',
};

// A category coarse enough to count on. This is what the report groups by.
function statusGroup(code) {
  const n = Number(code);
  if (!Number.isFinite(n) || n <= 0) return 'unreachable';
  if (n >= 200 && n < 300) return 'ok';
  if (n >= 300 && n < 400) return 'redirect';
  if (n === 401 || n === 403 || n === 429) return 'blocked';
  if (n >= 400 && n < 500) return 'missing';
  if (n >= 500) return 'server-error';
  return 'other';
}

const GROUP_LABEL = {
  ok: 'served normally',
  redirect: 'redirected elsewhere',
  blocked: 'refused this scanner',
  missing: 'do not exist',
  'server-error': 'failed on the server',
  unreachable: 'never answered',
  other: 'other',
};

// statusMeaning(code) -> { code, label, meaning, action, group, groupLabel }
// code 0 / null / undefined / non-numeric = the fetch never produced a status at all. That is a real,
// common case (DNS, timeout, refused) and must not render as "other".
function statusMeaning(code) {
  const n = Number(code);
  const group = statusGroup(code);
  if (!Number.isFinite(n) || n <= 0) {
    return { code: null, label: 'No response', group, groupLabel: GROUP_LABEL[group],
      meaning: 'The request never produced an HTTP status — the host did not resolve, did not answer, or refused the connection.',
      action: 'Confirm the URL loads from another network before treating it as down.' };
  }
  const exact = EXACT[n];
  const cls = CLASS[Math.floor(n / 100)] || ['Unknown status', 'This status is not one the tool has wording for.'];
  const [label, meaning] = exact || cls;
  return { code: n, label, meaning, action: ACTION[n] || null, group, groupLabel: GROUP_LABEL[group] };
}

// Count a list of statuses into groups, each with the exact codes underneath. Input may be raw codes or
// objects carrying a `status` — both shapes turn up (pageCoverage.errored is {url,status}).
// Returns groups sorted by count desc, and codes within a group likewise, so the report never has to sort.
function summariseStatuses(list) {
  const items = Array.isArray(list) ? list : [];
  const byGroup = new Map();
  let total = 0;
  for (const it of items) {
    const raw = (it && typeof it === 'object') ? it.status : it;
    const m = statusMeaning(raw);
    const key = m.group;
    if (!byGroup.has(key)) byGroup.set(key, { group: key, groupLabel: m.groupLabel, count: 0, codes: new Map() });
    const g = byGroup.get(key);
    g.count++; total++;
    const ck = m.code == null ? 'none' : m.code;
    if (!g.codes.has(ck)) g.codes.set(ck, { code: m.code, label: m.label, meaning: m.meaning, action: m.action, count: 0 });
    g.codes.get(ck).count++;
  }
  const groups = [...byGroup.values()]
    .map(g => ({ ...g, codes: [...g.codes.values()].sort((a, b) => b.count - a.count) }))
    .sort((a, b) => b.count - a.count);
  return { total, groups };
}

module.exports = { statusMeaning, statusGroup, summariseStatuses };
