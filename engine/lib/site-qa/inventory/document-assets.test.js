'use strict';
// document-assets.test.js — ADR-0006 evidence. Document Collector → Collection → DocumentAssetProvider.
//
// The load-bearing suite here is §8: a DIFFERENTIAL against the pre-refactor render-blocking code.
// PERF-005 was refactored onto this collector, and the only acceptable outcome is that it emits
// byte-identical findings. That is asserted against a verbatim copy of the ORIGINAL implementation,
// not against a fixture someone wrote afterwards — a fixture can agree with a regression.
const http = require('http');
const { buildInventory, PROVIDERS } = require('./index');
const { makeCollection, wasCollected } = require('./collection');
const { IdRegistry } = require('./id-registry');
const { collectDocumentAssets, headSlice, attrOf, boolAttr, TAGS } = require('../collectors/document');
const { STATIC_CHECKS, buildCtx } = require('../../migration-qa/checks-static');

let pass = 0, fail = 0; const failures = [];
function ok(c, n) { if (c) pass++; else { fail++; failures.push(n); console.log('  ✗ ' + n); } }
function eq(a, b, n) { ok(JSON.stringify(a) === JSON.stringify(b), n + (JSON.stringify(a) === JSON.stringify(b) ? '' : ` (got ${JSON.stringify(a)})`)); }

const docProvider = () => PROVIDERS.find(p => p.type === 'document');
const collectionWith = (documents, collected = ['documents']) => makeCollection({ documents, collected });

const DOC = `<!doctype html><html><head>
<meta charset="utf-8">
<link rel="preconnect dns-prefetch" href="https://cdn.example">
<link rel="stylesheet" href="/a.css">
<link rel="stylesheet" href="/print.css" media="print">
<link rel="preload" as="font" href="/f.woff2" crossorigin="anonymous">
<script src="/blocking.js"></script>
<script src="/async.js" async></script>
<script src="/defer.js" defer></script>
<script type="module" src="/m.mjs"></script>
<script nomodule src="/legacy.js" integrity="sha384-xyz"></script>
<script>window.inlineOne=1;</script>
<style>.a{b:c}</style>
</head><body>
<img src="/hero.jpg">
<script src="/body.js"></script>
<script>window.inlineTwo=2;</script>
<iframe src="https://x.example/f"></iframe>
</body></html>`;

console.log('Document Asset Inventory (ADR-0006) — test suite\n');

// ── 1 · the collector captures assets ─────────────────────────────────────────────────────────────
(function captures() {
  const d = collectDocumentAssets(DOC, { documentUrl: 'https://s.example/p' });
  ok(d.assets.length === 16, `collector: captured 16 assets (got ${d.assets.length})`);
  eq(d.counts.head, 12, 'collector: 12 head assets');
  eq(d.counts.body, 4, 'collector: 4 body assets');
  eq(d.documentUrl, 'https://s.example/p', 'collector: documentUrl retained');
  eq(d.source, 'static', 'collector: source defaults to static');
  ok(TAGS.includes('script') && TAGS.includes('link') && TAGS.includes('meta'), 'collector: tag set covers script/link/meta');
})();

// ── 2 · exact document order, never sorted / grouped / classified ─────────────────────────────────
(function order() {
  const a = collectDocumentAssets(DOC).assets;
  eq(a.map(x => x.tag).join(','),
    'meta,link,link,link,link,script,script,script,script,script,script,style,img,script,script,iframe',
    'order: tags in EXACT document order — not grouped by tag, not sorted');
  eq(a.map(x => x.index), a.map((_, i) => i), 'order: index is document position, contiguous');
  const head = a.filter(x => x.section === 'head');
  eq(head.map(x => x.sectionIndex), head.map((_, i) => i), 'order: sectionIndex is position within the section');
  // offsets must be strictly increasing — proof nothing was reordered
  ok(a.every((x, i) => i === 0 || x.offset > a[i - 1].offset), 'order: source offsets strictly increasing');
})();

