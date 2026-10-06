# Content & SEO audit — what the tool actually checks today

Read off `engine/lib/site-qa/rules/registry.js` (v1.15.0, 161 rules) and the detector sources, on
2026-07-31. Weights are the SGEN Quality Score contribution; **weight 0 + severity `manual` = advisory,
cannot move the score by any path.**

---

## 1. Content quality

### Scored (these are defects)

| Rule | What it catches | Sev | Weight |
|---|---|---|---|
| FUNC-004 `placeholder-content` | **lorem ipsum / lipsum**, "your text here", "sample/dummy/placeholder text", TODO / FIXME / TBD / "insert … here" | high | 6 |
| FUNC-008 `content-artifacts` | Loose symbols, unresolved template tokens, mojibake in visible copy | high | 6 |
| FUNC-009 `misspelling-common` | Common misspellings, doubled words | medium | 3 |
| FUNC-006 `empty-code-block` | Empty `<pre>`/`<code>` | low | 2 |
| FUNC-007 `empty-table` | Empty / structureless table | low | 2 |
| SEO-037 `thin-content` | Very low word count | low | 3 |
| SEO-038 `readability-hard` | Low Flesch reading ease | low | 2 |

Lorem detection is literally:

```js
/lorem ipsum|lipsum/i
/\byour (?:text|content|headline|title|image|logo) here\b/i
/\b(?:sample|dummy|placeholder) (?:text|content|copy)\b/i
/\b(?:TODO|FIXME|TBD|coming soon\.\.\.|insert .* here)\b/i
```

### Advisory — Copy Review (Suite 13, weight 0, every row `manual`)

> **Runs in Content & SEO only** (since 5.2.0). It used to run in Site Audit too — by default, not by
> intent — so the same finding surfaced in two tools. Removing it did not move the Site Audit score;
> that is measured, not assumed (`seo-split.test.js` adds the suite back to a shipped result and
> recomputes to the same number).

| Rule | What it flags | Confidence |
|---|---|---|
| COPY-001 `llm-boilerplate-leak` | `as an AI language model`, `as of my last training`, `I cannot browse the internet`, `Certainly! Here's…`, `here's a rewritten version` | High — near-zero FP |
| COPY-002 `unresolved-authoring-placeholder` | `[INSERT…]`, `[YOUR …]`, `[COMPANY…]`, `[TODO…]`, `TK`, `TODO:`, `FIXME`, `XXXX+` | High |
| COPY-003 `ai-tell-phrasing` | `delve into`, `in today's fast-paced world`, `unlock the potential`, `elevate your`, `a testament to`, `in the realm of`, `seamlessly integrat`, `robust solution`… | **Signal only** |
| COPY-004 `uniform-paragraph-rhythm` | Coefficient of variation of paragraph word-counts < 0.18, over ≥8 paragraphs / ≥300 words | **Signal only** |

The registry is explicit that this **never asserts a page is AI-written** — not deterministically
knowable, and the most damaging false positive the tool could ship.

---

## 2. SEO — 46 rules

**Metadata** — SEO-001 title missing (10) · 002 title length (2) · 003 description missing (6) ·
004 description length (2) · 014 favicon missing (1) · 015 favicon does not load (1)

**Indexability** — SEO-007 **live page NOINDEX (critical, 22)** · 008 staging indexable (5) ·
030 **staging host referenced on live (critical, 20)** · 035 noindex + cross-URL canonical conflict (5) ·
036 meta robots vs X-Robots-Tag disagree (5) · **047 noindex on a URL robots.txt blocks (8)**

> SEO-047 is the row none of the others could produce. robots.txt forbids the fetch, so the crawler
> **never reads the noindex** — the URL can sit in the index as a bare link indefinitely. Both
> directives are individually correct; together they do the opposite of what either intends. It is
> only visible when the signals are joined, which is what §3c exists to do.

**Canonical** — SEO-005 missing (8) · 006 **points to a staging/preview host (critical, 18)** · 050 relative canonical, Google recommends absolute (2, warn) · 051 points to another site, correct only for syndication (2, warn)

