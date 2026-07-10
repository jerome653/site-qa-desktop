'use strict';
// Preload bridge — exposes a tiny, safe update API to the local web UI (contextIsolation on, no Node
// in the page). The engine UI (served from 127.0.0.1) feature-detects window.sgenUpdate: present only
// inside the Electron shell, absent in the plain-browser / CLI build, so the button self-hides there.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sgenUpdate', {
  version: () => ipcRenderer.invoke('app:version'),
  check: () => ipcRenderer.invoke('update:check'),
  download: () => ipcRenderer.invoke('update:download'),
  install: () => ipcRenderer.invoke('update:install'),
  // subscribe to updater lifecycle events: cb({state, version?, percent?, message?})
  onStatus: (cb) => ipcRenderer.on('update:status', (_e, payload) => { try { cb(payload); } catch (_) {} }),
});

// persistent UI flags backed by the shell's userData (survives the per-launch port change that
// resets the page's localStorage). Absent in the plain-browser build -> UI falls back to localStorage.
contextBridge.exposeInMainWorld('sgenApp', {
  getFlag: (k) => ipcRenderer.invoke('ui:getFlag', k),
  setFlag: (k, v) => ipcRenderer.invoke('ui:setFlag', k, v),
});
