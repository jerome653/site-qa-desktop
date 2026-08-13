'use strict';
// dns/snapshot.js — the before/after half. Capture a zone's state to disk, then diff a later read
// against it and classify what the difference MEANS for a migration.
//
// WHY A SNAPSHOT AND NOT JUST A CHECK: a live-only check can tell you a domain has no MX record.
// It cannot tell you whether that domain ever had one. Those are the same observation and opposite
// incidents — a marketing site that never received mail versus a business whose email stopped
// twenty minutes ago. Only a baseline separates them, and the baseline has to be taken BEFORE the
// cutover, which is the one moment nobody thinks about DNS.
//
// THE DIFF IS NOT SYMMETRICAL, AND THAT IS THE WHOLE DESIGN. A/AAAA/CNAME changing is the POINT of
// the migration — flagging it as a defect trains people to ignore the report. MX or SPF changing is
// almost never intended, because nothing about moving a website requires touching mail. So the same
// mechanical event ("values differ") is expected news for one record type and an incident for
// another. classify() below encodes that asymmetry explicitly, per record type, once.

const fs = require('node:fs');
const path = require('node:path');
const { resolveAll, resolveDmarc, TYPES } = require('./resolve');
const live = require('./live');

const SCHEMA = 'sgen-dns-snapshot/1';

// ---------------------------------------------------------------------------------------------
// capture
// ---------------------------------------------------------------------------------------------
// Records apex + www together, always. A migration that moves one and forgets the other is the
// most common half-done cutover there is, and capturing only the name someone typed makes that
// invisible from the first minute.
function apexOf(host) { return String(host).trim().toLowerCase().replace(/^www\./, '').replace(/\.$/, ''); }

async function capture(hostInput, opts = {}) {
  const apex = apexOf(hostInput);
  const www = `www.${apex}`;
  const at = opts.now || new Date().toISOString();

  const [apexRec, wwwRec, dmarc] = await Promise.all([
    resolveAll(apex, opts),
    resolveAll(www, { ...opts, types: ['A', 'AAAA', 'CNAME'] }),
    resolveDmarc(apex, opts),
  ]);

  const snap = {
    schema: SCHEMA,
    host: apex,
    capturedAt: at,
    resolvers: apexRec.resolvers,
    records: apexRec.records,
    www: wwwRec.records,
    dmarc: dmarc.records.TXT,
    cnameTarget: null,
    live: null,
  };

  // A CNAME's target is resolved HERE, at capture time, and stored — not looked up later by the
  // classifier. Two reasons, both deliberate: the snapshot must contain every fact a finding is
  // derived from (so a stored baseline can be re-classified offline, and so the tests can drive
  // the classifier with no network), and it keeps the classifier a pure synchronous function.
  // A CNAME whose target has stopped resolving is a dead site — and if that target host is
  // re-registrable, someone else can claim it and serve content from this domain.
  for (const [key, recs] of [['apex', snap.records], ['www', snap.www]]) {
    const cn = recs.CNAME;
    if (!cn || cn.status !== 'ok' || !cn.values.length) continue;
    const target = cn.values[0];
    const r = await resolveAll(target, { ...opts, types: ['A', 'AAAA'] });
    const addresses = addressesOf(r.records);
    snap.cnameTarget = snap.cnameTarget || {};
    snap.cnameTarget[key] = {
      name: target,
      addresses,
      // 'dangling' is claimed only on a definitive NXDOMAIN from the consensus read. A timeout or
      // an insufficient sample resolves to 'unknown' — a network hiccup must never be reportable
      // as "the target no longer exists".
      status: addresses.length ? 'ok'
        : (r.records.A && r.records.A.agreed === 'insufficient') ? 'unknown'
          : (r.records.A && r.records.A.status === 'nxdomain') ? 'dangling' : 'no-address',
    };
  }

  // Live state is captured too, not just the zone. A baseline that records "the old site answered
  // 200 with this fingerprint from these addresses" is what makes probeLegacy() possible later —
  // without the old addresses on file there is nothing to ask afterwards.
  if (opts.live !== false) {
    snap.live = {
      apex: await live.checkName(apex, addressesOf(apexRec.records), opts),
      // .records, not the wrapper. Passing the wrapper yielded an empty address list, so every www
      // in the first live run reported "unreachable" while resolving perfectly — a fabricated
      // outage, and the worst possible direction for this tool to be wrong in.
      www: await live.checkName(www, addressesOf(wwwRec.records), opts),
    };
  }
  return snap;
}

