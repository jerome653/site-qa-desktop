'use strict';
// dns/recover.js — rebuild a baseline AFTER the cutover, from the nameservers that were replaced.
//
// THE OBSERVATION THIS IS BUILT ON (credit: the Zone Recon tool, which is where it came from):
// when a domain's delegation moves, the OLD nameservers usually keep serving the OLD zone. Nothing
// deletes it. No resolver asks them anymore, because the parent zone now points elsewhere — but
// query them DIRECTLY, by address, and they still answer authoritatively with the pre-migration
// data. That shadow zone survives until the old host garbage-collects it, which is typically weeks.
//
// WHY THAT MATTERS HERE: snapshot.capture() is honest but demands foresight — it only helps someone
// who thought about DNS before the cutover, which is nearly nobody. This module recovers the same
// baseline retroactively, so the whole diff (dropped MX, dropped SPF, lost subdomains) becomes
// available on a migration that is already done and already broken. That is the case people
// actually bring you.
//
// AND THE PART A PRE-CAPTURE MISSES ENTIRELY: the old zone lists SUBDOMAINS. mail, webmail, ftp,
// cpanel, shop, staging, autodiscover — hostnames nobody remembers exist until they stop working.
// Only the zone knows the full set, so only the zone can tell you what the migration left behind.
//
// TWO LIMITS, STATED RATHER THAN PAPERED OVER:
//
//  1. THIS IS NOT A TIME MACHINE. It reads what the old nameservers say TODAY. If someone edited
//     the old zone after the cutover, or the host has already purged it, the recovered baseline is
//     wrong in a way nothing here can detect. Every snapshot this module produces is stamped
//     source:'recovered' precisely so no report can present it as a genuine pre-cutover capture.
//
//  2. SUBDOMAIN DISCOVERY IS A PROBE LIST, NOT AN ENUMERATION. AXFR (a real zone transfer, which
//     would return the complete zone exactly) needs a raw TCP DNS implementation node:dns does not
//     have, and is refused by almost every server anyway. So this walks a list of common names.
//     Absence from the result means "not in the list or not present" — never "the zone has no other
//     subdomains", and findings() must never phrase it that way.

const { Resolver } = require('node:dns').promises;
const { resolveAll } = require('./resolve');
const snapshot = require('./snapshot');

// Deliberately short and boring. These are the names that break a business when they vanish —
// mail routing, webmail, control panels, autodiscovery, and the staging/shop hosts that were never
// in anybody's migration checklist. A 10,000-word brute-force list would take minutes, hammer a
// third party's nameserver, and find mostly nothing.
const COMMON = [
  'www', 'mail', 'webmail', 'smtp', 'imap', 'pop', 'mx', 'mx1', 'mx2', 'email',
  'autodiscover', 'autoconfig', '_dmarc',
  'ftp', 'sftp', 'cpanel', 'whm', 'webdisk', 'plesk', 'panel', 'admin', 'portal',
  'api', 'app', 'apps', 'dev', 'test', 'staging', 'stage', 'demo', 'beta', 'old', 'legacy',
  'blog', 'shop', 'store', 'cart', 'checkout', 'pay', 'billing',
  'cdn', 'static', 'assets', 'img', 'images', 'media', 'files', 'download',
  'docs', 'help', 'support', 'kb', 'status', 'forum', 'community',
  'crm', 'erp', 'intranet', 'vpn', 'remote', 'git', 'ci', 'jenkins',
  'm', 'mobile', 'news', 'events', 'jobs', 'careers', 'secure', 'sso', 'auth', 'login',
  'dashboard', 'my', 'client', 'clients', 'partner', 'video', 'wiki', 'calendar', 'cloud',
];

const CONCURRENCY = 8; // polite: this is someone else's authoritative server, and it is not ours to load-test