// ── 3 · head/body preserved ───────────────────────────────────────────────────────────────────────
(function sections() {
  const a = collectDocumentAssets(DOC).assets;
  eq(a.filter(x => x.section === 'body').map(x => x.tag), ['img', 'script', 'script', 'iframe'], 'section: body assets identified positionally');
  ok(a.find(x => x.src === '/blocking.js').section === 'head', 'section: head script in head');
  ok(a.find(x => x.src === '/body.js').section === 'body', 'section: body script in body');
  // the headSlice fallback is preserved verbatim — every head-based check depends on it
  const noHead = '<html><body>' + 'x'.repeat(9000) + '<script src="/late.js"></script></body></html>';
  eq(headSlice(noHead).length, 8000, 'section: no <head> → the 8000-char fallback is preserved exactly');
  ok(collectDocumentAssets(noHead).assets.every(x => x.section === 'body'), 'section: an asset beyond the fallback window is body, not head');
})();

// ── 4 · attributes preserved; nulls are null, never '' ────────────────────────────────────────────
(function attributes() {
  const a = collectDocumentAssets(DOC).assets;
  const pre = a.find(x => x.rel === 'preconnect dns-prefetch');
  eq(pre.relTokens, ['preconnect', 'dns-prefetch'], 'attrs: rel tokenised (acquisition), not classified');
  const preload = a.find(x => x.href === '/f.woff2');
  eq(preload.crossorigin, 'anonymous', 'attrs: crossorigin captured');
  eq(preload.relTokens, ['preload'], 'attrs: preload visible via rel tokens');
  eq(a.find(x => x.href === '/print.css').media, 'print', 'attrs: media captured');
  const mod = a.find(x => x.src === '/m.mjs');
  ok(mod.module === true && mod.type === 'module', 'attrs: module detected from type');
  const legacy = a.find(x => x.src === '/legacy.js');
  ok(legacy.nomodule === true && legacy.integrity === 'sha384-xyz', 'attrs: nomodule + integrity captured');
  ok(a.find(x => x.src === '/async.js').async === true && a.find(x => x.src === '/defer.js').defer === true, 'attrs: async/defer captured');
  const inline = a.find(x => x.tag === 'script' && x.inline);
  ok(inline.inline === true && inline.external === false, 'attrs: inline vs external distinguished');
  eq(inline.src, null, 'nulls: an inline script has src null, NOT ""');
  eq(inline.rel, null, 'nulls: absent rel is null, NOT ""');
  eq(inline.relTokens, null, 'nulls: absent relTokens is null, NOT []');
  eq(inline.integrity, null, 'nulls: absent integrity is null');
  ok(a.every(x => Object.values(x).every(v => v !== '')), 'nulls: no field uses an empty string to mean unknown');
  ok(a.find(x => x.src === '/blocking.js').async === false, 'booleans: absent async is false — presence IS observable, so false is measured');
  ok(typeof a[0].attrs === 'object' && a[0].attrs.charset === 'utf-8', 'attrs: full attribute map retained');
  eq(boolAttr('<script async src="x">', 'async'), true, 'attrs: boolAttr on a valueless attribute');
  eq(attrOf('<link href="/a.css">', 'href'), '/a.css', 'attrs: attrOf matches checks-static semantics');
})();

