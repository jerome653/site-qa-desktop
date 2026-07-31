'use strict';
// interaction-scan.test.js — markup inside a <script> string is not markup in the document.
//
// THE DEFECT: interactionCheck() walks the RAW html with a tag regex and keeps a stack of open
// interactive elements. Inline scripts that build markup — `wrap.innerHTML = '<button …>'` — push
// onto that stack and never pop, because the matching '</button>' is in a different string literal
// or built by a loop. Every real control that opens afterwards is then reported as nested inside a
// control that does not exist. On a real client build this produced one DOM-012 at medium severity
// against a close button sitting alone in a modal bar, and it cost the Accessibility suite 4 points
// that no edit to the page could ever recover.
//
// The same scan drives LINK-006/007/008/009 and DOM-010/011/013, so a dirty stack is not the only
// exposure: an <a href="#"> inside a template string is not a dead link on the page either.
//
//   node interaction-scan.test.js

const { interactionCheck } = require('./checks-interaction');

let pass = 0, fail = 0;
const ok = (cond, name, extra) => cond ? (pass++, console.log('  ✓ ' + name))
  : (fail++, console.log('  ✗ ' + name + (extra ? '\n      → ' + extra : '')));

const run = (html) => interactionCheck({ isHtml: true, html, url: 'https://x.test/' });
const ids = (out) => out.map(f => `${f.ruleId}:${f.value}`).join(' · ') || '(none)';

console.log('\n  — script bodies and comments are not document markup —');

let out = run(`<html><body>
  <script>var t = '<button class="tpl-close" type="button">x</button>'; el.innerHTML = t;</script>
  <div class="bar"><button class="site-modal__close" type="button">✕</button></div>
</body></html>`);
ok(!out.some(f => f.ruleId === 'DOM-012'),
  'a button built in an inline script does not make the next real button "nested"', ids(out));

// The real shape, verbatim from the build that exposed this: an opening tag written inside a JS
// block comment, thousands of bytes before the control it poisons.
out = run(`<html><body>
  <script data-clone-template="nav-mobile">
  /* Auto-binds to any <button aria-expanded aria-controls=...> that targets a menu element. */
  </script>
  <div class="bar"><button class="site-modal__close" type="button">✕</button></div>
</body></html>`);
ok(!out.some(f => f.ruleId === 'DOM-012'),
  'an opening tag inside a JS comment does not poison the stack for the rest of the document', ids(out));

out = run(`<html><body>
  <!--<a href="#">commented out</a>-->
  <a href="/real">real link</a>
</body></html>`);
ok(!out.some(f => f.ruleId === 'LINK-007'), 'href="#" inside an HTML comment is not a dead link on the page', ids(out));

out = run(`<html><body><style>/* <button> in a comment */</style><button>real</button></body></html>`);
ok(!out.some(f => f.ruleId === 'DOM-012'), 'style bodies are skipped too', ids(out));

console.log('\n  — real nesting and real dead links are still caught —');

out = run('<html><body><button type="button">outer <button type="button">inner</button></button></body></html>');
ok(out.some(f => f.ruleId === 'DOM-012'), 'a button genuinely inside a button still fires', ids(out));

out = run('<html><body><a href="/x">link <button type="button">go</button></a></body></html>');
ok(out.some(f => f.ruleId === 'DOM-012'), 'a button genuinely inside an anchor still fires', ids(out));

out = run('<html><body><a href="#">dead</a><a>no href</a></body></html>');
ok(out.some(f => f.ruleId === 'LINK-007') && out.some(f => f.ruleId === 'LINK-009'),
  'real href="#" and real hrefless anchors still fire', ids(out));

out = run('<html><body><button type="submit">submits nothing</button></body></html>');
ok(out.some(f => f.ruleId === 'DOM-010'), 'a submit button outside a form still fires', ids(out));

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
