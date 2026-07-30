'use strict';
// seo-split.test.js — SEO is its own tool, and Site Audit is purely technical.
//
// THE DEFECT THIS EXISTS TO PREVENT. Splitting a suite out of a scored product is a SCORE change, not a
// UI change. Two ways to get it wrong, both invisible to a screenshot:
//   1. Site Audit stops SHOWING SEO but keeps SEO's registry risk in the denominator — a nine-suite
//      score presented as a ten-suite one. ADR-0011 is exactly this class of lie.
//   2. Site Audit drops SEO's risk from the denominator only, banking its rules as resolved — which
//      would RAISE the technical score for removing work. Scope must narrow the question, never
//      restore the inflation.
// So this suite asserts the SCORE CONTRACT, not the tab bar: which suites ran, and what the coverage
// declaration says about the ones that did not.
//
// It touches no internals. It spawns the real sgen-qa-serve.js, drives /api/run and /api/seo over HTTP,
// and reads the report.json the APP wrote — because the split lives in the server's scope derivation
// and a unit test of audit.js could not see it.
const cp = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

let pass = 0, fail = 0; const failures = [];
function ok(c, n) { if (c) pass++; else { fail++; failures.push(n); console.log('  ✗ ' + n); } }
function eq(a, b, n) { const g = JSON.stringify(a), w = JSON.stringify(b); ok(g === w, n + (g === w ? '' : ` (got ${g}, want ${w})`)); }

const SERVE = path.resolve(__dirname, '..', '..', 'sgen-qa-serve.js');
const RUNS = path.resolve(__dirname, '..', '..', '..', 'sgen', 'W5-Live-Surface-Audit', 'site-qa', '_ui-runs');
const { SUITES } = require('./audit');

// The fixture carries a <script> element ON PURPOSE. The report embeds its data island as
// `<script>window.__DATA=${JSON.stringify(data)}</script>`, and JSON.stringify does not escape `<` — so
// the first literal `</script>` inside any page HTML the payload carries CLOSES THE TAG EARLY, the JS
// parser hits an unterminated string, `window.__DATA` is never assigned, and the rest of the JSON is
// rendered by the browser as page content. Measured on sgen.com 2026-07-29: the SEO report printed
// thousands of literal `\n` runs plus fragments of the site's own DOM below the footer, and the issue
// list was empty because the report client starts `var D = window.__DATA`.
//
// This fixture had NO script tag, which is exactly why the whole suite could be green while every real
// site was broken: a page with no `</script>` in it can never break the payload out.
const PAGE = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>seo split</title>'
  + '<meta name="description" content="deterministic page driving the real server for the seo split"></head>'
  + '<body><header><nav><a href="/">h</a></nav></header><h1>Split</h1><p>Body copy for the split test.</p>'
  + '<script>window.__fixture=1;</script><footer>f</footer></body></html>';

