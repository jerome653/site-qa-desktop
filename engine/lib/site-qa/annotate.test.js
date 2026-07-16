'use strict';
// annotate.test.js — Run: node annotate.test.js  (exit 0 = 100% pass).
// Proves the Site Comparison annotation layer: normalised-coordinate sanitation, the disk
// round-trip, the {domain}-{date}-v{n} filename rule, and — the load-bearing one — that the red
// pixel-diff overlay can NEVER reach the PDF export model or the rendered document.
const fs = require('fs');
const os = require('os');
const path = require('path');
const A = require('./annotate');
const { render } = require('./report-annotate');

let fails = 0, total = 0;
const ok = (cond, msg) => { total++; if (!cond) { console.error('  FAIL:', msg); fails++; } };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sgen-annotate-test-'));

// ---- keys ---------------------------------------------------------------------------------------
ok(A.annKey('/', '1920 · Desktop', 'ref') === '/||1920 · Desktop||ref', 'annKey shape');
ok(A.annKey('/', '1920 · Desktop', 'ref') !== A.annKey('/', '1920 · Desktop', 'cand'), 'panes key apart — a live mark cannot land on staging');

// ---- sanitation ---------------------------------------------------------------------------------
const dirty = {
  items: {
    '/||vp||ref': {
      marks: [
        { id: 'm1', type: 'pen', color: '#E01F26', points: [[0.5, 0.5], [2.5, -3], ['x', null]] }, // clamps
        { id: 'm2', type: 'pen', points: [] },                                                     // dropped: no geometry
        { id: 'm3', type: 'bogus', color: 'javascript:alert(1)', points: [[0.2, 0.2]] },           // type+color fall back
      ],
      comments: [
        { id: 'c1', text: 'real note', x: 5, y: -5 },   // clamps
        { id: 'c2', text: '   ' },                      // dropped: empty
      ],
    },
    '/||vp||cand': { marks: [], comments: [] },         // dropped: empty bucket
  },
};
const clean = A.sanitizeAnnotations(dirty);
const b = clean.items['/||vp||ref'];
ok(b.marks.length === 2, 'empty-geometry mark dropped (got ' + b.marks.length + ')');
ok(b.marks[0].points.every(p => p[0] >= 0 && p[0] <= 1 && p[1] >= 0 && p[1] <= 1), 'coords clamped into 0..1');
ok(b.marks[0].points[1][0] === 1 && b.marks[0].points[1][1] === 0, 'out-of-range clamps to the edge, not to garbage');
ok(b.marks[1].type === 'pen', 'unknown mark type falls back to pen');
ok(b.marks[1].color === '#E01F26', 'non-hex color rejected (no injection into the stroke attr)');
ok(b.comments.length === 1 && b.comments[0].text === 'real note', 'blank comment dropped');
ok(b.comments[0].x === 1 && b.comments[0].y === 0, 'comment anchor clamped');
ok(!clean.items['/||vp||cand'], 'empty bucket not persisted');
ok(A.sanitizeAnnotations(null).items && Object.keys(A.sanitizeAnnotations(null).items).length === 0, 'null input is a clean empty store');
ok(A.sanitizeAnnotations({ items: [] }).items && !Array.isArray(A.sanitizeAnnotations({ items: [] }).items), 'array items rejected');

// ---- persistence round-trip ---------------------------------------------------------------------
const runDir = path.join(TMP, 'run-1');
fs.mkdirSync(runDir, { recursive: true });
ok(Object.keys(A.loadAnnotations(runDir).items).length === 0, 'missing file loads as empty, not a throw');
A.saveAnnotations(runDir, dirty);
ok(fs.existsSync(path.join(runDir, 'annotations.json')), 'annotations.json written next to the run');
const reloaded = A.loadAnnotations(runDir);
ok(reloaded.items['/||vp||ref'].marks.length === 2, 'marks survive the disk round-trip');
ok(reloaded.items['/||vp||ref'].comments[0].text === 'real note', 'comment text survives the disk round-trip');
ok(reloaded.items['/||vp||ref'].marks[0].points[0][0] === 0.5, 'exact normalised coord survives the round-trip');
const counts = A.countAnnotations(reloaded);
ok(counts.marks === 2 && counts.comments === 1, 'countAnnotations: ' + JSON.stringify(counts));
// edit + delete are just a re-save of the whole store
const edited = JSON.parse(JSON.stringify(reloaded));
edited.items['/||vp||ref'].comments[0].text = 'edited note';
edited.items['/||vp||ref'].marks.pop();
A.saveAnnotations(runDir, edited);
const r2 = A.loadAnnotations(runDir);
ok(r2.items['/||vp||ref'].comments[0].text === 'edited note', 'comment edit persists');
ok(r2.items['/||vp||ref'].marks.length === 1, 'mark delete persists');

