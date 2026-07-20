'use strict';
// annotate.js — the annotation store + PDF export model for the Site Comparison tool (tab `visual`).
//
// Scope, verbatim from the spec: "for the pdf export I only need live and staging comparison — NOT
// the 3rd image with red shades". So this module reads ONLY shots.ref (live) and shots.cand
// (staging) out of a visual-match run. `shots.diff` — the red pixel-mismatch overlay produced by
// visual-match.js pixelDiff() and rendered by report-visual.js as "Difference overlay" — is never
// read here. buildExportModel() is the single funnel every export goes through, so that exclusion is
// structural, not a matter of remembering to leave it out downstream. annotate.test.js asserts it.
//
// Coordinates are NORMALISED 0..1 against the screenshot's own box, so a mark drawn on a 1920x8400
// full-page capture lands in the same spot when the PDF scales that capture down to fit A4
// landscape. Nothing stores pixels.
//
// Persistence sits next to the run (RUNS/<id>/annotations.json) — the run dir already owns the
// shots the marks point at, so annotations travel with the evidence they annotate.

const fs = require('fs');
const path = require('path');

const ANN_VERSION = 1;
const ANN_FILE = 'annotations.json';
const EXPORTS_DIRNAME = '_exports';  // '_' prefix => listRuns() in sgen-qa-serve.js skips it

const MARK_TYPES = { pen: 1, highlight: 1 };

// ---- keys ---------------------------------------------------------------------------------------
// A mark belongs to ONE screenshot: this page, at this viewport, in this pane. The pane segment is
// what makes "anchor to the screenshot they were drawn on" true — a mark on the live pane can never
// bleed onto staging.
function annKey(pagePath, viewportLabel, pane) {
  return `${pagePath}||${viewportLabel}||${pane}`;
}

// ---- sanitize -----------------------------------------------------------------------------------
const clamp01 = (n) => { const v = Number(n); return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0; };
const str = (s, max) => String(s == null ? '' : s).slice(0, max);

function sanitizeMark(m) {
  if (!m || typeof m !== 'object') return null;
  const type = MARK_TYPES[m.type] ? m.type : 'pen';
  const pts = Array.isArray(m.points) ? m.points : [];
  const points = pts
    .filter(p => Array.isArray(p) && p.length >= 2)
    .slice(0, 4000)                                  // a scribble is bounded; a runaway array is not
    .map(p => [clamp01(p[0]), clamp01(p[1])]);
  if (!points.length) return null;                   // a mark with no geometry is not a mark
  return {
    id: str(m.id, 40) || ('m' + Math.random().toString(36).slice(2, 10)),
    type,
    color: /^#[0-9a-f]{6}$/i.test(String(m.color || '')) ? m.color : '#E01F26',
    width: Math.max(0.0005, Math.min(0.06, Number(m.width) || (type === 'highlight' ? 0.018 : 0.004))),
    points,
  };
}

function sanitizeComment(c) {
  if (!c || typeof c !== 'object') return null;
  const text = str(c.text, 2000).trim();
  if (!text) return null;                            // an empty comment is a delete, not a save
  return {
    id: str(c.id, 40) || ('c' + Math.random().toString(36).slice(2, 10)),
    markId: c.markId ? str(c.markId, 40) : null,
    text,
    x: clamp01(c.x), y: clamp01(c.y),
    created: str(c.created, 40) || new Date().toISOString(),
    updated: str(c.updated, 40) || new Date().toISOString(),
  };
}

// Accepts whatever the browser POSTs and returns a store we are willing to write to disk.
// Drops unknown keys, clamps every coordinate, and discards empty entries.
function sanitizeAnnotations(raw) {
  const out = { version: ANN_VERSION, updated: new Date().toISOString(), items: {} };
  const items = (raw && typeof raw === 'object' && raw.items && typeof raw.items === 'object' && !Array.isArray(raw.items)) ? raw.items : {};
  for (const k of Object.keys(items)) {
    if (typeof k !== 'string' || k.length > 400) continue;
    const it = items[k];
    if (!it || typeof it !== 'object') continue;
    const marks = (Array.isArray(it.marks) ? it.marks : []).map(sanitizeMark).filter(Boolean).slice(0, 500);
    const comments = (Array.isArray(it.comments) ? it.comments : []).map(sanitizeComment).filter(Boolean).slice(0, 500);
    if (!marks.length && !comments.length) continue; // don't persist empty buckets
    out.items[k] = { marks, comments };
  }
  return out;
}

