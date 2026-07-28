'use strict';
// collection-store/index.js — THE COLLECTION STORE (ADR-0009, governed by ADR-0004 · built on ADR-0008).
//
// Persists a complete ACQUISITION — everything the collector layer saw on one run — as an immutable,
// content-addressed, tamper-evident record. It is the last acquisition-layer persistence component.
//
// ── IT IS CONFIGURATION, NOT A SIXTH IMPLEMENTATION ─────────────────────────────────────────────
// ADR-0004 §D8 required the immutable-store extraction to happen BEFORE this store precisely so that
// this file would not be store #6. Everything durable here comes from `RecordStore`: the storage /
// indexes / manifest layout, the temp->fsync->rename commit, the append-only journals, the canonical
// digest. What remains below is this store's SPECIALISATION — what a collection record contains, which
// indexes it projects, and what counts as damage. That is the adapter shape ADR-0008 predicted.
//
// ── IT PERSISTS; IT DECIDES NOTHING ──────────────────────────────────────────────────────────────
// No finding evaluation, no scoring, no technology classification, no report generation, no registry
// access, no Playwright, no policy. Two consequences that are easy to get wrong and are therefore
// enforced rather than intended:
//
//   1. IT READS NO CLOCK. `acquiredAt` is supplied by the caller and is REQUIRED. Infrastructure that
//      timestamps its own writes silently makes a policy decision about when a thing happened.
//   2. IT IMPORTS NO VERSION MODULE. engine / registry / provider-contract versions are supplied by
//      the caller and are REQUIRED. Importing `version.js` would transitively import the rule registry
//      — the exact boundary this store is forbidden to cross — so the versions are recorded as facts
//      it is GIVEN, never facts it discovers. A caller that cannot say what produced a collection has
//      no business sealing one, so a missing version throws.
//
// ── REFERENCES, NOT COPIES ───────────────────────────────────────────────────────────────────────
// Binary artifacts are NEVER duplicated here. A screenshot lives where the collector wrote it and is
// addressed by the ADR-0007 Evidence Ledger's `artifactId`; this store records those ids in
// `evidenceRefs` and stores the shot entries as the references they already are. Page bodies and the
// structured channels are the acquisition ITSELF, not artifacts, so they are stored as given —
// externalising them is storage optimisation, which ADR-0009 explicitly excludes.

const {
  sha256, canonical,
  writeRecordAtomic, appendLine, appendLines, readJsonl, readRecord, exists,
  RecordStore,
} = require('../immutable-store');

const MODEL = 'sgen-collection-store-v1';
const ID_PREFIX = 'col-';
const ID_RE = /^col-[a-f0-9]{64}$/;

// The channels a collection can carry. Mirrors the Collection contract (ADR-0004 §D2 / ADR-0005 §D3)
// but is declared here as DATA rather than imported, so this store never depends on the provider layer.
const CHANNELS = ['staticPages', 'documents', 'network', 'render', 'console', 'fonts', 'shots'];
const INDEX_NAMES = ['by-target', 'by-date', 'by-engine', 'by-schema', 'by-digest'];

function isCollectionId(v) { return typeof v === 'string' && ID_RE.test(v); }

// Every artifactId referenced anywhere in the collection's shot entries, de-duplicated and sorted.
// REFERENCES ONLY — no byte of any artifact is read, copied or stored by this module.
function evidenceRefsOf(collection) {
  const out = new Set();
  for (const s of (collection.shots || [])) {
    if (s && typeof s.artifactId === 'string' && s.artifactId) out.add(s.artifactId);
  }
  return [...out].sort();
}

// Per-channel content address. Makes integrity verification say WHICH channel changed instead of only
// that something did — the same reason the other stores classify damage rather than returning a bool.
function channelDigests(collection) {
  const out = {};
  for (const ch of CHANNELS) out[ch] = sha256(collection[ch] || []);
  return out;
}
function countsOf(collection) {
  const out = {};
  for (const ch of CHANNELS) out[ch] = (collection[ch] || []).length;
  return out;
}

