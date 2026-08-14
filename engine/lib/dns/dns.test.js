'use strict';
// dns.test.js — offline gate for the DNS & Cutover module. Run: node lib/dns/dns.test.js
//
// NO NETWORK. Every assertion drives the real classifier with hand-built snapshots. A test that
// resolved a live domain would be green or red depending on the weather at the DNS root, and would
// quietly stop testing the classifier — which is the part that carries the actual judgement.
//
// The three sections that matter most:
//   §2 consensus — a timed-out resolver must never be counted as a vote, and never as agreement
//   §4 diff      — `dropped` and `unknown` must never collapse into `unchanged`; that collapse is
//                  precisely how a deleted MX record would ship as a green tick
//   §8 coverage  — every rule declared must be emitted by some code path, and every emitted id must
//                  be declared. DNS-022 was written and left unreachable during development; this
//                  section is what caught it.

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const resolve = require('./resolve');
const live = require('./live');
const snapshot = require('./snapshot');
const dns = require('./index');
const rules = require('./rules');

let pass = 0, fail = 0; const failures = [];
const ok = (c, n) => { if (c) pass++; else { fail++; failures.push(n); console.log('  ✗ ' + n); } };
const has = (findings, id) => findings.some((f) => f.ruleId === id);
const S = (name) => console.log(`\n${name}`);

// ---------------------------------------------------------------------------------------------
S('§1 normalisation — order-independent, spec-correct');
// ---------------------------------------------------------------------------------------------
ok(JSON.stringify(resolve.normalise('A', [{ address: '2.2.2.2', ttl: 60 }, { address: '1.1.1.1', ttl: 60 }])) === '["1.1.1.1","2.2.2.2"]',
  'A records sort, so round-robin rotation is not a diff');
ok(resolve.normalise('NS', ['NS1.Example.COM.'])[0] === 'ns1.example.com',
  'NS lowercased and de-rooted');
ok(resolve.normalise('MX', [{ priority: 10, exchange: 'MX.Example.com.' }])[0] === '10 mx.example.com',
  'MX keeps priority (a reorder changes which server takes mail first)');
ok(resolve.normalise('TXT', [['v=spf1 include:a ', 'include:b -all']])[0] === 'v=spf1 include:a include:b -all',
  'TXT chunks rejoin — a >255-char SPF/DKIM value is ONE string');
ok(resolve.normalise('CAA', [{ critical: 0, issue: 'LetsEncrypt.org' }])[0] === 'issue letsencrypt.org',
  'CAA flattens to a greppable "issue <identifier>"');
ok(resolve.normalise('SOA', { nsname: 'NS1.X.com.', hostmaster: 'a.X.com.', serial: 7 })[0] === 'ns1.x.com a.x.com 7',
  'SOA carries the serial — cheapest proof a zone was re-published');

// ---------------------------------------------------------------------------------------------
S('§2 consensus — a failed read is missing evidence, not a vote');
// ---------------------------------------------------------------------------------------------
const R = (status, values, ttl = null, error = null) => ({ status, values, ttl, ...(error ? { error } : {}) });

let c = resolve.consensus({ a: R('ok', ['1.1.1.1'], 300), b: R('ok', ['1.1.1.1'], 60), c: R('ok', ['1.1.1.1'], 300) });
ok(c.agreed === true && c.values[0] === '1.1.1.1', 'unanimous resolvers agree');
ok(c.ttl === 60, 'TTL is the LOWEST in the winning camp — staleness ceiling is the pessimistic one');

c = resolve.consensus({ a: R('ok', ['1.1.1.1']), b: R('ok', ['9.9.9.9']), c: R('ok', ['1.1.1.1']) });
ok(c.agreed === false && c.variants.length === 2, 'split answers report BOTH camps, not a majority winner');
ok(c.values[0] === '1.1.1.1', 'the larger camp leads, but the split is still flagged');

c = resolve.consensus({ a: R('ok', ['1.1.1.1']), b: R('error', [], null, 'ETIMEOUT'), c: R('ok', ['1.1.1.1']) });
ok(c.agreed === true && c.failed.length === 1 && c.sample === 2,
  'a timed-out resolver is excluded from the vote and reported separately');

c = resolve.consensus({ a: R('ok', ['1.1.1.1']), b: R('error', []), c: R('error', []) });
ok(c.agreed === 'insufficient', 'one definitive reply is an opinion, not consensus');

ok(resolve.classifyError({ code: 'ENODATA' }) === 'nodata', 'ENODATA = zone exists, record type absent (a DELETED record)');
ok(resolve.classifyError({ code: 'ENOTFOUND' }) === 'nxdomain', 'ENOTFOUND = the name does not exist');
ok(resolve.classifyError({ code: 'ETIMEOUT' }) === 'error', 'a timeout is a failed read, not a fact about the zone');
ok(resolve.classifyError({ code: 'ENODATA' }) !== resolve.classifyError({ code: 'ENOTFOUND' }),
  'nodata and nxdomain never collapse — opposite incidents');

// ---------------------------------------------------------------------------------------------
S('§3 certificate + fingerprint');
// ---------------------------------------------------------------------------------------------
ok(live.nameMatches('*.example.com', 'www.example.com') === true, 'wildcard covers one label');
ok(live.nameMatches('*.example.com', 'example.com') === false, 'wildcard does NOT cover the apex — the classic half-broken cert');
ok(live.nameMatches('*.example.com', 'a.b.example.com') === false, 'wildcard does not span two labels');
ok(live.nameMatches('Example.com.', 'example.com') === true, 'case and trailing dot are the same name');

