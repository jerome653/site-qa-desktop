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
:root,:root[data-theme="light"],:root[data-theme="dark"]{color-scheme:dark;--ground:#000000;--surface:#0B0A09;--surface-2:#131110;--line:#221F1B;--line-strong:#332E27;--ink:#F3EEE6;--ink-soft:#B0A796;--ink-faint:#726A5D;--brand:#E01F26;--brand-ink:#E01F26;--brand-solid:#C8181C;--pass:#C8181C;--pass-bg:#1C0908;--pass-line:#3E1512;--warn:#6E6E6E;--warn-bg:#141414;--warn-line:#262626;--fail:#B9BBBE;--fail-bg:#141414;--fail-line:#2A2A2A;--man:#4A4A4A;--man-bg:#131110;--man-line:#242424;--shadow:0 1px 2px rgba(0,0,0,.55),0 12px 34px rgba(0,0,0,.5);--shadow-sm:0 1px 2px rgba(0,0,0,.4);--radius:14px;--sans:ui-sans-serif,system-ui,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;--mono:ui-monospace,"Cascadia Code","SFMono-Regular",Menlo,Consolas,monospace;}
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
footer{margin-top:30px;padding-top:18px;border-top:1px solid var(--line);display:flex;flex-wrap:wrap;gap:8px 22px;justify-content:space-between;font-family:var(--mono);font-size:11px;color:var(--ink-faint)}
@media (max-width:820px){.summary{grid-template-columns:1fr}}
@media (max-width:560px){.tiles{grid-template-columns:1fr 1fr}}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
`;

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
function drill(items,c){if(!items||!items.length)return '';var hasEv=items.some(function(it){return it.evidence;});var rows=items.slice(0,500).map(function(it){return '<tr><td class="pg">'+pgLink(it.page)+'</td><td>'+esc(it.section||'—')+'</td><td class="id">'+idLink(it.id||'')+'</td><td class="vl">'+esc(it.value||'')+'</td>'+(hasEv?'<td class="vl">'+(it.evidence?'<span title="'+esc(it.evidence)+'">&#128247;</span>':'—')+'</td>':'')+'<td>'+(it._md?copyBtn(it._md,'\\u29C9'):'')+'</td></tr>';}).join('');var more=items.length>500?'<tr><td colspan="6">+'+(items.length-500)+' more (full list in report.json)</td></tr>':'';return '<details class="drill"><summary>&#9656; show '+items.length+' occurrence'+(items.length>1?'s':'')+' &middot; page &middot; section &middot; identifier</summary><div class="dwrap"><table><thead><tr><th>Page</th><th>Section</th><th>Identifier</th><th>Value</th>'+(hasEv?'<th>Evidence</th>':'')+'<th></th></tr></thead><tbody>'+rows+more+'</tbody></table></div></details>';}

document.getElementById('results').innerHTML=D.suites.map(function(su,si){var t=su.pass+su.warn+su.fail+su.manual;var w=worst(su);var badge=w==='fail'?'<span class="badge fail">'+su.fail+' failed</span>':w==='warn'?'<span class="badge warn">'+su.warn+' warning'+(su.warn>1?'s':'')+'</span>':w==='manual'?'<span class="badge manual">needs review</span>':'<span class="badge pass">all passing</span>';
var rows=su.checks.map(function(c,ci){var canCopy=(c.status==='fail'||c.status==='warn')&&c._md;return '<div class="row" id="chk-s'+si+'c'+ci+'" data-status="'+c.status+'"><span class="st">'+GLYPH[c.status]+'</span><div class="rbody"><div class="rname">'+esc(c.name)+(canCopy?' '+copyBtn(c._md,'\\u29C9 Copy for dev'):'')+'</div>'+(c.target?'<div class="rtarget">'+esc(c.target)+'</div>':'')+(c.detail?'<div class="rdetail">'+esc(c.detail)+'</div>':'')+drill(c.items,c)+'</div><span class="rmeta">'+esc(c.meta||'')+'</span></div>';}).join('');
var open=(w!=='pass')?' open':'';
return '<details class="suite" data-worst="'+w+'"'+open+'><summary><span class="sicon"><svg viewBox="0 0 24 24">'+ICONS[su.icon]+'</svg></span><span class="sname"><b>'+esc(su.name)+'</b><div class="sub">'+esc(su.desc)+'</div></span><span class="sratio">'+su.pass+'/'+(su.pass+su.warn+su.fail)+'</span>'+badge+'<svg class="chev" width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></summary><div class="rows">'+rows+'</div></details>';}).join('');

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
var MAX=5;
var rhtml=rows.slice(0,MAX).map(function(x){var n=(x.ch.items||[]).length;return '<button class="qi" data-status="'+x.ch.status+'" onclick="gotoIssue(\\'chk-s'+m.si+'c'+x.ci+'\\')"><span class="d-st">'+GLYPH[x.ch.status]+'</span><span class="qi-name">'+esc(x.ch.name)+'</span>'+(n?'<span class="qi-n">'+n+'\\u00d7</span>':'')+'<span class="d-go">\\u2192</span></button>';}).join('');
if(rows.length>MAX)rhtml+='<button class="qi qi-more" onclick="gotoIssue(\\'chk-s'+m.si+'c'+rows[MAX].ci+'\\')">+'+(rows.length-MAX)+' more in '+esc(c.name)+' \\u2192</button>';
cards.push({score:c.score,html:'<div class="qcat"><div class="top"><span class="nm">'+esc(c.name)+'</span>'+(c.score!=null?'<span class="sc" style="color:'+col(c.score)+'">'+c.score+'</span>':'')+'</div>'+(c.score!=null?'<div class="track"><i style="width:'+c.score+'%;background:'+col(c.score)+'"></i></div>':'')+rhtml+'</div>'});});
cards.sort(function(a,b){return (a.score==null?101:a.score)-(b.score==null?101:b.score);});
var cleanHtml=clean.length?'<div class="qclean">Clean: '+clean.map(function(x){return '<span class="qclean-chip">'+esc(x.name)+(x.score!=null?' '+x.score:'')+'</span>';}).join('')+'</div>':'';
var head='<div class="qs-head"><h2>Quality dashboard \\u00b7 '+totalIssues+' issue'+(totalIssues===1?'':'s')+' \\u2014 click any row for full detail + evidence</h2>'+(D.quality?'<span class="ov" style="color:'+col(D.quality.overall)+'">'+D.quality.overall+'</span>':'')+'</div><div class="sec-sub">Quality score per suite (0\\u2013100) with every issue \\u2014 not a pass/fail; the verdict is up top.</div>';
var blockHtml=blockers.length?'<div class="qblock"><div class="qblock-h">\\ud83d\\udd34 Fix first \\u2014 break'+(blockers.length===1?'s':'')+' the site \\u00b7 '+blockers.length+' launch blocker'+(blockers.length>1?'s':'')+'</div>'+blockers.map(function(x){var n=(x.ch.items||[]).length;return '<button class="qi qb" data-status="'+x.ch.status+'" onclick="gotoIssue(\\'chk-s'+x.si+'c'+x.ci+'\\')"><span class="d-st">'+GLYPH[x.ch.status]+'</span><span class="qi-name">'+esc(x.ch.name)+'</span><span class="qi-n">'+esc(x.su)+(n?' \\u00b7 '+n+'\\u00d7':'')+'</span><span class="d-go">\\u2192</span></button>';}).join('')+'</div>':'';
el.innerHTML=head+blockHtml+'<div class="qs-grid">'+cards.map(function(x){return x.html;}).join('')+'</div>'+cleanHtml;})();

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

window.filt=function(mode,btn){document.querySelectorAll('.tab').forEach(function(t){t.setAttribute('aria-pressed',t===btn?'true':'false');});document.querySelectorAll('.suite').forEach(function(su){var any=false;su.querySelectorAll('.row').forEach(function(r){var show=mode==='all'||r.getAttribute('data-status')===mode;r.classList.toggle('hidden',!show);if(show)any=true;});su.classList.toggle('hidden',!any);if(mode!=='all'&&any)su.open=true;if(mode==='all')su.open=su.getAttribute('data-worst')!=='pass';});};
// Score-summary tiles (beside the ring) are clickable: filter the detailed results to that status + scroll there.
window.gotoStatus=function(mode){var sel={all:'.tab.all',fail:'.tab.fail',warn:'.tab.warn',pass:'.tab.pass',manual:'.tab.manual'}[mode]||'.tab.all';var tab=document.querySelector(sel);if(tab)filt(mode,tab);var bar=document.querySelector('.tabs');if(bar)window.scrollTo({top:bar.getBoundingClientRect().top+window.scrollY-80,behavior:'smooth'});};
window.gotoShots=function(){var s=document.querySelector('.shotsec');if(s){window.scrollTo({top:s.getBoundingClientRect().top+window.scrollY-80,behavior:'smooth'});}else{gotoStatus('all');}};
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
`;

function renderReport(data, outDir) {
  const vc = data.ready ? (data.tally.warn ? 'warn' : 'pass') : 'fail';
  const vmap = { pass: ['var(--pass)', 'var(--pass-bg)', 'var(--pass-line)'], warn: ['var(--warn)', 'var(--warn-bg)', 'var(--warn-line)'], fail: ['var(--fail)', 'var(--fail-bg)', 'var(--fail-line)'] }[vc];
  const graded = data.tally.pass + data.tally.warn + data.tally.fail;
  const failLine = data.tally.fail > 0 ? `${data.tally.fail} test${data.tally.fail > 1 ? 's' : ''} failing before this site can pass`
    : data.tally.warn > 0 ? `Passing with ${data.tally.warn} warning${data.tally.warn > 1 ? 's' : ''} to review` : 'Every automated check passed';
  // gallery = full-page shots only; per-issue element close-ups stay attached to their findings
  // (evidence column + Copy MD) — as thumbnails they read as noise and crowd out the page views.
  const shots = Object.entries(data.shots || {}).flatMap(([url, arr]) => (arr || []).filter(s => !s.issue).map(s => ({ url, label: s.label, file: s.file })));
  // inline screenshots as data URIs so the report is fully self-contained (portable / shareable / artifact-safe)
  const shotSrc = (s) => { try { return 'data:image/png;base64,' + fs.readFileSync(s.file).toString('base64'); } catch (e) { return rel(outDir, s.file); } };
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

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SGEN Site QA — ${esc(data.host)}</title><style>${STYLE}</style></head><body>
<div class="brand-wm" aria-hidden="true"><b>SGEN</b></div>
<div class="bar"><div class="bar-in">
  <div class="brand"><span class="mark"><svg viewBox="0 0 24 24" fill="none"><path d="M5 12.5l4.2 4.2L19 7" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg></span><div><b>Site QA</b><span>SGEN · Tester</span></div></div>
  <div class="target"><span class="glob" style="background:${data.ready ? 'var(--pass)' : 'var(--fail)'}"></span><span class="u">${esc(data.target)}</span></div>
  <div class="rerun">re-run · <code>sgen qa-site ${esc(data.target)}</code></div>
</div></div>
<div class="wrap">
  <section class="summary">
    <div class="verdict" style="--vc:${vmap[0]};--vcb:${vmap[1]};--vcl:${vmap[2]}">
      <div class="ring"><svg width="118" height="118" viewBox="0 0 128 128"><circle cx="64" cy="64" r="52" fill="none" stroke="var(--line)" stroke-width="11"></circle><g id="ringsegs"></g></svg><div class="center"><div class="big num" id="score">0</div><div class="sm">checks passing</div></div></div>
      <div class="vtext"><div class="veyebrow">Overall result — the bottom line</div><span class="vlabel">${esc(data.verdict)}</span>${data.readiness ? `<span class="rlabel ${data.readiness.launchReady ? 'ok' : 'no'}">${esc(data.readiness.verdict)}</span>` : ''}<h1>${esc(failLine)}</h1><p>${graded} automated checks across ${data.suites.length} suites · ${data.tally.manual} item(s) flagged for manual review. The scores below are 0–100 quality reads, not separate pass/fail verdicts.</p></div>
    </div>
    <div class="tiles">
      <div class="tile pass" onclick="gotoStatus('pass')" role="button" tabindex="0" title="Show passed checks"><div class="v num" data-count="${data.tally.pass}">0</div><div class="l"><span class="dot"></span>Passed</div></div>
      <div class="tile warn" onclick="gotoStatus('warn')" role="button" tabindex="0" title="Show warnings"><div class="v num" data-count="${data.tally.warn}">0</div><div class="l"><span class="dot"></span>Warnings</div></div>
      <div class="tile fail" onclick="gotoStatus('fail')" role="button" tabindex="0" title="Show failed checks"><div class="v num" data-count="${data.tally.fail}">0</div><div class="l"><span class="dot"></span>Failed</div></div>
      <div class="tile man" onclick="gotoStatus('manual')" role="button" tabindex="0" title="Show items needing manual review"><div class="v num" data-count="${data.tally.manual}">0</div><div class="l"><span class="dot"></span>Manual</div></div>
      <div class="tile meta" onclick="gotoStatus('all')" role="button" tabindex="0" title="Show all checks"><div class="v mono">${data.crawl.pages}</div><div class="l"><span class="dot"></span>Pages crawled</div></div>
      <div class="tile meta" onclick="gotoShots()" role="button" tabindex="0" title="Jump to rendered screenshots"><div class="v mono">${data.render.rendered}</div><div class="l"><span class="dot"></span>Rendered</div></div>
    </div>
    <div class="legend" aria-label="Colour key">
      <span class="lg-t">What the colours mean</span>
      <span class="lg"><i style="background:var(--pass)"></i> Red = passing / good</span>
      <span class="lg"><i style="background:var(--warn)"></i> Grey = warning</span>
      <span class="lg"><i style="background:var(--fail)"></i> Silver = failed</span>
      <span class="lg"><i style="background:var(--man)"></i> Dark = manual review</span>
    </div>
  </section>
  <section class="lenses" id="lenses"></section>
  <div class="tabs" role="group" aria-label="Filter">
    <button class="tab all" aria-pressed="true" onclick="filt('all',this)">All <span class="c num">${graded + data.tally.manual}</span></button>
    <button class="tab fail" aria-pressed="false" onclick="filt('fail',this)">Failed <span class="c num">${data.tally.fail}</span></button>
    <button class="tab warn" aria-pressed="false" onclick="filt('warn',this)">Warnings <span class="c num">${data.tally.warn}</span></button>
    <button class="tab pass" aria-pressed="false" onclick="filt('pass',this)">Passed <span class="c num">${data.tally.pass}</span></button>
    <button class="tab manual" aria-pressed="false" onclick="filt('manual',this)">Manual <span class="c num">${data.tally.manual}</span></button>
  </div>
  <section class="qscore" id="qscore"></section>
  <section class="results" id="results"></section>
  ${shotHtml}
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

module.exports = { renderReport, STYLE, esc };
