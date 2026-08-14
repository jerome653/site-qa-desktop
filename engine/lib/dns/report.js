'use strict';
// dns/report.js — the DNS & Cutover run report.
//
// Reuses `site-qa/report.js`'s STYLE verbatim rather than defining a palette here. Two reasons: this
// report is opened in the same frame as every other report in the app, so a second palette would
// read as a bolted-on tool; and a copied palette silently stops matching the moment the real one is
// retuned.
//
// WHAT THIS REPORT REFUSES TO DO: print a green all-clear. There is no score and no percentage. Every
// rule in this suite is `manual` (see rules.js), and a DNS run's whole value is in named facts —
// which record changed, which name is not serving, what could not be checked. A number would compress
// exactly the information the reader needs and would invite the comparison ("87 last week, 91 now")
// that the underlying data cannot support.

const { STYLE } = require('../site-qa/report.js');
const { humanDuration } = require('./resolve');

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const SEV = {
  critical: { label: 'Critical', color: 'var(--brand)' },
  high: { label: 'High', color: 'var(--brand)' },
  medium: { label: 'Medium', color: 'var(--warn, #C79A2E)' },
  low: { label: 'Low', color: 'var(--ink-soft)' },
};
const SEV_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };

const VERDICT = {
  blocked: { text: 'BLOCKED', color: 'var(--brand)' },
  attention: { text: 'NEEDS ATTENTION', color: 'var(--warn, #C79A2E)' },
  verified: { text: 'VERIFIED', color: 'var(--pass, #2FA968)' },
  'no-baseline': { text: 'NO BASELINE', color: 'var(--ink-soft)' },
  captured: { text: 'BASELINE CAPTURED', color: 'var(--pass, #2FA968)' },
};

function recordRows(records, dmarc) {
  const order = ['A', 'AAAA', 'CNAME', 'NS', 'MX', 'TXT', 'CAA', 'SOA'];
  const rows = order.filter((t) => records[t]).map((t) => {
    const r = records[t];
    // A "null MX" is the single record `0 .`, and the trailing dot normalises away — so the raw value
    // printed as a bare "0", which reads as a broken row. RFC 7505 says it means the opposite of a
    // missing MX: the domain explicitly accepts no mail. Say that, rather than showing a lone digit.
    const nullMx = t === 'MX' && r.status === 'ok' && r.values.length === 1 && /^\d+\s*$/.test(r.values[0]);
    const val = nullMx
      ? '<span style="color:var(--ink-soft)">null MX — this domain accepts no mail (RFC 7505)</span>'
      : r.status === 'ok' ? r.values.map(esc).join('<br>') : `<span style="color:var(--ink-faint)">${esc(r.status)}</span>`;
    // Agreement is shown per record, not once for the run. Which record is split is the diagnosis:
    // a split A is a cutover mid-flight, a split NS is a delegation that has not settled.
    // AGREEMENT IS STATED EVEN WHEN IT HOLDS. Rendering '' for the healthy case left the whole column
    // blank on a clean run, which reads as a column that failed to populate — the reader cannot tell
    // "every resolver agreed" from "we never checked". Both are now words.
    const agree = r.agreed === true ? `<span style="color:var(--ink-faint)">all ${r.sample || ''} agree</span>`
      : r.agreed === false ? '<span style="color:var(--brand)">resolvers disagree</span>'
        : '<span style="color:var(--ink-faint)">not verified</span>';
    return `<tr><td class="mono">${t}</td><td class="mono">${val}</td><td class="mono">${r.ttl != null ? r.ttl + 's' : '—'}</td><td>${agree}</td></tr>`;
  });
  if (dmarc) {
    const val = dmarc.status === 'ok' ? dmarc.values.map(esc).join('<br>') : `<span style="color:var(--ink-faint)">${esc(dmarc.status)}</span>`;
    // DMARC is read by its own query against _dmarc.<host>, so it carries consensus like any other
    // record. Leaving its agreement cell empty was the same "is this blank or unchecked?" ambiguity
    // the other rows just had fixed.
    const agree = dmarc.agreed === true ? `<span style="color:var(--ink-faint)">all ${dmarc.sample || ''} agree</span>`
      : dmarc.agreed === false ? '<span style="color:var(--brand)">resolvers disagree</span>'
        : '<span style="color:var(--ink-faint)">not verified</span>';
    rows.push(`<tr><td class="mono">DMARC</td><td class="mono">${val}</td><td class="mono">—</td><td>${agree}</td></tr>`);
  }
  return rows.join('');
}

