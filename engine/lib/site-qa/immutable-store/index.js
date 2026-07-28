'use strict';
// immutable-store/index.js — THE IMMUTABLE STORE (ADR-0008, governed by ADR-0004 §D8).
//
// Shared INFRASTRUCTURE for every append-only, content-addressed, tamper-evident store in the
// platform. Not a store itself — a set of primitives the specialised stores call, so that
// content-addressing, atomic commit and index projection have ONE implementation instead of five.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────────────────────────
// ADR-0004 §D8: "Content-addressing, append-only semantics, rebuildable indexes and integrity
// verification are infrastructure concerns, not application concerns." Measured before this
// extraction, four stores carried their own copies:
//
//   scan-store/digest.js · finding-store/digest.js · regression/digest.js · timeline/digest.js
//     -> canonical() + sha256(), FUNCTIONALLY IDENTICAL in all four (verified empirically over
//        8 value shapes, both functions, before extraction — not by reading them).
//        The files differed only in comments and one temp-variable spelling.
//
//   scan-store/store.js · finding-store/store.js · regression/store.js
//     -> the same temp -> openSync -> writeSync(JSON.stringify(rec, null, 2)) -> fsyncSync ->
//        closeSync -> renameSync commit, and the same `appendFileSync(JSON.stringify(x) + '\n')`
//        manifest append, written out three times.
//
// A fifth (evidence-ledger, ADR-0007) was already importing sha256 from finding-store/digest —
// infrastructure reaching into an unrelated store because there was nowhere else for it to live.
// That is the smell this module removes.
//
// ── WHAT IT DELIBERATELY DOES NOT DO ─────────────────────────────────────────────────────────────
// No replay. No collections. No scoring. No reporting. No registry access. No provider logic. No
// business rules. It performs filesystem persistence — which IS an infrastructure concern — but it
// makes NO POLICY DECISIONS: what a record contains, which indexes exist, what counts as damage and
// what may be recovered all stay with the store that owns that meaning. This module knows how to
// write bytes durably and how to hash them, and nothing else.
//
// Determinism: same value -> same canonical bytes -> same digest, on any machine, forever. No clock
// is read here; a timestamp is always supplied by the caller.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ── content addressing ───────────────────────────────────────────────────────────────────────────
// canonical JSON: object keys sorted recursively; no whitespace. Stable across runs/machines.
// MOVED here verbatim from the four store copies — the behaviour is the union of what they all did,
// which is possible precisely because they were identical.
function canonical(v) {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
}

function sha256(input) {
  const s = typeof input === 'string' ? input : canonical(input);
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

// ── durable, crash-safe record commit ────────────────────────────────────────────────────────────
// temp -> fsync -> rename. A crash before the rename leaves only a `.tmp`, never a half-written
// record. The serialisation (`JSON.stringify(record, null, 2)`) is part of the contract, not a
// preference: it is the exact form the existing stores wrote, so extracting it preserves their bytes.
function writeRecordAtomic(filePath, record) {
  const tmp = filePath + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeSync(fd, JSON.stringify(record, null, 2)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(tmp, filePath);
  return filePath;
}

// ── append-only journals (manifest + indexes) ────────────────────────────────────────────────────
// The manifest append IS the commit marker: the record file exists first, then the store declares it.
// appendLine takes an object because every caller appended exactly `JSON.stringify(obj) + '\n'`.
function appendLine(filePath, obj) {
  fs.appendFileSync(filePath, JSON.stringify(obj) + '\n');
  return filePath;
}
// appendLines takes ALREADY-SERIALISED lines: the index projections build their own line strings, and
// re-serialising them here would change bytes. Infrastructure carries the write, not the shape.
function appendLines(filePath, lines) {
  if (!lines || !lines.length) return filePath;
  fs.appendFileSync(filePath, lines.join('\n') + '\n');
  return filePath;
}

// ── reads ────────────────────────────────────────────────────────────────────────────────────────
// A missing journal is an empty journal, never a throw: a store that has not written yet is a valid
// state, and treating it as an error is how a first run looks like a corrupt one.
function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean).map(l => {
    try { return JSON.parse(l); } catch (_) { return null; }   // a torn tail line is dropped, never fatal
  }).filter(Boolean);
}
function readRecord(filePath) {
  return fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : null;
}
function exists(filePath) { return fs.existsSync(filePath); }
function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); return dir; }

// ── RecordStore — the layout every store shares ──────────────────────────────────────────────────
// storage/ for immutable records · indexes/ for rebuildable projections · manifest.jsonl for the
// append-only commit log. Provided so a NEW store (ADR-0008's stated goal: "Collection Store becomes
// essentially configuration") is a subclass with a record shape, not another implementation.
//
// The four legacy stores are NOT reparented onto this class in this ADR — see the ADR's Consequences.
// They now call the primitives above, which is what removes the duplication; changing the class
// hierarchy of four certified stores would be a second, riskier change with no additional payoff, and
// this ADR's success criterion is byte-identical behaviour.
class RecordStore {
  constructor(root, { storageDirName = 'storage', indexDirName = 'indexes', manifestName = 'manifest.jsonl' } = {}) {
    this.root = root;
    this.storageDir = path.join(root, storageDirName);
    this.indexDir = path.join(root, indexDirName);
    this.manifestPath = path.join(root, manifestName);
    ensureDir(this.storageDir);
    ensureDir(this.indexDir);
  }
  recordPath(id) { return path.join(this.storageDir, id + '.json'); }
  indexPath(name) { return path.join(this.indexDir, name + '.jsonl'); }
  has(id) { return exists(this.recordPath(id)); }
  get(id) { return readRecord(this.recordPath(id)); }
  manifest() { return readJsonl(this.manifestPath); }
  // commit(id, record, manifestLine) — the whole durable write, in the one correct order.
  commit(id, record, manifestLine) {
    writeRecordAtomic(this.recordPath(id), record);
    appendLine(this.manifestPath, manifestLine);
    return id;
  }
}

module.exports = {
  canonical, sha256,
  writeRecordAtomic, appendLine, appendLines,
  readJsonl, readRecord, exists, ensureDir,
  RecordStore,
};
