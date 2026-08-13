'use strict';
// dns/resolve.js — deterministic, multi-resolver DNS reads. Zero dependencies (node:dns only).
//
// WHY THIS EXISTS AT ALL: every other check in this engine begins AFTER the name has already
// resolved. `https-enforce`, `404-config`, `robots-txt` and the whole crawl take a hostname that
// works and audit what it serves. A migration's most expensive failures happen one layer BELOW
// that — the zone itself — and are invisible from HTTP: a nameserver swap that silently drops MX
// and SPF takes email down while every page still scores 100.
//
// THREE RULES THIS MODULE REFUSES TO BREAK
//
// 1. NEVER USE THE SYSTEM RESOLVER. dns.resolve*() without setServers() asks whatever the machine
//    is configured to ask — a corporate forwarder, a VPN split-horizon view, a router that
//    NXDOMAIN-hijacks, a stale local cache. Every one of those makes the tool authoritative about
//    Jerome's laptop instead of about the internet. We ask named public resolvers explicitly and
//    report per-resolver, so "it works on my machine" is a visible data point rather than the
//    silent basis of the verdict.
//
// 2. ENODATA IS NOT ENOTFOUND. undici and most wrappers flatten both into "lookup failed". They are
//    opposite facts: ENODATA = the zone exists and has no record of this type (an MX record was
//    DELETED — the migration disaster this module was written for); ENOTFOUND = the name does not
//    exist at all. Collapsing them turns the single most important finding here into noise.
//
// 3. A FAILED READ IS NOT A DISAGREEMENT. If one resolver times out, that is missing evidence, not
//    evidence of split propagation. Consensus is computed over resolvers that returned a DEFINITIVE
//    answer; a timeout subtracts from the sample size and is reported, never voted.

const { Resolver } = require('node:dns').promises;

// Four independent operators, four distinct anycast networks. Not four addresses of one vendor:
// the entire point is that they can disagree, which is how partial propagation becomes visible.
const RESOLVERS = [
  { name: 'google', ip: '8.8.8.8' },
  { name: 'cloudflare', ip: '1.1.1.1' },
  { name: 'quad9', ip: '9.9.9.9' },
  { name: 'opendns', ip: '208.67.222.222' },
];

const TYPES = ['A', 'AAAA', 'CNAME', 'NS', 'MX', 'TXT', 'CAA', 'SOA'];

const DEFAULT_TIMEOUT = 5000;
const DEFAULT_TRIES = 2;

// ---------------------------------------------------------------------------------------------
// normalisation
// ---------------------------------------------------------------------------------------------
// Every record type collapses to a SORTED ARRAY OF STRINGS. Two reasons, both load-bearing:
//   · DNS answer order is deliberately unstable (round-robin rotation per query). Without sorting,
//     a re-read of an UNCHANGED zone diffs as changed, and a diff that cries wolf gets ignored on
//     the one day it matters.
//   · The diff, the consensus grouping and the on-disk snapshot then share one comparable shape,
//     so none of them can drift apart in how they decide "same".
const lower = (s) => String(s).toLowerCase();
const unroot = (s) => lower(s).replace(/\.$/, ''); // trailing-dot form is the same name

function normalise(type, raw) {
  switch (type) {
    case 'A':
    case 'AAAA':
      // resolve4/6 with {ttl:true} yields [{address, ttl}]; without it, bare strings.
      return raw.map((r) => (typeof r === 'string' ? r : r.address)).sort();
    case 'CNAME':
    case 'NS':
      return raw.map(unroot).sort();
    case 'MX':
      // Priority is part of the record's meaning — a provider swap that keeps the same hosts but
      // reorders priority changes which server receives mail first.
      return raw.map((r) => `${r.priority} ${unroot(r.exchange)}`).sort();
    case 'TXT':
      // resolveTxt returns chunk arrays: a >255-char record arrives split. Joining with '' is the
      // spec-correct reassembly — a long DKIM or SPF value is ONE string, and comparing the chunk
      // boundaries instead would diff on the provider's chunking, not on the value.
      return raw.map((chunks) => (Array.isArray(chunks) ? chunks.join('') : String(chunks))).sort();
    case 'CAA':
      // {critical, issue|issuewild|iodef}. Emit "issue letsencrypt.org" style so the issuer is
      // directly greppable by the CAA-vs-cert rule downstream.
      return raw
        .map((r) => {
          const tag = ['issue', 'issuewild', 'iodef'].find((t) => r[t] != null);
          return `${r.critical ? 'critical ' : ''}${tag || '?'} ${lower(r[tag] || '')}`.trim();
        })
        .sort();
    case 'SOA':
      // One object, not an array. Serial is the zone's version counter: it is the cheapest proof
      // that a zone was actually re-published rather than merely re-read.
      return [`${unroot(raw.nsname)} ${unroot(raw.hostmaster)} ${raw.serial}`];
    default:
      return raw.map(String).sort();
  }
}

// Status vocabulary. Four values, each a DIFFERENT fact — see rule 2 in the header.
//   ok       · the zone answered with at least one record of this type
//   nodata   · the zone exists, this record type does not (deleted MX lands here)
//   nxdomain · the name itself does not exist
//   error    · we failed to find out (timeout / refused / servfail) — NOT a fact about the zone
function classifyError(e) {
  const c = e && e.code;
  if (c === 'ENODATA') return 'nodata';
  if (c === 'ENOTFOUND' || c === 'NXDOMAIN') return 'nxdomain';
  return 'error';
}

