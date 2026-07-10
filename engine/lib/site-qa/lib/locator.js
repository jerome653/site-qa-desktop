'use strict';
// lib/locator.js — the SINGLE locator service. Rules never build locators by hand; they pass element
// facts (or a build/manifest/route target) and this service produces the generic, type-tagged Locator
// from ADR-0003 with ranked, stability-scored strategies + copy-as exports. One abstraction for DOM AND
// Build Integrity (manifest/route/config), so nothing forks a parallel locator model.
//
// Pure + deterministic: given the same element facts it emits the same locator. DOM facts are gathered
// in the render pass (Stage 3) via a small in-page serializer; this module only *shapes* them.

// Rank: id > data-testid/data-* > single unique class > tag+attr > structural nth > xpath.
function domStrategies(el) {
  const out = [];
  const tag = (el.tag || '').toLowerCase();
  if (el.id) out.push({ kind: 'id', value: '#' + el.id, stability: 'high' });
  const testAttr = el.attributes && (el.attributes['data-testid'] || el.attributes['data-test'] || el.attributes['data-cy']);
  if (testAttr) out.push({ kind: 'data-testid', value: `[data-testid='${testAttr}']`, stability: 'high' });
  const classes = Array.isArray(el.classes) ? el.classes.filter(Boolean) : [];
  if (classes.length === 1) out.push({ kind: 'unique-class', value: tag + '.' + classes[0], stability: 'medium' });
  else if (classes.length > 1) out.push({ kind: 'class-combo', value: tag + '.' + classes.join('.'), stability: 'medium' });
  // a distinctive attribute (name/href/type) as a mid-stability anchor
  const attrs = el.attributes || {};
  for (const a of ['name', 'type', 'role', 'aria-label']) {
    if (attrs[a]) { out.push({ kind: 'attr', value: `${tag}[${a}='${String(attrs[a]).slice(0, 40)}']`, stability: 'medium' }); break; }
  }
  if (el.structuralCss) out.push({ kind: 'structural-css', value: el.structuralCss, stability: 'low' });
  if (el.xpath) out.push({ kind: 'xpath', value: el.xpath, stability: 'low' });
  if (!out.length) out.push({ kind: 'tag', value: tag || '*', stability: 'low' });
  return out;
}

function copyAsFrom(preferred, xpath) {
  const css = preferred && preferred.kind !== 'xpath' ? preferred.value : null;
  return {
    css: css || null,
    xpath: xpath || null,
    querySelector: css ? `document.querySelector(${JSON.stringify(css)})` : null,
    playwright: css ? `page.locator(${JSON.stringify(css)})` : (xpath ? `page.locator('xpath=${xpath}')` : null),
    cypress: css ? `cy.get(${JSON.stringify(css)})` : null,
  };
}

// Build a DOM locator from element facts. `el`: { tag, id, classes[], attributes{}, xpath, structuralCss,
// boundingBox, url, screenshot, source }.
function domLocator(el) {
  const strategies = domStrategies(el);
  const preferred = strategies[0];
  const xpath = (strategies.find(s => s.kind === 'xpath') || {}).value || el.xpath || null;
  return {
    type: 'dom',
    target: preferred.value,
    strategies,
    url: el.url || null,
    boundingBox: el.boundingBox || null,
    copyAs: copyAsFrom(preferred, xpath),
    source: el.source || null,
    sourceAvailability: el.source ? 'available' : 'requires-build-provenance',
  };
}

// Generic non-DOM locator (build-artifact / manifest / route / configuration). Same shape, different type
// — this is what lets Build Integrity reuse the locator model unchanged.
function genericLocator(type, target, opts = {}) {
  const strategies = (opts.strategies && opts.strategies.length)
    ? opts.strategies
    : [{ kind: type, value: String(target), stability: opts.stability || 'high' }];
  return {
    type,
    target: String(target),
    strategies,
    url: opts.url || null,
    boundingBox: null,
    copyAs: null,
    source: opts.source || null,
    sourceAvailability: opts.source ? 'available' : 'requires-build-provenance',
  };
}

// pick the most stable available strategy value (for a stable fingerprint selector)
function stableSelector(locator) {
  if (!locator || !Array.isArray(locator.strategies) || !locator.strategies.length) return '';
  const rank = { high: 0, medium: 1, low: 2, unknown: 3 };
  return locator.strategies.slice().sort((a, b) => (rank[a.stability] ?? 3) - (rank[b.stability] ?? 3))[0].value;
}

module.exports = { domLocator, genericLocator, domStrategies, stableSelector, copyAsFrom };
