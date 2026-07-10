'use strict';
// report-visual.js — renders the visual-match result as a self-contained HTML report.
// PM-readable first (plain-language verdicts per page/viewport), raw numbers kept alongside.
// Every issue row carries a "Copy MD" button — a dev-ready Markdown ticket with the page →
// section → element mapping, the exact difference, and the evidence screenshot filenames.
const fs = require('fs');
const path = require('path');
const { STYLE, esc } = require('./report');

function bar(score) {
  const c = score >= 90 ? 'var(--pass)' : score >= 75 ? 'var(--warn)' : 'var(--fail)';
  return `<span class="vm-bar"><i style="width:${Math.max(2, score)}%;background:${c}"></i></span><b style="color:${c}">${score}%</b>`;
}

// plain-language verdict a non-technical reader can act on
function verdictLine(score) {
  if (score >= 95) return 'Matches the original — no visible differences worth raising.';
  if (score >= 90) return 'Very close to the original — minor differences, worth a quick look.';
  if (score >= 75) return 'Mostly matches, but there are visible differences a visitor would notice.';
  return 'Noticeably different from the original — needs rebuild work before sign-off.';
}

function plainKind(kind) {
  return {
    missing: 'was on the old site but is MISSING on the new build',
    extra: 'is on the new build but was NOT on the old site',
    moved: 'is in a different position than on the old site',
    restyled: 'looks different (styling changed) vs the old site',
  }[kind];
}

function elWhere(e) {
  const identStr = (e.text || e.aria || e.ialt || e.src || e.href || '').trim();
  const what = `${e.tag}${identStr ? ` "${identStr}"` : ''}${(e.head && !e.text) ? ` in "${e.head}"` : ''}`;
  return { what, section: e.sec || 'page' };
}

