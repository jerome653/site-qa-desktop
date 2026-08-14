'use strict';
// dns/rules.js — the DNS rule set. Same field shape as site-qa/rules/registry.js so this block can
// be merged into the main registry as Suite 15 without reshaping anything.
//
// SCORE-NEUTRAL BY CONSTRUCTION. Every rule here is severity 'manual' and the suite carries
// WEIGHT 0 — the same two independent mechanisms that keep best-practices (1.2.0), visual (1.3.0),
// copy (1.13.0) and discovery (1.15.0) out of the SGEN Quality Score. That is not timidity, it is
// correctness: a Site Audit is routinely run against a domain the operator does NOT control, and a
// scored DNS suite would deduct points for someone else's nameservers on every such run. It would
// also make the score depend on the auditing machine's network path, which no score may do.
//
// SEVERITY here classifies the incident for a human. `impact` is the plain-language consequence,
// because "MX dropped" is jargon and "inbound email to this domain will bounce" is the finding.
//
// WHY `readiness` AND NOT `tier`. The registry's own invariant, enforced by registry.test.js, is
// that a manual rule carries tier null — tier drives the launch-readiness VETO, and a rule that
// cannot be scored must not be able to veto. Every rule here is manual, so every rule here would
// have to be tier null, which would throw away the one thing worth ranking: whether the cutover is
// broken right now. So the ranking is carried in its own field. Same three levels, no collision
// with the veto layer, and this block stays mergeable into registry.js unchanged:
//   1 = the cutover is broken or is about to break something · 2 = hurts users · 3 = hygiene

const R = (id, slug, title, category, severity, impact, extra = {}) => ({
  id, slug, title,
  suite: 'dns',
  category,
  severity: 'manual',      // constitutional: nothing in this suite may move the score
  reported: severity,      // the severity a human should read it at
  deduction: 0,
  method: extra.method || 'network',
  deterministic: true,
  manual: true,
  autofix: false,
  introduced: '1.16.0',
  impact,
  tier: null,              // constitutional: manual ⇒ tier null (registry.test.js)
  readiness: extra.readiness || null,
  docs: `/docs/rules/${id.toLowerCase()}`,
  ...extra,
  ...(extra.tier != null ? { tier: null } : {}), // never let an extra re-introduce a tier
});

