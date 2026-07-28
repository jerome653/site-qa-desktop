'use strict';
// inventory/collection.js — THE COLLECTION: the sealed output of the Collector layer, and the only
// input a Provider is permitted to read (ADR-0004 §D2/§D3/§D5/§D7).
//
// WHY THIS EXISTS. `QA-SPECIFICATION.md` Part 6 specified the provider interface as
// `enumerate(ctx) → items[]`. The implementation shipped `enumerate(pages, host)` — static crawl
// records only. That one-word drift is why `ComponentProvider` has been a stub since it was written
// (`providers.js`: "Component-level enumeration is RESERVED (needs the render-time element read)"),
// and why a Network Ledger / Document Asset Inventory had nowhere to plug in. This module is the
// widened input, introduced additively: every existing provider reads `collection.staticPages`, which
// is byte-for-byte what it used to receive as `pages`.
//
// THE DETERMINISM BOUNDARY (ADR-0004 §D3) runs directly above this object. Collectors are the only
// layer allowed to touch the browser, the network, the clock or the OS; a Collection is the frozen
// record of what they saw. Everything downstream — providers, rules, views, reports — is a pure
// function of it. That is what makes replay possible: same collection → same score, forever.
//
// SEALED, AND WHY IT COPIES. Channel arrays are copied (`.slice()`) before freezing so sealing a
// collection can never freeze an array its caller still owns and later mutates. The copy is of
// references, not of page bodies — negligible cost, and it removes an entire class of action-at-a-
// distance bug from a boundary whose whole job is immutability.

const { COLLECTION_SCHEMA_VERSION } = require('../version');

// The channel set. `staticPages` is the only one populated today; the rest are declared now so the
// shape is stable and a child ADR adds a collector without reopening this contract (ADR-0004 §D5:
// boundaries change by additive version, never by silent behavioural change).
//   staticPages — raw crawl records { url, status, contentType, headers, body }
//   documents   — parsed head+body asset inventory            (ADR-0006)
//   network     — per-request records                          (ADR-0005)
//   render      — per page×viewport DOM / geometry read        (unblocks ComponentProvider)
//   console     — console + pageerror records
//   fonts       — webfont / icon-font integrity reads
//   shots       — captured artifact references                 (ADR-0007 addresses them)
const CHANNELS = ['staticPages', 'documents', 'network', 'render', 'console', 'fonts', 'shots'];

const MARKER = '__sgenCollection';

// ── `collected` — WHICH CHANNELS A COLLECTOR ACTUALLY RAN (schema 1.1, ADR-0005) ──────────────────
// An empty channel has two completely different meanings and the array alone cannot tell them apart:
//   • a collector ran and observed nothing   → "looked, clean"
//   • no collector ran at all                → "never looked"
// This engine has paid for that confusion before, at length: `audit.js`'s evaluation ledger and
// `score.js`'s evaluatedRules exist because "no finding" was being paid out as "passed". The same
// mistake at the acquisition boundary would be worse, because every layer above inherits it. So the
// declaration is explicit and travels WITH the collection, never inferred from emptiness.
// A 1.0 collection (no declaration) reads as "nothing declared", which is the safe direction.

// makeCollection(input) → a frozen Collection. Absent channels default to empty, never undefined, so
// a provider may read any channel without guarding — `collection.network` is always an array.
// `input.collected` = channel names a collector genuinely populated (even if it found zero records).
function makeCollection(input = {}) {
  const c = { [MARKER]: true, schemaVersion: COLLECTION_SCHEMA_VERSION };
  for (const ch of CHANNELS) {
    const v = input[ch];
    if (v != null && !Array.isArray(v)) throw new TypeError(`collection: channel "${ch}" must be an array (got ${typeof v})`);
    c[ch] = Object.freeze(Array.isArray(v) ? v.slice() : []);
  }
  const declared = Array.isArray(input.collected) ? input.collected : [];
  for (const ch of declared) if (!CHANNELS.includes(ch)) throw new TypeError(`collection: cannot declare unknown channel "${ch}" as collected`);
  // Sorted + de-duplicated so two collections built from the same facts are byte-identical regardless
  // of the order collectors happened to finish in — replay depends on it.
  c.collected = Object.freeze([...new Set(declared)].sort());
  return Object.freeze(c);
}

// wasCollected(collection, channel) — the only sanctioned way to ask "did anyone look?".
// Never substitute `collection[channel].length` for this: that is the exact conflation above.
function wasCollected(collection, channel) {
  return !!(collection && Array.isArray(collection.collected) && collection.collected.includes(channel));
}

// fromPages(pages) — the back-compatibility adapter. A legacy caller hands `buildInventory` a bare
// array of crawl records; it becomes a Collection carrying exactly that array as `staticPages` and
// nothing else. Deliberately the ONLY compatibility seam in this change: it lives here, at the
// boundary, instead of being repeated inside all seven providers.
// `staticPages` IS declared collected: a legacy caller has, by definition, just crawled.
function fromPages(pages) {
  return makeCollection({ staticPages: Array.isArray(pages) ? pages : [], collected: ['staticPages'] });
}

function isCollection(v) {
  return !!(v && typeof v === 'object' && v[MARKER] === true);
}

// assertCollection — the fail-closed seam validator (ADR-0004 §D7). Same discipline as
// `registry.validate()` (throws at load on an invalid registry) and `assertTransition()` (throws on an
// illegal lifecycle move): a boundary defends itself, it does not trust its caller. The failure this
// prevents is the platform's most expensive defect class — a contract honoured in one file and
// silently dropped in the next.
function assertCollection(v, who = 'provider') {
  if (!isCollection(v)) {
    throw new TypeError(
      `${who}: expected a Collection (ADR-0004 §D2). Received ${Array.isArray(v) ? 'a bare array' : typeof v}. ` +
      `Build one with makeCollection({ staticPages }) or fromPages(pages).`
    );
  }
  return v;
}

module.exports = { makeCollection, fromPages, isCollection, assertCollection, wasCollected, CHANNELS, COLLECTION_SCHEMA_VERSION };
