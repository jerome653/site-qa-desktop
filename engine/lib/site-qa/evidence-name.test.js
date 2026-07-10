'use strict';
// evidence-name.test.js — Run: node evidence-name.test.js  (exit 0 = 100% pass).
// Proves the canonical evidence filename scheme is deterministic, sanitized, and path-safe.
const { evidenceName, part } = require('./evidence-name');

let fails = 0, total = 0;
const ok = (cond, msg) => { total++; if (!cond) { console.error('  FAIL:', msg); fails++; } };

// plain evidence: page--section--component--viewport.png
ok(evidenceName({ page: 'home', section: 'hero', component: 'full', viewport: 'desktop' }) === 'home--hero--full--desktop.png', 'plain shape');

// issue evidence includes issue-<name>
ok(evidenceName({ page: 'home', section: 'hero', component: '.btn-cta', issue: 'tap-target-small', viewport: 'mobile' }) === 'home--hero--btn-cta--issue-tap-target-small--mobile.png', 'issue shape');

// selectors / headings with hostile chars sanitize clean (no path separators, quotes, spaces)
const hostile = evidenceName({ page: '/docs/getting started', section: '“Pricing & Plans” (section)', component: 'div#main > a[href="/x"]', issue: 'low contrast!', viewport: '1199 · desktop' });
ok(!/[^a-z0-9.\-]/.test(hostile), 'sanitized charset: ' + hostile);
ok(hostile.endsWith('.png'), 'png suffix');
ok(hostile.includes('--issue-low-contrast--'), 'issue slug embedded: ' + hostile);

// missing parts fall back, never emit empty segments
ok(evidenceName({}) === 'page--page--full--shot.png', 'fallbacks: ' + evidenceName({}));
ok(!evidenceName({ page: '///' }).includes('----'), 'no empty segments');

// long parts cap (whole name stays well under filesystem limits)
const long = evidenceName({ page: 'p'.repeat(300), section: 's'.repeat(300), component: 'c'.repeat(300), issue: 'i'.repeat(300), viewport: 'v'.repeat(300) });
ok(long.length < 280, 'length capped: ' + long.length);

// part() is deterministic
ok(part('Hello World!', 'x') === part('Hello World!', 'x'), 'deterministic');

if (fails) { console.error(`❌ FAIL — ${total - fails}/${total} assertions`); process.exit(1); }
console.log(`✅ PASS — ${total}/${total} assertions`);
