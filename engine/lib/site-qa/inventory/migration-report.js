'use strict';
// inventory/migration-report.js — the Reporting layer. Generates the migration report from ACTUAL
// runtime data (inventories + comparison + evidence + certification). Every finding links back to its
// Inventory ID, evidence, and lifecycle. Self-contained HTML + JSON.
const { meta } = require('./versions');
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function buildJson(refInv, tgtInv, diff, cert, opts) {
  const t = cert.tally;
  const total = t.passed + t.warning + t.failed + t.manual + t.approved;
  const migrationConfidence = total ? Math.round(100 * (t.passed + t.approved) / total) : 100;
  // axis summary — findings grouped by axis (completeness/visual/production/seo/a11y/responsive/…)
  const axisSummary = {};
  for (const e of cert.explanations) { const a = axisSummary[e.axis || 'completeness'] = axisSummary[e.axis || 'completeness'] || { blocking: 0, advisory: 0, manual: 0 }; a[e.severity] = (a[e.severity] || 0) + 1; }
  const allItems = Object.values(refInv.items).flat();
  const evidenceIndex = allItems.filter(i => i.evidence).length + allItems.reduce((n, i) => n + (i.findings || []).filter(f => f.evidence).length, 0);
  const manualItems = allItems.filter(i => i.certificationState === 'MANUAL').map(i => ({ id: i.id, type: i.type, identityKey: i.identityKey }));
  // viewport results (Phase 7) — findings aggregated per canonical SGEN breakpoint
  const viewportResults = {};
  for (const e of cert.explanations) if (e.viewport) { const v = viewportResults[e.viewport] = viewportResults[e.viewport] || { blocking: 0, advisory: 0, manual: 0 }; v[e.severity] = (v[e.severity] || 0) + 1; }
  return {
    metadata: meta({ ...(opts.meta || {}), at: opts.generatedAt }), // Phase 5 · version governance
    generatedAt: opts.generatedAt || '',
    source: opts.source, target: opts.target,
    verdict: cert.verdict,
    viewportResults,
    migrationConfidence,           // informational
    tally: cert.tally,
    axisSummary,
    stages: { completenessFindings: diff.missing.length, visualFindings: (opts.visual && opts.visual.mapped) || 0, productionFindings: (opts.production && opts.production.mapped) || 0 },
    inventorySummary: diff.perType,
    gates: cert.gates,
    evidenceIndex,
    captureEvidence: opts.captureEvidence || null, // v1.0.1 — additive screenshot-capture metadata
    findings: cert.explanations.map(e => ({ ...e })),
    approvedExceptions: (cert.exceptions || []).map(x => ({ relatedIds: x.relatedIds, reason: x.reason, approver: x.approver, date: x.date, evidence: x.evidence || null })),
    manualItems,
    added: diff.added.map(i => ({ id: i.id, type: i.type, identityKey: i.identityKey })),
    // every inventory item with its lifecycle + evidence, so the report is fully reproducible
    // full inventory serialization — SOURCE items + TARGET-ONLY items, so every finding ID resolves
    inventory: (() => {
      const serial = i => ({ id: i.id, identityKey: i.identityKey, provider: i.provider, parent: i.parent, children: i.children, state: i.state, certificationState: i.certificationState, comparison: i.comparisonMapping, findings: i.findings, evidence: i.evidence, history: i.history });
      const out = {};
      for (const [t, list] of Object.entries(refInv.items)) out[t] = list.map(serial);
      for (const it of diff.added) (out[it.type] = out[it.type] || []).push(serial(it));
      return out;
    })(),
  };
}

