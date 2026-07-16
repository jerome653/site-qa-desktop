# SGEN Site QA — Developer Handoff

Everything you need to **continue development on another machine** (laptop, etc.).
Last updated 2026-07-10. Current shipped state: **shell 2.5.3**, **engine 2.5.4** (on the update feed).

---

## 1. What this project is

A **Windows desktop app** (`SGEN Site QA`) that audits websites. It is split into two parts:

- **Shell** — a thin Electron wrapper (`main.js` + `preload.js`). Ships once via an installer. Rarely changes.
- **Engine** — the actual QA code + web UI (`engine/sgen-qa-serve.js` + `engine/lib/`). This is what changes almost every release.

The clever part: the engine **hot-updates itself**. A new engine is a ~370 KB zip fetched from a GitHub Releases feed, verified, and swapped in on the next launch — no reinstall. Only rare shell changes need a new installer.

```
  ┌─────────────────────────── the installed app ───────────────────────────┐
  │  Electron shell (main.js)                                                │
  │    ├─ starts the engine IN-PROCESS  (require engine/sgen-qa-serve.js)     │
  │    ├─ opens a window on http://127.0.0.1:<random-port>                    │
  │    └─ engine deps (playwright, sharp) + bundled Chromium live in the shell│
  │                                                                          │
  │  Engine (hot-swappable)                                                  │
  │    active = userData/engines/<ver>/  (if newer)  else  bundled base      │
  └──────────────────────────────────────────────────────────────────────────┘
                 ▲ downloads engine.zip from ▼
     GitHub Releases: jerome653/migration-qa,  tag "engine-latest"
       assets:  version.txt  ·  engine.zip  ·  engine.zip.sha256
```

---

## 2. Folder map (`D:\AI\_dist\siteqa-app`)

| Path | What it is | In git? |
|------|-----------|:---:|
| `main.js` | Electron shell — in-process engine, hot-update logic, window | ✅ |
| `preload.js` | safe bridge (`window.sgenUpdate`, `window.sgenApp`) | ✅ |
| `package.json` | shell version + electron-builder config | ✅ |
| `publish-engine.ps1` | **publishes an engine hot-update** to the feed | ✅ |
| `smoke.js` | `npm run smoke` — 7-check engine-integration test | ✅ |
| `build/icon.ico` | app icon | ✅ |
| `DEV-HANDOFF.md` | this file | ✅ |
| `engine/sgen-qa-serve.js` | the web UI + all 4 tools + API | ✅ |
| `engine/lib/**` | audit engine, rules, report renderer, manual.html | ✅ |
| `engine/package.json` | engine deps (playwright, sharp) | ✅ |
| `engine/node_modules/` | installed engine deps | ❌ `npm install` |
| `browsers/` | **bundled Chromium ~685 MB** | ❌ repopulate (see §4) |
| `node_modules/` | shell deps | ❌ `npm install` |
| `release/`, `dist-share/` | build outputs | ❌ regenerated |
| `sgen/` | runtime scan data / reports | ❌ |

> 🔴 **REVERSED as of 2026-07-16 — this used to say the opposite, and following the old text would
> revert a week of fixes.** `jerome653/migration-qa` is now the **engine source of truth**; the
> `engine/` folder here is a **stale 2.1.0 seed** kept only as the pre-first-update fallback that
> ships inside the installer.
>
> Measured 2026-07-16: `siteqa-app/engine/package.json` = **2.1.0** · `jerome653/migration-qa` `main`
> = **3.1.0** (`727df67`) · published feed `version.txt` = **3.1.0** · installed `active.json` = **3.1.0**.
> The published payload and `main` are byte-identical (`diff -r --strip-trailing-cr` → 0 content
> differences). **Building an engine from `siteqa-app/engine` would ship 2.1.0 and silently undo
> v2 scoring, the font/icon rules, render honesty, and the save-baseline false-data fix.**
>
> **Do engine work in `jerome653/migration-qa`. Touch `engine/` here only to refresh the seed.**

---

## 3. Push everything to git (from THIS machine)

The repo is already `git init`'d with a `.gitignore` that keeps out `node_modules`, `browsers/`, and build outputs (so only ~a few MB of source travels).

```bash
# 1. create an empty GitHub repo (via github.com, or gh CLI):
gh repo create docssgen-admin/site-qa-desktop --private
#    …or make it on github.com and copy its URL.

# 2. from D:\AI\_dist\siteqa-app  (Git Bash — Windows path with cd /d works, or just open here):
git add .
git commit -m "SGEN Site QA desktop — shell 2.5.3 + engine 2.5.4"
git branch -M main
git remote add origin https://github.com/docssgen-admin/site-qa-desktop.git
git push -u origin main
```

