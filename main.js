'use strict';
// SGEN Site QA — Electron desktop shell.
//
// Architecture (why updates are reliable): the app is split into a STABLE shell and a VOLATILE engine.
//   • Shell  = Electron + Chromium + the engine's node_modules (playwright/sharp) + browsers. Installed
//              once via NSIS; changes rarely.
//   • Engine = the QA code + web UI (sgen-qa-serve.js + lib/), a ~1MB bundle of pure JS. This is the part
//              that actually changes release to release (reports, viewports, rules, consent).
// The engine runs IN THIS process (no child) and can be HOT-UPDATED: a newer engine bundle is fetched from
// the GitHub Releases feed (tag "engine-latest"), verified, extracted to userData, and loaded on the next
// launch. An update is therefore a tiny download + a relaunch — never the ~865MB NSIS reinstall whose
// app-running close-check kept failing. The engine's heavy deps always resolve from the shell's bundled
// node_modules via NODE_PATH, so the hot bundle stays pure JS.
const { app, BrowserWindow, shell, dialog, Menu, ipcMain } = require('electron');
const log = require('electron-log');            // update logs -> %APPDATA%\SGEN Site QA\logs\main.log
try { log.transports.file.level = 'info'; } catch (_) {}
const https = require('https');
const http = require('http');
const net = require('net');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const Module = require('module');

const isPackaged = app.isPackaged;
// Bundled BASE engine that ships with the shell (fallback + the source of the shared node_modules).
const ENGINE_BASE = isPackaged
  ? (fs.existsSync(path.join(process.resourcesPath, 'app.asar.unpacked', 'engine', 'sgen-qa-serve.js'))
      ? path.join(process.resourcesPath, 'app.asar.unpacked', 'engine')
      : path.join(process.resourcesPath, 'engine'))
  : path.join(__dirname, 'engine');
const ENGINE_DEPS = path.join(ENGINE_BASE, 'node_modules');   // playwright/sharp/... — every engine uses these
const BROWSERS = isPackaged ? path.join(process.resourcesPath, 'browsers') : path.join(__dirname, 'browsers');

// Hot-update layout: extracted engine bundles live under userData/engines/<version>/, active.json points
// at the current one. Persists across shell reinstalls.
const ENGINES_DIR = path.join(app.getPath('userData'), 'engines');
const ACTIVE_JSON = path.join(ENGINES_DIR, 'active.json');
const BASE_VERSION = app.getVersion();                        // engine base ships with the shell => same version
const ENGINE_TAG = 'engine-latest';
// Owner is jerome653 — the repo's CURRENT home. Do NOT "restore" docssgen-admin: that path only still
// works because GitHub kept a permanent owner-redirect after the transfer (measured 2026-07-16:
// docssgen-admin/... -> 301 -> jerome653/... -> 302 -> release-assets -> 200). GitHub RETIRES that
// redirect the instant the old path is re-registered, and every install pointed at it would then
// silently poll a repo we do not control — a hijackable update channel, with no error surfaced.
const FEED_BASE = 'https://github.com/jerome653/migration-qa/releases/download/' + ENGINE_TAG;

let win = null, PORT = 0;

// A hot engine extracted to userData is JS-only; its bare requires (playwright/sharp/...) must resolve
// from the shell's bundled node_modules. Belt-and-suspenders, because NODE_PATH is NOT honored inside a
// packaged Electron main (it silently fails): (1) linkDeps drops a node_modules JUNCTION beside the
// bundle so normal walk-up resolution finds the shell's deps; (2) this resolver hook retries any bare
// specifier against ENGINE_DEPS if normal resolution throws.
const _resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  try { return _resolveFilename.call(this, request, parent, isMain, options); }
  catch (err) {
    if (request && request[0] !== '.' && request[0] !== '/' && request[1] !== ':') {
      try { return _resolveFilename.call(this, request, parent, isMain, Object.assign({}, options, { paths: [ENGINE_DEPS] })); } catch (_) {}
    }
    throw err;
  }
};
function linkDeps(dir) {
  const nm = path.join(dir, 'node_modules');   // <hot engine>/node_modules -> shell deps (Windows junction, no admin)
  try { if (!fs.existsSync(nm)) fs.symlinkSync(ENGINE_DEPS, nm, 'junction'); } catch (_) {}
}