// The record minus its own identity fields — what the digest is computed over. Same discipline as
// scan-store's recordForDigest: an id may never be part of the content it identifies.
function recordForDigest(rec) {
  const { collectionId, digest, ...rest } = rec;
  return rest;
}

// buildRecord(collection, meta) — pure. Exported so the record shape is testable without touching disk.
// FAILS CLOSED on anything it would otherwise have to invent.
function buildRecord(collection, meta = {}) {
  if (!collection || typeof collection !== 'object') throw new TypeError('collection-store: a collection object is required');
  const v = meta.versions || {};
  if (!meta.acquiredAt) throw new Error('collection-store: meta.acquiredAt is required — this store reads no clock');
  if (!v.engine || !v.registry || !v.providerContract) {
    throw new Error('collection-store: meta.versions {engine, registry, providerContract} are required — this store imports no version module, it records what it is told');
  }
  if (!collection.schemaVersion) throw new Error('collection-store: the collection carries no schemaVersion — refusing to seal an unidentifiable acquisition');

  const body = {
    model: MODEL,
    // ── MANIFEST: COMPATIBILITY FACTS ONLY ────────────────────────────────────────────────────────
    // Deliberately records no judgement about whether a collection CAN be replayed. That is a replay
    // decision, and replay is a later ADR. This says what produced the collection; something else may
    // later decide what that means.
    manifest: {
      schemaVersion: collection.schemaVersion,
      engineVersion: v.engine,
      registryVersion: v.registry,
      providerContractVersion: v.providerContract,
      // what actually ran — taken from the collection's own declaration, not inferred from emptiness
      collectorSet: Array.isArray(collection.collected) ? [...collection.collected].sort() : [],
      // supplied by the caller: the store does not enumerate providers, which would couple it to them
      providerSet: Array.isArray(meta.providerSet) ? [...meta.providerSet].sort() : [],
      acquiredAt: meta.acquiredAt,
      target: meta.target != null ? meta.target : null,
      host: meta.host != null ? meta.host : null,
    },
    counts: countsOf(collection),
    integrity: { channelDigests: channelDigests(collection) },
    // references, never copies (see header)
    evidenceRefs: evidenceRefsOf(collection),
    channels: CHANNELS.reduce((acc, ch) => { acc[ch] = collection[ch] || []; return acc; }, {}),
  };
  const digest = sha256(body);
  return { collectionId: ID_PREFIX + digest, digest, ...body };
}

class CollectionStore extends RecordStore {
  constructor(root) {
    super(root, { storageDirName: 'collections', indexDirName: 'indexes', manifestName: 'manifest.jsonl' });
  }

  // save(collection, meta) → { collectionId, digest, duplicate }
  // SEALING: a collection is immutable once written. An identical acquisition re-saved is reported as a
  // duplicate and NEVER rewritten — the same append-only contract every other store holds.
  save(collection, meta = {}) {
    const rec = buildRecord(collection, meta);
    if (this.has(rec.collectionId)) {
      return { collectionId: rec.collectionId, digest: rec.digest, duplicate: true };
    }
    this.commit(rec.collectionId, rec, {
      collectionId: rec.collectionId, digest: rec.digest,
      schema: rec.manifest.schemaVersion, engine: rec.manifest.engineVersion,
      registry: rec.manifest.registryVersion, providerContract: rec.manifest.providerContractVersion,
      target: rec.manifest.target, host: rec.manifest.host,
      acquiredAt: rec.manifest.acquiredAt, counts: rec.counts,
    });
    this._appendIndexes(rec);
    return { collectionId: rec.collectionId, digest: rec.digest, duplicate: false };
  }

  list() { return this.manifest().map(m => m.collectionId); }
  count() { return this.list().length; }
  // Every collectionId with a record actually on disk — the source of truth for a rebuild.
  storedIds() {
    const fs = require('fs');
    return fs.readdirSync(this.storageDir).filter(f => f.endsWith('.json') && !f.endsWith('.tmp')).map(f => f.slice(0, -5));
  }

