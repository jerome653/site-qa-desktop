# SGEN Migration QA — Operator Guide

A short workflow guide for using the tool correctly. If you read one page before running a migration
sign-off, read this one. Open the app with `sgen qa-serve` → **http://127.0.0.1:7878**.

---

## The three tools — which one, when

| You want to… | Use | Needs a second site? |
|---|---|---|
| Check that **one** site is technically healthy (before or after launch) | **Site Audit** | No |
| See whether **two** sites look and are built the same, screen by screen | **Visual Comparison** | Yes (reference + target) |
| **Sign off** that a migrated site is complete, faithful, and safe to go live | **Migration Certification** | Yes (source + target) |

### 1. Site Audit — "Is this one site healthy?"
Use it to check a single site for broken links, forms, accessibility (WCAG / axe-core), SEO, performance,
security (TLS), and cross-browser rendering. Independent — it needs nothing else.
- **When:** spot-checking any site; verifying a fix; a quick health read on staging before deeper work.
- **Do not** use it alone to approve a migration — it only looks at one site, it does not compare source vs target.

### 2. Visual Comparison — "Do these two sites match, visually?"
Renders a reference site and a target site side by side across the six SGEN breakpoints and diffs the
page render + structure.
- **When:** you want to see *where* two sites differ before certifying, or to review a redesign against a baseline.
- **Do not** treat a high match score as a migration sign-off on its own — it checks appearance, not completeness or production-readiness.

### 3. Migration Certification — "Is this migration safe to ship?"
The full pipeline, and the **only** tool that produces a migration verdict:

    Inventory → Completeness → Visual Comparison → Production Validation → Certification

It inventories both sites, checks every source page/asset/form is present on the target, compares them
visually, validates the target for production issues, and issues one verdict with evidence.
- **When:** approving any migration for go-live. This is the sign-off tool.
- **Tip:** for the completeness check, turn on **sitemap-only** so the canonical page list is authoritative.

---

## Reading the verdict

The verdict is one of three states. Read it together with the findings — never the headline alone.

### ✅ PASS
Every source item is present on the target, faithful, and production-clean. No blocking issues.
- **Action:** safe to approve. Keep the report as the sign-off record.

### ⚠️ PASS WITH MINOR ISSUES
No blocking problems, but there are advisory findings (small visual differences, non-blocking sub-page
or asset differences).
- **Action:** approve **only after** you have read each advisory finding and judged it acceptable.
  If any "minor" issue actually matters for this site, treat it as a blocker and hold.

### ❌ FAIL
At least one **blocking** problem — a source page or form is missing on the target, or a production-
readiness issue (e.g. a real accessibility fault) is present.
- **Action:** do **not** approve. Fix the blocking finding, then re-run. A FAIL is the tool doing its job.

### A finding marked "Manual Verification Required"
The tool could not automatically collect proof for that item. It is **not** a pass.
- **Action:** verify it yourself and record what you found before relying on it.

> **Important:** a **capped crawl never produces an authoritative completeness verdict** — the tool marks
> those completeness findings *manual* on purpose. If you need an authoritative completeness result, use
> **sitemap-only** so the whole canonical page set is covered.

---

## Evidence required before approving a migration

Do not approve on the headline verdict. Before you sign off, confirm the report actually contains:

1. **A Migration Certification report** (not just a Site Audit or Visual Comparison) — this is the only
   tool that certifies a migration.
2. **An authoritative completeness result** — every source page accounted for on the target (present, or
   an explicitly approved exception). If completeness is *manual/capped*, re-run with **sitemap-only**.
3. **Evidence attached to each finding** — screenshot / DOM / network proof. Findings without proof read
   as *Manual Verification Required* and must be checked by hand.
4. **Every blocking finding resolved** — verdict is PASS or PASS WITH MINOR ISSUES, and you have read and
   accepted each advisory item.
5. **The report saved to history** (Reports tab) — the certification report is the audit record for the
   sign-off. Keep it.

If any of these five is missing, the migration is **not** ready to approve — regardless of the verdict shown.

---

## Common mistakes to avoid
- Approving from a **Site Audit** (one site) instead of a **Certification** (source vs target).
- Trusting a **visual match %** as completeness — appearance ≠ every page present.
- Signing off a **PASS WITH MINOR ISSUES** without reading the advisories.
- Accepting a **capped** completeness result as authoritative — use sitemap-only.
- Treating **Manual Verification Required** as a pass.
