'use strict';
// ui-script.test.js — parse the client script the server ACTUALLY SERVES.
//
// WHY THIS EXISTS. The whole dashboard is ~66 KB of JavaScript living inside a Node template literal
// in sgen-qa-serve.js. `node --check sgen-qa-serve.js` parses the OUTER file and reports OK while the
// string it emits is unparseable garbage — the check passes and every tool on the page is dead. There
// is no linter on that inner script and no test ever ran it, so the only thing standing between a
// broken escape and a shipped brick was someone opening the app.
//
// That is not hypothetical. Adding the Annotate view switcher, an onclick was written as
//     onclick="setView(\''+pre+'\',\'report\')"
// when the template literal needs
//     onclick="setView(\\''+pre+'\\',\\'report\\')"
// A lone \' is consumed BY THE TEMPLATE LITERAL, so the browser received setView(''+pre+'','report')
// — a string immediately followed by a string. Every function on the page (runAudit, openSettings,
// showReport) silently vanished with "Unexpected string", and `node --check` said OK throughout.
//
// So: boot the real server, fetch the real page, and parse every inline <script> with new Function().
// It costs one process spawn and it is the only gate that can see this class of bug.
//
//   node testing/ui-script.test.js
const http = require('http');
const path = require('path');
const cp = require('child_process');

const SERVE = path.join(__dirname, '..', '..', '..', 'sgen-qa-serve.js');
const PORT = 20000 + Math.floor(process.hrtime()[1] % 15000);   // no Math.random: keep runs reproducible-ish
let pass = 0, fail = 0;
const t = (cond, msg) => { if (cond) { pass++; } else { fail++; console.log('  ❌ ' + msg); } };

function get(p) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: p, timeout: 15000 }, res => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ code: res.statusCode, body: b }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function waitUp(ms) {
  const t0 = Date.now();
  for (;;) {
    try { await get('/'); return true; } catch (_) {}
    if (Date.now() - t0 > ms) return false;
    await new Promise(r => setTimeout(r, 250));
  }
}

(async () => {
  const child = cp.spawn(process.execPath, [SERVE], {
    env: Object.assign({}, process.env, { SGEN_QA_PORT: String(PORT) }),
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  let out = 1;
  try {
    if (!await waitUp(30000)) { console.log('  ❌ server did not come up on ' + PORT); process.exit(1); }

    const page = await get('/');
    t(page.code === 200, 'GET / -> ' + page.code);

    // THE GATE: every inline script the browser will run must parse.
    const scripts = [...page.body.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
    t(scripts.length > 0, 'page carries at least one inline <script>');
    let biggest = 0;
    for (let i = 0; i < scripts.length; i++) {
      const src = scripts[i];
      biggest = Math.max(biggest, src.length);
      let ok = true, err = '';
      try { new Function(src); } catch (e) { ok = false; err = e.message; }
      t(ok, 'inline <script> #' + i + ' (' + src.length + ' bytes) parses — ' + err);
    }
    t(biggest > 20000, 'the main dashboard script is present (biggest block ' + biggest + ' bytes)');

    // The hidden-not-deleted contract, asserted against what is SERVED — not against the source.
    // These nodes are display:none but the runner reads them and the settings popup binds to them,
    // so deleting them breaks both. A grep of the source could pass while the page shipped without them.
    for (const id of ['a-url', 'a-save', 'a-max', 'a-render', 'a-vps']) {
      t(new RegExp('id="' + id + '"').test(page.body), 'served page still contains #' + id + ' (runner reads it)');
    }
    t(/\.settings-owned\{display:none!important\}/.test(page.body),
      'settings-owned hide rule is !important — label.fld (0-1-1) outranks a bare .settings-owned (0-1-0)');
    t(/save:saveAs/.test(page.body), 'runAudit sends the consumed save name, not a live re-read of #a-save');
    t(/\$\('a-save'\)\.value=''/.test(page.body),
      'runAudit CLEARS #a-save — saveBaseline overwrites unconditionally, so a remembered name would silently re-point the reference');

    // Annotate must be an in-page view, never a popped tab.
    t(!/href="\/annotate\/[^"]*"[^>]*target="_blank"/.test(page.body),
      'no target=_blank annotate link is served (Annotate swaps the frame in place)');
    t(/function setView\(/.test(page.body), 'setView() view-switcher is served');

    out = fail ? 1 : 0;
    console.log((fail ? '❌ FAIL' : '✅ PASS') + ' · ' + pass + '/' + (pass + fail) + ' assertions');
  } catch (e) {
    console.log('  ❌ harness error: ' + (e && e.message || e));
    out = 1;
  } finally {
    try { child.kill('SIGKILL'); } catch (_) {}
  }
  process.exit(out);
})();
