'use strict';
// pass-label-reachability.test.js — every green tick must be backed by a check that ran.
//
// THE FAILURE MODE THIS LOCKS:
// audit.js builds its static rows as "no finding carried this key => print PASS_LABEL[key]". That
// rule cannot tell "checked, clean" from "never checked". So the moment a check stops running — it
// is `continue`d out of the loop, or was never implemented — its label keeps printing green on
// EVERY site the tool scans, forever, and it is structurally incapable of failing.
//
// Both known instances were live on the real sgen.com 3.0.3 run (score 49%, quality 72):
//   · 'security-headers' — SEC-010 is `continue`d out of the STATIC_CHECKS loop (deprecatedIn 2.0,
//     superseded by the granular SEC-011..015), yet "Security headers present" printed GREEN in the
//     same section as five warnings saying CSP / X-Frame-Options / Referrer-Policy /
//     Permissions-Policy / X-Content-Type-Options were all missing.
//   · 'duplicate-description' — SEO-010 had NO detection code anywhere in the product (the `descs`
//     variable was declared and never read), yet "Meta descriptions are unique" printed GREEN two
//     rows below "Missing meta description ⚠".
//
// This suite does NOT hardcode those two. It derives the set of check families that can actually
// emit — from the REAL check registries (STATIC_CHECKS / SITE_CHECKS, loaded, not parsed) plus the
// real emitter call sites in the site-qa check modules — and fails on ANY label without one. A new
// dead label is caught the day it is added. An invented fixture would just agree with the bug, so
// there is none here: every input below is the shipping source.
const fs = require('fs');
const path = require('path');
const { STATIC_CHECKS, SITE_CHECKS } = require('../migration-qa/checks-static');
const { PASS_LABEL, STATIC_SUITE, SUITES, metaDescriptionOf } = require('./audit');
const REG = require('./rules/registry');

let pass = 0, fail = 0; const failures = [];
function ok(c, n) { if (c) pass++; else { fail++; failures.push(n); console.log('  ✗ ' + n); } }

const AUDIT_SRC = fs.readFileSync(path.join(__dirname, 'audit.js'), 'utf8');

// --- build the inventory of check families that can actually emit a finding during runAudit ---

// ids audit.js explicitly skips inside the per-page STATIC_CHECKS loop — these CANNOT emit
const skipped = [...AUDIT_SRC.matchAll(/if \(chk\.id === '([a-z0-9-]+)'\) continue;/g)].map(m => m[1]);
const staticIds = STATIC_CHECKS.map(c => c.id).filter(id => !skipped.includes(id));
const siteIds = SITE_CHECKS.map(c => c.id);