  // ---- indexes: pure projections of the immutable records -------------------
  _indexRows(rec) {
    return [
      ['by-target', sha256(String(rec.manifest.target || '')), rec.collectionId],
      ['by-date', String(rec.manifest.acquiredAt || '').slice(0, 10), rec.collectionId],
      ['by-engine', rec.manifest.engineVersion, rec.collectionId],
      ['by-schema', rec.manifest.schemaVersion, rec.collectionId],
      ['by-digest', rec.digest, rec.collectionId],
    ];
  }
  _appendIndexes(rec) {
    const buckets = {};
    for (const [name, key, id] of this._indexRows(rec)) {
      (buckets[name] || (buckets[name] = [])).push(JSON.stringify({ key, collectionId: id }));
    }
    for (const name of Object.keys(buckets)) appendLines(this.indexPath(name), buckets[name]);
  }
  // Rebuild every index from the immutable records — proves indexes carry no independent authority.
  // Walks the MANIFEST (committed order) so rebuilt index files are byte-identical run to run.
  rebuildIndexes() {
    const fs = require('fs');
    for (const name of INDEX_NAMES) {
      const p = this.indexPath(name);
      if (exists(p)) fs.unlinkSync(p);
    }
    let n = 0;
    for (const m of this.manifest()) {
      const rec = this.get(m.collectionId);
      if (rec) { this._appendIndexes(rec); n++; }
    }
    return { rebuilt: n };
  }
  readIndex(name) { return readJsonl(this.indexPath(name)); }
  query(name, key) {
    if (!INDEX_NAMES.includes(name)) throw new Error('collection-store: unknown index ' + name);
    return this.readIndex(name).filter(r => r.key === key).map(r => r.collectionId);
  }
  byTarget(target) { return this.query('by-target', sha256(String(target))); }
  byDate(day) { return this.query('by-date', day); }

  // ---- integrity: damage is CLASSIFIED, never summarised as a boolean -------
  //   modified        — the record's content no longer hashes to its recorded digest (tampering)
  //   id-mismatch     — the record's id does not match its own content address
  //   channel-modified— which CHANNEL changed, so a diagnosis does not require re-deriving it
  //   missing-record  — a manifest line with no record (committed then lost)
  //   uncommitted     — a record with no manifest line (partial write; recoverable, not corruption)
  verify() {
    const problems = [];
    const manifestIds = new Set();
    for (const m of this.manifest()) {
      manifestIds.add(m.collectionId);
      const rec = this.get(m.collectionId);
      if (!rec) { problems.push({ class: 'missing-record', collectionId: m.collectionId }); continue; }
      const recomputed = sha256(recordForDigest(rec));
      if (recomputed !== rec.digest) {
        problems.push({ class: 'modified', collectionId: m.collectionId, expected: rec.digest, actual: recomputed });
        const declared = (rec.integrity && rec.integrity.channelDigests) || {};
        for (const ch of CHANNELS) {
          const now = sha256((rec.channels && rec.channels[ch]) || []);
          if (declared[ch] && declared[ch] !== now) problems.push({ class: 'channel-modified', collectionId: m.collectionId, channel: ch });
        }
      }
      if (rec.collectionId !== ID_PREFIX + rec.digest) {
        problems.push({ class: 'id-mismatch', collectionId: m.collectionId });
      }
    }
    for (const id of this.storedIds()) {
      if (!manifestIds.has(id)) problems.push({ class: 'uncommitted', collectionId: id });
    }
    return { ok: problems.length === 0, checked: manifestIds.size, problems };
  }
}

module.exports = { CollectionStore, buildRecord, recordForDigest, evidenceRefsOf, channelDigests, isCollectionId, CHANNELS, INDEX_NAMES, MODEL, ID_PREFIX };
