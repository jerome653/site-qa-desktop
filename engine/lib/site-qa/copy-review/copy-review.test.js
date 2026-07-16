'use strict';
// copy-review.test.js — deterministic suite for Suite 13 "Copy Review" (COPY-001..004). Plain node, no
// framework. Verifies each detector fires on a true positive, stays silent on clean human marketing
// copy (the false-positive guard — real assertions that would FAIL if the detector over-fired), that
// code/pre examples never leak into prose, that COPY-004 respects its size gate and does not fire on
// naturally varied-length copy, and that every emitted row is score-neutral (status 'manual', COPY-00N
// ruleId) even when items were found.
const REG = require('../rules/registry');
const { detect } = require('./checks');
const { scanCopyReview, RULE_IDS } = require('./index');

let pass = 0, fail = 0; const failures = [];
function ok(c, n) { if (c) pass++; else { fail++; failures.push(n); console.log('  ✗ ' + n); } }
function eq(a, b, n) { ok(JSON.stringify(a) === JSON.stringify(b), n + (JSON.stringify(a) === JSON.stringify(b) ? '' : ` (got ${JSON.stringify(a)})`)); }

const U = 'https://demo-site.example.com/';
const ids = prose => new Set(detect({ url: U, prose }).map(i => i.id));
const has = (prose, id) => ids(prose).has(id);

// Build N paragraphs of near-identical word count (all `count` words) — used to trip COPY-004.
const para = n => Array.from({ length: n }, (_, i) => 'wordtoken' + (i % 9)).join(' ');
const htmlOfParas = counts => counts.map(n => `<p>${para(n)}</p>`).join('');

console.log('Copy Review (COPY-001..004) — test suite\n');

// -- registry integration: COPY-001..004 exist, are in the 'copy' suite, and are manual/deduction-0 --
(function registry() {
  for (const id of RULE_IDS) {
    const r = REG.getById(id);
    ok(!!r, `registry: ${id} exists`);
    if (!r) continue;
    eq(r.suite, 'copy', `registry: ${id} is in the 'copy' suite`);
    eq(r.severity, 'manual', `registry: ${id} severity is 'manual'`);
    eq(r.manual, true, `registry: ${id} manual flag is true`);
    eq(r.deduction, 0, `registry: ${id} deduction is 0`);
  }
  eq(REG.WEIGHTS.copy, 0, `registry: WEIGHTS.copy is 0 (advisory, never affects overall score)`);
})();

// -- COPY-001 llm-boilerplate-leak: fires on true positives --
(function copy001() {
  ok(has('As an AI language model, I cannot provide personal opinions.', 'llm-boilerplate-leak'),
    'COPY-001: "as an AI language model" fires');
  ok(has("I'm sorry, but I can't help with that request.", 'llm-boilerplate-leak'),
    'COPY-001: "I\'m sorry, but I can\'t" fires');
  ok(has('As of my last training update, that feature did not exist.', 'llm-boilerplate-leak'),
    'COPY-001: "as of my last training update" fires');
  ok(has("Certainly! Here's the rewritten version of your paragraph:", 'llm-boilerplate-leak'),
    'COPY-001: "Certainly! Here\'s..." fires');
  ok(has('Here is the revised version of the section you asked about.', 'llm-boilerplate-leak'),
    'COPY-001: "here is the revised version" fires');
})();

// -- COPY-002 unresolved-authoring-placeholder: fires on true positives --
(function copy002() {
  ok(has('Please have [INSERT CLIENT NAME] review this before it goes live.', 'unresolved-authoring-placeholder'),
    'COPY-002: "[INSERT ...]" fires');
  ok(has('Email us anytime at [YOUR EMAIL ADDRESS] for support.', 'unresolved-authoring-placeholder'),
    'COPY-002: "[YOUR ...]" fires');
  ok(has('Founded in 1998, [COMPANY NAME] has served the region ever since.', 'unresolved-authoring-placeholder'),
    'COPY-002: "[COMPANY ...]" fires');
  ok(has('TODO: write the closing paragraph before launch.', 'unresolved-authoring-placeholder'),
    'COPY-002: "TODO:" fires');
  ok(has('The venue drew TK attendees on opening night.', 'unresolved-authoring-placeholder'),
    'COPY-002: journalism "TK" placeholder fires');
  ok(has('FIXME the pricing table before this ships.', 'unresolved-authoring-placeholder'),
    'COPY-002: "FIXME" fires');
  ok(has('Serial number XXXXXX was left in the draft.', 'unresolved-authoring-placeholder'),
    'COPY-002: "XXXX+" fires');
})();

