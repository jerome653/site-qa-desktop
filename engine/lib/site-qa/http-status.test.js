'use strict';
// http-status.test.js — a status code the reader has to look up is a code that gets skipped.
//
// The page-coverage list used to render a bare number. 403 and 404 land on completely different desks:
// one is a WAF or an IP allowlist and the site may be perfectly healthy, the other is a real dead page.
// These assertions pin the DISTINCTIONS that matter operationally, not the prose.
const { statusMeaning, statusGroup, summariseStatuses } = require('./http-status');

let pass = 0; const fails = [];
const ok = (cond, name) => { if (cond) pass++; else fails.push(name); };
const eq = (a, b, name) => ok(a === b, name + ` (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
const has = (s, re, name) => ok(re.test(String(s)), name + ` (got "${String(s).slice(0, 70)}")`);

console.log('\nHTTP status — what the code MEANS, not just the number\n');

// ── grouping: the distinction the report counts on ────────────────────────────────────────────────
eq(statusGroup(200), 'ok', '200 groups as ok');
eq(statusGroup(301), 'redirect', '301 groups as redirect');
eq(statusGroup(404), 'missing', '404 groups as missing');
eq(statusGroup(410), 'missing', '410 groups as missing');
eq(statusGroup(500), 'server-error', '500 groups as server-error');
eq(statusGroup(503), 'server-error', '503 groups as server-error');
// The one that carries the product's whole reachability story: refused is NOT missing.
eq(statusGroup(403), 'blocked', '403 groups as BLOCKED, not missing — a refused scanner is not a dead page');
eq(statusGroup(401), 'blocked', '401 groups as blocked');
eq(statusGroup(429), 'blocked', '429 groups as blocked — rate-limited pages are unaudited, not clean');
eq(statusGroup(0), 'unreachable', 'status 0 groups as unreachable');
eq(statusGroup(null), 'unreachable', 'null groups as unreachable');
eq(statusGroup('nonsense'), 'unreachable', 'a non-numeric status groups as unreachable, never "other"');

// ── meaning: every code explains itself ───────────────────────────────────────────────────────────
const m403 = statusMeaning(403);
eq(m403.label, 'Forbidden', '403 is labelled Forbidden');
has(m403.meaning, /WAF|bot filter|allowlist/i, '403 names the usual cause — a filter, not a missing page');
has(m403.meaning, /healthy/i, '403 says the site may be fine and simply closed to this scanner');
has(m403.action, /allowlist|another network|accepts/i, '403 tells the operator what to do');

const m404 = statusMeaning(404);
eq(m404.label, 'Not Found', '404 is labelled Not Found');
has(m404.meaning, /no page at this URL/i, '404 says the page does not exist');
has(m404.action, /links here|sitemap/i, '404 points at the links and the sitemap');
ok(m403.meaning !== m404.meaning, '403 and 404 do NOT share wording — the whole point of this module');

has(statusMeaning(301).meaning, /permanent/i, '301 is explained as permanent');
has(statusMeaning(301).meaning, /not a page in its own right|destination/i, '301 explains it is not a page to audit');
has(statusMeaning(410).meaning, /deliberately|intentional/i, '410 is distinguished from 404 by intent');
has(statusMeaning(429).meaning, /rate limit/i, '429 is explained as rate limiting');
has(statusMeaning(503).meaning, /maintenance|overloaded/i, '503 is explained as transient');
has(statusMeaning(503).action, /Re-run/i, '503 says to re-run before calling it a defect');
has(statusMeaning(502).meaning, /upstream|proxy/i, '502 names the upstream');
has(statusMeaning(521).label, /Cloudflare/i, 'Cloudflare-specific codes are named');

// ── no bare numbers, ever ─────────────────────────────────────────────────────────────────────────
const m0 = statusMeaning(0);
eq(m0.code, null, 'status 0 reports a null code rather than 0');
eq(m0.label, 'No response', 'status 0 is labelled No response');
has(m0.meaning, /never produced an HTTP status|did not resolve|refused/i, 'status 0 explains there was no response at all');
const m599 = statusMeaning(599);
eq(m599.group, 'server-error', 'an unlisted 5xx still groups correctly');
has(m599.meaning, /server/i, 'an unlisted 5xx still gets class-level wording rather than nothing');
ok(statusMeaning(499).label.length > 0, 'an unlisted 4xx still has a label');
for (const c of [200, 301, 400, 403, 404, 418, 451, 500, 522, 599, 0, null])
  ok(statusMeaning(c).meaning && statusMeaning(c).meaning.length > 10, `status ${c} always carries a real explanation`);

// ── counting: the report groups by these ──────────────────────────────────────────────────────────
const s = summariseStatuses([404, 404, 404, 403, 301, 500, 0, { status: 404 }, { status: 403 }]);
eq(s.total, 9, 'summarise counts every entry, object or raw');
const g = Object.fromEntries(s.groups.map(x => [x.group, x.count]));
eq(g.missing, 4, 'four missing (3 raw 404 + 1 object 404)');
eq(g.blocked, 2, 'two blocked');
eq(g.redirect, 1, 'one redirect');
eq(g['server-error'], 1, 'one server error');
eq(g.unreachable, 1, 'one unreachable');
eq(s.groups[0].group, 'missing', 'groups are sorted by count, biggest first');
const missing = s.groups.find(x => x.group === 'missing');
eq(missing.codes[0].code, 404, 'codes inside a group are listed with counts');
eq(missing.codes[0].count, 4, 'the code count matches');
has(missing.codes[0].meaning, /no page at this URL/i, 'each counted code carries its meaning');
has(missing.groupLabel, /do not exist/i, 'the group has a plain-English label');
eq(summariseStatuses([]).total, 0, 'an empty list summarises to zero, not a crash');
eq(summariseStatuses(null).total, 0, 'a null list summarises to zero, not a crash');
eq(summariseStatuses(null).groups.length, 0, 'a null list has no groups');

console.log(fails.length ? `\n❌ FAIL — ${pass} passed, ${fails.length} failed\n` : `\n✅ PASS — ${pass}/${pass} assertions\n`);
for (const f of fails) console.log('   ✗ ' + f);
process.exit(fails.length ? 1 : 0);
