'use strict';
// replay/index.js — THE REPLAY ENGINE (ADR-0010, governed by ADR-0004 §D3).
//
// Re-executes the deterministic layer over a SEALED collection. No crawl, no browser, no Playwright,
// no network, no clock, no randomness. This is the capability ADR-0004 §D3 promised when it drew the
// determinism boundary:
//
//   > "Reproducibility gets a testable definition. It becomes 'same collection -> same score,
//      forever' - provable without the site being available, which is what certification requires."
//
// ── WHAT IS REPLAYED, STATED PRECISELY ───────────────────────────────────────────────────────────
// The PROVIDER layer: `collection -> inventories`. That is the layer that is pure today.
//
// It is NOT the rules layer, and this engine does not pretend otherwise. `audit.js` and
// `checks-static.js` are still PAGE-FIRST: they consume crawl pages and a live browser, not a
// collection (ADR-0004 §5 records this; ADR-0006 §Consequences records `render-blocking` as the
// remaining instance). Replaying FINDINGS therefore requires the rules layer to become an inventory
// consumer, which no ADR in force has authorised. Claiming finding-level replay now would be claiming
// a capability the architecture does not yet have — so this module replays what is genuinely
// deterministic and says plainly what it does not.
//
//   Mode A · REPRODUCIBILITY — same collection + same provider set -> byte-identical inventories.
//   Mode B · IMPACT          — same collection + a DIFFERENT provider set -> added/removed/changed/
//                              unchanged. What a provider change would do, computed without a crawl.
//
// ── READ-ONLY, AND STRUCTURALLY SO ───────────────────────────────────────────────────────────────
// Replay never writes. It takes a stored record, deep-freezes the collection it reconstructs, and
// hands that to the providers. A provider that tried to mutate its input would throw rather than
// silently corrupt a sealed acquisition.
//
// ── NO CLOCK, NO RANDOM ──────────────────────────────────────────────────────────────────────────
// Nothing here reads `Date` or `Math.random`. A replay that stamped its own time would not be
// reproducible, which is the one property it exists to provide. `at` is supplied by the caller when a
// caller wants a record stamped; the engine itself never needs one.

const { sha256 } = require('../immutable-store');
const { makeCollection, CHANNELS } = require('../inventory/collection');
const { buildInventory, PROVIDERS } = require('../inventory');
const { IdRegistry } = require('../inventory/id-registry');

const MODEL = 'sgen-replay-v1';
const MODES = ['reproducibility', 'impact'];

// Compatibility is REPORTED, never decided here beyond the two facts a replay cannot proceed without:
// the schema must be one this engine understands, and every provider the collection was sealed with
// must still exist. Everything else (engine/registry drift) is surfaced as a fact for the caller.
const SUPPORTED_SCHEMA_VERSIONS = ['1.0', '1.1'];

// deepFreeze — replay is read-only, enforced rather than promised.
// NOTE: it must NOT skip an already-frozen object. `makeCollection` freezes the container and each
// channel ARRAY, so an early `if (!Object.isFrozen(v))` return short-circuits before ever reaching the
// records inside those arrays — leaving every element mutable while looking sealed. Caught by
// replay.test.js §3, not by inspection. Freeze, then always descend; a `seen` set keeps it safe on
// cyclic input.
function deepFreeze(v, seen = new Set()) {
  if (!v || typeof v !== 'object' || seen.has(v)) return v;
  seen.add(v);
  Object.freeze(v);
  for (const k of Object.keys(v)) deepFreeze(v[k], seen);
  return v;
}

// Reconstruct the sealed Collection from a stored record. The record's `channels` ARE the collection's
// channels; `collected` comes from the manifest's collectorSet, which is where the store put it.
function collectionFrom(record) {
  if (!record || typeof record !== 'object' || !record.manifest || !record.channels) {
    throw new Error('replay: not a collection record — refusing to replay something this engine cannot read');
  }
  const input = { collected: record.manifest.collectorSet || [] };
  for (const ch of CHANNELS) input[ch] = record.channels[ch] || [];
  const c = makeCollection(input);
  // makeCollection already froze the container; freeze the contents too so a provider cannot mutate
  // a sealed acquisition even by accident.
  return deepFreeze(c);
}

