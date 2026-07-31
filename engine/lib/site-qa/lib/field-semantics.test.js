'use strict';
// field-semantics.test.js — FORM-002 must only ask for a text-entry type where a text-entry type is possible.
//
// THE DEFECT: the rule matches on the field's NAME and ignores its TYPE. A hidden field named
// phone_country (the ISO code a phone widget writes back) is told to be type="tel"; a radio pair
// named website_has (the yes/no question "do you have a website?") is told to be type="url". Neither
// instruction is applicable — a hidden input has no keyboard, and a radio's type IS its function, so
// "fixing" either one breaks the form. Measured on a real client build: four FORM-002 findings, all
// four of this shape, and because Forms is a three-rule suite those four zeroed the suite outright.
//
// The rule's intent is narrow and good: a TEXT field asking for an email/phone/URL should declare it,
// so mobile keyboards and autofill work. Restricting it to fields that can actually take text keeps
// every true positive and drops every one of these.
//
//   node field-semantics.test.js

const { stabilityPageChecks } = require('./checks-stability');

let pass = 0, fail = 0;
const ok = (cond, name, extra) => cond ? (pass++, console.log('  ✓ ' + name))
  : (fail++, console.log('  ✗ ' + name + (extra ? '\n      → ' + extra : '')));

const run = (body) => {
  const out = stabilityPageChecks({ isHtml: true, html: `<html><body><form>${body}</form></body></html>`, url: 'https://x.test/' });
  return out.filter(f => f.ruleId === 'FORM-002');
};
const items = (f) => (f[0] && f[0].items || []).map(i => `${i.id} ${i.value}`).join(' · ');

console.log('\n  — fields that cannot take text are not asked to declare a text type —');

let r = run('<input type="hidden" name="phone_country" value="US">');
ok(r.length === 0, 'a hidden field named phone_country does not demand type="tel"', items(r));

r = run('<input type="hidden" name="phone" data-phone-full>');
ok(r.length === 0, 'a hidden field named phone does not demand type="tel"', items(r));

r = run('<input type="radio" name="website_has" value="yes"><input type="radio" name="website_has" value="no">');
ok(r.length === 0, 'a yes/no radio named website_has does not demand type="url"', items(r));

r = run('<input type="checkbox" name="email_optin"><input type="range" name="phone_volume"><input type="file" name="website_logo">');
ok(r.length === 0, 'checkbox, range and file inputs are out of scope for the same reason', items(r));

console.log('\n  — the rule keeps its teeth on the fields it was written for —');

r = run('<input type="text" name="email" placeholder="you@practice.com">');
ok(r.length === 1 && /should be email/.test(items(r)), 'a text field named email still fires', items(r));

r = run('<input name="phone_national" placeholder="(555) 000-0000">');
ok(r.length === 1 && /should be tel/.test(items(r)), 'an untyped field named phone_national still fires', items(r));

r = run('<input type="text" name="website" placeholder="yoursite.com">');
ok(r.length === 1 && /should be url/.test(items(r)), 'a text field named website still fires', items(r));

r = run('<input type="password" name="pw">');
ok(r.length === 1 && /autocomplete/.test(items(r)), 'a password without autocomplete still fires', items(r));

r = run('<input type="email" name="email" autocomplete="email"><input type="tel" name="phone" autocomplete="tel"><input type="url" name="website" autocomplete="url">');
ok(r.length === 0, 'correctly typed fields stay silent', items(r));

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
