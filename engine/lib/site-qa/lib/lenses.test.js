'use strict';
// lenses.test.js — Phase 2 Inspector Lenses. Run: node lib/lenses.test.js
const { computeLenses, LENSES } = require('./lenses');

let fails = 0, total = 0;
const ok = (c, m) => { total++; if (!c) { console.error('  FAIL:', m); fails++; } };

// synthetic contract findings (only the fields lenses read)
const F = (inspector, interaction, deduction) => ({ inspector, interaction, metadata: { deduction }, locator: { url: 'https://x.test/p' } });
const findings = [
  F('seo', false, 6),               // SEO only
  F('security', false, 4),          // Security only
  F('security', false, 3),          // Security only
  F('seo', true, 8),                // SEO + Interaction (a dead link)
  F('stability', true, 4),          // Stability + Interaction (dead button)
];

const r = computeLenses(findings);

// structure
ok(r.lenses.join(',') === 'seo,security,stability,interaction', 'four lenses in order');
ok(r.model === 'sgen-lenses-v1', 'model tag');

// SEO = the two seo findings (6 + 8 = 14 ded → 86)
ok(r.scores.seo.score === 86 && r.scores.seo.count === 2, 'SEO lens: score 86, 2 findings');
// Security = two (4 + 3 = 7 → 93)
ok(r.scores.security.score === 93 && r.scores.security.count === 2, 'Security lens: 93, 2');
// Stability = one (4 → 96)
ok(r.scores.stability.score === 96 && r.scores.stability.count === 1, 'Stability lens: 96, 1');
// Interaction (cross-cutting) = the two interaction:true findings (8 + 4 = 12 → 88), regardless of inspector
ok(r.scores.interaction.score === 88 && r.scores.interaction.count === 2, 'Interaction lens: 88, 2 (cross-cutting)');
ok(r.scores.interaction.interaction === true && r.scores.interaction.isNew === true, 'Interaction lens flagged interaction + new');

// a finding can be in TWO lenses (dead link = SEO AND Interaction) — cross-cutting is the point
ok(r.scores.seo.count + r.scores.security.count + r.scores.stability.count === 5, 'inspector lenses partition by inspector (5 total)');
ok(r.scores.interaction.count === 2, 'interaction lens overlaps inspector lenses (2 interactive)');

// clamp: huge deductions floor at 0, none negative
const heavy = computeLenses([F('seo', false, 500)]);
ok(heavy.scores.seo.score === 0, 'score clamps at 0');
// empty → all 100
const empty = computeLenses([]);
ok(LENSES.every(l => empty.scores[l.key].score === 100 && empty.scores[l.key].count === 0), 'no findings → all lenses 100/clean');

if (fails) { console.error(`❌ FAIL — ${total - fails}/${total} assertions`); process.exit(1); }
console.log(`✅ PASS — ${total}/${total} assertions`);
