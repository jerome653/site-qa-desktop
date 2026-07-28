'use strict';
// evidence-ledger/index.js — THE EVIDENCE LEDGER (ADR-0007, governed by ADR-0004).
//
// Artifacts (screenshots, diffs, captures) become CONTENT-ADDRESSED records with stable ids, identical
// bytes collapse onto one artifact, and findings reference an artifact by id instead of by a filename
// that means nothing once the run directory moves.
//
// ── THIS WIRES EXISTING MACHINERY; IT DOES NOT DUPLICATE IT ──────────────────────────────────────
// Roughly 60% of an evidence ledger already existed in this engine, pointed at the wrong objects:
//   • `finding-store/digest.js  sha256()`  — content-addressing. REUSED verbatim (imported, not copied),
//     so an artifact hashes the same way a scan or a finding does.
//   • `evidence-name.js  evidenceName()`   — the one canonical descriptor (page·section·component·
//     issue·viewport). REUSED as the artifact's provenance, so a ledger record and the file on disk
//     describe themselves identically.
//   • `inventory/evidence.js  packageFor()` — the evidence PACKAGE (detectionConfidence, Complete/
//     Partial/Unavailable, before/after). Untouched: it describes what a finding means, this describes
//     what an artifact IS. They compose; neither replaces the other.
//   • `capture.js  stableCapture()`         — capture provenance (fontsLoaded, lazyLoadPass,
//     imageDecode, documentHeight, capturedAt). Carried into the record as `capture`, not recomputed.
// What was missing was never the hashing. It was ADDRESSING: `contract.js` stored evidence as a bare
// basename (`String(f.evidence).split(/[\\/]/).pop()`), which is not an identity, cannot be verified,
// cannot be de-duplicated and breaks the moment a report is copied — a bug already paid for once, in
// the 4.5.0 note about annotate showing every screenshot as broken after a run was moved.
//
// ── WHAT IT DEDUPLICATES, PRECISELY ──────────────────────────────────────────────────────────────
// IDENTITY, not yet STORAGE. Two paths whose bytes are identical collapse onto ONE artifactId with two
// recorded paths. Nothing is copied, moved or deleted — the files stay exactly where `checks-render.js`
// wrote them and `report.js` still reads them from there, so no report changes. Physical single-copy
// storage arrives when the ledger OWNS storage (ADR-0008); claiming it now would be claiming a saving
// that has not been made. `manifest().savedBytes` measures the saving that WOULD be realised, and is
// labelled as such.
//
// ── LAYER ────────────────────────────────────────────────────────────────────────────────────────
// Persistence infrastructure, alongside scan-store / finding-store — not a step in the
// Collector→Provider→Rule→View chain, so it does not bend ADR-0004 §D4. It reads bytes from disk, so
// it is only ever driven FROM the collector layer, which already owns filesystem access.
//
// NOTE (ADR-0004 §D8): this is store #5 by the pattern, hand-built because the immutable-store
// extraction is explicitly deferred. It is deliberately small — index + hash + verify — so it can sit
// on the extracted base later without its callers changing.

const fs = require('fs');
const path = require('path');
// ADR-0008: hashing comes from immutable-store/, the one place content-addressing lives. Until that
// extraction existed this reached into finding-store/digest — infrastructure borrowing from an
// unrelated store because there was nowhere else for it to live. Same function, correct home.
const { sha256 } = require('../immutable-store');
const { evidenceName } = require('../evidence-name');

const MODEL = 'sgen-evidence-ledger-v1';
const ID_PREFIX = 'ev-';
const ID_RE = /^ev-[a-f0-9]{64}$/;

// artifactId = ev- + sha256(BYTES). Content-addressed, so the id IS the integrity check: two runs on
// two machines that captured the same pixels produce the same id, and a changed byte produces a
// different one. Filename-safe by construction (no colons) because these ids end up in paths.
function artifactIdOf(buf) {
  return ID_PREFIX + sha256(Buffer.isBuffer(buf) ? buf.toString('binary') : String(buf == null ? '' : buf));
}
function isArtifactId(v) { return typeof v === 'string' && ID_RE.test(v); }

