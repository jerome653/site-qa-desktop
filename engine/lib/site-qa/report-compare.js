'use strict';
// site-qa/report-compare.js — render a two-scan diff into a comparison report (HTML + JSON).
// Reuses the tester-UI design tokens. Every row is a real transition from compare.js — no inference.

const fs = require('fs');
const path = require('path');
const { STYLE, esc } = require('./report');

const EXTRA = `
.cmp-head{display:flex;gap:14px;align-items:center;flex-wrap:wrap;margin:14px 0}
.side{flex:1;min-width:220px;background:var(--surface);border:1px solid var(--line);border-radius:12px;box-shadow:var(--shadow-sm);padding:12px 14px}
.side .lbl{font-family:var(--mono);font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-faint)}
.side .tg{font-family:var(--mono);font-size:12px;color:var(--ink);word-break:break-all;margin-top:2px}
.side .sc{font-size:22px;font-weight:750;margin-top:8px;font-variant-numeric:tabular-nums}
.arrow{font-size:22px;color:var(--ink-faint);flex:none}
.delta{display:inline-block;font-family:var(--mono);font-size:12px;font-weight:700;border-radius:6px;padding:2px 9px}
.delta.up{color:var(--pass);background:var(--pass-bg)}.delta.down{color:var(--fail);background:var(--fail-bg)}.delta.flat{color:var(--ink-faint);background:var(--surface-2)}
.vbanner{border-radius:12px;padding:12px 16px;font-weight:650;font-size:14px;margin:8px 0 18px;border:1px solid}
.vbanner.bad{color:var(--fail);background:var(--fail-bg);border-color:var(--fail-line)}
.vbanner.good{color:var(--pass);background:var(--pass-bg);border-color:var(--pass-line)}
.trans{background:var(--surface);border:1px solid var(--line);border-radius:12px;box-shadow:var(--shadow-sm);margin-bottom:12px;overflow:hidden}
.trans h3{margin:0;padding:11px 15px;font-size:13px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:9px}
.trans h3 .n{font-family:var(--mono);font-size:11px;background:var(--surface-2);border-radius:99px;padding:1px 8px;color:var(--ink-soft)}
.trans.reg h3{color:var(--fail)}.trans.fix h3{color:var(--pass)}
.tr{display:flex;gap:10px;align-items:baseline;padding:8px 15px;border-bottom:1px dashed var(--line);font-size:12.5px}.tr:last-child{border-bottom:0}
.tr .su{font-family:var(--mono);font-size:10px;color:var(--ink-faint);flex:none;width:120px;text-transform:uppercase;letter-spacing:.04em}
.tr .nm{flex:1}.tr .mv{font-family:var(--mono);font-size:11px;flex:none}
.mv .f{color:var(--fail)}.mv .w{color:var(--warn)}.mv .p{color:var(--pass)}
table.st2{border-collapse:collapse;width:100%;background:var(--surface);border:1px solid var(--line);border-radius:10px;overflow:hidden;margin-top:6px}
table.st2 th,table.st2 td{padding:7px 11px;border-bottom:1px solid var(--line);font-size:12px;text-align:center}
table.st2 th{background:var(--surface-2);font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--ink-faint)}
table.st2 td.nm{text-align:left;font-weight:600}
.tg-improved{color:var(--pass);font-weight:700}.tg-regressed{color:var(--fail);font-weight:700}.tg-same{color:var(--ink-faint)}
`;

function deltaChip(n, goodIsNegative) {
  if (n === 0) return `<span class="delta flat">±0</span>`;
  const good = goodIsNegative ? n < 0 : n > 0;
  return `<span class="delta ${good ? 'up' : 'down'}">${n > 0 ? '+' : ''}${n}</span>`;
}
function sv(s) { return s === 'fail' ? '<span class="f">fail</span>' : s === 'warn' ? '<span class="w">warn</span>' : '<span class="p">pass</span>'; }

function transBlock(title, cls, items, showFromTo) {
  if (!items.length) return '';
  const rows = items.slice(0, 60).map(t => `<div class="tr"><span class="su">${esc(t.suite)}</span><span class="nm">${esc(t.name)}</span><span class="mv">${showFromTo ? `${sv(t.from)} → ${sv(t.to)}` : sv(t.status)}</span></div>`).join('');
  return `<div class="trans ${cls}"><h3>${esc(title)} <span class="n">${items.length}</span></h3>${rows}${items.length > 60 ? `<div class="tr"><span class="nm">+${items.length - 60} more</span></div>` : ''}</div>`;
}