// Deterministic serialisation of an inventory for comparison. Excludes nothing — if two replays differ
// anywhere, the hash moves. IDs are included on purpose: a stable id is part of the reproducibility
// claim, not an implementation detail.
function serializeInventory(inv) {
  const out = { counts: inv.counts, total: inv.total, target: inv.target, items: {} };
  for (const t of Object.keys(inv.items).sort()) {
    out.items[t] = inv.items[t].map(i => ({
      id: i.id, type: i.type, identityKey: i.identityKey, provider: i.provider,
      parent: i.parent, children: i.children.slice().sort(), state: i.state,
      meta: i.meta, findings: i.findings, evidence: i.evidence,
      comparisonMapping: i.comparisonMapping, referenceMapping: i.referenceMapping,
      certificationState: i.certificationState,
    }));
  }
  return JSON.stringify(out, null, 2);
}

// compatibility(record, opts) — FACTS, not a verdict. It answers "what does this engine know about
// this collection", and only refuses on the two conditions that make replay impossible rather than
// merely different.
function compatibility(record, { providers = PROVIDERS, versions = null } = {}) {
  const m = record.manifest || {};
  const available = new Set(providers.map(p => p.type));
  const sealedWith = Array.isArray(m.providerSet) ? m.providerSet : [];
  const missingProviders = sealedWith.filter(t => !available.has(t)).sort();
  const addedProviders = [...available].filter(t => !sealedWith.includes(t)).sort();
  return {
    schemaVersion: m.schemaVersion || null,
    schemaSupported: SUPPORTED_SCHEMA_VERSIONS.includes(m.schemaVersion),
    sealedVersions: {
      engine: m.engineVersion || null, registry: m.registryVersion || null,
      providerContract: m.providerContractVersion || null,
    },
    currentVersions: versions || null,
    // drift is REPORTED, never acted on — deciding what drift means is the caller's job
    versionDrift: versions ? {
      engine: versions.engine !== m.engineVersion,
      registry: versions.registry !== m.registryVersion,
      providerContract: versions.providerContract !== m.providerContractVersion,
    } : null,
    collectorSet: m.collectorSet || [],
    sealedProviderSet: sealedWith,
    availableProviderSet: [...available].sort(),
    missingProviders, addedProviders,
  };
}

// assertReplayable — FAIL CLOSED. Two refusals only, both cases where replay could not be honest:
//   • an unsupported schema: this engine cannot read the collection's shape
//   • a provider the collection was sealed with no longer exists: the replay would silently be a
//     DIFFERENT computation wearing the original's name
// `allowProviderDivergence` is MODE-AWARE, and the distinction is the whole design:
//   • Mode A (reproducibility) — a sealed provider that is absent INVALIDATES the claim. The result
//     would be a different computation wearing the original's name. Refuse. (default: false)
//   • Mode B (impact) — running a DIFFERENT provider set is the entire purpose. Refusing there would
//     make the mode unreachable. The candidate side opts out explicitly, and the divergence is
//     REPORTED in the result rather than silently tolerated.
// The first version of this guard was unconditional and made Mode B impossible; caught by
// replay.test.js §4, which is why the exemption is narrow, named and surfaced instead of a flag that
// quietly disables a safety check.
function assertReplayable(compat, { allowProviderDivergence = false } = {}) {
  if (!compat.schemaSupported) {
    throw new Error(`replay: unsupported collection schema "${compat.schemaVersion}" (this engine understands ${SUPPORTED_SCHEMA_VERSIONS.join(', ')}) — refusing to replay a shape it cannot read`);
  }
  if (!allowProviderDivergence && compat.missingProviders.length) {
    throw new Error(`replay: provider(s) [${compat.missingProviders.join(', ')}] were sealed into this collection but no longer exist — replaying without them would be a DIFFERENT computation wearing the original's name`);
  }
}

// verifyRecord — a damaged collection is never replayed. The digest is recomputed over the record
// minus its own identity fields, exactly as collection-store computes it.
function verifyRecord(record) {
  const { collectionId, digest, ...body } = record || {};
  const recomputed = sha256(body);
  return { ok: recomputed === digest && collectionId === 'col-' + digest, expected: digest || null, actual: recomputed };
}