// -- COPY-003 ai-tell-phrasing: fires on true positives, and reports count + density in the row --
(function copy003() {
  ok(has("In today's fast-paced digital world, it's important to note that timing matters.", 'ai-tell-phrasing'),
    'COPY-003: "in today\'s fast-paced digital world" + "it\'s important to note" fire');
  ok(has('Our platform lets you delve into every detail of your account.', 'ai-tell-phrasing'),
    'COPY-003: "delve into" fires');
  ok(has('This upgrade will unlock the potential of your whole team.', 'ai-tell-phrasing'),
    'COPY-003: "unlock the potential" fires');
  ok(has('Ready to elevate your workflow? Start today.', 'ai-tell-phrasing'),
    'COPY-003: "elevate your" fires');
  ok(has('Our new app helps you navigate the complex world of taxes.', 'ai-tell-phrasing'),
    'COPY-003: "navigate the complex" fires');
  ok(has('The award is a testament to years of hard work.', 'ai-tell-phrasing'),
    'COPY-003: "a testament to" fires');
  ok(has('In the realm of modern finance, speed matters.', 'ai-tell-phrasing'),
    'COPY-003: "in the realm of" fires');
  ok(has('The new checkout seamlessly integrates with your existing store.', 'ai-tell-phrasing'),
    'COPY-003: "seamlessly integrat-" fires');
  ok(has('We built a robust solution for growing teams.', 'ai-tell-phrasing'),
    'COPY-003: "robust solution" fires');

  const row = scanCopyReview([{ url: U, prose: 'Teams delve into reports daily. Later they delve into forecasts too, over and over, in a two-hundred word page.' }])
    .find(r => r.ruleId === 'COPY-003');
  ok(row.items.length === 2, 'COPY-003: two occurrences of "delve into" both counted as items');
  ok(/2 phrase\(s\)/.test(row.detail), 'COPY-003: detail reports the count');
  ok(/per 1000 words/.test(row.detail), 'COPY-003: detail reports a per-1000-words density');
})();

// -- COPY-001/002/003 do NOT fire on clean human marketing copy (false-positive guard) --
(function cleanCopy() {
  const clean1 = "Our bakery has served fresh bread since 1998. We're sorry if a delivery runs late "
    + '— call us and we will make it right. Every loaf is baked fresh each morning using local flour, '
    + 'and our team is proud of the work. Order online or visit us on Main Street any day this week.';
  ok(!has(clean1, 'llm-boilerplate-leak'), 'clean: "We\'re sorry if a delivery" does not trip COPY-001 (needs "I\'m sorry, but I can\'t/as an AI")');
  ok(!has(clean1, 'unresolved-authoring-placeholder'), 'clean: no placeholder syntax in ordinary copy');
  ok(!has(clean1, 'ai-tell-phrasing'), 'clean: no AI-tell cliches in ordinary bakery copy');

  const clean2 = 'This detail is important for your safety, so please read the label before you start. '
    + 'Pricing starts at $20 and covers delivery within the city. Contact our office for a full quote, '
    + 'terms apply, and our team will confirm your appointment within one business day.';
  ok(!has(clean2, 'ai-tell-phrasing'), 'clean: "is important" without "it\'s ... to note" does not trip COPY-003');
  ok(!has(clean2, 'unresolved-authoring-placeholder'), 'clean: "$20" / "terms apply" do not trip COPY-002');
  ok(!has(clean2, 'llm-boilerplate-leak'), 'clean: plain paragraph does not trip COPY-001');

  // lorem ipsum is FUNC-004's job, not ours — must stay silent here
  const lorem = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt.';
  eq([...ids(lorem)].filter(id => id !== 'uniform-paragraph-rhythm'), [], 'clean: lorem ipsum is not duplicated here (FUNC-004 owns it)');
})();

// -- prose extraction: the same phrase inside <code>/<pre> does NOT fire; the same leak in real prose still does --
(function codeExcluded() {
  const htmlCode = '<h1>Docs</h1><p>Example assistant reply, for illustration only:</p>'
    + '<pre><code>As an AI language model, I cannot do that.</code></pre><p>All good.</p>';
  const items = detect({ url: U, html: htmlCode });
  ok(!items.some(i => i.id === 'llm-boilerplate-leak'), 'code: boilerplate phrase inside <pre><code> does NOT false-positive');

  const htmlLeak = '<p>As an AI language model, I cannot do that.</p><code>ignored [INSERT TOKEN] text</code>';
  const items2 = detect({ url: U, html: htmlLeak });
  ok(items2.some(i => i.id === 'llm-boilerplate-leak'), 'code: a real leak in prose still fires (code block ignored)');
  ok(!items2.some(i => i.id === 'unresolved-authoring-placeholder'), 'code: placeholder-looking text inside <code> does NOT false-positive');
})();

