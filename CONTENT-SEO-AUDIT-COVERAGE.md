# Content & SEO audit — what the tool actually checks today

Read off `engine/lib/site-qa/rules/registry.js` (v1.13.0, 142 rules) and the detector sources, on
2026-07-30. Weights are the SGEN Quality Score contribution; **weight 0 + severity `manual` = advisory,
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

## 2. SEO — 36 rules

**Metadata** — SEO-001 title missing (10) · 002 title length (2) · 003 description missing (6) ·
004 description length (2) · 014 favicon missing (1) · 015 favicon does not load (1)

**Indexability** — SEO-007 **live page NOINDEX (critical, 22)** · 008 staging indexable (5) ·
030 **staging host referenced on live (critical, 20)** · 035 noindex + cross-URL canonical conflict (5) ·
036 meta robots vs X-Robots-Tag disagree (5)

**Canonical** — SEO-005 missing (8) · 006 **points off the production domain (critical, 18)**

**Crawlability** — SEO-020 **robots.txt blocks the whole site on live (critical, 20)** · 029 no robots.txt (4) ·
021 no `Sitemap:` line (2) · 022 no XML sitemap (6) · 023 dead URL in sitemap (4) · 024 orphan page (4)

**Duplication** — SEO-009 duplicate title across pages (5) · SEO-010 duplicate description (4)
→ *this is the only duplicate detection that exists today. See §4.*

**Structured data** — SEO-016 no JSON-LD (3) · 017 invalid (3) · 018 item missing `@type` (3) ·
019 `@context` not schema.org (3)

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

## 4. Gaps worth your decision

1. **Duplicate content — only titles and descriptions.** SEO-009/010 compare `<title>` and
   `<meta description>` across pages in the same crawl. There is **no body-copy duplicate detection**,
   internal or external. Near-duplicate content is on the deferred list.
2. **No off-site / reverse search.** Nothing checks whether the copy exists elsewhere on the web.
   Separate proposal — needs an external search API, which is the first runtime network dependency on a
   third party this engine would take. Scored 72/100 on the tribunal rubric; the recommendation was to
   split it — internal near-duplicate detection needs no external anything.
3. **Content & SEO runs skip FUNC-004.** The tool runs with `passes: ['copyReview']` only, so it gets
   the COPY flags but **not** the scored lorem/placeholder check. Site Audit gets it. Now sharper than
   when this was first written: with Copy Review moved out of Site Audit, the tab named for content is
   the one that cannot flag lorem ipsum. One-line fix if unintended — **still awaiting your call.**
4. **COPY-002 `\bTK\b`** will fire on legitimate uses (ticker symbols, initials). Advisory only, so the
   blast radius is a flag a human reads.

---

## 5. How to read a score

- **Advisory suites (Best Practices, Visual, Copy Review) are weight 0** and every row is `manual` —
  score-neutral by two independent mechanisms.
- A rule that **did not run** is not a pass. It is subtracted from the denominator and declared in the
  coverage ledger (ADR-0011).
- As of **v5.0.0**, a run that never read a page publishes **no score at all** — `score: null`,
  `quality.overall: null`, verdict `COULD NOT AUDIT`, with the cause named (blocked / DNS / route /
  refused / TLS / 404 entry / redirect dead-end / non-HTML).
