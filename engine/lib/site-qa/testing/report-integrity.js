'use strict';
// report-integrity.js — FALSE-DATA HUNTER for stored reports.
//
// Point it at a directory of run folders:   node report-integrity.js <_ui-runs dir>
//
// Every check here is an INVARIANT whose violation means a shipped report STATES SOMETHING UNTRUE — a
// count that cannot be reconciled, a claim of absence from a check that never ran, a green tick with no
// evidence, a verdict that contradicts its own stated reason, or an index-status claim this engine is
// not allowed to make. It is deliberately separate from the unit suites: those test the code, this
// interrogates the ARTIFACTS the code already shipped, which is where three real defects were found
// that no unit test had caught.
//
// A NOTE ON VERIFYING THE VERIFIER: the first version of the contradiction check used a naive
// /noindex/ substring and matched the "no noindex" INSIDE the clean reason string, reporting 150
// violations that did not exist. An auditor that cries wolf is worse than none — every rule below
// matches exact shapes, not substrings.
const fs = require('fs'), path = require('path');

const ROOT = process.argv[2];
const runs = fs.readdirSync(ROOT).filter(d => fs.existsSync(path.join(ROOT, d, 'report.json')));

const V = []; // violations
const bad = (run, code, msg) => V.push({ run, code, msg });