**Crawlability** — SEO-020 **robots.txt blocks the whole site on live (critical, 20)** · 029 no robots.txt (4) ·
021 no `Sitemap:` line (2) · 022 no XML sitemap (6) · 023 dead URL in sitemap (4) · 024 crawled page missing from the sitemap (4) ·
**048 robots.txt blocks a NAMED search engine (critical, 18)** · 039 sitemap lists a robots-blocked URL (8) ·
040 sitemap lists a noindex URL (6) · 041 sitemap URL canonicals elsewhere (4) · 042 sitemap URL redirects (3) ·
043 sitemap declared but unreadable (6) · 044 sitemap over the 50,000-URL / 50 MB limit (6) ·
045 `<lastmod>` not a valid W3C datetime (2) · 046 sitemap lists a foreign host (3)

**Duplication** — SEO-009 duplicate title across pages (5) · SEO-010 duplicate description (4)
→ *this is the only duplicate detection that exists today. See §4.*

**Structured data** — SEO-016 no JSON-LD (3) · 017 invalid (3) · 018 item missing `@type` (3) ·
019 `@context` not schema.org (3) · **049 required property missing for the declared `@type` (4)**

> SEO-016..019 stop at "is there JSON-LD and does it parse". A `Product` with no `name` or an `Article`
> with no `headline` passes all four and is still ineligible for every rich result. SEO-049 validates
> only **documented-as-required** properties; the recommended tier is advisory (DISC-005), because a
> padded "required" list fails correct markup and a structured-data checker that cries wolf gets
> switched off. `@graph` + `@id` cross-references are resolved before anything is called missing —
> that is how Yoast/RankMath markup is written, and not handling it is the classic false positive.

**Social** — SEO-011 incomplete Open Graph (4) · 012 missing `twitter:card` (2) · 013 og:image does not load (4)

**Other** — SEO-025 no analytics on live (3) · 026 tracking on staging (2) · 027 mobile web-app metadata (2) ·
028 privacy/cookie signals (2) · 031 hreflang invalid / no x-default (4) · 037 thin content (3) ·
038 readability (2)

**Deferred, not implemented:** SEO-032/033/034 image/video/news sitemaps, HTML-001 broken markup,
STB-004 broken fonts, near-duplicate content.

---

## 3. Links & page status — current state

**Links (suite `links`, 11 rules).** LINK-001 broken internal (high, 12) · 002 broken external (medium, 4) ·
003 redirect chain/loop (high, 6) · 004 soft 404 (5) · 005 anchor to missing ID (2) · 006 empty href (8) ·
007 `href="#"` (4) · 008 `javascript:` no-op (4) · 009 no href (4) · 010 malformed mailto:/tel: (2).

Counts already recorded per run:
`links: { checked, broken, brokenInternal, brokenExternal, chains }` plus `totalInternal` / `totalExternal`.
Internal link checking is **capped at 300 URLs**.

**Page status.** `pageCoverage` records `audited` / `errored` / `notReached` with counts, but `errored`
carries `{ url, status }` — **a bare number**. 403 and 404 mean completely different things to whoever has
to fix them, and the report currently makes the reader know that themselves.

→ *Being fixed in this pass: plain-English meaning per status, and the internal/external/broken counts
surfaced as counts rather than only as pass/fail rows.*

---

## 3b. Tech stack — what the site is built on (new in 5.4.0)

Detected offline from responses the crawl already made — no extra requests, no third-party service.
Surfaced as a **"Built on"** panel and as `result.techStack`, each signature with a page count.

| Layer | Read from | Detects |
|---|---|---|
| CMS | HTML | WordPress, Shopify, Wix, Squarespace, Webflow, Drupal, Joomla, Ghost, HubSpot |
| Framework | HTML | Next.js, Nuxt, SvelteKit, Gatsby, Angular, Vue, React |
| E-commerce | HTML | WooCommerce, Shopify, Magento, BigCommerce |
| Server | `Server` header | nginx, Apache, LiteSpeed, IIS, Caddy, Google Frontend |
| CDN | Response headers | Cloudflare, Vercel, Netlify, CloudFront, Fastly, Akamai |
| Analytics | HTML | GA4, GTM, Meta Pixel, LinkedIn — **now named on the row** (5.3.0) |

**Signatures, never certainty.** A generator tag can be removed and a header spoofed or stripped by a
proxy, so an empty list means *no signature seen*, not that the technology is absent. The caveat ships
as `techStack.note`, on the data rather than in the renderer.

Page counts matter: WordPress on 1 of 40 pages is a part-migrated site, not "WordPress".