// ---- filename rule: {domain}-{YYYY-MM-DD}-v{n}.pdf ----------------------------------------------
const exp = path.join(TMP, '_exports');
fs.mkdirSync(exp, { recursive: true });
ok(A.domainOf('https://www.sgen.com/about?x=1') === 'sgen.com', 'domainOf strips www + path');
ok(A.domainOf('sgen.com') === 'sgen.com', 'domainOf tolerates a bare host');
ok(/^\d{4}-\d{2}-\d{2}$/.test(A.todayStamp()), 'todayStamp is YYYY-MM-DD');
ok(A.todayStamp(new Date(2026, 6, 15)) === '2026-07-15', 'todayStamp formats a known date');
const D = '2026-07-15';
const v1 = A.nextExportName(exp, 'sgen.com', D);
ok(v1.name === 'sgen.com-2026-07-15-v1.pdf' && v1.version === 1, 'first export is v1: ' + v1.name);
fs.writeFileSync(path.join(exp, v1.name), 'x');
const v2 = A.nextExportName(exp, 'sgen.com', D);
ok(v2.name === 'sgen.com-2026-07-15-v2.pdf' && v2.version === 2, 'second export is v2: ' + v2.name);
fs.writeFileSync(path.join(exp, v2.name), 'x');
ok(A.nextExportName(exp, 'sgen.com', D).version === 3, 'third export is v3 — nothing overwritten');
ok(A.nextExportName(exp, 'other.com', D).version === 1, 'a different domain starts its own v1');
ok(A.nextExportName(exp, 'sgen.com', '2026-07-16').version === 1, 'a different date starts its own v1');
// a gap (v1, v5) must not hand back a name that already exists
fs.writeFileSync(path.join(exp, 'gap.com-2026-07-15-v5.pdf'), 'x');
ok(A.nextExportName(exp, 'gap.com', D).version === 6, 'versioning takes max+1, never refills a gap');
ok(A.nextExportName(path.join(TMP, 'nope'), 'sgen.com', D).version === 1, 'missing export dir => v1, not a throw');

// ---- export model: two panes, and NO red diff overlay --------------------------------------------
const DIFF_FILE = 'home--visual-match--diff--1920-desktop.png';
const visualData = {
  reference: 'https://www.sgen.com', candidate: 'https://staging.sgen.com', overall: 91.2,
  pages: [{
    path: '/', ref: 'https://www.sgen.com/', cand: 'https://staging.sgen.com/', pageScore: 91.2,
    viewports: [{
      label: '1920 · Desktop', matchScore: 91.2, pixelMismatchPct: 8.8,
      // exactly the shape visual-match.js emits — diff included, as it is on a real run
      shots: { ref: 'shots/home--visual-match--reference--1920-desktop.png', cand: 'shots/home--visual-match--candidate--1920-desktop.png', diff: 'shots/' + DIFF_FILE },
      struct: { missing: [], extra: [], moved: [], restyled: [], matched: 10, refCount: 10 },
    }, {
      label: '414 · iPhone XR/11', matchScore: 88, shots: { ref: 'shots/a.png', cand: 'shots/b.png', diff: 'shots/c-diff.png' },
      struct: { missing: [], extra: [], moved: [], restyled: [], matched: 9, refCount: 10 },
    }],
  }],
};
const annForModel = A.sanitizeAnnotations({
  items: { [A.annKey('/', '1920 · Desktop', 'cand')]: { marks: [{ id: 'm9', type: 'highlight', color: '#FFD400', points: [[0.1, 0.1], [0.6, 0.12]] }], comments: [{ id: 'c9', markId: 'm9', text: 'Hero headline is wrong here', x: 0.6, y: 0.12 }] } },
});
const model = A.buildExportModel(visualData, annForModel);
const modelJson = JSON.stringify(model);

