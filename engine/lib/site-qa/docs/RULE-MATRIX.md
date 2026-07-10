# SGEN Site QA — Rule Matrix

> Definitive reference. Generated from rules/registry.js (v1.9.0). Do not edit by hand.
> 128 rules · contract v1.0 · engine 2.3.0.

| Rule | Title | Suite | Inspector | Severity | Tier | Quality | Cost | Interaction | Fixability | −pts |
|---|---|---|---|---|---|---|---|---|---|---|
| FUNC-001 | Page returns server error | functional | — | critical | 1 | — | — |  | — | 25 |
| FUNC-002 | Page returns client error | functional | — | critical | 1 | — | — |  | — | 18 |
| FUNC-003 | Page in sitemap/nav redirects | functional | — | medium | 2 | — | — |  | — | 4 |
| FUNC-004 | Placeholder / lorem text in visible copy | functional | — | high | 2 | — | — |  | — | 6 |
| FUNC-005 | Global landmark(s) not detected | functional | — | low | 3 | — | — |  | — | 2 |
| FUNC-006 | Empty code block | functional | — | low | 3 | — | — |  | — | 2 |
| FUNC-007 | Empty/structureless table | functional | — | low | 3 | — | — |  | — | 2 |
| FUNC-008 | Loose symbols / unresolved tokens / mojibake in visible copy | functional | — | high | 2 | — | — |  | — | 6 |
| FUNC-009 | Common misspelling / typo in visible copy | functional | — | medium | 2 | — | — |  | — | 4 |
| FUNC-900 | Visual design matches the intended design | functional | — | manual | — | — | — |  | — | 0 |
| LINK-001 | Broken internal link(s) | links | — | high | 1 | — | — |  | — | 12 |
| LINK-002 | Broken external link(s) | links | — | medium | 2 | — | — |  | — | 4 |
| LINK-003 | Redirect chain(s) / loop(s) | links | — | high | 2 | — | — |  | — | 6 |
| LINK-004 | Soft 404 (unknown URL returns 200) | links | — | medium | 2 | — | — |  | — | 5 |
| LINK-005 | In-page anchor links point to missing IDs | links | — | low | 3 | — | — |  | — | 2 |
| LINK-006 | Dead link (empty href) | links | seo | high | 2 | verified | cheap | ✓ | guided | 8 |
| LINK-010 | Malformed mailto: / tel: link | links | seo | low | 3 | verified | cheap | ✓ | guided | 2 |
| LINK-007 | Link goes nowhere (href="#") | links | seo | medium | 2 | verified | cheap | ✓ | guided | 4 |
| LINK-008 | Dead link (javascript: no-op) | links | seo | medium | 2 | verified | cheap | ✓ | guided | 4 |
| LINK-009 | Link has no href | links | seo | medium | 2 | verified | cheap | ✓ | guided | 4 |
| DOM-003 | Duplicate id attribute(s) | a11y | stability | medium | 2 | verified | cheap |  | guided | 4 |
| DOM-004 | Excessive DOM size | performance | stability | low | 3 | derived | moderate |  | manual | 3 |
| DOM-010 | Button submits nothing (type=submit outside form) | functional | stability | medium | 2 | verified | cheap | ✓ | manual | 4 |
| DOM-011 | Empty onclick handler | functional | stability | low | 3 | verified | cheap | ✓ | manual | 2 |
| DOM-012 | Nested interactive controls | a11y | stability | medium | 2 | verified | cheap | ✓ | manual | 4 |
| DOM-013 | Disabled control presented as active | a11y | stability | low | 3 | verified | cheap | ✓ | manual | 2 |
| FORM-001 | Form structure issue | forms | — | medium | 2 | — | — |  | — | 5 |
| FORM-002 | Form field missing correct type / autocomplete | forms | stability | low | 3 | verified | cheap |  | guided | 2 |
| FORM-900 | Form submission → email / CRM delivery | forms | — | manual | — | — | — |  | — | 0 |
| RESP-001 | No <meta name="viewport"> | responsive | — | critical | 1 | — | — |  | — | 20 |
| RESP-002 | Page scrolls horizontally | responsive | — | high | 2 | — | — |  | — | 10 |
| RESP-003 | Element bleeds past right edge | responsive | — | high | 2 | — | — |  | — | 10 |
| RESP-004 | Element wider than viewport | responsive | — | high | 2 | — | — |  | — | 10 |
| RESP-005 | Tap target < 44px | responsive | — | medium | 2 | — | — |  | — | 4 |
| RESP-006 | Input font < 16px | responsive | — | low | 3 | — | — |  | — | 2 |
| RESP-900 | Multi-device eyeball pass (Responsive Viewer) | responsive | — | manual | — | — | — |  | — | 0 |
| A11Y-001 | axe-core WCAG 2.1 A/AA violation | a11y | — | high | 2 | — | — |  | — | 12 |
| A11Y-002 | Text below AA contrast | a11y | — | medium | 2 | — | — |  | — | 6 |
| A11Y-003 | No <h1> on page | a11y | — | high | 2 | — | — |  | — | 6 |
| A11Y-004 | Multiple <h1> on page | a11y | — | low | 3 | — | — |  | — | 2 |
| A11Y-005 | Heading level skipped | a11y | — | low | 3 | — | — |  | — | 2 |
| A11Y-006 | Images missing alt text | a11y | — | medium | 2 | — | — |  | — | 6 |
| A11Y-007 | <img> without a src | a11y | — | medium | 2 | — | — |  | — | 6 |
| A11Y-008 | Images without width/height | a11y | — | low | 3 | — | — |  | — | 2 |
| A11Y-009 | <html> missing lang attribute | a11y | — | low | 3 | — | — |  | — | 2 |
| SEO-001 | Missing <title> | seo | — | high | 2 | — | — |  | — | 10 |
| SEO-002 | Title length outside 10–70 chars | seo | — | low | 3 | — | — |  | — | 2 |
| SEO-003 | Missing meta description | seo | — | medium | 2 | — | — |  | — | 6 |
| SEO-004 | Meta description length outside 50–170 | seo | — | low | 3 | — | — |  | — | 2 |
| SEO-005 | Missing canonical URL | seo | — | medium | 2 | — | — |  | — | 8 |
| SEO-006 | Canonical points off the production domain | seo | — | critical | 1 | — | — |  | — | 18 |
| SEO-007 | Live page is set to NOINDEX | seo | — | critical | 1 | — | — |  | — | 22 |
| SEO-008 | Staging page is indexable | seo | — | medium | 2 | — | — |  | — | 5 |
| SEO-009 | Duplicate title across pages | seo | — | medium | 2 | — | — |  | — | 5 |
| SEO-010 | Duplicate description across pages | seo | — | medium | 2 | — | — |  | — | 4 |
| SEO-011 | Incomplete Open Graph tags | seo | — | medium | 2 | — | — |  | — | 4 |
| SEO-012 | Missing twitter:card | seo | — | low | 3 | — | — |  | — | 2 |
| SEO-013 | og:image does not load | seo | — | medium | 2 | — | — |  | — | 4 |
| SEO-014 | No favicon declared | seo | — | low | 3 | — | — |  | — | 1 |
| SEO-015 | Favicon does not load | seo | — | low | 3 | — | — |  | — | 1 |
| SEO-016 | No JSON-LD structured data | seo | — | low | 3 | — | — |  | — | 3 |
| SEO-017 | Invalid JSON-LD | seo | — | medium | 2 | — | — |  | — | 3 |
| SEO-018 | JSON-LD item missing @type | seo | — | low | 3 | — | — |  | — | 3 |
| SEO-019 | JSON-LD @context is not schema.org | seo | — | low | 3 | — | — |  | — | 3 |
| SEO-020 | robots.txt blocks the whole site on live | seo | — | critical | 1 | — | — |  | — | 20 |
| SEO-021 | robots.txt has no Sitemap: line | seo | — | low | 3 | — | — |  | — | 2 |
| SEO-022 | No XML sitemap found | seo | — | medium | 2 | — | — |  | — | 6 |
| SEO-023 | Dead URL(s) in sitemap | seo | — | medium | 2 | — | — |  | — | 4 |
| SEO-024 | Orphan page(s) (not in sitemap) | seo | — | medium | 2 | — | — |  | — | 4 |
| SEO-025 | No analytics/tracking detected on live page | seo | — | medium | 2 | — | — |  | — | 5 |
| SEO-026 | Tracking present on staging — verify target | seo | — | low | 3 | — | — |  | — | 2 |
| SEO-027 | Mobile web-app metadata missing | seo | — | low | 3 | — | — |  | — | 2 |
| SEO-028 | Privacy / cookie signals incomplete | seo | — | low | 3 | — | — |  | — | 2 |
| SEO-029 | No robots.txt | seo | — | medium | 2 | — | — |  | — | 4 |
| SEO-030 | Staging/preview host referenced on live page | seo | — | critical | 1 | — | — |  | — | 20 |
| SEO-031 | hreflang is invalid or missing x-default | seo | seo | medium | 2 | verified | cheap |  | guided | 4 |
| SEO-035 | noindex combined with a cross-URL canonical (conflicting signals) | seo | seo | medium | 2 | verified | cheap |  | guided | 5 |
| SEO-036 | meta robots and X-Robots-Tag disagree | seo | seo | medium | 2 | verified | cheap |  | guided | 5 |
| SEO-037 | Thin content (very low word count) | seo | seo | low | 3 | derived | moderate |  | manual | 3 |
| SEO-038 | Very hard to read (low Flesch reading ease) | seo | seo | low | 3 | derived | moderate |  | manual | 2 |
| PERF-001 | Largest Contentful Paint | performance | — | medium | 2 | — | — |  | — | 6 |
| PERF-002 | Cumulative Layout Shift | performance | — | medium | 2 | — | — |  | — | 6 |
| PERF-003 | Little/no image lazy-loading | performance | — | low | 3 | — | — |  | — | 2 |
| PERF-004 | No WebP/AVIF images detected | performance | — | low | 3 | — | — |  | — | 2 |
| PERF-005 | Render-blocking resources in <head> | performance | — | low | 3 | — | — |  | — | 2 |
| PERF-006 | Heavy page (many requests / large transfer) | performance | — | medium | 2 | — | — |  | — | 5 |
| PERF-007 | HTML served without compression | performance | — | low | 3 | — | — |  | — | 2 |
| SEC-001 | TLS certificate has expired | security | — | high | 1 | — | — |  | — | 18 |
| SEC-002 | TLS handshake failed | security | — | high | 1 | — | — |  | — | 18 |
| SEC-003 | TLS certificate not fully trusted | security | — | medium | 2 | — | — |  | — | 8 |
| SEC-004 | TLS certificate hostname mismatch | security | — | medium | 2 | — | — |  | — | 8 |
| SEC-005 | TLS certificate expiring soon | security | — | medium | 2 | — | — |  | — | 8 |
| SEC-006 | Outdated TLS protocol | security | — | medium | 2 | — | — |  | — | 8 |
| SEC-007 | Origin is not HTTPS | security | — | high | 1 | — | — |  | — | 14 |
| SEC-008 | HTTP not redirected to HTTPS | security | — | high | 2 | — | — |  | — | 14 |
| SEC-009 | Mixed content (http on https page) | security | — | high | 2 | — | — |  | — | 12 |
| SEC-010 | Security headers missing | security | — | medium | 2 | — | — |  | — | 6 |
| SEC-011 | Content-Security-Policy header missing | security | security | medium | 2 | verified | cheap |  | guided | 4 |
| SEC-012 | X-Frame-Options / frame-ancestors missing (clickjacking) | security | security | medium | 2 | verified | cheap |  | guided | 3 |
| SEC-013 | Referrer-Policy header missing | security | security | low | 3 | verified | cheap |  | guided | 2 |
| SEC-014 | Permissions-Policy header missing | security | security | low | 3 | verified | cheap |  | guided | 2 |
| SEC-015 | X-Content-Type-Options: nosniff missing | security | security | low | 3 | verified | cheap |  | guided | 3 |
| SEC-016 | Cookie missing Secure flag | security | security | medium | 2 | verified | cheap |  | guided | 4 |
| SEC-017 | Cookie missing HttpOnly flag | security | security | medium | 2 | verified | cheap |  | guided | 4 |
| SEC-018 | Cookie missing/weak SameSite | security | security | low | 3 | verified | cheap |  | guided | 2 |
| SEC-019 | .git directory exposed | security | security | critical | 1 | verified | moderate |  | manual | 20 |
| SEC-020 | Backup / archive file exposed | security | security | high | 2 | verified | moderate |  | manual | 14 |
| SEC-021 | Configuration file exposed | security | security | critical | 1 | verified | moderate |  | manual | 20 |
| SEC-022 | Directory listing enabled | security | security | medium | 2 | verified | moderate |  | manual | 6 |
| SEC-023 | Dangerous JavaScript pattern (eval / document.write / innerHTML) | security | security | low | 3 | heuristic | moderate |  | manual | 3 |
| SEC-024 | Password field served over HTTP | security | security | high | 2 | verified | cheap |  | manual | 14 |
| SEC-025 | Login form uses method=GET (credentials in URL) | security | security | high | 2 | verified | cheap |  | manual | 10 |
| XBR-001 | Firefox failed to load the page | crossbrowser | — | high | 1 | — | — |  | — | 12 |
| XBR-002 | WebKit (Safari engine) failed to load the page | crossbrowser | — | high | 1 | — | — |  | — | 12 |
| XBR-003 | Cross-browser console error(s) | crossbrowser | — | medium | 2 | — | — |  | — | 4 |
| CON-001 | JavaScript / console errors | console | — | high | 2 | — | — |  | — | 10 |
| CON-002 | Failed / broken asset requests | console | — | high | 2 | — | — |  | — | 8 |
| CON-003 | Page blocked by overlay the audit could not dismiss | console | — | medium | 2 | — | — |  | — | 4 |
| BP-001 | No <!DOCTYPE html> (quirks-mode risk) | best-practices | — | medium | 2 | — | — |  | — | 5 |
| BP-002 | No character encoding declared | best-practices | — | low | 3 | — | — |  | — | 3 |
| BP-003 | Deprecated HTML tag(s) in markup | best-practices | — | low | 3 | — | — |  | — | 3 |
| BP-004 | target="_blank" without rel="noopener" | best-practices | — | medium | 2 | — | — |  | — | 4 |
| BP-005 | Non-descriptive link text ("click here") | best-practices | — | low | 3 | — | — |  | — | 2 |
| BP-006 | Platform/version exposed via <meta generator> | best-practices | — | low | 3 | — | — |  | — | 2 |
| BP-007 | Inline on*="" event handler(s) | best-practices | — | low | 3 | — | — |  | — | 2 |
| BP-008 | Legacy/quirks DOCTYPE (not HTML5) | best-practices | — | low | 3 | — | — |  | — | 2 |
| VIS-001 | Visual mismatch vs reference exceeds threshold | visual | — | medium | 2 | — | — |  | — | 10 |
| VIS-002 | Reference page has no match on the candidate site | visual | — | medium | 2 | — | — |  | — | 8 |
