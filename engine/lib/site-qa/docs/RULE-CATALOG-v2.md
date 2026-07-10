# SGEN Site QA — V2 Rule Catalog (Phase 1)

> Generated from the registry (v1.9.0). 32 rules added in V2 Phase 1.

| ID | Title | Suite | Sev | −pts | Quality | Cost | Interaction | Inspector | Fixability |
|---|---|---|---|---|---|---|---|---|---|
| LINK-006 | Dead link (empty href) | links | high | 8 | verified | cheap | yes | seo | guided |
| LINK-010 | Malformed mailto: / tel: link | links | low | 2 | verified | cheap | yes | seo | guided |
| LINK-007 | Link goes nowhere (href="#") | links | medium | 4 | verified | cheap | yes | seo | guided |
| LINK-008 | Dead link (javascript: no-op) | links | medium | 4 | verified | cheap | yes | seo | guided |
| LINK-009 | Link has no href | links | medium | 4 | verified | cheap | yes | seo | guided |
| DOM-003 | Duplicate id attribute(s) | a11y | medium | 4 | verified | cheap |  | stability | guided |
| DOM-004 | Excessive DOM size | performance | low | 3 | derived | moderate |  | stability | manual |
| DOM-010 | Button submits nothing (type=submit outside form) | functional | medium | 4 | verified | cheap | yes | stability | manual |
| DOM-011 | Empty onclick handler | functional | low | 2 | verified | cheap | yes | stability | manual |
| DOM-012 | Nested interactive controls | a11y | medium | 4 | verified | cheap | yes | stability | manual |
| DOM-013 | Disabled control presented as active | a11y | low | 2 | verified | cheap | yes | stability | manual |
| FORM-002 | Form field missing correct type / autocomplete | forms | low | 2 | verified | cheap |  | stability | guided |
| SEO-031 | hreflang is invalid or missing x-default | seo | medium | 4 | verified | cheap |  | seo | guided |
| SEO-035 | noindex combined with a cross-URL canonical (conflicting signals) | seo | medium | 5 | verified | cheap |  | seo | guided |
| SEO-036 | meta robots and X-Robots-Tag disagree | seo | medium | 5 | verified | cheap |  | seo | guided |
| SEO-037 | Thin content (very low word count) | seo | low | 3 | derived | moderate |  | seo | manual |
| SEO-038 | Very hard to read (low Flesch reading ease) | seo | low | 2 | derived | moderate |  | seo | manual |
| SEC-011 | Content-Security-Policy header missing | security | medium | 4 | verified | cheap |  | security | guided |
| SEC-012 | X-Frame-Options / frame-ancestors missing (clickjacking) | security | medium | 3 | verified | cheap |  | security | guided |
| SEC-013 | Referrer-Policy header missing | security | low | 2 | verified | cheap |  | security | guided |
| SEC-014 | Permissions-Policy header missing | security | low | 2 | verified | cheap |  | security | guided |
| SEC-015 | X-Content-Type-Options: nosniff missing | security | low | 3 | verified | cheap |  | security | guided |
| SEC-016 | Cookie missing Secure flag | security | medium | 4 | verified | cheap |  | security | guided |
| SEC-017 | Cookie missing HttpOnly flag | security | medium | 4 | verified | cheap |  | security | guided |
| SEC-018 | Cookie missing/weak SameSite | security | low | 2 | verified | cheap |  | security | guided |
| SEC-019 | .git directory exposed | security | critical | 20 | verified | moderate |  | security | manual |
| SEC-020 | Backup / archive file exposed | security | high | 14 | verified | moderate |  | security | manual |
| SEC-021 | Configuration file exposed | security | critical | 20 | verified | moderate |  | security | manual |
| SEC-022 | Directory listing enabled | security | medium | 6 | verified | moderate |  | security | manual |
| SEC-023 | Dangerous JavaScript pattern (eval / document.write / innerHTML) | security | low | 3 | heuristic | moderate |  | security | manual |
| SEC-024 | Password field served over HTTP | security | high | 14 | verified | cheap |  | security | manual |
| SEC-025 | Login form uses method=GET (credentials in URL) | security | high | 10 | verified | cheap |  | security | manual |

## Deferred (roadmap-tracked, not in Phase 1)
- image/video/news sitemap validation (SEO-032/034)
- broken markup (HTML-001) · broken fonts (STB-004)
- near-duplicate content clustering