**Post-Deployment Check gets all of this free** — it already runs a full audit of the target as
production validation (`c-prod`, on by default), which is also where PERF-001 (LCP), PERF-002 (CLS),
PERF-006 (page weight) and PERF-007 (compression) fire. So "is the deployed site production-ready, not
just a faithful copy" is now largely answered.

---

## 3c. Indexability — can Google and Bing actually index this? (new in 6.1.0)

Lives in `engine/lib/site-qa/indexability/`. Runs inside `audit.js` (**not** the advisory pipeline —
that seam hands passes `{url, html}` and this needs response **headers**, status codes and redirect
locations). Deterministic, offline apart from the target site itself, no third-party service, no key.

**Per URL, per engine.** Google and Bing get **separate** verdicts, because a group naming `googlebot`
and a `*` group are different rule sets — a site can be fully indexable in Bing and invisible in Google.
Averaging them produces a number true of neither.

| Verdict | Means |
|---|---|
| `indexable` | crawlable, no noindex, self-canonical |
| `blocked-robots` | robots.txt disallows the path **for that agent** |
| `noindex` | meta robots or `X-Robots-Tag` (agent-specific tags override the generic one) |
| `canonicalized-away` | the canonical names a different URL as the one to index |
| `redirect` / `error` / `non-html` | 3xx · 4xx/5xx/no response · not an HTML document |
| `not-checked` | never fetched in this run — **never** assumed clean |

**robots.txt is parsed properly** (RFC 9309): longest-match group selection, `*` only as fallback, `*`
and `$` in paths, longest-matching rule wins with Allow breaking ties, empty `Disallow:` matches
nothing. A 404 robots.txt means *everything allowed*; a **5xx means disallow** (Google's documented
behaviour) — collapsing those two would report a site as fully crawlable during an outage.

**The URL universe** = everything crawled ∪ every on-host URL any sitemap lists. Sitemap URLs the crawl
did not reach are HEAD-probed (status + content-type + `X-Robots-Tag`), capped at 500 and **declared** —
`summary.capped` / `summary.notProbed`, so a partial sweep can never read as a complete one. Those rows
carry `headOnly`, and are excluded from the canonical check rather than assumed self-canonical.

**Sitemap files are validated for real**, not just expanded for discovery: XML parses, urlset vs index,
50,000-URL and 50 MB protocol limits, `<lastmod>` as W3C datetime, foreign-host entries, one level of
index nesting, `&amp;` decoded in `<loc>`. A `.gz` sitemap is recorded **present and unread**, never
"malformed". A *guessed* conventional path that 404s or redirects raises **nothing** — only a sitemap
the site itself pointed at (robots.txt, or a child of a real index) is held to the standard.

### The boundary — INDEXABLE ships, INDEXED does not

`result.indexability.indexStatus.measured` is **`false`**, with the reason on the data so no surface can
render the table as "indexed in Google". Live index membership is not derivable from a site. It needs a
credentialed, ownership-verified API per engine (Search Console URL Inspection; Bing Webmaster URL
Info). The other route — scraping `site:` queries — is non-deterministic, captchas within a few dozen
URLs, and is against both engines' terms; a check whose answer depends on whether a captcha fired
cannot ship in a deterministic engine. **Not measured, stated as such, never estimated.**

## 3d. Suite 14 · Discovery & AI — advisory, weight 0 (new in 6.1.0)

The machine-readable surface a site publishes about itself. **Every row is `manual` and
`WEIGHTS.discovery = 0`** — score-neutral by the same two independent mechanisms as Best Practices,
Visual and Copy Review.

| Rule | Reports |
|---|---|
| DISC-001 `llms-txt` | `/llms.txt` presence + llmstxt.org shape (H1, sections, link count) |
| DISC-002 `ai-crawler-policy` | which of 13 AI agents robots.txt **names**, and allow/block for each |
| DISC-003 `machine-readable-files` | security.txt · ai.txt · humans.txt · **openapi.yaml / .json** · ai-plugin.json · assetlinks.json · apple-app-site-association |
| DISC-004 `content-feeds` | RSS / Atom / JSON feed `<link rel="alternate">` |
| DISC-005 `schema-coverage` | every `@type` seen with counts, types this engine has **no rules for** (declared unvalidated, never silently passed), and recommended-property gaps |
| DISC-006 `index-status-not-measured` | the honest row — see the boundary above |

