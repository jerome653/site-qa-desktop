'use strict';
// length.test.js — title and meta-description LENGTH are not findings. Google documents no length
// limit for either (Search Central: "Influencing your title links", "Control your snippets"); it
// shortens them for display only. SEO-002 / SEO-004 are retired (deprecatedIn 1.17.0): the ids stay
// registered so stored scans still resolve, and the checks never emit them.
// Missing title (SEO-001) and missing description (SEO-003) are still findings.
// Run: node lib/migration-qa/length.test.js
const { STATIC_CHECKS, buildCtx } = require('./checks-static');
const REG = require('../site-qa/rules/registry');

let fails = 0, total = 0;
const ok = (c, m) => { total++; if (!c) { console.error('  FAIL:', m); fails++; } };
const URL_ = 'https://example.com/page';
function run(checkId, head) {
  const body = `<!doctype html><html><head>${head}</head><body><main>x</main></body></html>`;
  const c = buildCtx({ url: URL_, status: 200, body, contentType: 'text/html', headers: { 'content-type': 'text/html' } }, 'example.com');
  return STATIC_CHECKS.find(k => k.id === checkId).fn(c, { env: 'live' });
}
const rid = (f) => (f ? f.ruleId : null);

for (const title of ['Acme', 'x'.repeat(9), 'y'.repeat(71), 'z'.repeat(300)]) {
  ok(rid(run('title', `<title>${title}</title>`)) === null, `title of ${title.length} chars is not a finding`);
}
ok(rid(run('title', '')) === 'SEO-001', 'missing title is still SEO-001');

for (const d of ['Short.', 'd'.repeat(49), 'e'.repeat(171), 'f'.repeat(400)]) {
  ok(rid(run('meta-description', `<title>t</title><meta name="description" content="${d}">`)) === null, `description of ${d.length} chars is not a finding`);
}
ok(rid(run('meta-description', '<title>t</title>')) === 'SEO-003', 'missing description is still SEO-003');

for (const id of ['SEO-002', 'SEO-004']) {
  const r = REG.getById(id);
  ok(r && r.deprecatedIn === '1.17.0', `${id} stays registered and is marked deprecatedIn 1.17.0`);
}

if (fails) { console.error(`❌ FAIL — ${total - fails}/${total} assertions`); process.exit(1); }
console.log(`✅ PASS — ${total}/${total} assertions`);
