'use strict';
// report-annotate.js — renders the annotated Site Comparison as a self-contained HTML document.
// Same shape as report-visual.js (STYLE + esc from ./report, one string, no build step), two modes:
//
//   mode 'live'  — the in-app preview: pen / highlight / comment tools over either pane, autosaved
//                  to the run via /api/annotations. This is what the operator marks up.
//   mode 'print' — the same document with the toolbar gone and every sheet forced onto its own PDF
//                  page. /api/annotate-pdf renders THIS through headless Chromium.
//
// Both modes run the SAME paint() over the SAME model, so the PDF is not a re-interpretation of the
// preview — it is the preview with the chrome removed. That is the whole point of "live view then
// pdf export all notes added": if they diverged, the export would be a second implementation to keep
// honest, and it would drift.
//
// Marks are polylines in a viewBox="0 0 1000 1000" preserveAspectRatio="none" SVG laid over the
// screenshot, fed from normalised 0..1 coords (x*1000). Non-uniform scaling is exactly what we want
// for the geometry — a mark tracks its pixels when the shot is squeezed to fit A4 — and
// vector-effect:non-scaling-stroke keeps the stroke from smearing with it.
//
// The model comes from annotate.buildExportModel(), which reads ONLY shots.ref + shots.cand. There
// is no diff-overlay code path in this file to disable — grep it for 'diff' and you get nothing.

const { STYLE, esc } = require('./report');

// JSON destined for a <script> block: only '<' can end the element early.
const j = (o) => JSON.stringify(o).replace(/</g, '\\u003c');

const CSS = `
.ann-top{display:flex;flex-wrap:wrap;gap:14px;align-items:center;justify-content:space-between;margin-bottom:6px}
.ann-h1{font-size:22px;margin:4px 0 0;letter-spacing:-.015em}
.ann-sub{font-size:12.5px;color:var(--ink-soft);margin:3px 0 0}
.ann-eyebrow{font-family:var(--mono);font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--ink-faint)}
.tb{position:sticky;top:0;z-index:50;display:flex;flex-wrap:wrap;gap:8px;align-items:center;background:color-mix(in srgb,var(--surface) 92%,transparent);backdrop-filter:blur(10px);border:1px solid var(--line);border-radius:12px;padding:9px 12px;margin:14px 0 18px}
.tb .grp{display:flex;gap:5px;align-items:center;padding-right:10px;margin-right:2px;border-right:1px solid var(--line)}
.tb .grp:last-child{border-right:0}
.tb label{font-family:var(--mono);font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-faint);margin-right:3px}
.tbtn{font-family:var(--mono);font-size:11px;font-weight:600;color:var(--ink-soft);background:var(--surface-2);border:1px solid var(--line);border-radius:7px;padding:5px 10px;cursor:pointer}
.tbtn:hover{color:var(--ink);border-color:var(--line-strong)}
.tbtn.on{color:#fff;background:var(--brand-solid);border-color:var(--brand)}
.tbtn.go{color:#fff;background:var(--brand-solid);border-color:var(--brand);font-weight:700}
.tbtn[disabled]{opacity:.45;cursor:default}
.sw{width:20px;height:20px;border-radius:5px;border:2px solid var(--line);cursor:pointer;padding:0}
.sw.on{border-color:var(--ink)}
.stat{font-family:var(--mono);font-size:10.5px;color:var(--ink-faint);margin-left:auto}
.stat.ok{color:var(--good)}.stat.err{color:var(--bad)}
.sheet{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:14px;margin-bottom:14px}
.sh-head{display:flex;flex-wrap:wrap;gap:10px;align-items:baseline;margin-bottom:10px}
.sh-path{font-family:var(--mono);font-size:13.5px;font-weight:700;color:var(--ink)}
.sh-vp{font-family:var(--mono);font-size:11px;color:var(--ink-soft);background:var(--surface-2);border:1px solid var(--line);border-radius:99px;padding:2px 9px}
.sh-n{font-family:var(--mono);font-size:10.5px;color:var(--ink-faint);margin-left:auto}
.panes{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.pane{margin:0;min-width:0}
.pane figcaption{display:flex;align-items:center;gap:7px;font-family:var(--mono);font-size:10px;letter-spacing:.07em;text-transform:uppercase;color:var(--ink-faint);margin-bottom:5px}
.pane figcaption i{width:7px;height:7px;border-radius:50%;background:var(--ink-faint);flex:none}
.pane.ref figcaption i{background:var(--fail)}
.pane.cand figcaption i{background:var(--brand)}
.pane figcaption u{text-decoration:none;color:var(--ink-faint);opacity:.75;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-transform:none;letter-spacing:0}
.wrapc{position:relative;border:1px solid var(--line);border-radius:8px;overflow:hidden;background:var(--surface-2);line-height:0}
.wrapc img{width:100%;display:block}
.ov{position:absolute;inset:0;width:100%;height:100%;touch-action:none}
.live .ov{cursor:crosshair}
.pin{position:absolute;transform:translate(-50%,-50%);width:19px;height:19px;border-radius:50%;background:var(--brand-solid);color:#fff;border:1.5px solid #fff;font:700 10px/16px var(--mono);text-align:center;cursor:pointer;padding:0;box-shadow:0 1px 4px rgba(0,0,0,.6)}
.pin.sel{outline:2px solid var(--ink)}
.notes{margin-top:10px;border-top:1px solid var(--line);padding-top:9px}
.notes:empty{display:none}
.nlbl{font-family:var(--mono);font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-faint);margin-bottom:6px}
.note{display:flex;gap:9px;align-items:flex-start;padding:6px 0;border-bottom:1px dashed var(--line)}
.note:last-child{border-bottom:0}
.badge{flex:none;min-width:19px;height:19px;border-radius:50%;background:var(--brand-solid);color:#fff;font:700 10px/19px var(--mono);text-align:center;padding:0 4px}
.badge.ghost{background:var(--surface-2);color:var(--ink-faint);border:1px solid var(--line)}
.ntxt{flex:1;font-size:12.5px;color:var(--ink);white-space:pre-wrap;word-break:break-word}
.nwhere{font-family:var(--mono);font-size:9.5px;color:var(--ink-faint);text-transform:uppercase;letter-spacing:.05em}
.nact{display:flex;gap:4px;flex:none}
.nact button{font-family:var(--mono);font-size:10px;color:var(--ink-faint);background:none;border:1px solid var(--line);border-radius:5px;padding:2px 7px;cursor:pointer}
.nact button:hover{color:var(--ink);border-color:var(--line-strong)}
.ed{width:100%;font:12.5px/1.5 var(--sans);color:var(--ink);background:var(--surface-2);border:1px solid var(--brand);border-radius:7px;padding:7px 9px;resize:vertical;min-height:58px}
.hint{font-size:12px;color:var(--ink-faint);margin:10px 0 0}
.empty{font-size:12.5px;color:var(--ink-faint);padding:20px;text-align:center}
`;