const CERT = { subject: 'example.com', issuer: "Let's Encrypt", altNames: 'DNS:example.com, DNS:www.example.com', validFrom: 'Jan 1 00:00:00 2026 GMT', validTo: 'Dec 31 00:00:00 2026 GMT' };
const NOW = Date.parse('2026-08-13T00:00:00Z');
let g = live.gradeCert(CERT, 'example.com', NOW);
ok(g.covers === true && g.expired === false, 'cert covering the name and in date');
ok(live.gradeCert(CERT, 'shop.example.com', NOW).covers === false, 'a name absent from the SAN list is not covered');
ok(live.gradeCert({ ...CERT, validTo: 'Jan 2 00:00:00 2026 GMT' }, 'example.com', NOW).expired === true, 'expiry detected');
ok(live.gradeCert(null, 'example.com', NOW).present === false, 'no cert is reported as absent, not as failure');

const fpA = live.fingerprint('<html><head><title>Home</title></head><body><script>var t=1</script><p>Hello   world</p></body></html>');
const fpB = live.fingerprint('<html><head><title>Home</title></head><body><script>var t=999</script>\n<p>Hello world</p>\n</body></html>');
ok(fpA.hash === fpB.hash, 'fingerprint ignores scripts and whitespace — a nonce must not change it');
ok(fpA.title === 'Home', 'title captured');
ok(live.fingerprint('<html><body><p>Different</p></body></html>').hash !== fpA.hash, 'different copy fingerprints differently');

// ---------------------------------------------------------------------------------------------
S('§4 diff — dropped and unknown never collapse into unchanged');
// ---------------------------------------------------------------------------------------------
const rec = (status, values, extra = {}) => ({ agreed: true, status, values, ttl: null, variants: [], failed: [], sample: 3, byResolver: {}, ...extra });

ok(snapshot.diffRecord(rec('ok', ['a']), rec('ok', ['a'])).state === 'unchanged', 'same values = unchanged');
ok(snapshot.diffRecord(rec('ok', ['a']), rec('ok', ['b'])).state === 'changed', 'different values = changed');
ok(snapshot.diffRecord(rec('ok', ['a']), rec('nodata', [])).state === 'dropped', 'ok → nodata = DROPPED (the deletion case)');
ok(snapshot.diffRecord(rec('nodata', []), rec('ok', ['a'])).state === 'added', 'nodata → ok = added');
ok(snapshot.diffRecord(rec('ok', ['a']), rec('error', [])).state === 'unknown', 'a failed read is unknown — never "unchanged"');
ok(snapshot.diffRecord(rec('ok', ['a']), rec('ok', ['a'], { agreed: 'insufficient' })).state === 'unknown',
  'insufficient consensus is unknown even when the values happen to match');
ok(snapshot.diffRecord(rec('nodata', []), rec('nodata', [])).state === 'unchanged', 'absent on both sides is unchanged, not dropped');
const ch = snapshot.diffRecord(rec('ok', ['a', 'b']), rec('ok', ['b', 'c']));
ok(ch.removed.join() === 'a' && ch.added.join() === 'c', 'changed carries removed/added, not just the two sets');

ok(snapshot.spfOf(['v=spf1 -all', 'google-site-verification=x']).length === 1, 'SPF pulled out of the TXT set by prefix');
ok(snapshot.dmarcOf(['v=DMARC1; p=none']).length === 1, 'DMARC identified');
ok(snapshot.apexOf('WWW.Example.com.') === 'example.com', 'apex normalisation strips www, case and trailing dot');

// ---------------------------------------------------------------------------------------------
S('§5 current-state findings');
// ---------------------------------------------------------------------------------------------
const snapOf = (over = {}) => ({
  schema: snapshot.SCHEMA, host: 'example.com', capturedAt: '2026-08-13T00:00:00Z', resolvers: [],
  records: {
    A: rec('ok', ['1.1.1.1']), AAAA: rec('nodata', []), CNAME: rec('nodata', []),
    NS: rec('ok', ['ns1.host.com']), MX: rec('ok', ['10 mail.example.com']),
    TXT: rec('ok', ['v=spf1 -all']), CAA: rec('nodata', []), SOA: rec('ok', ['ns1.host.com a.x 1']),
    ...(over.records || {}),
  },
  www: { A: rec('ok', ['1.1.1.1']), AAAA: rec('nodata', []), CNAME: rec('nodata', []), ...(over.www || {}) },
  dmarc: over.dmarc || rec('ok', ['v=DMARC1; p=none']),
  cnameTarget: over.cnameTarget || null,
  live: over.live === undefined ? {
    apex: { hostname: 'example.com', verdict: 'online', ips: [{ ip: '1.1.1.1', ok: true, status: 200, scheme: 'https', cert: live.gradeCert(CERT, 'example.com', NOW), fingerprint: fpA }], fingerprint: fpA },
    www: { hostname: 'www.example.com', verdict: 'online', ips: [{ ip: '1.1.1.1', ok: true, status: 200, scheme: 'https', cert: live.gradeCert(CERT, 'www.example.com', NOW), fingerprint: fpA }], fingerprint: fpA },
  } : over.live,
});

ok(dns.commonFindings(snapOf()).length === 0, 'a healthy zone produces no findings');

const nx = rec('nxdomain', []);
let f = dns.commonFindings(snapOf({ records: { A: nx, AAAA: nx, NS: nx } }));
ok(has(f, 'DNS-001') && f.length === 1, 'NXDOMAIN short-circuits — no cascade of downstream noise');

f = dns.commonFindings(snapOf({ records: { A: rec('nodata', []), AAAA: rec('nodata', []) }, live: null }));
ok(has(f, 'DNS-002'), 'zone answers but publishes no address');