// families emitted by the site-qa check modules (2nd positional arg of their F()/mk() helpers, or a
// `check:` field in a probe table). Read from the real module sources.
const MODULES = ['lib/checks-security.js', 'lib/checks-seo.js', 'lib/checks-stability.js', 'lib/checks-interaction.js'];
const moduleIds = new Set();
for (const rel of MODULES) {
  const t = fs.readFileSync(path.join(__dirname, rel), 'utf8');
  for (const m of t.matchAll(/(?:F|mk|push)\(\s*'[A-Z]+-\d+'\s*,\s*'([a-z0-9-]+)'/g)) moduleIds.add(m[1]);
  for (const m of t.matchAll(/check:\s*'([a-z0-9-]+)'/g)) moduleIds.add(m[1]);
}
// families audit.js pushes into staticBy itself (the cross-page duplicate roll-ups)
const inlineIds = new Set([...AUDIT_SRC.matchAll(/staticBy\['([a-z0-9-]+)'\]\s*=\s*staticBy/g)].map(m => m[1]));

const emitters = new Set([...staticIds, ...siteIds, ...moduleIds, ...inlineIds]);

// sanity: the inventory itself must be non-trivial, or this suite would pass by finding nothing
ok(staticIds.length > 15, `inventory: STATIC_CHECKS ids discovered (${staticIds.length})`);
ok(siteIds.length >= 4, `inventory: SITE_CHECKS ids discovered (${siteIds.length})`);
ok(moduleIds.size >= 5, `inventory: site-qa module families discovered (${moduleIds.size})`);
ok(emitters.size > 25, `inventory: total emitting families discovered (${emitters.size})`);

// --- THE GATE: every pass label must have a live emitter ---
const deadLabels = Object.keys(PASS_LABEL).filter(k => !emitters.has(k));
ok(deadLabels.length === 0, 'no PASS_LABEL key is unreachable — a green tick with no check behind it: ' + JSON.stringify(deadLabels));

// every label must also route to a real suite, or its row would crash / vanish on emit
for (const k of Object.keys(PASS_LABEL)) {
  ok(!!STATIC_SUITE[k], `PASS_LABEL '${k}' has a STATIC_SUITE mapping`);
  ok(SUITES.some(s => s.key === STATIC_SUITE[k]), `PASS_LABEL '${k}' routes to a declared suite`);
}

// --- the two regressions, named explicitly so they cannot come back quietly ---
ok(skipped.includes('security-headers'), 'security-headers is still `continue`d out of the loop (premise of the next assertion)');
ok(!('security-headers' in PASS_LABEL), 'no green "Security headers present" label while SEC-010 is skipped');
ok(!Object.values(PASS_LABEL).some(v => /Security headers present/i.test(v)), 'the SEC-010 roll-up label text is gone entirely');
// the granular replacements must genuinely be the ones reporting, or deleting the roll-up lost coverage
for (const id of ['SEC-011', 'SEC-012', 'SEC-013', 'SEC-014', 'SEC-015']) ok(!!REG.getById(id), `granular ${id} exists in the registry (covers the deleted roll-up)`);
ok(moduleIds.has('sec-header'), 'sec-header (SEC-011..015) is a live emitter — headers ARE still checked');

ok(emitters.has('duplicate-description'), 'duplicate-description (SEO-010) has a live emitter — the tick is backed by a check');
ok(inlineIds.has('duplicate-description'), 'duplicate-description is emitted by audit.js itself');
ok(inlineIds.has('duplicate-title'), 'duplicate-title (SEO-009) still emitted');

// findings must carry their ruleId: enrichRow() resolves identity ONLY by ruleId, so an emitter that
// omits it is stamped deduction 0 and the warning costs the site nothing.
for (const rid of ['SEO-009', 'SEO-010']) {
  ok(new RegExp("ruleId: '" + rid + "'").test(AUDIT_SRC), `${rid} finding carries its ruleId (else it scores 0)`);
  ok(!!REG.getById(rid), `${rid} resolves in the registry`);
}
ok(REG.getById('SEO-010').suite === 'seo', 'SEO-010 lands in the seo suite');

// --- metaDescriptionOf: the extractor the duplicate-description check depends on ---
const DESC = 'We build things.';
ok(metaDescriptionOf(`<meta name="description" content="${DESC}">`) === DESC, 'metaDescriptionOf reads name="description"');
ok(metaDescriptionOf(`<meta property="description" content="${DESC}">`) === DESC, 'metaDescriptionOf reads property="description"');
ok(metaDescriptionOf('<meta name="description" content="">') === null, 'empty description is not a description (would false-group pages)');
ok(metaDescriptionOf('<meta name="keywords" content="a,b">') === null, 'other meta tags are not descriptions');
ok(metaDescriptionOf('') === null && metaDescriptionOf(null) === null, 'no head / empty head is safe');
// must not match og:description — grouping those would invent duplicates that do not exist
ok(metaDescriptionOf('<meta property="og:description" content="x">') === null, 'og:description is not the meta description');

console.log(`\n${fail ? '❌ FAIL' : '✅ PASS'} · ${pass}/${pass + fail} assertions`);
if (fail) { console.log('failures:\n  - ' + failures.join('\n  - ')); process.exit(1); }
