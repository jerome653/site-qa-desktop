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
  console.log('=== Site Audit Desktop — engine-integration smoke ===');
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
    ok(/Site Audit/.test(home.body), 'UI serves (brand present)');
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

    // --- Tool 5 · DNS & Cutover -----------------------------------------------------------------
    // Tool 5 shipped in 6.4.1 with two defects that 423 offline assertions could not see and that ONE
    // live run exposed in seconds: a TXT-only name (_dmarc) scored DROPPED and raised a
    // launch-BLOCKING finding against a record that had never moved, and the recovered zone's SOA
    // rendered as "undefined undefined undefined" on the operator's screen. Smoke never touched this
    // tool at all. What follows are the invariants that hold NO MATTER what the internet answers —
    // asserting a live VALUE would be a test that fails when someone else edits their zone.
    const POISON = /undefined|\[object Object\]|\bNaN\b|\(\s*\)/;
    const DNS_HOST = 'example.com';                                   // stable, publishes DMARC + SOA
    const OLD_NS = 'a.iana-servers.net,b.iana-servers.net';           // its own NS — exercises queryZone
    const dnsRun = async (payload) => {
      const r = await post(PORT, '/api/dns', JSON.stringify(payload));
      return (r.body || '').trim().split('\n').map(l => { try { return JSON.parse(l); } catch (_) { return {}; } }).find(m => m.t === 'done');
    };
    const strings = (f) => [f.title, f.detail, f.impact, f.location, f.value].filter((s) => typeof s === 'string');
    const cap = await dnsRun({ action: 'capture', domain: DNS_HOST });
    if (!cap || !cap.ok) {
      // LOUD skip, never a silent pass: a machine with no route to the public resolvers cannot
      // certify this tool, and a smoke that quietly reports 100% in that state is worse than no check.
      console.log('  ⚠ SKIPPED — DNS & Cutover needs public resolvers (' + ((cap && cap.error) || 'no answer') + '). Tool 5 IS NOT CERTIFIED by this run.');
    } else {
      ok(cap.verdict === 'BASELINE CAPTURED', 'DNS capture recorded a baseline through the bundled engine');
      for (const [label, payload] of [
        ['verify', { action: 'verify', domain: DNS_HOST, expectCutover: false }],
        ['recover', { action: 'recover', domain: DNS_HOST, oldNameservers: OLD_NS }],
      ]) {
        const d = await dnsRun(payload);
        ok(d && d.ok, 'DNS ' + label + ' completed (verdict: ' + (d && d.verdict) + ')');
        if (!d || !d.ok) continue;
        const rep = await get(PORT, '/dns/' + d.id + '/report.json');
        let j = null; try { j = JSON.parse(rep.body); } catch (_) {}
        ok(!!j, 'DNS ' + label + ' wrote a readable report.json');
        if (!j) continue;
        const dirty = (j.findings || []).filter((f) => strings(f).some((s) => POISON.test(s)));
        ok(dirty.length === 0, 'DNS ' + label + ': no finding shows a placeholder to the operator'
          + (dirty.length ? ' — ' + dirty[0].ruleId + ': ' + String(strings(dirty[0])[1] || '').slice(0, 90) : ''));
        // "dropped" is the launch-blocking claim in this tool. Making it with no record of WHAT was
        // dropped is the exact shape of the 6.4.1 false positive, whatever the reason for it.
        const hollow = (j.subdomains || []).filter((s) => s.state === 'dropped' && !(s.was || []).length);
        ok(hollow.length === 0, 'DNS ' + label + ': nothing is reported lost without evidence of what was lost'
          + (hollow.length ? ' — ' + hollow[0].name : ''));
        ok((j.findings || []).every((f) => /^DNS-\d{3}$/.test(f.ruleId || '')), 'DNS ' + label + ': every finding carries a real rule id');
        // A run that reports a state without an action is a status line, not an answer. Whatever the
        // internet said, there is always a next thing for the operator to do — including "nothing".
        ok(typeof d.next === 'string' && d.next.length > 10, 'DNS ' + label + ': the result names the next action');
        ok(!d.propagation || (d.propagation.percent >= 0 && d.propagation.percent <= 100 && d.propagation.onNew <= d.propagation.definitive),
          'DNS ' + label + ': propagation is a real proportion of the resolvers that actually answered');
      }
    }
  }
  try { proc.kill(); } catch (_) {}
  const stillUp = (await get(PORT, '/')).status === 200; ok(!stillUp, 'server stops cleanly when the app closes');
  console.log('\n' + (fail === 0 ? '✅ DESKTOP SMOKE PASS — engine integration 100% operational' : `❌ SMOKE FAIL — ${fail} issue(s)`) + (out ? '\n(engine log tail: ' + out.split('\n').slice(-2).join(' ').slice(0, 120) + ')' : ''));
  process.exit(fail ? 1 : 0);
})();
