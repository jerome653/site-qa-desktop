'use strict';
// site-qa/deadline.js — one shared deadline for browser work that Playwright does not time out itself.
//
// WHY THIS EXISTS. Playwright bounds navigation and screenshots, and bounds NOTHING ELSE: `page.evaluate`
// has no timeout at all, and `context.close()` / `browser.close()` wait forever for a browser that has
// stopped answering. Both were measured wedging real runs on 2026-07-21, same staging site, same app
// session:
//
//   run 1784603443181 — last write `home--cross-browser--full--webkit.png` 11:15:02, then nothing.
//                       A healthy run writes report.html ~1s after that shot. Sat 4h.
//   run 1784618398466 — last write `home--cross-browser--full--firefox.png` 15:26:27, WebKit launched
//                       the same second and never came back. Sat 28min before it was killed.
//
// In both, `/api/status` stayed `{"busy":true,"active":1}` forever, no report was ever written, and the
// UI span with no error — a hang is the one failure mode this engine cannot report on, because the code
// that would report it never resumes. The tell was two DEFUNCT `WebKitNetworkProcess` entries (11:14:55
// and 15:26:27): the browser had already exited, and the awaits in our code still never settled.
//
// So the budget has to live on our side of the call. A blown deadline is always reported as a failure
// with the elapsed time attached — never swallowed into something that reads like a pass.
//
// The loser of the race is deliberately not awaited again: its rejection is absorbed here so a late
// failure cannot surface as an unhandled rejection long after the caller moved on.
function withDeadline(promise, ms, fallback) {
  let timer;
  const settled = Promise.resolve(promise).then((v) => v, () => fallback);
  return Promise.race([
    settled.then((v) => { clearTimeout(timer); return v; }),
    new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms); }),
  ]);
}

module.exports = { withDeadline };