ok(model.domain === 'sgen.com', 'model domain from the reference host: ' + model.domain);
ok(model.pages[0].viewports[0].panes.length === 2, 'exactly two panes per viewport (got ' + model.pages[0].viewports[0].panes.length + ')');
ok(model.pages[0].viewports[0].panes[0].pane === 'ref' && model.pages[0].viewports[0].panes[1].pane === 'cand', 'panes are live then staging, in that order');
ok(!modelJson.includes(DIFF_FILE), 'THE RULE: the diff filename is absent from the export model');
ok(!modelJson.includes('c-diff.png'), 'THE RULE: no diff shot from any viewport reaches the model');
ok(!/"diff"/.test(modelJson), 'THE RULE: the model carries no "diff" key at all');
ok(model.pages[0].viewports[0].panes[1].marks.length === 1, 'marks land on the pane they were drawn on (cand)');
ok(model.pages[0].viewports[0].panes[0].marks.length === 0, 'the other pane (ref) stays clean');
ok(model.pages[0].viewports[0].annotationCount === 2, '1 mark + 1 comment counted');
ok(model.totals.sheets === 2 && model.totals.annotations === 2, 'totals: ' + JSON.stringify(model.totals));

// onlyAnnotated drops the untouched viewport
const only = A.buildExportModel(visualData, annForModel, { onlyAnnotated: true });
ok(only.totals.sheets === 1, 'onlyAnnotated keeps just the annotated sheet (got ' + only.totals.sheets + ')');
ok(only.pages[0].viewports[0].label === '1920 · Desktop', 'onlyAnnotated kept the right sheet');
const none = A.buildExportModel(visualData, { items: {} }, { onlyAnnotated: true });
ok(none.totals.sheets === 0 && none.pages.length === 0, 'onlyAnnotated with no annotations yields nothing to export');

// win32 backslashes normalise for the browser
const winData = JSON.parse(JSON.stringify(visualData));
winData.pages[0].viewports[0].shots = { ref: 'shots\\a.png', cand: 'shots\\b.png', diff: 'shots\\d.png' };
ok(A.buildExportModel(winData, { items: {} }).pages[0].viewports[0].panes[0].shot === 'shots/a.png', 'backslash shot paths normalise to /');

// ---- rendered document: the diff must not appear there either -----------------------------------
for (const mode of ['live', 'print']) {
  const html = render(model, annForModel, { mode, runId: 'sgen-com-vis-1' });
  ok(!html.includes(DIFF_FILE), 'THE RULE: diff filename absent from the ' + mode + ' document');
  ok(!html.includes('c-diff.png'), 'THE RULE: no diff shot in the ' + mode + ' document');
  ok(!/Difference overlay/i.test(html), 'THE RULE: no "Difference overlay" caption in the ' + mode + ' document');
  ok(html.includes('reference--1920-desktop.png'), 'the live pane shot IS in the ' + mode + ' document');
  ok(html.includes('candidate--1920-desktop.png'), 'the staging pane shot IS in the ' + mode + ' document');
  ok(html.includes('Hero headline is wrong here'), 'the comment text is baked into the ' + mode + ' document');
  ok(html.includes('<base href="/annotate/sgen-com-vis-1/">'), '<base> present in ' + mode + ' so relative shots resolve');
}
const printHtml = render(model, annForModel, { mode: 'print', runId: 'r' });
ok(!printHtml.includes('class="tb"'), 'print mode drops the toolbar');
ok(printHtml.includes('break-after:page'), 'print mode forces one sheet per PDF page');
ok(printHtml.includes('sgen.com'), 'print cover carries the domain');
const liveHtml = render(model, annForModel, { mode: 'live', runId: 'r' });
ok(liveHtml.includes('class="tb"'), 'live mode keeps the toolbar');
ok(liveHtml.includes('/api/annotations'), 'live mode wires autosave to the persistence endpoint');
// REGRESSION GUARD. save() once did `ANN=d.annotations||ANN`, re-seating the whole store from the
// POST response. Every click handler that had captured a bucket was then holding an orphan, so
// "Delete note" spliced a detached array and the next save re-POSTed the note it had just removed.
// Only driving the real UI caught it. This is a static guard because the bug lives in client JS
// that node cannot execute here.
ok(!/ANN\s*=\s*d\.annotations/.test(liveHtml), 'save() must not re-seat ANN from its own response (stale-closure delete bug)');

// a script-injection attempt in a comment must not break out of the JSON <script> block
const evil = A.sanitizeAnnotations({ items: { [A.annKey('/', '1920 · Desktop', 'ref')]: { marks: [], comments: [{ id: 'x', text: '</script><img src=x onerror=alert(1)>', x: 0.1, y: 0.1 }] } } });
const evilHtml = render(A.buildExportModel(visualData, evil), evil, { mode: 'print', runId: 'r' });
ok(!/<\/script><img/.test(evilHtml), 'comment text cannot close the script block');

fs.rmSync(TMP, { recursive: true, force: true });

if (fails) { console.error(`❌ FAIL — ${total - fails}/${total} assertions`); process.exit(1); }
console.log(`✅ PASS — ${total}/${total} assertions`);
