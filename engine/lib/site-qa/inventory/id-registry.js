'use strict';
// id-registry.js — stable inventory identifiers (frozen spec, governance req #1).
// Every inventory item gets a stable ID (PAGE-001, ASSET-001, GLOBAL-001…). Stability comes from an
// append-only map of identityKey → ID: the FIRST time a logical object is seen it mints the next ID for
// its type; every run thereafter reuses it. So "Header" stays GLOBAL-001 across runs — every future
// system (visual comparison, evidence, history, regression, certification, reports) refers to the same
// logical object instead of rediscovering it differently. In-memory by default; optional JSONL persist.
const fs = require('fs');
const path = require('path');

const PREFIX = { page: 'PAGE', section: 'SECTION', component: 'COMP', global: 'GLOBAL', asset: 'ASSET', form: 'FORM', behavior: 'BEHAVIOR' };

class IdRegistry {
  constructor(persistPath) {
    this.persistPath = persistPath || null;
    this.map = new Map();        // identityKey → id
    this.counter = {};           // prefix → highest N used
    if (this.persistPath) {
      fs.mkdirSync(path.dirname(this.persistPath), { recursive: true }); // ensure the dir exists before append
      if (fs.existsSync(this.persistPath)) this._load();
    }
  }
  _load() {
    for (const line of fs.readFileSync(this.persistPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let e; try { e = JSON.parse(line); } catch (_) { continue; }
      this.map.set(e.identityKey, e.id);
      const n = parseInt(String(e.id).split('-')[1], 10);
      const p = String(e.id).split('-')[0];
      if (!isNaN(n)) this.counter[p] = Math.max(this.counter[p] || 0, n);
    }
  }
  prefixFor(type) { const p = PREFIX[type]; if (!p) throw new Error('unknown inventory type: ' + type); return p; }
  // Return the stable ID for (type, identityKey); mint + persist on first sight.
  mint(type, identityKey) {
    if (this.map.has(identityKey)) return this.map.get(identityKey);
    const prefix = this.prefixFor(type);
    const n = (this.counter[prefix] || 0) + 1;
    this.counter[prefix] = n;
    const id = prefix + '-' + String(n).padStart(3, '0');
    this.map.set(identityKey, id);
    if (this.persistPath) fs.appendFileSync(this.persistPath, JSON.stringify({ prefix, type, identityKey, id }) + '\n');
    return id;
  }
  has(identityKey) { return this.map.has(identityKey); }
  get(identityKey) { return this.map.get(identityKey) || null; }
  size() { return this.map.size; }
}

module.exports = { IdRegistry, PREFIX };