// Print mode: no @media print wrapper on purpose — apiAnnotatePdf renders with emulateMedia('screen')
// to keep the SGEN dark skin (matching the existing /api/pdf behaviour), so print-media rules would
// never fire. These are plain rules that are simply only emitted in print mode.
// INVARIANT: the .wrapc box must stay EXACTLY the image's box. The mark overlay is inset:0 over
// .wrapc and its 0..1 coords are relative to that box, so the moment the image stops filling the
// wrapper the marks decouple from the pixels they were drawn on.
//
// HISTORY, AND WHY THE PREVIOUS ANSWER WAS OVERRIDDEN.
// The first cut capped .wrapc at 112mm with `max-height + width:auto`, which letterboxed the image
// INSIDE a full-width wrapper: the wrapper stopped being the image's box, so the marks floated off
// their pixels. That cap was rightly reverted. The revert then went to the opposite extreme — no
// cap at all, `.sheet{break-inside:auto}` — and justified the resulting multi-page sheets as "the
// honest price of showing all of it; nothing is hidden and no mark is displaced".
//
// That justification is FALSE, and the exported artifact proves it. dispostore.com-2026-07-16-v1.pdf
// (1 page pair, 1 viewport, captures 1920x3016 / 1920x3003) came out as FIVE A4 landscape sheets,
// and reading its page objects back with pdf.js:
//     page 2 = sheet header, then a void        page 4 = both screenshots, footer sliced
//     page 3 = the pen mark alone on black      page 5 = a 10% strip of footer + 90% empty
// The mark landed on page 3. The screenshot it circles landed on page 4. Fragmenting .wrapc does
// not merely cost paper — it DISPLACES EVERY MARK ONTO A DIFFERENT SHEET FROM ITS TARGET, because
// the in-flow <img> fragments across pages while the position:absolute .ov overlay does not. The
// one invariant this file exists to protect was being broken by the rule that claimed to protect
// it, and only a rendered export shows it: the sheet count looks like a paper problem right up
// until you look at the pages.
//
// So the real constraint is not "cap or don't cap" — it is: .wrapc MUST NOT FRAGMENT, and it must
// stay exactly the image's box. Both, or the marks lie. That gives:
//   * .panes/.wrapc break-inside:avoid  — a screenshot is never sliced and never leaves its overlay.
//   * the image is bounded by max-height AND max-width, so it always fits its page by construction
//     (break-inside:avoid on a box taller than the page would CLIP it — that would hide content).
//   * .wrapc is width:fit-content, so the wrapper shrinks onto the scaled image instead of the
//     image letterboxing inside a full-width wrapper. This is what the 112mm cap got wrong, and it
//     is why a cap is safe now.
// The cost is real and I am taking it deliberately. Measured at print geometry on dispostore.com:
// the pane goes 137.4mm -> 106.9mm wide, i.e. the capture renders at 21.1% of native scale instead
// of 27.1%. Both are far below reading size — nobody reads 16px body copy at 27% either — so the
// export gives up nothing a reader was actually using, and buys the only thing that matters: the
// mark sits on the pixels it was drawn on, on one sheet, beside its staging counterpart. Reading
// the text is what the full visual report (and the live view) are for; this artifact is for
// pointing at a region and mailing it to someone.
//
// KNOWN LIMIT, stated rather than hidden: an extreme capture is height-bound to a narrow column.
// Rendered at 1920x14835 (sgen.com's home, the case the old comment cited) the pane measures
// 21.7mm x 168mm — a thumbnail. It is *whole, undistorted and correctly marked* (verified: overlay
// box == image box, mark drift 0.00007 of the image), where the old rule stranded that page's marks
// on different sheets from the screenshot. Small-but-true beats large-but-lying. Making a 15000px
// page legible on A4 needs region cropping around each mark — a real feature, not a CSS tweak.
//
// .sheet stays break-inside:auto ON PURPOSE: header+panes are pinned together and always fit, so
// the only thing that can ever flow onto a continuation page is a long notes list — which is text,
// carries no geometry, and must never be truncated. Nothing is hidden; only the panes are atomic.
//
// WHERE THE NOTES GO. Height-bounding the pane has a useful side effect: a full-page capture is
// always TALL, so a height-bounded pane is narrow and the sheet ends up with spare WIDTH. Two
// 1:1.57 panes bounded to 168mm tall occupy ~217mm of the 279mm inside the padding — leaving ~62mm
// of dead column on the right of every sheet. Putting the notes THERE instead of stacking them
// under the panes keeps a sheet's notes on the sheet they describe (a dev reads "mark 1" beside
// mark 1, not on the next page) and costs the panes ~2mm of width.
// The first attempt bought that room by SHRINKING the pane (--pane-h:116mm when notes exist).
// Rendered, it was the worst of both worlds: panes cut to 74mm wide, a third of the sheet still
// empty, and the notes spilled to a third page anyway. Looked at, not reasoned about — so it's gone.
const PANE_MAX_H = '168mm';   // A4 landscape: 210 - 6 - 6 page margins = 198mm usable, less this
                              // sheet's 8mm padding, ~6mm header and ~4mm caption. Measured: the
                              // sheet lands at 720.6px against 748.3px usable — 27.7px of headroom.