const RULES = [
  // ---------------- resolution ----------------
  R('DNS-001', 'nxdomain', 'Domain does not resolve', 'resolution', 'critical',
    'No resolver can find this name. The site is unreachable for everyone, not just for you.', { readiness: 1 }),
  R('DNS-002', 'no-address-record', 'No A or AAAA record', 'resolution', 'critical',
    'The zone exists but publishes no address, so browsers have nowhere to connect.', { readiness: 1 }),
  R('DNS-003', 'resolver-disagreement', 'Resolvers disagree on this record', 'resolution', 'high',
    'Propagation is still in flight or a resolver holds a different view: some visitors reach the new server, others the old one.', { readiness: 1 }),
  R('DNS-022', 'dangling-cname', 'CNAME target does not resolve', 'resolution', 'high',
    'The alias points at a name that no longer exists — the site is broken, and if the target host is claimable this is a subdomain-takeover risk.', { readiness: 1 }),
  R('DNS-013', 'cname-at-apex', 'CNAME on the bare domain', 'resolution', 'medium',
    'A CNAME at the apex is invalid unless the DNS provider flattens it (ALIAS/ANAME). On a provider that does not, mail and other records at the apex break.', { readiness: 2 }),

  // ---------------- cutover (baseline diff) ----------------
  R('DNS-004', 'mx-dropped', 'MX records disappeared since the baseline', 'cutover', 'critical',
    'Inbound email to this domain will bounce. Moving a website never requires changing MX — this is almost always a nameserver swap that did not carry the mail records across.', { readiness: 1, method: 'engine' }),
  R('DNS-005', 'spf-dropped', 'SPF record disappeared since the baseline', 'cutover', 'critical',
    'Outbound mail from this domain will start landing in spam or being rejected, and the domain becomes spoofable.', { readiness: 1, method: 'engine' }),
  R('DNS-006', 'dmarc-dropped', 'DMARC record disappeared since the baseline', 'cutover', 'high',
    'The domain loses its published anti-spoofing policy and its reporting feed.', { readiness: 2, method: 'engine' }),
  R('DNS-020', 'txt-dropped', 'TXT record(s) removed since the baseline', 'cutover', 'high',
    'Verification tokens live in TXT records — removing them can silently un-verify a domain in Google, Microsoft or a mail provider.', { readiness: 2, method: 'engine' }),
  R('DNS-007', 'ns-changed', 'Nameservers changed since the baseline', 'cutover', 'high',
    'The whole zone moved. Every record now comes from a new provider, so anything not re-created there is gone — check this finding before any other DNS finding.', { readiness: 1, method: 'engine' }),
  R('DNS-021', 'soa-changed', 'Zone authority (SOA) changed since the baseline', 'cutover', 'low',
    'Confirms the zone was re-published or re-hosted. Informational context for the other findings.', { readiness: 3, method: 'engine' }),
  R('DNS-008', 'address-unchanged', 'Address record is unchanged since the baseline', 'cutover', 'high',
    'The cutover has not taken effect: this name still points at the address recorded before the migration.', { readiness: 1, method: 'engine' }),
  R('DNS-009', 'address-off-target', 'Address does not match the expected target', 'cutover', 'critical',
    'The record changed, but not to the address the migration was supposed to point at.', { readiness: 1, method: 'engine' }),
  R('DNS-018', 'legacy-origin-live', 'The previous server still answers for this domain', 'cutover', 'high',
    'Anyone still holding the old address — caches, corporate resolvers, mobile networks — is being served a live copy of the old site. Form posts and logins are landing on a machine nobody is watching.', { readiness: 1 }),
  R('DNS-019', 'content-matches-baseline', 'Served content is identical to the baseline', 'cutover', 'medium',
    'Cannot be settled automatically: either the migration is faithful, or the new address is still serving the old site. Confirm by hand.', { readiness: null, method: 'manual' }),

  // ---------------- coverage ----------------
  R('DNS-010', 'apex-www-split', 'The bare domain and www resolve to different origins', 'coverage', 'high',
    'Half the links to this site reach one server and half reach another. Whichever is stale will keep serving old pages indefinitely.', { readiness: 1 }),
  R('DNS-011', 'www-missing', 'www does not resolve', 'coverage', 'high',
    'Every existing inbound link, bookmark and search result using www fails outright.', { readiness: 1 }),
  R('DNS-012', 'ttl-too-high-for-cutover', 'TTL is too high for a planned cutover', 'coverage', 'medium',
    'Resolvers may cache the old address for this long after the change. Lower the TTL to 300s at least a full old-TTL before cutover day.', { readiness: 2 }),

  // ---------------- serving ----------------
  R('DNS-015', 'resolves-but-dead', 'Resolves, but nothing answers at that address', 'serving', 'critical',
    'DNS is correct and the origin is silent. The site is down: firewall, wrong server, or the vhost was never created.', { readiness: 1 }),
  R('DNS-023', 'partial-origin', 'Only some addresses are serving the site', 'serving', 'high',
    'A round-robin set with a dead member. Visitors are randomly assigned, so it looks healthy to anyone who tests once.', { readiness: 1 }),
  R('DNS-016', 'cert-does-not-cover-name', 'TLS certificate does not cover this name', 'serving', 'critical',
    'Browsers show a full-page security warning. Common cause: a wildcard certificate that covers www but not the bare domain.', { readiness: 1, method: 'cert' }),
  R('DNS-017', 'cert-expiring', 'TLS certificate expired or expiring soon', 'serving', 'high',
    'The site becomes unreachable in every browser the moment it expires.', { readiness: 1, method: 'cert' }),
  R('DNS-014', 'caa-blocks-issuer', 'CAA record does not permit the certificate issuer', 'serving', 'high',
    'Certificate renewal will fail even though DNS looks correct — the classic cause of "the domain is connected but HTTPS never turns on".', { readiness: 1 }),
  R('DNS-024', 'redirect-off-domain', 'The domain only redirects elsewhere', 'serving', 'medium',
    'Nothing is hosted here — the name forwards away. Correct for a parked domain, a broken migration for anything else.', { readiness: 2 }),

  // ---------------- recovered zone (see recover.js) ----------------
  R('DNS-026', 'subdomain-dropped', 'Subdomain from the old zone no longer resolves', 'cutover', 'high',
    'A hostname the old zone still publishes has no record on the new nameservers. Mail hosts, webmail, control panels and shop subdomains are the usual casualties — they break silently because nobody remembers they existed.', { readiness: 1, method: 'engine' }),
  R('DNS-027', 'shadow-zone-live', 'The old nameservers still serve this zone', 'cutover', 'medium',
    'The pre-migration zone is still recoverable — take the baseline now, before the old host deletes it. It is also a loose end: that data stays answerable to anyone who queries those servers directly.', { readiness: 3 }),
  R('DNS-028', 'subdomain-scan-not-exhaustive', 'Subdomain recovery is a probe list, not a full zone transfer', 'cutover', 'low',
    'Only common hostnames were probed. A zone transfer would return the zone exactly, but is refused by virtually every server — so absence from this report is not proof a subdomain did not exist.', { readiness: null, method: 'manual' }),

  // ---------------- unverifiable, stated as such ----------------
  R('DNS-029', 'address-not-testable-here', 'Some addresses could not be probed from this machine', 'serving', 'low',
    'Usually an IPv6 address on a host with no IPv6 route. These were excluded from the serving verdict rather than counted as failures — a limit of the auditing machine is not a defect of the site — but it does mean those addresses are unverified.', { readiness: null, method: 'manual' }),

  R('DNS-031', 'subdomain-mx-dropped', 'A surviving hostname lost its mail route', 'cutover', 'critical',
    'The hostname still resolves, so an address check calls it healthy — but the MX records the old zone published for it are gone, and mail addressed to it bounces. This is the failure a website migration causes most often and notices last.', { readiness: 1, method: 'engine' }),

  // ---------------- the cutover, measured rather than judged ----------------
  R('DNS-030', 'propagation-in-progress', 'The new address is live on some resolvers and not others', 'cutover', 'low',
    'Not a fault — this IS a cutover working. Public resolvers cache independently, so a repoint reaches them at different times, and the split says how much of the internet has already moved. Everyone still on the old address keeps landing on the old server until their cache expires, which is why the old server stays up until then.', { readiness: 3 }),

  R('DNS-025', 'dkim-not-verifiable', 'DKIM could not be checked', 'cutover', 'low',
    'DKIM keys live at a selector name chosen by the mail provider and cannot be discovered from DNS. Verify by hand that the selector records survived the move.', { readiness: null, method: 'manual' }),
];

const BY_ID = new Map(RULES.map((r) => [r.id, r]));
const BY_SLUG = new Map(RULES.map((r) => [r.slug, r]));
const getById = (id) => BY_ID.get(id) || null;
const getBySlug = (slug) => BY_SLUG.get(slug) || null;

// Suite descriptor, shaped for site-qa/audit.js SUITES. `advisory: true` is what keeps it out of
// scoring alongside best-practices and discovery.
const SUITE = { key: 'dns', name: 'DNS & Cutover', desc: 'records · propagation · cert · origin is live', icon: 'globe', advisory: true };

module.exports = { RULES, BY_ID, BY_SLUG, getById, getBySlug, SUITE, WEIGHT: 0 };
