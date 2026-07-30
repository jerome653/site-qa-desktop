'use strict';
// updater.test.js — the update signal must reach a user who is NOT looking at the window.
//
// WHY THIS FILE EXISTS. The updater had no committed coverage of any kind: it was verified once with a
// throwaway script, which is the same as not being verified — the next edit had nothing to fail against.
// Two defects lived behind that gap. (1) The whole update signal was in-app only, so during the one
// activity this product exists for — a scan that runs for minutes with the window minimised — "an update
// is ready" announced itself to an empty screen. (2) The main process, the ONLY side that can raise an OS
// notification, never learned an update existed: discovery lived in the renderer's own feed poll.
//
// WHAT THIS FILE DOES AND DOES NOT PROVE. These are WIRING assertions read off the shipped sources. They
// prove the choke point is connected, the state set is the narrow one, and the renderer branch the main
// process now drives is live rather than dead. They do NOT prove a toast appears on a real desktop —
// that needs the packaged Electron build and a human looking at the tray. Do not read a pass here as
// "the notification was seen".
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const MAIN = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const SERVE = fs.readFileSync(path.join(ROOT, 'engine', 'sgen-qa-serve.js'), 'utf8');

let pass = 0; const fails = [];
const ok = (cond, name) => { if (cond) pass++; else fails.push(name); };
const has = (src, re, name) => ok(re.test(src), name);

// Body of a top-level `function <name>(...) { ... }` — brace-matched, so an assertion about what a
// function does cannot accidentally match code in a neighbouring one.
function bodyOf(src, name) {
  const i = src.indexOf('function ' + name + '(');
  if (i === -1) return '';
  const start = src.indexOf('{', i);
  let depth = 0;
  for (let j = start; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(start, j + 1); }
  }
  return '';
}

console.log('\nUpdater — the signal has to leave the window\n');

// ── 1. The OS channel exists at all ───────────────────────────────────────────────────────────────
has(MAIN, /require\('electron'\)[\s\S]{0,20}/, 'main.js requires electron');
has(MAIN, /\{[^}]*\bNotification\b[^}]*\}\s*=\s*require\('electron'\)/, 'Notification is imported from electron');
has(MAIN, /app\.setAppUserModelId\(/, 'AppUserModelId is set — without it Windows drops the toast silently, with no error');
has(MAIN, /Notification\.isSupported\(\)/, 'notification support is checked before constructing one');

// ── 2. It is wired to the one choke point every update state passes through ───────────────────────
has(MAIN, /const send = s => \{\s*osNotify\(s\)/, 'send() calls osNotify — every state that reaches the renderer is considered for the OS');
const notify = bodyOf(MAIN, 'osNotify');
ok(notify.length > 0, 'osNotify() is defined');
has(notify, /isFocused\(\)/, 'osNotify stays silent when the window is already focused — the in-app toast has been seen');
has(notify, /isMinimized\(\)/, 'a minimised window still notifies, even though Electron may report it focused');
has(notify, /notified\.(has|add)\(/, 'osNotify dedupes — applyEngineWhenIdle re-sends waiting every 15s');
has(notify, /\.on\('click'/, 'clicking the notification is a way back into the app');
has(notify, /catch/, 'a failed notification can never break the update path');

// ── 3. The state set is NARROW. A notification per poll is how a channel gets muted for good. ─────
const noteMap = (MAIN.match(/const OS_NOTE = \{[\s\S]*?\n\};/) || [''])[0];
ok(noteMap.length > 0, 'OS_NOTE map is defined');
for (const s of ['available', 'downloaded', 'waiting'])
  ok(new RegExp('\\b' + s + ':').test(noteMap), `OS_NOTE notifies on "${s}" — a state that is ABOUT the user`);
for (const s of ['checking', 'downloading', 'none', 'error', 'installing'])
  ok(!new RegExp('\\b' + s + ':').test(noteMap), `OS_NOTE does NOT notify on "${s}" — progress noise stays in-app`);

// ── 4. Main owns DISCOVERY. This is the fact that was missing, not the notification call. ─────────
const poll = bodyOf(MAIN, 'pollAvailability');
ok(poll.length > 0, 'pollAvailability() is defined in the main process');
has(poll, /version\.txt/, 'the poll reads version.txt — the cheap file, not the bundle');
has(poll, /state: 'available'/, "the poll emits 'available', which is what reaches both the OS and the renderer");
ok(!/engine\.zip/.test(poll), 'the poll does NOT download — a ~360KB fetch on a timer spends bandwidth on a decision the user has not made');
ok(!/download\(/.test(poll), 'the poll calls no download()');
has(poll, /app\.isPackaged/, 'the poll is inert in a dev build, like every other update path');
has(poll, /pendingEngine|applyingUpdate|checking/, 'the poll stands down once an update is already in flight');
has(MAIN, /setInterval\(pollAvailability/, 'the poll is scheduled on an interval');
has(MAIN, /setTimeout\(pollAvailability/, 'the first poll is delayed — startServer and first paint come first');

// ── 5. The renderer branch main now drives must be LIVE, not dead code ────────────────────────────
// This is the specific trap this repo has been bitten by before (drift() shipped dead for two releases):
// a handler that exists, reads correctly, and is never reached by anything.
has(SERVE, /p\.state==='available'/, "the renderer handles the 'available' state main now sends");
const availBranch = (SERVE.match(/p\.state==='available'\)\{[^}]*\}/) || [''])[0];
has(availBranch, /has-update/, "the 'available' branch turns the top-bar button red");
has(availBranch, /pulse/, "the 'available' branch pulses the button — solid red in a dark bar is easy to look past");
has(availBranch, /mode='download'/, "the 'available' branch puts the control in download mode");
// ...and that mode is exactly what stands the renderer's own poll down, so the two do not both announce.
has(SERVE, /function autoCheck\(\)\{if\(mode==='install'\|\|mode==='download'\)return;/,
  "autoCheck() early-returns in download mode — main's first announcement stands the renderer's poll down");

// ── 6. The restart claim stays honest ─────────────────────────────────────────────────────────────
// The engine is require()d INTO this process, so activating a new one still relaunches. That is a real
// constraint, not a bug, and the code must not drift into claiming otherwise.
has(MAIN, /app\.relaunch\(\)/, 'applying an update still relaunches — the engine loads into this process');
has(MAIN, /state: 'installing'/, 'the relaunch announces itself rather than looking like a crash');

console.log(fails.length ? `\n❌ FAIL — ${pass} passed, ${fails.length} failed\n` : `\n✅ PASS — ${pass}/${pass} assertions\n`);
for (const f of fails) console.log('   ✗ ' + f);
process.exit(fails.length ? 1 : 0);
