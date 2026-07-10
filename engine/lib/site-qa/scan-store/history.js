'use strict';
// history.js — lineage over the immutable store. Lineage is expressed by parentScanId links
// (an explicit chain) AND by timestamp order within a target (implicit chronology). Both are pure
// reads over records/manifest — history never mutates anything.
const { ScanStore } = require('./store');

function asStore(storeOrRoot) {
  return storeOrRoot instanceof ScanStore ? storeOrRoot : new ScanStore(storeOrRoot);
}

// All scans for a target, oldest → newest (stable: timestamp, then scanId).
function chronology(store, targetOrDigest, byDigest) {
  store = asStore(store);
  const ids = byDigest ? store.query('by-target', targetOrDigest) : store.byTarget(targetOrDigest);
  const recs = ids.map(id => store.get(id)).filter(Boolean);
  recs.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || '') || a.scanId.localeCompare(b.scanId));
  return recs;
}

// Explicit ancestry via parentScanId, from the given scan up to its root.
function ancestors(store, scanId) {
  store = asStore(store);
  const chain = [];
  const seen = new Set();
  let rec = store.get(scanId);
  while (rec && rec.parentScanId && !seen.has(rec.parentScanId)) {
    seen.add(rec.parentScanId);
    const parent = store.get(rec.parentScanId);
    if (!parent) break;
    chain.push(parent);
    rec = parent;
  }
  return chain; // nearest parent first
}

// Direct children (scans whose parentScanId === scanId).
function children(store, scanId) {
  store = asStore(store);
  return store.manifest().filter(m => m.parent === scanId).map(m => store.get(m.scanId)).filter(Boolean);
}

// Full lineage view for one scan.
function lineage(store, scanId) {
  store = asStore(store);
  const rec = store.get(scanId);
  if (!rec) return null;
  const chrono = chronology(store, rec.targetDigest, true);
  const idx = chrono.findIndex(r => r.scanId === scanId);
  const anc = ancestors(store, scanId);
  return {
    scanId,
    self: rec,
    parent: rec.parentScanId ? store.get(rec.parentScanId) : null,
    children: children(store, scanId),
    ancestors: anc,
    root: anc.length ? anc[anc.length - 1] : rec,
    previous: idx > 0 ? chrono[idx - 1] : null,       // chronological (per target)
    next: idx >= 0 && idx < chrono.length - 1 ? chrono[idx + 1] : null,
    first: chrono[0] || null,
    latest: chrono[chrono.length - 1] || null,
    position: idx,
    total: chrono.length,
  };
}

// Latest scan for a target (by chronology).
function latestForTarget(store, target) {
  const chrono = chronology(store, target, false);
  return chrono[chrono.length - 1] || null;
}

module.exports = { chronology, ancestors, children, lineage, latestForTarget };