function bootServe(port) {
  const child = cp.spawn(process.execPath, [SERVE, '--port', String(port)], {
    cwd: path.dirname(SERVE), env: Object.assign({}, process.env), stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    let out = '';
    const t = setTimeout(() => reject(new Error('server did not start: ' + out.slice(0, 200))), 30000);
    const on = d => { out += d.toString(); if (/127\.0\.0\.1:\d+|listening|ready/i.test(out)) { clearTimeout(t); resolve(child); } };
    child.stdout.on('data', on); child.stderr.on('data', on);
    child.on('exit', c => { clearTimeout(t); reject(new Error('server exited (' + c + '): ' + out.slice(0, 200))); });
  });
}
function post(port, route, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request({ host: '127.0.0.1', port, path: route, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, res => {
      let d = ''; res.on('data', x => { d += x; }); res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', reject); req.setTimeout(240000, () => reject(new Error(route + ' timed out'))); req.end(body);
  });
}
// The run directory the APP wrote — located by id from the stream's own done message, never guessed.
function reportFor(id) {
  const f = path.join(RUNS, id, 'report.json');
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
}
// The HTML the app wrote. report.json can be perfect while report.html — the thing the operator
// actually reads — is unparseable, so the two are checked separately.
function reportHtmlFor(id) {
  const f = path.join(RUNS, id, 'report.html');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
}
function doneOf(ndjson) {
  for (const line of ndjson.split('\n')) {
    if (!line.trim()) continue;
    try { const m = JSON.parse(line); if (m.t === 'done') return m; } catch (_) {}
  }
  return null;
}

console.log('SEO split — Site Audit is technical, SEO is its own tool — REAL SERVER e2e — test suite\n');

(async function main() {
  let site, serve;
  try {
    site = await new Promise(r => {
      const s = http.createServer((q, res) => {
        if (q.url === '/robots.txt') { res.writeHead(404); return res.end('x'); }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(PAGE);
      }); s.listen(0, '127.0.0.1', () => r(s));
    });
    const target = 'http://127.0.0.1:' + site.address().port + '/';
    const port = 7800 + (process.pid % 90);
    serve = await bootServe(port);

    // ── 1 · SITE AUDIT — nine suites, SEO genuinely absent ────────────────────────────────────────
    const aRes = await post(port, '/api/run', { url: target, maxPages: 1, render: false });
    const aDone = doneOf(aRes.body);
    ok(aDone && aDone.ok, 'audit: /api/run completed' + (aDone && aDone.error ? ' — ' + aDone.error : ''));
    const A = aDone && aDone.ok ? reportFor(aDone.id) : null;
    ok(!!A, 'audit: the app wrote a report.json');

    if (A) {
      const keys = A.suites.map(s => s.key);
      ok(!keys.includes('seo'), 'audit: the seo suite is ABSENT from the report — not merely hidden');
      // EACH TAB OWNS WHAT ITS NAME SAYS. Copy Review belongs to Content & SEO alone. It used to run
      // here too — the SEO tool asked for it, and Site Audit got it for free because applyAdvisory()
      // with no passes runs all four — so a technical report carried a copy section and the same
      // finding surfaced in two tools. Site Audit keeps the advisory passes that ARE technical.
      ok(!keys.includes('copy'), 'audit: NO Copy Review suite — copy belongs to Content & SEO, and a tab is true to its name');
      ok(keys.includes('best-practices'), 'audit: Best Practices stays — web hygiene is technical');
      // MEASURED, not assumed: a Site Audit report still carries the weight-0 best-practices suite,
      // which applyAdvisory() appends and which is NOT part of audit.js's SUITES. Orthogonal to this
      // split, so count the scored suites only.
      const SUITE_KEYS = new Set(SUITES.map(x => x.key));
      eq(keys.filter(k => SUITE_KEYS.has(k)).length, SUITES.length - 1, 'audit: exactly nine of the ten scored suites present');
      // The score contract. SEO must leave the DENOMINATOR with the suite; if its rules stayed declared
      // as evaluated they would bank as resolved risk and removing SEO would RAISE the technical score.
      const declared = A.coverage && Array.isArray(A.coverage.evaluatedRules) ? A.coverage.evaluatedRules : null;
      ok(!!declared, 'audit: a coverage declaration is present (ADR-0011)');
      eq(A.quality && A.quality.evaluationDeclared, true, 'audit: evaluationDeclared stays TRUE — the score still states what it covers');
      if (declared) {
        const rules = require('./rules/registry');
        const all = (rules.all ? rules.all() : rules.RULES) || [];
        const seoIds = new Set(all.filter(r => r.suite === 'seo').map(r => r.id));
        const leaked = declared.filter(id => seoIds.has(id));
        eq(leaked, [], 'audit: NO seo rule is declared evaluated — its risk leaves the denominator with it, so the split cannot buy points');
      }
      ok(!(A.quality.categories || []).some(c => c.suite === 'seo' || c.key === 'seo'),
        'audit: no seo category in the quality breakdown');
      // ── REMOVING COPY REVIEW DID NOT MOVE THE TECHNICAL SCORE ───────────────────────────────────
      // The claim is that the suite was score-neutral, so dropping it costs nothing. Measured rather
      // than asserted from the weights table: put a copy suite BACK into the app's own shipped suites
      // and recompute. If Copy Review could ever have moved the number, these disagree — and a Site
      // Audit score from before this change would not be comparable to one after it.
      {
        const { compute } = require('./score');
        const declaredA = (A.coverage && A.coverage.evaluatedRules) || [];
        const asShipped = compute(A.suites, { evaluatedRules: declaredA });
        const withCopyBack = compute(A.suites.concat([{
          key: 'copy', name: 'Copy Review', advisory: true,
          checks: [{ status: 'manual', name: 'Assistant boilerplate left in visible copy', ruleId: 'COPY-001', suite: 'copy', items: [{ page: '/', section: 'content', id: 'llm-boilerplate-leak', value: 'as an AI language model' }] }],
        }]), { evaluatedRules: declaredA });
        eq(asShipped.overall, withCopyBack.overall,
          'audit: adding Copy Review back does not change the technical score — removing it was free, measured not assumed');
      }
      // The narrowing is recorded on disk, not just rendered.
      ok(A.scope && Array.isArray(A.scope.suitesNotRun) && A.scope.suitesNotRun.includes('seo'),
        'audit: report.json records seo in scope.suitesNotRun — the narrowing is auditable after the fact');
    }

    // ── 2 · SEO TOOL — the exact complement ───────────────────────────────────────────────────────
    const sRes = await post(port, '/api/seo', { url: target, maxPages: 1, render: false });
    const sDone = doneOf(sRes.body);
    ok(sDone && sDone.ok, 'seo: /api/seo completed' + (sDone && sDone.error ? ' — ' + sDone.error : ''));
    eq(sDone && sDone.mode, 'seo', 'seo: the done message carries mode:"seo" so the client can state scope instead of listing nine NOT RUN sections');
    ok(sDone && /-seo-\d+$/.test(sDone.id || ''), 'seo: the run id is marked -seo- so listRuns() can classify it from the id alone');

    const S = sDone && sDone.ok ? reportFor(sDone.id) : null;
    ok(!!S, 'seo: the app wrote a report.json');
    if (S) {
      // The SEO tool runs the seo suite plus ONE advisory pass: Copy Review (Suite 13). It is the content
      // surface an SEO report needs, and it is score-neutral by two independent mechanisms —
      // WEIGHTS.copy = 0, and every COPY-* row is status 'manual', which score.js skips in BOTH openRisk
      // and totalRisk. Proven below rather than asserted. Best Practices and FUNC-008/009 are deliberately
      // NOT here: FUNC-008/009 are SCORED rules of the functional suite, which an SEO run does not run.
      eq(S.suites.map(x => x.key), ['seo', 'copy'], 'seo: the seo suite plus the weight-0 Copy Review advisory pass — nothing else');
      eq(S.quality && S.quality.evaluationDeclared, true, 'seo: evaluationDeclared stays TRUE — an SEO score that states its coverage');
      const declared = S.coverage && Array.isArray(S.coverage.evaluatedRules) ? S.coverage.evaluatedRules : [];
      const rules = require('./rules/registry');
      const all = (rules.all ? rules.all() : rules.RULES) || [];
      const nonSeo = new Set(all.filter(r => r.suite !== 'seo').map(r => r.id));
      const copyIds = all.filter(r => r.suite === 'copy').map(r => r.id).sort();
      // Copy Review DID run, so its rules are declared — that is the declaration being honest, not a leak.
      // Anything else non-seo would be: a rule declared evaluated whose row was never emitted is the
      // ADR-0011 lie, and it is the default failure mode here — applyAdvisory pushes FUNC-008/009 into the
      // FUNCTIONAL suite, which an SEO run skips, so those rows are silently dropped while the pass still
      // reports having run.
      eq(declared.filter(id => nonSeo.has(id)).sort(), copyIds,
        'seo: the only non-seo rules declared evaluated are the COPY-* rules that actually ran — no rule is declared without a row');
      eq(declared.filter(id => /^(FUNC-008|FUNC-009|BP-)/.test(id)), [],
        'seo: content-artifacts, spelling and Best Practices are NOT declared — those passes did not run for this tool');

      // ── SCORE NEUTRALITY, MEASURED ─────────────────────────────────────────────────────────────
      // Recompute the SEO quality from the app's own suites with the copy suite REMOVED. If the advisory
      // pass could move the number, these two disagree. This is the assertion that lets the release notes
      // say a 4.11.0 score is comparable to a 4.10.0 one.
      const { compute } = require('./score');
      const withCopy = compute(S.suites, { evaluatedRules: declared });
      const withoutCopy = compute(S.suites.filter(s => s.key !== 'copy'), { evaluatedRules: declared });
      eq(withCopy.overall, withoutCopy.overall, 'seo: the Copy Review pass does not move the SEO quality score — score-neutral, measured not assumed');
      eq(S.quality.overall, withoutCopy.overall, 'seo: the score the app SHIPPED equals the score without the advisory pass');
      const copySuite = S.suites.find(s => s.key === 'copy') || { checks: [] };
      eq((copySuite.checks || []).filter(c => c.status !== 'manual').map(c => c.ruleId), [],
        'seo: every Copy Review row is status manual — an advisory flag can never read as a verdict');

      // ── A CLEAN CHECK MUST BE IDENTIFIABLE ────────────────────────────────────────────────────
      // A passing row carries ruleId null by design, so before `check` was stamped it was ANONYMOUS —
      // and the graded summary, which groups by check, printed NOT RUN for every check that passed.
      // Measured on sgen.com 2026-07-29: 8 of them (canonical, indexability, favicon, schema,
      // robots.txt, sitemap, analytics, og:image). "Clean" reading as "never looked" is this platform's
      // oldest law broken in the flattering direction, which is the harder one to notice.
      const seoRows = (S.suites.find(s => s.key === 'seo') || { checks: [] }).checks || [];
      ok(seoRows.length > 0, 'seo: the seo suite produced rows');
      eq(seoRows.filter(c => !c.check).map(c => c.status + ':' + c.name), [],
        'seo: EVERY row names the check that produced it — a passing check is identifiable, not anonymous');
      ok(seoRows.some(c => c.status === 'pass' && c.check),
        'seo: at least one PASSING row carries its check id — the case that used to render as NOT RUN');
    }

    // ── 2c · THE REPORT'S DATA ISLAND MUST SURVIVE A PAGE THAT CONTAINS A SCRIPT TAG ──────────────
    // The regression this exists to prevent, measured on sgen.com 2026-07-29 (v4.10.0): the SEO report
    // body rendered thousands of literal `\n` runs plus fragments of the audited site's own DOM, and the
    // issue list was empty. Cause: the server passed the RAW result to renderReport on the SEO path only
    // (`mode === 'seo' ? raw : applyAdvisory(raw)`), so `pages[].html` — every audited page's full source,
    // attached because the server always scans with collectPages:true — reached
    // `<script>window.__DATA=${JSON.stringify(data)}</script>`, and the first `</script>` in it closed the
    // tag. Two independent defects, so two independent assertions: the payload is ESCAPED, and the raw
    // page HTML is not in the report at all.
    if (S && sDone && sDone.ok) {
      const html = reportHtmlFor(sDone.id);
      ok(!!html, 'island: the app wrote a report.html');
      if (html) {
        eq((html.match(/<script/g) || []).length, 2, 'island: the report has exactly the 2 script tags its template emits — nothing broke out');
        const line = (html.split('\n').find(l => l.indexOf('window.__DATA=') !== -1)) || '';
        ok(line, 'island: the window.__DATA= assignment is present');
        // Exactly one `</script` on that line, and it is the template's own closing tag at the end. A
        // second one anywhere earlier IS the break-out.
        eq((line.match(/<\/script/g) || []).length, 1, 'island: one `</script` on the payload line — its own closing tag, nothing earlier');
        ok(/;<\/script>\s*$/.test(line), 'island: the payload line ends with its own closing tag');
        // The escaping must not change the VALUE — an escape that mangles the data trades one broken
        // report for another. A \\uXXXX sequence is a legal JSON string escape, so this parses exactly
        // as the browser's own JSON-literal parse does, with no un-escaping step of its own.
        const json = line.replace(/^\s*<script>window\.__DATA=/, '').replace(/;<\/script>\s*$/, '');
        let parsed = null, perr = null;
        try { parsed = JSON.parse(json); } catch (e) { perr = e.message; }
        ok(parsed && parsed.host, 'island: the payload parses and still carries the report data' + (perr ? ' — ' + perr : ''));
      }
      ok(!('pages' in S), 'island: report.json carries no `pages` key — the SEO report stops writing every audited page\'s raw HTML to disk twice');
    }

    // ── 2b · SCOPE — 'this page' vs 'whole site' ──────────────────────────────────────────────────
    // The tool used to ask HOW MANY PAGES as a raw number. It now asks for a SCOPE. These assertions
    // are about what the ENGINE ACTUALLY FETCHED, counted by the fixture server itself — a request log
    // cannot be talked round the way a returned page count can.
    {
      // A fixture with a real sitemap listing four pages, so 'whole site' has something to discover.
      const PAGES = ['/', '/a', '/b', '/c'];
      const hit = [];
      const site2 = await new Promise(r => {
        const srv = http.createServer((q, res) => {
          hit.push(q.url);
          if (q.url === '/robots.txt') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('User-agent: *\nAllow: /'); }
          if (q.url === '/sitemap.xml') {
            const origin = 'http://127.0.0.1:' + srv.address().port;
            res.writeHead(200, { 'content-type': 'application/xml' });
            return res.end('<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
              + PAGES.map(p => '<url><loc>' + origin + p + '</loc></url>').join('') + '</urlset>');
          }
          const known = PAGES.includes(q.url.split('?')[0]);
          if (!known) { res.writeHead(404); return res.end('nope'); }
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>page ' + q.url + '</title>'
            + '<meta name="description" content="a description for ' + q.url + ' long enough to be real">'
            + '<link rel="canonical" href="http://127.0.0.1:' + srv.address().port + q.url + '"></head>'
            + '<body><header><nav><a href="/a">a</a><a href="/b">b</a><a href="/c">c</a></nav></header>'
            + '<h1>Page</h1><p>Body copy for the scope test, long enough to look like content.</p><footer>f</footer></body></html>');
        }); srv.listen(0, '127.0.0.1', () => r(srv));
      });
      const t2 = 'http://127.0.0.1:' + site2.address().port + '/';

      // THIS PAGE — no crawl beyond the given URL.
      hit.length = 0;
      const pRes = doneOf((await post(port, '/api/seo', { url: t2, scope: 'page', render: false })).body);
      ok(pRes && pRes.ok, 'scope/page: run completed' + (pRes && pRes.error ? ' — ' + pRes.error : ''));
      eq(pRes && pRes.scope, 'page', 'scope/page: the result states the scope it used');
      eq(pRes && pRes.pagesAudited, 1, 'scope/page: exactly one page audited');
      // robots.txt and the sitemap LOCATIONS are not crawled pages — they are the resources the
      // robots-txt and sitemap CHECKS exist to inspect, and an SEO audit of one page still asks whether
      // they exist. What must not happen is another PAGE being fetched. Attribution was MEASURED, not
      // assumed: before the singlePage bypass this list read
      // [/sitemap_index.xml, /sitemap-index.xml, /wp-sitemap.xml, /a, /b, /c]; after it only the
      // sitemap/robots resources remain and /a /b /c are never touched.
      const SITE_RESOURCES = /^\/(robots\.txt|sitemap[._-]?index\.xml|sitemap\.xml|wp-sitemap\.xml)$/;
      const otherPages = [...new Set(hit)].map(u => u.split('?')[0])
        .filter(u => u !== '/' && !SITE_RESOURCES.test(u));
      eq(otherPages, [], 'scope/page: NO page other than the given URL was ever fetched — the fixture logged every request');

      // duplicate-* cannot mean anything on one page and must not be reported as passing.
      eq(pRes && pRes.notApplicable, ['duplicate-title', 'duplicate-description'],
        'scope/page: duplicate-title and duplicate-description are declared NOT APPLICABLE');
      const Pr = pRes && pRes.ok ? reportFor(pRes.id) : null;
      if (Pr) {
        const seoSuite = (Pr.suites || []).find(x => x.key === 'seo') || { checks: [] };
        const dup = (seoSuite.checks || []).filter(c => /^duplicate-/.test(c.check));
        const passing = dup.filter(c => c.status === 'pass').map(c => c.check);
        const declared = (Pr.coverage && Pr.coverage.evaluatedRules) || [];
        const dupRules = ['SEO-009', 'SEO-010'];
        // The load-bearing one: whatever the row says, those rules must NOT be banked as evaluated-clean
        // in the score. A pass nobody could have earned is the thing being prevented.
        eq(dupRules.filter(r => declared.includes(r)), [],
          'scope/page: duplicate-* rules are NOT declared evaluated — a meaningless pass cannot reach the score'
          + (passing.length ? ' (rows still present: ' + passing.join(', ') + ', declared not-applicable in the result)' : ''));
      }

      // WHOLE SITE — discovers more than one page via the sitemap.
      hit.length = 0;
      const sRes2 = doneOf((await post(port, '/api/seo', { url: t2, scope: 'site', maxPages: 50, render: false })).body);
      ok(sRes2 && sRes2.ok, 'scope/site: run completed' + (sRes2 && sRes2.error ? ' — ' + sRes2.error : ''));
      eq(sRes2 && sRes2.scope, 'site', 'scope/site: the result states the scope it used');
      ok(sRes2 && sRes2.pagesAudited > 1, `scope/site: more than one page audited (got ${sRes2 && sRes2.pagesAudited})`);
      ok(hit.includes('/sitemap.xml'), 'scope/site: the sitemap was actually fetched — discovery is sitemap-first');
      eq(sRes2 && sRes2.capped, false, 'scope/site: a ceiling of 50 over 4 pages does not report as capped');

      // THE CEILING — when it bites, it is REPORTED, not swallowed.
      const cRes = doneOf((await post(port, '/api/seo', { url: t2, scope: 'site', maxPages: 2, render: false })).body);
      ok(cRes && cRes.ok, 'ceiling: run completed' + (cRes && cRes.error ? ' — ' + cRes.error : ''));
      eq(cRes && cRes.ceiling, 2, 'ceiling: the result states the ceiling it was given');
      ok(cRes && cRes.pagesAudited <= 2, `ceiling: no more than the ceiling was audited (got ${cRes && cRes.pagesAudited})`);
      eq(cRes && cRes.capped, true, 'ceiling: the run REPORTS that it stopped at the ceiling — a silent cap makes a partial audit look complete');
      ok(cRes && cRes.notReached > 0, `ceiling: the pages it never reached are counted (got ${cRes && cRes.notReached})`);

      try { site2.close(); } catch (_) {}
    }

    // ── 3 · THE TWO TOOLS ARE COMPLEMENTARY, NOT OVERLAPPING ──────────────────────────────────────
    if (A && S) {
      const aKeys = new Set(A.suites.map(s => s.key));
      const sKeys = new Set(S.suites.map(s => s.key));
      const KEYS = new Set(SUITES.map(x => x.key));
      const aScored = [...aKeys].filter(k => KEYS.has(k)), sScored = [...sKeys].filter(k => KEYS.has(k));
      eq(aScored.filter(k => sScored.includes(k)), [], 'split: the two tools share NO scored suite — no check is scored twice across the product');
      eq(aScored.concat(sScored).sort(), SUITES.map(x => x.key).sort(),
        'split: together they cover every suite audit.js declares — the split loses nothing');
    }
  } catch (e) {
    ok(false, 'harness: ' + String(e && e.message || e));
  } finally {
    try { serve && serve.kill(); } catch (_) {}
    try { site && site.close(); } catch (_) {}
  }

  console.log('\n' + (fail === 0 ? '✅ PASS' : '❌ FAIL') + ` — ${pass}/${pass + fail} assertions`);
  if (fail) { console.log('Failures:\n' + failures.map(f => '  - ' + f).join('\n')); process.exit(1); }
})();
