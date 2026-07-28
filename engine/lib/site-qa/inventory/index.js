'use strict';
// inventory/index.js — the Inventory layer. buildInventory() runs every provider once over a crawl
// result and produces stable-ID'd, lifecycle-tracked items (the single source of truth). Parent/child
// links are wired (section→page). The comparison / evidence / certification / reporting LAYERS consume
// these items through their own modules — this layer never certifies or reports.
const { IdRegistry } = require('./id-registry');
const { makeItem } = require('./model');
const { PROVIDERS } = require('./providers');
const { isCollection, fromPages, makeCollection } = require('./collection');

// Which inventory types/roles are BLOCKING when a source item goes missing on the target.
const BLOCKING_TYPES = new Set(['page', 'form']);
const CONTENT_ASSET_ROLES = new Set(['image', 'document', 'video', 'og-image', 'logo']);
const BLOCKING_GLOBALS = new Set(['header', 'footer', 'nav', 'cookie-banner']);

// buildInventory(input, opts) — `input` is a Collection (ADR-0004 §D2) or, for compatibility, the bare
// array of crawl records every existing caller passes today. THE ADAPTER LIVES HERE AND ONLY HERE: one
// boundary seam instead of seven providers each guessing what they were handed. A legacy array becomes
// a Collection whose `staticPages` is exactly that array, so what a provider reads is byte-for-byte
// what it read before the contract widened — which is the whole of the A1 parity claim.
function buildInventory(input, opts = {}) {
  const host = opts.host || '';
  const collection = isCollection(input) ? input : fromPages(input);
  // ctx = everything a provider needs that is NOT collected evidence. Kept separate from the
  // collection on purpose: a collection is sealed acquisition, ctx is run parameters, and mixing them
  // would make two different things replay as one.
  const ctx = { host, target: opts.target || host };
  const idRegistry = opts.idRegistry || new IdRegistry(opts.persistPath || null);
  // opts.providers — run a SUBSET of the registered providers. Default is every one, so no caller
  // changes. Added with ADR-0005: registering an eighth provider legitimately changes what
  // buildInventory returns, which would otherwise have forced a re-baseline of the A1 golden and
  // destroyed the very evidence A1 exists to preserve. Scoping the golden to the seven providers whose
  // parity A1 actually claims keeps that evidence true forever, and keeps new providers cheap to add.
  const providerList = Array.isArray(opts.providers) && opts.providers.length ? opts.providers : PROVIDERS;
  const items = {};          // type → [item]
  const byKey = new Map();   // identityKey → item
  for (const provider of providerList) {
    const raw = provider.enumerate(collection, ctx);
    raw.sort((a, b) => a.identityKey.localeCompare(b.identityKey)); // deterministic mint order
    const list = items[provider.type] = [];
    for (const r of raw) {
      if (byKey.has(r.identityKey)) continue;
      const id = idRegistry.mint(provider.type, r.identityKey);
      const item = makeItem({ id, type: provider.type, identityKey: r.identityKey, provider: provider.type, meta: r.meta });
      list.push(item); byKey.set(r.identityKey, item);
    }
  }
  // wire parent/children: a section belongs to its page
  for (const sec of items.section || []) {
    const pageKey = 'page:' + (sec.meta.path || '');
    const page = byKey.get(pageKey);
    if (page) { sec.parent = pageKey; page.children.push(sec.identityKey); }
  }
  const counts = Object.fromEntries(Object.entries(items).map(([t, l]) => [t, l.length]));
  return { items, byKey, counts, idRegistry, total: byKey.size, target: opts.target || host };
}

// Classify the impact of a missing source item (used by the Comparison + Certification layers).
function isBlockingMissing(item) {
  if (BLOCKING_TYPES.has(item.type)) return true;
  if (item.type === 'asset') return CONTENT_ASSET_ROLES.has(item.meta.role);
  if (item.type === 'global') return BLOCKING_GLOBALS.has(item.meta.key);
  return false; // section/behavior/component decorative-by-default → advisory
}

module.exports = { buildInventory, isBlockingMissing, IdRegistry, PROVIDERS, makeCollection, fromPages, isCollection };