// ---- store --------------------------------------------------------------------------------------
function loadAnnotations(runDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(runDir, ANN_FILE), 'utf8'));
    // Re-sanitize on read: a hand-edited or older file can't inject bad geometry into a render.
    return sanitizeAnnotations(raw);
  } catch (_) { return { version: ANN_VERSION, updated: null, items: {} }; }
}

function saveAnnotations(runDir, raw) {
  const clean = sanitizeAnnotations(raw);
  fs.mkdirSync(runDir, { recursive: true });
  // Write-then-rename so a crash mid-write can't truncate an existing annotation set.
  const dst = path.join(runDir, ANN_FILE);
  const tmp = dst + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(clean, null, 2));
  fs.renameSync(tmp, dst);
  return clean;
}

function countAnnotations(ann) {
  let marks = 0, comments = 0;
  for (const k of Object.keys((ann && ann.items) || {})) {
    marks += (ann.items[k].marks || []).length;
    comments += (ann.items[k].comments || []).length;
  }
  return { marks, comments, keys: Object.keys((ann && ann.items) || {}).length };
}

// ---- export naming ------------------------------------------------------------------------------
// "{domain}-{YYYY-MM-DD}-v{n}.pdf", n auto-incrementing per domain+date. The scan is by domain+date
// (NOT per run) because that is the rule as stated: a second export for the same site on the same
// day is v2 even if it came from a different comparison run. Nothing is ever overwritten.
function domainOf(url) {
  let h = String(url || '').trim();
  try { h = new URL(/^https?:\/\//i.test(h) ? h : 'https://' + h).host; } catch (_) {}
  return h.replace(/^www\./i, '').replace(/[^a-z0-9.-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'site';
}

function todayStamp(d) {
  const dt = d instanceof Date ? d : new Date();
  const p = n => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;  // local date — matches the operator's calendar
}

function nextExportName(dir, domain, date) {
  let max = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      const m = f.match(/^(.+)-(\d{4}-\d{2}-\d{2})-v(\d+)\.pdf$/i);
      if (m && m[1].toLowerCase() === String(domain).toLowerCase() && m[2] === date) max = Math.max(max, parseInt(m[3], 10) || 0);
    }
  } catch (_) { /* dir may not exist yet — first export is v1 */ }
  return { name: `${domain}-${date}-v${max + 1}.pdf`, version: max + 1 };
}

// ---- export model -------------------------------------------------------------------------------
// The ONLY path from a visual-match result to anything exportable. Reads shots.ref + shots.cand and
// nothing else — see the header note on the deliberate diff exclusion.
function buildExportModel(data, ann, opts = {}) {
  const items = (ann && ann.items) || {};
  const onlyAnnotated = !!opts.onlyAnnotated;
  const fwd = (s) => (s ? String(s).replace(/\\/g, '/') : null);   // win32 path.relative emits '\'

  const bucket = (pagePath, vpLabel, pane) => {
    const it = items[annKey(pagePath, vpLabel, pane)] || {};
    return { marks: it.marks || [], comments: it.comments || [] };
  };

  // The pane list is data-driven so a ONE-pane source can reuse this whole path. A visual-match run
  // supplies no spec and gets exactly the pair it always got — same panes, same order, same keys —
  // so its output is unchanged. `v.shots.diff` is still never read, by either spec.
  const spec = (Array.isArray(data.paneSpec) && data.paneSpec.length) ? data.paneSpec : [
    { pane: 'ref',  title: 'REFERENCE · live',    urlKey: 'ref' },
    { pane: 'cand', title: 'CANDIDATE · staging', urlKey: 'cand' },
  ];

  const pages = [];
  for (const p of (data.pages || [])) {
    const viewports = [];
    for (const v of (p.viewports || [])) {
      const buckets = spec.map(s => bucket(p.path, v.label, s.pane));
      const n = buckets.reduce((a, b) => a + b.marks.length + b.comments.length, 0);
      if (onlyAnnotated && !n) continue;
      viewports.push({
        label: v.label,
        matchScore: v.matchScore,
        annotationCount: n,
        panes: spec.map((s, i) => ({
          pane: s.pane,
          title: s.title,
          url: p[s.urlKey || s.pane] || null,
          shot: fwd(v.shots && v.shots[s.pane]),
          marks: buckets[i].marks,
          comments: buckets[i].comments,
        })),
      });
    }
    if (!viewports.length) continue;
    pages.push({ path: p.path, ref: p.ref, cand: p.cand, pageScore: p.pageScore, viewports });
  }

  const totals = pages.reduce((a, p) => {
    for (const v of p.viewports) { a.sheets++; a.annotations += v.annotationCount; }
    return a;
  }, { sheets: 0, annotations: 0 });

  return {
    reference: data.reference, candidate: data.candidate,
    domain: domainOf(data.reference),
    overall: data.overall,
    mode: data.mode === 'audit' ? 'audit' : 'compare',   // cover copy only; sheets are identical
    generated: new Date().toISOString(),
    onlyAnnotated,
    pages, totals,
  };
}

// ---- Site Audit adapter -------------------------------------------------------------------------
// Annotate was Site-Comparison-only: a Site Audit run has ONE screenshot per page+viewport rather
// than a live/staging PAIR, so it could not be fed through the two-pane model and /annotate/<id>
// answered "comparison run not found" for every audit. Reported as "the annotate options we got and
// export pdf is not working" — the option simply was not offered on the tool being used.
//
// This reshapes an audit report.json into the SAME `data` contract buildExportModel consumes, with a
// one-pane spec. Everything downstream — the annotation store, the key format, the sanitizer, the
// live page, the print body and the PDF exporter — is reused untouched. No second implementation of
// any of it, and nothing about the comparison path changes.
//
// Only FULL-PAGE shots become sheets. A run also carries per-issue element close-ups (measured on a
// real 15-page run: 114 close-ups vs 47 full-page shots), and turning each into its own markup sheet
// would bury the pages the operator actually wants to draw on. Close-ups stay attached to their
// findings in the report, where they already are and where they make sense.
function auditToModelData(report, runDir) {
  // report.json stores ABSOLUTE screenshot paths, and the annotate page can only serve files from
  // INSIDE the run dir (serveAnnotateAsset joins RUNS/<id>/<rest> and refuses anything that escapes).
  // So a run that has been copied or moved — the normal life of a report you are marking up to send
  // on — produced paths resolving outside the run, which Chromium then blocked as file:/// URLs:
  // 47 sheets, every image dead. Measured against a real run copied to a second location.
  // Resolve relative first; if that escapes, fall back to the file's own name under screenshots/,
  // which is where the capture always writes it. Both are inside the run, so both are servable.
  const relShot = (f) => {
    try {
      const r = path.relative(runDir, f).replace(/\\/g, '/');
      if (r && !r.startsWith('..') && !path.isAbsolute(r)) return r;
    } catch (_) {}
    const base = String(f || '').replace(/\\/g, '/').split('/').pop();
    if (!base) return null;
    try { if (fs.existsSync(path.join(runDir, 'screenshots', base))) return 'screenshots/' + base; } catch (_) {}
    return null;
  };
  const pathOf = (u) => { try { const x = new URL(u); return x.pathname === '/' ? '/' : x.pathname; } catch (e) { return String(u || '/'); } };
  const pages = [];
  for (const [url, arr] of Object.entries((report && report.shots) || {})) {
    const viewports = [];
    for (const s of (Array.isArray(arr) ? arr : [])) {
      if (!s || s.issue || !s.file) continue;              // close-ups carry `issue`; skip them
      const shot = relShot(s.file);
      if (!shot) continue;                                 // no servable file => no sheet, rather than an empty pane
      viewports.push({ label: s.label, matchScore: null, shots: { shot } });
    }
    if (!viewports.length) continue;
    pages.push({ path: pathOf(url), ref: url, cand: null, pageScore: null, viewports });
  }
  pages.sort((a, b) => a.path.localeCompare(b.path));
  return {
    mode: 'audit',
    reference: report.target || (report.host ? 'https://' + report.host + '/' : ''),
    candidate: null,
    overall: (report.quality && report.quality.overall != null) ? report.quality.overall : (report.score != null ? report.score : null),
    paneSpec: [{ pane: 'shot', title: 'SCREENSHOT', urlKey: 'ref' }],
    pages,
  };
}

module.exports = {
  ANN_VERSION, ANN_FILE, EXPORTS_DIRNAME,
  annKey, sanitizeMark, sanitizeComment, sanitizeAnnotations,
  loadAnnotations, saveAnnotations, countAnnotations,
  domainOf, todayStamp, nextExportName, buildExportModel, auditToModelData,
};