function renderCompare(d, outDir) {
  const worse = d.worse;
  const banner = worse
    ? `<div class="vbanner bad">B is worse than A — ${d.counts.regressed} regression(s), ${d.counts.newIssues} new issue(s), fail ${deltaChip(d.tallyDelta.fail, true)}</div>`
    : `<div class="vbanner good">No regressions in B vs A — ${d.counts.fixed} fixed, ${d.counts.resolved} resolved</div>`;
  const scoreDelta = d.scoreDelta;
  const suiteRows = d.suites.map(s => `<tr><td class="nm">${esc(s.name)}</td>
    <td>${s.a.pass}/${s.a.warn}/${s.a.fail}</td><td>${s.b.pass}/${s.b.warn}/${s.b.fail}</td>
    <td>${s.dFail > 0 ? '+' : ''}${s.dFail}</td><td class="tg-${s.trend}">${s.trend}</td></tr>`).join('');

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SGEN Site QA — Comparison</title><style>${STYLE}${EXTRA}</style></head><body>
<div class="bar"><div class="bar-in"><div class="brand"><span class="mark"><svg viewBox="0 0 24 24" fill="none"><path d="M5 12.5l4.2 4.2L19 7" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg></span><div><b>Site QA</b><span>SGEN · Comparison</span></div></div></div></div>
<div class="wrap">
  <div class="cmp-head">
    <div class="side"><div class="lbl">A · ${esc(d.a.label)}</div><div class="tg">${esc(d.a.target)}</div><div class="sc">${d.a.score}%</div><div class="lbl">${esc(d.a.verdict)}</div></div>
    <div class="arrow">→</div>
    <div class="side"><div class="lbl">B · ${esc(d.b.label)}</div><div class="tg">${esc(d.b.target)}</div><div class="sc">${d.b.score}% ${deltaChip(scoreDelta, false)}</div><div class="lbl">${esc(d.b.verdict)}</div></div>
  </div>
  ${banner}
  <div class="tiles">
    <div class="tile fail"><div class="v">${d.counts.regressed}</div><div class="l"><span class="dot"></span>Regressed</div></div>
    <div class="tile fail"><div class="v">${d.counts.newIssues}</div><div class="l"><span class="dot"></span>New issues</div></div>
    <div class="tile pass"><div class="v">${d.counts.fixed}</div><div class="l"><span class="dot"></span>Fixed</div></div>
    <div class="tile pass"><div class="v">${d.counts.resolved}</div><div class="l"><span class="dot"></span>Resolved</div></div>
    <div class="tile warn"><div class="v">${d.counts.persisting}</div><div class="l"><span class="dot"></span>Still open</div></div>
    <div class="tile meta"><div class="v mono">${d.tallyDelta.fail > 0 ? '+' : ''}${d.tallyDelta.fail}</div><div class="l"><span class="dot"></span>Fail delta</div></div>
  </div>
  ${transBlock('Regressed (worse in B)', 'reg', d.regressed, true)}
  ${transBlock('New issues in B', 'reg', d.newIssues, false)}
  ${transBlock('Fixed (better in B)', 'fix', d.fixed, true)}
  ${transBlock('Resolved (gone in B)', 'fix', d.resolved, false)}
  <h2>Suite-by-suite (A pass/warn/fail → B pass/warn/fail)</h2>
  <table class="st2"><thead><tr><th style="text-align:left">Suite</th><th>A p/w/f</th><th>B p/w/f</th><th>Δfail</th><th>trend</th></tr></thead><tbody>${suiteRows}</tbody></table>
  <footer><span>A: ${esc(d.a.host)} · B: ${esc(d.b.host)}</span><span>compare generated locally · deterministic diff</span></footer>
</div></body></html>`;

  fs.mkdirSync(outDir, { recursive: true });
  const htmlPath = path.join(outDir, 'comparison.html');
  const jsonPath = path.join(outDir, 'comparison.json');
  fs.writeFileSync(htmlPath, html);
  fs.writeFileSync(jsonPath, JSON.stringify(d, null, 2));
  return { htmlPath, jsonPath };
}

module.exports = { renderCompare };