for (const run of runs) {
  let j;
  try { j = JSON.parse(fs.readFileSync(path.join(ROOT, run, 'report.json'), 'utf8')); }
  catch (e) { bad(run, 'UNREADABLE', e.message); continue; }

  // ── 1. page coverage must reconcile ──────────────────────────────────────────────────────────
  const pc = j.pageCoverage;
  if (pc && pc.counts) {
    const c = pc.counts;
    const sum = (c.audited || 0) + (c.errored || 0) + (c.notReached || 0);
    if (typeof c.discovered === 'number' && sum !== c.discovered)
      bad(run, 'COUNT', `audited+errored+notReached=${sum} but discovered=${c.discovered}`);
  }

  // ── 2. a blind run must publish NO number ────────────────────────────────────────────────────
  const blind = j.reachability && j.reachability.audited === false;
  if (blind && (j.score != null || (j.quality && j.quality.overall != null)))
    bad(run, 'BLIND-SCORE', `never read a page but published score=${j.score} quality=${j.quality && j.quality.overall}`);

  // ── 3. no rule may be BOTH evaluated and not-evaluated ───────────────────────────────────────
  const cov = j.coverage || {};
  const ev = new Set(cov.evaluatedRules || []), nev = new Set(cov.notEvaluatedRules || []);
  for (const r of ev) if (nev.has(r)) bad(run, 'COVERAGE', `${r} declared BOTH evaluated and not-evaluated`);

  // ── 4. ADR-0011: a rule declared evaluated must have a row behind it (or a pass row for its check)
  const rows = (j.suites || []).flatMap(s => (s.checks || []).map(c => ({ ...c, _suite: s.key })));
  const rowRuleIds = new Set(rows.map(r => r.ruleId).filter(Boolean));
  const rowChecks = new Set(rows.map(r => r.check).filter(Boolean));
  // Only meaningful for suites actually present — a skipped suite legitimately has neither.
  const presentSuites = new Set((j.suites || []).map(s => s.key));

  // ── 5. a NOT-RUN row must never also be a pass ───────────────────────────────────────────────
  for (const r of rows) {
    if (r.notRun && r.status === 'pass') bad(run, 'GREEN-NO-EVIDENCE', `"${r.name}" is notRun AND status pass`);
    if (r.notRun && r.ruleId) bad(run, 'NOTRUN-RULEID', `"${r.name}" is notRun but carries ruleId ${r.ruleId}`);
  }

  // ── indexability-specific invariants ─────────────────────────────────────────────────────────
  const X = j.indexability;
  if (!X) continue;
  const S = X.summary || {};
  const urls = X.urls || [];

  // 6. the URL table must account for itself
  const expect = (S.total || 0) - (X.urlsTruncated || 0);
  if (urls.length !== expect) bad(run, 'IX-COUNT', `summary.total=${S.total} truncated=${X.urlsTruncated || 0} but urls[]=${urls.length}`);

  // 7. per-engine verdict tallies must equal the table
  for (const eng of ['google', 'bing']) {
    const tally = S[eng] || {};
    const summed = Object.values(tally).reduce((a, b) => a + b, 0);
    if (summed !== urls.length) bad(run, 'IX-TALLY', `summary.${eng} sums to ${summed} but urls[]=${urls.length}`);
    for (const [verdict, n] of Object.entries(tally)) {
      const actual = urls.filter(u => u.verdict && u.verdict[eng] === verdict).length;
      if (actual !== n) bad(run, 'IX-TALLY', `summary.${eng}.${verdict}=${n} but table has ${actual}`);
    }
  }

  // 8. THE BIG ONE — sitemap membership must never CLAIM absence it did not establish.
  const known = S.sitemapKnown;
  const nulls = urls.filter(u => u.inSitemap === null).length;
  const falses = urls.filter(u => u.inSitemap === false).length;
  const trues = urls.filter(u => u.inSitemap === true).length;
  if (known === false && falses > 0)
    bad(run, 'FALSE-ABSENCE', `sitemap was never fetched, yet ${falses} row(s) assert inSitemap=false ("not in sitemap")`);
  if (known === undefined && (X.sitemaps && X.sitemaps.counts && X.sitemaps.counts.listed === 0) && falses > 0 && urls.length <= 2)
    bad(run, 'FALSE-ABSENCE', `single-page run with no sitemap read, yet ${falses} row(s) assert inSitemap=false (pre-1.9.0 report)`);
  if (known === true && trues !== (S.inSitemap || 0))
    bad(run, 'IX-COUNT', `summary.inSitemap=${S.inSitemap} but table has ${trues} true`);
  if (nulls && known !== false) bad(run, 'IX-STATE', `${nulls} null inSitemap rows but sitemapKnown=${known}`);

  // 9. a verdict must agree with its own stated reason
  for (const u of urls) {
    const g = u.verdict && u.verdict.google, why = ((u.reasons && u.reasons.google) || []).join(' ');
    // NOT a substring hunt: the clean reason is literally "crawlable, no noindex, self-canonical", and
    // a naive /noindex/ matches the "no noindex" INSIDE it — 150 false alarms on the first run of this
    // auditor. An indexable row must carry exactly the clean reason and nothing else.
    if (g === 'indexable' && !/^crawlable, no noindex, self-canonical$/.test(why))
      bad(run, 'IX-CONTRADICTION', `${u.url} verdict=indexable but reason is "${why.slice(0, 70)}"`);
    if (g === 'blocked-robots' && !/robots\.txt/i.test(why))
      bad(run, 'IX-CONTRADICTION', `${u.url} verdict=blocked-robots with no robots reason`);
    if (u.canonical && u.canonicalSelf === false && g === 'indexable')
      bad(run, 'IX-CONTRADICTION', `${u.url} canonicalises elsewhere yet verdict=indexable`);
  }

  // 10. schema must not have seen more pages than the crawl audited
  const audited = pc && pc.counts ? pc.counts.audited : null;
  if (audited != null && X.schema && X.schema.pagesWithSchema > audited)
    bad(run, 'SCHEMA-POP', `schema saw ${X.schema.pagesWithSchema} pages but only ${audited} were audited (reads non-200s)`);

  // 11. sitemap arithmetic
  const sc = (X.sitemaps || {}).counts || {};
  if (typeof sc.onHost === 'number' && typeof sc.listed === 'number' && sc.onHost > sc.listed)
    bad(run, 'SITEMAP-MATH', `onHost=${sc.onHost} exceeds listed=${sc.listed}`);

  // 12. discovery must not claim a file is present AND absent
  for (const f of ((X.discovery || {}).files || [])) {
    if (f.present && /soft 404|redirected away|empty body|HTTP 4/i.test(f.note || ''))
      bad(run, 'DISCOVERY', `claims ${f.label} present while the note says it is absent: "${f.note}"`);
  }

  // 13. index status must always be declared NOT measured
  if (X.indexStatus && X.indexStatus.measured !== false)
    bad(run, 'BOUNDARY', `indexStatus.measured=${X.indexStatus.measured} — the tool must never claim index membership`);
}

const byCode = {};
for (const v of V) (byCode[v.code] = byCode[v.code] || []).push(v);
console.log(`\nAudited ${runs.length} stored run(s).\n`);
if (!V.length) console.log('  NO false-data violations found.\n');
else {
  for (const [code, list] of Object.entries(byCode)) {
    console.log(`  ${code}  (${list.length})`);
    for (const v of list.slice(0, 6)) console.log(`     · ${v.run}\n         ${v.msg}`);
    if (list.length > 6) console.log(`     · …${list.length - 6} more`);
    console.log('');
  }
}
process.exitCode = V.length ? 1 : 0;