**Why none of it is scored.** `llms.txt` is a 2024 convention with no registrar. `ai.txt` is one
vendor's proposal. Publishing an OpenAPI document is a product decision. Blocking GPTBot is a *policy
choice* — `checks-static.js` already shipped that mistake once, calling sgen.com CRITICAL for a
deliberate AI-training opt-out. Deducting points here would be the tool inventing a standard and then
failing sites against it. **AI-training agents are not search agents** and never affect a search verdict.

**Absent arrives in more shapes than 404.** Measured on sgen.com, where every unknown path answers
`301 → /404?from=…` with an empty body: a redirect, an empty body, or an HTML shell on a JSON path all
mean *no file here*. Before that gate the report claimed four well-known files were present **and
invalid** — four files the site does not have, each with a defect it does not have.

**YAML is a shape check, and the row says so.** No YAML parser is taken as a runtime dependency for an
advisory row, so it asserts "reads as a mapping document" and never "the YAML is valid".

## 4. Gaps worth your decision

1. **Duplicate content — only titles and descriptions.** SEO-009/010 compare `<title>` and
   `<meta description>` across pages in the same crawl. There is **no body-copy duplicate detection**,
   internal or external. Near-duplicate content is on the deferred list.
2. **No off-site / reverse search.** Nothing checks whether the copy exists elsewhere on the web.
   Separate proposal — needs an external search API, which is the first runtime network dependency on a
   third party this engine would take. Scored 72/100 on the tribunal rubric; the recommendation was to
   split it — internal near-duplicate detection needs no external anything.
3. ~~**Content & SEO runs skip FUNC-004.**~~ **Closed in 6.0.0.** The tab now runs
   `['copyReview', 'contentArtifacts', 'spelling']`, and COPY-005 shares `detectPlaceholders()` with
   FUNC-004 so the patterns cannot drift. The content tab flags lorem ipsum. Stated cost: advisory
   there, so those rows are flagged and no longer scored anywhere.
4. **COPY-002 TK** will fire on legitimate uses (ticker symbols, initials). Advisory only, so the
   blast radius is a flag a human reads.
5. **Live index status is not measured, and cannot be at zero architectural cost.** §3c ships
   INDEXABLE. To answer *"is this URL in Google's index right now"* the engine needs a credentialed,
   ownership-verified API per property — Search Console URL Inspection (free, OAuth + verified
   property, ~2,000 URLs/day) and Bing Webmaster URL Info (free, API key + verified site). Both are
   free in money and neither is free in architecture: they would be the first runtime third-party
   network dependencies this engine takes, they are per-site credentialed so they cannot ship
   configured, and a run that reaches them is no longer reproducible offline. That is a
   tribunal-scored decision, not a code change — **your call, nothing built.** The scraping route is
   not on the table: non-deterministic, captchas within a few dozen URLs, against both engines' terms.
6. ~~**`.gz` sitemaps are recorded, not parsed.**~~ **Closed in 6.2.1.** Gzipped sitemaps are now
   decompressed with the `zlib` builtin (no new dependency) and parsed like any other. Gzip is
   detected by MAGIC BYTES rather than the URL suffix, so both legal shapes work — a raw `.gz`
   file and a `Content-Encoding: gzip` response — as does a `.gz` extension on an uncompressed
   file. Decompression is capped at 64 MB: a few hundred bytes of gzip can encode gigabytes, and
   an unbounded gunzip in a tool that fetches attacker-controlled URLs is a denial-of-service the
   audited site can aim at the operator. A stream that is corrupt and one that is merely too big
   are reported separately, because they need different fixes.
7. **Sitemap URL probing is capped at 500** beyond what the crawl already fetched, and those probes
   are HEAD-only (no body, so meta robots and canonical are unknown for them). Both limits are
   declared on the result — a partial sweep never reads as a complete one.

---

## 5. How to read a score

- **Advisory suites (Best Practices, Visual, Copy Review, Discovery & AI) are weight 0** and every row is `manual` —
  score-neutral by two independent mechanisms.
- A rule that **did not run** is not a pass. It is subtracted from the denominator and declared in the
  coverage ledger (ADR-0011).
- As of **v5.0.0**, a run that never read a page publishes **no score at all** — `score: null`,
  `quality.overall: null`, verdict `COULD NOT AUDIT`, with the cause named (blocked / DNS / route /
  refused / TLS / 404 entry / redirect dead-end / non-HTML).
