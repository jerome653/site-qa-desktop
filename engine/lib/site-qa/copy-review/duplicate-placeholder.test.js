'use strict';
// duplicate-placeholder.test.js — the two content gaps Jerome named on 2026-07-30.
//
// 1. PLACEHOLDER COPY WAS INVISIBLE TO THE CONTENT TAB. FUNC-004 catches lorem ipsum / "your text
//    here" / TODO markers, but it lives in the FUNCTIONAL suite, and a Content & SEO run skips every
//    suite except 'seo'. So the tab named for content was the one blind to placeholder copy, while
//    Site Audit caught it. A rule toggle cannot fix that — the whole suite is skipped at run level.
//
// 2. DUPLICATE CONTENT MEANT TITLES AND DESCRIPTIONS ONLY. SEO-009/010 compare <title> and
//    <meta description> across pages. Nothing ever compared the BODY COPY, so two pages with
//    word-for-word identical text passed clean.
//
// Both land in Copy Review (advisory, WEIGHTS.copy = 0, every row status 'manual'), because that is
// the suite that actually runs in Content & SEO and because neither is a defect the tool should score
// on the author's behalf — near-duplicate copy is sometimes deliberate.
//
// Written BEFORE the implementation and watched failing.
let pass = 0; const fails = [];
const ok = (c, n) => { if (c) pass++; else fails.push(n); };
const eq = (a, b, n) => ok(a === b, n + ` (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
const has = (s, re, n) => ok(re.test(String(s)), n + ` (got "${String(s).slice(0, 80)}")`);

console.log('\nCopy Review — placeholder copy and duplicate body content\n');

const REG = require('../rules/registry');
const { scanCopyReview, RULE_IDS } = require('./index');

// ── the two new rules exist and are advisory ──────────────────────────────────────────────────────
for (const id of ['COPY-005', 'COPY-006']) {
  const r = REG.getById(id);
  ok(!!r, `${id} is registered`);
  if (r) {
    eq(r.suite, 'copy', `${id} lives in the copy suite`);
    eq(r.severity, 'manual', `${id} is severity manual — it can never move a score`);
    eq(r.deduction, 0, `${id} carries deduction 0`);
  }
  ok(RULE_IDS.includes(id), `${id} is emitted by scanCopyReview`);
}

const page = (url, body) => ({ url, html: `<html><body><main>${body}</main></body></html>` });
// Missing rule -> a MISSING marker object rather than undefined. A test that throws on an absent
// feature reports a stack trace instead of a red line, and a stack trace does not say which
// assertions would have failed.
const MISSING = { items: [], detail: '(rule not emitted)', status: '(none)', __missing: true };
const rowOf = (rows, id) => rows.find(r => r.ruleId === id) || MISSING;

// ── COPY-005 · placeholder copy ───────────────────────────────────────────────────────────────────
{
  const rows = scanCopyReview([page('/a', '<p>Lorem ipsum dolor sit amet, consectetur adipiscing elit and so on.</p>')]);
  const r = rowOf(rows, 'COPY-005');
  ok(!!r, 'COPY-005 row is produced');
  if (r) {
    eq(r.status, 'manual', 'COPY-005 is manual even when it finds something');
    ok(r.items.length > 0, 'COPY-005 flags lorem ipsum');
    has(JSON.stringify(r.items), /lorem ipsum/i, 'the flagged item names what it saw');
  }
  const clean = rowOf(scanCopyReview([page('/a', '<p>Real copy written by a person about a real subject.</p>')]), 'COPY-005');
  eq(clean.items.length, 0, 'clean copy raises no placeholder flag');
  has(clean.detail, /clean/i, 'a clean placeholder row says so');

  // the other markers FUNC-004 knows about must be caught by the SAME detector, not a second copy
  const markers = [
    ['<p>Your text here for now.</p>', 'your-text-here'],
    ['<p>This is sample text pending review.</p>', 'sample text'],
    ['<p>TODO: write the real intro.</p>', 'TODO marker'],
  ];
  for (const [body, label] of markers) {
    const rr = rowOf(scanCopyReview([page('/p', body)]), 'COPY-005');
    ok(rr.items.length > 0, `COPY-005 flags ${label}`);
  }
  const cs = require('../../migration-qa/checks-static');
  ok(typeof cs.detectPlaceholders === 'function',
    'checks-static exports detectPlaceholders — ONE detector shared with FUNC-004, not a second implementation');
}

// ── COPY-006 · duplicate body content across pages ────────────────────────────────────────────────
{
  const body = '<p>' + 'The quick brown fox jumps over the lazy dog near the riverbank every single morning. '.repeat(6) + '</p>';
  const other = '<p>' + 'Completely different words about an unrelated subject entirely, written separately. '.repeat(6) + '</p>';

  const dup = rowOf(scanCopyReview([page('/a', body), page('/b', body)]), 'COPY-006');
  ok(!!dup, 'COPY-006 row is produced');
  eq(dup.status, 'manual', 'COPY-006 is manual — near-duplicate copy is sometimes deliberate');
  ok(dup.items.length > 0, 'two identical pages are flagged as duplicates');
  has(JSON.stringify(dup.items), /\/a/, 'the flagged pair names the first page');
  has(JSON.stringify(dup.items), /\/b/, 'the flagged pair names the second page');
  has(JSON.stringify(dup.items), /100|9[0-9]/, 'the item carries a similarity percentage');

  const distinct = rowOf(scanCopyReview([page('/a', body), page('/b', other)]), 'COPY-006');
  eq(distinct.items.length, 0, 'two different pages are NOT flagged');

  // one page cannot duplicate anything — and must not crash or self-match
  const single = rowOf(scanCopyReview([page('/a', body)]), 'COPY-006');
  eq(single.items.length, 0, 'a single page never matches itself');
  has(single.detail, /one page|clean|not applicable/i, 'a single-page run says why there is nothing to compare');

  // short pages are noise: nav-only or stub pages trivially "match" and would drown the real signal
  const stub = '<p>Contact us.</p>';
  const stubs = rowOf(scanCopyReview([page('/a', stub), page('/b', stub)]), 'COPY-006');
  eq(stubs.items.length, 0, 'pages below the word floor are not compared — stubs would swamp the signal');

  // a pair is reported ONCE, not twice (a~b and b~a are the same finding)
  const three = rowOf(scanCopyReview([page('/a', body), page('/b', body), page('/c', other)]), 'COPY-006');
  eq(three.items.length, 1, 'each duplicate PAIR is reported once, not in both directions');
}

// ── score neutrality, measured ────────────────────────────────────────────────────────────────────
{
  const { compute } = require('../score');
  const rows = scanCopyReview([page('/a', '<p>Lorem ipsum dolor sit amet.</p>'), page('/b', '<p>Lorem ipsum dolor sit amet.</p>')]);
  const suites = [{ key: 'seo', name: 'SEO', checks: [{ status: 'pass', name: 'x', ruleId: 'SEO-001', suite: 'seo' }] }];
  const withCopy = compute(suites.concat([{ key: 'copy', name: 'Copy Review', advisory: true, checks: rows }]), { evaluatedRules: ['SEO-001'] });
  const without = compute(suites, { evaluatedRules: ['SEO-001'] });
  eq(withCopy.overall, without.overall, 'adding the two new rules does not move the score — measured, not assumed');
}

console.log(fails.length ? `\n❌ FAIL — ${pass} passed, ${fails.length} failed\n` : `\n✅ PASS — ${pass}/${pass} assertions\n`);
for (const f of fails) console.log('   ✗ ' + f);
process.exitCode = fails.length ? 1 : 0;
