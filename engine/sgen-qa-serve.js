#!/usr/bin/env node
'use strict';
// sgen qa-serve — local web UI for the SGEN Site QA suite. FOUR independent tools, one browser app,
// bound to 127.0.0.1 only. No AI at runtime; no fake results. Every button POSTs to the SAME frozen
// engines the CLIs use — this file is UI-exposure ONLY and modifies none of them:
//   1. Site Audit          -> runAudit + renderReport                (/api/run)
//   2. Visual Comparison   -> visual-match.run + report-visual.render (/api/visual)
//   3. Post-Deployment Check (engine: migration certification) -> discoverPages + certifyMigration (/api/certify)
//   4. Reports             -> lists _ui-runs + qualification portfolio (/api/reports)
//
//   sgen qa-serve [--port 7878] [--open]

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { runAudit } = require('./lib/site-qa/audit');
const { renderReport, STYLE } = require('./lib/site-qa/report');
const { saveBaseline, loadResult, diff, listBaselines, recordScan } = require('./lib/site-qa/compare');
const { renderCompare } = require('./lib/site-qa/report-compare');
const { discoverPages } = require('./lib/migration-qa/crawl');
const visualMatch = require('./lib/site-qa/visual-match');
const { render: renderVisual } = require('./lib/site-qa/report-visual');
const { certifyMigration } = require('./lib/site-qa/inventory/certify-pipeline');
const { IdRegistry } = require('./lib/site-qa/inventory/id-registry');
let loadCases; try { ({ loadCases } = require('./lib/site-qa/inventory/portfolio')); } catch (e) { loadCases = () => []; }