const NOTES_COL = '62mm';     // the dead right-hand column a height-bounded pane leaves behind
const PRINT_CSS = `
body{background:#000}
.wrap{padding:0}
.sheet{break-after:page;page-break-after:always;break-inside:auto;margin:0;border:0;border-radius:0;padding:4mm}
.sheet:last-child{break-after:auto;page-break-after:auto}
.cover{break-after:page;page-break-after:always;padding:10mm 4mm}
.sh-head{break-after:avoid;page-break-after:avoid}
/* The panes are the atomic unit: never split, so the overlay can never leave its screenshot. */
.panes{break-inside:avoid;page-break-inside:avoid}
.pane{break-inside:avoid;page-break-inside:avoid}
.wrapc{break-inside:avoid;page-break-inside:avoid;width:fit-content;max-width:100%;margin:0 auto}
/* Bounded by BOTH axes => always fits its page; fit-content above keeps the wrapper on the image. */
.wrapc img{width:auto;height:auto;max-width:100%;max-height:${PANE_MAX_H}}
.notes{break-inside:avoid;page-break-inside:avoid}
/* Only a sheet that actually has notes pays for the notes column. The .note rows are built by
   PRINT_CLIENT before the ready flag, so :has() has settled long before page.pdf() lays out. */
.sheet:has(.note){display:grid;grid-template-columns:1fr ${NOTES_COL};grid-template-areas:"head head" "panes notes";column-gap:4mm;align-content:start}
.sheet:has(.note) .sh-head{grid-area:head}
.sheet:has(.note) .panes{grid-area:panes;min-width:0}
.sheet:has(.note) .notes{grid-area:notes;align-self:start;margin-top:0;padding-top:0;border-top:0;border-left:1px solid var(--line);padding-left:4mm}
`;