// ---------------------------------------------------------------------------------------------
// pointing a resolver at the old nameservers
// ---------------------------------------------------------------------------------------------
// The old NS hostnames are resolved through the PUBLIC resolvers first, because the whole premise
// is that nothing delegates to them anymore — asking them to resolve themselves is circular. Once
// we have addresses, every subsequent query goes straight to those addresses.
async function nsAddresses(nameservers, opts = {}) {
  const out = [];
  for (const ns of nameservers) {
    const n = String(ns).trim().toLowerCase().replace(/\.$/, '');
    if (!n) continue;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(n) || n.includes(':')) { out.push({ ns: n, ip: n }); continue; }
    const r = await resolveAll(n, { ...opts, types: ['A'] });
    const ips = r.records.A && r.records.A.status === 'ok' ? r.records.A.values : [];
    if (!ips.length) out.push({ ns: n, ip: null, error: 'nameserver hostname does not resolve' });
    else ips.forEach((ip) => out.push({ ns: n, ip }));
  }
  return out;
}

function resolverFor(ips, opts = {}) {
  const r = new Resolver({ timeout: opts.timeout || 5000, tries: opts.tries || 2 });
  r.setServers(ips);
  return r;
}

// Is the shadow zone actually there? SOA is the test: an authoritative server answers SOA for the
// zones it holds and refuses (or returns nothing) for zones it does not. Without this check the
// module could "recover" an empty baseline from a server that simply never had the zone, and an
// empty baseline diffs as "everything was dropped" — the most alarming possible false report.
async function probeShadowZone(domain, ips, opts = {}) {
  const r = resolverFor(ips, opts);
  try {
    const soa = await r.resolveSoa(domain);
    return { live: true, soa: `${String(soa.nsname).toLowerCase().replace(/\.$/, '')} ${soa.serial}`, serial: soa.serial };
  } catch (e) {
    return { live: false, error: (e && e.code) || String(e) };
  }
}

// ---------------------------------------------------------------------------------------------
// recover
// ---------------------------------------------------------------------------------------------
// Produces a snapshot in the SAME schema snapshot.capture() writes, so verify() can diff against it
// with no special-casing anywhere downstream — except for the `source` stamp, which every renderer
// must show.
//
// Note what is NOT done here: no live/HTTP probing of the recovered records. The addresses in a
// shadow zone are the OLD origin, and hitting them is probeLegacy()'s job during verification,
// where the result has a current state to be meaningful against.
async function recover(domain, nameservers, opts = {}) {
  const apex = snapshot.apexOf(domain);
  const servers = await nsAddresses(nameservers, opts);
  const ips = servers.filter((s) => s.ip).map((s) => s.ip);
  if (!ips.length) {
    return { ok: false, host: apex, servers, error: 'none of the supplied nameservers resolved to an address' };
  }

  const zone = await probeShadowZone(apex, ips, opts);
  if (!zone.live) {
    // A hard stop, not a warning. See probeShadowZone(): continuing here would manufacture a
    // baseline of "nothing", and every record on the live domain would then diff as ADDED while
    // every record the real old zone held would be invisible.
    return { ok: false, host: apex, servers, zone, error: `the supplied nameservers are not authoritative for ${apex} (${zone.error}) — nothing to recover` };
  }

  const at = opts.now || new Date().toISOString();
  const [apexRec, wwwRec, dmarcRec] = await Promise.all([
    queryZone(apex, ips, ['A', 'AAAA', 'CNAME', 'NS', 'MX', 'TXT', 'CAA', 'SOA'], opts),
    queryZone(`www.${apex}`, ips, ['A', 'AAAA', 'CNAME'], opts),
    queryZone(`_dmarc.${apex}`, ips, ['TXT'], opts),
  ]);

  const subdomains = opts.subdomains === false ? [] : await sweepSubdomains(apex, ips, opts);

  const snap = {
    schema: snapshot.SCHEMA,
    host: apex,
    capturedAt: at,
    // The stamp that keeps this honest everywhere downstream. A recovered baseline is evidence of
    // what the old nameservers hold NOW, which is usually — but not provably — what they held at
    // cutover.
    source: 'recovered',
    recoveredFrom: { nameservers: servers, soa: zone.soa, serial: zone.serial },
    resolvers: servers.filter((s) => s.ip).map((s) => `${s.ns} (${s.ip})`),
    records: apexRec,
    www: wwwRec,
    dmarc: dmarcRec.TXT,
    cnameTarget: null,
    subdomains,
    live: null,
  };
  return { ok: true, host: apex, zone, snapshot: snap, servers };
}

