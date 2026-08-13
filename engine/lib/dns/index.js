'use strict';
// dns/index.js — the two operations this module exists to provide.
//
//   capture(host)  → read the zone as it is TODAY, prove what the current origin serves, write it
//                    to disk. Run before a cutover. Nothing else in the engine records prior state.
//   verify(host)   → read it again, diff against the baseline, prove the NEW origin is actually
//                    serving, and say which differences are the migration working and which are it
//                    breaking something.
//
// THE CLASSIFIER IS THE PRODUCT. Fetching records is twenty lines; knowing that a changed A record
// is success and a changed MX record is an outage is the part that takes migration experience, and
// it lives in findings() below — one place, explicit, per record type.
//
// WHAT THIS MODULE WILL NOT DO: it will not report a fact it did not observe. Where a signal is
// genuinely unobtainable (DKIM selectors, TTL on record types node:dns will not expose, whether
// two identical fingerprints mean success or a stalled cutover) it emits a rule that says so and
// names what a human has to check. A confident wrong answer about DNS costs more than a gap.

const { resolveAll } = require('./resolve');
const snapshot = require('./snapshot');
const live = require('./live');
const { getById } = require('./rules');

const DEFAULT_CUTOVER_TTL = 300;

// Finding constructor. Pulls title/severity/impact from the rule set so no call site can invent a
// severity or restate a title that then drifts out of sync with the registry.
function F(ruleId, detail, location, value, evidence) {
  const r = getById(ruleId);
  return {
    ruleId,
    suite: 'dns',
    title: r ? r.title : ruleId,
    severity: r ? r.reported : 'medium',
    category: r ? r.category : 'dns',
    impact: r ? r.impact : '',
    readiness: r ? r.readiness : null,
    detail: detail || '',
    location: location || '',
    value: value == null ? '' : String(value),
    ...(evidence ? { evidence } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// capture
// ---------------------------------------------------------------------------------------------
async function capture(host, opts = {}) {
  const snap = await snapshot.capture(host, opts);
  const file = opts.dir ? snapshot.save(snap, opts.dir) : null;
  return { snapshot: snap, file, findings: preCutoverFindings(snap, opts) };
}

// Findings available from a SINGLE read — no baseline needed. These are the ones that are only
// actionable BEFORE the cutover (TTL above all: after the change, a high TTL is no longer a warning,
// it is simply a delay you are already living through).
function preCutoverFindings(snap, opts = {}) {
  const out = [];
  const ttlMax = opts.cutoverTtl || DEFAULT_CUTOVER_TTL;
  const A = snap.records.A;

  if (A && A.status === 'ok' && A.ttl != null && A.ttl > ttlMax) {
    out.push(F('DNS-012',
      `A record TTL is ${A.ttl}s. Resolvers may keep serving the old address for that long after the change.`,
      snap.host, A.ttl));
  }
  // A "null MX" (RFC 7505) is the single record `0 .` and means the OPPOSITE of having mail: the
  // domain declares it accepts none. Treating it as a normal MX made the first live run announce
  // that example.com receives mail and needs its DKIM checked. It does not.
  const mx = snap.records.MX;
  const nullMx = mx && mx.status === 'ok' && mx.values.length === 1 && /^\d+\s*$/.test(mx.values[0]);
  if (mx && mx.status === 'ok' && !nullMx) {
    out.push(F('DNS-025',
      `${mx.values.length} MX record(s) present, so this domain receives mail. DKIM selector records cannot be discovered from DNS — confirm with the mail provider that they survive the move.`,
      snap.host, mx.values.join(' · ')));
  }
  return out.concat(commonFindings(snap, opts));
}

// ---------------------------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------------------------
// `expectedTarget` is optional and is the difference between "something changed" and "it changed to
// the right thing". Accepts an IP or a hostname; a hostname is resolved so a CNAME-style target
// (the usual shape for a platform migration) can be compared on addresses.
async function verify(host, opts = {}) {
  const apex = snapshot.apexOf(host);
  const current = await snapshot.capture(apex, opts);

  let found = opts.baseline
    ? { snap: opts.baseline, file: opts.baselineFile || '(supplied)' }
    : (opts.dir ? snapshot.loadLatest(opts.dir, apex) : null);

  // No captured baseline, but the old nameservers were supplied → recover one from the shadow zone
  // they are still serving. A recovered baseline is used ONLY when there is no captured one: a real
  // pre-cutover recording is stronger evidence and must never be silently displaced by a
  // reconstruction of the same zone read today.
  let recovered = null, subdomains = null;
  if (!found && opts.oldNameservers && opts.oldNameservers.length) {
    const rec = await require('./recover').recover(apex, opts.oldNameservers, opts);
    if (rec.ok) {
      recovered = rec;
      found = { snap: rec.snapshot, file: '(recovered from the old nameservers)' };
      subdomains = await require('./recover').compareSubdomains(rec.snapshot, opts);
    } else {
      recovered = rec; // carries .error — reported rather than swallowed
    }
  }
  const baseline = found ? found.snap : null;

  let expected = null;
  if (opts.expectedTarget) expected = await resolveExpected(opts.expectedTarget, opts);

  // Ask the addresses from the baseline whether they are STILL serving this hostname. Only
  // meaningful with a baseline, and only for addresses that are no longer in the current answer.
  let legacy = { apex: null, www: null };
  if (baseline) {
    legacy = {
      apex: await live.probeLegacy(apex, snapshot.addressesOf(baseline.records), snapshot.addressesOf(current.records), opts),
      www: await live.probeLegacy(`www.${apex}`, snapshot.addressesOf(baseline.www), snapshot.addressesOf(current.www), opts),
    };
  }

  const d = baseline ? snapshot.diff(baseline, current) : null;
  const findings = [
    ...commonFindings(current, opts),
    ...(d ? cutoverFindings(d, baseline, current, legacy, opts) : []),
    ...(recovered && recovered.ok ? recoveryFindings(recovered.snapshot, subdomains) : []),
    ...(expected ? targetFindings(current, expected) : []),
  ];

  return {
    host: apex,
    baseline: baseline
      ? { file: found.file, capturedAt: baseline.capturedAt, source: baseline.source || 'captured' }
      : null,
    recovered: recovered ? { ok: recovered.ok, error: recovered.error || null, zone: recovered.zone || null } : null,
    subdomains,
    current,
    diff: d,
    legacy,
    expected,
    findings,
    verdict: verdictOf(current, findings, !!baseline),
  };
}

async function resolveExpected(target, opts) {
  const t = String(target).trim().toLowerCase();
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(t) || t.includes(':')) return { input: t, addresses: [t], kind: 'ip' };
  const r = await resolveAll(t, { ...opts, types: ['A', 'AAAA'] });
  return { input: t, addresses: snapshot.addressesOf(r.records), kind: 'host' };
}

// ---------------------------------------------------------------------------------------------
// classifiers
// ---------------------------------------------------------------------------------------------

// Findings derivable from the current state alone — they mean the same thing before and after.
function commonFindings(snap, opts = {}) {
  const out = [];
  const { records, www } = snap;
  const A = records.A, AAAA = records.AAAA, CNAME = records.CNAME;

  // --- resolution ---
  const nx = (r) => r && r.status === 'nxdomain';
  if (nx(A) && nx(AAAA) && nx(records.NS)) {
    out.push(F('DNS-001', 'No resolver could find this name.', snap.host, 'NXDOMAIN'));
    return out; // everything downstream is noise once the name does not exist
  }
  const hasAddr = (A && A.status === 'ok') || (AAAA && AAAA.status === 'ok');
  const hasCname = CNAME && CNAME.status === 'ok';
  if (!hasAddr && !hasCname) {
    out.push(F('DNS-002', 'The zone answers, but publishes no A, AAAA or CNAME record.', snap.host, 'no address'));
  }

  // Disagreement is reported PER RECORD TYPE, because which record is split is the whole story: a
  // split A record is a cutover mid-flight, a split NS is a delegation that has not settled.
  for (const [type, rec] of Object.entries(records)) {
    if (!rec || rec.agreed !== false) continue;
    const camps = rec.variants.map((v) => `${v.resolvers.join('+')} → ${v.status === 'ok' ? v.values.join(', ') : v.status}`);
    out.push(F('DNS-003', `${type}: resolvers do not agree. ${camps.join('  |  ')}`, snap.host, type, { variants: rec.variants }));
  }
  for (const [type, rec] of Object.entries(records)) {
    if (rec && rec.agreed === 'insufficient' && rec.failed.length) {
      // Not a finding about the zone — a stated gap in our own evidence, so nothing downstream
      // silently reports this record as clean.
      out.push(F('DNS-003', `${type}: too few resolvers answered to establish consensus (failed: ${rec.failed.join(', ')}). This record was not verified.`, snap.host, type));
    }
  }

  // A CNAME at the bare domain is invalid per RFC 1034 §3.6.2 unless the provider flattens it. We
  // report the condition, not a verdict on the provider — flattening is invisible from outside, and
  // the observable consequence (do MX/NS still answer at the apex?) is stated alongside.
  if (hasCname) {
    const coexists = ['MX', 'NS', 'TXT'].filter((t) => records[t] && records[t].status === 'ok');
    out.push(F('DNS-013',
      `The bare domain is a CNAME to ${CNAME.values.join(', ')}. ${coexists.length ? `Other records still answer at the apex (${coexists.join(', ')}), so the provider is flattening it — safe, but provider-specific.` : 'No MX/NS/TXT answered at the apex, which is what a non-flattening provider looks like.'}`,
      snap.host, CNAME.values.join(', ')));
  }

  // A CNAME that points at a name which no longer exists. Resolved at capture time (see
  // snapshot.js) so this stays a pure read of recorded evidence.
  for (const [key, t] of Object.entries(snap.cnameTarget || {})) {
    const name = key === 'www' ? `www.${snap.host}` : snap.host;
    if (t.status === 'dangling') {
      out.push(F('DNS-022', `${name} is a CNAME to ${t.name}, which does not exist (NXDOMAIN). If that name is claimable, whoever registers it serves this domain.`, name, t.name));
    } else if (t.status === 'no-address') {
      out.push(F('DNS-022', `${name} is a CNAME to ${t.name}, which exists but publishes no address — nothing to connect to.`, name, t.name));
    }
  }

  // --- coverage: www ---
  const wwwHasAddr = (www.A && www.A.status === 'ok') || (www.AAAA && www.AAAA.status === 'ok') || (www.CNAME && www.CNAME.status === 'ok');
  if (!wwwHasAddr && hasAddr) {
    out.push(F('DNS-011', `www.${snap.host} does not resolve, while the bare domain does.`, `www.${snap.host}`, (www.A && www.A.status) || 'nodata'));
  } else if (wwwHasAddr && hasAddr) {
    const apexIps = snapshot.addressesOf(records);
    const wwwIps = snapshot.addressesOf(www);
    // Disjoint address sets = two different origins. Only claimed when BOTH sides produced
    // addresses; a www that CNAMEs to the apex resolves to the same set and correctly says nothing.
    if (apexIps.length && wwwIps.length && !wwwIps.some((ip) => apexIps.includes(ip))) {
      out.push(F('DNS-010',
        `The bare domain resolves to ${apexIps.join(', ')} and www resolves to ${wwwIps.join(', ')} — no address in common.`,
        snap.host, `${apexIps.length}+${wwwIps.length} addresses`));
    }
  }

  // --- serving ---
  if (snap.live) {
    for (const [key, res] of Object.entries(snap.live)) {
      if (!res) continue;
      const name = res.hostname;
      // Addresses this machine has no route to are excluded from every serving judgement — see the
      // UNTESTABLE block in live.js. They are reported once, as our gap, by DNS-029.
      const testable = (res.ips || []).filter((i) => !i.untestable);
      if (res.verdict === 'unreachable' && testable.length) {
        const why = testable.map((i) => `${i.ip}: ${i.error || `HTTP ${i.status}`}`).join(' · ');
        out.push(F('DNS-015', `${name} resolves, but no address served a page. ${why}`, name, testable.length + ' address(es)'));
      }
      if (res.verdict === 'degraded') {
        const dead = testable.filter((i) => !i.ok || i.status >= 400).map((i) => `${i.ip} (${i.error || i.status})`);
        out.push(F('DNS-023', `${dead.length} of ${testable.length} reachable addresses for ${name} are not serving: ${dead.join(', ')}`, name, dead.join(', ')));
      }
      if ((res.untested || []).length) {
        out.push(F('DNS-029',
          `${res.untested.length} address(es) for ${name} could not be probed from this machine (${res.untested[0].reason}): ${res.untested.map((u) => u.ip).join(', ')}. They were excluded from the serving verdict rather than counted as failures.`,
          name, res.untested.map((u) => u.ip).join(', ')));
      }
      if (res.verdict === 'redirect-off') {
        const to = (res.ips.find((i) => i.location) || {}).location;
        out.push(F('DNS-024', `${name} answers only with a redirect to ${to}.`, name, to || 'redirect'));
      }
      // Certificate rules are evaluated per address: one member of a round-robin set carrying a
      // stale certificate is invisible to any check that tests the name once.
      for (const i of res.ips || []) {
        if (!i.ok || i.scheme !== 'https' || !i.cert || !i.cert.present) continue;
        if (!i.cert.covers) {
          out.push(F('DNS-016', `${name} at ${i.ip} presents a certificate for ${i.cert.names.join(', ') || i.cert.subject} — this name is not on it.`, `${name} @ ${i.ip}`, i.cert.names.join(', ')));
        }
        if (i.cert.expired) {
          out.push(F('DNS-017', `${name} at ${i.ip}: certificate expired on ${i.cert.validTo}.`, `${name} @ ${i.ip}`, i.cert.validTo));
        } else if (i.cert.daysLeft != null && i.cert.daysLeft <= 14) {
          out.push(F('DNS-017', `${name} at ${i.ip}: certificate expires in ${i.cert.daysLeft} day(s), on ${i.cert.validTo}.`, `${name} @ ${i.ip}`, `${i.cert.daysLeft}d`));
        }
      }
    }
    out.push(...caaFindings(snap));
  }
  return out;
}

// CAA vs the certificate that is actually installed.
//
// Fires ONLY when the installed issuer can be mapped to a CAA identifier with confidence. An
// unrecognised issuer means our mapping is incomplete, not that the CAA record is blocking — and
// "your CAA record forbids your own certificate" is far too alarming a claim to make on a lookup
// miss. Unknown issuers are therefore silent by design.
const CAA_ISSUERS = [
  [/let'?s encrypt|isrg/i, ['letsencrypt.org']],
  [/digicert/i, ['digicert.com']],
  [/sectigo|comodo/i, ['sectigo.com', 'comodoca.com']],
  [/globalsign/i, ['globalsign.com']],
  [/google trust services|gts/i, ['pki.goog', 'google.com']],
  [/amazon/i, ['amazon.com', 'amazontrust.com', 'awstrust.com', 'amazonaws.com']],
  [/cloudflare/i, ['pki.goog', 'digicert.com', 'letsencrypt.org', 'ssl.com']],
  [/zerossl/i, ['sectigo.com', 'zerossl.com']],
  [/buypass/i, ['buypass.com']],
  [/entrust/i, ['entrust.net']],
];

function caaFindings(snap) {
  const caa = snap.records.CAA;
  if (!caa || caa.status !== 'ok' || !caa.values.length) return [];
  const permitted = caa.values
    .filter((v) => /\bissue(wild)?\b/.test(v))
    .map((v) => v.split(/\s+/).pop())
    .filter(Boolean);
  if (!permitted.length) return []; // iodef-only records permit nothing and forbid nothing

  const issuers = new Set();
  for (const res of Object.values(snap.live || {})) {
    for (const i of (res && res.ips) || []) if (i.cert && i.cert.issuer) issuers.add(i.cert.issuer);
  }
  const out = [];
  for (const issuer of issuers) {
    const mapped = CAA_ISSUERS.find(([re]) => re.test(issuer));
    if (!mapped) continue; // unrecognised → stay silent rather than accuse
    if (!mapped[1].some((id) => permitted.includes(id))) {
      out.push(F('DNS-014',
        `The installed certificate is from ${issuer} (CAA identifier ${mapped[1][0]}), but CAA permits only: ${permitted.join(', ')}. Renewal will be refused.`,
        snap.host, permitted.join(', ')));
    }
  }
  return out;
}

// Findings that only exist because there is a baseline.
function cutoverFindings(d, baseline, current, legacy, opts = {}) {
  const out = [];
  const at = `baseline ${baseline.capturedAt}`;

  // --- mail: the records a website migration has no reason to touch ---
  const mx = d.records.MX;
  if (mx.state === 'dropped') {
    out.push(F('DNS-004', `MX records present at baseline are gone. Was: ${mx.before.join(' · ')}`, current.host, mx.before.join(' · '), { before: mx.before, at }));
  } else if (mx.state === 'changed') {
    out.push(F('DNS-004', `MX records changed. Removed: ${mx.removed.join(' · ') || 'none'}. Added: ${mx.added.join(' · ') || 'none'}. Confirm this was intended — a website move does not require it.`, current.host, mx.added.join(' · '), { before: mx.before, after: mx.after, at }));
  }

  const txt = d.records.TXT;
  const spfBefore = snapshot.spfOf(txt.before), spfAfter = snapshot.spfOf(txt.after);
  if (spfBefore.length && !spfAfter.length) {
    out.push(F('DNS-005', `SPF record is gone. Was: ${spfBefore.join(' ')}`, current.host, spfBefore.join(' '), { before: spfBefore, at }));
  }
  if (d.dmarc.state === 'dropped' || (snapshot.dmarcOf(d.dmarc.before).length && !snapshot.dmarcOf(d.dmarc.after).length)) {
    out.push(F('DNS-006', `DMARC policy at _dmarc.${current.host} is gone. Was: ${d.dmarc.before.join(' ')}`, `_dmarc.${current.host}`, d.dmarc.before.join(' '), { at }));
  }
  if (txt.state === 'changed' || txt.state === 'dropped') {
    // SPF is already reported on its own; the remainder is verification tokens, which fail silently.
    const lost = (txt.removed || txt.before || []).filter((v) => !/^v=spf1\b/i.test(v));
    if (lost.length) out.push(F('DNS-020', `TXT record(s) removed: ${lost.join(' · ')}`, current.host, `${lost.length} removed`, { removed: lost, at }));
  }

  // --- zone authority ---
  if (d.records.NS.state === 'changed') {
    out.push(F('DNS-007', `Nameservers moved from [${d.records.NS.before.join(', ')}] to [${d.records.NS.after.join(', ')}]. Every record above is served by the new provider — anything not re-created there is gone.`, current.host, d.records.NS.after.join(', '), { at }));
  }
  if (d.records.SOA.state === 'changed') {
    out.push(F('DNS-021', `SOA changed: ${d.records.SOA.before.join('')} → ${d.records.SOA.after.join('')}`, current.host, d.records.SOA.after.join(''), { at }));
  }

  // --- did the address actually move ---
  const a = d.records.A;
  const cname = d.records.CNAME;
  const addressMoved = a.state === 'changed' || a.state === 'added' || a.state === 'dropped'
    || cname.state === 'changed' || cname.state === 'added' || cname.state === 'dropped';
  if (!addressMoved && a.state === 'unchanged' && !a.bothAbsent && opts.expectCutover !== false) {
    out.push(F('DNS-008', `A record is still ${a.after.join(', ')} — the same address recorded at baseline. Nothing has been repointed yet.`, current.host, a.after.join(', '), { at }));
  }

  // --- the old server ---
  for (const [key, l] of Object.entries(legacy || {})) {
    if (!l || !l.stillServing || !l.stillServing.length) continue;
    const name = key === 'www' ? `www.${current.host}` : current.host;
    out.push(F('DNS-018', `${l.stillServing.join(', ')} (the pre-migration address${l.stillServing.length > 1 ? 'es' : ''}) still answers for ${name}. Until it is switched off, anyone holding a cached record keeps reaching it.`, name, l.stillServing.join(', '), { probes: l.checked }));
  }

  // --- content identity: stated as ambiguous, never resolved automatically ---
  const bFp = baseline.live && baseline.live.apex && baseline.live.apex.fingerprint;
  const cFp = current.live && current.live.apex && current.live.apex.fingerprint;
  if (bFp && cFp && bFp.hash === cFp.hash && addressMoved) {
    out.push(F('DNS-019', `The address changed, and the page served is byte-for-byte the same content as the baseline (title "${cFp.title}"). Either the migration is faithful or the new address proxies the old site. This cannot be settled from outside — confirm on the new origin.`, current.host, cFp.hash));
  }
  return out;
}

// Findings from a RECOVERED baseline (recover.js). Kept separate from cutoverFindings() because
// they rest on a different evidence base: not "what we recorded before", but "what the replaced
// nameservers still hold". Every consumer needs to be able to tell those apart.
function recoveryFindings(recoveredSnap, subRows) {
  const out = [];
  const rf = recoveredSnap.recoveredFrom || {};
  out.push(F('DNS-027',
    `${(rf.nameservers || []).filter((n) => n.ip).map((n) => n.ns).join(', ')} still answer authoritatively for ${recoveredSnap.host} (SOA ${rf.soa}). The pre-migration zone was read from them.`,
    recoveredSnap.host, rf.soa || ''));

  const dropped = (subRows || []).filter((r) => r.state === 'dropped');
  for (const r of dropped) {
    out.push(F('DNS-026', `${r.name} exists in the old zone (${(r.was || []).join(', ')}) but does not resolve on the current nameservers.`, r.name, (r.was || []).join(', ')));
  }
  const unknown = (subRows || []).filter((r) => r.state === 'unknown');
  if (subRows && subRows.length) {
    out.push(F('DNS-028',
      `${subRows.length} common hostname(s) answered in the old zone: ${dropped.length} dropped, ${subRows.filter((r) => r.state === 'moved').length} moved, ${subRows.filter((r) => r.state === 'intact').length} unchanged${unknown.length ? `, ${unknown.length} could not be checked` : ''}. Names outside the probe list were not tested.`,
      recoveredSnap.host, `${subRows.length} probed`));
  }
  return out;
}

// Did it land on the intended target?
function targetFindings(current, expected) {
  const now = snapshot.addressesOf(current.records);
  if (!expected.addresses.length) {
    return [F('DNS-009', `Expected target "${expected.input}" itself does not resolve, so the address could not be compared against it.`, current.host, expected.input)];
  }
  if (!now.length) return [];
  const hit = now.some((ip) => expected.addresses.includes(ip));
  if (!hit) {
    return [F('DNS-009', `${current.host} resolves to ${now.join(', ')}; the expected target ${expected.input} is ${expected.addresses.join(', ')}. No overlap.`, current.host, now.join(', '))];
  }
  return [];
}

// ---------------------------------------------------------------------------------------------
// verdict
// ---------------------------------------------------------------------------------------------
// Deliberately coarse and conservative. `verified` requires a baseline: without prior state the
// tool cannot know what was lost, so the best it may claim is that the current state looks healthy.
// That distinction is the difference between "we checked" and "we assumed".
function verdictOf(current, findings, hasBaseline) {
  const tier1 = findings.filter((f) => f.readiness === 1);
  const online = current.live && ['apex', 'www'].every((k) => {
    const r = current.live[k];
    return r && (r.verdict === 'online' || r.verdict === 'redirect-off');
  });
  if (tier1.length) return { state: 'blocked', online: !!online, blockers: tier1.length, note: `${tier1.length} launch-blocking DNS finding(s)` };
  if (!hasBaseline) return { state: 'no-baseline', online: !!online, blockers: 0, note: 'current state looks healthy; without a baseline, deleted records cannot be detected' };
  return { state: online ? 'verified' : 'attention', online: !!online, blockers: 0, note: online ? 'records match the baseline except where expected, and both names are serving' : 'no blocking findings, but not every name is serving' };
}

module.exports = { capture, verify, preCutoverFindings, commonFindings, cutoverFindings, recoveryFindings, targetFindings, verdictOf, F };
