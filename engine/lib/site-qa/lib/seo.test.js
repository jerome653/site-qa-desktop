'use strict';
// seo.test.js — Batch 3 SEO rules. Run: node lib/seo.test.js
const { seoPageChecks, flesch } = require('./checks-seo');

let fails = 0, total = 0;
const ok = (c, m) => { total++; if (!c) { console.error('  FAIL:', m); fails++; } };
const ids = (ctx) => seoPageChecks({ url: 'https://x.test/p', isHtml: true, headers: {}, ...ctx }).map(f => f.ruleId);

// SEO-031 hreflang
ok(ids({ html: '<link rel="alternate" hreflang="en-US" href="/a"><link rel="alternate" hreflang="fr" href="/b">' }).includes('SEO-031'), 'SEO-031 no x-default');
ok(ids({ html: '<link rel="alternate" hreflang="english" href="/a">' }).includes('SEO-031'), 'SEO-031 invalid code');
ok(!ids({ html: '<link rel="alternate" hreflang="en" href="/a"><link rel="alternate" hreflang="x-default" href="/a">' }).includes('SEO-031'), 'valid hreflang + x-default → clean');
ok(seoPageChecks({ url: 'https://x.test/p', isHtml: true, headers: {}, html: '<p>no hreflang here</p>' }).filter(f => f.ruleId === 'SEO-031').length === 0, 'no hreflang → no SEO-031');

// SEO-035 noindex + cross-url canonical
ok(ids({ url: 'https://x.test/p', html: '<meta name="robots" content="noindex"><link rel="canonical" href="https://x.test/other">' }).includes('SEO-035'), 'SEO-035 noindex + cross canonical');
ok(!ids({ url: 'https://x.test/p', html: '<meta name="robots" content="noindex"><link rel="canonical" href="https://x.test/p">' }).includes('SEO-035'), 'noindex + self-canonical → no conflict');

// SEO-036 robots signal disagreement
ok(ids({ html: '<meta name="robots" content="noindex">', headers: { 'x-robots-tag': 'index' } }).includes('SEO-036'), 'SEO-036 meta vs header disagree');
ok(!ids({ html: '<meta name="robots" content="noindex">', headers: { 'x-robots-tag': 'noindex' } }).includes('SEO-036'), 'agreeing signals → clean');

// SEO-037 thin content (content page, < 100 words)
ok(ids({ html: '<main><p>Short page.</p></main>', prose: 'Short page.' }).includes('SEO-037'), 'SEO-037 thin content');
ok(!ids({ html: '<main><p>' + 'word '.repeat(150) + '</p></main>', prose: 'word '.repeat(150) }).includes('SEO-037'), 'enough words → no thin');
ok(!ids({ html: '<div>Short but not a content page</div>' }).includes('SEO-037'), 'non-content page → no thin');

// SEO-038 readability — very hard text scores low
const hard = 'The utilization of multifaceted interdisciplinary methodologies necessitates comprehensive epistemological reconceptualization notwithstanding institutional inertia. ' .repeat(6);
ok(ids({ html: '<article>' + hard + '</article>', prose: hard }).includes('SEO-038'), 'SEO-038 hard readability');
const easy = 'The cat sat on the mat. The dog ran fast. We had fun in the sun. It was a good day for all of us. ' .repeat(6);
ok(!ids({ html: '<article>' + easy + '</article>', prose: easy }).includes('SEO-038'), 'easy text → no SEO-038');

// flesch returns null on too-short text
ok(flesch('too short') === null, 'flesch null on short text');

if (fails) { console.error(`❌ FAIL — ${total - fails}/${total} assertions`); process.exit(1); }
console.log(`✅ PASS — ${total}/${total} assertions`);