function diffRows(diff) {
  if (!diff) return '';
  const all = Object.entries(diff.records).concat([['DMARC', diff.dmarc]]);
  const changed = all.filter(([, d]) => d && d.state !== 'unchanged');
  if (!changed.length) return '<p class="muted">No record changed since the baseline.</p>';
  const tone = { dropped: 'var(--brand)', changed: 'var(--warn, #C79A2E)', added: 'var(--pass, #2FA968)', unknown: 'var(--ink-faint)' };
  return `<table class="tbl"><thead><tr><th>Record</th><th>Change</th><th>Baseline</th><th>Now</th></tr></thead><tbody>${
    changed.map(([t, d]) => `<tr><td class="mono">${esc(t)}</td><td style="color:${tone[d.state] || 'var(--ink)'}"><b>${esc(d.state.toUpperCase())}</b></td><td class="mono">${(d.before || []).map(esc).join('<br>') || '—'}</td><td class="mono">${(d.after || []).map(esc).join('<br>') || '—'}</td></tr>`).join('')
  }</tbody></table>`;
}

function liveRows(live) {
  if (!live) return '';
  return Object.values(live).filter(Boolean).map((r) => {
    const ips = (r.ips || []).map((i) => {
      const status = i.untestable
        ? `<span style="color:var(--ink-faint)">not testable here — ${esc(i.untestableReason || i.error)}</span>`
        : i.ok ? `HTTP ${i.status}` : `<span style="color:var(--brand)">${esc(i.error)}</span>`;
      const cert = i.cert && i.cert.present
        ? (i.cert.covers
          ? `cert ok${i.cert.daysLeft != null ? ` · ${i.cert.daysLeft}d left` : ''}`
          : '<span style="color:var(--brand)">cert does not cover this name</span>')
        : '';
      return `<tr><td class="mono">${esc(i.ip)}</td><td>${status}</td><td class="mono">${i.ms != null ? i.ms + 'ms' : ''}</td><td>${cert}</td></tr>`;
    }).join('');
    return `<h4 class="mono">${esc(r.hostname)} — <span style="color:${r.verdict === 'online' ? 'var(--pass, #2FA968)' : r.verdict === 'untested' ? 'var(--ink-faint)' : 'var(--brand)'}">${esc(r.verdict)}</span></h4>
      <table class="tbl"><thead><tr><th>Address</th><th>Response</th><th>Time</th><th>Certificate</th></tr></thead><tbody>${ips}</tbody></table>`;
  }).join('');
}

function findingRows(findings) {
  if (!findings.length) return '<p class="muted">No findings.</p>';
  const sorted = [...findings].sort((a, b) => (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9));
  return sorted.map((f) => {
    const s = SEV[f.severity] || SEV.low;
    return `<div class="fnd">
      <div class="fnd-h"><span class="pill" style="border-color:${s.color};color:${s.color}">${esc(s.label)}</span>
        <span class="mono rid">${esc(f.ruleId)}</span>
        <b>${esc(f.title)}</b>${f.readiness === 1 ? '<span class="pill" style="border-color:var(--brand);color:var(--brand)">blocks cutover</span>' : ''}</div>
      <div class="fnd-d">${esc(f.detail)}</div>
      ${f.impact ? `<div class="fnd-i">${esc(f.impact)}</div>` : ''}
      ${f.location ? `<div class="fnd-l mono">${esc(f.location)}</div>` : ''}
    </div>`;
  }).join('');
}