// ── 5 · the provider consumes collection.documents, deterministically ─────────────────────────────
(function provider() {
  const d = collectDocumentAssets(DOC, { documentUrl: 'https://s.example/p', now: () => 'T1' });
  const items = docProvider().enumerate(collectionWith([d]), {});
  eq(items.length, 16, 'provider: one item per asset');
  ok(items.every(i => i.identityKey.startsWith('docasset:/p|')), 'provider: identity is document-scoped');
  const blocking = items.find(i => i.meta.src === '/blocking.js');
  eq(blocking.meta.section, 'head', 'provider: section carried through');
  eq(blocking.meta.index, 5, 'provider: document position carried through');
  eq(blocking.meta.recordIndexes, [{ document: 0, asset: 5 }], 'provider: item points BACK at its collection record');
  ok(items.every(i => !('raw' in i.meta) && !('capturedAt' in i.meta)), 'provider: raw text and capture clock do NOT travel into items');

  // determinism: different clocks, identical items
  const a = docProvider().enumerate(collectionWith([collectDocumentAssets(DOC, { documentUrl: 'https://s.example/p', now: () => '2026-01-01' })]), {});
  const b = docProvider().enumerate(collectionWith([collectDocumentAssets(DOC, { documentUrl: 'https://s.example/p', now: () => '2099-12-31' })]), {});
  ok(JSON.stringify(a) === JSON.stringify(b), 'determinism: differing capture clocks yield byte-identical items');
  ok(JSON.stringify(a).indexOf('2026-01-01') === -1, 'determinism: no wall-clock leaked into an item');

  const inv = buildInventory(collectionWith([d]), { idRegistry: new IdRegistry(), host: 's.example' });
  eq(inv.counts.document, 16, 'inventory: document assets land via buildInventory');
  ok(inv.items.document.every(i => i.provider === 'document' && i.state === 'DISCOVERED'), 'inventory: ordinary inventory items');
  ok(inv.items.document.every(i => /^DOC-\d{3}$/.test(i.id)), 'inventory: DOC- ids minted');
})();

// ── 6 · fails closed / empty handled ──────────────────────────────────────────────────────────────
(function failsClosed() {
  const undeclared = makeCollection({ staticPages: [], collected: ['staticPages'] });
  eq(docProvider().enumerate(undeclared, {}), [], 'fail-closed: an UNCOLLECTED channel yields no items and makes no claim');
  eq(docProvider().enumerate(collectionWith([]), {}), [], 'fail-closed: a COLLECTED-but-empty channel yields no items');
  ok(wasCollected(collectionWith([]), 'documents') && !wasCollected(undeclared, 'documents'),
    'fail-closed: "collected, empty" is DISTINGUISHABLE from "never collected"');
  eq(collectDocumentAssets('').assets, [], 'empty: an empty document yields zero assets, not a throw');
  eq(collectDocumentAssets(null).assets, [], 'empty: null input is handled');
  let t1 = false; try { docProvider().enumerate([], {}); } catch (_) { t1 = true; }
  ok(t1, 'fail-closed: a bare array is not a Collection');
  let t2 = false; try { docProvider().enumerate(collectionWith([{ documentUrl: 'x' }]), {}); } catch (_) { t2 = true; }
  ok(t2, 'fail-closed: a document entry with no assets array THROWS');
  let t3 = false; try { docProvider().enumerate(collectionWith([{ documentUrl: 'x', assets: [{ index: 0 }] }]), {}); } catch (_) { t3 = true; }
  ok(t3, 'fail-closed: an asset with no tag THROWS rather than being silently dropped');
})();