// ---- shared paint ------------------------------------------------------------------------------
// One implementation, both modes. Builds the SVG children + comment pins for a pane from the model.
const PAINT = `
function pathOf(m){var d='',p=m.points;for(var i=0;i<p.length;i++){d+=(i?'L':'M')+(p[i][0]*1000).toFixed(2)+' '+(p[i][1]*1000).toFixed(2);}
if(p.length===1){d+='L'+(p[0][0]*1000+0.6).toFixed(2)+' '+(p[0][1]*1000).toFixed(2);}return d;}
// The number badge is filled with the mark's own colour so a reader can tie badge -> stroke. That
// makes the numeral's contrast depend on the palette: white on #FFD400 is unreadable (caught by
// looking at a rendered export, not by a test). Pick the ink from the badge's luminance instead.
function badgeInk(hex){ try{ var r=parseInt(hex.slice(1,3),16),g=parseInt(hex.slice(3,5),16),b=parseInt(hex.slice(5,7),16);
  return (0.2126*r+0.7152*g+0.0722*b)>140?'#111111':'#FFFFFF'; }catch(e){ return '#FFFFFF'; } }
function paintPane(wrap,bucket,live){
  var svg=wrap.querySelector('.ov'); var NS='http://www.w3.org/2000/svg';
  while(svg.firstChild)svg.removeChild(svg.firstChild);
  var i,m;
  for(i=0;i<bucket.marks.length;i++){ m=bucket.marks[i];
    var el=document.createElementNS(NS,'path');
    el.setAttribute('d',pathOf(m));
    el.setAttribute('fill','none');
    el.setAttribute('stroke',m.color);
    el.setAttribute('stroke-linecap','round');
    el.setAttribute('stroke-linejoin','round');
    el.setAttribute('vector-effect','non-scaling-stroke');
    el.setAttribute('stroke-width',Math.max(1.5,m.width*wrap.clientWidth).toFixed(2));
    if(m.type==='highlight'){el.setAttribute('stroke-opacity','0.38');}
    el.setAttribute('data-mid',m.id);
    if(live)el.style.cursor='pointer';
    svg.appendChild(el);
    var t=document.createElementNS(NS,'text');
    t.setAttribute('x',(m.points[0][0]*1000).toFixed(2)); t.setAttribute('y',(m.points[0][1]*1000).toFixed(2));
    t.setAttribute('fill',badgeInk(m.color)); t.setAttribute('font-size','22'); t.setAttribute('font-weight','700');
    t.setAttribute('text-anchor','middle'); t.setAttribute('dominant-baseline','central');
    t.setAttribute('paint-order','stroke'); t.setAttribute('stroke',m.color); t.setAttribute('stroke-width','14');
    t.setAttribute('stroke-linejoin','round'); t.setAttribute('vector-effect','non-scaling-stroke');
    t.textContent=String(i+1);
    svg.appendChild(t);
  }
  var old=wrap.querySelectorAll('.pin'); for(i=0;i<old.length;i++)old[i].remove();
  for(i=0;i<bucket.comments.length;i++){ var c=bucket.comments[i];
    var b=document.createElement('button'); b.className='pin'; b.style.left=(c.x*100)+'%'; b.style.top=(c.y*100)+'%';
    b.textContent=String(i+1); b.setAttribute('data-cid',c.id); b.title=c.text;
    if(!live)b.style.cursor='default';
    wrap.appendChild(b);
  }
}
`;

// Print panes ask the server for a downscaled JPEG instead of the native capture. A pane renders
// ~540px wide on an A4 landscape sheet, so embedding a 1920px-wide (and, on a real site, ~15000px
// tall) PNG puts megabytes into the PDF to draw pixels nobody can see: the sgen.com single-sheet
// export measured 4.18 MB. w=1200 still leaves the pane ~2x oversampled at print. The whole point
// of the feature is "so i can send it over", so the file has to stay mailable.
// Falls back to the untouched original if sharp is unavailable — see serveAnnotateAsset.
const PRINT_IMG_Q = '?w=1200&fmt=jpg';

function sheetHtml(p, v, mode) {
  const paneHtml = (pn) => `
      <figure class="pane ${pn.pane}" data-pane="${pn.pane}">
        <figcaption><i></i>${esc(pn.title)} <u>${esc(pn.url || '')}</u></figcaption>
        <div class="wrapc" data-key="${esc(annKeyAttr(p.path, v.label, pn.pane))}">
          ${pn.shot ? `<img src="${esc(pn.shot)}${mode === 'print' ? PRINT_IMG_Q : ''}" alt="${esc(pn.title)}">` : `<div class="empty">screenshot missing for this pane</div>`}
          <svg class="ov" viewBox="0 0 1000 1000" preserveAspectRatio="none"></svg>
        </div>
      </figure>`;
  return `<section class="sheet" data-page="${esc(p.path)}" data-vp="${esc(v.label)}">
    <div class="sh-head">
      <span class="sh-path">${esc(p.path)}</span>
      <span class="sh-vp">${esc(v.label)}</span>
      <span class="sh-n">${v.matchScore != null ? v.matchScore + '% match · ' : ''}<b data-count>${v.annotationCount}</b> annotation(s)</span>
    </div>
    <div class="panes">${v.panes.map(paneHtml).join('')}</div>
    <div class="notes" data-notes></div>
  </section>`;
}