// ── MODE A · REPRODUCIBILITY ─────────────────────────────────────────────────────────────────────
// Replay a sealed collection through a provider set. Returns the inventory plus its content address,
// so two replays are compared by hash rather than by eyeball.
function replay(record, { providers = PROVIDERS, versions = null, host = null, target = null, allowProviderDivergence = false } = {}) {
  const integrity = verifyRecord(record);
  if (!integrity.ok) {
    throw new Error(`replay: collection integrity check FAILED (expected ${String(integrity.expected).slice(0, 16)}…, got ${integrity.actual.slice(0, 16)}…) — a damaged collection is never replayed`);
  }
  const compat = compatibility(record, { providers, versions });
  assertReplayable(compat, { allowProviderDivergence });

  const collection = collectionFrom(record);
  // A FRESH IdRegistry per replay, deliberately: ids must be reproducible from the collection alone.
  // Sharing a registry across replays would let a previous run's mint order leak into this one's
  // output and make the reproducibility claim depend on invocation history.
  const inv = buildInventory(collection, {
    providers,
    idRegistry: new IdRegistry(),
    host: host != null ? host : (record.manifest.host || ''),
    target: target != null ? target : (record.manifest.target || ''),
  });
  const serialized = serializeInventory(inv);
  return {
    model: MODEL, mode: 'reproducibility',
    collectionId: record.collectionId,
    inventory: inv,
    inventoryDigest: sha256(serialized),
    serialized,
    compatibility: compat,
    integrity,
  };
}

// ── MODE B · IMPACT ANALYSIS ─────────────────────────────────────────────────────────────────────
// The same collection through two provider sets. Diffs by inventory identityKey, which is the stable
// logical identity — NOT by minted id, which is positional and would report every item as changed the
// moment one is inserted.
function impact(record, { baselineProviders, candidateProviders, versions = null, host = null, target = null } = {}) {
  if (!Array.isArray(baselineProviders) || !Array.isArray(candidateProviders)) {
    throw new TypeError('replay.impact: baselineProviders and candidateProviders are both required');
  }
  // BOTH sides may diverge from the seal, and that is correct: in Mode B the caller has NAMED both
  // provider sets explicitly, so neither is silently pretending to be the sealed computation --
  // which is the only thing the guard exists to prevent. Mode A keeps the strict guard, because there
  // the caller is asserting faithful reproduction. The divergence of each side is REPORTED below
  // rather than tolerated in silence. (First written with the guard on the baseline; replay.test.js
  // proved that made an old-vs-new provider comparison impossible.)
  const before = replay(record, { providers: baselineProviders, versions, host, target, allowProviderDivergence: true });
  const after = replay(record, { providers: candidateProviders, versions, host, target, allowProviderDivergence: true });

  const index = (inv) => {
    const m = new Map();
    for (const list of Object.values(inv.items)) for (const it of list) m.set(it.identityKey, it);
    return m;
  };
  const a = index(before.inventory), b = index(after.inventory);
  // Compare the MEANING of an item, not its minted id: id is assigned by the registry in enumeration
  // order, so including it would report positional churn as semantic change.
  const shapeOf = (it) => sha256({ type: it.type, provider: it.provider, parent: it.parent, meta: it.meta });

  const added = [], removed = [], changed = [], unchanged = [];
  for (const [key, it] of b) {
    if (!a.has(key)) { added.push({ identityKey: key, type: it.type }); continue; }
    const same = shapeOf(a.get(key)) === shapeOf(it);
    (same ? unchanged : changed).push({ identityKey: key, type: it.type });
  }
  for (const [key, it] of a) if (!b.has(key)) removed.push({ identityKey: key, type: it.type });

  const byKey = (x, y) => x.identityKey.localeCompare(y.identityKey);
  added.sort(byKey); removed.sort(byKey); changed.sort(byKey); unchanged.sort(byKey);

  return {
    model: MODEL, mode: 'impact',
    collectionId: record.collectionId,
    baseline: { digest: before.inventoryDigest, providerSet: before.compatibility.availableProviderSet, counts: before.inventory.counts },
    candidate: { digest: after.inventoryDigest, providerSet: after.compatibility.availableProviderSet, counts: after.inventory.counts },
    // the provider-set change that produced this diff, stated rather than left to be inferred
    providerDivergence: {
      baseline: { droppedFromSeal: before.compatibility.missingProviders, addedSinceSeal: before.compatibility.addedProviders },
      candidate: { droppedFromSeal: after.compatibility.missingProviders, addedSinceSeal: after.compatibility.addedProviders },
    },
    identical: before.inventoryDigest === after.inventoryDigest,
    added, removed, changed, unchanged,
    counts: { added: added.length, removed: removed.length, changed: changed.length, unchanged: unchanged.length },
  };
}

module.exports = { replay, impact, compatibility, assertReplayable, verifyRecord, collectionFrom, serializeInventory, deepFreeze, MODEL, MODES, SUPPORTED_SCHEMA_VERSIONS };