function arg(name, def) { const i = process.argv.indexOf('--' + name); return i >= 0 ? (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true) : def; }
const PORT = parseInt(arg('port', process.env.SGEN_QA_PORT || '7878'), 10);
const RUNS = path.resolve(__dirname, '..', 'sgen', 'W5-Live-Surface-Audit', 'site-qa', '_ui-runs');
const DATA = path.resolve(__dirname, '..', 'sgen', 'W5-Live-Surface-Audit', 'site-qa', '_auditor-data');
const safe = (s) => String(s).replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 60);
const H = (u) => { try { return new URL(u).host; } catch (_) { return u; } };
const norm = (u) => { u = String(u || '').trim(); if (u && !/^https?:\/\//i.test(u)) u = 'https://' + u; return u; };
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.gif': 'image/gif', '.json': 'application/json', '.css': 'text/css', '.html': 'text/html; charset=utf-8' };
const gitCommit = (() => { try { return require('child_process').execSync('git rev-parse --short HEAD', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch (_) { return 'unknown'; } })();
// The user manual (self-contained HTML) — bundled in lib/, served at /manual, opened from the Manual button.
let MANUAL_HTML = ''; try { MANUAL_HTML = fs.readFileSync(path.join(__dirname, 'lib', 'manual.html'), 'utf8'); } catch (_) {}

// ---- version log: release notes + this machine's update history ----------------------------------
// A hot engine is extracted to userData/engines/<version>/, so our own version == this directory's name.
const SELF_VER = (path.basename(__dirname).match(/^\d+\.\d+\.\d+$/) || [null])[0];
const NOTES_DIR = path.join(process.env.APPDATA || process.env.HOME || __dirname, 'SGEN Site QA');
const UPDATE_LOG = path.join(NOTES_DIR, 'update-log.json');
// Newest first. Each shipped engine carries its own notes; older entries are kept for the in-app log.
const CHANGELOG = [
  { version: '2.5.4', date: '2026-07-10', notes: [
    'Cleaner look — scrollbars are now hidden throughout the app and reports (scrolling still works normally).'
  ] },
  { version: '2.5.3', date: '2026-07-10', notes: [
    'The in-app user manual now uses the dark SGEN theme, with a cleaner scroll-free look.'
  ] },
  { version: '2.5.2', date: '2026-07-10', notes: [
    'Added a Manual button (between Logs and Help) that opens the full user guide right in the app.'
  ] },
  { version: '2.5.1', date: '2026-07-10', notes: [
    'Walkthrough polish: the coach-mark popup (and its Next/Finish button) now always stays fully on screen.',
    'Verified for release — 24 test suites + stress pass.'
  ] },
  { version: '2.5.0', date: '2026-07-10', notes: [
    'Refreshed the ? Help walkthrough to cover everything new — saved settings, the pass/fail result, clickable summary cards, grouped Reports, in-app updates, and the Logs + diagnostics window.'
  ] },
  { version: '2.4.9', date: '2026-07-10', notes: [
    'Your tool settings now stick — inputs, checkboxes, viewports and options are saved and restored automatically, so you do not re-set them each time.',
    'Site Audit: the URL box is narrower with the scan configuration on one row beside it.',
    'Visual Comparison + Post-Deployment Check: cleaner two-column layout — URLs on the left, options on the right, the run button beside the summary.',
    'Reports: grouped by site (newest first) with a search box and a date filter.',
    'Logs window: "Generate diagnostics" produces a detailed Markdown report you can download or copy to send for review.'
  ] },
  { version: '2.4.8', date: '2026-07-10', notes: [
    'Clearer report: the overall PASS/FAIL verdict is now labelled distinctly from the 0–100 quality scores (Inspector lenses + Quality dashboard), so it is obvious at a glance whether the site passes.'
  ] },
  { version: '2.4.7', date: '2026-07-10', notes: [
    'The score-summary cards (Passed / Warnings / Failed / Manual / Pages / Rendered) are now clickable — jump straight to those checks.',
    'Added a colour key on the report explaining what red / grey / silver mean.'
  ] },
  { version: '2.4.6', date: '2026-07-10', notes: [
    'Auto-check for updates: the button turns red and a toast appears when one is available — download + install stay a manual click.',
    'The header and tool tabs now stay locked in place while you scroll.',
    'Evidence screenshots trim the empty space at the bottom of tall pages.',
    'Cleaned the address stamp out of the header.'
  ] },
  { version: '2.4.4', date: '2026-07-10', notes: [
    'New: this Logs panel (beside Help) — shows what each update changed and your update history.',
    'Tools 2-4 (Visual Comparison, Post-Deployment Check, Reports) now use the full width — single column, no empty sidebar.'
  ] },
  { version: '2.4.2', date: '2026-07-10', notes: [
    'Fixed: in-app updates now apply reliably and are fully manual — nothing installs unless you click.',
    'An update is a ~360 KB download + a 1-second restart. No installer, no "cannot be closed".'
  ] },
  { version: '2.4.0', date: '2026-07-10', notes: [
    'Re-architected updates: the engine updates itself in place instead of a full app reinstall.'
  ] },
  { version: '2.3.5', date: '2026-07-10', notes: [
    'Clearer Visual Comparison reports: grouped moves, plain-language labels, per-issue Copy-as-Markdown dev tickets.',
    'Age-gate / cookie-banner bypass across all tools so audits proceed to the real page.'
  ] },
  { version: '2.3.0', date: '2026-07-10', notes: [
    '10 device viewports with model labels (added 1200 / 480 / 430 / 380).'
  ] },
  { version: '2.2.0', date: '2026-07-09', notes: [
    'Windows installer + Add/Remove Programs, scan cancel/retry, SGEN red theme, single-row tool tabs.'
  ] }
];
function readHistory() { try { const h = JSON.parse(fs.readFileSync(UPDATE_LOG, 'utf8')); return Array.isArray(h) ? h : []; } catch (_) { return []; } }
function recordVersion() {   // append only when the running version changes (an update landing), not every launch
  if (!SELF_VER) return readHistory();
  const h = readHistory(); const last = h[h.length - 1];
  if (!last || last.version !== SELF_VER) {
    h.push({ version: SELF_VER, at: new Date().toISOString() });
    try { fs.mkdirSync(NOTES_DIR, { recursive: true }); fs.writeFileSync(UPDATE_LOG, JSON.stringify(h.slice(-60))); } catch (_) {}
  }
  return h;
}

// Auto-check (DETECT ONLY — never downloads): poll the engine feed's version.txt in the background and
// cache the latest. The UI compares it to the running app version and reddens the button + toasts when a
// newer one exists; the actual download + install stays a manual click through the shell.
const FEED_VERSION_URL = 'https://github.com/docssgen-admin/migration-qa/releases/download/engine-latest/version.txt';
let FEED_VERSION = null;
function fetchFeedVersion() {
  return new Promise((resolve) => {
    (function go(u, n) {
      if (n > 5) return resolve(null);
      const req = https.get(u, { headers: { 'User-Agent': 'sgen-site-qa' } }, (r) => {
        if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) { r.resume(); return go(r.headers.location, n + 1); }
        if (r.statusCode !== 200) { r.resume(); return resolve(null); }
        let b = ''; r.setEncoding('utf8'); r.on('data', c => b += c); r.on('end', () => resolve(b.trim()));
      });
      req.on('error', () => resolve(null));
      req.setTimeout(10000, () => { req.destroy(); resolve(null); });
    })(FEED_VERSION_URL, 0);
  });
}
function refreshFeed() { fetchFeedVersion().then(v => { if (v) FEED_VERSION = v; }).catch(() => {}); }

// Detailed diagnostics as Markdown — for the user to download from the Logs window and send for review.
function safeResolve(m) { try { require.resolve(m); return true; } catch (_) { return false; } }
function tailFile(p, n) { try { const t = fs.readFileSync(p, 'utf8').split(/\r?\n/); return t.slice(-n).join('\n'); } catch (_) { return ''; } }
function buildDiagnostics() {
  const L = [], now = new Date().toISOString();
  L.push('# SGEN Site QA — Diagnostics', '', '_Generated ' + now + '_', '');
  L.push('## Version');
  L.push('- Running engine: **' + (SELF_VER || 'base (bundled with the app)') + '**');
  L.push('- Latest on update feed: **' + (FEED_VERSION || 'unknown / offline') + '**');
  L.push('- Engine directory: `' + __dirname + '`');
  L.push('- User data: `' + NOTES_DIR + '`', '');
  L.push('## Environment');
  L.push('- Node: ' + process.version);
  L.push('- Platform: ' + process.platform + ' ' + process.arch);
  L.push('- Local server port: ' + PORT);
  L.push('- Playwright browsers path: `' + (process.env.PLAYWRIGHT_BROWSERS_PATH || '(default)') + '`');
  L.push('- Playwright module: ' + (safeResolve('playwright') ? 'present' : 'MISSING'));
  L.push('- sharp module: ' + (safeResolve('sharp') ? 'present' : 'MISSING'));
  L.push('- Bundled browsers dir exists: ' + ((process.env.PLAYWRIGHT_BROWSERS_PATH && fs.existsSync(process.env.PLAYWRIGHT_BROWSERS_PATH)) ? 'yes' : 'no / unknown'));
  L.push('- Uptime: ' + Math.round(process.uptime()) + 's');
  try { L.push('- Memory RSS: ' + Math.round(process.memoryUsage().rss / 1048576) + ' MB'); } catch (_) {}
  L.push('- Active scans right now: ' + ACTIVE_SCANS, '');
  L.push('## Update history (this machine)');
  const h = readHistory();
  if (h.length) h.slice().reverse().forEach(e => L.push('- v' + e.version + ' — ' + e.at)); else L.push('- (none recorded yet)');
  L.push('');
  L.push('## Recent runs');
  let runs = []; try { runs = listRuns(); } catch (_) {}
  L.push('- Runs directory: `' + RUNS + '`');
  L.push('- Total listed: ' + runs.length);
  runs.slice(0, 25).forEach(r => L.push('- [' + r.kind + '] ' + r.host + ' — ' + r.when + '  (`' + r.id + '`)'));
  L.push('');
  L.push('## Recent app log (last 60 lines)');
  const logTxt = tailFile(path.join(NOTES_DIR, 'logs', 'main.log'), 60);
  L.push('```', logTxt || '(no log file found)', '```', '');
  L.push('## Version notes (recent)');
  CHANGELOG.slice(0, 6).forEach(c => { L.push('### v' + c.version + ' (' + c.date + ')'); c.notes.forEach(n => L.push('- ' + n)); L.push(''); });
  return L.join('\n');
}

// ---- shared page chrome (nav + shared runner) ---------------------------------------------------
function appPage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SGEN Site QA</title><style>${STYLE}
  :root{--nav-h:56px}
  /* header row: brand (left) + utility actions (right). Tool tabs live in their OWN full-width bar below. */
  .topbar{position:sticky;top:0;z-index:20;background:var(--surface)}
  .top{display:flex;align-items:center;gap:12px;padding:11px 20px;min-height:var(--nav-h);border-bottom:1px solid var(--line)}
  .top .brand{display:flex;align-items:center;gap:10px;font-weight:700;letter-spacing:-.01em;font-size:15px;flex:none}
  .top .brand .mk{width:28px;height:28px;border-radius:8px;background:var(--brand-solid);display:grid;place-items:center;flex:none}
  .top .brand .bt{display:flex;flex-direction:column;line-height:1.12}
  .top .brand .bv{font-size:10px;font-weight:500;color:var(--ink-faint);letter-spacing:.02em;font-family:var(--mono)}
  .hdr-actions{display:flex;align-items:center;gap:8px;margin-left:auto;min-width:0}
  .top .env{font-family:var(--mono);font-size:11px;color:var(--ink-faint);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  /* full-width tool tab bar — four equal quarters; active carries a red underline + surface lift */
  .tabbar{display:flex;background:var(--surface);border-bottom:1px solid var(--line-strong)}
  .tabbar button{flex:1 1 0;min-width:0;display:flex;flex-direction:column;gap:2px;padding:12px 18px;cursor:pointer;background:transparent;border:0;border-right:1px solid var(--line);border-bottom:2px solid transparent;color:var(--ink-soft);font-family:inherit;text-align:left;transition:background .12s ease,border-color .12s ease,color .12s ease}
  .tabbar button:last-child{border-right:0}
  .tabbar button b{font-size:14px;font-weight:650;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
  .tabbar button .nd{font-size:11px;font-weight:450;color:var(--ink-faint);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
  .tabbar button:hover{background:var(--surface-2)}
  .tabbar button:focus-visible{outline:2px solid var(--brand);outline-offset:-2px}
  .tabbar button.on{background:var(--surface-2);border-bottom-color:var(--brand-solid)}
  .tabbar button.on b{color:#fff}
  .tabbar button.on .nd{color:var(--ink-soft)}
  /* responsive: drop help/env first, then thin the tabs, then wrap to 2x2, then stack */
  @media(max-width:900px){ .help-btn{display:none} }
  @media(max-width:760px){ .top .env{display:none} .tabbar button .nd{display:none} .tabbar button{padding:11px 12px;text-align:center;align-items:center} .tabbar button b{font-size:13px} }
  @media(max-width:560px){ .tabbar{flex-wrap:wrap} .tabbar button{flex:1 1 45%;border-bottom:1px solid var(--line)} .tabbar button.on{border-bottom:2px solid var(--brand-solid)} }
  @media(max-width:440px){ .top .brand .bv{display:none} }
  /* overflow-x:clip (NOT hidden) prevents sideways scroll WITHOUT creating a scroll container, so the
     sticky header + tool tabs stay locked to the top during scroll. */
  html,body{max-width:100%;overflow-x:clip}
  .topbar{box-shadow:0 1px 0 var(--line),0 6px 18px -12px rgba(0,0,0,.6)}
  .wrap{width:100%;max-width:none;margin:0;padding:26px clamp(22px,4vw,56px) 60px;box-sizing:border-box}
  .panel{display:none}.panel.on{display:block}
  .card,.pbar,.status,.cmplink{width:100%;box-sizing:border-box}
  .row{width:100%}
  iframe{width:100%;box-sizing:border-box}
  h2.tt{font-size:20px;margin:0 0 4px;letter-spacing:-.02em}
  p.sub{color:var(--ink-soft);font-size:13.5px;margin:0 0 18px;line-height:1.6}
  .card{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow);padding:18px;margin-bottom:14px}
  .row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
  label.fld{display:flex;flex-direction:column;gap:5px;font-size:12px;color:var(--ink-soft);font-weight:600;flex:1;min-width:220px}
  input[type=text],select{font-family:var(--mono);font-size:13.5px;padding:10px 12px;border:1px solid var(--line-strong);border-radius:9px;background:var(--surface-2);color:var(--ink);outline:none;width:100%}
  input[type=text]:focus,select:focus{border-color:var(--brand)}
  input[type=number]{width:70px;font-family:var(--mono);padding:7px 9px;border:1px solid var(--line);border-radius:7px;background:var(--surface-2);color:var(--ink)}
  .run{background:var(--brand-solid);color:#fff;border:0;border-radius:9px;padding:11px 22px;font-size:14px;font-weight:650;cursor:pointer;white-space:nowrap;font-family:inherit}
  .run:disabled{opacity:.55;cursor:default}
  .run.ghost{background:var(--surface-2);color:var(--ink-soft);border:1px solid var(--line-strong);margin-left:8px}
  .run.ghost:hover{color:var(--ink);border-color:var(--ink-faint)}
  .run.retry{background:transparent;color:var(--brand);border:1px solid var(--brand);margin-left:8px}
  .run.retry:hover{background:var(--surface-2)}
  .upd{display:flex;align-items:center;gap:8px;margin-left:10px}
  .upd-btn{background:transparent;border:1px solid var(--line-strong);color:var(--ink-soft);border-radius:8px;padding:6px 12px;font-size:12px;font-family:inherit;cursor:pointer}
  .upd-btn:hover{color:var(--ink);border-color:var(--brand)}.upd-btn:disabled{opacity:.55;cursor:default}
  .upd-btn.has-update{color:#fff;background:var(--brand-solid);border-color:var(--brand-solid);font-weight:700}
  .upd-btn.has-update:hover{background:var(--brand);border-color:var(--brand);color:#fff}
  .upd-toast{position:fixed;right:18px;bottom:18px;z-index:200;max-width:340px;background:var(--surface);border:1px solid var(--brand-solid);border-left:4px solid var(--brand-solid);border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.5);padding:13px 16px;font-size:12.5px;color:var(--ink-soft);line-height:1.55;opacity:0;transform:translateY(10px);transition:opacity .3s,transform .3s}
  .upd-toast.show{opacity:1;transform:none}
  .upd-toast b{color:var(--ink);display:block;margin-bottom:3px;font-size:13px}
  .upd-st{font-family:var(--mono);font-size:11px;color:var(--ink-faint);white-space:nowrap}
  .chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:6px}
  .chip{display:flex;align-items:center;gap:6px;font-size:12.5px;color:var(--ink-soft);background:var(--surface-2);border:1px solid var(--line);border-radius:7px;padding:6px 10px;cursor:pointer;user-select:none}
  .chip input{accent-color:var(--brand-solid)}
  /* viewport chips: even grid so 10 device widths line up in tidy columns instead of a ragged wrap */
  #v-vps{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px}
  #v-vps .chip{white-space:nowrap}
  .grp{margin-top:14px}.grp .glab{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-faint);font-weight:700;margin-bottom:7px}
  .opts{display:flex;flex-wrap:wrap;gap:16px;margin-top:14px;align-items:center;font-size:13px;color:var(--ink-soft)}
  .opts label{display:flex;align-items:center;gap:6px}
  .note{font-size:11.5px;color:var(--ink-faint);margin:12px 0 0;line-height:1.6}.note b{color:var(--ink-soft);font-weight:640}
  .status{font-family:var(--mono);font-size:13px;color:var(--ink-soft);min-height:22px;margin-top:14px}
  .status .spin{display:inline-block;width:11px;height:11px;border:2px solid var(--line-strong);border-top-color:var(--brand);border-radius:50%;animation:sp .8s linear infinite;vertical-align:-1px;margin-right:8px}
  @keyframes sp{to{transform:rotate(360deg)}}
  .pbar{height:8px;background:var(--surface-2);border:1px solid var(--line);border-radius:99px;overflow:hidden;display:none;margin-top:12px}.pbar.on{display:block}
  .pfill{height:100%;width:0;background:var(--brand);transition:width .35s ease;border-radius:99px}
  .cmplink{font-size:13px;margin-top:10px}.cmplink a{color:var(--brand);font-weight:600}
  iframe{width:100%;height:auto;min-height:72vh;border:1px solid var(--line);border-radius:12px;background:var(--ground);display:block;overflow:hidden;margin-top:14px}
  .pipe{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px;font-family:var(--mono);font-size:11.5px}
  .pipe span{padding:4px 9px;border:1px solid var(--line);border-radius:99px;color:var(--ink-faint)}
  .pipe span.on{border-color:var(--brand);color:var(--brand);background:var(--surface-2)}
  .pipe span.done{border-color:var(--ok,#C8181C);color:var(--ok,#C8181C)}
  .rlist{display:flex;flex-direction:column;gap:8px}
  .ritem{display:flex;align-items:center;gap:12px;padding:11px 13px;border:1px solid var(--line);border-radius:10px;background:var(--surface-2);font-size:13px}
  .ritem .tag{font-family:var(--mono);font-size:10.5px;font-weight:700;padding:3px 8px;border-radius:6px;text-transform:uppercase;letter-spacing:.04em}
  .tag.audit{background:#2A3A55;color:#BcD}.tag.visual{background:#3A2A55;color:#DcF}.tag.cert{background:#553A2A;color:#FDc}.tag.case{background:#2A5541;color:#cFD}
  .ritem .nm{flex:1;font-family:var(--mono);color:var(--ink)}.ritem .when{color:var(--ink-faint);font-size:11.5px}
  .ritem a{color:var(--brand);font-weight:600;font-size:12.5px}
  .hint{font-family:var(--mono);font-size:11px;color:var(--ink-faint)}
  /* two-column tool layout: controls left, results right */
  /* single column top-to-bottom (matches Site Audit): controls card, then results at full width — no empty sidebar */
  .toolgrid{display:block}
  .toolgrid .col-left,.toolgrid .col-right{min-width:0}
  .toolgrid .col-right{margin-top:18px}
  .card{margin-bottom:0}
  .placeholder{border:1px dashed var(--line-strong);border-radius:12px;padding:46px 22px;text-align:center;color:var(--ink-faint);font-size:13px;line-height:1.6;background:var(--surface-2)}
  .placeholder b{color:var(--ink-soft);display:block;margin-bottom:4px;font-size:13.5px}
  /* Site Audit — horizontal scan-configuration grouping (operator console, not a settings form) */
  .scancfg{margin-top:16px;padding-top:16px;border-top:1px solid var(--line)}
  /* URL(s) on one half, config on the other — fills the width, matches across tools */
  .cfg-split{display:flex;gap:22px;align-items:flex-start;flex-wrap:wrap}
  .cfg-split>.fld,.cfg-split>.cs-cfg,.cfg-split>.cs-col{flex:1 1 300px;min-width:0}
  .cfg-split .glab{margin-bottom:9px}
  .cs-col>.grp:first-child{margin-top:0}
  /* Site Audit: URL ~35%, scan config fills the rest on one row */
  .cfg-au>.fld{flex:0 1 35%;min-width:200px}
  .cfg-au>.cs-cfg{flex:1 1 60%;min-width:0}
  .cfg-au .cfg-grid{flex-wrap:nowrap;align-items:center}
  @media(max-width:900px){.cfg-au>.fld,.cfg-au>.cs-cfg{flex:1 1 100%}.cfg-au .cfg-grid{flex-wrap:wrap}}
  /* Visual + Post-Deploy: 2 inner columns, then an info + button footer row */
  .vc-foot{display:flex;gap:20px;align-items:flex-end;margin-top:16px;flex-wrap:nowrap}
  .vc-foot>.grp{flex:1 1 auto;min-width:0;margin-top:0}
  .vc-foot>.row{flex:none;width:auto;margin:0}
  @media(max-width:760px){.vc-foot{flex-wrap:wrap}.vc-foot>.grp{flex:1 1 100%}.vc-foot>.row{width:100%}}
  .cfg-grid{display:flex;flex-wrap:wrap;gap:14px 24px;align-items:center}
  .cfg-grid>label{display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--ink-soft);font-weight:600}
  .cfg-c{flex:0 0 auto}
  .cfg-g{flex:1 1 240px}
  .cfg-action{display:flex;justify-content:flex-end;margin-top:18px}
  @media(max-width:820px){ .cfg-c,.cfg-g{flex:1 1 calc(50% - 24px)} }
  @media(max-width:520px){ .cfg-grid{gap:12px} .cfg-grid>label{flex:1 1 100%} .cfg-action{margin-top:14px} .cfg-action .run{width:100%} }
  /* help bubble */
  .help{display:inline-flex;align-items:center;justify-content:center;width:15px;height:15px;border-radius:50%;background:var(--surface-2);border:1px solid var(--line-strong);color:var(--ink-soft);font-size:10px;font-weight:700;cursor:help;margin-left:6px;position:relative;font-family:var(--mono);vertical-align:middle}
  .help:hover,.help:focus{background:var(--brand-solid);color:#fff;border-color:var(--brand-solid);outline:none}
  .help .tip{display:none;position:absolute;left:50%;bottom:calc(100% + 9px);transform:translateX(-50%);width:250px;max-width:70vw;background:var(--surface);border:1px solid var(--line-strong);border-radius:10px;box-shadow:var(--shadow);padding:11px 13px;font-size:11.5px;line-height:1.55;color:var(--ink-soft);z-index:60;text-align:left;font-family:inherit;font-weight:400;white-space:normal}
  .help:hover .tip,.help:focus .tip{display:block}
  .help .tip b{color:var(--ink);display:block;margin-bottom:3px;font-size:12px}
  .help .tip em{color:var(--brand-ink);font-style:normal;display:block;margin-top:5px}
  /* guided tour (spotlight coach-marks) */
  .tour{position:fixed;inset:0;z-index:100;display:none;pointer-events:none}
  .tour.on{display:block}
  #tour-hi{position:fixed;border-radius:10px;box-shadow:0 0 0 9999px rgba(0,0,0,.74),0 0 0 2px var(--brand-solid),0 0 22px 3px rgba(224,31,38,.35);transition:top .28s ease,left .28s ease,width .28s ease,height .28s ease,opacity .2s;pointer-events:none;opacity:0}
  #tour-hi.show{opacity:1}
  .tour-pop{position:fixed;width:340px;max-width:90vw;background:var(--surface);border:1px solid var(--line-strong);border-radius:14px;box-shadow:var(--shadow);padding:18px 20px 0;pointer-events:auto;transition:top .28s ease,left .28s ease}
  .tour-pop .tour-lbl{font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:var(--brand-ink);font-weight:700;margin-bottom:6px}
  .tour-pop h3{font-size:17px;margin:0 0 8px;letter-spacing:-.01em}
  .tour-pop p{color:var(--ink-soft);font-size:13px;line-height:1.6;margin:0 0 14px}
  .tour-foot{display:flex;align-items:center;gap:9px;padding:13px 0;border-top:1px solid var(--line);margin:0 -20px 0;padding-left:20px;padding-right:20px}
  .wk-dots{display:flex;flex-wrap:wrap;gap:5px;flex:1 1 0;min-width:0;margin-right:8px}
  .wk-dots i{width:7px;height:7px;border-radius:50%;background:var(--line-strong);transition:background .2s}.wk-dots i.on{background:var(--brand-solid)}
  .wk-btn{background:var(--surface);border:1px solid var(--line-strong);color:var(--ink);border-radius:8px;padding:8px 17px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit}
  .wk-btn:disabled{opacity:.4;cursor:default}
  .wk-btn.primary{background:var(--brand-solid);color:#fff;border-color:var(--brand-solid)}
  .wk-skip{background:none;border:0;color:var(--ink-faint);font-size:12px;cursor:pointer;font-family:inherit;margin-right:4px}
  .help-btn{background:none;border:1px solid var(--line-strong);color:var(--ink-soft);border-radius:8px;padding:6px 12px;font-size:12.5px;font-weight:600;cursor:pointer;font-family:inherit}
  /* version log modal */
  .logmodal{position:fixed;inset:0;z-index:120;display:none;align-items:flex-start;justify-content:center;background:rgba(0,0,0,.6);padding:6vh 16px;overflow:auto}
  .logmodal.on{display:flex}
  .logcard{background:var(--surface);border:1px solid var(--line-strong);border-radius:14px;box-shadow:var(--shadow);width:640px;max-width:100%}
  .loghead{display:flex;align-items:center;justify-content:space-between;padding:15px 20px;border-bottom:1px solid var(--line)}
  .loghead b{font-size:15px;letter-spacing:-.01em}
  .logx{background:none;border:none;color:var(--ink-soft);font-size:15px;cursor:pointer;line-height:1;padding:4px 6px}
  .logx:hover{color:var(--ink)}
  .logbody{padding:16px 20px 22px;max-height:64vh;overflow:auto}
  .loghead-r{display:flex;gap:8px;align-items:center}
  .logdiag{background:var(--surface-2);border:1px solid var(--line);color:var(--ink-soft);border-radius:7px;padding:5px 11px;font-size:11.5px;cursor:pointer;font-family:inherit}
  .logdiag:hover{border-color:var(--brand);color:var(--ink)}
  .diagbar{display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap}
  .sec-note{font-size:11.5px;color:var(--ink-faint);margin-bottom:10px;line-height:1.5}
  .diagmd{white-space:pre-wrap;word-break:break-word;font-family:var(--mono);font-size:11px;line-height:1.5;color:var(--ink-soft);background:var(--surface-2);border:1px solid var(--line);border-radius:8px;padding:12px;max-height:50vh;overflow:auto;margin:0}
  .logsec{font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:var(--brand-ink);font-weight:700;margin:16px 0 8px}
  .logsec:first-child{margin-top:0}
  .logrow{display:flex;align-items:baseline;gap:10px;padding:3px 0;font-size:12.5px}
  .logrel{padding:9px 0 10px;border-top:1px solid var(--line)}
  .logrel:first-of-type{border-top:none}
  .logrelh{display:flex;align-items:baseline;gap:10px;margin-bottom:5px}
  .logv{font-weight:700;font-size:13px;color:var(--ink)}
  .lognow{font-size:10px;font-weight:700;color:#fff;background:var(--brand-solid);border-radius:5px;padding:1px 6px;margin-left:6px;text-transform:uppercase;letter-spacing:.04em}
  .logmut{color:var(--ink-faint);font-size:11.5px}
  .logrel ul{margin:0;padding-left:18px}
  .logrel li{font-size:12.5px;color:var(--ink-soft);line-height:1.65;margin:2px 0}
  .help-btn:hover{color:var(--ink);border-color:var(--brand)}
  /* reports two-column */
  /* Reports: single column too — run list on top, full-width preview below */
  .rgrid{display:block}
  .rgrid .col-left,.rgrid .col-right{min-width:0}
  .rgrid .col-right{margin-top:16px}
  .rgrid .rlist{max-height:40vh;overflow:auto}
  .rfilters{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px}
  .rfilters button{background:var(--surface-2);border:1px solid var(--line);color:var(--ink-soft);border-radius:7px;padding:5px 11px;font-size:12px;cursor:pointer;font-family:inherit}
  .rfilters button.on{background:var(--brand-solid);color:#fff;border-color:var(--brand-solid)}
  .ritem{cursor:pointer}.ritem.sel{border-color:var(--brand);background:var(--surface)}
  .rtools{display:flex;gap:8px;margin-bottom:10px}
  .rtools #r-search{flex:1 1 auto;min-width:0;width:auto;background:var(--surface-2);border:1px solid var(--line);color:var(--ink);border-radius:8px;padding:7px 11px;font-size:12.5px;font-family:inherit}
  .rtools #r-search:focus{outline:none;border-color:var(--brand)}
  .rtools #r-date{flex:0 0 auto;width:auto;background:var(--surface-2);border:1px solid var(--line);color:var(--ink-soft);border-radius:8px;padding:7px 9px;font-size:12px;font-family:inherit;cursor:pointer}
  .rgroup{display:flex;flex-direction:column;gap:8px;margin-bottom:16px}
  .rghead{display:flex;align-items:center;gap:8px;font-family:var(--mono);font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--ink-faint);font-weight:700;padding:0 2px 6px;border-bottom:1px solid var(--line)}
  .rghead .rgc{background:var(--surface-2);border:1px solid var(--line);border-radius:99px;padding:0 7px;font-size:10px;color:var(--ink-soft)}
  </style></head><body>
  <header class="topbar">
    <div class="top">
      <div class="brand"><span class="mk"><svg viewBox="0 0 24 24" width="17" height="17" fill="none"><path d="M5 12.5l4.2 4.2L19 7" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg></span><span class="bt">SGEN Site QA<span class="bv" id="brand-ver"></span></span></div>
      <div class="hdr-actions">
        <div class="upd" id="upd" style="display:none"><button class="upd-btn" id="upd-btn" onclick="updClick()">Check for updates</button><span class="upd-st" id="upd-st"></span></div>
        <button class="help-btn" id="logs-btn" onclick="openLog()" title="Version log &amp; what changed">Logs</button>
        <button class="help-btn" id="manual-btn" onclick="openManual()" title="Open the user manual">Manual</button>
        <button class="help-btn" id="help-btn" onclick="openWalk()" title="Reopen the walkthrough">? Help</button>
      </div>
    </div>
    <nav class="tabbar" role="tablist" aria-label="Tools">
      <button data-t="audit" class="on" onclick="tab('audit')"><b>1 · Site Audit</b><span class="nd">quality-check one site</span></button>
      <button data-t="visual" onclick="tab('visual')"><b>2 · Visual Comparison</b><span class="nd">old vs new, side by side</span></button>
      <button data-t="cert" onclick="tab('cert')"><b>3 · Post-Deployment Check</b><span class="nd">did everything make it across?</span></button>
      <button data-t="reports" onclick="tab('reports');loadReports()"><b>4 · Reports</b><span class="nd">past runs · HTML · PDF</span></button>
    </nav>
  </header>
  <div class="wrap">

    <!-- 1 SITE AUDIT -->
    <section class="panel on" id="p-audit">
      <h2 class="tt">Site Audit</h2><p class="sub">Full single-site tester — links, forms, responsive, accessibility (axe-core), SEO, performance, security (TLS), cross-browser (Firefox + WebKit), console. Independent: needs no inventory, comparison, or certification.</p>
      <div class="card">
        <div class="cfg-split cfg-au">
          <label class="fld" style="min-width:0">Site URL<input id="a-url" type="text" placeholder="e.g. sgen.com" spellcheck="false"></label>
          <div class="cs-cfg">
            <div class="glab">Scan Configuration</div>
            <div class="cfg-grid">
              <label class="cfg-c">Max pages <input id="a-max" type="number" value="1" min="1" max="500"><span class="help" tabindex="0">?<span class="tip"><b>Max pages</b>How many pages to crawl and test. 1 = homepage only; higher follows the sitemap + internal links up to this cap.<em>Example: 1 for a quick single-page check.</em></span></span></label>
              <label class="cfg-c"><input id="a-render" type="checkbox" checked> Browser render <span class="help" tabindex="0">?<span class="tip"><b>Browser render</b>Loads each page in a real headless browser for axe-core accessibility, Core Web Vitals, full-page screenshots, and Firefox + WebKit. Off = faster static-only scan.</span></span></label>
              <label class="cfg-g">Save report as <input id="a-save" type="text" placeholder="reference name" style="flex:1;min-width:120px"><span class="help" tabindex="0">?<span class="tip"><b>Save report as</b>Stores this scan as a reference for future comparisons.<em>Example: save the live site, then compare staging to it.</em></span></span></label>
            </div>
          </div>
        </div>
        <div class="cfg-action"><button class="run" id="a-btn" onclick="runAudit()">Run audit</button><button class="run ghost" id="a-cancel" onclick="cancelScan('a')" style="display:none">Cancel</button><button class="run retry" id="a-retry" onclick="retryScan('a')" style="display:none">Retry</button></div>
      </div>
      <div class="pbar" id="a-pbar"><div class="pfill" id="a-pfill"></div></div><div class="status" id="a-status"></div><div class="cmplink" id="a-link"></div><div id="a-frame"></div>
      <div class="placeholder" id="a-ph"><b>Results appear here</b>Run an audit to see the quality score, findings, screenshots, and the full report preview.</div>
    </section>

    <!-- 2 VISUAL COMPARISON -->
    <section class="panel" id="p-visual">
      <h2 class="tt">Visual Comparison</h2><p class="sub">Compare a reference site and a target site visually across industry device breakpoints — no prior audit, no certification, no stored inventory. Diffs page render + full DOM structure.</p>
      <div class="toolgrid">
        <div class="col-left"><div class="card">
          <div class="cfg-split">
            <div class="cs-col">
              <label class="fld" style="min-width:0">Reference URL<input id="v-ref" type="text" placeholder="old / source site" spellcheck="false"></label>
              <label class="fld" style="min-width:0;margin-top:12px">Target URL<input id="v-tgt" type="text" placeholder="new / SGEN site" spellcheck="false"></label>
            </div>
            <div class="cs-col">
              <div class="grp"><div class="glab">Scope <span class="help" tabindex="0">?<span class="tip"><b>Scope</b>How many pages to compare. <b style="display:inline">Full site</b> discovers additional linked pages — useful for audits, but may surface non-canonical URLs (pagination, query variants).<em>Example: Single page for a fast homepage check.</em></span></span></div>
                <div class="row" style="gap:12px;align-items:center;flex-wrap:nowrap">
                  <select id="v-scope" style="flex:1;min-width:0;max-width:340px"><option value="single">Single page (homepage)</option><option value="multiple">Multiple pages (up to max)</option><option value="sitemap">Sitemap-driven</option><option value="full">Full site</option></select>
                  <label style="font-size:12px;color:var(--ink-soft);display:flex;align-items:center;gap:6px;flex:none">max pages <input id="v-max" type="number" value="1" min="1" max="200"></label></div></div>
              <div class="grp"><div class="glab">Viewports <span class="help" tabindex="0">?<span class="tip"><b>Viewports</b>Industry-standard device widths. The 360–480 phone band is where most real-world breakage lives.<em>desktop · laptop · iPad landscape/portrait · iPhone Pro Max · iPhone · Android · Galaxy S</em></span></span></div><div class="chips" id="v-vps">
                <label class="chip"><input type="checkbox" value="1920" checked>1920 · Desktop</label><label class="chip"><input type="checkbox" value="1440" checked>1440 · Laptop</label><label class="chip"><input type="checkbox" value="1200" checked>1200 · Laptop&nbsp;sm</label><label class="chip"><input type="checkbox" value="1024" checked>1024 · iPad&nbsp;LS</label><label class="chip"><input type="checkbox" value="768" checked>768 · iPad</label><label class="chip"><input type="checkbox" value="480" checked>480 · Mobile&nbsp;lg</label><label class="chip"><input type="checkbox" value="430" checked>430 · iPhone&nbsp;Max</label><label class="chip"><input type="checkbox" value="390" checked>390 · iPhone</label><label class="chip"><input type="checkbox" value="380" checked>380 · Android</label><label class="chip"><input type="checkbox" value="360" checked>360 · Galaxy&nbsp;S</label></div></div>
            </div>
          </div>
          <div class="vc-foot">
            <div class="grp"><div class="glab">What's compared <span class="help" tabindex="0">?<span class="tip"><b>What's compared</b>Every comparison runs the full check — there is nothing to toggle.<em>Pixel match + structural diff at each viewport.</em></span></span></div>
              <div style="font-size:12.5px;color:var(--ink-soft);line-height:1.7;background:var(--surface-2);border:1px solid var(--line);border-radius:9px;padding:10px 13px">
                Each paired page is compared at every selected viewport on two axes:
                <b style="display:inline;color:var(--ink)">pixel match</b> (visual difference %) and
                <b style="display:inline;color:var(--ink)">structural diff</b> — elements <b style="display:inline;color:var(--ink)">missing</b>, <b style="display:inline;color:var(--ink)">extra</b>, <b style="display:inline;color:var(--ink)">moved</b>, or <b style="display:inline;color:var(--ink)">restyled</b> vs the reference. The full check always runs.</div></div>
            <div class="row"><button class="run" id="v-btn" onclick="runVisual()">Run visual comparison</button><button class="run ghost" id="v-cancel" onclick="cancelScan('v')" style="display:none">Cancel</button><button class="run retry" id="v-retry" onclick="retryScan('v')" style="display:none">Retry</button></div>
          </div>
        </div></div>
        <div class="col-right">
          <div class="pbar" id="v-pbar"><div class="pfill" id="v-pfill"></div></div><div class="status" id="v-status"></div><div class="cmplink" id="v-link"></div><div id="v-frame"></div>
          <div class="placeholder" id="v-ph"><b>Comparison results appear here</b>Run a comparison to see the similarity score, screenshot gallery, difference images, and evidence.</div>
        </div>
      </div>
    </section>

    <!-- 3 MIGRATION CERTIFICATION -->
    <section class="panel" id="p-cert">
      <h2 class="tt">Post-Deployment Check</h2><p class="sub">Answers one question: <b>did everything make it across?</b> Inventories every page, section, image, menu and form on the source site, then verifies each one exists intact on the new build — with evidence per item and a PASS / PASS&nbsp;WITH&nbsp;MINOR&nbsp;ISSUES / FAIL verdict. Run it after deploying the rebuild, before go-live.</p>
      <div class="toolgrid">
        <div class="col-left"><div class="card">
          <div class="cfg-split">
            <div class="cs-col">
              <label class="fld" style="min-width:0">Source URL<input id="c-src" type="text" placeholder="original site" spellcheck="false"></label>
              <label class="fld" style="min-width:0;margin-top:12px">Target URL<input id="c-tgt" type="text" placeholder="migrated SGEN site" spellcheck="false"></label>
            </div>
            <div class="cs-col">
              <div class="grp"><div class="glab">Migration options</div><div class="opts" style="margin-top:0;flex-direction:column;align-items:flex-start;gap:11px">
                <label><input id="c-sitemap" type="checkbox"> sitemap-only completeness <span class="help" tabindex="0">?<span class="tip"><b>Sitemap-only</b>Uses the sitemap as the authoritative page list. Recommended for migration completeness checks. Without it, a capped crawl reports completeness as <b style="display:inline">manual</b>, never authoritative.<em>Example: certify docs.sgen.com → staging against the sitemap.</em></span></span></label>
                <label><input id="c-visual" type="checkbox"> visual comparison stage</label>
                <label><input id="c-prod" type="checkbox" checked> production validation (audit target)</label>
                <label>max pages <input id="c-max" type="number" value="1" min="1" max="700"></label>
              </div></div>
            </div>
          </div>
          <div class="vc-foot">
            <div class="grp"><div class="glab">Evidence <span class="help" tabindex="0">?<span class="tip"><b>Evidence</b>Every finding must have proof (screenshot / DOM / network). Findings without available proof are marked <b style="display:inline">Manual Verification Required</b> — never silently passed.</span></span></div>
              <div class="hint">Findings carry inventory IDs, status, and an evidence package.</div></div>
            <div class="row"><button class="run" id="c-btn" onclick="runCert()">Run certification</button><button class="run ghost" id="c-cancel" onclick="cancelScan('c')" style="display:none">Cancel</button><button class="run retry" id="c-retry" onclick="retryScan('c')" style="display:none">Retry</button></div>
          </div>
        </div></div>
        <div class="col-right">
          <div class="glab" style="margin-bottom:7px">Pipeline</div>
          <div class="pipe" id="c-pipe"><span data-s="inventory">Inventory</span><span data-s="completeness">Completeness</span><span data-s="visual">Visual</span><span data-s="production">Production</span><span data-s="certification">Certification</span></div>
          <div class="pbar" id="c-pbar"><div class="pfill" id="c-pfill"></div></div><div class="status" id="c-status"></div><div class="cmplink" id="c-link"></div><div id="c-frame"></div>
          <div class="placeholder" id="c-ph"><b>Post-deployment results appear here</b>Run the check to see what was found on the source, what made it across, the verdict, and findings with evidence.</div>
        </div>
      </div>
    </section>

    <!-- 4 REPORTS -->
    <section class="panel" id="p-reports">
      <h2 class="tt">Reports</h2><p class="sub">Review previous runs. Select one to preview its report; open the HTML or save it as a PDF to share.</p>
      <div class="rgrid">
        <div class="col-left">
          <div class="rtools">
            <input id="r-search" type="text" placeholder="Search site or report name…" oninput="renderReports()" spellcheck="false">
            <select id="r-date" onchange="renderReports()" title="Filter by date"><option value="all">Any time</option><option value="1">Today</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option></select>
          </div>
          <div class="rfilters" id="r-filters">
            <button data-f="all" class="on" onclick="rfilter('all')">All</button>
            <button data-f="audit" onclick="rfilter('audit')">Audit</button>
            <button data-f="visual" onclick="rfilter('visual')">Visual</button>
            <button data-f="cert" onclick="rfilter('cert')">Cert</button>
            <button data-f="case" onclick="rfilter('case')">Cases</button>
          </div>
          <div class="rlist" id="r-list"><div class="hint">Loading…</div></div>
        </div>
        <div class="col-right">
          <div id="r-preview"></div>
          <div class="placeholder" id="r-ph"><b>Select a report</b>Choose a run above to preview its HTML report, evidence, and assets here.</div>
        </div>
      </div>
    </section>

  </div>

  <!-- guided tour (spotlight coach-marks; shown once; reopen via ? Help) -->
  <div id="tour" class="tour">
    <div id="tour-hi"></div>
    <div id="tour-pop" class="tour-pop">
      <div class="tour-lbl" id="tour-lbl"></div>
      <h3 id="tour-title"></h3>
      <p id="tour-body"></p>
      <div class="tour-foot">
        <button class="wk-skip" onclick="tourEnd()">Skip tour</button>
        <div class="wk-dots" id="tour-dots"></div>
        <button class="wk-btn" id="tour-back" onclick="tourGo(-1)">Back</button>
        <button class="wk-btn primary" id="tour-next" onclick="tourGo(1)">Next</button>
      </div>
    </div>
  </div>

  <!-- version log & update history (opened from the Logs button beside Help) -->
  <div id="logmodal" class="logmodal" onclick="if(event.target===this)closeLog()">
    <div class="logcard">
      <div class="loghead"><b>Version log &amp; updates</b><div class="loghead-r"><button class="logdiag" onclick="genDiag()">Generate diagnostics</button><button class="logx" onclick="closeLog()" aria-label="Close">&#10005;</button></div></div>
      <div class="logbody" id="logbody"></div>
    </div>
  </div>

  <script>
    var VPMAP={1920:'1920 · desktop',1440:'1440 · laptop',1200:'1200 · laptop-sm',1024:'1024 · iPad landscape',768:'768 · iPad portrait',480:'480 · mobile-lg',430:'430 · iPhone Pro Max',390:'390 · iPhone',380:'380 · Android',360:'360 · Galaxy S'};
    function tab(t){document.querySelectorAll('.panel').forEach(function(p){p.classList.remove('on')});document.getElementById('p-'+t).classList.add('on');document.querySelectorAll('.tabbar button').forEach(function(b){b.classList.toggle('on',b.dataset.t===t)});}
    function $(id){return document.getElementById(id);}
    function checked(cid){return [].slice.call(document.querySelectorAll('#'+cid+' input:checked')).map(function(i){return i.value});}
    function setProg(pre,pct,phase){$(pre+'-pbar').classList.add('on');pct=Math.max(2,Math.min(100,pct||0));$(pre+'-pfill').style.width=pct+'%';if(phase)$(pre+'-status').innerHTML='<span class="spin"></span>'+phase+' — '+pct+'%';}
    function endProg(pre){setProg(pre,100,'');setTimeout(function(){$(pre+'-pbar').classList.remove('on')},400);}
    // desktop notification when a scan finishes — fires as a native OS toast when the tab is in the
    // background or the window unfocused (multitasking), plus a soft chime + title flash either way.
    var TOOL_NAME={a:'Site Audit',v:'Visual Comparison',c:'Post-Deployment Check'};
    var baseTitle=document.title;
    function chime(){try{var ctx=new (window.AudioContext||window.webkitAudioContext)();var o=ctx.createOscillator(),g=ctx.createGain();o.connect(g);g.connect(ctx.destination);o.frequency.value=880;g.gain.setValueAtTime(0.0001,ctx.currentTime);g.gain.exponentialRampToValueAtTime(0.06,ctx.currentTime+0.02);g.gain.exponentialRampToValueAtTime(0.0001,ctx.currentTime+0.5);o.start();o.stop(ctx.currentTime+0.55);}catch(e){}}
    function flashTitle(msg){var n=0,iv=setInterval(function(){document.title=(n%2?baseTitle:msg);if(++n>9||!document.hidden){clearInterval(iv);document.title=baseTitle;}},900);}
    function scanNotify(pre,m){
      var tool=TOOL_NAME[pre]||'Scan';
      var body=m.ok===false?('Failed: '+String(m.error||'unknown error').slice(0,120))
        :(m.verdict?tool+': '+m.verdict+(m.score!=null?' \\u00b7 '+m.score+'%':'')+(m.tally?' \\u00b7 '+(m.tally.fail||0)+' failed / '+(m.tally.warn||0)+' warnings':'')
        :(m.overall!=null?tool+': '+m.overall+'% match \\u00b7 '+(m.pairs||0)+' page(s)':tool+' finished'));
      chime();flashTitle('\\u2713 '+tool+' done');
      if(!('Notification' in window))return;
      if((document.hidden||!document.hasFocus())&&Notification.permission==='granted'){
        try{var nt=new Notification('SGEN Site QA \\u2014 '+tool+' finished',{body:body,tag:'sgenqa-'+pre,requireInteraction:false});nt.onclick=function(){try{window.focus();}catch(e){}nt.close();};}catch(e){}
      }
    }
    // per-tool abort controllers + last-run args, so a scan can be Cancelled mid-flight and Retried.
    var CTRL={},LAST={};
    function showCtl(pre,which){ // which: 'run' | 'cancel' | 'retry'
      $(pre+'-btn').style.display=which==='cancel'?'none':'';
      $(pre+'-cancel').style.display=which==='cancel'?'':'none';
      $(pre+'-retry').style.display=which==='retry'?'':'none';
    }
    function cancelScan(pre){var c=CTRL[pre];if(c){c.abort();}$(pre+'-btn').disabled=false;endProg(pre);showCtl(pre,'run');$(pre+'-status').textContent='Scan cancelled.';}
    function retryScan(pre){var l=LAST[pre];if(l){stream(l.endpoint,l.body,pre,l.onDone);}}
    function stream(endpoint,body,pre,onDone){
      if('Notification' in window&&Notification.permission==='default'){try{Notification.requestPermission();}catch(e){}} // ask on the Run gesture, so the first finished scan can already toast
      LAST[pre]={endpoint:endpoint,body:body,onDone:onDone};
      var ctrl=new AbortController();CTRL[pre]=ctrl;
      var btn=$(pre+'-btn');btn.disabled=true;showCtl(pre,'cancel');$(pre+'-frame').innerHTML='';$(pre+'-link').innerHTML='';setProg(pre,3,'starting');
      fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:ctrl.signal}).then(function(r){
        var reader=r.body.getReader(),dec=new TextDecoder(),buf='';
        function pump(){return reader.read().then(function(res){if(res.done)return;buf+=dec.decode(res.value,{stream:true});var lines=buf.split('\\n');buf=lines.pop();lines.forEach(function(ln){if(ln.trim()){try{var m=JSON.parse(ln);if(m.t==='p'){setProg(pre,m.pct,m.phase);if(m.stage)mark(pre,m.stage);}else if(m.t==='done'){CTRL[pre]=null;btn.disabled=false;endProg(pre);showCtl(pre,m.ok===false?'retry':'run');scanNotify(pre,m);onDone(m);}}catch(e){}}});return pump();});}
        return pump();
      }).catch(function(err){CTRL[pre]=null;btn.disabled=false;endProg(pre);if(err&&err.name==='AbortError'){showCtl(pre,'run');return;}showCtl(pre,'retry');$(pre+'-status').innerHTML='Request error: '+err;});
    }
    // Grow an embedded report iframe to its FULL content height so the whole page scrolls (no tiny
    // nested scrollbar). ResizeObserver tracks late layout (dashboard animations, lazy images) + a
    // 12s poll fallback. Reused by Site Audit + Reports preview.
    function autosize(f){
      function fit(){try{var d=f.contentWindow.document;var h=Math.max(d.body.scrollHeight,d.documentElement.scrollHeight,d.body.offsetHeight);if(h>200)f.style.height=(h+48)+'px';}catch(e){}}
      f.addEventListener('load',function(){
        fit();
        try{var d=f.contentWindow.document;
          if(window.ResizeObserver){var ro=new ResizeObserver(fit);ro.observe(d.documentElement);if(d.body)ro.observe(d.body);}
          if(d.fonts&&d.fonts.ready)d.fonts.ready.then(fit);
          [].forEach.call(d.images,function(im){if(!im.complete)im.addEventListener('load',fit);});
        }catch(e){}
        var n=0,iv=setInterval(function(){fit();if(++n>48)clearInterval(iv);},250);
      });
    }
    function showReport(pre,route,label){
      var ph=$(pre+'-ph'); if(ph)ph.style.display='none';
      $(pre+'-link').innerHTML='<a href="'+route+'" target="_blank">↗ Open '+label+' in a new tab</a>';
      var f=document.createElement('iframe');f.scrolling='no';autosize(f);f.src=route;
      $(pre+'-frame').appendChild(f);
    }
    function mark(pre,stage){var p=$(pre+'-pipe');if(!p)return;var els=p.querySelectorAll('span');var hit=false;els.forEach(function(s){if(s.dataset.s===stage){s.className='on';hit=true;}else if(!hit){s.className='done';}});}

    // 1 Site Audit
    function runAudit(){var url=$('a-url').value.trim();if(!url){$('a-status').textContent='Enter a site URL.';return;}
      stream('/api/run',{url:url,maxPages:+$('a-max').value||1,render:$('a-render').checked,save:$('a-save').value.trim()},'a',function(m){
        if(!m.ok){$('a-status').textContent='Scan failed: '+(m.error||'unknown');return;}
        $('a-status').innerHTML='Done — '+m.verdict+' · score '+m.score+'% · pass '+m.tally.pass+' / warn '+m.tally.warn+' / fail '+m.tally.fail+' / manual '+m.tally.manual+' · saved to history';
        var cmp='';if(m.comparison)cmp=' · <a href="/compare/'+m.id+'" target="_blank">open comparison ↗</a>';$('a-link').innerHTML='<a href="/report/'+m.id+'" target="_blank">↗ Open full report</a>'+cmp;
        showReport('a','/report/'+m.id,'report');});}

    // 2 Visual Comparison
    function runVisual(){var ref=$('v-ref').value.trim(),tgt=$('v-tgt').value.trim();if(!ref||!tgt){$('v-status').textContent='Enter both Reference and Target URLs.';return;}
      var vps=checked('v-vps').map(function(w){return VPMAP[w]});
      stream('/api/visual',{ref:ref,target:tgt,scope:$('v-scope').value,maxPages:+$('v-max').value||1,viewports:vps,axes:checked('v-ax')},'v',function(m){
        if(!m.ok){$('v-status').textContent='Comparison failed: '+(m.error||'unknown');return;}
        $('v-status').innerHTML='Done — overall match '+m.overall+'% · '+m.pairs+' page(s) · '+m.viewports+' viewport(s)'+(m.sharp?'':' · (pixel diff off: sharp missing)');
        showReport('v','/visual/'+m.id,'visual report');});}

    // 3 Post-Deployment Check
    function runCert(){var src=$('c-src').value.trim(),tgt=$('c-tgt').value.trim();if(!src||!tgt){$('c-status').textContent='Enter both Source and Target URLs.';return;}
      $('c-pipe').querySelectorAll('span').forEach(function(s){s.className=''});
      stream('/api/certify',{source:src,target:tgt,sitemapOnly:$('c-sitemap').checked,visual:$('c-visual').checked,production:$('c-prod').checked,maxPages:+$('c-max').value||1},'c',function(m){
        if(!m.ok){$('c-status').textContent='Post-deployment check failed: '+(m.error||'unknown');return;}
        $('c-pipe').querySelectorAll('span').forEach(function(s){s.className='done'});
        var subw=(m.subErrors&&m.subErrors.length)?' <span style="color:var(--warn)">· '+m.subErrors.length+' stage(s) skipped: '+m.subErrors.join('; ')+'</span>':'';
        $('c-status').innerHTML='<b>'+m.verdict+'</b> — passed '+m.tally.passed+' · warnings '+m.tally.warning+' · failed '+m.tally.failed+' · manual '+m.tally.manual+' · approved '+m.tally.approved+subw;
        showReport('c','/certify/'+m.id,'certification report');});}

    // 4 Reports — history list (left) + preview (right), filterable
    var R_DATA={runs:[],cases:[]},R_FILTER='all';
    function loadReports(){fetch('/api/reports').then(function(r){return r.json()}).then(function(d){R_DATA=d;renderReports();}).catch(function(e){$('r-list').innerHTML='<div class="hint">reports error: '+e+'</div>';});}
    function rfilter(f){R_FILTER=f;[].forEach.call(document.querySelectorAll('#r-filters button'),function(b){b.classList.toggle('on',b.dataset.f===f)});renderReports();}
    function renderReports(){
      var el=$('r-list'),f=R_FILTER;
      var q=((($('r-search')||{}).value)||'').trim().toLowerCase();
      var dsel=(($('r-date')||{}).value)||'all';
      var cutoff=dsel==='all'?0:(Date.now()-parseInt(dsel,10)*86400000);
      var runs=(R_DATA.runs||[]).filter(function(x){
        if(f==='case')return false;
        if(f!=='all'&&x.kind!==f)return false;
        if(cutoff&&x.mtime&&x.mtime<cutoff)return false;
        if(q&&((x.host||'')+' '+(x.id||'')+' '+x.kind).toLowerCase().indexOf(q)<0)return false;
        return true;
      });
      // group by site (host); groups ordered by most-recent run (runs already come newest-first)
      var groups={},order=[];
      runs.forEach(function(x){ if(!groups[x.host]){groups[x.host]=[];order.push(x.host);} groups[x.host].push(x); });
      order.sort(function(a,b){return (groups[b][0].mtime||0)-(groups[a][0].mtime||0);});
      var html='';
      order.forEach(function(host){
        var items=groups[host];
        html+='<div class="rgroup"><div class="rghead">'+host+' <span class="rgc">'+items.length+'</span></div>';
        items.forEach(function(x){
          var route=x.kind==='visual'?'/visual/'+x.id:(x.kind==='cert'?'/certify/'+x.id:'/report/'+x.id);
          html+='<div class="ritem" data-route="'+route+'" data-json="'+route+'/'+x.json+'" onclick="selectReport(this)"><span class="tag '+(x.kind==='visual'?'visual':x.kind==='cert'?'cert':'audit')+'">'+(x.kind==='visual'?'Visual':x.kind==='cert'?'Post-Deploy':'Audit')+'</span><span class="nm">'+x.when+'</span></div>';
        });
        html+='</div>';
      });
      if(f==='all'||f==='case'){ var cs=(R_DATA.cases||[]).filter(function(c){return !q||((c.name||'').toLowerCase().indexOf(q)>=0);});
        if(cs.length){ html+='<div class="rgroup"><div class="rghead">Qualification cases <span class="rgc">'+cs.length+'</span></div>';
          cs.forEach(function(c){html+='<div class="ritem"><span class="tag case">Case</span><span class="nm">'+c.name+'</span><span class="when">'+(c.verdict||'')+' · '+(c.metrics?c.metrics.pages+'p':'')+'</span></div>';});
          html+='</div>'; } }
      el.innerHTML=html||'<div class="hint">No reports match — try clearing the search or date filter.</div>';
    }
    function selectReport(elm){
      [].forEach.call(document.querySelectorAll('#r-list .ritem'),function(i){i.classList.remove('sel')});elm.classList.add('sel');
      var route=elm.dataset.route,json=elm.dataset.json;
      $('r-ph').style.display='none';
      $('r-preview').innerHTML='<div class="cmplink"><a href="'+route+'" target="_blank">↗ Open HTML</a> &nbsp; <a href="/api/pdf?route='+encodeURIComponent(route)+'">⬇ Save as PDF</a></div>';
      var fr=document.createElement('iframe');fr.scrolling='no';autosize(fr);fr.src=route;
      $('r-preview').appendChild(fr);
    }

    // Guided tour — spotlight coach-marks that switch tabs + highlight the real controls (shown once
    // per browser; reopen via ? Help). Each step: {tab, target selector, title, body}.
    var WK_KEY='sgenqa_onboarded_v2';
    var TOUR=[
      {tab:'audit',target:null,lbl:'Welcome',title:'SGEN Site QA',body:"Four offline tools to check any website's quality — audit, compare, verify a migration, and review reports. Nothing leaves this machine. Let me show you around."},
      {tab:'audit',target:'.tabbar',lbl:'Navigation',title:'Four tools, one app',body:'Switch tools here — the header and these tabs stay locked in place as you scroll. Site Audit checks one site · Visual Comparison diffs old vs new · Post-Deployment Check verifies a migration · Reports holds past runs.'},
      {tab:'audit',target:'#a-url',lbl:'Tool 1 · Site Audit',title:'Enter any site URL',body:'Point it at a live site; the scan configuration sits beside it. Everything you set — URLs, options, viewports — is saved automatically, so you never re-enter it next launch.'},
      {tab:'audit',target:'#a-btn',lbl:'Tool 1 · Site Audit',title:'Read the result at a glance',body:'The report opens with one clear OVERALL pass/fail up top; the other numbers are 0–100 quality reads, not separate verdicts. The summary cards are clickable — jump straight to the failing checks — and a colour key explains that red means passing.'},
      {tab:'visual',target:'#v-ref',lbl:'Tool 2 · Visual Comparison',title:'Old vs new, side by side',body:'Give a reference URL and a target URL. Every paired page is compared at each viewport on two axes: pixel match and structural diff (missing / extra / moved / restyled elements).'},
      {tab:'visual',target:'#v-vps',lbl:'Tool 2 · Viewports',title:'Real device widths',body:'Industry-standard breakpoints — desktop, laptop, iPad, iPhone Pro Max, iPhone, Android, Galaxy S. The 360–480 phone band is where most real-world breakage hides.'},
      {tab:'cert',target:'#c-src',lbl:'Tool 3 · Post-Deployment Check',title:'Did everything make it across?',body:'After a migration, this inventories every page, section, image, menu and form on the source and verifies each exists intact on the new build — with a PASS / MINOR / FAIL verdict.'},
      {tab:'reports',target:'[data-t=reports]',lbl:'Tool 4 · Reports',title:'Every run, grouped by site',body:'Past runs are grouped by site, newest first, with a search box and a date filter. Preview any run, open its HTML, or save it as a PDF to hand off. Runs stay on this machine.'},
      {tab:'audit',target:'#upd-btn',lbl:'Updates',title:'Automatic check, manual apply',body:'The app checks for updates on its own — this button turns red and a toast appears when one is ready. Click it to download, then Restart: a one-second in-app update, no installer.'},
      {tab:'audit',target:'#logs-btn',lbl:'Logs & support',title:'Version log + diagnostics',body:'Open Logs to see what changed in each version and your update history. “Generate diagnostics” builds a detailed report you can download and send over if anything looks off.'},
      {tab:'audit',target:'#help-btn',lbl:'Done',title:"That's the tour",body:"Reopen it anytime from ? Help. Enter a URL and run your first audit whenever you're ready."}
    ];
    var TW=0;
    (function initDots(){var d=$('tour-dots');for(var i=0;i<TOUR.length;i++){var s=document.createElement('i');d.appendChild(s);}})();
    function tourShow(){
      var st=TOUR[TW]; if(st.tab)tab(st.tab);
      $('tour-lbl').textContent=st.lbl;$('tour-title').textContent=st.title;$('tour-body').textContent=st.body;
      [].forEach.call($('tour-dots').children,function(d,i){d.classList.toggle('on',i===TW);});
      $('tour-back').disabled=TW===0;$('tour-next').textContent=TW===TOUR.length-1?'Finish':'Next';
      var hi=$('tour-hi'),pop=$('tour-pop');
      var el=st.target?document.querySelector(st.target):null;
      if(el){ el.scrollIntoView({behavior:'smooth',block:'center'});
        setTimeout(function(){ var r=el.getBoundingClientRect(),pad=8;
          hi.style.top=(r.top-pad)+'px';hi.style.left=(r.left-pad)+'px';hi.style.width=(r.width+pad*2)+'px';hi.style.height=(r.height+pad*2)+'px';hi.classList.add('show');
          var pw=pop.offsetWidth||340,ph=pop.offsetHeight||200,gap=14,vw=innerWidth,vh=innerHeight;
          var left=Math.min(Math.max(12,r.left),vw-pw-12);
          var top=(r.bottom+gap+ph<vh)?(r.bottom+gap):(r.top-gap-ph);
          top=Math.max(12,Math.min(top,vh-ph-12));   // keep the whole popup (incl. Next button) on-screen
          pop.style.left=left+'px';
          pop.style.top=top+'px';
        },300);
      } else { hi.classList.remove('show');
        pop.style.left=(innerWidth/2-170)+'px';pop.style.top=(innerHeight/2-120)+'px';
      }
    }
    function tourGo(dir){ if(dir>0&&TW===TOUR.length-1){tourEnd();return;} TW=Math.max(0,Math.min(TOUR.length-1,TW+dir)); tourShow(); }
    function openWalk(){ TW=0; $('tour').classList.add('on'); tourShow(); }
    // ---- version log & update history ----
    function logEsc(s){return String(s).replace(/[&<>]/g,function(c){return c==='&'?'&amp;':c==='<'?'&lt;':'&gt;';});}
    function logFmt(iso){try{return new Date(iso).toLocaleString([],{year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});}catch(e){return iso;}}
    function openLog(){
      var m=$('logmodal'); m.classList.add('on'); var b=$('logbody'); b.innerHTML='<div class="logmut">Loading…</div>';
      var cur=window.__appver||null;
      fetch('/api/notes').then(function(r){return r.json();}).then(function(d){
        var h='', hist=(d.history||[]).slice().reverse();
        if(hist.length){ h+='<div class="logsec">Update history — this computer</div>';
          hist.forEach(function(e){ h+='<div class="logrow"><span class="logv">v'+logEsc(e.version)+'</span><span class="logmut">updated '+logFmt(e.at)+'</span></div>'; }); }
        h+='<div class="logsec">What changed in each version</div>';
        (d.changelog||[]).forEach(function(c){
          var now=(cur&&c.version===cur)||(!cur&&c.version===d.current);
          h+='<div class="logrel"><div class="logrelh"><span class="logv">v'+logEsc(c.version)+(now?'<span class="lognow">now</span>':'')+'</span><span class="logmut">'+logEsc(c.date||'')+'</span></div><ul>';
          (c.notes||[]).forEach(function(n){ h+='<li>'+logEsc(n)+'</li>'; });
          h+='</ul></div>';
        });
        b.innerHTML=h;
      }).catch(function(){ b.innerHTML='<div class="logmut">Could not load version notes.</div>'; });
    }
    function closeLog(){ $('logmodal').classList.remove('on'); }
    function openManual(){ try{ window.open('/manual','_blank'); }catch(e){} }
    // Diagnostics — pull a detailed Markdown report from the engine; user downloads/copies it to send for review.
    function genDiag(){
      var b=$('logbody'); b.innerHTML='<div class="logmut">Gathering diagnostics…</div>';
      fetch('/api/diagnostics').then(function(r){return r.json();}).then(function(d){
        window.__diag={md:d.markdown||'',name:d.filename||'sgen-site-qa-diagnostics.md'};
        b.innerHTML='<div class="diagbar"><button class="logdiag" onclick="dlDiag()">\\u2b07 Download .md</button><button class="logdiag" onclick="copyDiag(this)">Copy to clipboard</button><button class="logdiag" onclick="openLog()">\\u2039 Back to log</button></div><div class="sec-note">Save this file and send it over for review — it includes versions, environment, update history, recent runs, and the recent app log.</div><pre class="diagmd" id="diagmd"></pre>';
        $('diagmd').textContent=window.__diag.md;
      }).catch(function(){ b.innerHTML='<div class="logmut">Could not gather diagnostics. Try again.</div>'; });
    }
    function dlDiag(){ if(!window.__diag)return; try{var blob=new Blob([window.__diag.md],{type:'text/markdown'});var a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=window.__diag.name;document.body.appendChild(a);a.click();setTimeout(function(){URL.revokeObjectURL(a.href);a.remove();},1500);}catch(e){} }
    function copyDiag(btn){ if(!window.__diag)return; try{navigator.clipboard.writeText(window.__diag.md).then(function(){if(btn){var t=btn.textContent;btn.textContent='Copied \\u2713';setTimeout(function(){btn.textContent=t;},1500);}});}catch(e){} }
    document.addEventListener('keydown',function(e){ if(e.key==='Escape') closeLog(); });
    // "tour seen" persists via the Electron shell (window.sgenApp) when present - the app runs on a fresh
    // random port each launch so page localStorage never carries over; browser build falls back to localStorage.
    function markTourSeen(){ try{localStorage.setItem(WK_KEY,'1');}catch(e){} if(window.sgenApp&&sgenApp.setFlag){try{sgenApp.setFlag(WK_KEY,'1');}catch(e){}} }
    function tourSeen(cb){
      if(window.sgenApp&&sgenApp.getFlag){ sgenApp.getFlag(WK_KEY).then(function(v){cb(!!v);}).catch(function(){try{cb(!!localStorage.getItem(WK_KEY));}catch(e){cb(false);}}); }
      else { try{cb(!!localStorage.getItem(WK_KEY));}catch(e){cb(false);} }
    }
    function tourEnd(){ $('tour').classList.remove('on'); $('tour-hi').classList.remove('show'); markTourSeen(); }
    var closeWalk=tourEnd; // ? Help + Esc compatibility
    tourSeen(function(seen){ if(!seen){ markTourSeen(); setTimeout(openWalk,350); } }); // mark on first auto-open so it never re-shows, even if closed mid-tour (? Help still reopens)
    document.addEventListener('keydown',function(e){if($('tour').classList.contains('on')){if(e.key==='Escape')tourEnd();else if(e.key==='ArrowRight')tourGo(1);else if(e.key==='ArrowLeft')tourGo(-1);}});
    addEventListener('resize',function(){if($('tour').classList.contains('on'))tourShow();});

    // in-app updater control — active ONLY inside the Electron shell (preload injects window.sgenUpdate).
    // In the plain browser / CLI build the bridge is absent, so the control stays hidden. check → (if an
    // update exists) download → restart-to-install, driven by events forwarded from the main process.
    (function(){
      if(!window.sgenUpdate)return;
      var box=$('upd'),btn=$('upd-btn'),st=$('upd-st'),mode='check',toasted='';
      box.style.display='';
      function set(t){st.textContent=t;}
      function svGt(a,b){var pa=String(a).split('.').map(Number),pb=String(b).split('.').map(Number);for(var i=0;i<3;i++){if((pa[i]||0)>(pb[i]||0))return true;if((pa[i]||0)<(pb[i]||0))return false;}return false;}
      try{sgenUpdate.version().then(function(v){if(v){window.__appver=v;var bv=$('brand-ver');if(bv)bv.textContent='v'+v;if(mode==='check')set('v'+v);autoCheck();}});}catch(e){}
      window.updClick=function(){
        if(mode==='install'){sgenUpdate.install();return;}
        if(mode==='download'){btn.disabled=true;set('Downloading…');sgenUpdate.download();return;}
        btn.disabled=true;set('Checking…');   // 'avail' or plain check -> shell verifies + downloads (manual)
        sgenUpdate.check().then(function(r){btn.disabled=false;if(r&&r.state==='dev')set(r.message||'Installed build only');else if(r&&r.state==='error')set('Error: '+(r.message||''));});
      };
      sgenUpdate.onStatus(function(p){
        if(!p)return;
        if(p.state==='checking'){btn.disabled=true;set('Checking…');}
        else if(p.state==='none'){btn.disabled=false;mode='check';btn.classList.remove('has-update');btn.textContent='Check for updates';set('Up to date');}
        else if(p.state==='available'){btn.disabled=false;mode='download';btn.classList.add('has-update');btn.textContent='Download update';set('v'+(p.version||'')+' available');}
        else if(p.state==='downloading'){btn.disabled=true;set('Downloading… '+(p.percent||0)+'%');}
        else if(p.state==='downloaded'){btn.disabled=false;mode='install';btn.classList.add('has-update');btn.textContent='Restart to update';set('v'+(p.version||'')+' ready');}
        else if(p.state==='error'){btn.disabled=false;set('Update error');}
      });
      // AUTO-CHECK — detect only, never downloads. Poll the engine's cached feed version; if it's newer than
      // the running app, redden the button + toast. Download + install stay a manual click (above).
      function updToast(v){var t=document.createElement('div');t.className='upd-toast';t.innerHTML='<b>Update available — v'+v+'</b>Click the red “Update available” button in the top bar to download, then Restart to install.';document.body.appendChild(t);requestAnimationFrame(function(){t.classList.add('show');});setTimeout(function(){t.classList.remove('show');setTimeout(function(){if(t.parentNode)t.remove();},400);},9000);}
      function markAvail(v){if(mode==='install'||mode==='download')return;mode='avail';btn.disabled=false;btn.classList.add('has-update');btn.textContent='Update available';set('v'+v);if(toasted!==v){toasted=v;updToast(v);}}
      function autoCheck(){if(mode==='install'||mode==='download')return;fetch('/api/feed-version').then(function(r){return r.json();}).then(function(d){if(d&&d.version&&window.__appver&&svGt(d.version,window.__appver))markAvail(d.version);}).catch(function(){});}
      setInterval(autoCheck,10*60*1000);
    })();

    // Persist tool settings across launches — every input/checkbox/select is saved on change and restored
    // on load, so you don't re-set them each time. Backed by the shell's userData (window.sgenApp) with a
    // localStorage fallback (the engine runs on a fresh random port each launch, resetting page localStorage).
    (function(){
      var KEY='sgenqa_form_v1';
      var IDS=['a-url','a-max','a-render','a-save','v-ref','v-tgt','v-scope','v-max','c-src','c-tgt','c-sitemap','c-visual','c-prod','c-max'];
      var GROUPS=['v-vps','v-ax'];   // checkbox groups, keyed by container id
      function lsGet(){try{return JSON.parse(localStorage.getItem(KEY)||'{}');}catch(e){return {};}}
      function load(cb){ if(window.sgenApp&&sgenApp.getFlag){sgenApp.getFlag(KEY).then(function(v){cb(v?JSON.parse(v):lsGet());}).catch(function(){cb(lsGet());});} else cb(lsGet()); }
      function store(s){var j=JSON.stringify(s);if(window.sgenApp&&sgenApp.setFlag){try{sgenApp.setFlag(KEY,j);}catch(e){}}try{localStorage.setItem(KEY,j);}catch(e){}}
      var st={};
      function snapshot(){IDS.forEach(function(id){var el=$(id);if(!el)return;st[id]=el.type==='checkbox'?el.checked:el.value;});GROUPS.forEach(function(g){var c=$(g);if(!c)return;st[g]=[].slice.call(c.querySelectorAll('input:checked')).map(function(i){return i.value;});});store(st);}
      load(function(saved){ st=saved||{};
        IDS.forEach(function(id){var el=$(id);if(!el||st[id]==null)return;if(el.type==='checkbox')el.checked=!!st[id];else el.value=st[id];});
        GROUPS.forEach(function(g){var c=$(g);if(!c||!st[g])return;c.querySelectorAll('input').forEach(function(i){i.checked=st[g].indexOf(i.value)>=0;});});
        IDS.forEach(function(id){var el=$(id);if(el)el.addEventListener('change',snapshot);});
        GROUPS.forEach(function(g){var c=$(g);if(c)c.querySelectorAll('input').forEach(function(i){i.addEventListener('change',snapshot);});});
      });
    })();
  </script></body></html>`;
}

// ---- serving helpers ----------------------------------------------------------------------------
function send(res, code, type, body) { res.writeHead(code, { 'content-type': type }); res.end(body); }
function readBody(req) { return new Promise((resolve) => { let b = ''; req.on('data', c => b += c); req.on('end', () => resolve(b)); }); }
function serveReport(res, id, file, prefix) {
  const f = path.join(RUNS, id, file);
  if (!fs.existsSync(f)) return send(res, 404, 'text/plain', 'report not found');
  let html = fs.readFileSync(f, 'utf8');
  // UI-only serving fix: some frozen renderers emit Windows backslash separators in image paths
  // (path.relative on win32). Normalize \ -> / inside quoted image refs so the browser resolves them
  // under the injected <base>. Engine output on disk is untouched; only the served copy is normalized.
  html = html.replace(/((?:src|href)=")([^"]*\.(?:png|jpe?g|webp|gif|svg))(")/gi, (m, a, pth, z) => a + pth.replace(/\\/g, '/') + z);
  // inject <base> so relative asset paths (shots/…, screenshots/…) resolve under the run dir
  const base = `<base href="/${prefix}/${id}/">`;
  html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + base) : base + html;
  send(res, 200, 'text/html; charset=utf-8', html);
}
function serveAsset(res, id, rest) {
  try { rest = decodeURIComponent(rest); } catch (_) {} // filenames carry spaces + '·' → percent-encoded by the browser
  rest = rest.replace(/\\/g, '/').replace(/\.\.[/\\]/g, ''); // normalize + strip traversal
  const f = path.join(RUNS, id, rest);
  if (!f.startsWith(RUNS) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return send(res, 404, 'text/plain', 'not found');
  send(res, 200, MIME[path.extname(f).toLowerCase()] || 'application/octet-stream', fs.readFileSync(f));
}
// pull an existing report route (id + trailing asset) apart: /prefix/<id>[/<asset...>]
function splitRoute(pathname, prefix) {
  const rest = pathname.slice(prefix.length).replace(/^\/+/, '');
  const slash = rest.indexOf('/');
  return slash < 0 ? { id: safe(rest), asset: '' } : { id: safe(rest.slice(0, slash)), asset: rest.slice(slash + 1) };
}

// ---- PDF export: render the served report through headless Chromium and stream a real PDF -------
// GET /api/pdf?route=/report/<id>  (also /visual/<id>, /certify/<id>). Renders THROUGH the local
// server route (not file://) so <base>-relative shots/screenshots resolve exactly as in the browser.
async function apiPdf(req, res, u) {
  const route = String(u.searchParams.get('route') || '');
  const m = route.match(/^\/(report|visual|certify)\/([a-z0-9._-]+)$/i);
  if (!m) return send(res, 400, 'text/plain', 'bad route');
  const id = safe(m[2]);
  if (!fs.existsSync(path.join(RUNS, id))) return send(res, 404, 'text/plain', 'run not found');
  let chromium;
  try { ({ chromium } = require('playwright')); }
  catch (e) { return send(res, 501, 'text/plain', 'PDF export needs Playwright (npx playwright install chromium)'); }
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${PORT}/${m[1]}/${id}`, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(1200); // client-side dashboard/scripts settle
    await page.emulateMedia({ media: 'screen' }); // keep the real dark report look, not print styles
    const pdf = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '10mm', bottom: '10mm', left: '8mm', right: '8mm' } });
    await browser.close(); browser = null;
    res.writeHead(200, { 'content-type': 'application/pdf', 'content-disposition': `attachment; filename="${id}.pdf"`, 'content-length': pdf.length });
    res.end(pdf);
  } catch (e) {
    if (browser) try { await browser.close(); } catch (_) {}
    send(res, 500, 'text/plain', 'PDF export failed: ' + (e && e.message || e));
  }
}

// ---- report history listing ---------------------------------------------------------------------
function listRuns() {
  if (!fs.existsSync(RUNS)) return [];
  return fs.readdirSync(RUNS).filter(d => !d.startsWith('_') && (() => { try { return fs.statSync(path.join(RUNS, d)).isDirectory(); } catch (_) { return false; } })()).map(id => {
    const dir = path.join(RUNS, id);
    let kind = 'audit', json = 'report.json';
    if (fs.existsSync(path.join(dir, 'visual-match.html'))) { kind = 'visual'; json = 'visual-match.json'; }
    else if (id.includes('-cert-')) { kind = 'cert'; json = 'report.json'; }
    let when = ''; try { when = new Date(fs.statSync(dir).mtimeMs).toISOString().replace('T', ' ').slice(0, 16); } catch (_) {}
    const host = id.replace(/-(vis|cert)-\d+$/, '').replace(/-\d{10,}$/, '');
    return { id, kind, host, when, json, mtime: (() => { try { return fs.statSync(dir).mtimeMs; } catch (_) { return 0; } })() };
  }).sort((a, b) => b.mtime - a.mtime).slice(0, 60);
}

// ---- server -------------------------------------------------------------------------------------
// active-scan tracking so the desktop shell can defer a silent auto-update/refresh until no scan is
// running (never restart mid-audit). Incremented per streaming scan; decremented when its response ends.
let ACTIVE_SCANS = 0;
function trackScan(res) { ACTIVE_SCANS++; let done = false; const end = () => { if (done) return; done = true; ACTIVE_SCANS = Math.max(0, ACTIVE_SCANS - 1); }; res.on('close', end); res.on('finish', end); return end; }
const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const p = u.pathname;
    if (req.method === 'GET' && p === '/') return send(res, 200, 'text/html; charset=utf-8', appPage());
    if (req.method === 'GET' && p === '/api/baselines') return send(res, 200, 'application/json', JSON.stringify({ baselines: listBaselines() }));
    if (req.method === 'GET' && p === '/api/reports') { let cases = []; try { cases = loadCases(path.join(DATA, 'portfolio.jsonl')); } catch (_) {} return send(res, 200, 'application/json', JSON.stringify({ runs: listRuns(), cases })); }
    if (req.method === 'GET' && p === '/api/status') return send(res, 200, 'application/json', JSON.stringify({ busy: ACTIVE_SCANS > 0, active: ACTIVE_SCANS }));
    if (req.method === 'GET' && p === '/api/notes') return send(res, 200, 'application/json', JSON.stringify({ current: SELF_VER, changelog: CHANGELOG, history: readHistory() }));
    if (req.method === 'GET' && p === '/api/feed-version') return send(res, 200, 'application/json', JSON.stringify({ version: FEED_VERSION, current: SELF_VER }));
    if (req.method === 'GET' && p === '/manual') return send(res, 200, 'text/html; charset=utf-8', MANUAL_HTML || '<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:44px;color:#333">The user manual is not available in this build.</body>');
    if (req.method === 'GET' && p === '/api/diagnostics') { const md = buildDiagnostics(); const fn = 'sgen-site-qa-diagnostics-' + (SELF_VER || 'base') + '-' + new Date().toISOString().slice(0, 10) + '.md'; return send(res, 200, 'application/json', JSON.stringify({ markdown: md, filename: fn })); }

    for (const [prefix, file] of [['report', 'report.html'], ['compare', 'comparison.html'], ['visual', 'visual-match.html'], ['certify', 'report.html']]) {
      if (req.method === 'GET' && p.startsWith('/' + prefix + '/')) {
        const { id, asset } = splitRoute(p, '/' + prefix);
        return asset ? serveAsset(res, id, asset) : serveReport(res, id, file, prefix);
      }
    }

    // await async handlers so their rejections are CAUGHT here (a bare `return apiRun()` would let a
    // rejection escape to an unhandled promise rejection — which crashes Node. Stress-test found this.)
    if (req.method === 'GET' && p === '/api/pdf') return await apiPdf(req, res, u);
    if (req.method === 'POST' && p === '/api/run') return await apiRun(req, res);
    if (req.method === 'POST' && p === '/api/visual') return await apiVisual(req, res);
    if (req.method === 'POST' && p === '/api/certify') return await apiCertify(req, res);
    return send(res, 404, 'text/plain', 'not found');
  } catch (e) { try { if (!res.headersSent) send(res, 500, 'text/plain', 'server error: ' + (e && e.message || e)); else res.end(); } catch (_) {} }
});

// 1 — Site Audit (unchanged engine path)
async function apiRun(req, res) {
  let opts; try { opts = JSON.parse(await readBody(req) || '{}'); } catch (e) { return send(res, 400, 'application/json', JSON.stringify({ ok: false, error: 'bad json' })); }
  if (!opts || typeof opts !== 'object' || Array.isArray(opts)) opts = {}; // guard null/array/scalar JSON
  const url = norm(opts.url); if (!url) return send(res, 400, 'application/json', JSON.stringify({ ok: false, error: 'pass a site URL' }));
  let host; try { host = new URL(url).host; } catch (e) { return send(res, 400, 'application/json', JSON.stringify({ ok: false, error: 'invalid URL' })); }
  const id = safe(host) + '-' + Date.now(), outDir = path.join(RUNS, id);
  res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' });
  trackScan(res);
  const emit = (o) => { try { res.write(JSON.stringify(o) + '\n'); } catch (e) {} };
  // cooperative cancel: when the client aborts the fetch the socket closes → the next engine
  // progress() call throws → the engine unwinds at the next page/render boundary (no engine edits).
  let aborted = false; const onClose = () => { aborted = true; }; req.on('close', onClose); res.on('close', onClose);
  const progress = (pct, phase) => { if (aborted) throw new Error('client-cancelled'); emit({ t: 'p', pct, phase }); };
  try {
    const data = await runAudit(url, { maxPages: opts.maxPages || 30, render: opts.render !== false, renderSample: Math.min(opts.maxPages || 30, 25), screensDir: path.join(outDir, 'screenshots'), log: () => {}, progress });
    emit({ t: 'p', pct: 99, phase: 'writing report' });
    renderReport(data, outDir); recordScan(data);
    let comparison = false, cmp = null;
    if (opts.save) saveBaseline(data, opts.save);
    if (opts.baseline) { try { const base = loadResult(opts.baseline); base.data._label = opts.baseline; data._label = 'current'; const d = diff(base.data, data); renderCompare(d, outDir); comparison = true; cmp = d.counts; } catch (e) {} }
    emit({ t: 'done', ok: true, id, verdict: data.verdict, score: data.score, tally: data.tally, comparison, cmp }); res.end();
  } catch (e) { if (!aborted) emit({ t: 'done', ok: false, error: String(e && e.message || e) }); res.end(); }
}

// 2 — Visual Comparison (frozen visual-match engine)
async function apiVisual(req, res) {
  let o; try { o = JSON.parse(await readBody(req) || '{}'); } catch (e) { return send(res, 400, 'application/json', JSON.stringify({ ok: false, error: 'bad json' })); }
  if (!o || typeof o !== 'object' || Array.isArray(o)) o = {}; // guard null/array/scalar JSON
  const ref = norm(o.ref), tgt = norm(o.target);
  if (!ref || !tgt) return send(res, 400, 'application/json', JSON.stringify({ ok: false, error: 'pass Reference and Target URLs' }));
  const SCOPE = { single: 1, multiple: o.maxPages || 8, sitemap: o.maxPages || 80, full: o.maxPages || 150 };
  const maxPages = SCOPE[o.scope] || o.maxPages || 8;
  const vps = Array.isArray(o.viewports) && o.viewports.length ? visualMatch.VIEWPORTS.filter(v => o.viewports.includes(v.label)) : null;
  const id = safe(H(ref)) + '-vis-' + Date.now(), outDir = path.join(RUNS, id);
  res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' });
  trackScan(res);
  const emit = (o2) => { try { res.write(JSON.stringify(o2) + '\n'); } catch (e) {} };
  let aborted = false; const onClose = () => { aborted = true; }; req.on('close', onClose); res.on('close', onClose);
  try {
    emit({ t: 'p', pct: 6, phase: 'discovering + rendering pages' });
    const data = await visualMatch.run(ref, tgt, { maxPages, outDir, viewports: vps, axes: o.axes, log: () => {}, progress: (pct, phase) => { if (aborted) throw new Error('client-cancelled'); emit({ t: 'p', pct: Math.max(6, Math.min(96, pct || 0)), phase: phase || 'comparing' }); } });
    emit({ t: 'p', pct: 98, phase: 'writing report' });
    renderVisual(data, outDir);
    emit({ t: 'done', ok: true, id, overall: data.overall, pairs: data.pairs, viewports: (data.viewports || []).length, sharp: data.sharp }); res.end();
  } catch (e) { if (!aborted) emit({ t: 'done', ok: false, error: String(e && e.message || e) }); res.end(); }
}

// 3 — Post-Deployment Check (frozen migration-certification pipeline; mirrors sgen-qa-certify.js orchestration)
async function apiCertify(req, res) {
  let o; try { o = JSON.parse(await readBody(req) || '{}'); } catch (e) { return send(res, 400, 'application/json', JSON.stringify({ ok: false, error: 'bad json' })); }
  if (!o || typeof o !== 'object' || Array.isArray(o)) o = {}; // guard null/array/scalar JSON
  const source = norm(o.source), target = norm(o.target);
  if (!source || !target) return send(res, 400, 'application/json', JSON.stringify({ ok: false, error: 'pass Source and Target URLs' }));
  const maxPages = o.maxPages || 30, sitemapOnly = !!o.sitemapOnly;
  const id = safe(H(source)) + '-cert-' + Date.now(), outDir = path.join(RUNS, id);
  fs.mkdirSync(outDir, { recursive: true });
  res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' });
  trackScan(res);
  const emit = (o2) => { try { res.write(JSON.stringify(o2) + '\n'); } catch (e) {} };
  let aborted = false; const onClose = () => { aborted = true; }; req.on('close', onClose); res.on('close', onClose);
  const step = (o2) => { if (aborted) throw new Error('client-cancelled'); emit(o2); };
  const subErrors = [];
  try {
    step({ t: 'p', pct: 8, phase: 'inventory — crawling source', stage: 'inventory' });
    const refCrawl = await discoverPages(source, { maxPages, sitemapOnly, log: () => {} });
    step({ t: 'p', pct: 22, phase: 'inventory — crawling target', stage: 'inventory' });
    const tgtCrawl = await discoverPages(target, { maxPages, sitemapOnly, log: () => {} });
    const at = new Date().toISOString();
    let auditResult = null, visualResult = null;
    // sub-stages are optional but their FAILURE must be surfaced — not silently swallowed (a failed
    // sub-step used to look like a clean pass). Capture the error and report it in the done frame.
    if (o.production !== false) { step({ t: 'p', pct: 42, phase: 'production validation — auditing target', stage: 'production' }); try { auditResult = await runAudit(target, { maxPages, render: true, screensDir: path.join(outDir, 'shots'), log: () => {} }); } catch (e) { if (aborted) throw e; subErrors.push('production audit: ' + String(e && e.message || e)); emit({ t: 'p', pct: 44, phase: 'production validation skipped (failed)', stage: 'production' }); } }
    if (o.visual) { step({ t: 'p', pct: 62, phase: 'visual comparison — device breakpoints', stage: 'visual' }); try { visualResult = await visualMatch.run(source, target, { maxPages, outDir: path.join(outDir, 'visual'), log: () => {} }); } catch (e) { if (aborted) throw e; subErrors.push('visual comparison: ' + String(e && e.message || e)); emit({ t: 'p', pct: 64, phase: 'visual comparison skipped (failed)', stage: 'visual' }); } }
    step({ t: 'p', pct: 82, phase: 'certifying', stage: 'certification' });
    const idRegistry = new IdRegistry(path.join(DATA, 'inventory-ids.jsonl'));
    const r = certifyMigration(refCrawl.pages, tgtCrawl.pages, {
      idRegistry, source: H(source), target: H(target), sourceHost: H(source), targetHost: H(target),
      auditResult, visualResult, at, capped: refCrawl.capped || tgtCrawl.capped,
      meta: { gitCommit, build: 'ui', environment: `node ${process.version} · ${process.platform}` },
    });
    emit({ t: 'p', pct: 96, phase: 'writing report' });
    fs.writeFileSync(path.join(outDir, 'report.html'), r.report.html);
    fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(r.report.json, null, 2));
    emit({ t: 'done', ok: true, id, verdict: r.cert.verdict, tally: r.cert.tally, subErrors: subErrors.length ? subErrors : undefined }); res.end();
  } catch (e) { if (!aborted) emit({ t: 'done', ok: false, error: String(e && e.stack || e) }); res.end(); }
}