f = dns.commonFindings(snapOf({ records: { A: rec('ok', ['1.1.1.1'], { agreed: false, variants: [{ status: 'ok', values: ['1.1.1.1'], resolvers: ['google'] }, { status: 'ok', values: ['9.9.9.9'], resolvers: ['quad9'] }] }) } }));
ok(has(f, 'DNS-003'), 'split propagation flagged');

f = dns.commonFindings(snapOf({ records: { A: rec('ok', ['1.1.1.1'], { agreed: 'insufficient', failed: ['google', 'quad9'] }) } }));
ok(has(f, 'DNS-003'), 'a record we could not read is stated as unverified, never reported clean');

f = dns.commonFindings(snapOf({ www: { A: rec('ok', ['9.9.9.9']) } }));
ok(has(f, 'DNS-010'), 'apex and www on disjoint addresses = split-brain');
ok(dns.commonFindings(snapOf()).filter((x) => x.ruleId === 'DNS-010').length === 0,
  'www sharing the apex address (the CNAME-to-apex case) is NOT a split');

f = dns.commonFindings(snapOf({ www: { A: rec('nodata', []), AAAA: rec('nodata', []), CNAME: rec('nodata', []) }, live: null }));
ok(has(f, 'DNS-011'), 'missing www flagged');

f = dns.commonFindings(snapOf({ cnameTarget: { apex: { name: 'old.host.net', addresses: [], status: 'dangling' } }, records: { CNAME: rec('ok', ['old.host.net']) } }));
ok(has(f, 'DNS-022'), 'dangling CNAME flagged');
ok(has(f, 'DNS-013'), 'CNAME at the apex flagged');
f = dns.commonFindings(snapOf({ cnameTarget: { apex: { name: 'x.net', addresses: [], status: 'unknown' } }, records: { CNAME: rec('ok', ['x.net']) } }));
ok(!has(f, 'DNS-022'), 'a target we could not resolve is NOT called dangling');

f = dns.commonFindings(snapOf({ live: { apex: { hostname: 'example.com', verdict: 'unreachable', ips: [{ ip: '1.1.1.1', ok: false, error: 'ETIMEDOUT' }] }, www: null } }));
ok(has(f, 'DNS-015'), 'resolves but nothing answers');

f = dns.commonFindings(snapOf({ live: { apex: { hostname: 'example.com', verdict: 'degraded', ips: [{ ip: '1.1.1.1', ok: true, status: 200, scheme: 'https', cert: { present: false } }, { ip: '2.2.2.2', ok: false, error: 'ECONNREFUSED' }] }, www: null } }));
ok(has(f, 'DNS-023'), 'partial round-robin — one dead member');

// The regression the first live run produced: this machine has no IPv6, so every AAAA probe failed
// and example.com was reported "degraded — blocks cutover". A limit of the auditing host must never
// be reported as a defect of the audited site.
const v6dead = { ip: '2606:4700::1', ok: false, error: 'ENETUNREACH', untestable: true, untestableReason: 'no IPv6 route from this machine' };
f = dns.commonFindings(snapOf({ live: { apex: { hostname: 'example.com', verdict: 'online', untested: [{ ip: v6dead.ip, reason: v6dead.untestableReason }], ips: [{ ip: '1.1.1.1', ok: true, status: 200, scheme: 'https', cert: live.gradeCert(CERT, 'example.com', NOW) }, v6dead] }, www: null } }));
ok(!has(f, 'DNS-023') && !has(f, 'DNS-015'), 'an address with no route from here is NOT reported as the site failing');
ok(has(f, 'DNS-029'), 'it is reported once, as a gap in our own coverage');
ok(live.checkName('x.com', []).then, 'checkName is async');

f = dns.commonFindings(snapOf({ live: { apex: { hostname: 'example.com', verdict: 'online', ips: [{ ip: '1.1.1.1', ok: true, status: 200, scheme: 'https', cert: live.gradeCert({ ...CERT, altNames: 'DNS:other.com' }, 'example.com', NOW) }] }, www: null } }));
ok(has(f, 'DNS-016'), 'certificate not covering the name');

f = dns.commonFindings(snapOf({
  records: { CAA: rec('ok', ['issue digicert.com']) },
  live: { apex: { hostname: 'example.com', verdict: 'online', ips: [{ ip: '1.1.1.1', ok: true, status: 200, scheme: 'https', cert: live.gradeCert(CERT, 'example.com', NOW) }] }, www: null },
}));
ok(has(f, 'DNS-014'), "CAA permitting only DigiCert while Let's Encrypt is installed = renewal will fail");
f = dns.commonFindings(snapOf({
  records: { CAA: rec('ok', ['issue digicert.com']) },
  live: { apex: { hostname: 'example.com', verdict: 'online', ips: [{ ip: '1.1.1.1', ok: true, status: 200, scheme: 'https', cert: live.gradeCert({ ...CERT, issuer: 'Some Local CA Ltd' }, 'example.com', NOW) }] }, www: null },
}));
ok(!has(f, 'DNS-014'), 'an unrecognised issuer stays SILENT rather than accusing the CAA record');

ok(has(dns.preCutoverFindings(snapOf({ records: { A: rec('ok', ['1.1.1.1'], { ttl: 86400 }) } })), 'DNS-012'), 'TTL too high for a cutover');
ok(!has(dns.preCutoverFindings(snapOf({ records: { A: rec('ok', ['1.1.1.1'], { ttl: 300 }) } })), 'DNS-012'), '300s TTL is acceptable');
ok(has(dns.preCutoverFindings(snapOf()), 'DNS-025'), 'a domain with MX gets the DKIM-not-verifiable note');
// RFC 7505: a lone `0 .` MX declares the domain accepts NO mail. The first live run read it as
// normal mail routing and told the operator to go check DKIM for a domain that receives nothing.
ok(!has(dns.preCutoverFindings(snapOf({ records: { MX: rec('ok', ['0 ']) } })), 'DNS-025'),
  'a null MX means no mail — it must not be read as a mail domain');
