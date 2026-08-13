'use strict';
// dns/cli.js — the operator surface. Two commands, matching the two moments that matter.
//
//   node lib/dns/cli.js capture <host> [--dir <baselines>]
//   node lib/dns/cli.js verify  <host> [--dir <baselines>] [--target <ip|host>] [--old-ns a,b] [--json]
//   node lib/dns/cli.js recover <host> --old-ns ns1.old.com,ns2.old.com [--dir <baselines>]
//   node lib/dns/cli.js list            [--dir <baselines>]
//
// `recover` is the after-the-fact path: no baseline was captured, but the replaced nameservers are
// usually still serving the old zone, so one can be reconstructed from them. `verify --old-ns` does
// the same thing inline when no captured baseline is on disk.
//
// EXIT CODES ARE THE CONTRACT: 0 clean · 1 launch-blocking finding · 2 could not run. A CI step or
// a cutover runbook needs to branch on the result without parsing prose, and a tool that always
// exits 0 gets wired into a pipeline that can never fail.

const path = require('node:path');
const os = require('node:os');
const dns = require('./index');
const snapshot = require('./snapshot');
const recover = require('./recover');

const argv = process.argv.slice(2);
const cmd = argv[0];
const host = argv[1] && !argv[1].startsWith('--') ? argv[1] : null;
const flag = (n, def) => {
  const i = argv.indexOf('--' + n);
  if (i < 0) return def;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};

const DEFAULT_DIR = path.join(
  process.env.SGEN_DNS_BASELINES || path.join(process.env.APPDATA || os.homedir(), 'SGEN Site QA'),
  'dns-baselines',
);

const SEV_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };
const MARK = { critical: '✗', high: '✗', medium: '!', low: '·' };

function printFindings(findings) {
  if (!findings.length) { console.log('\n  no findings'); return; }
  const sorted = [...findings].sort((a, b) => (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9));
  console.log('');
  for (const f of sorted) {
    console.log(`  ${MARK[f.severity] || '·'} [${f.ruleId}] ${f.title}${f.readiness === 1 ? '  (blocks cutover)' : ''}`);
    console.log(`      ${f.detail}`);
    // The impact line is printed for the blocking ones only. On a clean-ish run it is useful
    // context; on a long list it is the difference between a report someone reads and one they skip.
    if (f.readiness === 1 && f.impact) console.log(`      → ${f.impact}`);
  }
}

function printLive(live) {
  if (!live) return;
  for (const [, r] of Object.entries(live)) {
    if (!r) continue;
    const addrs = (r.ips || []).map((i) => {
      const cert = i.cert && i.cert.present ? (i.cert.covers ? `cert ok${i.cert.daysLeft != null ? ` (${i.cert.daysLeft}d)` : ''}` : 'cert MISMATCH') : '';
      return `      ${i.ip}  ${i.ok ? `HTTP ${i.status}` : i.error}  ${i.ms}ms  ${cert}`;
    });
    console.log(`   ${r.hostname}: ${r.verdict}`);
    addrs.forEach((a) => console.log(a));
  }
}