function buildHtml(json) {
  const v = json.verdict;
  const vcolor = v === 'PASS' ? '#C8181C' : v === 'FAIL' ? '#4A4A4A' : '#6E6E6E';
  const row = (t, s) => `<tr><td>${esc(t)}</td><td class="n">${s.ref}</td><td class="n">${s.target}</td><td class="n ok">${s.matched}</td><td class="n ${s.missing ? 'bad' : ''}">${s.missing}</td><td class="n">${s.added}</td></tr>`;
  const impact = sev => sev === 'blocking' ? '✗ BLOCKING' : sev === 'manual' ? '? MANUAL' : '· advisory';
  const finding = f => `<tr class="${esc(f.severity)}"><td class="mono">${esc(f.id)}</td><td>${esc(f.axis || 'completeness')}</td><td class="mono">${esc(f.ruleId || '—')}</td><td>${impact(f.severity)}</td><td class="mono">${esc(String(f.identityKey || '').replace(/^[a-z]+:/, ''))}</td><td>${esc(f.detail || f.reason || '')}${f.viewport ? ' <span class="vp">[' + esc(f.viewport) + ']</span>' : ''}</td><td class="n">${Math.round((f.confidence != null ? f.confidence : 1) * 100)}%</td></tr>`;
  const axisRows = Object.entries(json.axisSummary).map(([a, s]) => `<tr><td>${esc(a)}</td><td class="n ${s.blocking ? 'bad' : ''}">${s.blocking || 0}</td><td class="n">${s.advisory || 0}</td><td class="n">${s.manual || 0}</td></tr>`).join('');
  const excRows = json.approvedExceptions.map(x => `<tr><td class="mono">${esc((x.relatedIds || []).join(', '))}</td><td>${esc(x.reason || '')}</td><td>${esc(x.approver || '')}</td><td class="mono">${esc(x.date || '')}</td></tr>`).join('');
  const manRows = json.manualItems.map(m => `<tr><td class="mono">${esc(m.id)}</td><td>${esc(m.type)}</td><td class="mono">${esc(m.identityKey.replace(/^[a-z]+:/, ''))}</td></tr>`).join('');
  return `<title>Migration Certification — ${esc(json.target)}</title>
<style>
 body{font-family:'Segoe UI',system-ui,Arial;margin:0;background:#f4f1ee;color:#1B1A18}
 @media(prefers-color-scheme:dark){body{background:#131110;color:#f2efeb}}
 .wrap{max-width:1040px;margin:0 auto;padding:28px 24px 80px}
 .verdict{font-family:ui-monospace,Consolas,monospace;font-weight:700;font-size:15px;color:#fff;background:${vcolor};display:inline-block;padding:8px 18px;border-radius:6px;letter-spacing:.05em}
 h1{font-size:24px;margin:.2em 0 .1em} .sub{color:#6b645d;margin:0 0 18px;font-family:ui-monospace,monospace;font-size:12.5px}
 h2{font-family:ui-monospace,monospace;font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#6b645d;margin:34px 0 12px;border-bottom:1px solid #e6e0d9;padding-bottom:8px}
 table{border-collapse:collapse;width:100%;font-size:13.5px;background:#fff;border:1px solid #e6e0d9;border-radius:8px;overflow:hidden}
 @media(prefers-color-scheme:dark){table{background:#1c1a18;border-color:#2d2926}}
 th,td{text-align:left;padding:9px 13px;border-bottom:1px solid #e6e0d9}
 @media(prefers-color-scheme:dark){th,td{border-color:#2d2926}}
 th{font-family:ui-monospace,monospace;font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;color:#6b645d;background:#faf8f6}
 @media(prefers-color-scheme:dark){th{background:#232019}}
 td.n{text-align:right;font-family:ui-monospace,monospace} td.mono{font-family:ui-monospace,monospace}
 td.ok{color:#C8181C} td.bad{color:#6E6E6E;font-weight:700} .vp{color:#89909e;font-size:11px}
 tr.manual td:first-child{border-left:3px solid #6E6E6E}
 tr.blocking td:first-child{border-left:3px solid #4A4A4A} tr.advisory td:first-child{border-left:3px solid #6E6E6E}
 .kpi{display:flex;gap:22px;flex-wrap:wrap;font-family:ui-monospace,monospace;font-size:13px;color:#6b645d;margin-top:10px}
 .kpi b{color:#1B1A18} @media(prefers-color-scheme:dark){.kpi b{color:#f2efeb}}
 .empty{color:#6b645d;font-family:ui-monospace,monospace;font-size:13px;padding:14px 0}
</style>
<div class="wrap">
 <p class="sub">SGEN Migration Certification · inventory-driven · evidence-backed</p>
 <h1>${esc(json.source)} &rarr; ${esc(json.target)}</h1>
 <div class="verdict">${esc(v)}</div>
 <div class="kpi"><span>migration confidence <b>${json.migrationConfidence}%</b> <span style="color:#89909e">(informational)</span></span></div>
 <div class="kpi"><span>passed <b>${json.tally.passed}</b></span><span>warnings <b>${json.tally.warning}</b></span><span>failed <b>${json.tally.failed}</b></span><span>manual <b>${json.tally.manual}</b></span><span>approved <b>${json.tally.approved}</b></span><span>evidence artifacts <b>${json.evidenceIndex}</b></span></div>

 <h2>Inventory summary</h2>
 <table><thead><tr><th>Inventory</th><th>Source</th><th>Target</th><th>Matched</th><th>Missing</th><th>Added</th></tr></thead>
 <tbody>${Object.entries(json.inventorySummary).filter(([, s]) => s.ref || s.target).map(([t, s]) => row(t, s)).join('')}</tbody></table>

 ${axisRows ? `<h2>By axis</h2><table><thead><tr><th>Axis</th><th>Blocking</th><th>Advisory</th><th>Manual</th></tr></thead><tbody>${axisRows}</tbody></table>` : ''}

 <h2>Findings — why this migration is ${esc(v)}</h2>
 ${json.findings.length ? `<table><thead><tr><th>Inventory ID</th><th>Axis</th><th>Rule</th><th>Impact</th><th>Item</th><th>Detail</th><th>Conf.</th></tr></thead><tbody>${json.findings.map(finding).join('')}</tbody></table>` : '<p class="empty">No findings — every source inventory item is present, faithful, and production-clean on the target.</p>'}

 ${excRows ? `<h2>Approved exceptions (honored — did not fail certification)</h2><table><thead><tr><th>Inventory IDs</th><th>Reason</th><th>Approver</th><th>Date</th></tr></thead><tbody>${excRows}</tbody></table>` : ''}
 ${manRows ? `<h2>Manual verification required (evidence could not be collected automatically)</h2><table><thead><tr><th>Inventory ID</th><th>Type</th><th>Item</th></tr></thead><tbody>${manRows}</tbody></table>` : ''}

 ${json.added.length ? `<h2>Added on target (informational)</h2><table><thead><tr><th>Inventory ID</th><th>Type</th><th>Item</th></tr></thead><tbody>${json.added.slice(0, 40).map(a => `<tr><td class="mono">${esc(a.id)}</td><td>${esc(a.type)}</td><td class="mono">${esc(a.identityKey.replace(/^[a-z]+:/, ''))}</td></tr>`).join('')}</tbody></table>` : ''}

 <p class="sub" style="margin-top:34px">Every finding links to its Inventory ID + evidence + lifecycle history (full data in report.json).</p>
 <p class="sub">engine ${esc(json.metadata.versions.migrationQaEngine)} · registry ${esc(json.metadata.versions.ruleRegistry)} · inventory-schema ${esc(json.metadata.versions.inventorySchema)} · evidence-schema ${esc(json.metadata.versions.evidenceSchema)} · cert-schema ${esc(json.metadata.versions.certificationSchema)} · report-schema ${esc(json.metadata.versions.reportSchema)} · build ${esc(json.metadata.build)} · commit ${esc(json.metadata.gitCommit)} · ${esc(json.metadata.environment)} · ${esc(json.metadata.executionTimestamp)}</p>
</div>`;
}

function renderMigrationReport(refInv, tgtInv, diff, cert, opts = {}) {
  const json = buildJson(refInv, tgtInv, diff, cert, opts);
  const html = buildHtml(json);
  return { json, html };
}

module.exports = { renderMigrationReport };