// ---------- engine selection ----------
function semverGt(a, b) {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) > (pb[i] || 0)) return true; if ((pa[i] || 0) < (pb[i] || 0)) return false; }
  return false;
}
function readActive() {
  try {
    const a = JSON.parse(fs.readFileSync(ACTIVE_JSON, 'utf8'));
    if (a && a.dir && a.version && fs.existsSync(path.join(a.dir, 'sgen-qa-serve.js'))) return a;
  } catch (_) {}
  return null;
}
// The active engine, unless the bundled base is newer (e.g. after a shell reinstall) — base always wins ties.
function activeEngineDir() {
  const a = readActive();
  if (a && !semverGt(BASE_VERSION, a.version) && a.version !== BASE_VERSION) return { dir: a.dir, version: a.version };
  if (a && a.version === BASE_VERSION) return { dir: a.dir, version: a.version };
  return { dir: ENGINE_BASE, version: BASE_VERSION };
}
function loadEngine(dir) {
  require(path.join(dir, 'sgen-qa-serve.js'));   // starts the engine HTTP server on 127.0.0.1:PORT in-process
}

// ---------- local server plumbing ----------
function freePort() {
  return new Promise((res, rej) => { const s = net.createServer(); s.unref(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}
function waitForServer(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    (function poll() {
      const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1500 }, r => { r.resume(); resolve(true); });
      req.on('error', () => { if (Date.now() > deadline) reject(new Error('server did not start')); else setTimeout(poll, 250); });
      req.on('timeout', () => { req.destroy(); if (Date.now() > deadline) reject(new Error('server timeout')); else setTimeout(poll, 250); });
    })();
  });
}
async function startServer() {
  PORT = await freePort();
  process.env.SGEN_QA_PORT = String(PORT);
  if (fs.existsSync(BROWSERS)) process.env.PLAYWRIGHT_BROWSERS_PATH = BROWSERS;   // packaged Chromium
  const eng = activeEngineDir();
  try {
    if (eng.dir !== ENGINE_BASE) linkDeps(eng.dir);   // ensure a hot engine's deps junction exists
    loadEngine(eng.dir);
    log.info('[engine] loaded ' + eng.version + ' from ' + eng.dir);
  } catch (e) {
    // a corrupt hot engine must never brick the app — drop the pointer and fall back to the bundled base
    log.error('[engine] hot engine failed to load, falling back to base', e);
    try { fs.unlinkSync(ACTIVE_JSON); } catch (_) {}
    loadEngine(ENGINE_BASE);
  }
  await waitForServer(PORT, 30000);
}
function createWindow() {
  win = new BrowserWindow({
    width: 1360, height: 900, minWidth: 900, minHeight: 600, backgroundColor: '#000000',
    title: 'SGEN Site QA', show: false, icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, 'preload.js') },
  });
  Menu.setApplicationMenu(null);
  win.loadURL('http://127.0.0.1:' + PORT + '/');
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url) && url.indexOf('127.0.0.1:' + PORT) < 0) { shell.openExternal(url); return { action: 'deny' }; } return { action: 'allow' }; });
}

// ---------- HTTP helpers (engine bundle fetch) ----------
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'sgen-site-qa' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { res.resume(); return resolve(httpsGet(res.headers.location)); }
      resolve(res);
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('timeout')));
  });
}
function fetchText(url) {
  return httpsGet(url).then(res => new Promise((resolve, reject) => {
    if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
    let b = ''; res.setEncoding('utf8'); res.on('data', c => b += c); res.on('end', () => resolve(b));
  }));
}
function download(url, dest) {
  return httpsGet(url).then(res => new Promise((resolve, reject) => {
    if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
    const f = fs.createWriteStream(dest);
    res.pipe(f); f.on('finish', () => f.close(() => resolve(dest))); f.on('error', reject); res.on('error', reject);
  }));
}
function sha256File(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256'); const s = fs.createReadStream(p);
    s.on('data', d => h.update(d)); s.on('end', () => resolve(h.digest('hex'))); s.on('error', reject);
  });
}
function extractZip(zip, destDir) {
  // Windows-only app → PowerShell Expand-Archive, no extra runtime dependency.
  return new Promise((resolve, reject) => {
    fs.mkdirSync(destDir, { recursive: true });
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      "Expand-Archive -LiteralPath '" + zip.replace(/'/g, "''") + "' -DestinationPath '" + destDir.replace(/'/g, "''") + "' -Force"],
      { windowsHide: true }, err => err ? reject(err) : resolve(destDir));
  });
}

// ---------- in-app engine updater ----------
// Checks the feed's version.txt (tiny). If newer, downloads engine.zip, verifies its sha256, extracts to
// userData, then activates + relaunches when the engine is idle (never mid-audit). No NSIS, no admin.
let checking = false, applyingUpdate = false, pendingEngine = null;
const send = s => { try { if (win && !win.isDestroyed()) win.webContents.send('update:status', s); } catch (_) {} };