server.requestTimeout = 0; server.headersTimeout = 0;
// Final safety net: a single bad request must NEVER take the whole server down. Log + keep serving.
// (Belt-and-suspenders behind the per-handler guards + awaited dispatch.)
process.on('unhandledRejection', (e) => { process.stderr.write('[unhandledRejection] ' + (e && e.message || e) + '\n'); });
process.on('uncaughtException', (e) => { process.stderr.write('[uncaughtException] ' + (e && e.stack || e) + '\n'); });
fs.mkdirSync(RUNS, { recursive: true }); fs.mkdirSync(DATA, { recursive: true });
recordVersion();   // note this version in the machine's update history (no-op unless the version changed)
refreshFeed(); setInterval(refreshFeed, 30 * 60 * 1000);   // background auto-check (detect only)
server.listen(PORT, '127.0.0.1', () => {
  process.stderr.write(`\nSGEN Site QA → http://127.0.0.1:${PORT}\n(4 tools: Site Audit · Visual Comparison · Post-Deployment Check · Reports. Ctrl+C to stop.)\n`);
  if (arg('open', false)) { try { spawn(process.platform === 'win32' ? 'cmd' : 'sh', process.platform === 'win32' ? ['/c', 'start', '', `http://127.0.0.1:${PORT}`] : ['-c', `xdg-open http://127.0.0.1:${PORT}`], { detached: true, stdio: 'ignore' }).unref(); } catch (e) {} }
});
