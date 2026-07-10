'use strict';
// inventory/index.js — the Inventory layer. buildInventory() runs every provider once over a crawl
// result and produces stable-ID'd, lifecycle-tracked items (the single source of truth). Parent/child
// links are wired (section→page). The comparison / evidence / certification / reporting LAYERS consume
// these items through their own modules — this layer never certifies or reports.
const { IdRegistry } = require('./id-registry');
const { makeItem } = require('./model');
const { PROVIDERS } = require('./providers');

// Which inventory types/roles are BLOCKING when a source item goes missing on the target.
const BLOCKING_TYPES = new Set(['page', 'form']);
const CONTENT_ASSET_ROLES = new Set(['image', 'document', 'video', 'og-image', 'logo']);
const BLOCKING_GLOBALS = new Set(['header', 'footer', 'nav', 'cookie-banner']);

function buildInventory(pages, opts = {}) {
  const host = opts.host || '';
  const idRegistry = opts.idRegistry || new IdRegistry(opts.persistPath || null);
  const items = {};          // type → [item]
  const byKey = new Map();   // identityKey → item
  for (const provider of PROVIDERS) {
    const raw = provider.enumerate(pages, host);
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

module.exports = { buildInventory, isBlockingMissing, IdRegistry, PROVIDERS };