// keep the key construction identical to annotate.annKey without importing it into the template
function annKeyAttr(pagePath, vpLabel, pane) { return `${pagePath}||${vpLabel}||${pane}`; }

function coverHtml(model) {
  return `<section class="cover">
    <p class="ann-eyebrow">SGEN Site QA · Site Comparison</p>
    <h1 class="ann-h1" style="font-size:30px">${esc(model.domain)}</h1>
    <p class="ann-sub" style="font-size:14px;margin-top:8px">Live vs staging, annotated.</p>
    <div style="margin-top:22px;font-family:var(--mono);font-size:12px;color:var(--ink-soft);line-height:2">
      <div><span style="color:var(--ink-faint)">REFERENCE (live)&nbsp;&nbsp;</span>${esc(model.reference)}</div>
      <div><span style="color:var(--ink-faint)">CANDIDATE (staging)</span>&nbsp;&nbsp;${esc(model.candidate)}</div>
      <div><span style="color:var(--ink-faint)">OVERALL MATCH&nbsp;&nbsp;&nbsp;&nbsp;</span>${model.overall}%</div>
      <div><span style="color:var(--ink-faint)">SHEETS&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span>${model.totals.sheets} (page × viewport)</div>
      <div><span style="color:var(--ink-faint)">ANNOTATIONS&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span>${model.totals.annotations}</div>
      <div><span style="color:var(--ink-faint)">EXPORTED&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span>${esc(model.generated)}</div>
      ${model.exportName ? `<div><span style="color:var(--ink-faint)">FILE&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span>${esc(model.exportName)}</div>` : ''}
    </div>
    <p class="ann-sub" style="margin-top:20px;max-width:150mm">Each sheet below pairs the live page (left) with the staging rebuild (right) at one viewport, carrying the marks and comments added in the app. Numbered marks correspond to the numbered notes under each sheet.</p>
  </section>`;
}

const TOOLBAR = `
  <div class="tb">
    <div class="grp"><label>Tool</label>
      <button class="tbtn on" data-tool="pen" onclick="setTool('pen',this)">&#9998; Pen</button>
      <button class="tbtn" data-tool="highlight" onclick="setTool('highlight',this)">&#9646; Highlight</button>
      <button class="tbtn" data-tool="comment" onclick="setTool('comment',this)">&#128172; Comment</button>
      <button class="tbtn" data-tool="erase" onclick="setTool('erase',this)">&#10005; Erase</button>
    </div>
    <div class="grp"><label>Color</label><span id="sw"></span></div>
    <div class="grp">
      <button class="tbtn" onclick="undo()">&#8630; Undo</button>
      <button class="tbtn" onclick="clearSheet()">Clear sheet</button>
    </div>
    <div class="grp">
      <button class="tbtn go" id="pdfbtn" onclick="exportPdf()">&#8681; Export PDF</button>
      <label style="margin-left:6px"><input type="checkbox" id="onlyann"> annotated only</label>
    </div>
    <span class="stat" id="stat">ready</span>
  </div>`;