// ── 7 · layer boundary (ADR-0004 §D3/§D4) ─────────────────────────────────────────────────────────
(function boundary() {
  const fs = require('fs');
  const src = fs.readFileSync(require.resolve('../collectors/document.js'), 'utf8');
  const code = src.replace(/^\s*\/\/.*$/gm, '');
  ok(!/require\(.*(score|registry|finding|report|playwright)/.test(code), 'boundary: the collector imports no score, registry, finding, report or Playwright module');
  ok(!/severity|deduction|verdict/i.test(code), 'boundary: the collector contains no severity, deduction or verdict logic');
  const psrc = fs.readFileSync(require.resolve('./providers.js'), 'utf8');
  ok(!/require\(.*playwright/.test(psrc) && !/\bfs\.\w/.test(psrc), 'boundary: the provider touches neither Playwright nor the filesystem');
  const reg = require('../rules/registry'); const version = require('../version');
  eq(reg.RULES.length, 161, 'D9: registry rule count unchanged — ADR-0006 adds NO rule');
  eq(reg.REGISTRY_VERSION, '1.15.0', 'D9: registry version unmoved');
  // ADR-0011 note: this used to pin a version LITERAL, which made the test a SECOND AUTHORITY --
  // exactly the defect D6 eliminated, reintroduced here and exposed the moment ENGINE_VERSION
  // legitimately moved to 2.4.0. A test may assert the SHAPE of a stream and that it comes from the
  // authority; it must never re-declare the value.
  const SEMVER_ = /^\d+\.\d+(\.\d+)?$/;
  ok(SEMVER_.test(version.ENGINE_VERSION), 'D9: engine version unmoved (from the authority: ' + version.ENGINE_VERSION + ')');
  ok(SEMVER_.test(version.REPORT_VERSION), 'D9: report version unmoved (from the authority: ' + version.REPORT_VERSION + ')');
})();

// ── 8 · DIFFERENTIAL: PERF-005 is byte-identical to the pre-refactor implementation ───────────────
// A verbatim copy of the ORIGINAL render-blocking body, kept here as the oracle. If the refactored
// check ever diverges from it, this fails — which is the only thing that makes the refactor safe.
(function differential() {
  const attr = (tag, name) => { const m = tag.match(new RegExp('\\s' + name + '\\s*=\\s*["\']([^"\']*)["\']', 'i')); return m ? m[1] : null; };
  function ORIGINAL(c) {
    if (!c.isHtml) return null;
    const css = (c.head.match(/<link\b[^>]*rel\s*=\s*["']stylesheet["'][^>]*>/gi) || []).filter(t => !/\smedia\s*=\s*["']print/i.test(t));
    const js = (c.head.match(/<script\b[^>]*\ssrc\s*=[^>]*>/gi) || []).filter(t => !/\b(async|defer)\b/i.test(t) && !/type\s*=\s*["']module["']/i.test(t));
    const n = css.length + js.length;
    if (n < 4) return null;
    return {
      n, detail: `${css.length} blocking CSS + ${js.length} blocking JS in <head> — defer/async or inline critical CSS to speed first paint`,
      items: [
        ...css.map(t => ({ id: (attr(t, 'href') || 'stylesheet').split('/').pop().slice(0, 80), section: '<head> · blocking CSS', value: attr(t, 'href') || '' })),
        ...js.map(t => ({ id: (attr(t, 'src') || 'script').split('/').pop().slice(0, 80), section: '<head> · blocking JS', value: attr(t, 'src') || '' })),
      ],
    };
  }
  const live = STATIC_CHECKS.find(x => x.id === 'render-blocking');
  ok(!!live, 'differential: the live render-blocking check is reachable');

  // A corpus chosen to exercise the quirks, not just the happy path.
  const corpus = [
    ['rich head', DOC],
    ['below threshold', '<html><head><link rel="stylesheet" href="/a.css"><script src="/b.js"></script></head><body></body></html>'],
    ['exactly 4', '<html><head><link rel=stylesheet href="/a.css"><link rel="stylesheet" href="/b.css"><script src="/c.js"></script><script src="/d.js"></script></head><body></body></html>'],
    ['print media excluded', '<html><head><link rel="stylesheet" href="/p.css" media="print"><link rel="stylesheet" href="/a.css"><script src="/c.js"></script><script src="/d.js"></script><script src="/e.js"></script></head><body></body></html>'],
    ['async/defer/module excluded', '<html><head><script src="/a.js" async></script><script src="/b.js" defer></script><script type="module" src="/c.mjs"></script><link rel="stylesheet" href="/1.css"><link rel="stylesheet" href="/2.css"><link rel="stylesheet" href="/3.css"><link rel="stylesheet" href="/4.css"></head><body></body></html>'],
    // the QUIRK cases — a naive rewrite breaks exactly here
    ['filename contains "async"', '<html><head><script src="/vendor.async.min.js"></script><link rel="stylesheet" href="/1.css"><link rel="stylesheet" href="/2.css"><link rel="stylesheet" href="/3.css"></head><body></body></html>'],
    ['filename contains "defer"', '<html><head><script src="/defer-polyfill.js"></script><link rel="stylesheet" href="/1.css"><link rel="stylesheet" href="/2.css"><link rel="stylesheet" href="/3.css"></head><body></body></html>'],
    ['no head element at all', '<html><body><link rel="stylesheet" href="/a.css"><link rel="stylesheet" href="/b.css"><script src="/c.js"></script><script src="/d.js"></script></body></html>'],
    ['body assets must not count', '<html><head><link rel="stylesheet" href="/a.css"></head><body><script src="/1.js"></script><script src="/2.js"></script><script src="/3.js"></script><script src="/4.js"></script></body></html>'],
    ['no assets', '<html><head><title>t</title></head><body><p>x</p></body></html>'],
    ['unquoted rel', '<html><head><link rel=stylesheet href="/a.css"><link rel="stylesheet" href="/b.css"><script src="/c.js"></script><script src="/d.js"></script></head><body></body></html>'],
  ];
  let same = 0;
  for (const [name, html] of corpus) {
    const c = buildCtx({ url: 'https://s.example/x', body: html, status: 200, contentType: 'text/html', headers: {} }, 's.example');
    const oracle = ORIGINAL(c);
    const got = live.fn(c, { env: 'live', host: 's.example' });
    const gotShape = got ? { n: Number(got.value), detail: got.detail, items: (got.items || []).map(i => ({ id: i.id, section: i.section, value: i.value })) } : null;
    const match = JSON.stringify(oracle) === JSON.stringify(gotShape);
    ok(match, `differential[${name}]: refactored PERF-005 identical to the original` + (match ? '' : `\n      oracle: ${JSON.stringify(oracle)}\n      got:    ${JSON.stringify(gotShape)}`));
    if (match) same++;
  }
  ok(same === corpus.length, `differential: all ${corpus.length} corpus documents identical (${same}/${corpus.length})`);
})();

// ── 9 · REAL Chromium integration ─────────────────────────────────────────────────────────────────
(async function endToEnd() {
  let server, browser;
  try {
    server = http.createServer((req, res) => {
      if (req.url === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end('<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/a.css"><script src="/a.js"></script></head><body><img src="/i.png"><script>var d=document.createElement("script");d.src="/injected.js";document.body.appendChild(d);</script></body></html>');
      }
      if (req.url === '/a.css') { res.writeHead(200, { 'content-type': 'text/css' }); return res.end('body{a:1}'); }
      res.writeHead(200, { 'content-type': 'application/javascript' }); res.end('var x=1;');
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = 'http://127.0.0.1:' + server.address().port + '/';

    const { chromium } = require('playwright');
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(base, { waitUntil: 'networkidle', timeout: 30000 });
    const rendered = collectDocumentAssets(await page.content(), { documentUrl: base, source: 'rendered' });

    const inv = buildInventory(makeCollection({ documents: [rendered], collected: ['documents'] }), { idRegistry: new IdRegistry(), host: '127.0.0.1' });
    const srcs = inv.items.document.map(i => i.meta.src).filter(Boolean);
    ok(rendered.assets.length >= 5, `e2e: real Chromium DOM yielded ${rendered.assets.length} assets`);
    ok(srcs.includes('/a.js') && srcs.includes('/i.png'), `e2e: authored assets present (${srcs.join(' ')})`);
    ok(srcs.includes('/injected.js'), 'e2e: a JS-INJECTED script is in the rendered document — data the static parse cannot see');
    eq(rendered.source, 'rendered', 'e2e: source recorded as rendered, distinguishable from a static parse');
    ok(inv.items.document.some(i => i.meta.section === 'head') && inv.items.document.some(i => i.meta.section === 'body'), 'e2e: head/body preserved through a real DOM');
    ok(inv.counts.document >= 5, 'e2e: Collector → Collection → Provider → Inventory, end to end');
  } catch (e) {
    ok(false, 'e2e: real Chromium integration FAILED — ' + String((e && e.message) || e).slice(0, 160));
  } finally {
    if (browser) { try { await browser.close(); } catch (_) {} }
    if (server) { try { server.close(); } catch (_) {} }
  }

  console.log('\n' + (fail === 0 ? '✅ PASS' : '❌ FAIL') + ` — ${pass}/${pass + fail} assertions`);
  if (fail) { console.log('Failures:\n' + failures.map(f => '  - ' + f).join('\n')); process.exit(1); }
})();