async function queryOne(resolver, host, type) {
  const method = {
    A: 'resolve4', AAAA: 'resolve6', CNAME: 'resolveCname', NS: 'resolveNs',
    MX: 'resolveMx', TXT: 'resolveTxt', CAA: 'resolveCaa', SOA: 'resolveSoa',
  }[type];
  try {
    // TTL is only obtainable for A/AAAA through node:dns. Requesting it for the others is not
    // possible without a raw wire-format query, so those records carry ttl:null and the TTL rule
    // reports them as unknown rather than inventing a number. Silence beats a plausible guess.
    const wantsTtl = type === 'A' || type === 'AAAA';
    const raw = await (wantsTtl ? resolver[method](host, { ttl: true }) : resolver[method](host));
    // resolveSoa returns a bare OBJECT, every other method an array. Wrapping the object in an
    // array and handing that to normalise() produced "undefined undefined undefined" for every SOA
    // on the first live run — the shape has to be unwrapped here, not guessed at downstream.
    if (type === 'SOA') {
      return raw ? { status: 'ok', values: normalise('SOA', raw), ttl: null } : { status: 'nodata', values: [], ttl: null };
    }
    const arr = Array.isArray(raw) ? raw : [raw];
    if (!arr.length) return { status: 'nodata', values: [], ttl: null };
    const ttl = wantsTtl
      ? Math.min(...arr.map((r) => (typeof r === 'object' && r.ttl != null ? r.ttl : Infinity)))
      : null;
    return {
      status: 'ok',
      values: normalise(type, arr),
      ttl: Number.isFinite(ttl) ? ttl : null,
    };
  } catch (e) {
    return { status: classifyError(e), values: [], ttl: null, error: (e && e.code) || String(e) };
  }
}

// ---------------------------------------------------------------------------------------------
// consensus
// ---------------------------------------------------------------------------------------------
// A record's signature is status + normalised values. Resolvers holding the same signature are one
// camp. One camp = propagated. Two camps = mid-propagation (or a split-horizon / hijacking
// resolver), which during a cutover is the difference between "done" and "half your visitors still
// land on the old server".
//
// `error` replies are excluded from the vote and counted separately: they are missing evidence.
// Fewer than two definitive replies means we cannot claim consensus at all — reported as
// 'insufficient', never as agreement. A one-resolver "consensus" is just a single opinion.
function consensus(perResolver) {
  const definitive = Object.entries(perResolver).filter(([, r]) => r.status !== 'error');
  const failed = Object.entries(perResolver).filter(([, r]) => r.status === 'error').map(([n]) => n);

  if (definitive.length < 2) {
    return { agreed: 'insufficient', status: null, values: [], ttl: null, variants: [], failed, sample: definitive.length };
  }

  const camps = new Map();
  for (const [name, r] of definitive) {
    const sig = `${r.status}|${r.values.join(',')}`;
    if (!camps.has(sig)) camps.set(sig, { status: r.status, values: r.values, resolvers: [], ttls: [] });
    const c = camps.get(sig);
    c.resolvers.push(name);
    if (r.ttl != null) c.ttls.push(r.ttl);
  }
  const variants = [...camps.values()].sort((a, b) => b.resolvers.length - a.resolvers.length);
  const top = variants[0];
  return {
    agreed: variants.length === 1,
    status: top.status,
    values: top.values,
    // Lowest TTL across the winning camp: TTL is a ceiling on staleness, so the pessimistic value
    // is the operationally true one.
    ttl: top.ttls.length ? Math.min(...top.ttls) : null,
    variants: variants.length === 1 ? [] : variants,
    failed,
    sample: definitive.length,
  };
}

// ---------------------------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------------------------
// resolveAll(host) -> { host, records: { A: {agreed,status,values,ttl,variants,failed,byResolver}, ... } }
async function resolveAll(host, opts = {}) {
  const types = opts.types || TYPES;
  const servers = opts.resolvers || RESOLVERS;
  const timeout = opts.timeout || DEFAULT_TIMEOUT;
  const tries = opts.tries || DEFAULT_TRIES;

  const instances = servers.map((s) => {
    const r = new Resolver({ timeout, tries });
    r.setServers([s.ip]);
    return { ...s, r };
  });

  const records = {};
  await Promise.all(
    types.map(async (type) => {
      const byResolver = {};
      await Promise.all(
        instances.map(async (inst) => { byResolver[inst.name] = await queryOne(inst.r, host, type); }),
      );
      records[type] = { ...consensus(byResolver), byResolver };
    }),
  );
  return { host, resolvers: servers.map((s) => `${s.name} (${s.ip})`), records };
}

// A DMARC policy does not live in the apex TXT set — it lives at _dmarc.<host>. Reading only the
// apex and reporting "TXT unchanged" is how a dropped DMARC record passes a DNS check clean.
// DKIM is deliberately NOT attempted: its records sit at <selector>._domainkey.<host> and selectors
// are chosen by the mail provider and are not enumerable from DNS. Guessing a selector list would
// produce confident "DKIM missing" findings for correctly configured domains, so DKIM is surfaced
// as a manual item by the rules layer instead of being faked here.
async function resolveDmarc(host, opts = {}) {
  return resolveAll(`_dmarc.${host}`, { ...opts, types: ['TXT'] });
}

module.exports = { RESOLVERS, TYPES, resolveAll, resolveDmarc, normalise, consensus, classifyError };