// Records are shaped exactly like resolve.js's consensus output so the diff engine cannot tell the
// difference. `agreed` is true because there is only one authority being asked — that is not a
// multi-resolver vote and must not be dressed up as one, which is why `sample` reports the real
// number of servers queried.
async function queryZone(name, ips, types, opts = {}) {
  const r = resolverFor(ips, opts);
  const method = { A: 'resolve4', AAAA: 'resolve6', CNAME: 'resolveCname', NS: 'resolveNs', MX: 'resolveMx', TXT: 'resolveTxt', CAA: 'resolveCaa', SOA: 'resolveSoa' };
  const { normalise, classifyError } = require('./resolve');
  const out = {};
  await Promise.all(types.map(async (t) => {
    try {
      const raw = await r[method[t]](name);
      const arr = Array.isArray(raw) ? raw : [raw];
      out[t] = { agreed: true, status: arr.length ? 'ok' : 'nodata', values: arr.length ? normalise(t, arr) : [], ttl: null, variants: [], failed: [], sample: ips.length, byResolver: {}, authoritative: true };
    } catch (e) {
      const status = classifyError(e);
      out[t] = { agreed: true, status, values: [], ttl: null, variants: [], failed: [], sample: ips.length, byResolver: {}, authoritative: true, error: (e && e.code) || String(e) };
    }
  }));
  return out;
}

// ---------------------------------------------------------------------------------------------
// subdomain sweep
// ---------------------------------------------------------------------------------------------
async function sweepSubdomains(apex, ips, opts = {}) {
  const list = opts.wordlist || COMMON;
  const r = resolverFor(ips, opts);
  const found = [];
  let i = 0;
  const worker = async () => {
    while (i < list.length) {
      const label = list[i++];
      const name = `${label}.${apex}`;
      const rec = {};
      for (const [t, m] of [['A', 'resolve4'], ['CNAME', 'resolveCname'], ['TXT', 'resolveTxt']]) {
        // TXT only for the names where it carries policy; probing it everywhere triples the query
        // count for no signal.
        if (t === 'TXT' && !/^_dmarc$|^_domainkey$/.test(label)) continue;
        try {
          const raw = await r[m](name);
          if (raw && raw.length) rec[t] = require('./resolve').normalise(t, raw);
        } catch (_) { /* absent or unanswerable — not a finding, just not present */ }
      }
      if (Object.keys(rec).length) found.push({ name, records: rec });
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, list.length) }, worker));
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------------------------
// which recovered hostnames no longer work
// ---------------------------------------------------------------------------------------------
// The payoff. For every subdomain the old zone still knows about, ask the PUBLIC resolvers whether
// it resolves today. The ones that do not are hostnames the migration silently dropped.
//
// Deliberately reports three states, because "does not resolve" and "we could not tell" are not the
// same claim and only one of them is a defect:
//   dropped  · the old zone has it, public DNS returns NXDOMAIN/nodata for it
//   moved    · resolves today, but to a different address than the old zone held (expected)
//   intact   · resolves today to an address the old zone also held
// `opts.resolveFn` exists so this can be driven offline in the tests. The state machine below is
// the part that decides whether a hostname is reported as lost, and a rule that important must be
// provable without depending on what the live internet happens to be doing.
async function compareSubdomains(recovered, opts = {}) {
  const lookup = opts.resolveFn || resolveAll;
  const rows = [];
  for (const sub of recovered.subdomains || []) {
    const cur = await lookup(sub.name, { ...opts, types: ['A', 'CNAME'] });
    const nowA = cur.records.A && cur.records.A.status === 'ok' ? cur.records.A.values : [];
    const nowC = cur.records.CNAME && cur.records.CNAME.status === 'ok' ? cur.records.CNAME.values : [];
    const unresolved = (cur.records.A && cur.records.A.agreed === 'insufficient');
    const oldA = sub.records.A || [];
    let state;
    if (unresolved) state = 'unknown';
    else if (!nowA.length && !nowC.length) state = 'dropped';
    else if (oldA.length && nowA.some((ip) => oldA.includes(ip))) state = 'intact';
    else state = 'moved';
    rows.push({ name: sub.name, state, was: oldA.length ? oldA : (sub.records.CNAME || []), now: nowA.length ? nowA : nowC });
  }
  return rows;
}

module.exports = { recover, compareSubdomains, sweepSubdomains, probeShadowZone, nsAddresses, queryZone, COMMON };
