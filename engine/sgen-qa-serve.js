#!/usr/bin/env node
'use strict';
// sgen qa-serve — local web UI for the SGEN Site QA suite. FOUR independent tools, one browser app,
// bound to 127.0.0.1 only. No AI at runtime; no fake results. Every button POSTs to the SAME frozen
// engines the CLIs use — this file is UI-exposure ONLY and modifies none of them:
//
// ONE EXCEPTION, stated rather than buried: the per-tool settings popup's scope control needs the
// scorer to be able to score a SUBSET of the registry, which the frozen engines could not express.
// score.js therefore gained an opt-in `compute(suites, {excludeRules})` and report.js an opt-in
// `opts.scopePanel` slot. Both default to the previous behaviour exactly (no opts => byte-identical
// output => the CLIs and every existing caller are unchanged). Scope is a SCORING decision only:
// this file never asks the engine to skip a check, so findings/evidence/tally/verdict/readiness stay
// whole-site and a de-scoped run still reports every problem it found.
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
const { runAudit, SUITES: AUDIT_SUITES } = require('./lib/site-qa/audit');
const { applyAdvisory } = require('./lib/site-qa/pipeline');   // advisory pass: FUNC-008/009, Best Practices, Copy Review
const { compute: computeQuality } = require('./lib/site-qa/score');
const { RULES, WEIGHTS } = require('./lib/site-qa/rules/registry');
const { renderReport, STYLE, TOTOP_JS } = require('./lib/site-qa/report');
const { saveBaseline, loadResult, diff, listBaselines, recordScan, loadLatestRecord } = require('./lib/site-qa/compare');
const { renderCompare, renderComparePanel } = require('./lib/site-qa/report-compare');
const { discoverPages } = require('./lib/migration-qa/crawl');
const visualMatch = require('./lib/site-qa/visual-match');
const { render: renderVisual } = require('./lib/site-qa/report-visual');
const annotate = require('./lib/site-qa/annotate');
const { render: renderAnnotate } = require('./lib/site-qa/report-annotate');
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
// The literal below is the fallback used only when this dir is NOT named like a version (dev checkout).
// BUMP IT EVERY RELEASE — it has already gone stale twice. Keep in sync with package.json "version"
// and lib/site-qa/release-metadata.json packageVersion.
const SELF_VER = (path.basename(__dirname).match(/^\d+\.\d+\.\d+$/) || ['3.1.0'])[0];
const NOTES_DIR = path.join(process.env.APPDATA || process.env.HOME || __dirname, 'SGEN Site QA');
const UPDATE_LOG = path.join(NOTES_DIR, 'update-log.json');
// Newest first. Each shipped engine carries its own notes; older entries are kept for the in-app log.
const CHANGELOG = [
  { version: '2.5.13', date: '2026-07-14', notes: [
    'Audit criteria re-prioritization: fewer false launch-blockers, real security risks now gate. Bundles 2.5.11 developer-centric element context + 2.5.12 one-click Inspect.'
  ] },
  { version: '2.5.12', date: '2026-07-14', notes: [
    'Inspect: open any element issue in a live browser with the exact element highlighted (fingerprint→selector→xpath→signature fallback). In-app only.'
  ] },
  { version: '2.5.11', date: '2026-07-14', notes: [
    'Developer-centric report: every element issue now shows its exact DOM location (outerHTML, DOM path, XPath, classes, attributes, element box, ranked selectors) in the report + copy-ticket.'
  ] },
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
// ---- per-tool settings: saved defaults -----------------------------------------------------------
// Same persistence pattern as UPDATE_LOG above: a JSON file in NOTES_DIR (the user-data dir), read
// defensively, written best-effort. NOTES_DIR is deliberately the home rather than RUNS: a hot engine
// update extracts a NEW build into NOTES_DIR/engines/<version>/, so anything stored under the engine
// dir dies on the next update, and RUNS is scan OUTPUT (prunable). Settings sit beside update-log.json
// and outlive both.
//
// Two slots ONLY, matching the two operations the UI offers:
//   settings.tools.<tool>  the SAVED DEFAULT  — written by "Save as default", restored on page load
//   FACTORY (client-side)  the reset target   — restored by "Reset defaults", which also clears the slot
// There is deliberately no third "last used" slot: an implicit auto-stick tier would make "Save as
// default" a no-op you could not observe, which is precisely the fake-looking-real control this build
// is meant to remove.
const SETTINGS_FILE = path.join(NOTES_DIR, 'settings.json');
function readSettings() {
  try {
    const s = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    if (!s || typeof s !== 'object' || Array.isArray(s)) return { tools: {} };
    return { tools: (s.tools && typeof s.tools === 'object' && !Array.isArray(s.tools)) ? s.tools : {} };
  } catch (_) { return { tools: {} }; }
}
function writeSettings(s) {
  try { fs.mkdirSync(NOTES_DIR, { recursive: true }); fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ v: 1, tools: s.tools || {} }, null, 2)); return true; }
  catch (e) { return false; }
}
const TOOL_KEYS = ['audit', 'visual', 'cert', 'reports'];

// ---- scope catalog: the checks a Site Audit can be scored on -------------------------------------
// Derived from the registry + audit.SUITES — never hand-listed, so a registry change flows straight
// through to the UI. Only the 10 suites runAudit() actually assembles are offered: the registry also
// carries best-practices + visual, but those are weight-0 advisory suites this tool never emits
// (see the note in rules/registry.js), so listing them would be a control over nothing.
// Manual rules are OMITTED, not shown disabled: they carry deduction 0 and can never move the score,
// so a checkbox for one would be decoration.
const SCOPE_SUITE_KEYS = AUDIT_SUITES.map(s => s.key);
const SCOPE_CATALOG = {
  suites: AUDIT_SUITES.map(s => ({ key: s.key, name: s.name, desc: s.desc || '', weight: WEIGHTS[s.key] || 0 })),
  rules: RULES.filter(r => !r.manual && r.deduction > 0 && SCOPE_SUITE_KEYS.includes(r.suite))
    .map(r => ({ id: r.id, suite: r.suite, ded: r.deduction, tier: r.tier, sev: r.severity, title: r.title })),
  manualCount: RULES.filter(r => r.manual && SCOPE_SUITE_KEYS.includes(r.suite)).length,
};
const SCOPE_RULE_IDS = new Set(SCOPE_CATALOG.rules.map(r => r.id));
const ruleById = new Map(RULES.map(r => [r.id, r]));

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
const FEED_VERSION_URL = 'https://github.com/jerome653/migration-qa/releases/download/engine-latest/version.txt';
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