const EXT_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.html': 'text/html', '.json': 'application/json', '.txt': 'text/plain' };
function mimeFor(p) { return EXT_MIME[path.extname(String(p || '')).toLowerCase()] || null; }

class EvidenceLedger {
  // root — optional directory for the append-only index. Absent = in-memory (what a scan uses today).
  // now  — injectable clock. The ledger records WHEN an artifact was first seen; that is provenance,
  //        not identity, and it never enters the artifactId, so ids stay reproducible.
  constructor({ root = null, now = () => new Date().toISOString() } = {}) {
    this.root = root || null;
    this.now = now;
    this.byId = new Map();       // artifactId -> record
    this.byPath = new Map();     // absolute path -> artifactId
    this.refs = new Map();       // artifactId -> Set(finding fingerprint)
    this.indexPath = this.root ? path.join(this.root, 'evidence-index.jsonl') : null;
    if (this.indexPath) fs.mkdirSync(path.dirname(this.indexPath), { recursive: true });
  }

  // putBytes(buf, descriptor) — register an artifact from bytes already in hand.
  // descriptor = { page, section, component, issue, viewport, capture } — the SAME fields
  // evidenceName() consumes, so provenance and filename cannot drift apart.
  putBytes(buf, descriptor = {}, filePath = null) {
    if (!Buffer.isBuffer(buf)) throw new TypeError('evidence-ledger: putBytes expects a Buffer');
    const artifactId = artifactIdOf(buf);
    const abs = filePath ? path.resolve(filePath) : null;
    const existing = this.byId.get(artifactId);
    if (existing) {
      // DEDUPLICATION. Identical bytes are ONE artifact, however many files carry them.
      if (abs && !existing.paths.includes(abs)) { existing.paths.push(abs); existing.paths.sort(); }
      if (abs) this.byPath.set(abs, artifactId);
      return { artifactId, bytes: existing.bytes, duplicate: true, duplicateOf: artifactId, record: existing };
    }
    const rec = {
      artifactId,
      hash: artifactId.slice(ID_PREFIX.length),
      bytes: buf.length,
      mime: mimeFor(abs || (descriptor && descriptor.name)),
      // canonical descriptor + the canonical NAME derived from it — one naming authority, reused
      descriptor: {
        page: descriptor.page != null ? descriptor.page : null,
        section: descriptor.section != null ? descriptor.section : null,
        component: descriptor.component != null ? descriptor.component : null,
        issue: descriptor.issue != null ? descriptor.issue : null,
        viewport: descriptor.viewport != null ? descriptor.viewport : null,
      },
      canonicalName: evidenceName({ page: descriptor.page, section: descriptor.section, component: descriptor.component, issue: descriptor.issue, viewport: descriptor.viewport }),
      // capture provenance from stableCapture(), carried not recomputed. null when unavailable —
      // never {} , which would read as "captured with nothing set".
      capture: descriptor.capture || null,
      paths: abs ? [abs] : [],
      firstSeenAt: this.now(),
    };
    this.byId.set(artifactId, rec);
    if (abs) this.byPath.set(abs, artifactId);
    if (this.indexPath) {
      // append-only, fsync-free: an index line is a claim about an immutable artifact, and the bytes
      // themselves are the authority (verify() re-reads them), so a torn tail costs an index entry and
      // never corrupts an artifact.
      try { fs.appendFileSync(this.indexPath, JSON.stringify(rec) + '\n'); } catch (_) { /* index is a convenience, not the truth */ }
    }
    return { artifactId, bytes: rec.bytes, duplicate: false, duplicateOf: null, record: rec };
  }