const CLIENT = `
var MODEL=window.__MODEL__, RUNID=window.__RUNID__, ANN=window.__ANN__;
var TOOL='pen', COLOR='#E01F26', SEL=null, UNDO=[];
var COLORS=['#E01F26','#FFD400','#22C55E','#3B82F6','#FFFFFF'];
function $(id){return document.getElementById(id);}
function bucket(k){ if(!ANN.items[k])ANN.items[k]={marks:[],comments:[]}; return ANN.items[k]; }
function stat(t,cls){var s=$('stat');s.textContent=t;s.className='stat'+(cls?' '+cls:'');}
function setTool(t,btn){TOOL=t;var b=document.querySelectorAll('[data-tool]');for(var i=0;i<b.length;i++)b[i].classList.toggle('on',b[i]===btn);}
function uid(p){return p+Math.random().toString(36).slice(2,10);}

${PAINT}

function repaint(wrap){ var k=wrap.getAttribute('data-key'); paintPane(wrap,bucket(k),true); notes(wrap.closest('.sheet')); }
function repaintAll(){ var w=document.querySelectorAll('.wrapc'); for(var i=0;i<w.length;i++)repaint(w[i]); }

// ---- notes list (add / edit / delete) ----
function notes(sheet){
  var box=sheet.querySelector('[data-notes]'), rows=[], n=0;
  var wraps=sheet.querySelectorAll('.wrapc');
  box.innerHTML='';
  for(var i=0;i<wraps.length;i++){
    (function(wrap){
      var k=wrap.getAttribute('data-key'), b=bucket(k);
      var paneName=wrap.closest('.pane').getAttribute('data-pane')==='ref'?'LIVE':'STAGING';
      for(var c=0;c<b.comments.length;c++){ n++;
        (function(cm,idx){
          var row=document.createElement('div'); row.className='note';
          var mi=cm.markId?b.marks.map(function(x){return x.id;}).indexOf(cm.markId):-1;
          row.innerHTML='<span class="badge'+(mi<0?' ghost':'')+'">'+(idx+1)+'</span>'+
            '<div class="ntxt"><span class="nwhere">'+paneName+(mi>=0?' · mark '+(mi+1):'')+'</span><br></div>'+
            '<div class="nact"><button>Edit</button><button>Delete</button></div>';
          row.querySelector('.ntxt').appendChild(document.createTextNode(cm.text));
          var btns=row.querySelectorAll('.nact button');
          btns[0].onclick=function(){editNote(row,wrap,cm);};
          // Resolve the bucket at CLICK time and match by id, never through a captured object
          // reference — see the note on save() below for why a captured bucket goes stale.
          btns[1].onclick=function(){ var bk=bucket(k); bk.comments=bk.comments.filter(function(x){return x.id!==cm.id;}); save(); repaint(wrap); };
          box.appendChild(row);
        })(b.comments[c],c);
      }
    })(wraps[i]);
  }
  if(n){ var h=document.createElement('div'); h.className='nlbl'; h.textContent='Notes'; box.insertBefore(h,box.firstChild); }
  var cnt=sheet.querySelector('[data-count]');
  if(cnt){ var t=0,ws=sheet.querySelectorAll('.wrapc'); for(var q=0;q<ws.length;q++){var bb=bucket(ws[q].getAttribute('data-key'));t+=bb.marks.length+bb.comments.length;} cnt.textContent=t; }
}
function editNote(row,wrap,cm){
  var ta=document.createElement('textarea'); ta.className='ed'; ta.value=cm.text;
  var act=row.querySelector('.nact'); act.innerHTML='<button>Save</button><button>Cancel</button>';
  row.querySelector('.ntxt').innerHTML=''; row.querySelector('.ntxt').appendChild(ta); ta.focus();
  var b=act.querySelectorAll('button');
  b[0].onclick=function(){ var v=ta.value.trim(); var bk=bucket(wrap.getAttribute('data-key'));
    // match by id: clearing the text is a delete, otherwise edit in place
    if(!v){ bk.comments=bk.comments.filter(function(x){return x.id!==cm.id;}); }
    else { var t=bk.comments.filter(function(x){return x.id===cm.id;})[0]||cm; t.text=v; t.updated=new Date().toISOString(); }
    save(); repaint(wrap); };
  b[1].onclick=function(){ repaint(wrap); };
}

// ---- drawing ----
function rel(wrap,e){ var r=wrap.getBoundingClientRect(); return [Math.min(1,Math.max(0,(e.clientX-r.left)/r.width)),Math.min(1,Math.max(0,(e.clientY-r.top)/r.height))]; }
function bind(wrap){
  var svg=wrap.querySelector('.ov'), drawing=null;
  svg.addEventListener('pointerdown',function(e){
    var k=wrap.getAttribute('data-key'), b=bucket(k), pt=rel(wrap,e);
    if(TOOL==='erase'){ var t=e.target.getAttribute&&e.target.getAttribute('data-mid');
      if(t){ b.marks=b.marks.filter(function(m){return m.id!==t;}); b.comments=b.comments.map(function(c){ if(c.markId===t)c.markId=null; return c; }); save(); repaint(wrap); } return; }
    if(TOOL==='comment'){ addComment(wrap,pt,null); return; }
    e.preventDefault(); svg.setPointerCapture(e.pointerId);
    UNDO.push(k);
    drawing={id:uid('m'),type:TOOL,color:COLOR,width:TOOL==='highlight'?0.018:0.004,points:[pt]};
    b.marks.push(drawing); repaint(wrap);
  });
  svg.addEventListener('pointermove',function(e){ if(!drawing)return; var p=rel(wrap,e), last=drawing.points[drawing.points.length-1];
    if(Math.abs(p[0]-last[0])<0.002&&Math.abs(p[1]-last[1])<0.002)return;
    drawing.points.push(p); paintPane(wrap,bucket(wrap.getAttribute('data-key')),true); });
  svg.addEventListener('pointerup',function(e){ if(!drawing)return; var m=drawing; drawing=null; SEL=m.id;
    save(); repaint(wrap); });
  svg.addEventListener('pointercancel',function(){ drawing=null; });
  wrap.addEventListener('click',function(e){ var cid=e.target.getAttribute&&e.target.getAttribute('data-cid'); if(!cid)return;
    var b=bucket(wrap.getAttribute('data-key')); var cm=b.comments.filter(function(c){return c.id===cid;})[0];
    if(!cm)return;
    if(TOOL==='erase'){ b.comments.splice(b.comments.indexOf(cm),1); save(); repaint(wrap); return; }
    var v=window.prompt('Edit note',cm.text); if(v===null)return; v=v.trim();
    if(!v)b.comments.splice(b.comments.indexOf(cm),1); else {cm.text=v;cm.updated=new Date().toISOString();}
    save(); repaint(wrap); });
}
function addComment(wrap,pt,markId){
  var v=window.prompt('Note for this spot'); if(!v||!v.trim())return;
  var b=bucket(wrap.getAttribute('data-key'));
  // attach to the last mark drawn on THIS pane if it is still the selected one
  var mid=markId; if(!mid&&SEL&&b.marks.some(function(m){return m.id===SEL;}))mid=SEL;
  var now=new Date().toISOString();
  b.comments.push({id:uid('c'),markId:mid||null,text:v.trim(),x:pt[0],y:pt[1],created:now,updated:now});
  save(); repaint(wrap);
}
function undo(){ var k=UNDO.pop(); if(!k)return; var b=bucket(k); b.marks.pop();
  var w=document.querySelector('.wrapc[data-key="'+k.replace(/"/g,'\\\\"')+'"]'); save(); if(w)repaint(w); }
function clearSheet(){ var sh=document.querySelectorAll('.sheet'); if(!sh.length)return;
  if(!window.confirm('Clear every mark and note on this run?'))return;
  ANN.items={}; save(); repaintAll(); }

// ---- persistence ----
// The debounced POST sends the whole store; the server sanitizes and is the disk authority. It does
// NOT re-seat ANN from the response: doing that swapped the live object graph out from under every
// handler that had already captured a bucket, so a delete would splice an orphaned array and the
// next save would faithfully re-POST the undeleted comment. (Found by driving the UI, not by a unit
// test — the state was correct everywhere except in the closures.) The client stays authoritative
// in-session; a reload re-reads the sanitized truth from disk.
var T=null;
function save(){ clearTimeout(T); stat('saving…'); T=setTimeout(function(){
  fetch('/api/annotations?id='+encodeURIComponent(RUNID),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(ANN)})
    .then(function(r){return r.json();})
    .then(function(d){ if(d&&d.ok){ stat('saved · '+d.counts.marks+' mark(s), '+d.counts.comments+' note(s)','ok'); } else stat('save failed: '+(d&&d.error),'err'); })
    .catch(function(e){ stat('save failed: '+e,'err'); });
},220); }

function exportPdf(){ var b=$('pdfbtn'); b.disabled=true; stat('rendering PDF…');
  var q='/api/annotate-pdf?id='+encodeURIComponent(RUNID)+($('onlyann').checked?'&only=annotated':'');
  fetch(q).then(function(r){ return r.json().then(function(d){ return {ok:r.ok,d:d}; }); })
    .then(function(x){ b.disabled=false;
      if(!x.ok||!x.d.ok){ stat('PDF failed: '+((x.d&&x.d.error)||'error'),'err'); return; }
      stat('saved '+x.d.file+' · '+x.d.pages+' page(s) · '+Math.round(x.d.bytes/1024)+' KB','ok');
      window.open('/api/annotate-pdf-file?name='+encodeURIComponent(x.d.file),'_blank');
    }).catch(function(e){ b.disabled=false; stat('PDF failed: '+e,'err'); });
}

// ---- boot ----
(function(){
  var sw=$('sw');
  COLORS.forEach(function(c,i){ var b=document.createElement('button'); b.className='sw'+(i===0?' on':''); b.style.background=c;
    b.onclick=function(){ COLOR=c; var a=document.querySelectorAll('.sw'); for(var q=0;q<a.length;q++)a[q].classList.toggle('on',a[q]===b); };
    sw.appendChild(b); });
  var w=document.querySelectorAll('.wrapc'); for(var i=0;i<w.length;i++)bind(w[i]);
  repaintAll();
  window.addEventListener('resize',repaintAll);
  var imgs=document.querySelectorAll('.wrapc img');
  for(var q=0;q<imgs.length;q++)imgs[q].addEventListener('load',repaintAll);
  document.body.dataset.ready='1';
})();
`;