// ---- scope disclosure ---------------------------------------------------------------------------
// A clean score on a reduced scope is the most dangerous artifact this tool can emit: the number
// looks exactly like a whole-site pass, and a PDF of it walks out of the building with no hint that
// the red checks were simply switched off. So the moment scope is reduced the report says so ABOVE
// the score (report.js renders opts.scopePanel before the summary — you cannot reach the number
// without passing the notice), it names how many hidden checks are OPEN DEFECTS, and it says plainly
// which numbers are scoped and which are not. Fail closed, disclose always.
const hEsc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function scopeFacts(data, excludedIds) {
  const excluded = [...new Set(excludedIds || [])].filter((id) => SCOPE_RULE_IDS.has(id));
  // Which rules actually fired in THIS run — so the notice can say "and 3 of them are open defects"
  // rather than the toothless "some checks were excluded".
  const fired = new Map();
  for (const s of (data.suites || [])) for (const c of (s.checks || [])) {
    if (!c.ruleId || (c.status !== 'fail' && c.status !== 'warn')) continue;
    if (fired.get(c.ruleId) !== 'fail') fired.set(c.ruleId, c.status);
  }
  const openHidden = excluded.filter((id) => fired.has(id));
  const blockersHidden = openHidden.filter((id) => { const r = ruleById.get(id); return r && r.tier === 1; });
  const outBySuite = {};
  for (const id of excluded) { const r = ruleById.get(id); if (r) (outBySuite[r.suite] = outBySuite[r.suite] || []).push(id); }
  const fullyOut = SCOPE_CATALOG.suites.filter((s) => {
    const all = SCOPE_CATALOG.rules.filter((r) => r.suite === s.key).length;
    return all > 0 && (outBySuite[s.key] || []).length === all;
  });
  return { excluded, total: SCOPE_CATALOG.rules.length, openHidden, blockersHidden, fullyOut, outBySuite, verdict: data.verdict };
}
function buildScopePanel(f) {
  if (!f.excluded.length) return '';
  const pct = Math.round(f.excluded.length / f.total * 100);
  const openLine = f.openHidden.length
    ? `<b style="color:var(--fail)">${f.openHidden.length} of the excluded checks ${f.openHidden.length === 1 ? 'is an open defect' : 'are open defects'} on this site</b>${f.blockersHidden.length ? `, <b style="color:var(--fail)">including ${f.blockersHidden.length} launch blocker${f.blockersHidden.length > 1 ? 's' : ''}</b>` : ''} — real ${f.openHidden.length === 1 ? 'problem' : 'problems'} this score does not see`
    : 'none of the excluded checks are currently failing on this site';
  const suiteLine = f.fullyOut.length
    ? `<div class="sc-row"><span class="sc-k">Sections switched off entirely</span><span class="sc-v">${f.fullyOut.map((s) => hEsc(s.name) + ' <i>(weight ' + s.weight + ')</i>').join(' · ')}</span></div>` : '';
  const ids = f.openHidden.slice(0, 12).map((id) => { const r = ruleById.get(id); return hEsc(id) + (r ? ' ' + hEsc(r.title) : ''); });
  return `<style>
  .qa-scope{border:1px solid var(--fail);border-left:5px solid var(--fail);background:var(--fail-bg);border-radius:var(--radius);padding:16px 18px;margin:0 0 18px;display:flex;gap:14px;align-items:flex-start}
  .qa-scope .sc-i{font-size:20px;line-height:1;color:var(--fail);flex:none;margin-top:1px}
  .qa-scope b.sc-h{display:block;font-size:14.5px;color:var(--ink);letter-spacing:-.01em;margin-bottom:5px}
  .qa-scope p{margin:0 0 9px;font-size:12.5px;color:var(--ink-soft);line-height:1.65}
  .qa-scope .sc-row{display:flex;gap:10px;font-size:11.5px;line-height:1.6;padding:4px 0;border-top:1px solid var(--fail-line)}
  .qa-scope .sc-k{flex:0 0 190px;color:var(--ink-faint);font-weight:650;text-transform:uppercase;letter-spacing:.05em;font-size:10px;padding-top:2px}
  .qa-scope .sc-v{color:var(--ink-soft);min-width:0}
  .qa-scope .sc-v i{color:var(--ink-faint);font-style:normal}
  .qa-scope code{font-family:var(--mono);font-size:10.5px;color:var(--ink-soft)}
  @media(max-width:700px){.qa-scope .sc-row{flex-direction:column;gap:2px}.qa-scope .sc-k{flex:none}}
  </style>
  <section class="qa-scope">
    <div class="sc-i">&#9888;</div>
    <div style="min-width:0">
      <b class="sc-h">PARTIAL AUDIT — the quality score below does not describe the whole site.</b>
      <p><b style="color:var(--ink)">${f.excluded.length}</b> of ${f.total} scorable checks (<b style="color:var(--ink)">${pct}%</b>) were excluded from scoring by the operator, so the Quality score is the share of resolved risk across the <i>selected checks alone</i>. ${openLine}.</p>
      <div class="sc-row"><span class="sc-k">Scoped to the selection</span><span class="sc-v">The <b style="color:var(--ink)">Quality dashboard</b> (overall + per-suite 0–100). Excluding a check removes its risk from the numerator <b style="color:var(--ink)">and</b> the denominator, so an excluded section drops out of the weighted mean rather than scoring 100.</span></div>
      <div class="sc-row"><span class="sc-k">NOT scoped — whole site</span><span class="sc-v">The <b style="color:var(--ink)">${hEsc(String((f.verdict || 'PASS/FAIL verdict')))}</b> verdict, the checks-passing ring, the tallies and the launch-readiness gate all still count <b style="color:var(--ink)">every</b> check that ran. De-scoping cannot buy a pass — only a higher quality number.</span></div>
      ${suiteLine}
      ${ids.length ? `<div class="sc-row"><span class="sc-k">Open defects hidden from the score</span><span class="sc-v"><code>${ids.join('</code> · <code>')}</code>${f.openHidden.length > 12 ? ' <i>+' + (f.openHidden.length - 12) + ' more</i>' : ''}</span></div>` : ''}
      <div class="sc-row"><span class="sc-k">If you are sending this on</span><span class="sc-v">This notice must travel with the report. A reduced-scope score is not a site pass, and the PDF export carries this panel.</span></div>
    </div>
  </section>`;
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
  /* Paint the ROOT, not just body, and floor the height to the window.
     Measured 2026-07-16 (Site Audit tab, 1440x900): body/html were both sized to CONTENT (624px) in a
     900px window with min-height:0 and html's background TRANSPARENT — so the bottom 276px was dark
     only because CSS propagates body's background to the canvas when html has none. That propagation
     is a fallback, not a decision: any moment it does not apply (first paint before body renders,
     print/PDF, the Electron window's own default surface) the same 276px comes back WHITE. That is
     the "black or white gap" — one cause, two colours, depending on who paints the canvas.
     Setting the background on html makes the root itself the painter (no propagation involved), and
     min-height:100vh makes the ground reach the bottom of the window on short tabs. */
  html{background:#000;min-height:100vh}
  html,body{max-width:100%;overflow-x:clip}
  body{min-height:100vh}
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
  #v-vps,#a-vps{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px}
  #v-vps .chip,#a-vps .chip{white-space:nowrap}
  #v-vps .vpdiv,#a-vps .vpdiv{grid-column:1/-1;font-size:11px;color:var(--ink-soft);border-top:1px solid var(--line);padding-top:7px;margin-top:1px}
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
  .vseg{display:inline-flex;border:1px solid var(--line-strong);border-radius:8px;overflow:hidden;vertical-align:middle;margin-right:4px}
  .vbt{background:var(--surface-2);border:0;border-right:1px solid var(--line-strong);color:var(--ink-soft);padding:6px 13px;font-size:12.5px;font-weight:600;cursor:pointer;font-family:inherit}
  .vbt:last-child{border-right:0}
  .vbt.on{background:var(--brand-solid);color:#fff}
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
  /* Site Audit: the per-run inputs share the row. The Scan Configuration block that used to sit
     beside them is settings-owned and hidden now (see .settings-owned), so they grow to fill. */
  .cfg-au>.fld{flex:1 1 35%;min-width:200px}
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
  /* ---- controls the per-tool settings popup owns ---------------------------------------------
     HIDDEN, NOT DELETED — deliberately. Read this before you "clean up" the markup below it.
     Each control tagged .settings-owned is STILL the one source of truth the runner reads at run
     time — runAudit() reads $('a-max') / $('a-render') / #a-vps, runVisual() reads $('v-mode') /
     $('v-scope') / $('v-max') / $('v-warm') / #v-vps, runCert() reads $('c-sitemap') / $('c-visual')
     / $('c-prod') / $('c-max') — and the settings popup is a second VIEW bound to these same nodes
     (FIELDS[].bind + fGet/fSet, and FACTORY, which snapshots the authored DOM at parse time).
     display:none changes none of that: .value, .checked and querySelectorAll all still work on a
     hidden node. Delete these inputs and you break BOTH the scan AND the popup that edits them.
     The dashboard therefore shows only the per-run inputs (the URLs, the save-as name) + the gear
     + the run button; everything that is a SETTING is edited in the popup. */
  /* !important is deliberate. This class means "this control now lives in the settings popup; never
     render it on the dashboard" — an absolute rule, not a suggestion. Without it the class silently
     loses: label.fld{display:flex} above is specificity 0-1-1 and beats a bare .settings-owned (0-1-0)
     no matter what order they appear in, so the Save-as-reference label kept rendering at full width
     while every class-matched group hid correctly. Anything tagged settings-owned must stay in the DOM
     (the runner reads these nodes and the popup binds to them) but must never paint. */
  .settings-owned{display:none!important}
  /* the run button keeps its right edge once the info block beside it is settings-owned */
  .vc-foot{justify-content:flex-end}
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
  /* ---- per-tool settings: gear + popup -------------------------------------------------------
     The gear lives in each tool's PANEL HEADER, not in the tab bar: .tabbar items are <button>s and
     a <button> inside a <button> is invalid HTML — browsers unnest it, so the gear would escape the
     tab and the click target would be ambiguous. The panel header is unambiguous and stays reachable
     once a tool is open, which is exactly when its settings matter. */
  .tthead{display:flex;align-items:center;gap:12px;margin:0 0 4px}
  .tthead h2.tt{margin:0;flex:1;min-width:0}
  .gear{display:inline-flex;align-items:center;gap:7px;background:var(--surface-2);border:1px solid var(--line-strong);color:var(--ink-soft);border-radius:9px;padding:7px 13px;font-size:12.5px;font-weight:600;cursor:pointer;font-family:inherit;flex:none;white-space:nowrap}
  .gear:hover{color:var(--ink);border-color:var(--brand)}
  .gear:focus-visible{outline:2px solid var(--brand);outline-offset:2px}
  .gear .gi{font-size:13px;line-height:1}
  .gear .gdot{width:6px;height:6px;border-radius:50%;background:var(--brand-solid);display:none}
  .gear.custom .gdot{display:block}
  .gear.custom{border-color:var(--brand);color:var(--ink)}
  .setmodal{position:fixed;inset:0;z-index:130;display:none;align-items:flex-start;justify-content:center;background:rgba(0,0,0,.62);padding:5vh 16px;overflow:auto}
  .setmodal.on{display:flex}
  .setcard{background:var(--surface);border:1px solid var(--line-strong);border-radius:14px;box-shadow:var(--shadow);width:720px;max-width:100%;display:flex;flex-direction:column;max-height:90vh}
  .sethead{display:flex;align-items:center;gap:12px;padding:15px 20px;border-bottom:1px solid var(--line);flex:none}
  .sethead .sic{width:30px;height:30px;border-radius:9px;background:var(--brand-solid);color:#fff;display:grid;place-items:center;font-size:14px;flex:none}
  .sethead .stt{display:flex;flex-direction:column;line-height:1.25;min-width:0;flex:1}
  .sethead .stt b{font-size:15px;letter-spacing:-.01em}
  .sethead .stt span{font-size:10px;font-family:var(--mono);color:var(--ink-faint);letter-spacing:.06em}
  .setbody{padding:6px 20px 18px;overflow:auto;flex:1 1 auto}
  .setfoot{display:flex;align-items:center;gap:9px;padding:13px 20px;border-top:1px solid var(--line);flex:none;flex-wrap:wrap}
  .setfoot .sp{flex:1 1 auto}
  .set-saved{font-size:11.5px;color:var(--brand-ink);font-weight:600;white-space:nowrap}
  .bt{background:var(--surface-2);border:1px solid var(--line-strong);color:var(--ink);border-radius:8px;padding:8px 15px;font-size:12.5px;font-weight:600;cursor:pointer;font-family:inherit;white-space:nowrap}
  .bt:hover{border-color:var(--brand)}
  .bt.pri{background:var(--brand-solid);border-color:var(--brand-solid);color:#fff}
  .bt.warn{color:var(--ink-soft)}
  .bt.warn:hover{color:var(--ink)}
  .opt{display:flex;align-items:center;gap:16px;padding:13px 0;border-top:1px solid var(--line)}
  .opt:first-child{border-top:0}
  .opt .otx{flex:1;min-width:0}
  .opt .otx b{display:block;font-size:13px;color:var(--ink);font-weight:640;margin-bottom:3px}
  .opt .otx span{display:block;font-size:11.5px;color:var(--ink-faint);line-height:1.6}
  .opt .octl{flex:none}
  .opt .octl input[type=number]{width:82px}
  .opt .octl select{width:auto;min-width:190px}
  .opt.col{display:block}
  .opt.col .otx{margin-bottom:10px}
  .sw{position:relative;display:inline-block;width:40px;height:22px;flex:none}
  .sw input{position:absolute;opacity:0;width:100%;height:100%;margin:0;cursor:pointer;z-index:2}
  .sw i{position:absolute;inset:0;background:var(--surface-2);border:1px solid var(--line-strong);border-radius:99px;transition:background .15s,border-color .15s}
  .sw i:after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--ink-faint);transition:transform .15s,background .15s}
  .sw input:checked+i{background:var(--brand-solid);border-color:var(--brand-solid)}
  .sw input:checked+i:after{transform:translateX(18px);background:#fff}
  .sw input:focus-visible+i{outline:2px solid var(--brand);outline-offset:2px}
  /* scope tree — suite rows that expand to their individual checks */
  .sc-tools{display:flex;align-items:center;gap:7px;margin-bottom:9px;flex-wrap:wrap}
  .sc-tools .bt{padding:5px 11px;font-size:11.5px}
  .sc-count{font-family:var(--mono);font-size:11px;color:var(--ink-faint);margin-left:auto}
  .sc-count b{color:var(--brand-ink)}
  .sc-count.part b{color:var(--ink)}
  .sctree{border:1px solid var(--line);border-radius:10px;overflow:hidden}
  .scs{border-top:1px solid var(--line)}
  .scs:first-child{border-top:0}
  .scs-h{display:flex;align-items:center;gap:10px;padding:9px 11px;background:var(--surface-2);cursor:pointer;user-select:none}
  .scs-h:hover{background:var(--surface)}
  .scs-h .nm{flex:1;min-width:0;font-size:12.5px;font-weight:640;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .scs-h .mt{font-family:var(--mono);font-size:10.5px;color:var(--ink-faint);white-space:nowrap}
  .scs-h .cv{font-size:10px;transition:transform .15s;color:var(--ink-faint);width:10px;text-align:center}
  .scs.open .scs-h .cv{transform:rotate(90deg)}
  .scs-b{display:none;padding:4px 11px 9px 40px;background:var(--ground)}
  .scs.open .scs-b{display:block}
  .scr{display:flex;align-items:center;gap:9px;padding:5px 0;font-size:12px}
  .scr .rid{font-family:var(--mono);font-size:10.5px;color:var(--ink-faint);flex:none;width:74px}
  .scr .rt{flex:1;min-width:0;color:var(--ink-soft);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .scr .rd{font-family:var(--mono);font-size:10.5px;color:var(--ink-faint);flex:none}
  .scr.off .rt,.scr.off .rid{opacity:.4;text-decoration:line-through}
  .scr input,.scs-h input[type=checkbox]{accent-color:var(--brand-solid);flex:none;width:14px;height:14px;cursor:pointer;margin:0}
  .sc-note{font-size:11px;color:var(--ink-faint);line-height:1.6;margin-top:9px}
  .sc-note b{color:var(--ink-soft);font-weight:640}
  .sc-warn{margin-top:9px;border:1px solid var(--line-strong);border-left:3px solid var(--brand-solid);background:var(--surface-2);border-radius:8px;padding:9px 11px;font-size:11.5px;color:var(--ink-soft);line-height:1.6}
  .sc-warn b{color:var(--ink)}
  @media(max-width:620px){.opt{display:block}.opt .octl{margin-top:9px}.opt .octl select,.opt .octl input[type=number]{width:100%}.scs-b{padding-left:16px}.scr .rid{width:66px}}
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
      <div class="tthead"><h2 class="tt">Site Audit</h2><button class="gear" id="gear-audit" onclick="openSettings('audit')" title="Site Audit settings" aria-label="Site Audit settings"><span class="gi">&#9881;</span>Settings<span class="gdot"></span></button></div><p class="sub">Full single-site tester — links, forms, responsive, accessibility (axe-core), SEO, performance, security (TLS), cross-browser (Firefox + WebKit), console. Independent: needs no inventory, comparison, or certification.</p>
      <div class="card">
        <div class="cfg-split cfg-au">
          <label class="fld" style="min-width:0">Site URL<input id="a-url" type="text" placeholder="e.g. sgen.com" spellcheck="false"></label>
          <!-- "Save report as" now lives in the Site Audit settings popup as a perRun field, so the
               dashboard is URL + gear + Audit like every other tool. It is HIDDEN, not deleted: runAudit()
               reads #a-save straight from this node and the popup binds to it.
               It is per-RUN, never a default, and runAudit() CLEARS it once a scan consumes it. That is
               load-bearing, not tidiness: saveBaseline() (compare.js) is an unconditional writeFileSync
               over baselines/<name>.json — no existence check, no versioning. A remembered name silently
               re-points the reference at whatever you scanned next: save "live", scan staging, and the
               "live" baseline IS staging, so Visual Comparison diffs staging against itself and reports a
               false all-clear. The old sticky localStorage entry did exactly that; it was survivable only
               because the field was visible. Hidden + sticky would have made it silent, so the stickiness
               had to go with the visibility. -->
          <label class="fld settings-owned" style="min-width:0"><span>Save report as <span class="help" tabindex="0">?<span class="tip"><b>Save report as</b>Stores this scan as a reference for future comparisons.<em>Example: save the live site, then compare staging to it.</em></span></span></span><input id="a-save" type="text" placeholder="reference name" spellcheck="false"></label>
          <div class="cs-cfg settings-owned">
            <div class="glab">Scan Configuration</div>
            <div class="cfg-grid">
              <label class="cfg-c">Max pages <input id="a-max" type="number" value="1" min="1" max="500"><span class="help" tabindex="0">?<span class="tip"><b>Max pages</b>How many pages to crawl and test. 1 = homepage only; higher follows the sitemap + internal links up to this cap.<em>Example: 1 for a quick single-page check.</em></span></span></label>
              <label class="cfg-c"><input id="a-render" type="checkbox" checked> Browser render <span class="help" tabindex="0">?<span class="tip"><b>Browser render</b>Loads each page in a real headless browser for axe-core accessibility, Core Web Vitals, full-page screenshots, and Firefox + WebKit. Off = faster static-only scan.</span></span></label>
            </div>
          </div>
        </div>
        <div class="grp settings-owned" style="margin-top:2px"><div class="glab">Viewports <span class="help" tabindex="0">?<span class="tip"><b>Viewports</b>What the browser-render responsive sweep tests. The 10 <b style="display:inline">devices</b> are really emulated — touch, pixel density, and the mobile UA on Android. The 3 <b style="display:inline">boundary probes</b> are width only: they test the layout on a framework breakpoint, not a device. Fewer = faster; all selected = the full matrix. AA colour-contrast still runs once even if 1920 is deselected.<em>Leave all selected to keep the standard 13-viewport sweep.</em></span></span></div><div class="chips" id="a-vps">
          <label class="chip"><input type="checkbox" value="1920" checked>1920 · Desktop</label><label class="chip"><input type="checkbox" value="1440" checked>1440 · MacBook&nbsp;Air</label><label class="chip"><input type="checkbox" value="1180" checked>1180 · iPad&nbsp;Air&nbsp;LS</label><label class="chip"><input type="checkbox" value="820" checked>820 · iPad&nbsp;Air&nbsp;11</label><label class="chip"><input type="checkbox" value="744" checked>744 · iPad&nbsp;mini</label><label class="chip"><input type="checkbox" value="414" checked>414 · iPhone&nbsp;XR/11</label><label class="chip"><input type="checkbox" value="440" checked>440 · iPhone&nbsp;17&nbsp;Max</label><label class="chip"><input type="checkbox" value="393" checked>393 · iPhone&nbsp;16</label><label class="chip"><input type="checkbox" value="360" checked>360 · Galaxy&nbsp;S</label><label class="chip"><input type="checkbox" value="384" checked>384 · Galaxy&nbsp;S&nbsp;Ultra</label><div class="vpdiv">Breakpoint probes — width only, not devices</div><label class="chip"><input type="checkbox" value="1280" checked>1280 · xl&nbsp;boundary</label><label class="chip"><input type="checkbox" value="1024" checked>1024 · lg&nbsp;boundary</label><label class="chip"><input type="checkbox" value="768" checked>768 · md&nbsp;boundary</label></div></div>
        <div class="cfg-action"><button class="run" id="a-btn" onclick="runAudit()">Run audit</button><button class="run ghost" id="a-cancel" onclick="cancelScan('a')" style="display:none">Cancel</button><button class="run retry" id="a-retry" onclick="retryScan('a')" style="display:none">Retry</button></div>
      </div>
      <div class="pbar" id="a-pbar"><div class="pfill" id="a-pfill"></div></div><div class="status" id="a-status"></div><div class="cmplink" id="a-link"></div><div id="a-frame"></div>
      <div class="placeholder" id="a-ph"><b>Results appear here</b>Run an audit to see the quality score, findings, screenshots, and the full report preview.</div>
    </section>

    <!-- 2 VISUAL COMPARISON -->
    <section class="panel" id="p-visual">
      <div class="tthead"><h2 class="tt">Visual Comparison</h2><button class="gear" id="gear-visual" onclick="openSettings('visual')" title="Visual Comparison settings" aria-label="Visual Comparison settings"><span class="gi">&#9881;</span>Settings<span class="gdot"></span></button></div><p class="sub">Compare a reference site and a target site visually across industry device breakpoints — no prior audit, no certification, no stored inventory. Diffs page render + full DOM structure.</p>
      <div class="toolgrid">
        <div class="col-left"><div class="card">
          <div class="cfg-split">
            <div class="cs-col">
              <label class="fld" style="min-width:0">Reference URL<input id="v-ref" type="text" placeholder="old / source site" spellcheck="false"></label>
              <label class="fld" style="min-width:0;margin-top:12px">Target URL<input id="v-tgt" type="text" placeholder="new / SGEN site" spellcheck="false"></label>
            </div>
            <!-- mode / scope / max / warm-up / viewports all live in the gear now: every one of them
                 binds to FIELDS.visual. Hidden, not deleted — runVisual() still reads these nodes. -->
            <div class="cs-col settings-owned">
              <div class="grp"><div class="glab">Comparison mode <span class="help" tabindex="0">?<span class="tip"><b>Comparison mode</b>The pixel diff only means something when the two sites are meant to look the SAME. <b style="display:inline">Like-for-like</b> = same design on a new platform: pixel diff on and scored. <b style="display:inline">Redesign</b> = the new site is meant to look different: pixel diff off, and the match score is structural only — what the old site had vs what the new build still has.<em>Wrong mode on a redesign = a page of differences that are all intentional.</em></span></span></div>
                <div class="row" style="gap:12px;align-items:center;flex-wrap:nowrap">
                  <select id="v-mode" style="flex:1;min-width:0;max-width:340px"><option value="like-for-like">Like-for-like replatform (pixel diff on)</option><option value="redesign">Redesign (pixel diff off — structure only)</option></select></div></div>
              <div class="grp"><div class="glab">Scope <span class="help" tabindex="0">?<span class="tip"><b>Scope</b>How many pages to compare. <b style="display:inline">Full site</b> discovers additional linked pages — useful for audits, but may surface non-canonical URLs (pagination, query variants).<em>Example: Single page for a fast homepage check.</em></span></span></div>
                <div class="row" style="gap:12px;align-items:center;flex-wrap:nowrap">
                  <select id="v-scope" style="flex:1;min-width:0;max-width:340px"><option value="single">Single page (homepage)</option><option value="multiple">Multiple pages (up to max)</option><option value="sitemap">Sitemap-driven</option><option value="full">Full site</option></select>
                  <label style="font-size:12px;color:var(--ink-soft);display:flex;align-items:center;gap:6px;flex:none">max pages <input id="v-max" type="number" value="1" min="1" max="200"></label>
                  <label style="font-size:12px;color:var(--ink-soft);display:flex;align-items:center;gap:6px;flex:none" title="Load each page this many times before screenshotting so lazy-loaded / CDN-cold assets are in — fewer false diffs. 1 = no warm-up.">warm-up loads <input id="v-warm" type="number" value="3" min="1" max="5"></label></div></div>
              <div class="grp"><div class="glab">Viewports <span class="help" tabindex="0">?<span class="tip"><b>Viewports</b>Real device sizes, verified against each vendor's published spec — emulated with touch and pixel density, not just narrowed. The 360–440 phone band is where most real-world breakage lives; the boundary probes catch layouts that break exactly on a framework breakpoint.<em>Desktop · MacBook · iPad Air/mini · iPhone · Galaxy S — plus xl/lg/md boundaries</em></span></span></div><div class="chips" id="v-vps">
                <label class="chip"><input type="checkbox" value="1920" checked>1920 · Desktop</label><label class="chip"><input type="checkbox" value="1440" checked>1440 · MacBook&nbsp;Air</label><label class="chip"><input type="checkbox" value="1180" checked>1180 · iPad&nbsp;Air&nbsp;LS</label><label class="chip"><input type="checkbox" value="820" checked>820 · iPad&nbsp;Air&nbsp;11</label><label class="chip"><input type="checkbox" value="744" checked>744 · iPad&nbsp;mini</label><label class="chip"><input type="checkbox" value="414" checked>414 · iPhone&nbsp;XR/11</label><label class="chip"><input type="checkbox" value="440" checked>440 · iPhone&nbsp;17&nbsp;Max</label><label class="chip"><input type="checkbox" value="393" checked>393 · iPhone&nbsp;16</label><label class="chip"><input type="checkbox" value="360" checked>360 · Galaxy&nbsp;S</label><label class="chip"><input type="checkbox" value="384" checked>384 · Galaxy&nbsp;S&nbsp;Ultra</label><div class="vpdiv">Breakpoint probes — width only, not devices</div><label class="chip"><input type="checkbox" value="1280" checked>1280 · xl&nbsp;boundary</label><label class="chip"><input type="checkbox" value="1024" checked>1024 · lg&nbsp;boundary</label><label class="chip"><input type="checkbox" value="768" checked>768 · md&nbsp;boundary</label></div></div>
            </div>
          </div>
          <div class="vc-foot">
            <div class="grp settings-owned"><div class="glab">What's compared <span class="help" tabindex="0">?<span class="tip"><b>What's compared</b>The structural diff and the typography read always run. The pixel axis depends on the comparison mode — it is only meaningful when the two sites are supposed to look the same.<em>Like-for-like: pixel + structure. Redesign: structure only.</em></span></span></div>
              <div style="font-size:12.5px;color:var(--ink-soft);line-height:1.7;background:var(--surface-2);border:1px solid var(--line);border-radius:9px;padding:10px 13px">
                Each paired page is compared at every selected viewport on the
                <b style="display:inline;color:var(--ink)">structural diff</b> — elements <b style="display:inline;color:var(--ink)">missing</b>, <b style="display:inline;color:var(--ink)">extra</b>, <b style="display:inline;color:var(--ink)">moved</b>, or <b style="display:inline;color:var(--ink)">restyled</b> vs the reference — plus a page-level
                <b style="display:inline;color:var(--ink)">typography read</b> (a font the old site renders that the new build never uses). Both always run.
                <b style="display:inline;color:var(--ink)">Pixel match</b> (visual difference %) runs on <b style="display:inline;color:var(--ink)">like-for-like</b> only: on a redesign the sites are meant to differ, so it is switched off rather than reported as noise. Screenshots of both sides are captured in either mode.</div></div>
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
      <div class="tthead"><h2 class="tt">Post-Deployment Check</h2><button class="gear" id="gear-cert" onclick="openSettings('cert')" title="Post-Deployment Check settings" aria-label="Post-Deployment Check settings"><span class="gi">&#9881;</span>Settings<span class="gdot"></span></button></div><p class="sub">Answers one question: <b>did everything make it across?</b> Inventories every page, section, image, menu and form on the source site, then verifies each one exists intact on the new build — with evidence per item and a PASS / PASS&nbsp;WITH&nbsp;MINOR&nbsp;ISSUES / FAIL verdict. Run it after deploying the rebuild, before go-live.</p>
      <div class="toolgrid">
        <div class="col-left"><div class="card">
          <div class="cfg-split">
            <div class="cs-col">
              <label class="fld" style="min-width:0">Source URL<input id="c-src" type="text" placeholder="original site" spellcheck="false"></label>
              <label class="fld" style="min-width:0;margin-top:12px">Target URL<input id="c-tgt" type="text" placeholder="migrated SGEN site" spellcheck="false"></label>
            </div>
            <!-- sitemap-only / visual stage / production validation / max pages all live in the gear
                 now: every one binds to FIELDS.cert. Hidden, not deleted — runCert() still reads these. -->
            <div class="cs-col settings-owned">
              <div class="grp"><div class="glab">Migration options</div><div class="opts" style="margin-top:0;flex-direction:column;align-items:flex-start;gap:11px">
                <label><input id="c-sitemap" type="checkbox"> sitemap-only completeness <span class="help" tabindex="0">?<span class="tip"><b>Sitemap-only</b>Uses the sitemap as the authoritative page list. Recommended for migration completeness checks. Without it, a capped crawl reports completeness as <b style="display:inline">manual</b>, never authoritative.<em>Example: certify docs.sgen.com → staging against the sitemap.</em></span></span></label>
                <label><input id="c-visual" type="checkbox"> visual comparison stage</label>
                <label><input id="c-prod" type="checkbox" checked> production validation (audit target)</label>
                <label>max pages <input id="c-max" type="number" value="1" min="1" max="700"></label>
              </div></div>
            </div>
          </div>
          <div class="vc-foot">
            <div class="grp settings-owned"><div class="glab">Evidence <span class="help" tabindex="0">?<span class="tip"><b>Evidence</b>Every finding must have proof (screenshot / DOM / network). Findings without available proof are marked <b style="display:inline">Manual Verification Required</b> — never silently passed.</span></span></div>
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
      <div class="tthead"><h2 class="tt">Reports</h2><button class="gear" id="gear-reports" onclick="openSettings('reports')" title="Reports settings" aria-label="Reports settings"><span class="gi">&#9881;</span>Settings<span class="gdot"></span></button></div><p class="sub">Review previous runs. Select one to preview its report; open the HTML or save it as a PDF to share.</p>
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

  <!-- per-tool settings popup (opened from each tool's gear; one modal, re-rendered per tool) -->
  <div id="setmodal" class="setmodal" onclick="if(event.target===this)closeSettings()" role="dialog" aria-modal="true" aria-labelledby="set-title">
    <div class="setcard">
      <div class="sethead">
        <div class="sic" id="set-ic">&#9881;</div>
        <div class="stt"><b id="set-title">Settings</b><span id="set-sub">CUSTOM TEST SETTINGS</span></div>
        <button class="logx" onclick="closeSettings()" aria-label="Close">&#10005;</button>
      </div>
      <div class="setbody" id="set-body"></div>
      <div class="setfoot">
        <button class="bt warn" id="set-reset" onclick="resetDefaults()">Reset defaults</button>
        <span class="set-saved" id="set-saved"></span>
        <span class="sp"></span>
        <button class="bt" onclick="closeSettings()">Cancel</button>
        <button class="bt" id="set-save" onclick="saveAsDefault()">Save as default</button>
        <button class="bt pri" id="set-apply" onclick="applySettings()">Apply</button>
      </div>
    </div>
  </div>

  <script>
    // chip value (width) -> canonical matrix label. These strings MUST match the labels in
    // lib/migration-qa/checks-render.js and lib/site-qa/visual-match.js exactly: both backends filter
    // their matrix BY LABEL, so a typo here silently drops that viewport from the sweep rather than
    // erroring. Width is a valid key because every width is unique across devices + breakpoint probes.
    var VPMAP={1920:'1920 · Desktop',1440:'1440 · MacBook Air',1180:'1180 · iPad Air 11 (LS)',820:'820 · iPad Air 11',744:'744 · iPad mini',414:'414 · iPhone XR/11',440:'440 · iPhone 17 Pro Max',393:'393 · iPhone 16',360:'360 · Galaxy S',384:'384 · Galaxy S Ultra',1280:'1280 · xl boundary',1024:'1024 · lg boundary',768:'768 · md boundary'};
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
    // Every tool's result carries its own actions. Save-as-PDF on all of them; the annotate lane on
    // visual runs. These previously existed ONLY in the Reports tab, so after running a comparison in
    // tool 2 you had to leave, find your own run in a list, and click through — the tool that PRODUCES
    // the artifact never offered to mark it up. Keyed off the route, not the tool prefix, so it stays
    // correct wherever showReport is called from.
    // ---- results views -------------------------------------------------------------------------
    // Annotate is a PRIMARY view of the results, level with the report itself: it swaps THIS frame in
    // place. It used to be a target="_blank" link, which meant the one action whose entire point is
    // marking up what you are looking at was the only one that threw you out of the page to do it.
    // autosize() re-fits on the iframe's load event, so a src swap re-fits on its own — no extra wiring.
    var VIEW={};
    function viewRoute(pre){var st=VIEW[pre];return st&&st.mode==='annotate'?st.annotate:st&&st.report;}
    function setView(pre,mode){
      var st=VIEW[pre];if(!st||st.mode===mode)return;
      if(mode==='annotate'&&!st.annotate)return;
      st.mode=mode;
      var f=$(pre+'-frame').querySelector('iframe');
      if(f)f.src=viewRoute(pre);
      paintView(pre);
    }
    function paintView(pre){
      var st=VIEW[pre];if(!st)return;
      var seg=st.annotate?'<span class="vseg">'
        +'<button class="vbt'+(st.mode==='report'?' on':'')+'" onclick="setView(\\''+pre+'\\',\\'report\\')">'+sEsc(st.label)+'</button>'
        +'<button class="vbt'+(st.mode==='annotate'?' on':'')+'" onclick="setView(\\''+pre+'\\',\\'annotate\\')">'+'✎ Annotate'+'</button>'
        +'</span>':'';
      // "Save as PDF" is the REPORT view's export and is shown only there, for two hard reasons:
      // /api/pdf's route regex accepts /report|/visual|/certify and would 400 on /annotate/<id>, and the
      // annotate page ships its own Export PDF (#pdfbtn -> /api/annotate-pdf) which is the one that
      // carries the marks. A generic "Save as PDF" while marking up would hand back the UNMARKED report.
      var pdf=(st.mode==='report')?' &nbsp; <a href="/api/pdf?route='+encodeURIComponent(st.report)+'">⬇ Save as PDF</a>':'';
      $(pre+'-link').innerHTML=seg+pdf+' &nbsp; <a href="'+viewRoute(pre)+'" target="_blank">↗ Open in a new tab</a>';
    }
    function showReport(pre,route,label){
      var ph=$(pre+'-ph'); if(ph)ph.style.display='none';
      var isVis=route.indexOf('/visual/')===0;
      VIEW[pre]={report:route,annotate:isVis?'/annotate/'+route.slice(8):'',mode:'report',label:label||'Report'};
      paintView(pre);
      var f=document.createElement('iframe');f.scrolling='no';autosize(f);f.src=route;
      $(pre+'-frame').appendChild(f);
    }
    function mark(pre,stage){var p=$(pre+'-pipe');if(!p)return;var els=p.querySelectorAll('span');var hit=false;els.forEach(function(s){if(s.dataset.s===stage){s.className='on';hit=true;}else if(!hit){s.className='done';}});}

    // 1 Site Audit
    function runAudit(){var url=$('a-url').value.trim();if(!url){$('a-status').textContent='Enter a site URL.';return;}
      var vps=checked('a-vps').map(function(w){return VPMAP[w]});
      // CONSUME the save-as name: read it once, then clear the field. saveBaseline() (compare.js) is an
      // unconditional writeFileSync over baselines/<name>.json, so a name left sitting in #a-save would
      // silently re-point that reference at the NEXT thing you scan — save "live", then scan staging, and
      // your "live" baseline becomes staging. Visual Comparison would then diff staging against itself
      // and report a false all-clear. Saving a baseline is a deliberate one-shot act, so the field has to
      // empty when a run takes it. Cleared before the request, not in the callback: a second Audit click
      // while the first is still streaming would otherwise re-send the same name.
      var saveAs=$('a-save').value.trim();
      $('a-save').value='';
      if(saveAs)$('a-status').textContent='Saving this scan as reference “'+saveAs+'”…';
      stream('/api/run',{url:url,maxPages:+$('a-max').value||1,render:$('a-render').checked,viewports:vps,save:saveAs,excludeRules:SCOPE_EXCLUDED},'a',function(m){
        if(!m.ok){$('a-status').textContent='Scan failed: '+(m.error||'unknown');return;}
        var q=(m.quality!=null?' · quality '+m.quality:'');
        // A de-scoped run must never read as a whole one, here either — not just in the report.
        var sc=(m.scopedOut?' · <b style="color:var(--brand)">PARTIAL: quality scored on '+((m.scorableTotal||0)-m.scopedOut)+'/'+m.scorableTotal+' checks</b>':'');
        $('a-status').innerHTML='Done — '+m.verdict+' · score '+m.score+'%'+q+' · pass '+m.tally.pass+' / warn '+m.tally.warn+' / fail '+m.tally.fail+' / manual '+m.tally.manual+' · saved to history'+sc;
        var cmp='';if(m.comparison)cmp=' · <a href="/compare/'+m.id+'" target="_blank">open comparison ↗</a>';$('a-link').innerHTML='<a href="/report/'+m.id+'" target="_blank">↗ Open full report</a>'+cmp;
        showReport('a','/report/'+m.id,'report');});}

    // 2 Visual Comparison
    function runVisual(){var ref=$('v-ref').value.trim(),tgt=$('v-tgt').value.trim();if(!ref||!tgt){$('v-status').textContent='Enter both Reference and Target URLs.';return;}
      var vps=checked('v-vps').map(function(w){return VPMAP[w]});
      stream('/api/visual',{ref:ref,target:tgt,mode:$('v-mode').value,scope:$('v-scope').value,maxPages:+$('v-max').value||1,viewports:vps,axes:checked('v-ax'),warmLoads:+$('v-warm').value||3},'v',function(m){
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
    function loadReports(){fetch('/api/reports?limit='+encodeURIComponent(UNBOUND.reports.limit)).then(function(r){return r.json()}).then(function(d){R_DATA=d;renderReports();}).catch(function(e){$('r-list').innerHTML='<div class="hint">reports error: '+e+'</div>';});}
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
      // Visual runs get the annotate lane: mark up live-vs-staging, then export those marks as a PDF.
        // Same lane as the tools: Annotate is a VIEW of this preview, not another tab. Reuses
        // showReport() so the Reports tab and the tool results cannot drift apart. r-ph is a SIBLING of
        // r-preview, so replacing this innerHTML does not destroy the placeholder showReport hides.
        $('r-preview').innerHTML='<div class="cmplink" id="r-link"></div><div id="r-frame"></div>';
        showReport('r',route,'Report');
    }

    // Guided tour — spotlight coach-marks that switch tabs + highlight the real controls (shown once
    // per browser; reopen via ? Help). Each step: {tab, target selector, title, body}.
    var WK_KEY='sgenqa_onboarded_v2';
    var TOUR=[
      {tab:'audit',target:null,lbl:'Welcome',title:'SGEN Site QA',body:"Four offline tools to check any website's quality — audit, compare, verify a migration, and review reports. Nothing leaves this machine. Let me show you around."},
      {tab:'audit',target:'.tabbar',lbl:'Navigation',title:'Four tools, one app',body:'Switch tools here — the header and these tabs stay locked in place as you scroll. Site Audit checks one site · Visual Comparison diffs old vs new · Post-Deployment Check verifies a migration · Reports holds past runs.'},
      {tab:'audit',target:'#a-url',lbl:'Tool 1 · Site Audit',title:'Enter any site URL',body:'Point it at a live site and run it — that is the whole dashboard. How it scans (max pages, browser render, viewports, which checks score) lives behind Settings, and the URLs you type are saved automatically, so you never re-enter them next launch.'},
      {tab:'audit',target:'#a-btn',lbl:'Tool 1 · Site Audit',title:'Read the result at a glance',body:'The report opens with one clear OVERALL pass/fail up top; the other numbers are 0–100 quality reads, not separate verdicts. The summary cards are clickable — jump straight to the failing checks — and a colour key explains that red means passing.'},
      {tab:'visual',target:'#v-ref',lbl:'Tool 2 · Visual Comparison',title:'Old vs new, side by side',body:'Give a reference URL and a target URL. Every paired page is compared at each viewport on two axes: pixel match and structural diff (missing / extra / moved / restyled elements).'},
      // Targets the gear, not #v-vps: the viewport chips are settings-owned (display:none) and a hidden
      // node measures 0x0, so spotlighting it would frame nothing in the corner of the screen.
      {tab:'visual',target:'#gear-visual',lbl:'Tool 2 · Settings',title:'Real devices, really emulated',body:'Open Settings to choose what a comparison does: like-for-like or redesign, how many pages, and the viewports. Ten current devices — Desktop, MacBook Air, iPad Air/mini, iPhone, Galaxy S — each checked against the vendor spec and emulated with real touch and pixel density, not just a narrow window. Below the line sit three framework boundary probes: width only, honestly labelled, because a layout breaks exactly on a breakpoint. Every tool has its own gear.'},
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

    // ================= PER-TOOL SETTINGS =========================================================
    // A gear on each of the 4 tools opens THIS tool's settings. Three rules hold the design together:
    //
    //  1. ONE SOURCE OF TRUTH. Every field either BINDS to the real control the runner already reads
    //     (a-max, a-render, a-vps, v-scope, ...) or has no DOM twin at all (scope, reports.limit).
    //     The popup is a second VIEW of that control, never a second copy of the value — so wiring the
    //     popup cannot desync from what /api/run actually receives. It also means the run path below
    //     is untouched: runAudit() still reads $('a-max'), exactly as it did before this existed.
    //  2. FACTORY IS THE AUTHORED DOM, snapshotted at parse time before any restore runs. "Reset
    //     defaults" therefore restores what the build literally ships with — it cannot drift from the
    //     HTML the way a hand-maintained defaults table would.
    //  3. TWO SLOTS, NO MAGIC. Saved default (server, NOTES_DIR/settings.json) or FACTORY. Changing a
    //     field affects this session; it persists when you click Save as default. No hidden auto-stick.
    var TOOLS={
      audit:{name:'Site Audit',ic:'\\u2713',sub:'CRAWL \\u00b7 RENDER \\u00b7 SCORE'},
      visual:{name:'Visual Comparison',ic:'\\u21c4',sub:'REFERENCE vs TARGET'},
      cert:{name:'Post-Deployment Check',ic:'\\u2605',sub:'DID EVERYTHING MAKE IT ACROSS'},
      reports:{name:'Reports',ic:'\\u25a4',sub:'HISTORY \\u00b7 PREVIEW \\u00b7 EXPORT'}
    };
    // t: bool|num|sel|vps|scope · bind: the id of the live control this field is a view of.
    var FIELDS={
      audit:[
        {k:'maxPages',t:'num',bind:'a-max',min:1,max:500,label:'Max pages to crawl',hint:'1 = homepage only; higher follows the sitemap + internal links up to this cap. Sent to the scan as maxPages.'},
        {k:'render',t:'bool',bind:'a-render',label:'Browser render pass',hint:'Loads each page in a real headless browser for axe-core accessibility, Core Web Vitals, full-page screenshots and the Firefox + WebKit pass. Off = a faster static-only scan that cannot see any of those.'},
        {k:'viewports',t:'vps',bind:'a-vps',label:'Viewports swept',hint:'The responsive sweep. Devices are really emulated (touch, pixel density, mobile UA); the boundary probes are width only. Fewer = faster.'},
        {k:'scope',t:'scope',label:'Checks included in the score',hint:'Untick a check and the Quality score is recalculated across what is left ALONE — the excluded risk leaves the total, not just the deductions.'},
        // perRun: rendered here for discoverability, but NOT a setting. Excluded from the gear's custom
        // dot, from "Save as default", and from the load path. Making it a normal field would persist the
        // name server-side (saveAsDefault POSTs DRAFT) — the same silent-overwrite bug as the old
        // localStorage entry, but in a store that survives clearing localStorage. See #a-save.
        {k:'saveAs',t:'text',bind:'a-save',perRun:true,ph:'reference name',label:'Save this scan as a reference (this run only)',hint:'Names the baseline THIS scan is stored as, so Visual Comparison can diff a later scan against it. Example: save the live site, then compare staging to it. Deliberately per-run: it is never kept as a default and clears once a scan uses it, because saving a baseline overwrites any reference of the same name — a remembered name would silently re-point your reference at whatever you scanned next.'}
      ],
      visual:[
        // Binds to #v-mode, the live select runVisual() reads — same contract as every other field
        // here (rule 1 above). FACTORY is the authored DOM, and #v-mode's first <option> is
        // like-for-like, so the shipped default is today's behaviour: pixel pass ON, unchanged.
        {k:'mode',t:'sel',bind:'v-mode',label:'Comparison mode',opts:[['like-for-like','Like-for-like replatform (pixel diff on)'],['redesign','Redesign (pixel diff off — structure only)']],hint:'The pixel diff only answers a question worth asking when the two sites are supposed to look the SAME. Like-for-like = same design, new platform: the diff is on and scored. Redesign = the new site is meant to look different: the diff is switched off (it would only measure the intent) and the match score becomes structural only — what the old site had vs what the new build still has. Both sides are still screenshotted either way.'},
        {k:'scope',t:'sel',bind:'v-scope',label:'Page scope',opts:[['single','Single page (homepage)'],['multiple','Multiple pages (up to max)'],['sitemap','Sitemap-driven'],['full','Full site']],hint:'How many pages to pair up and compare. Full site discovers additional linked pages and may surface non-canonical URLs.'},
        {k:'maxPages',t:'num',bind:'v-max',min:1,max:200,label:'Max pages',hint:'Upper bound on paired pages for the Multiple / Sitemap / Full scopes.'},
        {k:'warmLoads',t:'num',bind:'v-warm',min:1,max:5,label:'Warm-up loads',hint:'Load each page this many times before screenshotting so lazy-loaded / CDN-cold assets are in — fewer false diffs. 1 = no warm-up.'},
        {k:'viewports',t:'vps',bind:'v-vps',label:'Viewports compared',hint:'Each paired page is diffed at every selected viewport on both axes (pixel match + structural).'}
      ],
      cert:[
        {k:'sitemapOnly',t:'bool',bind:'c-sitemap',label:'Sitemap-only completeness',hint:'Use the sitemap as the authoritative page list. Without it a capped crawl reports completeness as manual, never authoritative.'},
        {k:'visual',t:'bool',bind:'c-visual',label:'Run the visual comparison stage',hint:'Adds a source-vs-target visual diff to the certification pipeline. Slower.'},
        {k:'production',t:'bool',bind:'c-prod',label:'Production validation (audit the target)',hint:'Runs a full Site Audit against the migrated target as part of the pipeline.'},
        {k:'maxPages',t:'num',bind:'c-max',min:1,max:700,label:'Max pages',hint:'Crawl cap for both the source inventory and the target verification.'}
      ],
      reports:[
        {k:'filter',t:'sel',label:'Default filter',opts:[['all','All'],['audit','Audit'],['visual','Visual'],['cert','Post-Deploy'],['case','Cases']],hint:'Which run type the Reports list opens on.'},
        {k:'date',t:'sel',bind:'r-date',label:'Default date range',opts:[['all','Any time'],['1','Today'],['7','Last 7 days'],['30','Last 30 days']],hint:'Date filter the Reports list opens on.'},
        {k:'limit',t:'num',min:1,max:500,label:'Runs to load',hint:'How many past runs the server returns to the Reports list, newest first. Higher = deeper history, slower list.'}
      ]
    };
    var SCOPE_CAT=${JSON.stringify(SCOPE_CATALOG).replace(/</g, '\\u003c')};
    var SCOPE_EXCLUDED=[];        // ruleIds excluded from SCORING (the checks still run + still report)
    var UNBOUND={reports:{filter:'all',limit:60}};
    function sEsc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
    function clone(o){return JSON.parse(JSON.stringify(o));}
    function vpsOpts(bind){var c=$(bind);if(!c)return [];
      return [].slice.call(c.querySelectorAll('label.chip')).map(function(l){var i=l.querySelector('input');return {v:i.value,label:l.textContent.trim()};});}
    // read/write a field through its bound control — the control stays the truth
    function fGet(tool,f){
      if(f.t==='scope')return SCOPE_EXCLUDED.slice();
      if(f.t==='vps'){var c=$(f.bind);if(!c)return [];return [].slice.call(c.querySelectorAll('input:checked')).map(function(i){return i.value;});}
      if(f.bind){var el=$(f.bind);if(!el)return null;return f.t==='bool'?el.checked:(f.t==='num'?(+el.value||0):el.value);}
      return UNBOUND[tool][f.k];
    }
    function fSet(tool,f,v){
      if(f.t==='scope'){SCOPE_EXCLUDED=Array.isArray(v)?v.slice():[];return;}
      if(f.t==='vps'){var c=$(f.bind);if(!c||!Array.isArray(v))return;
        // Matrix-migration guard (carried over from the old form-persistence block). A saved viewport
        // list is a set of WIDTHS and the device matrix has changed before (1200/480/430/380 retired,
        // 1180/820/744/414/440/393/384/1280 added). Restoring a pre-change list verbatim would leave
        // most of the new matrix unchecked — a silently shrunken sweep nobody chose and nobody sees.
        // If the saved list names a width this build no longer ships, discard it and keep the authored
        // matrix. A list made on the CURRENT matrix contains only known widths and restores exactly.
        var ins=[].slice.call(c.querySelectorAll('input')),known={};
        ins.forEach(function(i){known[i.value]=1;});
        if(v.some(function(x){return !known[x];}))return;
        ins.forEach(function(i){i.checked=v.indexOf(i.value)>=0;});return;}
      if(f.bind){var el=$(f.bind);if(!el)return;if(f.t==='bool')el.checked=!!v;else el.value=v;return;}
      UNBOUND[tool][f.k]=v;
    }
    function readTool(tool){var o={};FIELDS[tool].forEach(function(f){o[f.k]=fGet(tool,f);});return o;}
    function writeTool(tool,vals){FIELDS[tool].forEach(function(f){if(vals&&vals[f.k]!=null)fSet(tool,f,vals[f.k]);});}
    // FACTORY = the authored DOM, snapshotted NOW (parse time) before anything restores over it.
    var FACTORY={};Object.keys(FIELDS).forEach(function(t){FACTORY[t]=readTool(t);});
    var SAVED={},curTool='audit',DRAFT={};
    // A perRun field sits in the popup but is not a setting. It must never reach the defaults store, the
    // factory comparison, or the load path — otherwise "Save as default" would make a one-shot value
    // permanent. Strip it at every boundary where a settings OBJECT is compared or persisted.
    function stripPerRun(tool,o){var c=clone(o||{});(FIELDS[tool]||[]).forEach(function(f){if(f.perRun)delete c[f.k];});return c;}
    // Compare on the stripped object, or typing a save-as name would paint the gear "custom" — telling
    // you the tool's settings had changed when nothing about how it scans did.
    function isCustom(tool){return JSON.stringify(stripPerRun(tool,readTool(tool)))!==JSON.stringify(stripPerRun(tool,FACTORY[tool]));}
    function paintGears(){Object.keys(TOOLS).forEach(function(t){var g=$('gear-'+t);if(g)g.classList.toggle('custom',isCustom(t));});}
    function openSettings(tool){
      curTool=tool;DRAFT=clone(readTool(tool));
      $('set-ic').innerHTML=TOOLS[tool].ic;$('set-title').textContent=TOOLS[tool].name+' \\u2014 settings';
      $('set-sub').textContent=TOOLS[tool].sub+' \\u00b7 CUSTOM TEST SETTINGS';
      $('set-saved').textContent='';renderModal();$('setmodal').classList.add('on');
    }
    function closeSettings(){$('setmodal').classList.remove('on');}
    function renderModal(){
      $('set-body').innerHTML=FIELDS[curTool].map(function(f){
        if(f.t==='scope')return '<div class="opt col"><div class="otx"><b>'+sEsc(f.label)+'</b><span>'+sEsc(f.hint)+'</span></div><div id="sc-host"></div></div>';
        if(f.t==='vps')return '<div class="opt col"><div class="otx"><b>'+sEsc(f.label)+'</b><span>'+sEsc(f.hint)+'</span></div><div class="chips" id="vp-host-'+f.k+'">'+
          vpsOpts(f.bind).map(function(o){return '<label class="chip"><input type="checkbox" value="'+sEsc(o.v)+'"'+(DRAFT[f.k].indexOf(o.v)>=0?' checked':'')+' onchange="setVps(\\''+f.k+'\\')">'+sEsc(o.label)+'</label>';}).join('')+'</div></div>';
        var ctl='';
        if(f.t==='bool')ctl='<label class="sw"><input type="checkbox"'+(DRAFT[f.k]?' checked':'')+' onchange="setF(\\''+f.k+'\\',this.checked)" aria-label="'+sEsc(f.label)+'"><i></i></label>';
        if(f.t==='num')ctl='<input type="number" value="'+sEsc(DRAFT[f.k])+'" min="'+f.min+'" max="'+f.max+'" onchange="setF(\\''+f.k+'\\',+this.value)" aria-label="'+sEsc(f.label)+'">';
        // oninput, not onchange: onchange only fires on blur, so clicking Apply straight after typing
        // would commit a DRAFT that never saw the last keystroke.
        if(f.t==='text')ctl='<input type="text" value="'+sEsc(DRAFT[f.k]||'')+'" placeholder="'+sEsc(f.ph||'')+'" spellcheck="false" oninput="setF(\\''+f.k+'\\',this.value)" aria-label="'+sEsc(f.label)+'">';
        if(f.t==='sel')ctl='<select onchange="setF(\\''+f.k+'\\',this.value)" aria-label="'+sEsc(f.label)+'">'+f.opts.map(function(o){return '<option value="'+sEsc(o[0])+'"'+(String(DRAFT[f.k])===o[0]?' selected':'')+'>'+sEsc(o[1])+'</option>';}).join('')+'</select>';
        return '<div class="opt"><div class="otx"><b>'+sEsc(f.label)+'</b><span>'+sEsc(f.hint)+'</span></div><div class="octl">'+ctl+'</div></div>';
      }).join('');
      if(FIELDS[curTool].some(function(f){return f.t==='scope';}))renderScope();
    }
    function setF(k,v){DRAFT[k]=v;}
    function setVps(k){var h=$('vp-host-'+k);DRAFT[k]=[].slice.call(h.querySelectorAll('input:checked')).map(function(i){return i.value;});}
    // ---- scope tree: suites that expand to their individual checks ----
    function scRules(sk){return SCOPE_CAT.rules.filter(function(r){return r.suite===sk;});}
    function scOn(id){return DRAFT.scope.indexOf(id)<0;}
    function renderScope(){
      var h='<div class="sc-tools"><button class="bt" onclick="scAll(true)">Include all</button><button class="bt" onclick="scAll(false)">Exclude all</button><span class="sc-count" id="sc-count"></span></div><div class="sctree">';
      SCOPE_CAT.suites.forEach(function(s){
        var rs=scRules(s.key),on=rs.filter(function(r){return scOn(r.id);}).length;
        h+='<div class="scs" data-k="'+sEsc(s.key)+'"><div class="scs-h" onclick="scTog(event,\\''+s.key+'\\')">'+
          '<input type="checkbox" onclick="event.stopPropagation()" onchange="scSuite(\\''+s.key+'\\',this.checked)" aria-label="'+sEsc(s.name)+'"'+(on===rs.length?' checked':'')+'>'+
          '<span class="nm">'+sEsc(s.name)+'</span><span class="mt" id="sc-m-'+sEsc(s.key)+'">'+on+'/'+rs.length+' \\u00b7 weight '+s.weight+'</span><span class="cv">\\u25b8</span></div><div class="scs-b">'+
          rs.map(function(r){return '<div class="scr'+(scOn(r.id)?'':' off')+'" id="sc-r-'+sEsc(r.id)+'"><input type="checkbox"'+(scOn(r.id)?' checked':'')+' onchange="scRule(\\''+r.id+'\\',this.checked)" aria-label="'+sEsc(r.id)+'"><span class="rid">'+sEsc(r.id)+'</span><span class="rt" title="'+sEsc(r.title)+'">'+sEsc(r.title)+'</span><span class="rd">\\u2212'+r.ded+'</span></div>';}).join('')+
          '</div></div>';
      });
      h+='</div><div class="sc-note"><b>How this changes the number.</b> A section\\u2019s score is the share of its known risk that is resolved. Excluding a check removes its risk from the total <b>and</b> from the deductions \\u2014 so excluding a failing check raises the score, excluding a passing one lowers it, and a fully excluded section drops out of the weighted average instead of scoring 100. '+SCOPE_CAT.manualCount+' manual checks are not listed: they carry no deduction and can never move the score.</div>'+
        '<div class="sc-warn" id="sc-warn" style="display:none"></div>';
      $('sc-host').innerHTML=h;scPaint();
    }
    function scPaint(){
      var tot=SCOPE_CAT.rules.length,out=DRAFT.scope.length,on=tot-out;
      var c=$('sc-count');c.innerHTML='scoring on <b>'+on+'</b> / '+tot+' checks';c.classList.toggle('part',out>0);
      SCOPE_CAT.suites.forEach(function(s){
        var rs=scRules(s.key),k=rs.filter(function(r){return scOn(r.id);}).length;
        var m=$('sc-m-'+s.key);if(m)m.textContent=k+'/'+rs.length+' \\u00b7 weight '+s.weight;
        var box=document.querySelector('.scs[data-k="'+s.key+'"] .scs-h input');
        if(box){box.checked=k===rs.length;box.indeterminate=k>0&&k<rs.length;}
      });
      var w=$('sc-warn');
      if(!w)return;
      if(out>0){w.style.display='';w.innerHTML='<b>\\u26a0 Partial audit.</b> '+out+' of '+tot+' checks ('+Math.round(out/tot*100)+'%) will be left out of the Quality score. The run still performs every check and the report still lists them \\u2014 and the report will carry a disclosure notice above the score. The pass/fail verdict and launch-readiness gate stay whole-site, so de-scoping cannot buy a pass.';}
      else w.style.display='none';
    }
    function scTog(e,k){if(e.target.tagName==='INPUT')return;document.querySelector('.scs[data-k="'+k+'"]').classList.toggle('open');}
    function scSet(id,on){var i=DRAFT.scope.indexOf(id);if(on&&i>=0)DRAFT.scope.splice(i,1);if(!on&&i<0)DRAFT.scope.push(id);
      var row=$('sc-r-'+id);if(row){row.classList.toggle('off',!on);var b=row.querySelector('input');if(b)b.checked=on;}}
    function scRule(id,on){scSet(id,on);scPaint();}
    function scSuite(k,on){scRules(k).forEach(function(r){scSet(r.id,on);});scPaint();}
    function scAll(on){SCOPE_CAT.rules.forEach(function(r){scSet(r.id,on);});scPaint();}
    // ---- apply / save / reset ----
    var AFTER={reports:function(){rfilter(UNBOUND.reports.filter);loadReports();}};
    function applySettings(after){
      writeTool(curTool,DRAFT);
      if(AFTER[curTool])AFTER[curTool]();
      paintGears();
      if(after!=='keep')closeSettings();
    }
    function saveAsDefault(){
      applySettings('keep');
      fetch('/api/settings',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({tool:curTool,values:stripPerRun(curTool,DRAFT)})})
        .then(function(r){return r.json();}).then(function(d){
          if(!d||!d.ok)throw new Error((d&&d.error)||'save failed');
          SAVED=d.tools||{};$('set-saved').textContent='\\u2713 saved as default';
        }).catch(function(e){$('set-saved').textContent='\\u2715 '+e;});
    }
    function resetDefaults(){
      DRAFT=clone(FACTORY[curTool]);
      writeTool(curTool,DRAFT);
      if(AFTER[curTool])AFTER[curTool]();
      renderModal();paintGears();
      fetch('/api/settings',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({tool:curTool,reset:1})})
        .then(function(r){return r.json();}).then(function(d){
          if(!d||!d.ok)throw new Error((d&&d.error)||'reset failed');
          SAVED=d.tools||{};$('set-saved').textContent='\\u2713 reset to factory defaults';
        }).catch(function(e){$('set-saved').textContent='\\u2715 '+e;});
    }
    // Restore saved defaults on boot. Runs before the URL-persistence block below; the two touch
    // disjoint controls (settings here, per-run URL/name text there), so their order does not matter.
    fetch('/api/settings').then(function(r){return r.json();}).then(function(d){
      SAVED=(d&&d.tools)||{};
      Object.keys(FIELDS).forEach(function(t){if(SAVED[t])writeTool(t,stripPerRun(t,SAVED[t]));});
      if(SAVED.reports)AFTER.reports();
      paintGears();
    }).catch(function(){});
    document.addEventListener('keydown',function(e){if(e.key==='Escape')closeSettings();});

    // The URLs you type still stick automatically across launches — they are not settings and have no
    // popup. Everything that IS a setting moved to the per-tool popup above and persists server-side via
    // Save as default, so it is no longer mirrored here: two writers for one control is how a saved value
    // silently loses a race on load.
    //
    // #a-save is DELIBERATELY NOT in this list any more. It used to be, alongside the URLs, and that was
    // a live false-data path: saveBaseline() overwrites baselines/<name>.json unconditionally, so a
    // remembered name re-saved the reference on the next scan of anything. Save "live", relaunch, scan
    // staging -> the "live" baseline IS staging, and Visual Comparison diffs staging against itself and
    // calls it clean. Being visible on the dashboard was the only thing that made it survivable; now that
    // it lives behind the gear, remembering it would make it silent. It is one-shot: runAudit() clears it.
    (function(){
      var KEY='sgenqa_form_v1';
      var IDS=['a-url','v-ref','v-tgt','c-src','c-tgt'];
      function lsGet(){try{return JSON.parse(localStorage.getItem(KEY)||'{}');}catch(e){return {};}}
      function load(cb){ if(window.sgenApp&&sgenApp.getFlag){sgenApp.getFlag(KEY).then(function(v){cb(v?JSON.parse(v):lsGet());}).catch(function(){cb(lsGet());});} else cb(lsGet()); }
      function store(s){var j=JSON.stringify(s);if(window.sgenApp&&sgenApp.setFlag){try{sgenApp.setFlag(KEY,j);}catch(e){}}try{localStorage.setItem(KEY,j);}catch(e){}}
      var st={};
      function snapshot(){IDS.forEach(function(id){var el=$(id);if(!el)return;st[id]=el.type==='checkbox'?el.checked:el.value;});store(st);}
      load(function(saved){ st=saved||{};
        IDS.forEach(function(id){var el=$(id);if(!el||st[id]==null)return;if(el.type==='checkbox')el.checked=!!st[id];else el.value=st[id];});
        IDS.forEach(function(id){var el=$(id);if(el)el.addEventListener('change',snapshot);});
      });
    })();
${TOTOP_JS}
    // THE global back-to-top, and the one that does the real work. It is wired to the SHELL's window
    // because that is the window that actually scrolls: showReport() embeds each report in an iframe
    // that autosize() grows to the report's full content height with scrolling='no', so the inner
    // window has innerHeight === scrollHeight and cannot move (measured: a visual report frame is
    // 2247/2247, an audit ~5458). All the scrolling a user does while reading an embedded report is
    // THIS window's scrolling — so this control alone covers every report shown in the app, and the
    // reports' own copies stand down while framed rather than render a button that cannot work.
    initToTop(window);
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
    // print=1 tells the report's client script this render is destined for a PDF, so screen-only
    // furniture (the floating back-to-top) never installs. It has to be an explicit flag rather than
    // a CSS @media print rule, BECAUSE of the emulateMedia('screen') line below: that pins the page
    // to screen media, so print rules cannot match here and a CSS-only guard would silently ship a
    // floating arrow into a client's PDF. The /annotate route already takes print=1 the same way.
    await page.goto(`http://127.0.0.1:${PORT}/${m[1]}/${id}?print=1`, { waitUntil: 'networkidle', timeout: 60000 });
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

// ---- Site Comparison: annotate + annotated PDF export --------------------------------------------
// Live markup in the app, then a PDF of exactly what was marked up. Two panes only — live vs
// staging. The red pixel-diff overlay that report-visual.js shows as "Difference overlay" is not
// part of this path: annotate.buildExportModel() reads shots.ref + shots.cand and nothing else, so
// there is no diff image to leave out here.
//
// Routes:
//   GET  /annotate/<id>[?print=1][&only=annotated]  live preview (or the print body the PDF renders)
//   GET  /annotate/<id>/<asset>                     the run's shots, via the shared serveAsset
//   GET  /api/annotations?id=<id>                   load
//   POST /api/annotations?id=<id>                   save (whole store; sanitized server-side)
//   GET  /api/annotate-pdf?id=<id>[&only=annotated] render + save {domain}-{date}-v{n}.pdf -> JSON
//   GET  /api/annotate-pdf-file?name=<file>         download a previously exported PDF
// The print document requests its panes downscaled (?w=1200&fmt=jpg). A pane occupies ~540px on an
// A4 landscape sheet while a real full-page capture is 1920px wide and can run ~15000px tall, so
// handing Chromium the native PNG buries megabytes of invisible pixels in the PDF. sharp is already
// a dependency of visual-match.js; if it is missing we serve the original untouched rather than
// fail the export — a fat PDF beats no PDF.
let sharpLib = null; try { sharpLib = require('sharp'); } catch (_) { sharpLib = null; }
async function serveAnnotateAsset(res, id, rest, u) {
  const w = parseInt(u.searchParams.get('w') || '', 10);
  const jpg = u.searchParams.get('fmt') === 'jpg';
  if (!w || !sharpLib || !/\.png$/i.test(rest.split('?')[0])) return serveAsset(res, id, rest);
  try { rest = decodeURIComponent(rest); } catch (_) {}
  rest = rest.replace(/\\/g, '/').replace(/\.\.[/\\]/g, '');
  const f = path.join(RUNS, id, rest);
  if (!f.startsWith(RUNS) || !fs.existsSync(f)) return send(res, 404, 'text/plain', 'not found');
  try {
    let img = sharpLib(f).resize({ width: Math.max(200, Math.min(3000, w)), withoutEnlargement: true });
    const out = jpg ? await img.jpeg({ quality: 82 }).toBuffer() : await img.png({ compressionLevel: 9 }).toBuffer();
    return send(res, 200, jpg ? 'image/jpeg' : 'image/png', out);
  } catch (e) { return serveAsset(res, id, rest); }
}

function visualRunData(id) {
  const f = path.join(RUNS, id, 'visual-match.json');
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; }
}

function annotateDoc(id, { print = false, onlyAnnotated = false, exportName = null } = {}) {
  const data = visualRunData(id);
  if (!data) return null;
  const runDir = path.join(RUNS, id);
  const ann = annotate.loadAnnotations(runDir);
  const model = annotate.buildExportModel(data, ann, { onlyAnnotated });
  if (exportName) model.exportName = exportName;
  return { html: renderAnnotate(model, ann, { mode: print ? 'print' : 'live', runId: id }), model, ann };
}

// Page count straight out of the produced bytes — the PDF's own page objects, not our sheet count.
// If these two ever disagree, the number reported is the one the reader will actually see.
function pdfPageCount(buf) {
  const s = buf.toString('latin1');
  const byType = (s.match(/\/Type\s*\/Page[^s]/g) || []).length;
  if (byType) return byType;
  const counts = [...s.matchAll(/\/Count\s+(\d+)/g)].map(m => +m[1]);
  return counts.length ? Math.max(...counts) : 0;
}

function apiAnnotations(req, res, u, body) {
  const id = safe(u.searchParams.get('id') || '');
  const runDir = path.join(RUNS, id);
  if (!id || !fs.existsSync(runDir)) return send(res, 404, 'application/json', JSON.stringify({ ok: false, error: 'run not found' }));
  if (req.method === 'GET') {
    const ann = annotate.loadAnnotations(runDir);
    return send(res, 200, 'application/json', JSON.stringify({ ok: true, annotations: ann, counts: annotate.countAnnotations(ann) }));
  }
  let raw; try { raw = JSON.parse(body || '{}'); } catch (e) { return send(res, 400, 'application/json', JSON.stringify({ ok: false, error: 'bad json' })); }
  try {
    const saved = annotate.saveAnnotations(runDir, raw);
    return send(res, 200, 'application/json', JSON.stringify({ ok: true, annotations: saved, counts: annotate.countAnnotations(saved) }));
  } catch (e) { return send(res, 500, 'application/json', JSON.stringify({ ok: false, error: String(e && e.message || e) })); }
}

async function apiAnnotatePdf(req, res, u) {
  const id = safe(u.searchParams.get('id') || '');
  const runDir = path.join(RUNS, id);
  const data = id ? visualRunData(id) : null;
  if (!data) return send(res, 404, 'application/json', JSON.stringify({ ok: false, error: 'comparison run not found' }));
  const onlyAnnotated = u.searchParams.get('only') === 'annotated';
  const ann = annotate.loadAnnotations(runDir);
  const model = annotate.buildExportModel(data, ann, { onlyAnnotated });
  if (!model.totals.sheets) return send(res, 400, 'application/json', JSON.stringify({ ok: false, error: onlyAnnotated ? 'no annotated sheets yet — add a mark or a note first' : 'this run paired no pages' }));
  const dir = path.join(RUNS, annotate.EXPORTS_DIRNAME);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  // Reserve the name BEFORE rendering, ATOMICALLY. A plain existsSync check would leave a wide
  // TOCTOU window (the render takes seconds), so two exports fired together could both resolve to
  // v1 and the second would silently clobber the first — exactly what the versioning rule exists to
  // prevent. openSync(...,'wx') fails if the name is taken, so the winner owns it; retry to walk up
  // to the next free version.
  let name, version, file, fd = null;
  for (let attempt = 0; attempt < 20 && fd === null; attempt++) {
    ({ name, version } = annotate.nextExportName(dir, model.domain, annotate.todayStamp()));
    file = path.join(dir, name);
    try { fd = fs.openSync(file, 'wx'); } catch (e) { if (e.code !== 'EEXIST') throw e; fd = null; }
  }
  if (fd === null) return send(res, 409, 'application/json', JSON.stringify({ ok: false, error: 'could not reserve an export filename for ' + model.domain }));
  fs.closeSync(fd);
  const abandon = () => { try { const s = fs.statSync(file); if (!s.size) fs.unlinkSync(file); } catch (_) {} };
  let chromium;
  try { ({ chromium } = require('playwright')); }
  catch (e) { abandon(); return send(res, 501, 'application/json', JSON.stringify({ ok: false, error: 'PDF export needs Playwright (npx playwright install chromium)' })); }
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const q = `print=1&name=${encodeURIComponent(name)}${onlyAnnotated ? '&only=annotated' : ''}`;
    // Render THROUGH the local server (not file://) so the <base>-relative shots resolve exactly as
    // they do in the preview — same reasoning as apiPdf above.
    await page.goto(`http://127.0.0.1:${PORT}/annotate/${id}?${q}`, { waitUntil: 'networkidle', timeout: 120000 });
    // Wait on the document's own readiness flag (set once every mark is painted) rather than a sleep.
    await page.waitForFunction('document.body && document.body.dataset.ready === "1"', null, { timeout: 45000 });
    await page.emulateMedia({ media: 'screen' });   // keep the SGEN dark skin, as /api/pdf does
    const pdf = await page.pdf({ format: 'A4', landscape: true, printBackground: true, preferCSSPageSize: false, margin: { top: '6mm', bottom: '6mm', left: '5mm', right: '5mm' } });
    await browser.close(); browser = null;
    fs.writeFileSync(file, pdf);
    const counts = annotate.countAnnotations(ann);
    return send(res, 200, 'application/json', JSON.stringify({
      ok: true, file: name, version, bytes: pdf.length, pages: pdfPageCount(pdf),
      sheets: model.totals.sheets, marks: counts.marks, comments: counts.comments, path: file,
    }));
  } catch (e) {
    if (browser) try { await browser.close(); } catch (_) {}
    abandon();   // release the reserved name so a failed render doesn't burn a version number
    return send(res, 500, 'application/json', JSON.stringify({ ok: false, error: 'PDF export failed: ' + (e && e.message || e) }));
  }
}

function apiAnnotatePdfFile(res, u) {
  const name = path.basename(String(u.searchParams.get('name') || ''));
  if (!/^[a-z0-9.\-]+\.pdf$/i.test(name)) return send(res, 400, 'text/plain', 'bad name');
  const f = path.join(RUNS, annotate.EXPORTS_DIRNAME, name);
  if (!f.startsWith(path.join(RUNS, annotate.EXPORTS_DIRNAME)) || !fs.existsSync(f)) return send(res, 404, 'text/plain', 'not found');
  const buf = fs.readFileSync(f);
  res.writeHead(200, { 'content-type': 'application/pdf', 'content-disposition': `attachment; filename="${name}"`, 'content-length': buf.length });
  res.end(buf);
}

// ---- Inspect (2.5.12): open a REAL browser on the offending page with the element highlighted -----
// INSPECT_INJECT is a standalone injectable function string (same pattern as DESCRIBE_ELEMENTS in
// evidence-providers.js) so the resolve+highlight logic is unit-testable independent of launch mode.
// Called in-page as (INSPECT_INJECT)(spec); returns { matchedBy, tried[], rect } or matchedBy:null.
// Fallback tiers, in order: (1) selector, (2) each strategy value, (3) xpath, (4) SIGNATURE
// (structuralCss → nearest text match → nearest to boundingBox). matchedBy names the tier that hit.
const INSPECT_INJECT = `(function(spec){
  spec = spec || {};
  function byCss(sel){ try{ return sel ? document.querySelector(sel) : null; }catch(e){ return null; } }
  function byXpath(xp){ try{ var r=document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null); return (r&&r.singleNodeValue&&r.singleNodeValue.nodeType===1)?r.singleNodeValue:null; }catch(e){ return null; } }
  function looksXpath(v){ return typeof v==='string' && (v.charAt(0)==='/' || v.slice(0,2)==='./'); }
  var tried=[], el=null, matchedBy=null;
  // (1) preferred selector
  if(spec.selector){ tried.push('selector'); el=byCss(spec.selector); if(el)matchedBy='selector'; }
  // (2) ranked strategies, in order (id > data-testid > class > attr > structural-css > xpath)
  if(!el && spec.strategies && spec.strategies.length){
    for(var i=0;i<spec.strategies.length;i++){ var s=spec.strategies[i]; var v=s&&s.value; if(!v)continue;
      var kind=(s.kind||('#'+i)); tried.push('strategy:'+kind);
      el = (s.kind==='xpath'||looksXpath(v)) ? byXpath(v) : byCss(v);
      if(el){ matchedBy='strategy:'+kind; break; } } }
  // (3) xpath
  if(!el && spec.xpath){ tried.push('xpath'); el=byXpath(spec.xpath); if(el)matchedBy='xpath'; }
  // (4) signature fallback — structuralCss, else nearest text match, else nearest to boundingBox
  if(!el && spec.structuralCss){ tried.push('structuralCss'); el=byCss(spec.structuralCss); if(el)matchedBy='signature:structuralCss'; }
  if(!el && spec.text){ tried.push('text'); var want=String(spec.text).trim().slice(0,120);
    if(want){ var all=document.body?document.body.getElementsByTagName('*'):[]; var best=null,bestLen=Infinity;
      for(var j=0;j<all.length;j++){ var t=(all[j].textContent||'').trim(); if(t && t.indexOf(want)>=0 && t.length<bestLen){ best=all[j]; bestLen=t.length; } }
      if(best){ el=best; matchedBy='signature:text'; } } }
  if(!el && spec.boundingBox){ tried.push('boundingBox'); var bb=spec.boundingBox;
    var cx=(bb.x||0)+(bb.width||0)/2, cy=((bb.y||0)-(window.scrollY||0))+(bb.height||0)/2;
    var hit=null; try{ hit=document.elementFromPoint(cx, cy); }catch(e){}
    if(hit){ el=hit; matchedBy='signature:boundingBox'; } }
  if(!el) return { matchedBy:null, tried:tried, rect:null };
  // highlight — scroll into view, then a fixed-position overlay box + badge appended to <body>.
  try{ el.scrollIntoView({block:'center', inline:'center'}); }catch(e){}
  var r=el.getBoundingClientRect();
  var OID='__sgen_inspect_overlay__';
  var old=document.getElementById(OID); if(old&&old.parentNode)old.parentNode.removeChild(old);
  var box=document.createElement('div'); box.id=OID; box.setAttribute('data-sgen-inspect','1');
  var top=Math.max(0,r.top), left=Math.max(0,r.left);
  box.style.cssText='position:fixed;z-index:2147483647;pointer-events:none;box-sizing:border-box;'
    +'border:3px solid #E01F26;border-radius:3px;box-shadow:0 0 0 3px rgba(224,31,38,.35);'
    +'background:rgba(224,31,38,.12);left:'+left+'px;top:'+top+'px;width:'+Math.max(2,r.width)+'px;height:'+Math.max(2,r.height)+'px;';
  var badge=document.createElement('div'); badge.textContent=String(spec.label||spec.selector||'element');
  var badgeTop=(r.top>26)?'-24px':(r.height+4)+'px';
  badge.style.cssText='position:absolute;left:0;top:'+badgeTop+';background:#E01F26;color:#fff;'
    +'font:700 12px/1.6 ui-monospace,Menlo,Consolas,monospace;padding:2px 8px;border-radius:5px;'
    +'white-space:nowrap;max-width:60vw;overflow:hidden;text-overflow:ellipsis;';
  box.appendChild(badge); document.body.appendChild(box);
  return { matchedBy:matchedBy, tried:tried, rect:{ x:Math.round(r.left), y:Math.round(r.top), width:Math.round(r.width), height:Math.round(r.height) } };
})`;

// bound concurrency: never spawn unbounded headed browsers. Each open inspect increments; a browser's
// 'disconnected' (window closed) decrements. >2 already open → refuse rather than launch a third.
let INSPECT_INFLIGHT = 0;
async function apiInspect(req, res) {
  let body;
  try { body = JSON.parse(await readBody(req) || '{}'); }
  catch (e) { return send(res, 400, 'application/json', JSON.stringify({ ok: false, reason: 'bad json' })); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return send(res, 400, 'application/json', JSON.stringify({ ok: false, reason: 'bad body' }));
  const url = String(body.url || '').trim();
  if (!/^https?:\/\//i.test(url)) return send(res, 400, 'application/json', JSON.stringify({ ok: false, reason: 'only http/https urls can be inspected' }));
  if (INSPECT_INFLIGHT >= 2) return send(res, 429, 'application/json', JSON.stringify({ ok: false, reason: 'too-many-open' }));
  let chromium;
  try { ({ chromium } = require('playwright')); }
  catch (e) { return send(res, 501, 'application/json', JSON.stringify({ ok: false, reason: 'headed-browser-unavailable' })); }
  const spec = {
    selector: body.selector || null,
    strategies: Array.isArray(body.strategies) ? body.strategies : [],
    xpath: body.xpath || null,
    structuralCss: body.structuralCss || null,
    text: body.text || null,
    boundingBox: (body.boundingBox && typeof body.boundingBox === 'object') ? body.boundingBox : null,
    label: String(body.label || (body.fingerprint ? ('#' + String(body.fingerprint).slice(0, 10)) : (body.selector || 'element'))),
  };
  INSPECT_INFLIGHT++;
  let browser = null;
  try {
    browser = await chromium.launch({ headless: false });
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const result = await page.evaluate(({ code, spec }) => {
      // eslint-disable-next-line no-new-func
      const fn = new Function('return (' + code + ')')();
      return fn(spec);
    }, { code: INSPECT_INJECT, spec });
    // KEEP the browser open so the user sees the highlight. Recover the counter when the window closes.
    browser.on('disconnected', () => { INSPECT_INFLIGHT = Math.max(0, INSPECT_INFLIGHT - 1); });
    if (result && result.matchedBy) {
      return send(res, 200, 'application/json', JSON.stringify({ ok: true, matchedBy: result.matchedBy, tried: result.tried || [], rect: result.rect || null }));
    }
    return send(res, 200, 'application/json', JSON.stringify({ ok: false, reason: 'element-not-found', tried: (result && result.tried) || [] }));
  } catch (e) {
    // fail soft: headed launch throws with no display → never crash. Close any partial browser + recover.
    if (browser) { try { await browser.close(); } catch (_) {} }
    INSPECT_INFLIGHT = Math.max(0, INSPECT_INFLIGHT - 1);
    return send(res, 200, 'application/json', JSON.stringify({ ok: false, reason: 'headed-browser-unavailable', detail: String((e && e.message) || e).slice(0, 200) }));
  }
}

// ---- per-tool settings API -----------------------------------------------------------------------
// POST /api/settings  { tool, values }  -> save that tool's defaults   ("Save as default")
// POST /api/settings  { tool, reset:1 } -> drop that tool's slot        ("Reset defaults" -> FACTORY)
// Only the 4 known tool keys are writable, and the payload is size-capped: this file is read back on
// every page load, so an unbounded POST would be a self-inflicted DoS on the app's own boot path.
function apiSettings(req, res, body) {
  let o; try { o = JSON.parse(body || '{}'); } catch (e) { return send(res, 400, 'application/json', JSON.stringify({ ok: false, error: 'bad json' })); }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return send(res, 400, 'application/json', JSON.stringify({ ok: false, error: 'bad body' }));
  const tool = String(o.tool || '');
  if (!TOOL_KEYS.includes(tool)) return send(res, 400, 'application/json', JSON.stringify({ ok: false, error: 'unknown tool' }));
  const s = readSettings();
  if (o.reset) { delete s.tools[tool]; }
  else {
    const v = o.values;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return send(res, 400, 'application/json', JSON.stringify({ ok: false, error: 'bad values' }));
    const json = JSON.stringify(v);
    if (json.length > 65536) return send(res, 413, 'application/json', JSON.stringify({ ok: false, error: 'settings too large' }));
    s.tools[tool] = v;
  }
  if (!writeSettings(s)) return send(res, 500, 'application/json', JSON.stringify({ ok: false, error: 'could not write ' + SETTINGS_FILE }));
  return send(res, 200, 'application/json', JSON.stringify({ ok: true, tools: readSettings().tools, file: SETTINGS_FILE }));
}

// ---- report history listing ---------------------------------------------------------------------
// `limit` is the Reports tool's "runs to list" setting (default 60 — the historical hardcoded cap, so
// an absent/!finite value behaves exactly as before). Clamped: the list is rendered in one pass.
function listRuns(limit) {
  const cap = Number.isFinite(+limit) && +limit >= 1 ? Math.min(500, Math.floor(+limit)) : 60;
  if (!fs.existsSync(RUNS)) return [];
  return fs.readdirSync(RUNS).filter(d => !d.startsWith('_') && (() => { try { return fs.statSync(path.join(RUNS, d)).isDirectory(); } catch (_) { return false; } })()).map(id => {
    const dir = path.join(RUNS, id);
    let kind = 'audit', json = 'report.json';
    if (fs.existsSync(path.join(dir, 'visual-match.html'))) { kind = 'visual'; json = 'visual-match.json'; }
    else if (id.includes('-cert-')) { kind = 'cert'; json = 'report.json'; }
    let when = ''; try { when = new Date(fs.statSync(dir).mtimeMs).toISOString().replace('T', ' ').slice(0, 16); } catch (_) {}
    const host = id.replace(/-(vis|cert)-\d+$/, '').replace(/-\d{10,}$/, '');
    return { id, kind, host, when, json, mtime: (() => { try { return fs.statSync(dir).mtimeMs; } catch (_) { return 0; } })() };
  }).sort((a, b) => b.mtime - a.mtime).slice(0, cap);
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
    if (req.method === 'GET' && p === '/api/reports') { let cases = []; try { cases = loadCases(path.join(DATA, 'portfolio.jsonl')); } catch (_) {} return send(res, 200, 'application/json', JSON.stringify({ runs: listRuns(u.searchParams.get('limit')), cases })); }
    if (req.method === 'GET' && p === '/api/status') return send(res, 200, 'application/json', JSON.stringify({ busy: ACTIVE_SCANS > 0, active: ACTIVE_SCANS }));
    if (req.method === 'GET' && p === '/api/notes') return send(res, 200, 'application/json', JSON.stringify({ current: SELF_VER, changelog: CHANGELOG, history: readHistory() }));
    if (req.method === 'GET' && p === '/api/settings') return send(res, 200, 'application/json', JSON.stringify({ ok: true, tools: readSettings().tools, file: SETTINGS_FILE }));
    if (req.method === 'POST' && p === '/api/settings') return apiSettings(req, res, await readBody(req));
    if (req.method === 'GET' && p === '/api/feed-version') return send(res, 200, 'application/json', JSON.stringify({ version: FEED_VERSION, current: SELF_VER }));
    if (req.method === 'GET' && p === '/manual') return send(res, 200, 'text/html; charset=utf-8', MANUAL_HTML || '<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:44px;color:#333">The user manual is not available in this build.</body>');
    if (req.method === 'GET' && p === '/api/diagnostics') { const md = buildDiagnostics(); const fn = 'sgen-site-qa-diagnostics-' + (SELF_VER || 'base') + '-' + new Date().toISOString().slice(0, 10) + '.md'; return send(res, 200, 'application/json', JSON.stringify({ markdown: md, filename: fn })); }

    // Annotate view — generated per request (never a file on disk), so it sits ahead of the
    // static-report prefix loop. Its assets are the run's own shots, served by the shared handler.
    if (req.method === 'GET' && p.startsWith('/annotate/')) {
      const { id, asset } = splitRoute(p, '/annotate');
      if (asset) return await serveAnnotateAsset(res, id, asset, u);
      const doc = annotateDoc(id, { print: u.searchParams.get('print') === '1', onlyAnnotated: u.searchParams.get('only') === 'annotated', exportName: u.searchParams.get('name') });
      if (!doc) return send(res, 404, 'text/plain', 'comparison run not found');
      return send(res, 200, 'text/html; charset=utf-8', doc.html);
    }

    for (const [prefix, file] of [['report', 'report.html'], ['compare', 'comparison.html'], ['visual', 'visual-match.html'], ['certify', 'report.html']]) {
      if (req.method === 'GET' && p.startsWith('/' + prefix + '/')) {
        const { id, asset } = splitRoute(p, '/' + prefix);
        return asset ? serveAsset(res, id, asset) : serveReport(res, id, file, prefix);
      }
    }

    // await async handlers so their rejections are CAUGHT here (a bare `return apiRun()` would let a
    // rejection escape to an unhandled promise rejection — which crashes Node. Stress-test found this.)
    if (req.method === 'GET' && p === '/api/pdf') return await apiPdf(req, res, u);
    if (req.method === 'GET' && p === '/api/annotations') return apiAnnotations(req, res, u, null);
    if (req.method === 'POST' && p === '/api/annotations') return apiAnnotations(req, res, u, await readBody(req));
    if (req.method === 'GET' && p === '/api/annotate-pdf') return await apiAnnotatePdf(req, res, u);
    if (req.method === 'GET' && p === '/api/annotate-pdf-file') return apiAnnotatePdfFile(res, u);
    if (req.method === 'POST' && p === '/api/run') return await apiRun(req, res);
    if (req.method === 'POST' && p === '/api/visual') return await apiVisual(req, res);
    if (req.method === 'POST' && p === '/api/certify') return await apiCertify(req, res);
    if (req.method === 'POST' && p === '/api/inspect') return await apiInspect(req, res);
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
    // maxPages: explicit + honest. `opts.maxPages || 30` treated 0/missing/non-numeric as 30 and
    // diverged from the UI (whose Max-pages default is 1). Missing/invalid ⇒ single-page (1).
    const maxPages = Number.isFinite(+opts.maxPages) && +opts.maxPages >= 1 ? +opts.maxPages : 1;
    // Viewport picker (labels) — filter the render matrix like Visual Comparison; absent/empty ⇒ all.
    const viewports = Array.isArray(opts.viewports) && opts.viewports.length ? opts.viewports : null;
    // collectPages:true + applyAdvisory = the ADVISORY pass. Measured 2026-07-16: this server called
    // runAudit() and NOTHING ELSE, so applyAdvisory() had zero callers and runAudit's collectPages
    // defaulted false — meaning FUNC-008 (content-artifacts), FUNC-009 (spelling), Best Practices and
    // Copy Review were ALL registered, tested, and NEVER EXECUTED in the app. A live sgen.com scan
    // returned 11 suites with no 'best-practices' and no 'copy' at all. Same class as VIS-003, which
    // shipped dead through 3.0.0/3.0.1 while the UI advertised it: a suite that never runs cannot fail
    // a test, so 34/34 green said nothing about it.
    // Advisory suites carry weight 0 and their rows are manual/0-deduction, so this cannot move the
    // SGEN Quality Score — verified by golden parity, not by assertion.
    const raw = await runAudit(url, { maxPages, render: opts.render !== false, renderSample: Math.min(maxPages, 25), viewports, screensDir: path.join(outDir, 'screenshots'), log: () => {}, progress, collectPages: true });
    const data = applyAdvisory(raw);
    emit({ t: 'p', pct: 99, phase: 'writing report' });
    // CHANGE E: auto-compare this scan against the most recent PRIOR recorded scan for this host and
    // embed a "vs previous scan" panel near the top. loadLatestRecord() runs BEFORE recordScan() below,
    // so it returns the previous scan (this one is not in history yet). First scan -> subtle empty state.
    let comparePanel = '';
    try {
      const prior = loadLatestRecord(data.host);
      comparePanel = (prior && prior.data)
        ? renderComparePanel(diff(prior.data, data), { priorCount: prior.count })
        : renderComparePanel(null);
    } catch (e) { comparePanel = ''; }
    // ---- SCOPE: score the operator's selected checks alone -------------------------------------
    // The engine ALWAYS runs every check — scope is a scoring decision, not a skipping one, so the
    // findings, evidence, tallies and launch gate below stay whole-site and a de-scoped check is
    // still visible in the report. Only `quality` is re-derived, with the excluded rules leaving the
    // numerator AND the denominator together (see score.js). Ids are filtered against the registry
    // first, so a stale/junk id from an older settings file cannot silently distort the denominator.
    const excludeRules = (Array.isArray(opts.excludeRules) ? opts.excludeRules : [])
      .filter((id) => typeof id === 'string' && SCOPE_RULE_IDS.has(id));
    let scopePanel = '';
    if (excludeRules.length) {
      data.quality = computeQuality(data.suites, { excludeRules });
      const facts = scopeFacts(data, excludeRules);
      scopePanel = buildScopePanel(facts);
      // Recorded in report.json so the de-scoping is auditable after the fact, not just visible.
      data.scope = {
        excludedRules: facts.excluded, scoredOf: facts.total - facts.excluded.length, scorableTotal: facts.total,
        openDefectsExcluded: facts.openHidden, launchBlockersExcluded: facts.blockersHidden,
        suitesFullyExcluded: facts.fullyOut.map((s) => s.key),
        note: 'Quality score covers the selected checks only. Verdict, tally, checks-passing score and launch readiness remain whole-site.',
      };
    }
    // recordScan() stores verdict/score/tally/suite ROWS — none of which scope touches — so a partial
    // run cannot poison the per-host history or the "vs previous scan" diff with an inflated number.
    renderReport(data, outDir, { comparePanel, scopePanel }); recordScan(data);
    let comparison = false, cmp = null;
    if (opts.save) saveBaseline(data, opts.save);
    if (opts.baseline) { try { const base = loadResult(opts.baseline); base.data._label = opts.baseline; data._label = 'current'; const d = diff(base.data, data); renderCompare(d, outDir); comparison = true; cmp = d.counts; } catch (e) {} }
    emit({ t: 'done', ok: true, id, verdict: data.verdict, score: data.score, tally: data.tally, comparison, cmp,
      quality: data.quality ? data.quality.overall : null, scopedOut: excludeRules.length || 0, scorableTotal: SCOPE_CATALOG.rules.length }); res.end();
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
    // mode is normalized inside visualMatch.run (unknown → like-for-like), so a hand-rolled POST
    // cannot smuggle a third mode past the engine — no second copy of that rule lives here.
    const data = await visualMatch.run(ref, tgt, { maxPages, outDir, viewports: vps, axes: o.axes, warmLoads: o.warmLoads, mode: o.mode, log: () => {}, progress: (pct, phase) => { if (aborted) throw new Error('client-cancelled'); emit({ t: 'p', pct: Math.max(6, Math.min(96, pct || 0)), phase: phase || 'comparing' }); } });
    emit({ t: 'p', pct: 98, phase: 'writing report' });
    renderVisual(data, outDir);
    emit({ t: 'done', ok: true, id, overall: data.overall, pairs: data.pairs, viewports: (data.viewports || []).length, sharp: data.sharp, mode: data.mode }); res.end();
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
// --- self-heal: ensure cross-browser engines (firefox/webkit) are installed --------------
// The desktop shell points PLAYWRIGHT_BROWSERS_PATH at resources/browsers before launching this
// engine, so detection + install both target the folder the app actually reads. Non-blocking:
// the server comes up immediately; the (~200 MB) browser download runs in the background and is
// idempotent (skipped once present), so this is a one-time provision after a fresh engine update.
const ensureEngines = () => {
  let pw;
  try { pw = require('playwright'); } catch (_) { return; }
  const missing = ['firefox', 'webkit'].filter((n) => {
    try { const p = pw[n].executablePath(); return !p || !fs.existsSync(p); } catch (_) { return true; }
  });
  if (!missing.length) { process.stderr.write('[engines] firefox+webkit present\n'); return; }
  const dest = process.env.PLAYWRIGHT_BROWSERS_PATH || '(default cache)';
  process.stderr.write(`[engines] missing ${missing.join('+')} -> background install into ${dest}\n`);
  try {
    // playwright 1.60 does not export './cli.js' in its package "exports" map, so
    // require.resolve('playwright/cli.js') throws ERR_PACKAGE_PATH_NOT_EXPORTED. Resolve the
    // exported package.json and join cli.js next to it instead.
    const cli = path.join(path.dirname(require.resolve('playwright/package.json')), 'cli.js');
    const child = spawn(process.execPath, [cli, 'install', ...missing], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'ignore',
    });
    child.on('exit', (c) => process.stderr.write(`[engines] install exit ${c}\n`));
    child.on('error', (e) => process.stderr.write(`[engines] install error ${e && e.message}\n`));
  } catch (e) { process.stderr.write(`[engines] cannot start install: ${e && e.message}\n`); }
};
ensureEngines();

server.listen(PORT, '127.0.0.1', () => {
  process.stderr.write(`\nSGEN Site QA → http://127.0.0.1:${PORT}\n(4 tools: Site Audit · Visual Comparison · Post-Deployment Check · Reports. Ctrl+C to stop.)\n`);
  if (arg('open', false)) { try { spawn(process.platform === 'win32' ? 'cmd' : 'sh', process.platform === 'win32' ? ['/c', 'start', '', `http://127.0.0.1:${PORT}`] : ['-c', `xdg-open http://127.0.0.1:${PORT}`], { detached: true, stdio: 'ignore' }).unref(); } catch (e) {} }
});
