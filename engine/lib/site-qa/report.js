'use strict';
// site-qa/report.js — render a real audit result into the tester-UI report (HTML + JSON).
// SGEN skin: pure-black background, crisp SGEN red (no pink, no gold, no green, no blue).
// Status colors: PASS = SGEN red #C8181C, FAIL = silver #B9BBBE, WARN = dim gray #6E6E6E,
// MANUAL = slate #4A4A4A. Screenshots sit at the top and open in a click-through lightbox.
// Every number/row is real audit data; 'manual' is a neutral status.

const fs = require('fs');
const path = require('path');

function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function rel(from, f) { try { return path.relative(from, f).replace(/\\/g, '/'); } catch (e) { return f; } }

const STYLE = `
:root,:root[data-theme="light"],:root[data-theme="dark"]{color-scheme:dark;--ground:#000000;--surface:#0B0A09;--surface-2:#131110;--line:#221F1B;--line-strong:#332E27;--ink:#F3EEE6;--ink-soft:#B0A796;--ink-faint:#726A5D;--brand:#E01F26;--brand-ink:#E01F26;--brand-solid:#C8181C;--pass:#C8181C;--pass-bg:#1C0908;--pass-line:#3E1512;--warn:#6E6E6E;--warn-bg:#141414;--warn-line:#262626;--fail:#B9BBBE;--fail-bg:#141414;--fail-line:#2A2A2A;--man:#4A4A4A;--man-bg:#131110;--man-line:#242424;--shadow:0 1px 2px rgba(0,0,0,.55),0 12px 34px rgba(0,0,0,.5);--shadow-sm:0 1px 2px rgba(0,0,0,.4);--radius:14px;--sans:ui-sans-serif,system-ui,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;--mono:ui-monospace,"Cascadia Code","SFMono-Regular",Menlo,Consolas,monospace;--good:#3fb950;--good-bg:rgba(63,185,80,.12);--good-line:rgba(63,185,80,.35);--bad:#e5484d;--bad-bg:rgba(229,72,77,.12);--bad-line:rgba(229,72,77,.35);--amber:#d29922;--amber-bg:rgba(210,153,34,.12);--amber-line:rgba(210,153,34,.35);}
*{box-sizing:border-box;scrollbar-width:none;-ms-overflow-style:none}::-webkit-scrollbar{display:none;width:0;height:0}body{margin:0;background:var(--ground);color:var(--ink);font-family:var(--sans);line-height:1.5;-webkit-font-smoothing:antialiased}
.brand-wm{position:fixed;inset:0;z-index:0;pointer-events:none;user-select:none;display:flex;align-items:center;justify-content:center;overflow:hidden}
.brand-wm b{font:800 clamp(160px,34vw,440px)/1 var(--sans);letter-spacing:-.02em;white-space:nowrap;color:rgba(255,255,255,.045)}
.wrap{position:relative;z-index:1}
.mono{font-family:var(--mono);font-variant-numeric:tabular-nums}.num{font-variant-numeric:tabular-nums}
.bar{position:sticky;top:0;z-index:40;background:color-mix(in srgb,var(--surface) 82%,transparent);backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
.bar-in{max-width:none;margin:0;padding:11px clamp(22px,3vw,64px);display:flex;align-items:center;gap:16px;flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:10px;flex:none}.mark{width:30px;height:30px;border-radius:8px;background:var(--brand-solid);display:grid;place-items:center}.mark svg{width:17px;height:17px}
.brand b{font-size:14px;font-weight:700;letter-spacing:-.01em}.brand span{font-family:var(--mono);font-size:10px;color:var(--ink-faint);letter-spacing:.14em;text-transform:uppercase;display:block;margin-top:-2px}
.target{flex:1;min-width:200px;display:flex;align-items:center;gap:9px;background:var(--surface-2);border:1px solid var(--line);border-radius:10px;padding:8px 12px}
.target .glob{width:7px;height:7px;border-radius:50%;flex:none}.target .u{font-family:var(--mono);font-size:12.5px;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rerun{flex:none;font-family:var(--mono);font-size:11px;color:var(--ink-faint)}.rerun code{background:var(--surface-2);border:1px solid var(--line);border-radius:5px;padding:2px 7px;color:var(--ink-soft)}
.wrap{max-width:none;margin:0;padding:26px clamp(22px,3vw,64px) 72px}
.summary{display:grid;grid-template-columns:minmax(0,340px) 1fr;gap:16px;align-items:stretch}
.verdict{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow);padding:20px;display:flex;gap:18px;align-items:center;position:relative;overflow:hidden}
.verdict::before{content:"";position:absolute;inset:0 auto 0 0;width:4px;background:var(--vc,var(--warn))}
.ring{position:relative;flex:none;width:118px;height:118px}.ring svg{transform:rotate(-90deg)}.ring .center{position:absolute;inset:0;display:grid;place-content:center;text-align:center}
.ring .big{font-size:30px;font-weight:750;letter-spacing:-.02em;line-height:1;font-variant-numeric:tabular-nums}.ring .sm{font-family:var(--mono);font-size:9.5px;color:var(--ink-faint);letter-spacing:.08em;text-transform:uppercase;margin-top:3px}
.vlabel{display:inline-flex;align-items:center;gap:7px;font-size:12px;font-weight:750;letter-spacing:.04em;text-transform:uppercase;color:var(--vc,var(--warn));background:var(--vcb,var(--warn-bg));border:1px solid var(--vcl,var(--warn-line));border-radius:999px;padding:4px 11px}
.vtext h1{font-size:19px;margin:11px 0 4px;letter-spacing:-.015em;font-weight:700;text-wrap:balance}.vtext p{margin:0;font-size:12.5px;color:var(--ink-soft)}
.veyebrow{font-family:var(--mono);font-size:10.5px;text-transform:uppercase;letter-spacing:.09em;color:var(--ink-faint);font-weight:700;margin-bottom:9px}
.sec-sub{font-size:12px;color:var(--ink-faint);margin:-6px 0 12px;font-family:var(--mono)}
.tiles{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
.tile{background:var(--surface);border:1px solid var(--line);border-radius:12px;box-shadow:var(--shadow-sm);padding:13px 15px;min-height:80px;display:flex;flex-direction:column;justify-content:space-between;cursor:pointer;transition:border-color .12s,transform .12s}
.tile:hover{border-color:var(--brand);transform:translateY(-2px)}
.tile:focus-visible{outline:2px solid var(--brand);outline-offset:2px}
.legend{display:flex;flex-wrap:wrap;align-items:center;gap:9px 18px;margin-top:14px;padding:11px 15px;background:var(--surface);border:1px solid var(--line);border-radius:10px;font-size:12px;color:var(--ink-soft)}
.legend .lg-t{font-family:var(--mono);font-size:10.5px;text-transform:uppercase;letter-spacing:.07em;color:var(--ink-faint);font-weight:700}
.legend .lg{display:inline-flex;align-items:center;gap:7px}
.legend .lg i{width:12px;height:12px;border-radius:4px;display:inline-block;flex:none;border:1px solid rgba(255,255,255,.14)}
.tile .v{font-size:24px;font-weight:730;line-height:1;font-variant-numeric:tabular-nums}.tile .l{font-family:var(--mono);font-size:10px;letter-spacing:.09em;text-transform:uppercase;color:var(--ink-faint);margin-top:8px;display:flex;align-items:center;gap:6px}.tile .l .dot{width:7px;height:7px;border-radius:50%}
.tile.pass .v{color:var(--pass)}.tile.pass .dot{background:var(--pass)}.tile.warn .v{color:var(--warn)}.tile.warn .dot{background:var(--warn)}.tile.fail .v{color:var(--fail)}.tile.fail .dot{background:var(--fail)}.tile.man .v{color:var(--man)}.tile.man .dot{background:var(--man)}.tile.meta .v{color:var(--ink)}.tile.meta .dot{background:var(--ink-faint)}
/* CHANGE (2.5.10) — "vs previous scan" panel, redesigned for at-a-glance scanning (adapted from the
   approved Option-A mockup). Plain-language verdict, oversized score+delta, and 5 semantic count cells.
   Traffic-light colors are scoped to THIS panel only: good=green(--good), bad=red(--bad),
   persisting=amber(--amber). The rest of the report keeps its inverted SGEN status palette
   (--pass red / --fail silver / --warn gray) untouched — no regression elsewhere. */
.cmpp{background:var(--surface);border:1px solid var(--line-strong);border-radius:var(--radius);box-shadow:var(--shadow-sm);overflow:hidden;margin:16px 0 4px}
.cmpp-h{display:flex;align-items:center;gap:10px;padding:13px 18px;border-bottom:1px solid var(--line);background:var(--surface-2)}
.cmpp-tag{font-family:var(--mono);font-size:9.5px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:#fff;background:var(--brand-solid);border-radius:5px;padding:4px 8px}
.cmpp-h h2{font-size:14px;font-weight:700;margin:0;letter-spacing:-.01em}
.cmpp-when{margin-left:auto;font-family:var(--mono);font-size:11px;color:var(--ink-faint)}
.cmpp-verdict{display:flex;align-items:center;gap:12px;padding:16px 18px 4px}
.cmpp-vico{width:34px;height:34px;flex:none;border-radius:9px;display:grid;place-items:center;font-size:18px;font-weight:700}
.cmpp-verdict.good .cmpp-vico{background:var(--good-bg);color:var(--good);border:1px solid var(--good-line)}
.cmpp-verdict.bad .cmpp-vico{background:var(--bad-bg);color:var(--bad);border:1px solid var(--bad-line)}
.cmpp-vtxt{font-size:15px;font-weight:650;line-height:1.4}
.cmpp-verdict.good .cmpp-vtxt b{color:var(--good)}
.cmpp-verdict.bad .cmpp-vtxt b{color:var(--bad)}
.cmpp-score{display:flex;align-items:center;gap:16px;padding:10px 18px 16px;flex-wrap:wrap}
.cmpp-sc{display:flex;flex-direction:column;gap:3px}
.cmpp-lbl{font-family:var(--mono);font-size:9.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-faint)}
.cmpp-prev{font-size:28px;font-weight:700;color:var(--ink-soft);font-variant-numeric:tabular-nums;line-height:1}
.cmpp-arrow{font-size:24px;color:var(--ink-faint);align-self:flex-end;padding-bottom:2px}
.cmpp-now{font-size:40px;font-weight:800;color:var(--ink);line-height:.95;font-variant-numeric:tabular-nums}
.cmpp-delta{font-family:var(--sans);font-size:15px;font-weight:800;color:#fff;background:var(--good);border-radius:8px;padding:7px 12px;align-self:center;font-variant-numeric:tabular-nums}
.cmpp-delta.neg{background:var(--bad)}
.cmpp-counts{display:grid;grid-template-columns:repeat(5,1fr);gap:1px;background:var(--line);border-top:1px solid var(--line);border-bottom:1px solid var(--line)}
.cmpp-cell{background:var(--surface);padding:14px 10px;text-align:center;position:relative}
.cmpp-cell .cmpp-n{font-size:30px;font-weight:800;line-height:1;font-variant-numeric:tabular-nums;color:var(--ink)}
.cmpp-cell .cmpp-k{font-family:var(--mono);font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;margin-top:7px;color:var(--ink-soft)}
.cmpp-cell .cmpp-sub{font-size:10px;line-height:1.3;color:var(--ink-faint);margin-top:4px}
.cmpp-top{position:absolute;top:0;left:0;right:0;height:3px}
.cmpp-cell.good .cmpp-n,.cmpp-cell.good .cmpp-k{color:var(--good)}.cmpp-cell.good .cmpp-top{background:var(--good)}
.cmpp-cell.bad .cmpp-n,.cmpp-cell.bad .cmpp-k{color:var(--bad)}.cmpp-cell.bad .cmpp-top{background:var(--bad)}
.cmpp-cell.warn .cmpp-n,.cmpp-cell.warn .cmpp-k{color:var(--amber)}.cmpp-cell.warn .cmpp-top{background:var(--amber)}
.cmpp-cell.zero{opacity:.34}
.cmpp-cell.zero .cmpp-top{display:none}
.cmpp-suites{padding:14px 18px}
.cmpp-slbl{font-family:var(--mono);font-size:9.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-faint);margin-bottom:9px}
.cmpp-strip{display:flex;flex-wrap:wrap;gap:7px}
.cmpp-strend{display:inline-flex;align-items:center;gap:6px;font-family:var(--sans);font-size:11px;border-radius:8px;padding:5px 10px;border:1px solid var(--line);background:var(--surface-2);color:var(--ink-soft)}
.cmpp-strend.improved{border-color:var(--good-line);background:var(--good-bg);color:var(--good);font-weight:650}
.cmpp-strend.regressed{border-color:var(--bad-line);background:var(--bad-bg);color:var(--bad);font-weight:650}
.cmpp-strend.same{color:var(--ink-faint)}
.cmpp-ar{font-size:12px}
.cmpp-foot{font-family:var(--mono);font-size:10.5px;color:var(--ink-faint);padding:12px 18px;border-top:1px solid var(--line)}
.cmpp-first{font-size:12.5px;color:var(--ink-soft);padding:16px 18px;line-height:1.55}
@media (max-width:560px){.cmpp-counts{grid-template-columns:repeat(2,1fr)}}
.shotsec{margin:20px 0 4px}.shotsec h2{font-size:11px;font-family:var(--mono);letter-spacing:.11em;text-transform:uppercase;color:var(--ink-faint);margin:0 0 12px;font-weight:700}
.evfilter{margin:0 0 14px;display:flex;flex-direction:column;gap:8px}
.evrow{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.evrow .evlab{font-family:var(--mono);font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-faint);font-weight:700;width:64px;flex:none}
.evchip{font-family:var(--mono);font-size:11px;color:var(--ink-soft);background:var(--surface-2);border:1px solid var(--line);border-radius:99px;padding:4px 11px;cursor:pointer;white-space:nowrap;max-width:280px;overflow:hidden;text-overflow:ellipsis}
.evchip:hover{border-color:var(--line-strong);color:var(--ink)}
.evchip.on{color:#fff;background:var(--brand-solid);border-color:var(--brand-solid)}
.shotcard.evhide{display:none}
.shotgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px}
.shotcard{background:var(--surface);border:1px solid var(--line);border-radius:10px;overflow:hidden;cursor:zoom-in;transition:border-color .12s ease,transform .12s ease}
.shotcard:hover{border-color:var(--brand);transform:translateY(-2px)}
.shotcard .thumb{width:100%;aspect-ratio:16/10;background:#000;overflow:hidden}
.shotcard .thumb img{width:100%;height:100%;object-fit:cover;object-position:top;display:block}
.shotcard .cardcap{padding:7px 10px;border-top:1px solid var(--line)}
.shotcard .vp{font-size:12px;font-weight:600;text-transform:capitalize}
.shotcard .pg{font-family:var(--mono);font-size:10px;color:var(--ink-faint);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px}
.lb{position:fixed;inset:0;z-index:100;background:rgba(0,0,0,.96);display:none;overflow:auto;text-align:center;padding:46px 0 64px}
.lb.open{display:block}
.lb img{max-width:min(94vw,1000px);height:auto;border:1px solid var(--line-strong);border-radius:8px;background:#000;margin:0 auto;display:inline-block}
.lb .cap{position:fixed;bottom:44px;left:0;right:0;text-align:center;font-family:var(--mono);font-size:12px;color:var(--ink-soft);pointer-events:none}
.lb .count{position:fixed;bottom:22px;left:0;right:0;text-align:center;font-family:var(--mono);font-size:11px;color:var(--ink-faint);pointer-events:none}
.lb .x{position:fixed;top:14px;right:20px;font-size:28px;color:var(--ink-soft);cursor:pointer;background:none;border:0;line-height:1;z-index:2}
.lb .nav{position:fixed;top:50%;transform:translateY(-50%);font-size:42px;color:var(--ink-soft);cursor:pointer;background:none;border:0;padding:10px 18px;user-select:none;z-index:2}.lb .nav:hover{color:var(--brand)}.lb .prev{left:6px}.lb .next{right:6px}
.strip{margin-top:16px;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow-sm);padding:14px 16px}
.strip h2,.results h2{font-size:11px;font-family:var(--mono);letter-spacing:.11em;text-transform:uppercase;color:var(--ink-faint);margin:0 0 12px;font-weight:700}
.ov{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:10px 18px}
.ovi{display:flex;flex-direction:column;gap:6px}.ovi .top{display:flex;justify-content:space-between;gap:8px;font-size:12.5px}.ovi .top b{font-weight:600}.ovi .top .r{font-family:var(--mono);font-size:11px;color:var(--ink-soft)}
.track{height:5px;border-radius:99px;background:var(--line);overflow:hidden;display:flex}.track i{height:100%;display:block}.track i.p{background:var(--pass)}.track i.w{background:var(--warn)}.track i.f{background:var(--fail)}.track i.m{background:var(--man)}
.tabs{display:flex;gap:7px;margin:22px 0 12px;flex-wrap:wrap}
.tab{font-family:var(--mono);font-size:12px;font-weight:600;color:var(--ink-soft);background:var(--surface);border:1px solid var(--line);border-radius:99px;padding:6px 13px;cursor:pointer;display:inline-flex;align-items:center;gap:7px}
.tab .c{font-size:10.5px;background:var(--surface-2);border-radius:99px;padding:1px 7px;color:var(--ink-faint)}
.tab[aria-pressed="true"]{color:var(--ink);border-color:var(--ink);background:var(--surface-2)}
.tab.fail[aria-pressed="true"]{color:var(--fail);border-color:var(--fail-line);background:var(--fail-bg)}.tab.warn[aria-pressed="true"]{color:var(--warn);border-color:var(--warn-line);background:var(--warn-bg)}.tab.pass[aria-pressed="true"]{color:var(--pass);border-color:var(--pass-line);background:var(--pass-bg)}.tab.manual[aria-pressed="true"]{color:var(--man);border-color:var(--man-line);background:var(--man-bg)}
.suite{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow-sm);margin-bottom:11px;overflow:hidden;position:relative}
.suite::before{content:"";position:absolute;top:0;bottom:0;left:0;width:3px}
.suite[data-worst="pass"]::before{background:var(--pass)}.suite[data-worst="warn"]::before{background:var(--warn)}.suite[data-worst="fail"]::before{background:var(--fail)}.suite[data-worst="manual"]::before{background:var(--man)}
.suite summary{list-style:none;cursor:pointer;padding:14px 16px 14px 20px;display:flex;align-items:center;gap:13px}.suite summary::-webkit-details-marker{display:none}
.sicon{width:30px;height:30px;border-radius:8px;background:var(--surface-2);border:1px solid var(--line);display:grid;place-items:center;flex:none;color:var(--ink-soft)}.sicon svg{width:16px;height:16px}
.sname{flex:1;min-width:0}.sname b{font-size:14.5px;font-weight:650;letter-spacing:-.01em}.sname .sub{font-family:var(--mono);font-size:11px;color:var(--ink-faint);margin-top:1px}
.sratio{font-family:var(--mono);font-size:12px;color:var(--ink-soft);font-variant-numeric:tabular-nums;flex:none}
.badge{font-family:var(--mono);font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;border-radius:6px;padding:3px 8px;flex:none}
.badge.pass{color:var(--pass);background:var(--pass-bg);border:1px solid var(--pass-line)}.badge.warn{color:var(--warn);background:var(--warn-bg);border:1px solid var(--warn-line)}.badge.fail{color:var(--fail);background:var(--fail-bg);border:1px solid var(--fail-line)}.badge.manual{color:var(--man);background:var(--man-bg);border:1px solid var(--man-line)}
.chev{flex:none;color:var(--ink-faint);transition:transform .18s ease}.suite[open] .chev{transform:rotate(90deg)}
.rows{border-top:1px solid var(--line)}
.row{display:flex;align-items:flex-start;gap:12px;padding:11px 16px 11px 20px;border-bottom:1px solid var(--line)}.row:last-child{border-bottom:0}
.st{width:18px;height:18px;border-radius:50%;flex:none;display:grid;place-items:center;margin-top:1px}.st svg{width:11px;height:11px}
.row[data-status="pass"] .st{background:var(--pass-bg);color:var(--pass)}.row[data-status="warn"] .st{background:var(--warn-bg);color:var(--warn)}.row[data-status="fail"] .st{background:var(--fail-bg);color:var(--fail)}.row[data-status="manual"] .st{background:var(--man-bg);color:var(--man)}
.rbody{flex:1;min-width:0}.rname{font-size:13.5px;font-weight:520}.rtarget{font-family:var(--mono);font-size:11.5px;color:var(--ink-faint);margin-top:2px;word-break:break-all}
.rwhy{font-size:12px;color:var(--ink-soft);margin-top:4px;line-height:1.5;max-width:82ch}
.rdetail{font-size:12.5px;color:var(--ink-soft);margin-top:6px;border-left:2px solid var(--line-strong);padding-left:10px}
.row[data-status="fail"] .rdetail{border-left-color:var(--fail);color:var(--ink)}.row[data-status="warn"] .rdetail{border-left-color:var(--warn)}.row[data-status="manual"] .rdetail{border-left-color:var(--man)}
.rmeta{font-family:var(--mono);font-size:11px;color:var(--ink-faint);flex:none;text-align:right;padding-top:1px}
.drill{margin-top:8px}
.drill>summary{list-style:none;cursor:pointer;font-family:var(--mono);font-size:11px;color:var(--ink-soft);display:inline-flex;align-items:center;gap:6px;padding:3px 9px;border:1px solid var(--line);border-radius:7px;background:var(--surface-2)}
.drill>summary::-webkit-details-marker{display:none}
.drill[open]>summary{color:var(--ink);border-color:var(--line-strong)}
.drill .dwrap{overflow-x:auto;margin-top:8px;border:1px solid var(--line);border-radius:8px}
.drill table{border-collapse:collapse;width:100%;font-size:11.5px}
.drill th{text-align:left;font-family:var(--mono);font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--ink-faint);padding:6px 10px;border-bottom:1px solid var(--line);background:var(--surface-2)}
.drill td{padding:6px 10px;border-bottom:1px solid var(--line);vertical-align:top;word-break:break-word}
.drill tr:last-child td{border-bottom:0}
.drill td.id{font-family:var(--mono);color:var(--ink)}
.drill td.pg{font-family:var(--mono);color:var(--ink-faint);max-width:240px;word-break:break-all}
.drill a.pglink{color:var(--brand,#C8181C);text-decoration:none;border-bottom:1px dotted currentColor}
.drill a.pglink:hover{text-decoration:none;opacity:.8}
.drill td.vl{font-family:var(--mono);color:var(--ink-soft);white-space:nowrap}
.drill2 .dwrap{overflow-x:auto;margin-top:8px;border:1px solid var(--line);border-radius:8px}
.pgroup{border-bottom:1px solid var(--line)} .pgroup:last-child{border-bottom:0}
.pghead{display:flex;align-items:center;gap:9px;padding:9px 12px;background:var(--surface-2);border-bottom:1px solid var(--line)}
.pghead .lbl{font:700 9.5px/1 var(--mono);text-transform:uppercase;letter-spacing:.06em;color:var(--ink-faint);flex:none}
.pghead a.pglink{font-family:var(--mono);font-size:12px;color:var(--brand);text-decoration:none;border-bottom:1px dotted currentColor;word-break:break-all}
.pghead .cnt{margin-left:auto;flex:none;font:600 10px/1 var(--mono);color:var(--ink-faint)}
.drill2 table{border-collapse:collapse;width:100%;font-size:11.5px}
.drill2 th{text-align:left;font-family:var(--mono);font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--ink-faint);padding:5px 12px;border-bottom:1px solid var(--line)}
.drill2 td{padding:6px 12px;border-bottom:1px solid var(--line);vertical-align:top;word-break:break-word}
.drill2 tr:last-child td{border-bottom:0}
.drill2 td.id{font-family:var(--mono);color:var(--ink)} .drill2 td.vl{font-family:var(--mono);color:var(--ink-soft)}
.drill2 td.vp{white-space:nowrap} .drill2 td.vp .vpb{display:inline-block;font-family:var(--mono);font-size:10px;line-height:1.5;white-space:nowrap;padding:1px 8px;border:1px solid var(--line-strong);border-radius:999px;color:var(--ink-soft);background:var(--surface-2)}
.qscore{margin-bottom:18px}
.qs-head{display:flex;align-items:baseline;gap:12px;margin:0 0 12px}
.qs-head h2{font-size:13px;font-family:var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--ink-faint);margin:0;font-weight:600}
.qs-head .ov{margin-left:auto;font-family:var(--mono);font-size:30px;font-weight:730;line-height:1;font-variant-numeric:tabular-nums}
.qs-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:10px}
.qcat{background:var(--surface);border:1px solid var(--line);border-radius:11px;padding:12px 14px;box-shadow:var(--shadow-sm)}
.qcat .top{display:flex;align-items:baseline;justify-content:space-between;gap:8px}
.qcat .nm{font-size:13px;font-weight:600}
.qcat .sc{font-family:var(--mono);font-size:17px;font-weight:730;font-variant-numeric:tabular-nums}
.qcat .track{height:5px;border-radius:99px;background:var(--surface-2);border:1px solid var(--line);overflow:hidden;margin:8px 0}
.qcat .track i{display:block;height:100%}
.qcat .ded{font-size:11.5px;color:var(--ink-soft);margin:2px 0}
.qcat .ded b{font-family:var(--mono);color:var(--fail);font-weight:600;margin-right:6px}
.qcat .clean{font-size:11.5px;color:var(--pass);font-family:var(--mono)}
.qi{display:flex;align-items:center;gap:8px;width:100%;text-align:left;background:var(--surface-2);border:1px solid var(--line);border-radius:8px;padding:6px 9px;margin:5px 0 0;cursor:pointer;color:var(--ink);font-family:var(--sans);font-size:12px;transition:border-color .12s ease,transform .12s ease}
.qi:hover{border-color:var(--brand);transform:translateX(3px)}
.qi .d-st{width:15px;height:15px;border-radius:50%;flex:none;display:grid;place-items:center}.qi .d-st svg{width:9px;height:9px}
.qi[data-status="fail"] .d-st{background:var(--fail-bg);color:var(--fail)}.qi[data-status="warn"] .d-st{background:var(--warn-bg);color:var(--warn)}
.qi-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:550}
.qi-n{font-family:var(--mono);font-size:10px;color:var(--ink-faint);flex:none}
.qi .d-go{color:var(--ink-faint);flex:none}
.qi-more{justify-content:center;color:var(--ink-soft);font-family:var(--mono);font-size:10.5px;border-style:dashed}
.rlabel{display:inline-flex;align-items:center;gap:6px;font-family:var(--mono);font-size:10.5px;font-weight:750;letter-spacing:.04em;text-transform:uppercase;border-radius:999px;padding:4px 11px;margin-left:8px;vertical-align:middle}
.rlabel.no{color:var(--fail);background:var(--fail-bg);border:1px solid var(--fail-line)}
.rlabel.ok{color:var(--pass);background:var(--pass-bg);border:1px solid var(--pass-line)}
/* .rlabel.part — blockers===0 but other suites still failing. A THIRD state exists because the
   readiness gate only vetoes on tier-1 rules and seven suites have none, so "no blockers" is not
   "ready". Amber, deliberately NOT .ok: colour is read before text, so a green pill reading "no
   launch blockers" still skims as an all-clear to a client who reads nothing else. Green is earned
   by the whole result (readiness.clean), never by the narrow gate alone. */
.rlabel.part{color:var(--amber);background:var(--amber-bg);border:1px solid var(--amber-line)}
.qblock{background:var(--fail-bg);border:1px solid var(--fail-line);border-radius:12px;padding:12px 14px;margin-bottom:12px}
.qblock-h{font-family:var(--mono);font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--fail);margin-bottom:4px}
.qblock .qi{background:var(--surface);font-size:13px;padding:8px 11px}
.qclean{margin-top:12px;font-size:12px;color:var(--ink-soft);display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.qclean-chip{font-family:var(--mono);font-size:10.5px;color:var(--pass);background:var(--pass-bg);border:1px solid var(--pass-line);border-radius:99px;padding:2px 9px}
.row.flash{animation:rowflash 1.6s ease}
@keyframes rowflash{0%{background:var(--warn-bg)}100%{background:transparent}}
.cmd{font-family:var(--mono);font-size:10px;font-weight:600;color:var(--ink-soft);background:var(--surface-2);border:1px solid var(--line);border-radius:6px;padding:2px 8px;cursor:pointer;vertical-align:middle;margin-left:8px;white-space:nowrap}
.cmd:hover{color:var(--ink);border-color:var(--line-strong)}
.cmd.ok{color:var(--pass);border-color:var(--pass-line)}.cmd.err{color:var(--fail);border-color:var(--fail-line)}
.drill td .cmd{margin-left:0}
.lenses{margin-top:16px}
.lens-h{font-size:11px;font-family:var(--mono);letter-spacing:.11em;text-transform:uppercase;color:var(--ink-faint);margin:0 0 12px;font-weight:700}
.lens-tiles{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
.ltile{background:var(--surface);border:1px solid var(--line);border-radius:12px;box-shadow:var(--shadow-sm);padding:14px 16px;display:flex;flex-direction:column;gap:11px;text-align:left;font-family:inherit}
.ltile.new{border-color:var(--brand-solid)}
.ltile .lt-badge{font-family:var(--mono);font-size:8.5px;letter-spacing:.08em;text-transform:uppercase;color:#fff;background:var(--brand-solid);border-radius:5px;padding:1px 6px;margin-left:6px;vertical-align:middle}
.ltile .lt-head{display:flex;align-items:center;justify-content:space-between;gap:16px}
.ltile .lt-l{display:flex;flex-direction:column;gap:3px;min-width:0}
.ltile .lt-nm{font-size:12.5px;font-weight:650}
.ltile .lt-sub{font-size:10.5px;color:var(--ink-faint);font-family:var(--mono)}
.ltile .lt-sc{font-family:var(--mono);font-size:26px;font-weight:730;line-height:1;flex:none}
.ltile .lt-trk{height:5px;border-radius:99px;background:var(--surface-2);border:1px solid var(--line);overflow:hidden}.ltile .lt-trk i{display:block;height:100%}
.lens-tabs{display:flex;gap:8px;margin:20px 0 12px;flex-wrap:wrap;border-bottom:1px solid var(--line)}
.lens-tab{font-family:var(--mono);font-size:12.5px;font-weight:600;color:var(--ink-soft);background:none;border:0;border-bottom:2px solid transparent;padding:9px 6px;cursor:pointer;display:inline-flex;align-items:center;gap:7px}
.lens-tab .c{font-size:10px;background:var(--surface-2);border:1px solid var(--line);border-radius:99px;padding:1px 7px;color:var(--ink-faint)}
.lens-tab[aria-pressed=true]{color:var(--ink);border-bottom-color:var(--brand)}
.lens-tab .dot{width:7px;height:7px;border-radius:50%}
.lens-view{display:none}.lens-view.on{display:block}
.lens-hd{display:flex;align-items:center;gap:14px;background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin-bottom:12px}
.lens-hd.new{border-color:var(--brand-solid)}
.lens-hd .lh-sc{font-family:var(--mono);font-size:30px;font-weight:740;line-height:1}
.lens-hd .lh-nm{font-size:15px;font-weight:700}.lens-hd .lh-q{font-size:12px;color:var(--ink-soft);margin-top:2px}
.lens-hd .lh-meta{margin-left:auto;text-align:right;font-family:var(--mono);font-size:11px;color:var(--ink-faint)}
.lens-note{font-size:12px;color:var(--ink-soft);background:var(--surface);border:1px solid var(--line);border-left:3px solid var(--brand);border-radius:10px;padding:11px 14px;margin-bottom:12px;line-height:1.6}
.li{display:flex;align-items:center;gap:11px;background:var(--surface-2);border:1px solid var(--line);border-radius:10px;padding:9px 12px;margin:6px 0;width:100%;text-align:left;cursor:pointer;font-family:inherit;color:var(--ink);transition:border-color .12s,transform .12s}
.li:hover{border-color:var(--brand);transform:translateX(3px)}
.li .st{width:16px;height:16px;border-radius:50%;flex:none;display:grid;place-items:center}.li .st svg{width:9px;height:9px}
.li[data-s=fail] .st{background:var(--fail-bg);color:var(--fail)}.li[data-s=warn] .st{background:var(--warn-bg);color:var(--warn)}
.li .inm{font-weight:600;font-size:13px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.li .rid,.li .eq,.li .n{font-family:var(--mono);font-size:10px;color:var(--ink-faint);flex:none}
.li .sev{font-family:var(--mono);font-size:9px;font-weight:700;text-transform:uppercase;border-radius:5px;padding:2px 6px;flex:none}
.li .sev.high,.li .sev.critical{color:var(--fail);background:var(--fail-bg)}.li .sev.medium{color:var(--warn);background:var(--warn-bg)}.li .sev.low{color:var(--ink-soft);background:var(--surface)}
.lens-clean{font-family:var(--mono);font-size:12px;color:var(--pass);padding:12px}
@media(max-width:760px){.lens-tiles{grid-template-columns:1fr 1fr}}
.hidden{display:none!important}
/* CHANGE (2.5.11) — developer-centric "where is this element" block, inside each occurrence row of the
   page-grouped drill table. Dark SGEN skin, reuses existing surface/line/ink tokens. Compact + legible. */
.drill2 tr.devrow>td{padding:0;background:var(--surface-2);border-bottom:1px solid var(--line)}
.devx{margin:0}
.devx>summary{list-style:none;cursor:pointer;font-family:var(--mono);font-size:10.5px;color:var(--ink-soft);padding:7px 12px;display:inline-flex;align-items:center;gap:6px}
.devx>summary::-webkit-details-marker{display:none}
.devx[open]>summary{color:var(--ink)}
.devx-body{padding:2px 12px 12px;display:flex;flex-direction:column;gap:6px}
.devx-r{display:flex;gap:9px;align-items:baseline;font-size:11.5px;flex-wrap:wrap}
.devx-k{font-family:var(--mono);font-size:9.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--ink-faint);flex:none;min-width:82px;padding-top:2px}
.devx-r code{font-family:var(--mono);font-size:11px;color:var(--ink);background:var(--surface);border:1px solid var(--line);border-radius:5px;padding:1px 6px;word-break:break-all}
.devx-strat{display:flex;flex-wrap:wrap;gap:6px}
.devx-s{font-family:var(--mono);font-size:10px;color:var(--ink-soft);background:var(--surface);border:1px solid var(--line);border-radius:6px;padding:2px 7px}
.devx-s b{color:var(--brand-ink);font-weight:700}.devx-s i{color:var(--ink-faint);font-style:normal}
.devx-s code{background:none;border:0;padding:0;color:var(--ink);font-size:10px}
.devx-html{font-family:var(--mono);font-size:10.5px;color:var(--ink-soft);background:var(--ground);border:1px solid var(--line);border-radius:7px;padding:9px 11px;overflow-x:auto;white-space:pre-wrap;word-break:break-all;margin:2px 0 0;line-height:1.5}
/* CHANGE (2.5.12) — Inspect button: open the offending page in a live browser with THIS element
   highlighted. Engine-served only (hidden on file: protocol). Dark SGEN skin, brand-red action. */
.devx-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:2px}
.inspect-btn{font-family:var(--mono);font-size:10px;font-weight:700;letter-spacing:.02em;color:#fff;background:var(--brand-solid);border:1px solid var(--brand-solid);border-radius:6px;padding:4px 10px;cursor:pointer;white-space:nowrap;display:inline-flex;align-items:center;gap:5px;transition:opacity .12s ease,background .12s ease,color .12s ease}
.inspect-btn:hover{opacity:.88}
.inspect-btn:focus-visible{outline:2px solid var(--brand);outline-offset:2px}
.inspect-btn.busy{opacity:.75;cursor:progress}
.inspect-btn.ok{background:var(--pass);border-color:var(--pass-line);color:#fff}
.inspect-btn.err{background:var(--surface-2);color:var(--fail);border-color:var(--fail-line)}
.inspect-btn[disabled]{opacity:.4;cursor:not-allowed}
.inspect-hint{font-family:var(--mono);font-size:9.5px;color:var(--ink-faint)}
/* CHANGE (3.0.0) — SITE AUDIT restructure. New flat ISSUES section + collapsed per-section detail.
   PRIORITY IS THE REGISTRY'S LAUNCH TIER (1 blocker · 2 major · 3 polish) via check.tier — no invented
   severity scheme (rules/registry.js is the single source; readiness.js reads the same field).
   COLOUR NOTE: this skin is INVERTED — brand red (--pass) means PASSING. A blocker must therefore never
   be brand red or it reads as "good". The priority ramp reuses the file's existing loudness idiom
   (cf. .qblock / .rlabel.no / .li .sev): solid silver = blocker, outlined silver = major, gray = polish. */
.issec{margin-top:22px}
.iss-hd{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;margin:0 0 4px}
.iss-hd h2{font-size:11px;font-family:var(--mono);letter-spacing:.11em;text-transform:uppercase;color:var(--ink-faint);margin:0;font-weight:700}
.iss-ct{font-family:var(--mono);font-size:11px;color:var(--ink-soft)}
.iss-ctl{display:flex;align-items:center;gap:9px;flex-wrap:wrap;margin:10px 0 12px}
.pbtn{font-family:var(--mono);font-size:11.5px;font-weight:600;color:var(--ink-soft);background:var(--surface);border:1px solid var(--line);border-radius:99px;padding:5px 12px;cursor:pointer;display:inline-flex;align-items:center;gap:7px}
.pbtn:hover{color:var(--ink);border-color:var(--line-strong)}
.pbtn .c{font-size:10px;background:var(--surface-2);border-radius:99px;padding:1px 7px;color:var(--ink-faint)}
.pbtn[aria-pressed="true"]{color:var(--ink);border-color:var(--ink);background:var(--surface-2)}
.pbtn:focus-visible{outline:2px solid var(--brand);outline-offset:2px}
.iss-un{font-family:var(--mono);font-size:10.5px;color:var(--ink-soft);background:var(--surface-2);border:1px solid var(--line);border-radius:7px;padding:5px 10px;cursor:pointer;margin-left:auto}
.iss-un:hover{color:var(--ink);border-color:var(--line-strong)}
.iss{display:flex;align-items:center;gap:10px;background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:9px 12px;margin:6px 0;transition:border-color .12s ease,opacity .12s ease}
.iss:hover{border-color:var(--line-strong)}
.iss.ignored{opacity:.42}
.iss.ignored .iss-t{text-decoration:line-through}
.iss.ignored .ig{color:var(--pass);background:var(--pass-bg);border-color:var(--pass-line)}
.iss.pfhide{display:none}
.pri{font-family:var(--mono);font-size:9px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;border-radius:5px;padding:3px 7px;flex:none;width:62px;text-align:center}
.pri-1{color:#0B0A09;background:var(--fail);border:1px solid var(--fail)}
.pri-2{color:var(--fail);background:var(--fail-bg);border:1px solid var(--fail-line)}
.pri-3{color:var(--warn);background:var(--warn-bg);border:1px solid var(--warn-line)}
.iss-rid{font-family:var(--mono);font-size:10px;color:var(--ink-faint);flex:none;width:66px}
.iss-b{flex:1;min-width:0}
.iss-t{font-size:13px;font-weight:600;line-height:1.35}
.iss-m{font-family:var(--mono);font-size:10px;color:var(--ink-faint);margin-top:2px}
.iss-why{font-size:11.5px;color:var(--ink-soft);margin-top:3px;line-height:1.45;max-width:82ch}
.iss-cost{font-family:var(--mono);font-size:11.5px;color:var(--fail);flex:none;font-variant-numeric:tabular-nums;width:34px;text-align:right}
.iss-go{font-family:var(--mono);font-size:10px;font-weight:600;color:var(--ink-soft);background:var(--surface-2);border:1px solid var(--line);border-radius:6px;padding:3px 8px;cursor:pointer;white-space:nowrap;flex:none}
.iss-go:hover{color:var(--ink);border-color:var(--brand)}
.ig{font-family:var(--mono);font-size:10px;font-weight:600;color:var(--ink-faint);background:var(--surface-2);border:1px solid var(--line);border-radius:6px;padding:3px 8px;cursor:pointer;white-space:nowrap;flex:none}
.ig:hover{color:var(--ink);border-color:var(--line-strong)}
.iss-empty{font-family:var(--mono);font-size:12px;color:var(--ink-faint);background:var(--surface);border:1px dashed var(--line-strong);border-radius:10px;padding:16px;text-align:center}
/* Reduced-view disclosure. A clean-looking report that quietly hides failures is the most dangerous
   output this tool produces — so the moment ignore hides anything, the report says so, visibly. */
.integ{display:flex;gap:11px;align-items:flex-start;background:var(--fail-bg);border:1px solid var(--fail-line);border-left:3px solid var(--fail);border-radius:10px;padding:11px 14px;margin:0 0 11px;font-size:12.5px;line-height:1.55;color:var(--ink-soft)}
.integ b{color:var(--fail)}
.integ-i{font-size:15px;color:var(--fail);flex:none;line-height:1.3}
.iss-note{font-size:12px;color:var(--ink-faint);margin:-2px 0 10px;line-height:1.5;max-width:96ch}
.detsec{margin-top:22px}
.detsec>h2{font-size:11px;font-family:var(--mono);letter-spacing:.11em;text-transform:uppercase;color:var(--ink-faint);margin:0 0 4px;font-weight:700}
@media (max-width:700px){.iss{flex-wrap:wrap}.iss-b{flex:1 0 100%;order:9}.iss-rid{width:auto}}
footer{margin-top:30px;padding-top:18px;border-top:1px solid var(--line);display:flex;flex-wrap:wrap;gap:8px 22px;justify-content:space-between;font-family:var(--mono);font-size:11px;color:var(--ink-faint)}
@media (max-width:820px){.summary{grid-template-columns:1fr}}
@media (max-width:560px){.tiles{grid-template-columns:1fr 1fr}}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
/* ---- global back-to-top ---------------------------------------------------------------------
   Shared by all three surfaces: the app shell, the audit report and the visual report all embed this
   STYLE block, so this rule is defined once here rather than three times.
   z-index 90 is load-bearing, not a guess. It parks the arrow UNDER every overlay that already
   exists: the report lightbox (100), and in the shell the tour (100), log modal (120), settings
   modal (130) and update toast (200 — which occupies this exact bottom-right corner). Anything
   >=100 would let the arrow punch through an open modal's backdrop and cover live UI.
   visibility (not just opacity) is what hides it: opacity:0 alone would leave an invisible button
   sitting in the tab order as a phantom stop, and would still be clickable over the content beneath. */
#totop{position:fixed;right:18px;bottom:18px;z-index:90;width:44px;height:44px;display:grid;place-items:center;padding:0;border-radius:99px;background:var(--surface);border:1px solid var(--line-strong);color:var(--ink-soft);cursor:pointer;box-shadow:var(--shadow);opacity:0;visibility:hidden;transform:translateY(8px);transition:opacity .18s ease,transform .18s ease,border-color .12s ease,color .12s ease}
#totop.on{opacity:1;visibility:visible;transform:none}
#totop:hover{color:var(--ink);border-color:var(--brand-solid)}
#totop:focus-visible{outline:2px solid var(--brand);outline-offset:2px}
#totop svg{width:19px;height:19px;display:block}
/* A floating arrow baked into a client's PDF is a defect. This rule covers ONE path only: a human
   pressing Ctrl+P on a standalone report tab, where the media really is print. It CANNOT cover
   /api/pdf — that route calls emulateMedia({media:'screen'}) before page.pdf(), so print rules never
   match there (verified: the element stays display:block under that emulation). That path is guarded
   separately in JS by the print=1 flag. Both guards are required; neither one covers the other. */
@media print{#totop{display:none!important}}
`;

