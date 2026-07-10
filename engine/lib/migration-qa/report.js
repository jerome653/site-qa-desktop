'use strict';
// migration-qa/report.js — findings -> styled report.html + report.json (+ optional Chrome PDF).
// Styling/verdict-banner pattern adapted from ~/.claude/qa-audit/lib/report.js, kept repo-local.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tally, bySection, ORDER } = require('./verdict');

const SEV_COLOR = { critical: '#b4342c', high: '#c2410c', medium: '#a16207', low: '#6b7280' };
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function rel(from, f) { try { return path.relative(from, f).replace(/\\/g, '/'); } catch (e) { return f; } }

function renderHtml(data, outDir) {
  const v = data.verdict, t = v.tally, ready = v.ready;
  const banner = ready ? '#0a5c50' : '#b4342c';
  const secRows = bySection(data.findings).map(s => `
    <tr><td>${esc(s.section)}</td>
      <td class="n">${s.critical ? `<b style="color:${SEV_COLOR.critical}">${s.critical}</b>` : '·'}</td>
      <td class="n">${s.high ? `<b style="color:${SEV_COLOR.high}">${s.high}</b>` : '·'}</td>
      <td class="n">${s.medium || '·'}</td>
      <td class="n">${s.low || '·'}</td></tr>`).join('');

  // group findings by page
  const pageMap = {};
  for (const f of data.findings) { (pageMap[f.location || '(site)'] = pageMap[f.location || '(site)'] || []).push(f); }
  const pageBlocks = Object.entries(pageMap).sort((a, b) => {
    const sev = arr => Math.min(...arr.map(f => ORDER[f.severity] ?? 9));
    return sev(a[1]) - sev(b[1]);
  }).map(([url, fs_]) => {
    const rows = fs_.slice().sort((a, b) => (ORDER[a.severity] ?? 9) - (ORDER[b.severity] ?? 9)).map(f => `
      <div class="finding"><span class="sev" style="background:${SEV_COLOR[f.severity]}">${esc(f.severity)}</span>
        <div><div class="ft">${esc(f.title)} <span class="chk">${esc(f.check)}</span></div>
          ${f.detail ? `<div class="fd">${esc(f.detail)}</div>` : ''}${f.value ? `<div class="fv">${esc(f.value)}</div>` : ''}</div></div>`).join('');
    const shots = (data.shots && data.shots[url] || []).map(s => `<figure><img src="${esc(rel(outDir, s.file))}" loading="lazy"><figcaption>${esc(s.label)}</figcaption></figure>`).join('');
    return `<section class="page"><h3>${esc(url)}</h3>${rows || '<div class="clean">No automated findings.</div>'}${shots ? `<div class="shots">${shots}</div>` : ''}</section>`;
  }).join('');

  const manual = `<section class="manual"><h2>${esc(data.manual.title)} — manual sign-off required</h2>
    <p class="mnote">v2.0 Definition of Done requires these human-judged items in addition to the automated pass. Tick each before declaring production-ready.</p>
    ${data.manual.items.map(m => `<label class="mi"><input type="checkbox" disabled> <b>${esc(m.section)}</b> — ${esc(m.item)}</label>`).join('')}</section>`;

  const redir = data.redirects ? `<section class="page"><h3>Redirect preservation (${data.redirects.checked} old URLs)</h3>
    ${data.redirects.failed.length ? data.redirects.failed.map(r => `<div class="finding"><span class="sev" style="background:${SEV_COLOR.high}">high</span><div><div class="ft">${esc(r.url)}</div><div class="fd">${esc(r.detail)}</div></div></div>`).join('') : `<div class="clean">All ${data.redirects.ok} old URLs redirect/resolve correctly.</div>`}</section>` : '';

  return `<!doctype html><html><head><meta charset="utf-8"><title>Migration QA — ${esc(data.target)}</title><style>
  *{box-sizing:border-box} body{font:13px/1.5 -apple-system,"Segoe UI",Roboto,sans-serif;color:#171c26;margin:0;background:#f3f4f6}
  .wrap{max-width:1040px;margin:0 auto;padding:32px 22px 64px}
  .head{border-bottom:3px solid ${banner};padding-bottom:14px;margin-bottom:16px}
  .verdict{display:inline-block;font-weight:800;font-size:20px;padding:6px 15px;border-radius:6px;color:#fff;background:${banner}}
  h1{font-size:16px;margin:11px 0 2px} .meta{color:#6b7280;font-size:11.5px}
  .env{display:inline-block;font-size:11px;font-weight:700;text-transform:uppercase;padding:3px 9px;border-radius:5px;margin-left:8px;background:${data.env === 'live' ? '#fee2e2' : '#dcede9'};color:${data.env === 'live' ? '#991b1b' : '#0a5c50'}}
  .counts{display:flex;gap:8px;margin:14px 0} .pill{font-size:11px;font-weight:700;padding:4px 10px;border-radius:99px;color:#fff}
  table{border-collapse:collapse;width:100%;margin:8px 0 18px;background:#fff;border:1px solid #e3e5eb;border-radius:8px;overflow:hidden}
  th,td{text-align:left;padding:7px 11px;border-bottom:1px solid #eef1f4;font-size:12px} th{background:#faf9f5;font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;color:#6b7280} td.n{text-align:center;font-variant-numeric:tabular-nums}
  h2{font-size:14px;margin:22px 0 8px;border-bottom:1px solid #e3e5eb;padding-bottom:5px}
  .page{background:#fff;border:1px solid #e3e5eb;border-radius:10px;padding:12px 14px;margin:10px 0}
  .page h3{font-size:12.5px;margin:0 0 8px;font-family:ui-monospace,monospace;word-break:break-all;color:#0a5c50}
  .finding{display:flex;gap:9px;padding:6px 0;border-bottom:1px dashed #eef1f4}
  .sev{color:#fff;font-size:10px;font-weight:700;text-transform:uppercase;padding:2px 7px;border-radius:4px;height:fit-content;white-space:nowrap}
  .ft{font-weight:600} .chk{font-family:ui-monospace,monospace;font-size:10px;color:#3730a3;background:#e0e7ff;border-radius:4px;padding:0 5px;font-weight:700} .fd{color:#374151;margin-top:2px} .fv{color:#6b7280;font-size:11px;font-family:ui-monospace,monospace} .clean{color:#0a5c50}
  .shots{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px} figure{margin:0;width:180px} figure img{width:100%;border:1px solid #e3e5eb;border-radius:5px} figcaption{font-size:10px;color:#6b7280;text-align:center;margin-top:3px}
  .manual{background:#fff;border:1px solid #e3e5eb;border-radius:10px;padding:14px 16px;margin-top:18px} .mnote{color:#6b7280;font-size:12px;margin:0 0 10px} .mi{display:block;padding:6px 0;border-bottom:1px dashed #eef1f4;font-size:12.5px} .mi b{color:#0a5c50}
  </style></head><body><div class="wrap">
  <div class="head"><span class="verdict">${esc(v.label)}</span><span class="env">${esc(data.env)}</span>
    <h1>SGEN Migration QA — ${esc(data.target)}</h1>
    <div class="meta">generated ${esc(data.generated)} · crawled ${data.crawl.pages} pages (${data.crawl.linkFollowed} via link-follow${data.crawl.capped ? `, capped ${data.crawl.maxPages}` : ''}) · rendered ${data.render.rendered}/${data.render.total}${data.render.error ? ` · render note: ${esc(data.render.error)}` : ''}</div></div>
  <div class="counts">
    <span class="pill" style="background:${SEV_COLOR.critical}">${t.critical} critical</span>
    <span class="pill" style="background:${SEV_COLOR.high}">${t.high} high</span>
    <span class="pill" style="background:${SEV_COLOR.medium}">${t.medium} medium</span>
    <span class="pill" style="background:${SEV_COLOR.low}">${t.low} low</span></div>
  <h2>Findings by v2.0 section</h2>
  <table><thead><tr><th>Section</th><th class="n">crit</th><th class="n">high</th><th class="n">med</th><th class="n">low</th></tr></thead><tbody>${secRows || '<tr><td colspan=5>none</td></tr>'}</tbody></table>
  <h2>Automated findings by page</h2>
  ${redir}${pageBlocks || '<div class="clean">No findings.</div>'}
  ${manual}
  </div></body></html>`;
}

function findChrome() {
  const cands = [process.env.QA_CHROME, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', 'google-chrome', 'chrome'].filter(Boolean);
  for (const c of cands) { if (c.includes('/') || c.includes('\\')) { if (fs.existsSync(c)) return c; } }
  return null;
}

function writeReport(data, outDir, { pdf = false } = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const htmlPath = path.join(outDir, 'report.html');
  const jsonPath = path.join(outDir, 'report.json');
  fs.writeFileSync(htmlPath, renderHtml(data, outDir));
  fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2));
  let pdfPath = null;
  if (pdf) {
    const chrome = findChrome();
    if (chrome) {
      const p = path.join(outDir, 'report.pdf');
      const r = spawnSync(chrome, ['--headless=new', '--disable-gpu', '--no-sandbox', `--print-to-pdf=${p}`, '--print-to-pdf-no-header', 'file://' + htmlPath.replace(/\\/g, '/')], { timeout: 60000 });
      if (r.status === 0 && fs.existsSync(p)) pdfPath = p;
    }
  }
  return { htmlPath, jsonPath, pdfPath };
}

module.exports = { writeReport, renderHtml };