> Tip in this session's environment: prefix a command with `!` to run it in the terminal
> (e.g. `! git -C D:/AI/_dist/siteqa-app push -u origin main`) so its output lands here.

---

## 4. Set up on a new machine (the laptop)

Prereqs: **Node 18+** (Node 24 used here) and **Git**.

```bash
# 1. clone
git clone https://github.com/docssgen-admin/site-qa-desktop.git
cd site-qa-desktop

# 2. install shell + engine deps
npm install
cd engine && npm install && cd ..

# 3. get the bundled Chromium (playwright pins the exact revision — chromium-1223 for playwright 1.60)
cd engine && npx playwright install chromium ffmpeg && cd ..
#    then copy Playwright's browser cache into ./browsers so the installer can bundle it:
#    (PowerShell)
#    New-Item -ItemType Directory -Force browsers | Out-Null
#    Copy-Item "$env:LOCALAPPDATA\ms-playwright\*" browsers\ -Recurse -Force

# 4. sanity check
npm run smoke                                   # 7/7 expected
node engine/lib/site-qa/testing/run-all.js      # 24/24 suites expected
```

**GitHub token** (only needed to *publish* updates): `publish-engine.ps1` reads it from the Git credential store (`git credential fill`, host github.com). On the laptop, sign in to GitHub via Git Credential Manager once (or store a PAT) and it just works — the token is never printed.

---

## 5. Day-to-day development

```bash
# run the engine + UI in a browser (fast iteration, no Electron):
node engine/sgen-qa-serve.js --port 7878 --open

# run the full desktop app in dev:
npm start
```

Most work is in **`engine/sgen-qa-serve.js`** (the whole UI + API) and **`engine/lib/site-qa/report.js`** (the report renderer / STYLE). After editing, re-run the smoke test.

---

## 6. Ship a change

### An engine change (99% of the time) — hot update, no reinstall
```bash
# bump the version number you publish, then:
pwsh -File publish-engine.ps1 -Version 2.5.5
```
This zips `engine/` (JS only), uploads `engine.zip` + `version.txt` + `.sha256` to the `engine-latest` release, and every installed app picks it up (button turns red → Restart). **That's it.**

### A shell change (rare — main.js / preload / electron config)
```bash
# bump "version" in package.json to match, then build the installer:
npm run dist
#   -> release/SGEN Site QA Setup <ver>.exe   (self-contained, ~296 MB)
```
Users install this **once** (uninstall the old copy first — a fresh install avoids the old NSIS "cannot be closed" bug). After that they hot-update forever. Keep the shell's `package.json` version == the latest engine version so a fresh install isn't immediately "out of date".

---

## 7. Gotchas worth knowing (hard-won)

- **CSS flex trap:** the report STYLE has a global `input[type=text],select{width:100%}` and `.row{width:100%}`. When you put an input/select/`.row` inside a flex row, it will hijack all the width — add `width:auto` explicitly. (Bit us twice.)
- **Hot engine dep resolution:** a hot engine is JS-only; `main.js` drops a `node_modules` junction beside it + patches `Module._resolveFilename` so `require('playwright')` resolves from the shell's deps. `NODE_PATH` does **not** work in a packaged Electron main — don't use it.
- **Updates are manual-apply:** the engine auto-*checks* the feed (button turns red + toast) but never downloads/installs without a click. Keep it that way.
- **Single-user concurrency:** the engine is single-threaded; don't fire dozens of concurrent scans (each garbage-URL scan hangs on network). Real use is one scan at a time — fine.
- **First shell transition:** upgrading an *old* installed version in place hits the legacy NSIS close-check. Always uninstall old → fresh install for the one-time switch.
- **Publishing:** `electron-builder --publish` creates a **draft** release by default; `publish-engine.ps1` avoids electron-builder entirely and writes the assets directly (no draft issue).

---

## 8. Current state (2026-07-10)

- Feed (`engine-latest/version.txt`): **2.5.4**
- Shell installer: **2.5.3** (in `release/`, and the distribution zip `D:\AI\_dist\SGEN-Site-QA-2.5.3.zip`)
- Test status: 24/24 suites · smoke 7/7 · stress green
- Recent features: hot-update engine, grouped/searchable Reports, clickable score tiles + colour legend, pass/fail-vs-quality clarity, evidence-whitespace trim, settings persistence, in-app Manual (dark), diagnostics export, hidden scrollbars, refreshed walkthrough.