// Back-to-top installer, shared verbatim by the shell (sgen-qa-serve.js) and both report renderers.
//
// WIRED TO AN EXPLICIT WINDOW ON PURPOSE — this argument is the entire point of the control.
// The reports are embedded in the shell inside an iframe that autosize() grows to the report's FULL
// content height (a real audit renders ~5458px) with scrolling='no'. That makes the iframe's own
// window UNSCROLLABLE: innerHeight === scrollHeight, so window.scrollY is pinned at 0 and a
// window.scrollTo(0,0) fired from inside the frame is a NO-OP. A button installed against the inner
// window would look perfect in a standalone tab and do literally nothing in the app — and because
// position:fixed inside an auto-height iframe resolves against the IFRAME's viewport, it would also
// park itself at the bottom of a 5000px document rather than at the corner of the visible window.
// So the surface that OWNS the scroll installs this against its own window, and a framed report
// installs nothing at all and defers to the shell's control.
const TOTOP_JS = `
function initToTop(win){
  // A framed report must not install this: the shell's control already scrolls the window that
  // actually moves, and an inner one could only ever be a dead button (see the note above).
  try{ if(win.self!==win.top) return; }catch(e){ return; }
  // /api/pdf renders the real route through headless Chromium. It forces media:'screen', so the
  // @media print rule cannot fire — this flag is what actually keeps the arrow out of client PDFs.
  if(/[?&]print=1/.test(win.location.search)) return;
  var doc=win.document;
  if(doc.getElementById('totop')) return;
  var b=doc.createElement('button');
  b.id='totop'; b.type='button'; b.title='Back to top';
  b.setAttribute('aria-label','Back to top');
  b.innerHTML='<svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false"><path d="M12 19V5M5 12l7-7 7 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  b.addEventListener('click',function(){
    // Honour the OS setting: 'smooth' is an animation and reduced-motion users have asked for none.
    var reduce=false; try{ reduce=win.matchMedia('(prefers-reduced-motion:reduce)').matches; }catch(e){}
    win.scrollTo({top:0,left:0,behavior:reduce?'auto':'smooth'});
    // No explicit focus move: once the top is reached the arrow hides itself, and visibility:hidden
    // drops it from the tab order, so focus falls back to the document and the next Tab resumes from
    // the top of the page — which is where a back-to-top user expects to be. Nothing is trapped.
  });
  doc.body.appendChild(b);
  // Threshold = three quarters of a screen, MEASURED PER SYNC rather than a fixed constant.
  // A hardcoded pixel threshold is a trap here: these pages range from ~1400px (visual report on a
  // wide desktop) to ~6200px (audit), and a constant larger than a short page's total scrollable
  // distance makes the arrow unreachable — it can never meet its own show condition. 600px did
  // exactly that to the standalone visual report at 1440x900, whose whole scroll range is 546px.
  // Deriving it from innerHeight keeps the meaning constant ("you have scrolled most of a screen")
  // across a phone and a 4K monitor, and re-reading it on resize keeps it true after a rotate.
  var tick=false;
  function sync(){
    tick=false;
    var y=win.pageYOffset||doc.documentElement.scrollTop||0;
    b.classList.toggle('on',y>win.innerHeight*0.75);
  }
  function onScroll(){ if(tick) return; tick=true; win.requestAnimationFrame(sync); }
  win.addEventListener('scroll',onScroll,{passive:true});
  win.addEventListener('resize',onScroll,{passive:true});
  sync();
}`;

