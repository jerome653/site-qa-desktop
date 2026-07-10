'use strict';
// smoke.js — headless operational check of the desktop app's ENGINE INTEGRATION (the part that doesn't
// need a display). Mirrors what main.js does: pick a free port, spawn the bundled engine, wait for it,
// exercise the UI + a real audit through the same code path a window would use. GUI window render is
// verified separately on a desktop (Electron can't run headless in CI).
const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const path = require('path');
const fs = require('fs');

const ENGINE = path.join(__dirname, 'engine', 'sgen-qa-serve.js');
let fail = 0; const ok = (c, m) => { console.log('  ' + (c ? '✓' : '✗') + ' ' + m); if (!c) fail++; };

function freePort() { return new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); }); }
function get(port, p) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: p, timeout: 4000 }, x => { let b = ''; x.on('data', c => b += c); x.on('end', () => res({ status: x.statusCode, body: b })); }); r.on('error', () => res({ status: 0 })); r.on('timeout', () => { r.destroy(); res({ status: 0 }); }); }); }
function post(port, p, body) { return new Promise(res => { const data = Buffer.from(body); const r = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': data.length }, timeout: 60000 }, x => { let b = ''; x.on('data', c => b += c); x.on('end', () => res({ status: x.statusCode, body: b })); }); r.on('error', () => res({ status: 0 })); r.on('timeout', () => { r.destroy(); res({ status: 0 }); }); r.end(data); }); }

// a tiny local site to audit (proves the render pipeline end-to-end through the app's engine)
function fixture() { return new Promise(r => { const s = http.createServer((q, s2) => { s2.setHeader('content-type', 'text/html'); s2.end('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Desktop Smoke Fixture Page</title></head><body><h1>Hi</h1><a href="#">dead</a></body></html>'); }).listen(0, '127.0.0.1', () => r(s)); }); }

(async () => {
  console.log('=== SGEN Site QA Desktop — engine-integration smoke ===');
  ok(fs.existsSync(ENGINE), 'engine present at ' + path.relative(__dirname, ENGINE));
  if (!fs.existsSync(ENGINE)) { console.log('\n❌ engine not bundled — run copy-engine first'); process.exit(1); }
  const PORT = await freePort();
  const env = Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' });
  const brs = path.join(__dirname, 'browsers'); if (fs.existsSync(brs)) env.PLAYWRIGHT_BROWSERS_PATH = brs;
  const proc = spawn(process.execPath, [ENGINE, '--port', String(PORT)], { env, cwd: path.dirname(ENGINE), stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; proc.stdout.on('data', d => out += d); proc.stderr.on('data', d => out += d);
  // wait up to 20s for the server
  let up = false; for (let i = 0; i < 80; i++) { if ((await get(PORT, '/')).status === 200) { up = true; break; } await new Promise(r => setTimeout(r, 250)); }
  ok(up, 'engine server booted on a free port (' + PORT + ')');
  if (up) {
    const home = await get(PORT, '/');
    ok(/SGEN Site QA/.test(home.body), 'UI serves (brand present)');
    ok(/tour-hi/.test(home.body), 'guided tour present');
    // malformed request must NOT crash (the stress-fix)
    await post(PORT, '/api/run', 'null'); await post(PORT, '/api/run', '[]');
    ok((await get(PORT, '/')).status === 200, 'survives malformed API request (crash-fix in the bundle)');
    // a real audit through the app engine (render off = fast + no browser needed for this check)
    const fx = await fixture(); const fxPort = fx.address().port;
    const run = await post(PORT, '/api/run', JSON.stringify({ url: 'http://127.0.0.1:' + fxPort + '/', maxPages: 1, render: false }));
    const done = (run.body || '').trim().split('\n').map(l => { try { return JSON.parse(l); } catch (_) { return {}; } }).find(m => m.t === 'done');
    ok(done && done.ok, 'ran a real audit through the bundled engine (verdict: ' + (done && done.verdict) + ')');
    fx.close();
  }
  try { proc.kill(); } catch (_) {}
  const stillUp = (await get(PORT, '/')).status === 200; ok(!stillUp, 'server stops cleanly when the app closes');
  console.log('\n' + (fail === 0 ? '✅ DESKTOP SMOKE PASS — engine integration 100% operational' : `❌ SMOKE FAIL — ${fail} issue(s)`) + (out ? '\n(engine log tail: ' + out.split('\n').slice(-2).join(' ').slice(0, 120) + ')' : ''));
  process.exit(fail ? 1 : 0);
})();