(async () => {
  const dir = String(flag('dir', DEFAULT_DIR));
  try {
    if (cmd === 'list') {
      const rows = snapshot.list(dir);
      if (!rows.length) { console.log(`no baselines in ${dir}`); return process.exit(0); }
      console.log(`baselines in ${dir}:`);
      rows.forEach((r) => console.log(`  ${r.capturedAt}  ${r.host}  (${r.file})`));
      return process.exit(0);
    }

    if (!host) {
      console.error('usage: node lib/dns/cli.js capture|verify <host> [--dir <baselines>] [--target <ip|host>] [--json]');
      return process.exit(2);
    }

    if (cmd === 'capture') {
      const res = await dns.capture(host, { dir });
      if (flag('json')) { console.log(JSON.stringify(res, null, 2)); return process.exit(0); }
      const s = res.snapshot;
      console.log(`\nBASELINE  ${s.host}   ${s.capturedAt}`);
      console.log(`  resolvers: ${s.resolvers.join(', ')}`);
      for (const [t, r] of Object.entries(s.records)) {
        const val = r.status === 'ok' ? r.values.join(' · ') : r.status;
        const agree = r.agreed === true ? '' : r.agreed === false ? '  ⚠ resolvers disagree' : '  ⚠ unverified';
        console.log(`  ${t.padEnd(6)} ${val}${r.ttl != null ? `   ttl ${r.ttl}s` : ''}${agree}`);
      }
      console.log(`  ${'DMARC'.padEnd(6)} ${s.dmarc.status === 'ok' ? s.dmarc.values.join(' · ') : s.dmarc.status}`);
      printLive(s.live);
      printFindings(res.findings);
      console.log(`\n  saved → ${res.file}`);
      // A capture is a recording, not a gate: it must not fail a pipeline for pre-existing state.
      return process.exit(0);
    }

    if (cmd === 'recover') {
      const ns = String(flag('old-ns', '')).split(/[,\s]+/).filter(Boolean);
      if (!ns.length) { console.error('recover needs --old-ns ns1.old.com,ns2.old.com'); return process.exit(2); }
      const rec = await recover.recover(host, ns, {});
      if (!rec.ok) { console.error(`\n  cannot recover: ${rec.error}`); return process.exit(1); }
      const s = rec.snapshot;
      console.log(`\nRECOVERED ZONE  ${s.host}   read ${s.capturedAt}`);
      console.log(`  from: ${s.resolvers.join(', ')}   SOA serial ${rec.zone.serial}`);
      console.log('  NOTE: this is what the old nameservers hold TODAY, not a recording taken before the cutover.');
      for (const [t, r] of Object.entries(s.records)) {
        console.log(`  ${t.padEnd(6)} ${r.status === 'ok' ? r.values.join(' · ') : r.status}`);
      }
      if (s.subdomains.length) {
        console.log(`\n  subdomains found in the old zone (${s.subdomains.length}):`);
        s.subdomains.forEach((x) => console.log(`    ${x.name.padEnd(38)} ${(x.records.A || x.records.CNAME || []).join(', ')}`));
        const rows = await recover.compareSubdomains(s, {});
        const gone = rows.filter((r) => r.state === 'dropped');
        console.log(`\n  ${gone.length} of them no longer resolve on the current nameservers:`);
        gone.forEach((r) => console.log(`    ✗ ${r.name.padEnd(38)} was ${r.was.join(', ')}`));
      }
      const file = snapshot.save(s, dir);
      console.log(`\n  saved as a baseline → ${file}`);
      console.log(`  now run:  node lib/dns/cli.js verify ${s.host} --dir "${dir}"`);
      return process.exit(0);
    }

    if (cmd === 'verify') {
      const oldNs = String(flag('old-ns', '')).split(/[,\s]+/).filter(Boolean);
      const res = await dns.verify(host, { dir, expectedTarget: flag('target', null), oldNameservers: oldNs });
      if (flag('json')) { console.log(JSON.stringify(res, null, 2)); return process.exit(res.verdict.state === 'blocked' ? 1 : 0); }
      console.log(`\nVERIFY  ${res.host}`);
      console.log(res.baseline
        ? `  baseline: ${res.baseline.capturedAt}  (${res.baseline.source}, ${path.basename(res.baseline.file)})`
        : `  baseline: NONE FOUND in ${dir} — deleted records cannot be detected without one`);
      if (res.recovered && !res.recovered.ok) console.log(`  recovery: failed — ${res.recovered.error}`);
      if (res.subdomains && res.subdomains.length) {
        const gone = res.subdomains.filter((r) => r.state === 'dropped');
        console.log(`  subdomains: ${res.subdomains.length} probed in the old zone, ${gone.length} no longer resolve`);
      }
      if (res.diff) {
        console.log('\n  record changes vs baseline:');
        for (const [t, d] of Object.entries(res.diff.records)) {
          if (d.state === 'unchanged') continue;
          console.log(`    ${t.padEnd(6)} ${d.state.toUpperCase().padEnd(9)} ${(d.before || []).join(' · ') || '—'}  →  ${(d.after || []).join(' · ') || '—'}`);
        }
        if (res.diff.dmarc.state !== 'unchanged') {
          console.log(`    DMARC  ${res.diff.dmarc.state.toUpperCase()}`);
        }
      }
      console.log('');
      printLive(res.current.live);
      printFindings(res.findings);
      console.log(`\n  VERDICT: ${res.verdict.state.toUpperCase()} — ${res.verdict.note}`);
      return process.exit(res.verdict.state === 'blocked' ? 1 : 0);
    }

    console.error(`unknown command "${cmd}"`);
    return process.exit(2);
  } catch (e) {
    console.error('dns check failed to run:', (e && e.stack) || e);
    return process.exit(2);
  }
})();