const CLIENT = `
var D = window.__DATA, C = 2*Math.PI*52;
var ICONS={cursor:'<path d="M6 3l14 8-6 1.5L11 20 6 3z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" fill="none"/>',link:'<path d="M9 15l6-6M8 12l-2 2a3 3 0 104 4l2-2M16 12l2-2a3 3 0 10-4-4l-2 2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/>',form:'<rect x="4" y="4" width="16" height="16" rx="2" stroke="currentColor" stroke-width="1.8" fill="none"/><path d="M8 9h8M8 13h8M8 17h5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',device:'<rect x="3" y="5" width="13" height="10" rx="1.5" stroke="currentColor" stroke-width="1.8" fill="none"/><rect x="15" y="9" width="6" height="11" rx="1.5" stroke="currentColor" stroke-width="1.8" fill="none"/>',a11y:'<circle cx="12" cy="5" r="2" stroke="currentColor" stroke-width="1.8" fill="none"/><path d="M5 9h14M12 9v6m0 0l-3 5m3-5l3 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',search:'<circle cx="11" cy="11" r="6" stroke="currentColor" stroke-width="1.8" fill="none"/><path d="M20 20l-4-4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',gauge:'<path d="M4 15a8 8 0 1116 0" stroke="currentColor" stroke-width="1.8" fill="none"/><path d="M12 15l4-3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',shield:'<path d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linejoin="round"/>',terminal:'<rect x="3" y="4" width="18" height="16" rx="2" stroke="currentColor" stroke-width="1.8" fill="none"/><path d="M7 9l3 3-3 3M13 15h4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',browsers:'<circle cx="12" cy="12" r="8.5" stroke="currentColor" stroke-width="1.8" fill="none"/><path d="M3.5 12h17M12 3.5c2.5 2.3 2.5 14.7 0 17M12 3.5c-2.5 2.3-2.5 14.7 0 17" stroke="currentColor" stroke-width="1.5" fill="none"/>'};
var GLYPH={pass:'<svg viewBox="0 0 24 24" fill="none"><path d="M5 12.5l4.2 4.2L19 7" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>',warn:'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3 1.5 21h21L12 3zm-1 6h2v6h-2V9zm0 8h2v2h-2v-2z"/></svg>',fail:'<svg viewBox="0 0 24 24" fill="none"><path d="M7 7l10 10M17 7L7 17" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>',manual:'<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/><path d="M12 8v5M12 16h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'};
function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function worst(s){return s.fail?'fail':s.warn?'warn':s.manual&&!s.pass?'manual':'pass';}
function pgShort(u){if(!u||u==='\\u2014'||u==='—')return '—';try{var x=new URL(u);return (x.pathname==='/'?'/':x.pathname)+(x.hash||'');}catch(e){return u;}}
function pgLink(u){if(!u||u==='—'||u==='\\u2014')return '—';if(!/^https?:/i.test(u))return esc(pgShort(u));return '<a class="pglink" href="'+esc(u)+'" target="_blank" rel="noopener" title="'+esc(u)+'">'+esc(pgShort(u))+'</a>';}
function idLink(id){if(!id)return '';if(/^https?:/i.test(id))return '<a class="pglink" href="'+esc(id)+'" target="_blank" rel="noopener">'+esc(id)+'</a>';return esc(id);}
// ---- copy-as-markdown: dev tickets are PRECOMPUTED from the canonical Finding Contract (lib/report-contract)
// and embedded on each check/item as _md. The client copies them verbatim — it never reconstructs finding
// fields (Stage-2 acceptance: one canonical source, no format-specific re-interpretation). ----
window.copyMD=function(btn){var md=decodeURIComponent(btn.getAttribute('data-md'));
function done(ok){var t=btn.textContent;btn.textContent=ok?'Copied \\u2713':'Copy failed';btn.classList.add(ok?'ok':'err');setTimeout(function(){btn.textContent=t;btn.classList.remove('ok','err');},1400);}
if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(md).then(function(){done(true);},function(){fallback();});}else fallback();
function fallback(){var ta=document.createElement('textarea');ta.value=md;ta.style.position='fixed';ta.style.opacity='0';document.body.appendChild(ta);ta.select();var ok=false;try{ok=document.execCommand('copy');}catch(e){}document.body.removeChild(ta);done(ok);}};
function copyBtn(md,label){return '<button class="cmd" data-md="'+encodeURIComponent(md).replace(/'/g,'%27')+'" onclick="event.preventDefault();event.stopPropagation();copyMD(this)" title="Copy a dev-ready Markdown ticket">'+(label||'\\u29C9 Copy MD')+'</button>';}
// 2.5.11 — developer-centric: an escaped, readable "where is this element" block for one occurrence.
// Pure render off it._dev (threaded by lib/report-contract). No engine dependency; the Inspect button +
// endpoint arrive in 2.5.12 (here we ONLY expose the readable block + the data-fp/data-sel/data-url hooks).
function devBlock(dev){if(!dev)return '';var parts=[];
function r(k,v){parts.push('<div class="devx-r"><span class="devx-k">'+esc(k)+'</span><code>'+esc(v)+'</code></div>');}
if(dev.tag)r('Tag',dev.tag);
if(dev.domPath)r('DOM path',dev.domPath);
if(dev.xpath)r('XPath',dev.xpath);
if(dev.classes&&dev.classes.length)r('Classes','.'+dev.classes.join('.'));
var attrs=(dev.attrs&&typeof dev.attrs==='object')?Object.keys(dev.attrs):[];
if(attrs.length)parts.push('<div class="devx-r"><span class="devx-k">Attributes</span><code>'+attrs.map(function(k){return esc(k)+'="'+esc(dev.attrs[k])+'"';}).join(' \\u00b7 ')+'</code></div>');
var bb=dev.bbox;
if(bb&&(bb.width!=null||bb.height!=null))r('Element box',bb.width+'\\u00d7'+bb.height+' at ('+bb.x+', '+bb.y+')');
if(dev.strategies&&dev.strategies.length)parts.push('<div class="devx-r"><span class="devx-k">Selectors</span><span class="devx-strat">'+dev.strategies.map(function(s){return '<span class="devx-s"><b>'+esc(s.kind)+'</b> <code>'+esc(s.value)+'</code> <i>'+esc(s.stability)+'</i></span>';}).join('')+'</span></div>');
var oh=dev.outerHTML?'<pre class="devx-html">'+esc(dev.outerHTML)+'</pre>':'';
// 2.5.12 — Inspect action. Encodes the full resolve payload (selector/strategies/xpath/structuralCss/
// text/bbox) so /api/inspect can open the live page and highlight this exact element. Engine-served
// only; on file: protocol the button is hidden (inline script below) and inspectEl no-ops with a hint.
var ipay={url:dev.url||'',fingerprint:dev.fp||'',selector:dev.sel||'',xpath:dev.xpath||'',strategies:dev.strategies||[],structuralCss:dev.domPath||'',text:dev.text||'',boundingBox:dev.bbox||null,label:dev.sel||dev.tag||'element'};
var ibtn='<button class="inspect-btn" data-fp="'+esc(dev.fp||'')+'" data-sel="'+esc(dev.sel||'')+'" data-url="'+esc(dev.url||'')+'" data-inspect="'+encodeURIComponent(JSON.stringify(ipay)).replace(/'/g,'%27')+'" onclick="event.preventDefault();event.stopPropagation();inspectEl(this)" title="Open this page in a live browser with this element highlighted">&#128269; Inspect in live browser</button>';
var actions='<div class="devx-actions">'+ibtn+'<span class="inspect-hint">opens a real browser on this page</span></div>';
return '<details class="devx"><summary>&#9656; Developer details \\u2014 where this element is</summary><div class="devx-body">'+actions+parts.join('')+oh+'</div></details>';}
// 2.5.12 — Inspect: POST the element locator to /api/inspect; the engine opens a live browser and
// highlights it. GUARD: the report is a self-contained file that also opens standalone (file:) where
// there is NO engine — on file: this no-ops with an "open in the app" hint (belt) and the button is
// also hidden by the inline script at the end of CLIENT (braces).
window.inspectEl=function(btn){
  if(location.protocol!=='http:'&&location.protocol!=='https:'){var t0=btn.textContent;btn.textContent='Open in the app';btn.classList.add('err');setTimeout(function(){btn.textContent=t0;btn.classList.remove('err');},2000);return;}
  if(btn.getAttribute('data-busy')==='1')return;
  var payload;try{payload=JSON.parse(decodeURIComponent(btn.getAttribute('data-inspect')||'{}'));}catch(e){payload={url:btn.getAttribute('data-url'),fingerprint:btn.getAttribute('data-fp'),selector:btn.getAttribute('data-sel')};}
  var t=btn.textContent;btn.setAttribute('data-busy','1');btn.classList.remove('ok','err');btn.classList.add('busy');btn.textContent='Opening\\u2026';
  function reset(){setTimeout(function(){btn.textContent=t;btn.classList.remove('ok','err','busy');btn.removeAttribute('data-busy');},2000);}
  fetch('/api/inspect',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)})
    .then(function(r){return r.json();})
    .then(function(j){btn.classList.remove('busy');
      if(j&&j.ok){btn.textContent='Opened \\u2713';btn.classList.add('ok');}
      else if(j&&j.reason==='headed-browser-unavailable'){btn.textContent='Unavailable';btn.classList.add('err');}
      else if(j&&j.reason==='too-many-open'){btn.textContent='Too many open';btn.classList.add('err');}
      else{btn.textContent='Not found';btn.classList.add('err');}
      reset();})
    .catch(function(){btn.classList.remove('busy');btn.textContent='Unavailable';btn.classList.add('err');reset();});
};
function drill(items,c){if(!items||!items.length)return '';var hasEv=items.some(function(it){return it.evidence;});var hasVp=items.some(function(it){return it.viewport;});var hasDev=items.some(function(it){return it._dev;});
var capped=items.slice(0,500);
var colspan=4+(hasVp?1:0)+(hasEv?1:0);
function fullPgLink(u){if(!u||u==='—'||u==='\\u2014')return '—';if(!/^https?:/i.test(u))return esc(u);return '<a class="pglink" href="'+esc(u)+'" target="_blank" rel="noopener" title="'+esc(u)+'">'+esc(u)+'</a>';}
var order=[],idx=Object.create(null);
capped.forEach(function(it){var pg=(it.page&&it.page!=='—'&&it.page!=='\\u2014')?it.page:'';if(!idx[pg]){idx[pg]={page:pg,items:[]};order.push(idx[pg]);}idx[pg].items.push(it);});
var groups=order.map(function(g){var n=g.items.length;var head='<div class="pghead"><span class="lbl">Page</span>'+fullPgLink(g.page)+'<span class="cnt">'+n+' issue'+(n>1?'s':'')+'</span></div>';var trs=g.items.map(function(it){var dev=it._dev;var rowAttr=dev?(' data-fp="'+esc(dev.fp||'')+'" data-sel="'+esc(dev.sel||'')+'" data-url="'+esc(dev.url||'')+'"'):'';var main='<tr'+rowAttr+'><td>'+esc(it.section||'—')+'</td>'+(hasVp?'<td class="vp">'+(it.viewport?'<span class="vpb">'+esc(it.viewport)+'</span>':'—')+'</td>':'')+'<td class="id">'+idLink(it.id||'')+'</td><td class="vl">'+esc(it.value||'')+'</td>'+(hasEv?'<td class="vl">'+(it.evidence?'<span title="'+esc(it.evidence)+'">&#128247;</span>':'—')+'</td>':'')+'<td>'+(it._md?copyBtn(it._md,'\\u29C9 Copy'):'')+'</td></tr>';var extra=dev?('<tr class="devrow"><td colspan="'+colspan+'">'+devBlock(dev)+'</td></tr>'):'';return main+extra;}).join('');var table='<table><thead><tr><th>Section</th>'+(hasVp?'<th>Viewport</th>':'')+'<th>Identifier</th><th>Value</th>'+(hasEv?'<th>Evidence</th>':'')+'<th></th></tr></thead><tbody>'+trs+'</tbody></table>';return '<div class="pgroup">'+head+table+'</div>';}).join('');
var more=items.length>500?'<div class="pgroup"><div class="pghead"><span class="lbl">Note</span><span class="cnt">+'+(items.length-500)+' more occurrence'+((items.length-500)>1?'s':'')+' (full list in report.json)</span></div></div>':'';
var np=order.length;
return '<details class="drill drill2"><summary>&#9656; show '+items.length+' occurrence'+(items.length>1?'s':'')+' on '+np+' page'+(np>1?'s':'')+'</summary><div class="dwrap">'+groups+more+'</div></details>';}

// CHANGE D: fail-first ordering. Suites that contain any fail/warn float above clean suites; within a
// suite, checks order fail -> warn -> manual -> pass. Both use a stable sort over an {item,index}
// wrapper so the ORIGINAL index is kept for the chk-s{si}c{ci} id (dashboard gotoIssue targets stay valid).
var CK_RANK={fail:0,warn:1,manual:2,pass:3};function ckRank(c){var r=CK_RANK[c.status];return r==null?4:r;}
document.getElementById('results').innerHTML=D.suites.map(function(su,si){return {su:su,si:si};}).sort(function(a,b){return ((a.su.fail||a.su.warn)?0:1)-((b.su.fail||b.su.warn)?0:1);}).map(function(o){var su=o.su,si=o.si;var t=su.pass+su.warn+su.fail+su.manual;var w=worst(su);var badge=w==='fail'?'<span class="badge fail">'+su.fail+' failed</span>':w==='warn'?'<span class="badge warn">'+su.warn+' warning'+(su.warn>1?'s':'')+'</span>':w==='manual'?'<span class="badge manual">needs review</span>':'<span class="badge pass">all passing</span>';
var rows=su.checks.map(function(c,ci){return {c:c,ci:ci};}).sort(function(a,b){return ckRank(a.c)-ckRank(b.c);}).map(function(o){var c=o.c,ci=o.ci;var canCopy=(c.status==='fail'||c.status==='warn')&&c._md;return '<div class="row" id="chk-s'+si+'c'+ci+'" data-status="'+c.status+'"><span class="st">'+GLYPH[c.status]+'</span><div class="rbody"><div class="rname">'+esc(c.name)+(canCopy?' '+copyBtn(c._md,'\\u29C9 Copy for dev'):'')+'</div>'+(c._why?'<div class="rwhy">'+esc(c._why)+'</div>':'')+(c.target?'<div class="rtarget">'+esc(c.target)+'</div>':'')+(c.detail?'<div class="rdetail">'+esc(c.detail)+'</div>':'')+drill(c.items,c)+'</div><span class="rmeta">'+esc(c.meta||'')+'</span></div>';}).join('');
// 3.0.0 restructure: the per-section detail list (incl. passed tests) starts COLLAPSED — the score
// dashboard + per-section summary is the only thing expanded. Was: open whenever a suite had a
// fail/warn. Issues now live in their own flat section above; this is the drill-down destination
// (gotoIssue opens the target suite on demand).
// The collapsed bar is the ONLY view of a section until you open it — the 3.0.0 restructure put the
// detail list behind a collapse, which left a STATIC suite description ("internal links · redirects")
// as the whole story for a closed section. It described the suite, never this run: a section with 3
// broken links read exactly like a clean one, so the bar could not be scanned and every section had to
// be opened to find out. Summarise what actually went wrong instead — real check names, fail before
// warn — so a closed bar answers "what is wrong in here". Names come from the same c.name the rows
// render, so the bar cannot disagree with the list underneath it. The ratio and badge stay: they are
// counts, this is the substance. Falls back to the description only when there is nothing to report.
var bad=su.checks.filter(function(c){return c.status==='fail'||c.status==='warn';}).sort(function(a,b){return ckRank(a)-ckRank(b);});
var sub=bad.length
  ? bad.slice(0,2).map(function(c){return esc(c.name);}).join(' &middot; ')+(bad.length>2?' &middot; +'+(bad.length-2)+' more':'')
  // Gate the all-clear on su.pass > 0, NOT on manual: a suite with nothing scorable (0/0 — Cross-Browser
  // when the extra engines did not run) would otherwise render "All 0 checks passed", which is a green
  // claim about a section that measured nothing. No passes => say what the section is, never that it passed.
  : (su.pass > 0 ? 'All '+su.pass+' check'+(su.pass===1?'':'s')+' passed' : esc(su.desc));
var open='';
return '<details class="suite" data-worst="'+w+'"'+open+'><summary><span class="sicon"><svg viewBox="0 0 24 24">'+ICONS[su.icon]+'</svg></span><span class="sname"><b>'+esc(su.name)+'</b><div class="sub">'+sub+'</div></span><span class="sratio">'+su.pass+'/'+(su.pass+su.warn+su.fail)+'</span>'+badge+'<svg class="chev" width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></summary><div class="rows">'+rows+'</div></details>';}).join('');

// Unified quality dashboard — ONE section: per-suite score card whose rows ARE the clickable issues.
// Clean suites collapse into a single line; no separate suite-strip / issue-list duplication.
window.gotoIssue=function(id){var el=document.getElementById(id);if(!el)return;var su=el.closest('details.suite');if(su)su.open=true;var f=document.querySelector('.tab.all');if(f)filt('all',f);if(su)su.open=true;el.scrollIntoView({behavior:'smooth',block:'center'});el.classList.remove('flash');void el.offsetWidth;el.classList.add('flash');};
// Grade color: 95+ = full SGEN red (a pass); below that it lightens toward pale as the grade drops.
function gcol(s){s=+s||0;if(s>=95)return'#C8181C';var t=Math.max(0,Math.min(1,(95-s)/60));return'rgb('+Math.round(200+55*t)+','+Math.round(24+150*t)+','+Math.round(28+150*t)+')';}
(function(){var el=document.getElementById('qscore');if(!el)return;
function col(s){return gcol(s);}
var SEVR={critical:0,high:1,medium:2,low:3};
var bySuiteKey={};D.suites.forEach(function(su,si){bySuiteKey[su.key]=bySuiteKey[su.name]={su:su,si:si};});
var cats=(D.quality?D.quality.categories:D.suites.map(function(s){return {key:s.key,name:s.name,score:null,deductions:[]};}));
var cards=[],clean=[],totalIssues=0,blockers=[];
D.suites.forEach(function(su,si){su.checks.forEach(function(ch,ci){if((ch.status==='fail'||ch.status==='warn')&&ch.tier===1)blockers.push({su:su.name,si:si,ci:ci,ch:ch});});});
cats.forEach(function(c){var m=bySuiteKey[c.key]||bySuiteKey[c.name];if(!m)return;
var rows=[];m.su.checks.forEach(function(ch,ci){if(ch.status==='fail'||ch.status==='warn')rows.push({ch:ch,ci:ci});});
rows.sort(function(a,b){var s=(a.ch.status==='fail'?0:1)-(b.ch.status==='fail'?0:1);if(s)return s;return (SEVR[a.ch.severity]!=null?SEVR[a.ch.severity]:4)-(SEVR[b.ch.severity]!=null?SEVR[b.ch.severity]:4);});
if(!rows.length){clean.push({name:c.name,score:c.score});return;}
totalIssues+=rows.length;
// 3.0.0 restructure — the dashboard is a SUMMARY: per-section score + bar + an issue count that jumps
// to the Issues section. It used to inline up-to-5 clickable issue rows per card; the flat Issues
// section above now owns that list (with priority filter, ignore and the dev ticket), so inlining them
// here is duplication and stops this being "one dashboard with per each section scores" (owner's ask).
var rhtml='<button class="qi qi-more" onclick="gotoIssues()" title="See these in the Issues section">'+rows.length+' issue'+(rows.length>1?'s':'')+' \\u2192</button>';
cards.push({score:c.score,html:'<div class="qcat"><div class="top"><span class="nm">'+esc(c.name)+'</span>'+(c.score!=null?'<span class="sc" style="color:'+col(c.score)+'">'+c.score+'</span>':'')+'</div>'+(c.score!=null?'<div class="track"><i style="width:'+c.score+'%;background:'+col(c.score)+'"></i></div>':'')+rhtml+'</div>'});});
cards.sort(function(a,b){return (a.score==null?101:a.score)-(b.score==null?101:b.score);});
var cleanHtml=clean.length?'<div class="qclean">Clean: '+clean.map(function(x){return '<span class="qclean-chip">'+esc(x.name)+(x.score!=null?' '+x.score:'')+'</span>';}).join('')+'</div>':'';
var head='<div class="qs-head"><h2>Score dashboard \\u00b7 per-section summary \\u00b7 '+totalIssues+' issue'+(totalIssues===1?'':'s')+'</h2>'+(D.quality?'<span class="ov" style="color:'+col(D.quality.overall)+'">'+D.quality.overall+'</span>':'')+'</div><div class="sec-sub">Quality score per section (0\\u2013100) \\u2014 not a pass/fail; the verdict is up top. Every issue is listed in full in the Issues section below.</div>';
var blockHtml=blockers.length?'<div class="qblock"><div class="qblock-h">\\ud83d\\udd34 Fix first \\u2014 break'+(blockers.length===1?'s':'')+' the site \\u00b7 '+blockers.length+' launch blocker'+(blockers.length>1?'s':'')+'</div>'+blockers.map(function(x){var n=(x.ch.items||[]).length;return '<button class="qi qb" data-status="'+x.ch.status+'" onclick="gotoIssue(\\'chk-s'+x.si+'c'+x.ci+'\\')"><span class="d-st">'+GLYPH[x.ch.status]+'</span><span class="qi-name">'+esc(x.ch.name)+'</span><span class="qi-n">'+esc(x.su)+(n?' \\u00b7 '+n+'\\u00d7':'')+'</span><span class="d-go">\\u2192</span></button>';}).join('')+'</div>':'';
el.innerHTML=head+blockHtml+'<div class="qs-grid">'+cards.map(function(x){return x.html;}).join('')+'</div>'+cleanHtml;})();

// ============ ISSUES — the new flat top section (3.0.0 restructure) =================================
// Owner: "add a new top section to list issues aside from the per section list ... which can be filtered
// by priority and an option to ignore as needed".
//
// PRIORITY = the registry's launch TIER (check.tier, stamped by finding.js from rules/registry.js):
//   1 blocker (breaks the site / vetoes go-live) · 2 major (real user-facing defect) · 3 polish.
// NOT an invented severity scheme — readiness.js gates on this exact field.
//
// ── IGNORE IS A VIEW FILTER ONLY. THIS IS DELIBERATE, NOT A SHORTCUT. ──────────────────────────────
// The mockup re-scored on ignore because it IS a scoring simulator: it owns its numbers and recomputes
// them live. This report cannot honestly do that:
//
//   • The score is a RECORDED artifact, not a live figure. renderReport writes report.json beside
//     report.html carrying data.score, and compare.js:recordScan appends that same score to the
//     per-domain history (_index.jsonl) that comparison.html diffs. A headline that re-scored on click
//     would show a number contradicting report.json, the recorded scan, and every comparison built from
//     it — "two different scores for the same site", the exact defect the mockup itself flags as a bug.
//   • It would fork the scoring model. score.js is constitutional ("this file hardcodes NO deductions
//     and NO weights") and already owns the ONLY honest exclusion path (opts.excludeRules — an excluded
//     rule must leave openRisk AND totalRisk TOGETHER, or scope becomes a score-inflation dial).
//     Re-implementing that in the browser is a second source of truth that will drift.
//   • Nothing here persists. A score that drops on click and jumps back on reload is not a score.
//
// So ignore dims/strikes the row and NOTHING else: score, tally and launch verdict are untouched, and a
// reduced view is disclosed loudly (ignDisclosure). Re-scoring against a chosen scope is a real
// capability — it belongs server-side in score.js's excludeRules, on a re-run, where it gets recorded.
// Ignored rows are MARKED, never removed: you can always see (and undo) what you triaged away.
// Fail closed — hide from the list, never from the verdict.
var PRI_NAME={1:'BLOCKER',2:'MAJOR',3:'POLISH'};
var PRIO='all', IGN=Object.create(null);
// Flatten every open finding (fail|warn — report-contract's definition of "an actual problem") out of
// the per-section tree. key = the existing chk-s{si}c{ci} anchor, so ignore is per-ISSUE and each row
// still deep-links into its per-section detail (evidence, occurrences, element locators).
function issueList(){var out=[];
  D.suites.forEach(function(su,si){su.checks.forEach(function(c,ci){
    if(c.status!=='fail'&&c.status!=='warn')return;
    // tier null = no registry rule resolved for this row; surfaced as POLISH per the mockup's
    // (r.tier||3) default, but labelled UNTIERED so we never silently assert a priority we lack.
    out.push({c:c,su:su.name,key:'chk-s'+si+'c'+ci,tier:(c.tier==null?3:c.tier),untiered:c.tier==null});});});
  out.sort(function(a,b){return a.tier-b.tier||((b.c.deduction||0)-(a.c.deduction||0));});
  return out;}
function issueRow(x){var c=x.c,ig=!!IGN[x.key],n=(c.items||[]).length;
  return '<div class="iss'+(ig?' ignored':'')+'" data-prio="'+x.tier+'" data-key="'+x.key+'">'
    +'<span class="pri pri-'+x.tier+'" title="Launch tier '+(x.untiered?'unknown':x.tier)+'">'+(x.untiered?'UNTIERED':PRI_NAME[x.tier])+'</span>'
    +'<span class="iss-rid">'+esc(c.ruleId||'\\u2014')+'</span>'
    +'<div class="iss-b"><div class="iss-t">'+esc(c.name)+'</div>'
    +'<div class="iss-m">'+esc(x.su)+' \\u00b7 '+esc(c.status)+(c.method?' \\u00b7 '+esc(c.method):'')+(n?' \\u00b7 '+n+' occurrence'+(n>1?'s':''):'')+'</div>'
    +(c._why?'<div class="iss-why">'+esc(c._why)+'</div>':'')+'</div>'
    +'<span class="iss-cost" title="points this rule costs its section score">'+(c.deduction?'\\u2212'+c.deduction:'\\u2014')+'</span>'
    +'<button class="iss-go" onclick="gotoIssue(\\''+x.key+'\\')" title="Open this issue in the per-section detail — evidence, every occurrence, element locators">detail \\u2192</button>'
    +(c._md?copyBtn(c._md,'\\u29C9 Copy for dev'):'')
    +'<button class="ig" onclick="tgIgnore(\\''+x.key+'\\')" title="Triage this row out of the list. VIEW FILTER ONLY — the score and the launch verdict do not change.">'+(ig?'\\u2713 ignored':'ignore')+'</button>'
    +'</div>';}
// Reduced-view disclosure (mockup: renderIntegrity). A clean-looking report that quietly hides failures
// is the most dangerous output this tool produces. A waived blocker is still counted, and is disclosed
// as waived — ignoring is a triage decision, never a launch waiver.
function ignDisclosure(all){var ig=all.filter(function(x){return IGN[x.key];});if(!ig.length)return '';
  var blk=ig.filter(function(x){return x.tier===1&&!x.untiered;});
  return '<div class="integ"><div class="integ-i">\\u26a0</div><div><b>REDUCED VIEW \\u2014 '+ig.length+' issue'+(ig.length>1?'s':'')+' ignored.</b> '
    +'Ignore is a <b>view filter only</b>: the quality score, the check tally and the launch verdict above are <b>unchanged</b>, and report.json still carries every finding.'
    +(blk.length?' <b>'+blk.length+' of them '+(blk.length>1?'are tier-1 launch blockers':'is a tier-1 launch blocker')+' \\u2014 waiving does NOT clear the launch gate.</b>':'')
    +'</div></div>';}
function pbtn(v,label,n){return '<button class="pbtn" data-p="'+v+'" aria-pressed="'+(PRIO===v?'true':'false')+'" onclick="issPrio(\\''+v+'\\')">'+label+' <span class="c">'+n+'</span></button>';}
window.renderIssues=function(){var host=document.getElementById('issec');if(!host)return;
  var all=issueList(),byTier={1:0,2:0,3:0},nIg=0;
  all.forEach(function(x){byTier[x.tier]++;if(IGN[x.key])nIg++;});
  var vis=all.filter(function(x){return PRIO==='all'||String(x.tier)===PRIO;});
  var ct='\\u00b7 '+(all.length-nIg)+' open'+(nIg?' \\u00b7 '+nIg+' ignored':'')+(PRIO!=='all'?' \\u00b7 showing '+vis.length+' of '+all.length:'');
  host.innerHTML='<div class="iss-hd"><h2>Issues \\u2014 every open finding, flattened out of the per-section tree</h2><span class="iss-ct">'+esc(ct)+'</span></div>'
    +'<div class="iss-note">Priority is the launch tier from the rule registry: <b>BLOCKER</b> vetoes go-live \\u00b7 <b>MAJOR</b> is a real user-facing defect \\u00b7 <b>POLISH</b> is advisory. Every row carries its dev handover ticket and deep-links to its evidence.</div>'
    +'<div class="iss-ctl">'+'<div class="pseg" role="group" aria-label="Filter issues by priority">'+pbtn('all','ALL',all.length)+pbtn('1','BLOCKERS',byTier[1])+pbtn('2','MAJOR',byTier[2])+pbtn('3','POLISH',byTier[3])+'</div>'
    +(nIg?'<button class="iss-un" onclick="clearIgnored()">un-ignore all ('+nIg+')</button>':'')+'</div>'
    +ignDisclosure(all)
    +(vis.length?vis.map(issueRow).join(''):'<div class="iss-empty">No '+(PRIO==='all'?'':esc(PRI_NAME[PRIO].toLowerCase())+' ')+'issues \\u2014 nothing open in this filter.</div>');};
window.issPrio=function(p){PRIO=p;renderIssues();};
window.tgIgnore=function(key){if(IGN[key])delete IGN[key];else IGN[key]=true;renderIssues();};
window.clearIgnored=function(){IGN=Object.create(null);renderIssues();};
renderIssues();

// Inspector Lenses (Phase 2) — the same findings re-viewed by inspector/interaction facet, each with a
// sub-score. Additive: reads D.lenses + D.findings; the frozen Quality Score + dashboard are untouched.
(function(){
  var host=document.getElementById('lenses'); if(!host||!D.lenses||!D.findings)return;
  var L=D.lenses.scores, order=D.lenses.lenses;
  function col(s){return gcol(s);}
  function sevShort(s){return s==='critical'||s==='high'?'high':s==='medium'?'med':'low';}
  function lensFindings(k){var isInt=L[k].interaction;return D.findings.filter(function(f){return isInt?f.interaction:(f.inspector===k);});}
  function byRule(fs){var g={},ord=[];fs.forEach(function(f){var k=f.ruleId||(f.metadata&&f.metadata.name)||'x';if(!g[k]){g[k]={f:f,n:0};ord.push(k);}g[k].n++;});return ord.map(function(k){return g[k];});}
  function issueBtn(item){var f=item.f;var st=(f.metadata&&f.metadata.status==='fail')||f.severity==='critical'||f.severity==='high'?'fail':'warn';var sev=sevShort(f.severity||'low');
    var inner='<span class="st">'+GLYPH[st]+'</span><span class="inm">'+esc((f.metadata&&f.metadata.name)||f.ruleId)+'</span><span class="rid">'+esc(f.ruleId||'')+'</span><span class="sev '+sev+'">'+sev+'</span><span class="eq">'+esc(f.evidenceQuality||'')+'</span><span class="n">'+item.n+'\\u00d7</span>';
    return '<button class="li" data-s="'+st+'" data-md="'+encodeURIComponent(f.markdown||'').replace(/\x27/g,'%27')+'" onclick="copyMD(this)" title="Copy a dev-ready ticket for this issue">'+inner+'</button>';}
  var tiles=order.map(function(k){var v=L[k];return '<div class="ltile'+(v.isNew?' new':'')+'"><div class="lt-head"><div class="lt-l"><span class="lt-nm">'+esc(v.name)+(v.isNew?' <span class="lt-badge">New</span>':'')+'</span><span class="lt-sub">'+(v.count?v.count+' issue'+(v.count>1?'s':''):'clean')+'</span></div><span class="lt-sc" style="color:'+col(v.score)+'">'+v.score+'</span></div><div class="lt-trk"><i style="width:'+v.score+'%;background:'+col(v.score)+'"></i></div></div>';}).join('');
  var tabs='<button class="lens-tab" aria-pressed="true" onclick="lensGo(\\'overview\\',this)">Overview</button>'+order.map(function(k){var v=L[k];return '<button class="lens-tab" aria-pressed="false" onclick="lensGo(\\''+k+'\\',this)"><span class="dot" style="background:'+col(v.score)+'"></span>'+esc(v.name.split(' ')[0])+' <span class="c">'+v.count+'</span></button>';}).join('');
  var views=order.map(function(k){var v=L[k];var rows=byRule(lensFindings(k)).map(issueBtn).join('');
    return '<div class="lens-view" id="lv-'+k+'"><div class="lens-hd'+(v.isNew?' new':'')+'"><div class="lh-sc" style="color:'+col(v.score)+'">'+v.score+'</div><div><div class="lh-nm">'+esc(v.name)+(v.isNew?' <span class="lt-badge">New</span>':'')+'</div><div class="lh-q">'+esc(v.question)+'</div></div><div class="lh-meta">'+v.count+' issue'+(v.count===1?'':'s')+(v.pages?'<br>'+v.pages+' page'+(v.pages>1?'s':''):'')+'</div></div>'+(v.interaction&&v.count?'<div class="lens-note">A site can score well elsewhere and still have a dead control. Every finding here carries a copy-ready Playwright/Cypress locator to the exact element — click any row to copy the dev ticket.</div>':'')+(rows||'<div class="lens-clean">No issues in this lens \\u2014 clean.</div>')+'</div>';}).join('');
  var overview='<div class="lens-view on" id="lv-overview"><div class="lens-note" style="border-left-color:var(--ink-faint)">Pick a lens to focus on one dimension. Overview is the full dashboard below \\u2014 the lenses are an additional way in, not a replacement. Same findings, same Copy-for-dev tickets. Click any lens issue to copy its ticket.</div></div>';
  host.innerHTML='<div class="lens-h">Inspector lenses \\u2014 quality by dimension</div><div class="sec-sub">A 0\\u2013100 quality read per dimension \\u2014 a summary view, not a separate pass/fail.</div><div class="lens-tiles">'+tiles+'</div>';
})();
window.lensGo=function(name,btn){
  document.querySelectorAll('.lens-view').forEach(function(v){v.classList.toggle('on',v.id==='lv-'+name);});
  var tabs=document.querySelectorAll('.lens-tab');tabs.forEach(function(t){t.setAttribute('aria-pressed','false');});
  if(btn&&btn.classList.contains('lens-tab'))btn.setAttribute('aria-pressed','true');
  else{var idx={overview:0};D.lenses.lenses.forEach(function(k,i){idx[k]=i+1;});if(tabs[idx[name]])tabs[idx[name]].setAttribute('aria-pressed','true');}
  var lt=document.querySelector('.lens-tabs');if(lt)window.scrollTo({top:lt.getBoundingClientRect().top+window.scrollY-70,behavior:'smooth'});
};

(function(){var reduce=matchMedia('(prefers-reduced-motion:reduce)').matches;var tot=D.tally.pass+D.tally.warn+D.tally.fail;var segs=[['var(--pass)',D.tally.pass],['var(--warn)',D.tally.warn],['var(--fail)',D.tally.fail]];var acc=0,html='';segs.forEach(function(s){var len=tot?s[1]/tot*C:0;html+='<circle cx="64" cy="64" r="52" fill="none" stroke-width="11" stroke="'+s[0]+'" stroke-dasharray="'+len+' '+(C-len)+'" stroke-dashoffset="'+(-acc)+'"></circle>';acc+=len;});document.getElementById('ringsegs').innerHTML=html;var el=document.getElementById('score');if(el)el.style.color=gcol(D.score);if(reduce){el.textContent=D.score+'%';return;}var n=0,step=Math.max(1,Math.round(D.score/28));var iv=setInterval(function(){n+=step;if(n>=D.score){n=D.score;clearInterval(iv);}el.textContent=n+'%';},22);})();

document.querySelectorAll('[data-count]').forEach(function(el){var target=+el.getAttribute('data-count');if(matchMedia('(prefers-reduced-motion:reduce)').matches){el.textContent=target;return;}var n=0,step=Math.max(1,Math.round(target/26));var iv=setInterval(function(){n+=step;if(n>=target){n=target;clearInterval(iv);}el.textContent=n;},24);});

window.filt=function(mode,btn){document.querySelectorAll('.tab').forEach(function(t){t.setAttribute('aria-pressed',t===btn?'true':'false');});document.querySelectorAll('.suite').forEach(function(su){var any=false;su.querySelectorAll('.row').forEach(function(r){var show=mode==='all'||r.getAttribute('data-status')===mode;r.classList.toggle('hidden',!show);if(show)any=true;});su.classList.toggle('hidden',!any);if(mode!=='all'&&any)su.open=true;if(mode==='all')su.open=false;});
  /* Evidence belongs to the WHOLE scan, not to a filtered slice. The screenshot gallery is per
     page+viewport — it is not filtered by finding status, so leaving it on screen under "Failed"
     implies those shots ARE the failures. They are not. Show it only under All. */
  var ev=document.querySelector('.shotsec');if(ev)ev.classList.toggle('hidden',mode!=='all');};
// Score-summary tiles (beside the ring) are clickable: filter the detailed results to that status + scroll there.
window.gotoStatus=function(mode){var sel={all:'.tab.all',fail:'.tab.fail',warn:'.tab.warn',pass:'.tab.pass',manual:'.tab.manual'}[mode]||'.tab.all';var tab=document.querySelector(sel);if(tab)filt(mode,tab);var bar=document.querySelector('.tabs');if(bar)window.scrollTo({top:bar.getBoundingClientRect().top+window.scrollY-80,behavior:'smooth'});};
window.gotoShots=function(){var s=document.querySelector('.shotsec');if(s){window.scrollTo({top:s.getBoundingClientRect().top+window.scrollY-80,behavior:'smooth'});}else{gotoStatus('all');}};
// 3.0.0 — the dashboard's per-section "N issues →" chip jumps to the flat Issues section (which owns
// the full list + priority filter + ignore), instead of re-listing those rows inside the dashboard.
window.gotoIssues=function(prio){var s=document.getElementById('issec');if(!s)return;if(prio)issPrio(String(prio));window.scrollTo({top:s.getBoundingClientRect().top+window.scrollY-70,behavior:'smooth'});};
document.addEventListener('keydown',function(e){if((e.key==='Enter'||e.key===' ')&&document.activeElement&&document.activeElement.classList&&document.activeElement.classList.contains('tile')){e.preventDefault();document.activeElement.click();}});

// screenshot lightbox — click to preview, arrows / buttons to step
// evidence gallery filter — toggle by page + viewport for easy review
window.evFilter=function(btn){var k=btn.getAttribute('data-k');btn.parentNode.querySelectorAll('.evchip').forEach(function(c){c.classList.remove('on');});btn.classList.add('on');
var pg=(document.querySelector('.evchip.on[data-k="pg"]')||{}).getAttribute?document.querySelector('.evchip.on[data-k="pg"]').getAttribute('data-v'):'__all';
var vp=(document.querySelector('.evchip.on[data-k="vp"]')||{}).getAttribute?document.querySelector('.evchip.on[data-k="vp"]').getAttribute('data-v'):'__all';
var shown=0;document.querySelectorAll('.shotgrid .shotcard').forEach(function(card){var okP=pg==='__all'||card.getAttribute('data-pg')===pg;var okV=vp==='__all'||card.getAttribute('data-vp')===vp;var show=okP&&okV;card.classList.toggle('evhide',!show);if(show)shown++;});
var cnt=document.getElementById('ev-count');if(cnt)cnt.textContent=shown;};
(function(){var rows=[].slice.call(document.querySelectorAll('.shotgrid .shotcard')),idx=0,lb=document.getElementById('lb');if(!lb||!rows.length)return;
window.lbShow=function(i){idx=(i+rows.length)%rows.length;var row=rows[idx];document.getElementById('lbimg').src=row.querySelector('img').src;document.getElementById('lbcap').textContent=row.getAttribute('data-cap')||'';document.getElementById('lbcount').textContent=(idx+1)+' / '+rows.length;lb.classList.add('open');lb.scrollTop=0;};
window.lbStep=function(d){lbShow(idx+d);};window.lbClose=function(){lb.classList.remove('open');};
rows.forEach(function(row,i){row.addEventListener('click',function(){lbShow(i);});});
lb.addEventListener('click',function(e){if(e.target===lb)lbClose();});
document.addEventListener('keydown',function(e){if(!lb.classList.contains('open'))return;if(e.key==='Escape')lbClose();else if(e.key==='ArrowRight')lbStep(1);else if(e.key==='ArrowLeft')lbStep(-1);});})();
// 2.5.12 — hard guard: the Inspect button only works when the report is served by the engine. On the
// standalone file: (or any non-http) copy there is no engine, so hide every Inspect button outright.
(function(){if(location.protocol!=='http:'&&location.protocol!=='https:'){document.querySelectorAll('.inspect-btn').forEach(function(b){b.style.display='none';});document.querySelectorAll('.inspect-hint').forEach(function(h){h.style.display='none';});}})();
${TOTOP_JS}
// Standalone-tab case only. initToTop() no-ops when this report is framed by the app shell, because
// the shell's iframe is grown to full content height and cannot scroll — the shell's own arrow is
// what moves the page there. This report is ~5400px on a real run and its scrollbars are hidden
// (see ::-webkit-scrollbar above), so the standalone tab genuinely needs its own way back up.
initToTop(window);
`;