// print mode: paint from the model, then flag readiness so the PDF renderer waits on a fact rather
// than a timeout.
const PRINT_CLIENT = `
var ANN=window.__ANN__;
function bucket(k){ return (ANN.items&&ANN.items[k])||{marks:[],comments:[]}; }
${PAINT}
function notesPrint(sheet){
  var box=sheet.querySelector('[data-notes]'), wraps=sheet.querySelectorAll('.wrapc'), n=0;
  box.innerHTML='';
  for(var i=0;i<wraps.length;i++){
    var wrap=wraps[i], b=bucket(wrap.getAttribute('data-key'));
    var paneName=wrap.closest('.pane').getAttribute('data-pane')==='ref'?'LIVE':'STAGING';
    for(var c=0;c<b.comments.length;c++){ var cm=b.comments[c]; n++;
      var mi=cm.markId?b.marks.map(function(x){return x.id;}).indexOf(cm.markId):-1;
      var row=document.createElement('div'); row.className='note';
      row.innerHTML='<span class="badge'+(mi<0?' ghost':'')+'">'+(c+1)+'</span><div class="ntxt"><span class="nwhere">'+paneName+(mi>=0?' · mark '+(mi+1):'')+'</span><br></div>';
      row.querySelector('.ntxt').appendChild(document.createTextNode(cm.text));
      box.appendChild(row);
    }
  }
  if(n){ var h=document.createElement('div'); h.className='nlbl'; h.textContent='Notes'; box.insertBefore(h,box.firstChild); }
}
function go(){
  var w=document.querySelectorAll('.wrapc');
  for(var i=0;i<w.length;i++)paintPane(w[i],bucket(w[i].getAttribute('data-key')),false);
  var s=document.querySelectorAll('.sheet');
  for(var q=0;q<s.length;q++)notesPrint(s[q]);
  document.body.dataset.ready='1';
}
// repaint AFTER images settle: stroke width is derived from the rendered pane width, and in print
// mode the letterbox (max-height) is only known once the image has its natural size.
(function(){
  var imgs=Array.prototype.slice.call(document.images);
  var pending=imgs.filter(function(im){return !im.complete;});
  if(!pending.length)return go();
  var left=pending.length, fired=false;
  var done=function(){ if(!--left&&!fired){fired=true;go();} };
  pending.forEach(function(im){ im.addEventListener('load',done); im.addEventListener('error',done); });
  setTimeout(function(){ if(!fired){fired=true;go();} },8000); // never hang the export on one dead asset
})();
`;