// one dev-ready Markdown ticket per issue — everything a dev needs to find and fix it
function mdIssue({ kind, e, extraLine, page, vp }) {
  const w = elWhere(e);
  const L = [
    `### Visual mismatch: ${w.what} — ${kind}`,
    `- **Page:** ${page.path}`,
    `- **Old (reference):** ${page.ref}`,
    `- **New (SGEN build):** ${page.cand}`,
    `- **Viewport:** ${vp.label}`,
    `- **Where:** section "${w.section}" → ${w.what}`,
    `- **Issue:** this element ${plainKind(kind)}.`,
  ];
  if (extraLine) L.push(`- **Detail:** ${extraLine}`);
  if (vp.matchScore != null) L.push(`- **Match at this viewport:** ${vp.matchScore}%${vp.pixelMismatchPct != null ? ` (${vp.pixelMismatchPct}% of pixels differ)` : ''}`);
  if (vp.shots) L.push(`- **Evidence screenshots:** \`${path.basename(vp.shots.ref || '')}\` (old) · \`${path.basename(vp.shots.cand || '')}\` (new)${vp.shots.diff ? ` · \`${path.basename(vp.shots.diff)}\` (difference overlay)` : ''}`);
  L.push('', '_Evidence filenames read page--section--component--viewport; files sit in the run\'s shots folder._');
  return L.join('\n');
}

function copyBtn(md, label) {
  return `<button class="cmd" data-md="${encodeURIComponent(md).replace(/'/g, '%27')}" onclick="event.preventDefault();event.stopPropagation();copyMD(this)" title="Copy a dev-ready Markdown ticket">${label || '&#10697; Copy MD'}</button>`;
}

function vpBlock(v, page) {
  const s = v.struct;
  const chips = [];
  if (s.missing.length) chips.push(`<span class="vm-chip miss">${s.missing.length} missing</span>`);
  if (s.extra.length) chips.push(`<span class="vm-chip extra">${s.extra.length} extra</span>`);
  if (s.moved.length) chips.push(`<span class="vm-chip moved">${s.moved.length} moved</span>`);
  if (s.restyled.length) chips.push(`<span class="vm-chip style">${s.restyled.length} restyled</span>`);
  if (!chips.length) chips.push(`<span class="vm-chip ok">structure matches</span>`);
  const issues = [];
  const item = (kind, e, extraLine, labelHtml) => {
    const md = mdIssue({ kind, e, extraLine, page, vp: v });
    issues.push(md);
    return `<li>${labelHtml} ${copyBtn(md, '&#10697;')}</li>`;
  };
  const idv = e => (e.text || e.aria || e.ialt || e.src || e.href || '').trim();
  const elLbl = e => { const id = idv(e); return `${esc(e.tag)}${id ? ' — "' + esc(id) + '"' : (e.head ? ' in "' + esc(e.head) + '"' : '')} <span class="vm-sec">[${esc(e.sec)}]</span>`; };
  const list = (title, plain, rows) => rows.length ? `<div class="vm-d"><span class="vm-dl">${title}</span><span class="vm-plain">${plain}</span><ul>${rows.slice(0, 40).join('')}${rows.length > 40 ? `<li>+${rows.length - 40} more</li>` : ''}</ul></div>` : '';
  const shot = (label, rel) => rel ? `<figure><figcaption>${label}</figcaption><a href="${esc(rel)}" target="_blank"><img loading="lazy" src="${esc(rel)}"></a></figure>` : '';
  const missingRows = s.missing.map(e => item('missing', e, null, elLbl(e)));
  const extraRows = s.extra.map(e => item('extra', e, null, elLbl(e)));
  // Moves read whole for PMs, precise for devs: relocations (landmark changed) are shown plainly, and
  // same-delta shifts are grouped into one "block moved" line instead of dozens of coordinate rows.
  const dirWord = (dx, dy) => { const p = []; if (Math.abs(dx) > 8) p.push(dx > 0 ? `right ${dx}px` : `left ${-dx}px`); if (Math.abs(dy) > 8) p.push(dy > 0 ? `down ${dy}px` : `up ${-dy}px`); return p.join(', ') || 'shifted slightly'; };
  const relocations = s.moved.filter(m => m.fromSec && m.toSec && m.fromSec !== m.toSec);
  const shifts = s.moved.filter(m => !(m.fromSec && m.toSec && m.fromSec !== m.toSec));
  const sbuckets = new Map();
  for (const m of shifts) { const dx = m.to[0] - m.from[0], dy = m.to[1] - m.from[1]; const k = `${Math.round(dx / 16) * 16},${Math.round(dy / 16) * 16}`; if (!sbuckets.has(k)) sbuckets.set(k, []); sbuckets.get(k).push({ m, dx, dy }); }
  const movedRows = [];
  for (const arr of sbuckets.values()) {
    if (arr.length >= 3) {
      const dx = arr[0].dx, dy = arr[0].dy, sec = arr[0].m.el.sec;
      const md = mdIssue({ kind: 'moved', e: arr[0].m.el, extraLine: `${arr.length} elements in ${sec} moved together — ${dirWord(dx, dy)}`, page, vp: v });
      issues.push(md);
      movedRows.push(`<li><b>${arr.length} elements</b> moved together in <span class="vm-sec">[${esc(sec)}]</span> — ${esc(dirWord(dx, dy))} ${copyBtn(md, '&#10697;')}</li>`);
    } else {
      for (const { m, dx, dy } of arr) movedRows.push(item('moved', m.el, `moved ${dirWord(dx, dy)}`, `${elLbl(m.el)} <span class="vm-sec">moved ${esc(dirWord(dx, dy))}</span>`));
    }
  }
  for (const m of relocations) movedRows.push(item('moved', m.el, `relocated from ${m.fromSec} to ${m.toSec} — the page was restructured, this element was not removed`, `${elLbl(m.el)} <span class="vm-sec">relocated ${esc(m.fromSec)}&rarr;${esc(m.toSec)}</span>`));
  const restyledRows = s.restyled.map(m => item('restyled', m.el, `style differences: ${m.diffs.join('; ')}`, `${elLbl(m.el)} <span class="vm-sec">${esc(m.diffs.join('; '))}</span>`));
  const nIssues = issues.length;
  const plainSummary = nIssues === 0
    ? 'At this screen size the new build matches the old site’s structure.'
    : `At this screen size, ${nIssues} thing${nIssues > 1 ? 's' : ''} differ${nIssues > 1 ? '' : 's'} from the old site${missingRows.length ? ` — ${missingRows.length} missing` : ''}${extraRows.length ? ` · ${extraRows.length} new` : ''}${movedRows.length ? ` · ${movedRows.length} moved/restructured` : ''}${restyledRows.length ? ` · ${restyledRows.length} restyled` : ''}.`;
  const allMd = nIssues ? [`## Visual mismatches — ${page.path} @ ${v.label} (${nIssues} issue${nIssues > 1 ? 's' : ''})`, '', ...issues].join('\n\n') : '';
  return `<details class="vm-vp"><summary><b>${esc(v.label)}</b> ${bar(v.matchScore || 0)}
    <span class="vm-meta">${v.pixelMismatchPct == null ? 'pixel n/a' : v.pixelMismatchPct + '% pixels differ'} · ${s.matched}/${s.refCount} elements matched</span>
    ${chips.join('')}${nIssues ? copyBtn(allMd, `&#10697; Copy all ${nIssues}`) : ''}</summary>
    <div class="vm-body">
      <p class="vm-plain vm-lead">${plainSummary}</p>
      <div class="vm-shots">${shot('Old site (reference)', v.shots.ref)}${shot('New build (SGEN)', v.shots.cand)}${shot('Difference overlay', v.shots.diff)}</div>
      ${v.capture && v.capture.ref ? `<div style="font-family:var(--mono);font-size:10.5px;color:var(--ink-faint);margin:2px 0 6px">capture · ${esc(v.capture.ref.browser)} · ${esc(v.capture.ref.captureMode)} · fonts ${v.capture.ref.fontsLoaded ? '&#10003;' : '&mdash;'} · lazy-load ${v.capture.ref.lazyLoadPass ? '&#10003;' : '&mdash;'} · decode ${v.capture.ref.imageDecode ? '&#10003;' : '&mdash;'} · ${v.capture.ref.documentHeight}px · ${v.capture.ref.captureDurationMs}ms · eng ${esc(v.capture.ref.engineVersion)}</div>` : ''}
      ${list('Missing on the new build', 'These were on the old site but are not on the rebuild — usually the highest priority.', missingRows)}
      ${list('New on the rebuild', 'These exist on the new build but not the old site — confirm they are intentional.', extraRows)}
      ${list('Moved &amp; restructured', 'Same element in a new spot. A block that shifted together is grouped into one line; “relocated” means the page structure changed (e.g. nav → header), not that anything was removed.', movedRows)}
      ${list('Restyled', 'Same element, but fonts / colors / sizing differ.', restyledRows)}
      ${v.errors && v.errors.length ? `<div class="vm-err">render note: ${esc(v.errors.join(' | '))}</div>` : ''}
    </div></details>`;
}

const CLIENT = `
window.copyMD=function(btn){var md=decodeURIComponent(btn.getAttribute('data-md'));
function done(ok){var t=btn.innerHTML;btn.textContent=ok?'Copied \\u2713':'Copy failed';btn.classList.add(ok?'ok':'err');setTimeout(function(){btn.innerHTML=t;btn.classList.remove('ok','err');},1400);}
function fallback(){var ta=document.createElement('textarea');ta.value=md;ta.style.position='fixed';ta.style.opacity='0';document.body.appendChild(ta);ta.select();var ok=false;try{ok=document.execCommand('copy');}catch(e){}document.body.removeChild(ta);done(ok);}
if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(md).then(function(){done(true);},function(){fallback();});}else fallback();};
`;

function render(data, outDir) {
  const overallColor = data.overall >= 90 ? 'var(--pass)' : data.overall >= 75 ? 'var(--warn)' : 'var(--fail)';
  const pages = data.pages.map(p => `
    <details class="vm-page"${p.pageScore < 90 ? ' open' : ''}>
      <summary><span class="vm-path mono">${esc(p.path)}</span> ${bar(p.pageScore)}
        <span class="vm-links"><a href="${esc(p.ref)}" target="_blank">old&#8599;</a> <a href="${esc(p.cand)}" target="_blank">sgen&#8599;</a></span></summary>
      <p class="vm-plain vm-pageverdict">${verdictLine(p.pageScore)}</p>
      <div class="vm-vps">${p.viewports.map(v => vpBlock(v, p)).join('')}</div>
    </details>`).join('');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Visual Match — ${esc(data.candidate)}</title><style>${STYLE}
    .vm-hero{display:flex;flex-wrap:wrap;gap:20px;align-items:center;justify-content:space-between;margin-top:8px}
    .vm-score{font-family:var(--mono);font-size:44px;font-weight:730;color:${overallColor};line-height:1}
    .vm-sub{font-size:13px;color:var(--ink-soft)}
    .vm-bar{display:inline-block;width:90px;height:7px;border-radius:99px;background:var(--surface-2);border:1px solid var(--line);overflow:hidden;vertical-align:middle;margin:0 7px}
    .vm-bar i{display:block;height:100%}
    .vm-page{background:var(--surface);border:1px solid var(--line);border-radius:12px;box-shadow:var(--shadow-sm);margin-bottom:10px;overflow:hidden}
    .vm-page>summary,.vm-vp>summary{cursor:pointer;list-style:none;padding:13px 16px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
    .vm-page>summary::-webkit-details-marker,.vm-vp>summary::-webkit-details-marker{display:none}
    .vm-path{font-size:14px;font-weight:600;flex:1;min-width:120px}
    .vm-links a,.vm-meta{font-family:var(--mono);font-size:11px;color:var(--ink-faint);text-decoration:none;margin-left:6px}
    .vm-vps{border-top:1px solid var(--line);padding:6px 10px}
    .vm-vp{border:1px solid var(--line);border-radius:10px;margin:8px 0;background:var(--surface-2)}
    .vm-meta{margin-left:4px}
    .vm-chip{font-family:var(--mono);font-size:10px;font-weight:700;border-radius:99px;padding:2px 8px;margin-left:5px}
    .vm-chip.ok{color:var(--pass);background:var(--pass-bg)}.vm-chip.miss{color:var(--fail);background:var(--fail-bg)}.vm-chip.extra{color:var(--warn);background:var(--warn-bg)}.vm-chip.moved{color:var(--amber-ink,#8A8172);background:var(--warn-bg)}.vm-chip.style{color:var(--ink-soft);background:var(--surface)}
    .vm-body{padding:6px 14px 14px}
    .vm-shots{display:flex;gap:10px;flex-wrap:wrap;margin:8px 0}
    .vm-shots figure{margin:0;flex:1;min-width:170px;max-width:320px}
    .vm-shots figcaption{font-family:var(--mono);font-size:10px;color:var(--ink-faint);margin-bottom:4px}
    .vm-shots img{width:100%;border:1px solid var(--line);border-radius:8px;background:var(--surface)}
    .vm-d{margin-top:10px}.vm-dl{font-family:var(--mono);font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-faint)}
    .vm-d ul{margin:5px 0 0;padding-left:16px}.vm-d li{font-size:12.5px;color:var(--ink-soft);margin:2px 0}
    .vm-sec{font-family:var(--mono);font-size:10.5px;color:var(--ink-faint)}
    .vm-err{margin-top:8px;font-size:11.5px;color:var(--warn)}
    .vm-plain{display:block;font-size:12.5px;color:var(--ink-soft);margin:2px 0 0}
    .vm-lead{font-size:13px;color:var(--ink);margin:6px 0 2px}
    .vm-pageverdict{padding:0 16px 10px;margin:0;font-size:12.5px}
    .cmd{font-family:var(--mono);font-size:10px;font-weight:600;color:var(--ink-soft);background:var(--surface-2);border:1px solid var(--line);border-radius:6px;padding:2px 8px;cursor:pointer;vertical-align:middle;margin-left:8px;white-space:nowrap}
    .cmd:hover{color:var(--ink);border-color:var(--line-strong)}
    .cmd.ok{color:var(--pass);border-color:var(--pass-line)}.cmd.err{color:var(--fail);border-color:var(--fail-line)}
  </style></head><body>
  <div class="wrap">
    <div class="vm-hero">
      <div><p class="eyebrow" style="font-family:var(--mono);font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--ink-faint)">Visual Match · old live vs SGEN staging</p>
        <h1 style="font-size:26px;margin:6px 0 0">${esc(data.candidate)}</h1>
        <p class="vm-sub">Reference: ${esc(data.reference)} · ${data.pairs} page(s) paired · ${data.viewports.length} viewports · ${data.sharp ? 'pixel + structural' : 'structural only (sharp missing)'}</p>
        <p class="vm-sub" style="margin-top:4px">${esc(verdictLine(data.overall))} Any issue below has a <b>Copy MD</b> button — it copies a ready-to-forward ticket (page, exact element, what differs, evidence screenshots) for the dev team.</p></div>
      <div style="text-align:right"><div class="vm-score">${data.overall}%</div><div class="vm-sub">overall match</div></div>
    </div>
    ${data.unmatchedRef && data.unmatchedRef.length ? `<div class="vm-err" style="margin-top:14px">${data.unmatchedRef.length} reference page(s) had no matching path on SGEN: ${data.unmatchedRef.slice(0, 12).map(esc).join(', ')}${data.unmatchedRef.length > 12 ? ' …' : ''}</div>` : ''}
    <div style="margin-top:22px">${pages || '<p class="vm-sub">No pages paired — check the two URLs share paths, or pass an old→new URL map.</p>'}</div>
  </div><script>${CLIENT}</script></body></html>`;
  const file = path.join(outDir, 'visual-match.html');
  fs.writeFileSync(file, html);
  fs.writeFileSync(path.join(outDir, 'visual-match.json'), JSON.stringify(data, null, 2));
  return file;
}

module.exports = { render };
