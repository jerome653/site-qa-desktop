'use strict';
// inventory/certify-pipeline.js — the ORCHESTRATOR (not a layer). Wires the frozen layers in order —
// Provider → Inventory → Comparison → Evidence → Certification → Reporting — for Tool 3 (Migration
// Certification). Each layer is called through its own module; none reaches across. Pure composition
// over inventory items; deterministic given the same crawl inputs + `at`.
const { buildInventory, IdRegistry } = require('./index');
const { compare } = require('./compare');
const { visualStage } = require('./visual-stage');
const { productionStage } = require('./audit-stage');
const { collectEvidence } = require('./evidence');
const { certify } = require('./certification');
const { renderMigrationReport } = require('./migration-report');

// v1.0.1 — collect screenshot-capture metadata (additive evidence) from the production audit + visual
// stages into one summary for the report. Purely descriptive; touches no certification logic.
function summarizeCapture(auditResult, visualResult) {
  const caps = [];
  try { const sh = (auditResult && auditResult.shots) || {}; for (const arr of Object.values(sh)) for (const s of (arr || [])) if (s.capture) caps.push({ context: 'production:' + s.label, ...s.capture }); } catch (_) {}
  try { for (const xb of ((auditResult && auditResult.xbrowser) || [])) if (xb.capture) caps.push({ context: 'cross-browser:' + xb.engine, ...xb.capture }); } catch (_) {}
  try { for (const pg of ((visualResult && visualResult.pages) || [])) for (const v of (pg.viewports || [])) { if (v.capture && v.capture.ref) caps.push({ context: 'visual-ref:' + v.label, ...v.capture.ref }); if (v.capture && v.capture.cand) caps.push({ context: 'visual-cand:' + v.label, ...v.capture.cand }); } } catch (_) {}
  if (!caps.length) return null;
  const dur = caps.map(c => c.captureDurationMs || 0);
  return {
    captureSchema: caps[0].captureSchema, engineVersion: caps[0].engineVersion, count: caps.length,
    allFontsLoaded: caps.every(c => c.fontsLoaded), allLazyPass: caps.every(c => c.lazyLoadPass), allImageDecode: caps.every(c => c.imageDecode),
    avgDurationMs: Math.round(dur.reduce((a, b) => a + b, 0) / caps.length),
    samples: caps.slice(0, 5).map(c => ({ context: c.context, browser: c.browser, viewport: c.viewport, captureMode: c.captureMode, fontsLoaded: c.fontsLoaded, lazyLoadPass: c.lazyLoadPass, imageDecode: c.imageDecode, documentHeight: c.documentHeight, captureDurationMs: c.captureDurationMs, capturedAt: c.capturedAt })),
  };
}

// certifyMigration(refPages, tgtPages, opts) — full frozen layer pipeline (Tool 3).
//   opts.visualResult  — output of visual-match run() (Phase 1: Visual Comparison stage)
//   opts.auditResult   — output of runAudit on the target (Phase 2: Production Validation stage)
//   opts.exceptions    — [{ relatedIds, reason, approver, date, evidence }] (Phase 4: Approved Exceptions)
function certifyMigration(refPages, tgtPages, opts = {}) {
  const at = opts.at || '';
  const idRegistry = opts.idRegistry || new IdRegistry(opts.persistPath || null);
  const refInv = buildInventory(refPages, { idRegistry, host: opts.sourceHost, target: opts.source });
  const tgtInv = buildInventory(tgtPages, { idRegistry, host: opts.targetHost, target: opts.target });

  // Comparison (completeness) — `capped` from either crawl downgrades "missing" to Manual Verification
  const diff = compare(refInv, tgtInv, { allowRemoved: opts.allowRemoved, capped: opts.capped, at });
  // Visual Comparison (Phase 1) — maps visual findings onto inventory items
  const visual = opts.visualResult ? visualStage(refInv, tgtInv, opts.visualResult, { at, matchThreshold: opts.matchThreshold, pixelThreshold: opts.pixelThreshold }) : { mapped: 0 };
  // Production Validation (Phase 2) — maps target audit findings onto inventory items
  const production = opts.auditResult ? productionStage(refInv, tgtInv, opts.auditResult, { at }) : { mapped: 0, orphan: 0 };
  // Evidence + Certification (consumes only inventory items + their cross-axis findings).
  // Target-only items participate too (Phase 6) — evidence + certification, never ignored.
  const ev = collectEvidence([...Object.values(refInv.items).flat(), ...diff.added], { at });
  const cert = certify(refInv, { at, exceptions: opts.exceptions, extraItems: diff.added });
  const captureEvidence = summarizeCapture(opts.auditResult, opts.visualResult);
  const report = renderMigrationReport(refInv, tgtInv, diff, cert, { source: opts.source, target: opts.target, generatedAt: at, visual, production, meta: opts.meta, captureEvidence });

  return { refInv, tgtInv, diff, visual, production, evidence: ev, cert, report };
}

module.exports = { certifyMigration };
