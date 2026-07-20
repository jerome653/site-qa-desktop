'use strict';
// annotate-audit.test.js — annotate works on a SITE AUDIT run, and the comparison path is untouched.
//
// WHAT THIS PINS. Annotate used to resolve only visual-match.json, so every Site Audit run — which is
// most runs — answered "comparison run not found" and the feature read as broken rather than absent.
// An audit has ONE screenshot per page+viewport instead of a live/staging PAIR, so it is reshaped
// into the same model contract and reuses the store, sanitizer, renderer and PDF exporter unchanged.
// Two things must therefore stay true forever: the audit shape produces one-pane sheets with
// SERVABLE image paths, and feeding a comparison run through the now-data-driven pane list still
// yields byte-identical two-pane output.

const fs = require('fs');
const os = require('os');
const path = require('path');
const annotate = require('./annotate');

let n = 0, bad = 0;
const ok = (c, m) => { n++; if (c) return; bad++; console.error('  FAIL: ' + m); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'annot-audit-'));
const shotsDir = path.join(tmp, 'screenshots');
fs.mkdirSync(shotsDir, { recursive: true });
const touch = (nm) => { const f = path.join(shotsDir, nm); fs.writeFileSync(f, ''); return f; };
const inside = touch('home--page--full--1280.png');
const alsoInside = touch('about--page--full--1280.png');
const moved = 'C:/some/other/place/_ui-runs/old-run/screenshots/home--page--full--1280.png'; // same basename
const gone = 'C:/some/other/place/screenshots/not-here-at-all.png';

const REPORT = {
  target: 'https://example.test/', host: 'example.test',
  quality: { overall: 61 }, score: 55,
  shots: {
    'https://example.test/': [
      { label: '1280 · xl boundary', file: inside },
      { label: '1280 · xl boundary', file: inside, issue: 'element-wider-than-viewport', component: 'div#x' },
      { label: '768 · md boundary', file: moved },
      { label: '1024 · lg boundary', file: gone },
    ],
    'https://example.test/about': [{ label: '1280 · xl boundary', file: alsoInside }],
  },
};

// ── 1) the audit shape ──────────────────────────────────────────────────────────────────────────
const data = annotate.auditToModelData(REPORT, tmp);
ok(data.mode === 'audit', 'mode is audit (drives the cover copy, not the sheets)');
ok(data.candidate === null, 'an audit has no candidate — nothing to compare against');
ok(data.overall === 61, 'overall prefers the quality score');
ok(Array.isArray(data.paneSpec) && data.paneSpec.length === 1, 'the audit pane spec is ONE pane');

const home = data.pages.find(p => p.path === '/');
ok(!!home, 'the homepage becomes a page');
ok(data.pages.length === 2, 'both audited URLs become pages');
ok(data.pages[0].path === '/' && data.pages[1].path === '/about', 'pages are sorted by path (stable order)');

// ── 2) per-issue close-ups are NOT sheets ───────────────────────────────────────────────────────
// A real 15-page run carried 114 close-ups against 47 full-page shots; one markup sheet per close-up
// would bury the pages the operator actually wants to draw on.
ok(home.viewports.length === 2, 'close-ups are excluded, and an unresolvable shot drops its sheet — 2 left, got ' + home.viewports.length);
ok(!home.viewports.some(v => /not-here-at-all/.test(v.shots.shot || '')), 'a shot with no servable file produces no sheet');

// ── 3) image paths must be SERVABLE — relative, inside the run ───────────────────────────────────
// The annotate page can only serve RUNS/<id>/<rest>; an absolute or escaping path renders as a
// blocked file:/// URL. Measured before the fix on a copied run: 47 sheets, every image dead.
for (const v of home.viewports) {
  const s = v.shots.shot;
  ok(typeof s === 'string' && s.length > 0, 'the sheet carries a shot path');
  ok(!path.isAbsolute(s) && !s.startsWith('..') && !/^[a-z]:/i.test(s), 'the path is run-relative, not absolute/escaping: ' + s);
}
const movedSheet = home.viewports.find(v => v.label === '768 · md boundary');
ok(movedSheet && movedSheet.shots.shot === 'screenshots/home--page--full--1280.png',
   'a run copied away from its original location still resolves by basename under screenshots/');

// ── 4) through buildExportModel: ONE pane, and it carries the page URL ──────────────────────────
const model = annotate.buildExportModel(data, { items: {} }, {});
ok(model.mode === 'audit', 'the model keeps the audit mode');
ok(model.totals.sheets === 3, 'sheet count = full-page shots that resolved (3), got ' + model.totals.sheets);
const sheet = model.pages[0].viewports[0];
ok(sheet.panes.length === 1, 'an audit sheet has exactly ONE pane');
ok(sheet.panes[0].pane === 'shot', 'the pane key is "shot" — its own annotation namespace');
ok(sheet.panes[0].url === 'https://example.test/', 'the pane shows the audited page URL');

// ── 5) marks bind to the audit pane through the SAME key format ────────────────────────────────
const key = annotate.annKey('/', '1280 · xl boundary', 'shot');
const withMark = annotate.buildExportModel(data, { items: { [key]: { marks: [{ id: 'm1' }], comments: [] } } }, {});
ok(withMark.pages[0].viewports[0].annotationCount === 1, 'a mark on an audit sheet is counted');
ok(withMark.pages[0].viewports[0].panes[0].marks.length === 1, 'and reaches its pane');
const onlyAnn = annotate.buildExportModel(data, { items: { [key]: { marks: [{ id: 'm1' }], comments: [] } } }, { onlyAnnotated: true });
ok(onlyAnn.totals.sheets === 1, 'onlyAnnotated narrows an audit export to the marked sheet');

// ── 6) REGRESSION: the comparison path is unchanged by the data-driven pane list ────────────────
const cmp = {
  reference: 'https://live.test/', candidate: 'https://staging.test/', overall: 97,
  pages: [{ path: '/', ref: 'https://live.test/', cand: 'https://staging.test/', pageScore: 97,
    viewports: [{ label: '1920 · Desktop', matchScore: 97, shots: { ref: 'shots/a.png', cand: 'shots/b.png', diff: 'shots/d.png' } }] }],
};
const cm = annotate.buildExportModel(cmp, { items: {} }, {});
const cv = cm.pages[0].viewports[0];
ok(cm.mode === 'compare', 'a comparison run is still mode=compare');
ok(cv.panes.length === 2, 'a comparison sheet still has exactly TWO panes');
ok(cv.panes[0].pane === 'ref' && cv.panes[1].pane === 'cand', 'pane order is still ref then cand');
ok(cv.panes[0].title === 'REFERENCE · live' && cv.panes[1].title === 'CANDIDATE · staging', 'pane titles unchanged');
ok(cv.panes[0].shot === 'shots/a.png' && cv.panes[1].shot === 'shots/b.png', 'panes still read shots.ref and shots.cand');
ok(cv.panes[0].url === 'https://live.test/' && cv.panes[1].url === 'https://staging.test/', 'panes still carry their own URLs');
ok(!JSON.stringify(cm).includes('shots/d.png'), 'the diff overlay is STILL never read — the deliberate exclusion survives');

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
console.log((bad ? 'FAIL' : 'PASS') + ' annotate-audit.test.js — ' + (n - bad) + '/' + n + ' assertions');
if (bad) process.exit(1);
