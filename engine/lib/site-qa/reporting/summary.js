'use strict';
// summary.js — deterministic executive-summary + scan-diff renderers built on the immutable history
// layer (timeline + regression). Additive reporting depth: does NOT touch the frozen report.js. Pure
// functions of their inputs — same inputs → identical text/HTML. Self-contained HTML (no external refs).
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function arrow(n) { return n > 0 ? '▲' : n < 0 ? '▼' : '='; }

// Build a structured executive summary from a timeline + its aggregate (+ optional regression verdict).
function execSummary({ target, timeline, aggregate, regression = null }) {
  const pts = timeline.points || [];
  const latest = pts[pts.length - 1] || null;
  const s = {
    target,
    scanCount: timeline.scanCount,
    span: timeline.span,
    currentScore: latest ? latest.overall : null,
    currentOpenFindings: latest ? latest.openFindings : null,
    trajectory: aggregate.trajectory,
    best: aggregate.milestones.best,
    worst: aggregate.milestones.worst,
    firstClean: aggregate.milestones.firstClean,
    streaks: aggregate.streaks,
    longestOpen: aggregate.findings ? aggregate.findings.longestOpen : null,
    mostReopened: aggregate.findings ? aggregate.findings.mostReopened : null,
    regression: regression ? { verdict: regression.verdict, violations: regression.violations.length, scoreDelta: regression.scoreDelta } : null,
  };
  const net = s.trajectory ? s.trajectory.net : null;
  const trendStr = net == null ? '—' : `${arrow(net)} ${Math.abs(net)} since first scan`;
  s.headline = latest == null
    ? `${target}: no scans on record`
    : `${target}: quality ${s.currentScore}/100 (${trendStr}), ${s.currentOpenFindings} open finding(s)`;
  return s;
}

function renderText(s) {
  const L = [];
  L.push('EXECUTIVE SUMMARY — ' + s.target);
  L.push('='.repeat(60));
  if (!s.scanCount) { L.push('No scans on record.'); return L.join('\n'); }
  L.push(`Scans: ${s.scanCount}   Span: ${s.span.first} → ${s.span.last}`);
  L.push(`Current quality score: ${s.currentScore}/100   Open findings: ${s.currentOpenFindings}`);
  if (s.trajectory) L.push(`Trajectory: ${s.trajectory.start} → ${s.trajectory.end}  (${arrow(s.trajectory.net)} ${Math.abs(s.trajectory.net)}; min ${s.trajectory.min}, max ${s.trajectory.max})`);
  if (s.best) L.push(`Best: ${s.best.overall} @ ${s.best.timestamp}    Worst: ${s.worst.overall} @ ${s.worst.timestamp}`);
  if (s.firstClean) L.push(`First clean scan: ${s.firstClean.timestamp}`);
  if (s.streaks) L.push(`Streak: ${s.streaks.improvingTrailing ? '+' + s.streaks.improvingTrailing + ' improving' : s.streaks.regressingTrailing ? '-' + s.streaks.regressingTrailing + ' regressing' : 'flat'}; longest clean run ${s.streaks.longestCleanRun}`);
  if (s.mostReopened && s.mostReopened.reopens) L.push(`Most reopened: ${s.mostReopened.ruleId} (${s.mostReopened.reopens}×)`);
  if (s.regression) L.push(`Latest gate: ${s.regression.verdict}  (${s.regression.violations} violation(s), score Δ ${s.regression.scoreDelta})`);
  return L.join('\n');
}

function renderHTML(s) {
  const badge = s.regression ? `<span class="v ${s.regression.verdict.toLowerCase()}">${esc(s.regression.verdict)}</span>` : '';
  const rows = [];
  if (s.scanCount) {
    rows.push(['Scans', `${s.scanCount} (${esc(s.span.first)} → ${esc(s.span.last)})`]);
    rows.push(['Quality score', `${s.currentScore}/100`]);
    rows.push(['Open findings', String(s.currentOpenFindings)]);
    if (s.trajectory) rows.push(['Trajectory', `${s.trajectory.start} → ${s.trajectory.end} (${arrow(s.trajectory.net)} ${Math.abs(s.trajectory.net)})`]);
    if (s.best) rows.push(['Best / Worst', `${s.best.overall} / ${s.worst.overall}`]);
    if (s.firstClean) rows.push(['First clean', esc(s.firstClean.timestamp)]);
    if (s.mostReopened && s.mostReopened.reopens) rows.push(['Most reopened', `${esc(s.mostReopened.ruleId)} (${s.mostReopened.reopens}×)`]);
  }
  const body = s.scanCount ? `<table>${rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${v}</td></tr>`).join('')}</table>` : '<p>No scans on record.</p>';
  return `<section class="exec-summary"><style>
.exec-summary{font:14px system-ui,Arial;max-width:640px}
.exec-summary h2{margin:0 0 .5em}
.exec-summary table{border-collapse:collapse;width:100%}
.exec-summary th{text-align:left;padding:.35em .6em;color:#555;width:38%;border-bottom:1px solid #eee}
.exec-summary td{padding:.35em .6em;border-bottom:1px solid #eee}
.v{padding:.1em .5em;border-radius:.3em;color:#fff;font-weight:700}
.v.pass{background:#1a7f37}.v.warn{background:#9a6700}.v.fail{background:#C8181C}
</style><h2>${esc(s.target)} ${badge}</h2>${body}</section>`;
}

// Deterministic scan-diff renderer (from scan-store diffRecords output).
function renderScanDiffText(diff) {
  const L = [];
  L.push(`SCAN DIFF  ${diff.from.scanId} → ${diff.to.scanId}   [${diff.classification}]`);
  L.push(`Score: ${diff.scoreDiff.from} → ${diff.scoreDiff.to} (${arrow(diff.scoreDiff.delta || 0)} ${Math.abs(diff.scoreDiff.delta || 0)})`);
  L.push(`New: ${diff.counts.introduced}   Resolved: ${diff.counts.resolved}   Changed: ${diff.counts.changed}   Unchanged: ${diff.counts.unchanged}`);
  for (const f of diff.introduced) L.push(`  + ${f.ruleId} @ ${f.page}`);
  for (const f of diff.resolved) L.push(`  - ${f.ruleId} @ ${f.page}`);
  return L.join('\n');
}

module.exports = { execSummary, renderText, renderHTML, renderScanDiffText, esc };