function subdomainRows(rows) {
  if (!rows || !rows.length) return '';
  const tone = { dropped: 'var(--brand)', moved: 'var(--warn, #C79A2E)', intact: 'var(--pass, #2FA968)', unknown: 'var(--ink-faint)' };
  return `<h3>Subdomains recovered from the old zone</h3>
    <p class="muted">Only common hostnames were probed. A name absent here was not necessarily absent from the zone.</p>
    <table class="tbl"><thead><tr><th>Hostname</th><th>State</th><th>Old zone</th><th>Now</th><th>Mail (MX)</th></tr></thead><tbody>${
      rows.map((r) => `<tr><td class="mono">${esc(r.name)}</td><td style="color:${tone[r.state]}"><b>${esc(r.state)}</b></td><td class="mono">${(r.was || []).map(esc).join(', ') || '—'}</td><td class="mono">${(r.now || []).map(esc).join(', ') || '—'}</td><td style="color:${r.mx ? tone[r.mx.state] : 'var(--ink-faint)'}">${
        // The address column cannot answer for the mail route: a host that resolves fine can have
        // lost every MX record it had, and that is the migration failure people notice last.
        r.mx ? `<b>${esc(r.mx.state)}</b>${r.mx.state === 'dropped' ? ` <span class="mono" style="color:var(--ink-faint)">(was ${(r.mx.was || []).map(esc).join(', ')})</span>` : ''}` : '—'
      }</td></tr>`).join('')
    }</tbody></table>`;
}

// How far the repoint has travelled, drawn rather than described. The bar is the ONLY chart in this
// report because it is the only quantity here that is a proportion — everything else is a fact that
// is either true or not, and a graph of those would be decoration.
function propagationStrip(p) {
  if (!p) return '';
  const seg = (n, color) => (n ? `<i style="flex:${n};background:${color}"></i>` : '');
  const names = (state) => Object.entries(p.byResolver).filter(([, s]) => s === state).map(([n]) => n);
  const behind = names('old'), unread = names('unknown');
  return `<div class="prop">
    <p class="muted" style="margin:0"><b style="color:var(--ink)">${p.percent}% propagated</b> — ${p.onNew} of ${p.definitive} resolvers serve the new ${p.type} record${p.unknown ? ` · ${p.unknown} did not answer (${esc(unread.join(', '))}) and are excluded` : ''}</p>
    <!-- The old-address segment is AMBER, not the brand red. Red is this report's FAILURE colour,
         and a resolver that has not expired its cache yet has failed at nothing — painting the
         unmoved half red made a working cutover look broken at a glance, which is the exact
         misreading DNS-030 exists to prevent. Caught by looking at the render, not by a test.
         Grey for the resolvers that never answered: absent evidence gets no colour of its own. -->
    <div class="propbar">${seg(p.onNew, 'var(--pass, #2FA968)')}${seg(p.onOld, 'var(--warn, #C79A2E)')}${seg(p.unknown, 'var(--line-strong)')}</div>
    <p class="muted" style="margin:0">${behind.length
      ? `Still on the old address: <b class="mono">${esc(behind.join(', '))}</b>${p.ttl != null ? ` — for up to ${esc(humanDuration(p.ttl))}` : ''}`
      : 'Every resolver that answered is on the new address.'}</p>
  </div>`;
}