async function checkEngineUpdate() {
  if (checking) return { state: 'checking' };
  if (pendingEngine) { applyEngineWhenIdle(); return { state: 'downloaded', version: pendingEngine.version }; }
  checking = true; send({ state: 'checking' });
  try {
    const remote = (await fetchText(FEED_BASE + '/version.txt')).trim();
    const cur = activeEngineDir().version;
    if (!remote || !semverGt(remote, cur)) { send({ state: 'none' }); return { state: 'none', version: cur }; }
    send({ state: 'downloading', percent: 0, version: remote });
    const tmp = path.join(os.tmpdir(), 'sgen-engine-' + remote + '.zip');
    await download(FEED_BASE + '/engine.zip', tmp);
    let want = '';
    try { want = (await fetchText(FEED_BASE + '/engine.zip.sha256')).trim().split(/\s+/)[0].toLowerCase(); } catch (_) {}
    const got = (await sha256File(tmp)).toLowerCase();
    if (want && want !== got) throw new Error('checksum mismatch — download not applied');
    const outDir = path.join(ENGINES_DIR, remote);
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch (_) {}
    await extractZip(tmp, outDir);
    let root = outDir;   // tolerate a wrapping engine/ folder inside the zip
    if (!fs.existsSync(path.join(root, 'sgen-qa-serve.js')) && fs.existsSync(path.join(root, 'engine', 'sgen-qa-serve.js'))) root = path.join(root, 'engine');
    if (!fs.existsSync(path.join(root, 'sgen-qa-serve.js'))) throw new Error('engine bundle is missing sgen-qa-serve.js');
    linkDeps(root);                              // node_modules junction -> shell deps (so the hot engine loads)
    try { fs.unlinkSync(tmp); } catch (_) {}
    pendingEngine = { version: remote, dir: root };
    log.info('[engine] downloaded ' + remote + ' -> ' + root);
    send({ state: 'downloaded', version: remote });   // UI shows "Restart to update"; user applies it manually
    return { state: 'downloaded', version: remote };
  } catch (e) {
    log.error('[engine] update check failed', e);
    send({ state: 'error', message: String(e && e.message || e) });
    return { state: 'error', message: String(e && e.message || e) };
  } finally { checking = false; }
}
function applyEngineWhenIdle() {
  if (applyingUpdate || !pendingEngine) return; applyingUpdate = true;
  (function tick() {
    engineBusy().then(busy => {
      if (busy) { setTimeout(tick, 15000); return; }        // audit running → wait, never swap mid-scan
      try {
        fs.mkdirSync(ENGINES_DIR, { recursive: true });
        fs.writeFileSync(ACTIVE_JSON, JSON.stringify(pendingEngine));
        log.info('[engine] activating ' + pendingEngine.version + ' -> relaunch');
        send({ state: 'installing', version: pendingEngine.version });
        setTimeout(() => { app.relaunch(); app.exit(0); }, 500);   // clean restart onto the new engine
      } catch (e) { applyingUpdate = false; log.error('[engine] activate failed', e); }
    }).catch(() => setTimeout(tick, 15000));
  })();
}
// Is a scan streaming right now? Ask the engine. Unreachable/parse-fail → treat as idle.
function engineBusy() {
  return new Promise(resolve => {
    if (!PORT) return resolve(false);
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/status', timeout: 2000 }, r => {
      let b = ''; r.on('data', c => b += c); r.on('end', () => { try { resolve(!!JSON.parse(b).busy); } catch (_) { resolve(false); } });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function wireIpc() {
  ipcMain.handle('app:version', () => activeEngineDir().version);
  ipcMain.handle('update:check', async () => {
    if (!app.isPackaged) return { state: 'dev', message: 'Updates apply only in the installed build.' };
    return await checkEngineUpdate();
  });
  // legacy channels kept so the existing UI keeps working
  ipcMain.handle('update:download', async () => await checkEngineUpdate());
  ipcMain.handle('update:install', () => { if (pendingEngine) applyEngineWhenIdle(); return { ok: true }; });

  // persistent UI flags (userData, not localStorage — the engine's 127.0.0.1 origin changes each launch)
  const stateFile = path.join(app.getPath('userData'), 'ui-state.json');
  const readState = () => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (_) { return {}; } };
  ipcMain.handle('ui:getFlag', (_e, k) => { const v = readState()[k]; return v == null ? null : v; });
  ipcMain.handle('ui:setFlag', (_e, k, v) => {
    const s = readState(); s[k] = v;
    try { fs.mkdirSync(path.dirname(stateFile), { recursive: true }); fs.writeFileSync(stateFile, JSON.stringify(s)); } catch (_) {}
    return true;
  });
}

app.whenReady().then(async () => {
  try { await startServer(); createWindow(); wireIpc(); }
  catch (e) { dialog.showErrorBox('SGEN Site QA — startup failed', String(e && e.message || e)); app.quit(); }
  // Updates are MANUAL: nothing is checked, downloaded, or applied unless the user clicks the update
  // control (ipc update:check -> download+stage, update:install -> relaunch). No auto-check on launch.
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { app.quit(); });
process.on('uncaughtException', e => { try { process.stderr.write('[shell] ' + (e && e.stack || e) + '\n'); } catch (_) {} });