ok(has(dns.preCutoverFindings(snapOf({ records: { MX: rec('ok', ['10 mail.example.com', '20 mx2.example.com']) } })), 'DNS-025'),
  'real MX records still produce the note');

// SOA arrives from node:dns as a bare object, not an array — normalise must be handed the object.
ok(resolve.normalise('SOA', { nsname: 'a.', hostmaster: 'b.', serial: 3 })[0] === 'a b 3',
  'SOA normalises from the object shape (an array wrapper produced "undefined undefined undefined" live)');

// ---------------------------------------------------------------------------------------------
S('§6 cutover findings — the asymmetry between an expected change and an incident');
// ---------------------------------------------------------------------------------------------
const NOLEG = { apex: { checked: [], stillServing: [] }, www: { checked: [], stillServing: [] } };
const run = (baseOver, curOver, legacy = NOLEG, opts = {}) => {
  const b = snapOf(baseOver), cur = snapOf(curOver);
  return dns.cutoverFindings(snapshot.diff(b, cur), b, cur, legacy, opts);
};

f = run({}, { records: { MX: rec('nodata', []) } });
ok(has(f, 'DNS-004'), 'MX dropped after a cutover = DNS-004');
f = run({}, { records: { TXT: rec('ok', ['google-site-verification=x']) } });
ok(has(f, 'DNS-005'), 'SPF gone from the TXT set = DNS-005');
ok(!has(f, 'DNS-020'), 'and DNS-020 does NOT also fire — SPF is reported once, by its own rule');
// The other half: a verification token removed while SPF survives. These fail silently in the
// wild — nothing bounces, the domain simply stops being verified in Google or a mail provider.
f = run({ records: { TXT: rec('ok', ['v=spf1 -all', 'google-site-verification=x']) } }, { records: { TXT: rec('ok', ['v=spf1 -all']) } });
ok(has(f, 'DNS-020') && !has(f, 'DNS-005'), 'a removed verification token is DNS-020, with SPF intact and unreported');
f = run({}, { dmarc: rec('nodata', []) });
ok(has(f, 'DNS-006'), 'DMARC dropped = DNS-006');
f = run({}, { records: { NS: rec('ok', ['ns1.newhost.com']) } });
ok(has(f, 'DNS-007'), 'nameserver change reported as the cause to read first');
f = run({}, { records: { SOA: rec('ok', ['ns1.newhost.com a.x 2']) } });
ok(has(f, 'DNS-021'), 'SOA change is informational context');

f = run({}, {});
ok(has(f, 'DNS-008'), 'an unchanged A record after a migration means the cutover has not happened');
ok(!has(run({}, { records: { A: rec('ok', ['5.5.5.5']) } }), 'DNS-008'), 'a moved address clears DNS-008');
ok(!has(run({}, {}, NOLEG, { expectCutover: false }), 'DNS-008'), 'expectCutover:false suppresses it for a plain re-check');

f = run({}, { records: { A: rec('ok', ['5.5.5.5']) } });
ok(!has(f, 'DNS-004') && !has(f, 'DNS-005'), 'a changed ADDRESS is the migration working — it raises no mail findings');

f = run({}, { records: { A: rec('ok', ['5.5.5.5']) } }, { apex: { checked: [], stillServing: ['1.1.1.1'] }, www: { checked: [], stillServing: [] } });
ok(has(f, 'DNS-018'), 'the old origin still answering is reported even though DNS is now correct');

f = run({}, { records: { A: rec('ok', ['5.5.5.5']) } });
ok(has(f, 'DNS-019'), 'identical content after an address change is surfaced as ambiguous, not as success');
ok(dns.commonFindings(snapOf()).concat(f).find((x) => x.ruleId === 'DNS-019').severity === 'medium',
  'and it is medium/manual — never a pass and never a failure');

// ---------------------------------------------------------------------------------------------
S('§7 expected target + verdict');
// ---------------------------------------------------------------------------------------------
ok(dns.targetFindings(snapOf(), { input: 'sgen', addresses: ['5.5.5.5'], kind: 'host' }).length === 1,
  'address not matching the intended target = DNS-009');
ok(dns.targetFindings(snapOf(), { input: 'sgen', addresses: ['1.1.1.1'], kind: 'host' }).length === 0,
  'address matching the target is silent');
ok(has(dns.targetFindings(snapOf(), { input: 'gone.example', addresses: [], kind: 'host' }), 'DNS-009'),
  'an unresolvable target is reported rather than silently skipped');

let v = dns.verdictOf(snapOf(), [], false);
ok(v.state === 'no-baseline', 'without a baseline the verdict is never "verified"');
ok(/deleted records cannot be detected/.test(v.note), 'and it says why');
ok(dns.verdictOf(snapOf(), [], true).state === 'verified', 'clean + baseline + serving = verified');
ok(dns.verdictOf(snapOf(), [{ readiness: 1 }], true).state === 'blocked', 'one blocking finding blocks');
ok(dns.verdictOf(snapOf({ live: { apex: { hostname: 'example.com', verdict: 'unreachable', ips: [] }, www: null } }), [], true).state === 'attention',
  'not serving = attention, even with nothing else wrong');