// -- COPY-004 uniform-paragraph-rhythm: size gate + real true/false positives --
(function copy004() {
  // True positive: 10 paragraphs of exactly 35 words each -> 350 words, CV = 0 (< 0.18) -> fires.
  const uniformHtml = htmlOfParas(Array(10).fill(35));
  ok(has_html(uniformHtml, 'uniform-paragraph-rhythm'), 'COPY-004: 10 uniform 35-word paragraphs fires');

  // False positive guard: same uniform shape but only 3 paragraphs (below MIN_PARAGRAPHS) -> must NOT fire.
  const shortHtml = htmlOfParas(Array(3).fill(35));
  ok(!has_html(shortHtml, 'uniform-paragraph-rhythm'), 'COPY-004: short page (3 paragraphs) does NOT fire even though uniform');

  // False positive guard: 10 paragraphs, >=300 words, but naturally varied lengths (CV well above 0.18) -> must NOT fire.
  const variedCounts = [10, 60, 15, 70, 20, 65, 12, 55, 18, 75]; // sum 400, mean 40, cv ~0.64
  const variedHtml = htmlOfParas(variedCounts);
  ok(!has_html(variedHtml, 'uniform-paragraph-rhythm'), 'COPY-004: varied-rhythm copy (CV >= 0.18) does NOT fire');

  function has_html(html, id) { return detect({ url: U, html }).some(i => i.id === id); }
})();

// -- score-neutrality guard: every emitted row is status 'manual' with a COPY-00N ruleId, ALWAYS --
(function scoreNeutrality() {
  const dirtyCtx = {
    url: U,
    html: '<p>As an AI language model, I cannot do that.</p>'
      + '<p>Please have [INSERT CLIENT NAME] review this before it goes live.</p>'
      + '<p>Our platform lets you delve into every detail of your account.</p>'
      + htmlOfParas(Array(10).fill(35)),
  };
  const dirtyRows = scanCopyReview([dirtyCtx]);
  eq(dirtyRows.length, 4, 'rows: scanCopyReview returns exactly 4 rows (COPY-001..004)');
  const withItems = dirtyRows.filter(r => r.items.length > 0);
  ok(withItems.length >= 3, 'rows: at least 3 of the 4 rules actually found something on the dirty fixture');
  for (const row of dirtyRows) {
    ok(/^COPY-00[1-4]$/.test(row.ruleId), `rows: ${row.ruleId} matches the COPY-00N pattern`);
    // The critical guard: status must stay 'manual' even though items.length > 0 for this row. A
    // regression that copies content-artifacts' `items.length ? fail : pass` pattern would break this.
    eq(row.status, 'manual', `rows: ${row.ruleId} status is 'manual' even with ${row.items.length} item(s) found`);
    eq(row.deduction, 0, `rows: ${row.ruleId} deduction is 0`);
    eq(row.severity, 'manual', `rows: ${row.ruleId} severity is 'manual'`);
    ok(!/is AI-generated|is AI-written|is written by AI/i.test(row.name + ' ' + row.detail),
      `rows: ${row.ruleId} title/detail never asserts the page IS AI-written`);
  }

  const cleanRows = scanCopyReview([{ url: U, prose: 'A perfectly ordinary, short, clean sentence.' }]);
  for (const row of cleanRows) {
    eq(row.status, 'manual', `rows: ${row.ruleId} status is 'manual' on clean content too`);
    eq(row.items.length, 0, `rows: ${row.ruleId} has no items on clean content`);
  }
})();

// -- determinism --
(function determinism() {
  const ctx = { url: U, prose: "As an AI language model, here's the revised version: [INSERT NAME]." };
  eq(detect(ctx), detect(ctx), 'determinism: detect() is repeatable on the same input');
  eq(scanCopyReview([ctx]), scanCopyReview([ctx]), 'determinism: scanCopyReview() is repeatable on the same input');
})();

console.log('\n' + (fail === 0 ? '✅ PASS' : '❌ FAIL') + ` — ${pass}/${pass + fail} assertions`);
if (fail) { console.log('Failures:\n' + failures.map(f => '  - ' + f).join('\n')); process.exit(1); }
