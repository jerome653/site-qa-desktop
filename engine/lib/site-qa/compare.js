'use strict';
// site-qa/compare.js — deterministic diff of two qa-site scan results (live vs staging, or a fresh
// scan vs a saved reference baseline). Pure code, no AI. Every transition is derived from the two
// real result JSONs — nothing inferred. Also owns the baseline store (save/resolve).

const fs = require('fs');
const path = require('path');

const BASELINES = path.resolve(__dirname, '..', '..', '..', 'sgen', 'W5-Live-Surface-Audit', 'site-qa', '_baselines');

function saveBaseline(data, label) {
  fs.mkdirSync(BASELINES, { recursive: true });
  const safe = String(label).replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'baseline';
  const file = path.join(BASELINES, safe + '.json');
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return file;
}

// Resolve a reference to a report.json object. Accepts: a .json path, a dir containing report.json,
// or a bare baseline label in the store.
function loadResult(ref) {
  const tries = [];
  if (/\.json$/i.test(ref)) tries.push(ref);
  else { tries.push(path.join(ref, 'report.json')); tries.push(path.join(BASELINES, ref + '.json')); tries.push(ref); }
  for (const t of tries) { if (fs.existsSync(t) && fs.statSync(t).isFile()) return { data: JSON.parse(fs.readFileSync(t, 'utf8')), source: t }; }
  throw new Error(`could not resolve scan reference: ${ref} (looked in ${tries.join(', ')})`);
}

function listBaselines() {
  if (!fs.existsSync(BASELINES)) return [];
  return fs.readdirSync(BASELINES).filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, ''));
}

// Auto-record EVERY scan to a per-domain history (light, no base64 screenshots) keyed by timestamp,
// plus an append-only _index.jsonl per host. This builds a running record of all scans, so any past
// scan is a reference you can compare against later.
const RECORDS = path.resolve(BASELINES, '..', '_records');
function recordScan(data) {
  const host = String(data.host || 'site').replace(/[^a-z0-9._-]+/gi, '-');
  const dir = path.join(RECORDS, host);
  fs.mkdirSync(dir, { recursive: true });
  const ts = String(data.generated || '').replace(/[:.]/g, '-') || 'scan';
  const file = path.join(dir, ts + '.json');
  const rec = {
    host: data.host, target: data.target, generated: data.generated, verdict: data.verdict,
    score: data.score, ready: data.ready, tally: data.tally,
    crawl: { pages: data.crawl && data.crawl.pages, htmlPages: data.crawl && data.crawl.htmlPages },
    render: { rendered: data.render && data.render.rendered, total: data.render && data.render.total },
    suites: (data.suites || []).map(s => ({ key: s.key, name: s.name, pass: s.pass, warn: s.warn, fail: s.fail, manual: s.manual, checks: s.checks })),
  };
  fs.writeFileSync(file, JSON.stringify(rec, null, 2));
  fs.appendFileSync(path.join(dir, '_index.jsonl'), JSON.stringify({ ts: data.generated, score: data.score, verdict: data.verdict, pass: data.tally.pass, warn: data.tally.warn, fail: data.tally.fail, file: path.basename(file) }) + '\n');
  return file;
}
function listRecords(host) {
  const dir = host ? path.join(RECORDS, String(host).replace(/[^a-z0-9._-]+/gi, '-')) : RECORDS;
  if (!fs.existsSync(dir)) return [];
  if (host) return fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort();
  return fs.readdirSync(dir);
}

// status rank for transition math; 'manual' is neutral (excluded from regression/fix).
const RANK = { pass: 0, warn: 1, fail: 2 };
const norm = (s) => String(s || '').toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();

// build a map key -> {status, name, suite} keeping the WORST status per key
function rowMap(result) {
  const m = {};
  for (const su of result.suites || []) for (const c of su.checks || []) {
    if (c.status === 'manual') continue;
    const key = su.key + '::' + norm(c.name);
    const rank = RANK[c.status];
    if (!(key in m) || rank > RANK[m[key].status]) m[key] = { status: c.status, name: c.name, suite: su.name };
  }
  return m;
}

function diff(a, b) {
  const A = rowMap(a), B = rowMap(b);
  const keys = new Set([...Object.keys(A), ...Object.keys(B)]);
  const regressed = [], fixed = [], newIssues = [], resolved = [], persisting = [];
  for (const k of keys) {
    const ra = A[k], rb = B[k];
    if (ra && rb) {
      if (RANK[rb.status] > RANK[ra.status]) regressed.push({ suite: rb.suite, name: rb.name, from: ra.status, to: rb.status });
      else if (RANK[rb.status] < RANK[ra.status]) fixed.push({ suite: rb.suite, name: rb.name, from: ra.status, to: rb.status });
      else if (rb.status !== 'pass') persisting.push({ suite: rb.suite, name: rb.name, status: rb.status });
    } else if (rb && !ra) { if (rb.status !== 'pass') newIssues.push({ suite: rb.suite, name: rb.name, status: rb.status }); }
    else if (ra && !rb) { if (ra.status !== 'pass') resolved.push({ suite: ra.suite, name: ra.name, status: ra.status }); }
  }
  const sortSev = (x, y) => (RANK[y.to || y.status] || 0) - (RANK[x.to || x.status] || 0);
  regressed.sort(sortSev); fixed.sort(sortSev); newIssues.sort(sortSev); resolved.sort(sortSev);

  // suite-level counts diff
  const suiteKeys = [...new Set([...(a.suites || []), ...(b.suites || [])].map(s => s.key))];
  const byKey = (r) => (r.suites || []).reduce((m, s) => (m[s.key] = s, m), {});
  const aS = byKey(a), bS = byKey(b);
  const suites = suiteKeys.map(k => {
    const sa = aS[k] || { name: k, pass: 0, warn: 0, fail: 0, manual: 0 }, sb = bS[k] || { name: k, pass: 0, warn: 0, fail: 0, manual: 0 };
    const dFail = sb.fail - sa.fail, dWarn = sb.warn - sa.warn;
    const trend = dFail > 0 ? 'regressed' : (dFail < 0 ? 'improved' : (dWarn > 0 ? 'regressed' : (dWarn < 0 ? 'improved' : 'same')));
    return { key: k, name: sb.name || sa.name, a: { pass: sa.pass, warn: sa.warn, fail: sa.fail, manual: sa.manual }, b: { pass: sb.pass, warn: sb.warn, fail: sb.fail, manual: sb.manual }, dFail, dWarn, trend };
  });

  const head = (r, lbl) => ({ label: lbl, target: r.target, host: r.host, score: r.score, verdict: r.verdict, tally: r.tally, generated: r.generated });
  return {
    a: head(a, a._label || 'A'), b: head(b, b._label || 'B'),
    scoreDelta: b.score - a.score,
    tallyDelta: { pass: b.tally.pass - a.tally.pass, warn: b.tally.warn - a.tally.warn, fail: b.tally.fail - a.tally.fail, manual: b.tally.manual - a.tally.manual },
    counts: { regressed: regressed.length, fixed: fixed.length, newIssues: newIssues.length, resolved: resolved.length, persisting: persisting.length },
    suites, regressed, fixed, newIssues, resolved, persisting,
    // B is "worse" if it introduced failures or regressions vs A
    worse: (b.tally.fail > a.tally.fail) || regressed.some(r => r.to === 'fail') || newIssues.some(r => r.status === 'fail'),
  };
}

module.exports = { diff, loadResult, saveBaseline, listBaselines, recordScan, listRecords, BASELINES, RECORDS };