// ---------------------------------------------------------------------------------------------
S('§8 rule integrity + score neutrality');
// ---------------------------------------------------------------------------------------------
const ids = new Set(), slugs = new Set();
for (const r of rules.RULES) {
  ok(!ids.has(r.id), 'duplicate rule id ' + r.id); ids.add(r.id);
  ok(!slugs.has(r.slug), 'duplicate slug ' + r.slug); slugs.add(r.slug);
  ok(/^[A-Z0-9]+-\d{3}$/.test(r.id), 'id format ' + r.id);
  ok(rules.getById(r.id) === r && rules.getBySlug(r.slug) === r, 'reachable by id and slug: ' + r.id);
  // The two independent mechanisms that keep this suite out of the SGEN Quality Score.
  ok(r.severity === 'manual' && r.manual === true && r.deduction === 0, 'score-neutral: ' + r.id);
  // The registry's own invariant, which this block must satisfy to be mergeable.
  ok(r.tier === null, 'manual rule carries tier null (registry invariant): ' + r.id);
  ok(r.readiness === null || [1, 2, 3].includes(r.readiness), 'readiness is 1|2|3|null: ' + r.id);
  ok(typeof r.impact === 'string' && r.impact.length > 30, 'has a plain-language impact: ' + r.id);
  ok(r.suite === 'dns', 'one-check-one-suite: ' + r.id);
}
ok(rules.WEIGHT === 0, 'suite weight is 0');
ok(rules.SUITE.advisory === true, 'suite descriptor is marked advisory');