function renderReport(data, outDir, opts = {}) {
  const vc = data.ready ? (data.tally.warn ? 'warn' : 'pass') : 'fail';
  const vmap = { pass: ['var(--pass)', 'var(--pass-bg)', 'var(--pass-line)'], warn: ['var(--warn)', 'var(--warn-bg)', 'var(--warn-line)'], fail: ['var(--fail)', 'var(--fail-bg)', 'var(--fail-line)'] }[vc];
  const graded = data.tally.pass + data.tally.warn + data.tally.fail;
  const failLine = data.tally.fail > 0 ? `${data.tally.fail} test${data.tally.fail > 1 ? 's' : ''} failing before this site can pass`
    : data.tally.warn > 0 ? `Passing with ${data.tally.warn} warning${data.tally.warn > 1 ? 's' : ''} to review` : 'Every automated check passed';
  // gallery = full-page shots only; per-issue element close-ups stay attached to their findings
  // (evidence column + Copy MD) — as thumbnails they read as noise and crowd out the page views.
  const shots = Object.entries(data.shots || {}).flatMap(([url, arr]) => (arr || []).filter(s => !s.issue).map(s => ({ url, label: s.label, file: s.file })));
  // Inline screenshots as data URIs so the report is fully self-contained (portable / shareable).
  //
  // Inlining the RAW PNG made a real sgen.com report **63 MB** (was 136 MB before the CSS-scale fix)
  // — 62 MB of it base64. Unsendable, which defeats the point of a self-contained report you hand to
  // a client. Full-page captures are the cause: the worst one measured **1024 x 29386 px**.
  //
  // Measured on that evidence (26 inlined shots):
  //   raw PNG base64  62.27 MB   <- today
  //   JPEG q82        16.92 MB   (-72.8%)
  //   JPEG q75        14.22 MB   (-77.2%)
  //
  // WebP was tested first and is IMPOSSIBLE here: sharp throws "Processed image is too large for the
  // WebP format" — WebP caps at 16383px per side, and these shots are 29386px tall.
  //
  // So: inline a JPEG q82 PREVIEW; the lossless PNG stays on disk in screenshots/ for anyone who
  // needs to zoom. The report is for reading, the PNG is the archive. Falls back to the raw PNG if
  // sharp is unavailable, and to a relative path if the file can't be read — a report always renders.
  // renderReport is SYNC and every caller invokes it sync, so we cannot compress here — sharp's
  // toBuffer() is Promise-only and would inline a [object Promise]. The preview is therefore built
  // in capture.js, which is already async, and written beside the PNG as `<name>.preview.jpg`.
  // Here we simply prefer that preview if it exists. Order of fallback: preview JPEG -> raw PNG ->
  // relative path. A report always renders, even with no preview and no readable file.
  const shotCache = new Map();
  const previewOf = (f) => f.replace(/\.png$/i, '.preview.jpg');
  const shotSrc = (s) => {
    if (shotCache.has(s.file)) return shotCache.get(s.file);
    let out;
    const prev = previewOf(s.file);
    try {
      if (prev !== s.file && fs.existsSync(prev)) {
        out = 'data:image/jpeg;base64,' + fs.readFileSync(prev).toString('base64');
      } else {
        out = 'data:image/png;base64,' + fs.readFileSync(s.file).toString('base64');
      }
    } catch (e) {
      try { out = rel(outDir, s.file); } catch (e2) { out = ''; }
    }
    shotCache.set(s.file, out);
    return out;
  };
  const cap = (s) => { try { return esc(s.label + ' · ' + new URL(s.url).pathname); } catch (e) { return esc(s.label); } };
  const pgOf = (s) => { try { return new URL(s.url).pathname; } catch (e) { return s.url; } };
  const galShots = shots.slice(0, 80);
  const galPages = [...new Set(galShots.map(pgOf))];
  const galVps = [...new Set(galShots.map(s => String(s.label)))];
  const chip = (kind, val, label) => `<button class="evchip" data-k="${kind}" data-v="${esc(val)}" onclick="evFilter(this)">${esc(label)}</button>`;
  const filterBar = (galPages.length > 1 || galVps.length > 1) ? `<div class="evfilter">
    ${galPages.length > 1 ? `<div class="evrow"><span class="evlab">Page</span><button class="evchip on" data-k="pg" data-v="__all" onclick="evFilter(this)">All</button>${galPages.map(p => chip('pg', p, p || '/')).join('')}</div>` : ''}
    ${galVps.length > 1 ? `<div class="evrow"><span class="evlab">Viewport</span><button class="evchip on" data-k="vp" data-v="__all" onclick="evFilter(this)">All</button>${galVps.map(v => chip('vp', v, String(v).replace(/-/g, ' '))).join('')}</div>` : ''}
  </div>` : '';
  const shotHtml = shots.length ? `<section class="shotsec"><h2>Rendered screenshots · evidence (<span id="ev-count">${galShots.length}</span>) — click a card to open the full page</h2>${filterBar}<div class="shotgrid">${galShots.map(s => `<div class="shotcard" data-pg="${esc(pgOf(s))}" data-vp="${esc(String(s.label))}" data-cap="${cap(s)}"><div class="thumb"><img loading="lazy" src="${shotSrc(s)}"></div><div class="cardcap"><div class="vp">${esc(String(s.label).replace(/-/g, ' '))}</div><div class="pg">${esc(pgOf(s))}</div></div></div>`).join('')}</div></section>` : '';
  const lightbox = shots.length ? `<div class="lb" id="lb"><button class="x" onclick="lbClose()" aria-label="close">×</button><button class="nav prev" onclick="lbStep(-1)" aria-label="previous">‹</button><img id="lbimg" alt="screenshot preview"><button class="nav next" onclick="lbStep(1)" aria-label="next">›</button><div class="cap" id="lbcap"></div><div class="count" id="lbcount"></div></div>` : '';

  // Readiness pill. The renderer does NOT trust an upstream 'ok' blindly: it independently refuses to
  // paint the pill green whenever the report's own overall verdict is not clean (data.ready !== true).
  // Two reasons. (1) Legacy: report.json files written before readiness 1.5.1 carry no `tone` and a
  // literal verdict:"LAUNCH-READY" on runs that scored 49 — re-rendering one must not reprint the lie.
  // (2) Belt and braces: the invariant a client depends on is a property of this PAGE — the badge can
  // never contradict the verdict sitting 8px to its left — so it is enforced here, at the last step
  // before ink, not only in the layer that happens to feed it today.
  const rdBadge = (() => {
    const rd = data.readiness;
    if (!rd) return '';
    let tone = rd.tone || (rd.launchReady ? 'ok' : 'no');
    let label = rd.verdict;
    let scope = rd.scope || '';
    if (tone === 'ok' && data.ready !== true) {
      tone = 'part';
      const n = typeof rd.outstanding === 'number'
        ? rd.outstanding
        : (data.tally ? data.tally.fail + data.tally.warn : 0);
      label = n > 0 ? `NO LAUNCH BLOCKERS — ${n} issue${n > 1 ? 's' : ''} outstanding` : 'NO LAUNCH BLOCKERS';
      scope = scope || 'Checked for launch-blocking (tier-1) faults only — none found. Other checks are still failing. This is NOT an all-clear.';
    }
    return `<span class="rlabel ${tone}"${scope ? ` title="${esc(scope)}"` : ''}>${esc(label)}</span>`;
  })();

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SGEN Site QA — ${esc(data.host)}</title><style>${STYLE}</style></head><body>
<div class="brand-wm" aria-hidden="true"><b>SGEN</b></div>
<div class="bar"><div class="bar-in">
  <div class="brand"><span class="mark"><svg viewBox="0 0 24 24" fill="none"><path d="M5 12.5l4.2 4.2L19 7" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg></span><div><b>Site QA</b><span>SGEN · Tester</span></div></div>
  <div class="target"><span class="glob" style="background:${data.ready ? 'var(--pass)' : 'var(--fail)'}"></span><span class="u">${esc(data.target)}</span></div>
  <div class="rerun">re-run · <code>sgen qa-site ${esc(data.target)}</code></div>
</div></div>
<div class="wrap">
  ${opts.scopePanel || ''}
  <section class="summary">
    <div class="verdict" style="--vc:${vmap[0]};--vcb:${vmap[1]};--vcl:${vmap[2]}">
      <div class="ring"><svg width="118" height="118" viewBox="0 0 128 128"><circle cx="64" cy="64" r="52" fill="none" stroke="var(--line)" stroke-width="11"></circle><g id="ringsegs"></g></svg><div class="center"><div class="big num" id="score">0</div><div class="sm">checks passing</div></div></div>
      <div class="vtext"><div class="veyebrow">Overall result — the bottom line</div><span class="vlabel">${esc(data.verdict)}</span>${rdBadge}<h1>${esc(failLine)}</h1><p>${graded} automated checks across ${data.suites.length} suites · ${data.tally.manual} item(s) flagged for manual review. The scores below are 0–100 quality reads, not separate pass/fail verdicts.</p></div>
    </div>
    <div class="tiles">
      <div class="tile pass" onclick="gotoStatus('pass')" role="button" tabindex="0" title="Show passed checks"><div class="v num" data-count="${data.tally.pass}">0</div><div class="l"><span class="dot"></span>Passed</div></div>
      <div class="tile warn" onclick="gotoStatus('warn')" role="button" tabindex="0" title="Show warnings"><div class="v num" data-count="${data.tally.warn}">0</div><div class="l"><span class="dot"></span>Warnings</div></div>
      <div class="tile fail" onclick="gotoStatus('fail')" role="button" tabindex="0" title="Show failed checks"><div class="v num" data-count="${data.tally.fail}">0</div><div class="l"><span class="dot"></span>Failed</div></div>
      <div class="tile man" onclick="gotoStatus('manual')" role="button" tabindex="0" title="Show items needing manual review"><div class="v num" data-count="${data.tally.manual}">0</div><div class="l"><span class="dot"></span>Manual</div></div>
      <div class="tile meta" onclick="gotoStatus('all')" role="button" tabindex="0" title="Show all checks"><div class="v mono">${data.crawl.pages}</div><div class="l"><span class="dot"></span>Pages crawled</div></div>
      <div class="tile meta" onclick="gotoShots()" role="button" tabindex="0" title="Jump to rendered screenshots"><div class="v mono">${data.render.rendered}</div><div class="l"><span class="dot"></span>Rendered</div></div>
      ${(() => {
        // COPY REVIEW card (Suite 13). Advisory: WEIGHTS.copy = 0 and every row is status 'manual',
        // so this number can never move the score — it is a READ, not a verdict. Counts flagged rules
        // (of 4), not "AI-ness": the tool cannot know who wrote the copy and must never imply it.
        // Rendered only when the copy suite actually ran, so an older scan's report is unchanged.
        const cs = (data.suites || []).find(s => s.key === 'copy');
        if (!cs) return '';
        const flagged = (cs.checks || []).filter(c => (c.items || []).length > 0).length;
        const total = (cs.checks || []).length;
        const title = flagged ? flagged + ' of ' + total + ' copy checks flagged something for review — advisory only, does not affect the score'
                              : 'No copy flags raised — advisory only, does not affect the score';
        // Click-through goes to gotoStatus('manual') — an EXISTING, proven handler (window.gotoStatus).
        // Copy rows are all status 'manual', so the Manual filter is exactly where they live. Do not
        // invent a gotoSuite(): there is no such function, and a dead onclick here is not a dead link —
        // it throws at parse and kills EVERY handler on the page (the 3.0.3 escape bug). suite:'copy'
        // is unreachable from the status tabs otherwise.
        return '<div class="tile meta" onclick="gotoStatus(\'manual\')" role="button" tabindex="0" title="' + title + '">'
             + '<div class="v mono">' + flagged + '/' + total + '</div>'
             + '<div class="l"><span class="dot"></span>Copy flags</div></div>';
      })()}
    </div>
    <div class="legend" aria-label="Colour key">
      <span class="lg-t">What the colours mean</span>
      <span class="lg"><i style="background:var(--pass)"></i> Red = passing / good</span>
      <span class="lg"><i style="background:var(--warn)"></i> Grey = warning</span>
      <span class="lg"><i style="background:var(--fail)"></i> Silver = failed</span>
      <span class="lg"><i style="background:var(--man)"></i> Dark = manual review</span>
    </div>
  </section>
  ${opts.comparePanel || ''}
  <section class="lenses" id="lenses"></section>
  <section class="qscore" id="qscore"></section>
  <section class="issec" id="issec"></section>
  ${shotHtml}
  <section class="detsec">
    <h2>Passed tests &amp; per-section detail</h2>
    <div class="sec-sub">Every check grouped by section — passed, warnings, failures and manual items, each with its evidence, occurrences and element locators. Collapsed by default: open a section to drill in, or use "detail →" on any issue above.</div>
    <div class="tabs" role="group" aria-label="Filter">
      <button class="tab all" aria-pressed="true" onclick="filt('all',this)">All <span class="c num">${graded + data.tally.manual}</span></button>
      <button class="tab fail" aria-pressed="false" onclick="filt('fail',this)">Failed <span class="c num">${data.tally.fail}</span></button>
      <button class="tab warn" aria-pressed="false" onclick="filt('warn',this)">Warnings <span class="c num">${data.tally.warn}</span></button>
      <button class="tab pass" aria-pressed="false" onclick="filt('pass',this)">Passed <span class="c num">${data.tally.pass}</span></button>
      <button class="tab manual" aria-pressed="false" onclick="filt('manual',this)">Manual <span class="c num">${data.tally.manual}</span></button>
    </div>
    <section class="results" id="results"></section>
  </section>
  <footer><span>SGEN Site QA · ${esc(data.host)} · ${esc(data.generated)}</span><span>Chromium render · ${data.render.rendered}/${data.render.total} pages · ${data.suites.length} suites</span></footer>
</div>
${lightbox}
<script>window.__DATA=${JSON.stringify(data)};</script>
<script>${CLIENT}</script>
</body></html>`;

  fs.mkdirSync(outDir, { recursive: true });
  const htmlPath = path.join(outDir, 'report.html');
  const jsonPath = path.join(outDir, 'report.json');
  fs.writeFileSync(htmlPath, html);
  fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2));
  return { htmlPath, jsonPath };
}

module.exports = { renderReport, STYLE, esc, TOTOP_JS };