// A/AAAA of the winning consensus camp. Falls back to nothing rather than to a minority answer:
// probing an address only one resolver believes in would produce findings about a view of the
// internet almost nobody has.
function addressesOf(records) {
  const a = records && records.A && records.A.status === 'ok' ? records.A.values : [];
  const aaaa = records && records.AAAA && records.AAAA.status === 'ok' ? records.AAAA.values : [];
  return [...a, ...aaaa];
}

// ---------------------------------------------------------------------------------------------
// persistence
// ---------------------------------------------------------------------------------------------
const safe = (s) => String(s).replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 60);

function save(snap, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${safe(snap.host)}--${safe(snap.capturedAt)}.json`);
  fs.writeFileSync(file, JSON.stringify(snap, null, 2));
  return file;
}

// Newest baseline for a host. Sorted by the timestamp INSIDE the file, not by mtime: a file copied
// between machines or restored from backup gets a new mtime and would otherwise silently become
// "the latest baseline" while carrying the oldest data.
function loadLatest(dir, host) {
  const apex = apexOf(host);
  let files;
  try { files = fs.readdirSync(dir); } catch (_) { return null; }
  const candidates = files
    .filter((f) => f.startsWith(`${safe(apex)}--`) && f.endsWith('.json'))
    .map((f) => {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        return j && j.schema === SCHEMA && j.host === apex ? { file: path.join(dir, f), snap: j } : null;
      } catch (_) { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.snap.capturedAt).localeCompare(String(a.snap.capturedAt)));
  return candidates[0] || null;
}

function list(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        return { file: f, host: j.host, capturedAt: j.capturedAt };
      } catch (_) { return null; }
    }).filter(Boolean).sort((a, b) => String(b.capturedAt).localeCompare(String(a.capturedAt)));
  } catch (_) { return []; }
}

// ---------------------------------------------------------------------------------------------
// diff
// ---------------------------------------------------------------------------------------------
// Per record type, one of five outcomes:
//   unchanged · same status, same values
//   changed   · both present, values differ
//   dropped   · was ok, now nodata/nxdomain  ← the deletion case; the reason this module exists
//   added     · was nodata/nxdomain, now ok
//   unknown   · either side failed to read, or consensus was insufficient
//
// `unknown` is a first-class outcome, not an error swallowed into "unchanged". A resolver timeout
// during verification must never be able to print "MX unchanged" — that is precisely the green tick
// that would let a dropped MX record ship.
function cmpValues(a, b) { return a.length === b.length && a.every((v, i) => v === b[i]); }

function diffRecord(before, after) {
  if (!before || !after) return { state: 'unknown', reason: 'record missing from one side' };
  if (before.agreed === 'insufficient' || after.agreed === 'insufficient' || before.status === 'error' || after.status === 'error') {
    return { state: 'unknown', reason: 'could not read the record definitively', before: before.values || [], after: after.values || [] };
  }
  const hadIt = before.status === 'ok';
  const hasIt = after.status === 'ok';
  if (hadIt && !hasIt) return { state: 'dropped', before: before.values, after: [], afterStatus: after.status };
  if (!hadIt && hasIt) return { state: 'added', before: [], after: after.values };
  if (!hadIt && !hasIt) return { state: 'unchanged', before: [], after: [], bothAbsent: true };
  return cmpValues(before.values, after.values)
    ? { state: 'unchanged', before: before.values, after: after.values }
    : { state: 'changed', before: before.values, after: after.values,
        removed: before.values.filter((v) => !after.values.includes(v)),
        added: after.values.filter((v) => !before.values.includes(v)) };
}

function diff(baseline, current) {
  const out = { host: baseline.host, baselineAt: baseline.capturedAt, currentAt: current.capturedAt, records: {}, www: {}, dmarc: null };
  for (const t of TYPES) out.records[t] = diffRecord(baseline.records[t], current.records[t]);
  for (const t of ['A', 'AAAA', 'CNAME']) out.www[t] = diffRecord(baseline.www && baseline.www[t], current.www && current.www[t]);
  out.dmarc = diffRecord(baseline.dmarc, current.dmarc);
  return out;
}

// ---------------------------------------------------------------------------------------------
// SPF / DMARC extraction
// ---------------------------------------------------------------------------------------------
// SPF is one TXT string among many at the apex; a TXT diff alone reports "TXT changed" and buries
// the fact that the line beginning v=spf1 is the one that vanished. Pulled out by prefix so the
// rule can name the actual consequence.
const spfOf = (vals) => (vals || []).filter((v) => /^v=spf1\b/i.test(v));
const dmarcOf = (vals) => (vals || []).filter((v) => /^v=DMARC1\b/i.test(v));

module.exports = { SCHEMA, capture, save, loadLatest, list, diff, diffRecord, addressesOf, apexOf, spfOf, dmarcOf };
