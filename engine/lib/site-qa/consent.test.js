'use strict';
// consent.test.js — Run: node consent.test.js  (exit 0 = 100% pass).
// Proves the affirmative-button matcher hits real consent labels and NEVER destructive/navigational ones.
const { AFFIRM_RX, CONTAINER_HINTS } = require('./consent');

let fails = 0, total = 0;
const ok = (cond, msg) => { total++; if (!cond) { console.error('  FAIL:', msg); fails++; } };

// must MATCH — real-world consent / age-gate / T&C affirmatives
[
  'Accept', 'Accept all', 'Accept All Cookies', 'Accept cookies', 'Allow all', 'Allow',
  'I agree', 'Agree', 'I accept', 'I consent', 'I understand', 'Got it', 'OK', 'Okay',
  'Yes', 'Yes, I am 21', 'Yes, I am over 18', "I'm over 21", 'I am 21 or older', 'I am 18',
  'I am 21 years or older', 'Enter', 'Enter site', 'Enter the site', 'Continue', 'Continue to site',
  'Confirm', 'Proceed', 'Verify', 'YES',
].forEach(t => ok(AFFIRM_RX.test(t), `should match: "${t}"`));

// must NOT match — destructive, navigational, or ambiguous labels the tool must never click
[
  'Reject', 'Reject all', 'Decline', 'No', 'No, I am under 21', 'Manage preferences', 'Settings',
  'Cookie settings', 'Learn more', 'Privacy policy', 'Exit', 'Leave', 'Close account', 'Delete',
  'Sign up', 'Subscribe', 'Buy now', 'Add to cart', 'Checkout', 'Log in', 'Submit order',
  'I am under 18', 'More options', 'Customize', 'Read our terms and conditions here',
].forEach(t => ok(!AFFIRM_RX.test(t), `must NOT match: "${t}"`));

// container hints: lowercase fragments, no empties, cover the major consent managers + age gates
ok(CONTAINER_HINTS.every(h => h === h.toLowerCase() && h.length >= 3), 'hints lowercase, len>=3');
['onetrust', 'cookiebot', 'cookieyes', 'didomi', 'usercentrics', 'quantcast', 'age-gate', 'agegate'].forEach(h =>
  ok(CONTAINER_HINTS.includes(h), 'hint present: ' + h));

if (fails) { console.error(`❌ FAIL — ${total - fails}/${total} assertions`); process.exit(1); }
console.log(`✅ PASS — ${total}/${total} assertions`);