  // putFile(p, descriptor) — the path a collector uses: it has just written a file.
  // FAILS CLOSED. An unreadable artifact throws rather than being registered as a hollow record: a
  // ledger entry that cannot be verified is worse than no entry, because it looks like evidence.
  putFile(p, descriptor = {}) {
    const abs = path.resolve(p);
    const known = this.byPath.get(abs);
    if (known) return { artifactId: known, bytes: this.byId.get(known).bytes, duplicate: true, duplicateOf: known, record: this.byId.get(known) };
    const buf = fs.readFileSync(abs);          // throws on missing/unreadable — deliberate
    return this.putBytes(buf, descriptor, abs);
  }

  get(artifactId) { return this.byId.get(artifactId) || null; }
  has(artifactId) { return this.byId.has(artifactId); }
  idForPath(p) { return this.byPath.get(path.resolve(p)) || null; }

  // link(artifactId, fingerprint) — a FINDING references an ARTIFACT. The reference is by content
  // address on one side and by the existing deterministic finding fingerprint (lib/fingerprint.js) on
  // the other, so the pair is reproducible without either object having to be re-read.
  link(artifactId, fingerprint) {
    if (!this.byId.has(artifactId)) throw new Error(`evidence-ledger: cannot link unknown artifact ${artifactId}`);
    if (typeof fingerprint !== 'string' || !fingerprint) throw new TypeError('evidence-ledger: link needs a finding fingerprint');
    if (!this.refs.has(artifactId)) this.refs.set(artifactId, new Set());
    this.refs.get(artifactId).add(fingerprint);
    return this;
  }
  referencesOf(artifactId) { return [...(this.refs.get(artifactId) || [])].sort(); }
  artifactsFor(fingerprint) {
    const out = [];
    for (const [id, set] of this.refs) if (set.has(fingerprint)) out.push(id);
    return out.sort();
  }

  // verify() — tamper-evidence. Re-reads every recorded path and re-hashes it. Same discipline as the
  // other stores' integrity passes: damage is CLASSIFIED, never summarised as a boolean.
  verify() {
    const problems = [];
    let checked = 0;
    for (const rec of this.byId.values()) {
      for (const p of rec.paths) {
        checked++;
        let buf = null;
        try { buf = fs.readFileSync(p); } catch (_) { problems.push({ class: 'missing', artifactId: rec.artifactId, path: p }); continue; }
        const id = artifactIdOf(buf);
        if (id !== rec.artifactId) problems.push({ class: 'modified', artifactId: rec.artifactId, path: p, actual: id });
      }
    }
    return { ok: problems.length === 0, checked, problems };
  }

  // manifest() — deterministic summary. Sorted by artifactId so two runs over the same artifacts
  // produce byte-identical manifests.
  manifest() {
    const artifacts = [...this.byId.values()]
      .sort((a, b) => a.artifactId.localeCompare(b.artifactId))
      .map(r => ({
        artifactId: r.artifactId, bytes: r.bytes, mime: r.mime,
        canonicalName: r.canonicalName, descriptor: r.descriptor,
        pathCount: r.paths.length,
        references: this.referencesOf(r.artifactId),
      }));
    const uniqueBytes = artifacts.reduce((a, r) => a + r.bytes, 0);
    const totalBytes = [...this.byId.values()].reduce((a, r) => a + r.bytes * r.paths.length, 0);
    const filesRegistered = [...this.byId.values()].reduce((a, r) => a + r.paths.length, 0);
    return {
      model: MODEL,
      artifacts,
      counts: {
        artifacts: artifacts.length,
        files: filesRegistered,
        duplicates: filesRegistered - artifacts.length,
      },
      // `savedBytes` is the saving single-copy storage WOULD realise. The ledger does not move files,
      // so it is a measurement of the opportunity, not a claim that disk was freed. See the header.
      bytes: { unique: uniqueBytes, total: totalBytes, savedBytes: totalBytes - uniqueBytes },
    };
  }
}

module.exports = { EvidenceLedger, artifactIdOf, isArtifactId, mimeFor, MODEL, ID_PREFIX, ID_RE };