// Reachability, both directions. Source-scanned rather than inferred: an emitted id with no rule
// prints as a bare code with no title, and a declared rule no code path can emit is a promise the
// product does not keep.
const SRC = ['index.js'].map((f) => fs.readFileSync(path.join(__dirname, f), 'utf8')).join('\n');
const emitted = new Set([...SRC.matchAll(/F\('(DNS-\d{3})'/g)].map((m) => m[1]));
for (const id of emitted) ok(rules.getById(id), `emitted id ${id} exists in the rule set`);
for (const r of rules.RULES) ok(emitted.has(r.id), `declared rule ${r.id} is emitted by some code path`);

// ---------------------------------------------------------------------------------------------
S('§9 persistence round-trip');
// ---------------------------------------------------------------------------------------------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dns-snap-'));
try {
  const older = { ...snapOf(), capturedAt: '2026-01-01T00:00:00Z' };
  const newer = { ...snapOf(), capturedAt: '2026-08-13T00:00:00Z' };
  snapshot.save(newer, dir); snapshot.save(older, dir);
  const latest = snapshot.loadLatest(dir, 'example.com');
  ok(latest && latest.snap.capturedAt === '2026-08-13T00:00:00Z',
    'loadLatest picks by the timestamp INSIDE the file, not by mtime');
  ok(snapshot.loadLatest(dir, 'www.example.com').snap.host === 'example.com', 'a www host finds the apex baseline');
  ok(snapshot.loadLatest(dir, 'nothere.com') === null, 'unknown host returns null, not a wrong baseline');
  ok(snapshot.list(dir).length === 2, 'list enumerates both');
  const reloaded = snapshot.loadLatest(dir, 'example.com').snap;
  ok(dns.commonFindings(reloaded).length === 0, 'a snapshot re-classifies identically after a disk round-trip');
} finally { fs.rmSync(dir, { recursive: true, force: true }); }

// ---------------------------------------------------------------------------------------------
S('§10 recovered zone — the after-the-fact baseline');
// ---------------------------------------------------------------------------------------------
const recover = require('./recover');

// A recovered snapshot must be diffable against a live one with no special-casing — that is the
// whole reason queryZone() emits the consensus record shape.
const recoveredSnap = {
  ...snapOf(), source: 'recovered',
  recoveredFrom: { nameservers: [{ ns: 'ns1.oldhost.com', ip: '5.5.5.5' }], soa: 'ns1.oldhost.com 42', serial: 42 },
  records: { ...snapOf().records, MX: rec('ok', ['10 mail.example.com']) },
  subdomains: [{ name: 'webmail.example.com', records: { A: ['1.1.1.1'] } }],
};
const dRec = snapshot.diff(recoveredSnap, snapOf({ records: { MX: rec('nodata', []) } }));
ok(dRec.records.MX.state === 'dropped', 'a recovered baseline diffs exactly like a captured one');

let rf = dns.recoveryFindings(recoveredSnap, [
  { name: 'webmail.example.com', state: 'dropped', was: ['1.1.1.1'], now: [] },
  { name: 'shop.example.com', state: 'moved', was: ['1.1.1.1'], now: ['5.5.5.5'] },
  { name: 'www.example.com', state: 'intact', was: ['1.1.1.1'], now: ['1.1.1.1'] },
]);
ok(has(rf, 'DNS-027'), 'a live shadow zone is reported — the baseline is recoverable right now');
ok(rf.filter((x) => x.ruleId === 'DNS-026').length === 1, 'exactly the dropped subdomain is flagged, not the moved or intact ones');
ok(has(rf, 'DNS-028') && /not tested/.test(rf.find((x) => x.ruleId === 'DNS-028').detail),
  'the report states that names outside the probe list were never checked');
ok(dns.recoveryFindings(recoveredSnap, []).filter((x) => x.ruleId === 'DNS-028').length === 0,
  'no probe results = no coverage claim at all');

// The state machine that decides whether a hostname counts as lost, driven offline. This part is
// async, so it and the summary run inside an IIFE — a CommonJS module cannot use top-level await.
const fakeResolve = (map) => async (name) => ({
  host: name,
  records: {
    A: map[name] === 'unknown'
      ? { agreed: 'insufficient', status: null, values: [], failed: ['google'] }
      : { agreed: true, status: map[name] ? 'ok' : 'nodata', values: map[name] && map[name] !== 'unknown' ? map[name] : [] },
    CNAME: { agreed: true, status: 'nodata', values: [] },
  },
});
const subs = { subdomains: [
  { name: 'gone.example.com', records: { A: ['1.1.1.1'] } },
  { name: 'moved.example.com', records: { A: ['1.1.1.1'] } },
  { name: 'same.example.com', records: { A: ['1.1.1.1'] } },
  { name: 'murky.example.com', records: { A: ['1.1.1.1'] } },
] };
(async () => {
  const rows = await recover.compareSubdomains(subs, { resolveFn: fakeResolve({
    'gone.example.com': null, 'moved.example.com': ['5.5.5.5'], 'same.example.com': ['1.1.1.1'], 'murky.example.com': 'unknown',
  }) });
  const st = Object.fromEntries(rows.map((r) => [r.name.split('.')[0], r.state]));
  ok(st.gone === 'dropped', 'in the old zone, gone from the new = dropped');
  ok(st.moved === 'moved', 'resolving to a new address = moved, not dropped');
  ok(st.same === 'intact', 'same address on both = intact');
  ok(st.murky === 'unknown', 'a hostname we could not resolve is unknown — never reported as lost');

  // --- regressions found by a LIVE recover run, not by the offline suite above ------------------
  // Both shipped in 6.4.1 and both were invisible to 423 green assertions, because every fixture
  // here hands compareSubdomains an A record and every fixture skips queryZone entirely.

  // (1) A name the sweep recovered on TXT ALONE — _dmarc, _domainkey. Asking only A/CNAME for it
  // returns nothing, and empty-vs-empty scored DROPPED: a launch-BLOCKING DNS-026 against a DMARC
  // record that never moved. It fired on every domain that publishes DMARC.
  const fakeTxt = (map) => async (name, o) => ({
    host: name,
    records: {
      A: { agreed: true, status: 'nodata', values: [] },
      CNAME: { agreed: true, status: 'nodata', values: [] },
      TXT: { agreed: true, status: map[name] ? 'ok' : 'nodata', values: map[name] || [] },
    },
    types: (o && o.types) || [],
  });
  const dmarc = { subdomains: [{ name: '_dmarc.example.com', records: { TXT: ['v=DMARC1; p=reject'] } }] };
  const [kept] = await recover.compareSubdomains(dmarc, { resolveFn: fakeTxt({ '_dmarc.example.com': ['v=DMARC1; p=reject'] }) });
  ok(kept.state === 'intact', 'a TXT-only name still publishing the same value is intact, not dropped');
  ok(kept.was[0] === 'v=DMARC1; p=reject' && kept.now[0] === 'v=DMARC1; p=reject',
    'the TXT-only row carries the values it compared, so DNS-026 can never print empty parentheses');
  const [changedTxt] = await recover.compareSubdomains(dmarc, { resolveFn: fakeTxt({ '_dmarc.example.com': ['v=DMARC1; p=none'] }) });
  ok(changedTxt.state === 'moved', 'a TXT-only name whose value changed is moved');
  const [lostTxt] = await recover.compareSubdomains(dmarc, { resolveFn: fakeTxt({}) });
  ok(lostTxt.state === 'dropped', 'a TXT-only name that stopped answering IS dropped — the real signal survives');

  // (2) resolveSoa returns a bare object; wrapping it in an array yielded "undefined undefined
  // undefined" as the BEFORE half of the recovered-zone SOA diff on screen. resolve.js already
  // unwrapped it on the public-resolver path — recover.js's own path did not.
  const zone = await recover.queryZone('example.com', ['5.5.5.5'], ['SOA', 'NS'], {
    resolverFactory: () => ({
      resolveSoa: async () => ({ nsname: 'ns1.old.example.', hostmaster: 'hostmaster.old.example.', serial: 42 }),
      resolveNs: async () => ['ns1.old.example.'],
    }),
  });
  ok(zone.SOA.values[0] === 'ns1.old.example hostmaster.old.example 42',
    'the recovered zone reads SOA as one object, not an array — never "undefined undefined undefined"');
  ok(!/undefined/.test(zone.SOA.values.join('')), 'no SOA field renders as undefined');

  // -------------------------------------------------------------------------------------------
  S('§11 propagation, one read path, and an instruction instead of a verdict');
  // -------------------------------------------------------------------------------------------

  // --- ONE resolver read path. Two hand-rolled resolver→normalise call sites is how the SOA-shape
  // defect got fixed in resolve.js and shipped anyway in recover.js. readRecord is now the only
  // place that turns a node:dns reply into a record, so the shape can only be got wrong once.
  const stub = {
    resolveSoa: async () => ({ nsname: 'ns1.X.com.', hostmaster: 'a.X.com.', serial: 9 }),
    resolve4: async () => [{ address: '1.1.1.1', ttl: 300 }, { address: '0.0.0.0', ttl: 60 }],
    resolveMx: async () => [{ priority: 10, exchange: 'Mail.X.com.' }],
    resolveNs: async () => { const e = new Error('no'); e.code = 'ENODATA'; throw e; },
  };
  const soa = await resolve.readRecord(stub, 'x.com', 'SOA');
  ok(soa.values[0] === 'ns1.x.com a.x.com 9', 'readRecord unwraps the SOA object — the one shape that is not an array');
  const a4 = await resolve.readRecord(stub, 'x.com', 'A');
  ok(a4.values.join() === '0.0.0.0,1.1.1.1' && a4.ttl === 60, 'readRecord sorts addresses and keeps the LOWEST ttl');
  ok((await resolve.readRecord(stub, 'x.com', 'MX')).values[0] === '10 mail.x.com', 'readRecord normalises MX through the same path');
  ok((await resolve.readRecord(stub, 'x.com', 'NS')).status === 'nodata', 'ENODATA is "the type does not exist", never an error');
  // and recover's zone read is now that same function, not a copy of it
  const z = await recover.queryZone('x.com', ['5.5.5.5'], ['SOA'], { resolverFactory: () => stub });
  ok(z.SOA.values[0] === soa.values[0], 'the old-nameserver read and the public read produce byte-identical records');

  // --- PROPAGATION. Four resolvers disagreeing during a cutover is not a fault, it is the
  // measurement: it says how much of the internet has already moved. Reporting it as
  // "resolvers do not agree" told the operator their zone was broken at the exact moment it was
  // working correctly.
  const withResolvers = (values, by, extra = {}) => rec('ok', values, { byResolver: by, sample: Object.keys(by).length, ...extra });
  const OLD = ['1.1.1.1'], NEW = ['9.9.9.9'];
  const half = snapOf({ records: { A: withResolvers(NEW, {
    google: { status: 'ok', values: NEW, ttl: 300 }, cloudflare: { status: 'ok', values: NEW, ttl: 300 },
    quad9: { status: 'ok', values: OLD, ttl: 900 }, opendns: { status: 'ok', values: OLD, ttl: 900 },
  }, { agreed: false, variants: [{ status: 'ok', values: NEW, resolvers: ['google', 'cloudflare'] }, { status: 'ok', values: OLD, resolvers: ['quad9', 'opendns'] }] }) } });
  const base = snapOf({ records: { A: rec('ok', OLD) } });
  const p = dns.propagationOf(half, base);
  ok(p && p.percent === 50 && p.onNew === 2 && p.onOld === 2, 'propagation is a percentage of resolvers already serving the new address');
  ok(p.byResolver.google === 'new' && p.byResolver.quad9 === 'old', 'it names WHICH resolvers are still behind — that is who your stragglers are');
  ok(p.complete === false && p.ttl === 900, 'the straggler TTL is the one that decides when they catch up, not the fast camp\'s');
  const donePr = dns.propagationOf(snapOf({ records: { A: withResolvers(NEW, {
    google: { status: 'ok', values: NEW }, cloudflare: { status: 'ok', values: NEW },
    quad9: { status: 'ok', values: NEW }, opendns: { status: 'ok', values: NEW },
  }) } }), base);
  ok(donePr.percent === 100 && donePr.complete === true, 'every resolver on the new address = propagation complete');
  const unread = dns.propagationOf(snapOf({ records: { A: withResolvers(NEW, {
    google: { status: 'ok', values: NEW }, cloudflare: { status: 'ok', values: NEW },
    quad9: { status: 'error', values: [], error: 'ETIMEOUT' }, opendns: { status: 'error', values: [], error: 'ETIMEOUT' },
  }) } }), base);
  ok(unread.percent === 100 && unread.unknown === 2, 'a resolver that did not answer is EXCLUDED from the percentage and counted openly — never voted as agreement');
  ok(dns.propagationOf(half, null) === null, 'no baseline, no propagation claim');

  ok(has(dns.propagationFindings(p), 'DNS-030'), 'mid-flight propagation is reported');
  ok(dns.propagationFindings(donePr).length === 0, 'a finished cutover raises nothing — silence is the correct report');
  ok(dns.propagationFindings(dns.propagationOf(snapOf({ records: { A: withResolvers(OLD, {
    google: { status: 'ok', values: OLD }, cloudflare: { status: 'ok', values: OLD },
  }) } }), base)).length === 0, 'nothing moved yet is DNS-008\'s claim, not a propagation claim — never both');
  ok(dns.propagationFindings(p)[0].readiness !== 1, 'propagation in progress must NEVER block a cutover — it IS the cutover working');

  // --- and the split it explains is no longer ALSO reported as a fault
  const splitAlone = dns.commonFindings(half);
  ok(has(splitAlone, 'DNS-003'), 'an unexplained split is still a fault');
  const splitExplained = dns.commonFindings(half, { splitExplained: ['A'] });
  ok(!has(splitExplained, 'DNS-003'), 'the same split, explained by a cutover in progress, is not reported twice');
  const stillUnread = dns.commonFindings(snapOf({ records: { A: rec('ok', OLD, { agreed: 'insufficient', failed: ['google', 'quad9'] }) } }), { splitExplained: ['A'] });
  ok(has(stillUnread, 'DNS-003'), 'a record we could not READ is a different claim, and stays reported whatever the cutover is doing');

  // --- AN INSTRUCTION, NOT A STATE. "BLOCKED — 1 launch-blocking finding" tells an operator
  // mid-cutover nothing about what to do with their hands.
  const blocked = dns.verdictOf(half, [dns.F('DNS-004', 'MX gone', 'example.com', '')], true);
  ok(/^Restore the MX/.test(blocked.next), 'the verdict names the ONE next action, taken from the worst finding');
  const midflight = dns.verdictOf(half, [], true, { propagation: p });
  ok(/recheck/i.test(midflight.next) && /15m/.test(midflight.next),
    'clean but mid-flight = do nothing, come back when the slowest cache expires (and it says when)');
  ok(/2 of 4/.test(midflight.next), 'it states how far along the cutover is, in resolvers');
  ok(/Capture a baseline/i.test(dns.verdictOf(half, [], false).next), 'no baseline = the next action is to make one');
  const notStarted = dns.propagationOf(snapOf({ records: { A: withResolvers(OLD, {
    google: { status: 'ok', values: OLD }, cloudflare: { status: 'ok', values: OLD },
  }) } }), base);
  ok(/[Nn]othing has (been repointed|moved)/.test(dns.verdictOf(half, [], true, { propagation: notStarted }).next),
    'every resolver still on the baseline address must not be congratulated as a finished cutover');
  ok(dns.verdictOf(half, [], true, { propagation: donePr }).next.length > 0, 'a finished cutover still says what to do next');

  ok(resolve.humanDuration(8382) === '2h 20m' && resolve.humanDuration(300) === '5m' && resolve.humanDuration(45) === '45s',
    'seconds are rendered the way a person reads a clock');
  const ttlF = dns.preCutoverFindings(snapOf({ records: { A: rec('ok', OLD, { ttl: 8382 }) } })).find((x) => x.ruleId === 'DNS-012');
  ok(ttlF && /2h 20m/.test(ttlF.detail) && /[Ll]ower it/.test(ttlF.detail),
    'the TTL finding gives the duration in human units AND the instruction, not just a number');

  // --- MAIL hosts in the sweep. The module exists because a migration takes email down; the sweep
  // asked for A/CNAME only, so a mail host that lost its MX came back "intact".
  ok(recover.MAIL_LABELS.every((l) => recover.COMMON.includes(l)), 'every mail label is a probed label');
  ok(['mail', 'smtp', 'mx'].every((l) => recover.MAIL_LABELS.includes(l)), 'the hosts that carry inbound mail are covered');
  const fakeMx = (map) => async (name) => ({ host: name, records: {
    A: { agreed: true, status: 'nodata', values: [] }, CNAME: { agreed: true, status: 'nodata', values: [] },
    MX: { agreed: true, status: map[name] ? 'ok' : 'nodata', values: map[name] || [] },
  } });
  const mailZone = { subdomains: [{ name: 'mail.example.com', records: { MX: ['10 old.mail.example.com'] } }] };
  ok((await recover.compareSubdomains(mailZone, { resolveFn: fakeMx({ 'mail.example.com': ['10 old.mail.example.com'] }) }))[0].state === 'intact',
    'a mail host still publishing the same MX is intact');
  ok((await recover.compareSubdomains(mailZone, { resolveFn: fakeMx({}) }))[0].state === 'dropped',
    'a mail host whose MX vanished in the migration is REPORTED — this is the failure the tool was built for');

  // THE REAL SHAPE OF THAT FAILURE: mail.example.com keeps its A record (the new host answers on
  // :443 quite happily) and silently loses the MX. Comparing addresses alone calls that "intact" and
  // the report is green while mail bounces. The address and the mail route are separate claims.
  const fakeBoth = (mx) => async (name, o) => ({ host: name, records: {
    A: { agreed: true, status: 'ok', values: ['9.9.9.9'] }, CNAME: { agreed: true, status: 'nodata', values: [] },
    MX: { agreed: true, status: mx ? 'ok' : 'nodata', values: mx || [] },
  }, types: (o && o.types) || [] });
  const mailHost = { subdomains: [{ name: 'mail.example.com', records: { A: ['1.1.1.1'], MX: ['10 old.mail.example.com'] } }] };
  const bothMoved = (await recover.compareSubdomains(mailHost, { resolveFn: fakeBoth(['10 new.mail.example.com']) }))[0];
  ok(bothMoved.state === 'moved' && bothMoved.mx && bothMoved.mx.state === 'moved', 'a mail host that moved BOTH its address and its MX is reported on both');
  const lost = (await recover.compareSubdomains(mailHost, { resolveFn: fakeBoth(null) }))[0];
  ok(lost.state === 'moved' && lost.mx.state === 'dropped', 'an address that survived does NOT excuse an MX that did not');
  ok(has(dns.recoveryFindings({ host: 'example.com', recoveredFrom: {}, subdomains: [] }, [lost]), 'DNS-031'),
    'losing the mail route on a surviving host raises its own finding — inbound mail to it bounces');
  ok(dns.recoveryFindings({ host: 'example.com', recoveredFrom: {}, subdomains: [] }, [lost]).find((x) => x.ruleId === 'DNS-031').readiness === 1,
    'and it blocks the cutover, because bounced mail is not recoverable after the fact');

  const addr = await recover.nsAddresses(['5.5.5.5', ' ']);
  ok(addr.length === 1 && addr[0].ip === '5.5.5.5', 'a nameserver given as a literal address needs no lookup');
  ok(recover.COMMON.includes('webmail') && recover.COMMON.includes('autodiscover') && recover.COMMON.includes('cpanel'),
    'the probe list covers the hostnames that break a business when they vanish');
  ok(new Set(recover.COMMON).size === recover.COMMON.length, 'no duplicate probes');

  // -------------------------------------------------------------------------------------------
  // OUTPUT FORMAT IS THE CONTRACT, not the exit code. run-all.js decides pass/fail by matching
  // `✅ PASS`/`PASS ·` in stdout and reads the count out of "N/M assertions" — it never looks at the
  // status code. This suite first shipped printing "✓ dns: 423 passed, 0 failed": exit 0, every
  // assertion green, and the aggregate run marked it FAILED with a blank count. Keep this line in
  // the house format, and never print ❌ on a clean run (the regex vetoes on it).
  if (fail) {
    console.log(`\n❌ FAIL · ${pass}/${pass + fail} assertions`);
    console.log('\nfailures:'); failures.forEach((f) => console.log('  · ' + f));
  } else {
    console.log(`\n✅ PASS · ${pass}/${pass + fail} assertions`);
  }
  process.exit(fail ? 1 : 0);
})();
