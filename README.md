# Site Audit — Desktop App

The Site Audit platform (v2.0.0) wrapped as a double-click Windows desktop app for non-technical
users. Everything runs locally — nothing leaves the machine. Bundles the certified engine + Playwright
Chromium, so audits (including browser render) work offline with no separate install.

## Run it (three ways)

1. **Packaged app (ready now):** `release/win-unpacked/Site Audit.exe` — double-click. Self-contained;
   share by zipping the `win-unpacked` folder (~981 MB, includes Chromium).
2. **Dev mode:** `npm start` (needs `npm install` first).
3. **Installer (.exe):** `npm run dist` — builds an NSIS one-click installer. **Requires Windows
   Developer Mode enabled** (Settings → Privacy & security → For developers) OR an elevated terminal,
   because electron-builder's signing cache extracts symlinks that need symlink privilege. Without it the
   `--dir` (packaged folder) build still succeeds; only the single-file installer needs the privilege.

## What it is

- `main.js` — Electron shell: starts the engine (`engine/sgen-qa-serve.js`) as a child on a free
  127.0.0.1 port, opens a window on it, stops the engine on quit. Engine is UNCHANGED — shell only.
- `engine/` — the certified `_dist` package (site-qa + migration-qa engine + node_modules: playwright,
  sharp). Shipped verbatim via `extraResources` (electron-builder prunes nested node_modules from `files`,
  so extraResources is used to keep the engine's deps intact).
- `browsers/` — Playwright Chromium rev 1223 (+ headless-shell, ffmpeg), so render audits work offline.
  main.js sets `PLAYWRIGHT_BROWSERS_PATH` to this bundle.

## Verification (all passed on this build)

- `npm run smoke` — engine-integration smoke (boots, serves, survives malformed requests, runs an audit,
  stops cleanly): PASS.
- Packaged-app end-to-end: server boots on a free port, UI served, **real render audit via the bundled
  Chromium** completed (verdict + score returned): PASS.

## Rebuild the engine from a new `_dist` release

```
# from repo root, after _dist is updated + re-certified
cp _dist/migration-qa/sgen-qa-serve.js _dist/migration-qa/package.json siteqa-app/engine/
cp -r _dist/migration-qa/lib siteqa-app/engine/lib
cd siteqa-app/engine && npm install --omit=dev
cd .. && npm run dist   # or: npx electron-builder --win --dir  (folder only, no installer)
```