function render(model, ann, opts = {}) {
  const mode = opts.mode === 'print' ? 'print' : 'live';
  const runId = opts.runId || '';
  const sheets = model.pages.map(p => p.viewports.map(v => sheetHtml(p, v, mode)).join('')).join('');
  const body = model.totals.sheets
    ? sheets
    : `<div class="empty">Nothing to show — ${model.onlyAnnotated ? 'no annotations have been added yet (untick “annotated only”).' : 'this run paired no pages.'}</div>`;

  const head = mode === 'print' ? coverHtml(model) : `
    <div class="ann-top">
      <div>
        <p class="ann-eyebrow">Site Comparison · annotate &amp; export</p>
        <h1 class="ann-h1">${esc(model.domain)}</h1>
        <p class="ann-sub">${esc(model.reference)} <b style="color:var(--ink-faint)">(live)</b> vs ${esc(model.candidate)} <b style="color:var(--ink-faint)">(staging)</b> · ${model.totals.sheets} sheet(s) · ${model.overall}% overall match</p>
        <p class="ann-sub">Draw on either pane. Notes are saved to this run as you go, and the PDF exports exactly what you see here.</p>
      </div>
      <div><a class="tbtn" href="/visual/${esc(runId)}" target="_blank">Full visual report &#8599;</a></div>
    </div>${TOOLBAR}`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${mode === 'print' ? 'Site Comparison' : 'Annotate'} — ${esc(model.domain)}</title>
${runId ? `<base href="/annotate/${esc(runId)}/">` : ''}
<style>${STYLE}${CSS}${mode === 'print' ? PRINT_CSS : ''}</style></head>
<body class="${mode === 'live' ? 'live' : 'printmode'}">
<div class="wrap">${head}${body}</div>
<script>
window.__RUNID__=${j(runId)};
window.__MODEL__=${j({ domain: model.domain, totals: model.totals })};
window.__ANN__=${j({ version: ann.version, items: ann.items })};
</script>
<script>${mode === 'print' ? PRINT_CLIENT : CLIENT}</script>
</body></html>`;
}

module.exports = { render };