// `res` is either a capture result ({snapshot, findings}) or a verify result.
function render(res, meta = {}) {
  const snap = res.current || res.snapshot;
  const isVerify = !!res.current;
  const v = isVerify ? (VERDICT[res.verdict.state] || VERDICT.attention) : VERDICT.captured;
  const blockers = (res.findings || []).filter((f) => f.readiness === 1).length;

  const baselineLine = !isVerify ? 'This run RECORDED the zone. Run a verification after the cutover to diff against it.'
    : res.baseline
      ? `Compared against a ${res.baseline.source === 'recovered' ? '<b>recovered</b>' : 'captured'} baseline from ${esc(res.baseline.capturedAt)}.`
      : '<b style="color:var(--brand)">No baseline was found.</b> Records that were DELETED cannot be detected without one — this run can only report the zone as it stands today.';

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DNS &amp; Cutover — ${esc(snap.host)}</title><style>${STYLE}
.sec{padding:22px clamp(22px,3vw,64px);border-bottom:1px solid var(--line)}
.tbl{width:100%;border-collapse:collapse;margin:10px 0 18px;font-size:13px}
.tbl th{text-align:left;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-faint);font-weight:600;padding:7px 10px;border-bottom:1px solid var(--line-strong)}
.tbl td{padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}
.muted{color:var(--ink-soft);font-size:13px}
h3{font-size:15px;margin:22px 0 6px}h4{font-size:13px;margin:16px 0 4px;font-weight:600}
.fnd{border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin:9px 0;background:var(--surface)}
.fnd-h{display:flex;align-items:center;gap:9px;flex-wrap:wrap;margin-bottom:5px}
.fnd-h b{font-size:13.5px}
.pill{font-size:10px;letter-spacing:.08em;text-transform:uppercase;border:1px solid;border-radius:99px;padding:2px 8px;font-weight:600}
.rid{font-size:11px;color:var(--ink-faint)}
.fnd-d{font-size:13px;color:var(--ink-soft)}
.fnd-i{font-size:12.5px;color:var(--ink-faint);margin-top:5px;font-style:italic}
.fnd-l{font-size:11px;color:var(--ink-faint);margin-top:5px}
.vh{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap}
.vh b{font-size:26px;letter-spacing:-.01em}
.next{margin:14px 0 0;padding:12px 14px;border:1px solid var(--line-strong);border-left:3px solid ${v.color};border-radius:8px;background:var(--surface)}
.next span{display:block;font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--ink-faint);font-weight:600;margin-bottom:4px}
.next b{font-size:14px;font-weight:600;line-height:1.45}
.prop{margin:14px 0 0}
.propbar{display:flex;height:8px;border-radius:99px;overflow:hidden;background:var(--line);margin:6px 0}
.propbar i{display:block}
</style></head><body><div class="brand-wm"><b>SGEN</b></div><div class="wrap">
<div class="sec">
  <div class="vh"><b style="color:${v.color}">${v.text}</b><span class="mono" style="color:var(--ink-soft)">${esc(snap.host)}</span></div>
  <p class="muted" style="margin:8px 0 0">${isVerify ? esc(res.verdict.note) : 'Zone and serving state recorded.'}${blockers ? ` · <b style="color:var(--brand)">${blockers} finding(s) block the cutover</b>` : ''}</p>
  ${isVerify && res.verdict.next ? `<div class="next"><span>Do this next</span><b>${esc(res.verdict.next)}</b></div>` : ''}
  ${propagationStrip(res.propagation)}
  <p class="muted" style="margin:6px 0 0">${baselineLine}</p>
  <p class="muted" style="margin:6px 0 0">Read ${esc(snap.capturedAt)} · resolvers: ${esc((snap.resolvers || []).join(', '))}${meta.engine ? ` · engine ${esc(meta.engine)}` : ''}</p>
  ${snap.source === 'recovered' ? '<p class="muted" style="margin:6px 0 0;color:var(--brand)">This zone was RECOVERED from the old nameservers. It reflects what they hold today, which is not provably what they held at cutover.</p>' : ''}
</div>
<div class="sec"><h3>Findings</h3>${findingRows(res.findings || [])}</div>
${isVerify && res.diff ? `<div class="sec"><h3>What changed since the baseline</h3>${diffRows(res.diff)}</div>` : ''}
${res.subdomains ? `<div class="sec">${subdomainRows(res.subdomains)}</div>` : ''}
<div class="sec"><h3>Zone as read now</h3>
  <table class="tbl"><thead><tr><th>Type</th><th>Value</th><th>TTL</th><th>Agreement</th></tr></thead><tbody>${recordRows(snap.records, snap.dmarc)}</tbody></table>
  <h3>Is it actually serving?</h3>${liveRows(snap.live) || '<p class="muted">Serving was not probed on this run.</p>'}
</div>
</div></body></html>`;
}

module.exports = { render };
