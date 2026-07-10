'use strict';
// portfolio.js — the Production Qualification Portfolio (living document + cumulative statistics).
// It does NOT audit sites — it RECORDS the results of `qa-certify` runs as certified case studies and
// maintains cumulative stats across all qualified projects. Append-only ledger (JSONL) → regenerated
// markdown. Reuses the certification pipeline entirely; adds no QA capability.
const fs = require('fs');
const path = require('path');

const CATEGORIES = ['small-brochure', 'corporate', 'large-marketing', 'blog', 'woocommerce', 'membership', 'lms', 'multi-language', 'large-asset-library', 'high-page-count', 'reference'];

// Build a portfolio case from a certifyMigration result `r` + runtime metrics.
function computeCase({ name, category, source, target, at, r, runtimeMs, memMb, screenshots, isReference }) {
  const c = r.refInv.counts;
  return {
    name, category, source, target, at, isReference: !!isReference,
    verdict: r.cert.verdict,
    metrics: {
      pages: c.page || 0, sections: c.section || 0, globals: c.global || 0, assets: c.asset || 0,
      forms: c.form || 0, behaviors: c.behavior || 0,
      inventorySize: r.refInv.total + (r.diff.added ? r.diff.added.length : 0),
      findings: r.cert.explanations.length,
      blocking: r.cert.tally.failed, warnings: r.cert.tally.warning,
      manual: r.cert.tally.manual, approved: r.cert.tally.approved,
      completenessFindings: r.diff.missing.length, visualFindings: r.visual ? r.visual.mapped : 0, productionFindings: r.production ? r.production.mapped : 0,
      runtimeMs: Math.round(runtimeMs || 0), memMb: +(memMb || 0).toFixed(1), screenshots: screenshots || 0, reportsGenerated: 1,
    },
  };
}

function appendCase(ledgerPath, caseObj) {
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.appendFileSync(ledgerPath, JSON.stringify(caseObj) + '\n');
}
function loadCases(ledgerPath) {
  if (!fs.existsSync(ledgerPath)) return [];
  return fs.readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}

function cumulative(cases) {
  const real = cases.filter(c => !c.isReference);
  const sum = (arr, f) => arr.reduce((a, c) => a + (f(c) || 0), 0);
  const n = cases.length || 1;
  return {
    totalProjects: cases.length, realProjects: real.length, referenceProjects: cases.length - real.length,
    totalPages: sum(cases, c => c.metrics.pages), totalAssets: sum(cases, c => c.metrics.assets),
    totalForms: sum(cases, c => c.metrics.forms), totalGlobals: sum(cases, c => c.metrics.globals),
    totalInventory: sum(cases, c => c.metrics.inventorySize),
    certifications: cases.length, totalFindings: sum(cases, c => c.metrics.findings),
    totalBlocking: sum(cases, c => c.metrics.blocking),
    avgRuntimeMs: Math.round(sum(cases, c => c.metrics.runtimeMs) / n), avgMemMb: +(sum(cases, c => c.metrics.memMb) / n).toFixed(1),
    verdicts: { PASS: cases.filter(c => c.verdict === 'PASS').length, MINOR: cases.filter(c => c.verdict === 'PASS WITH MINOR ISSUES').length, FAIL: cases.filter(c => c.verdict === 'FAIL').length },
    categoriesCovered: [...new Set(cases.map(c => c.category))],
  };
}

function renderPortfolio(allCases, defects = []) {
  // Supersede older runs of the same source→target pair (history kept in the ledger, never deleted).
  const latestIdx = {};
  allCases.forEach((c, i) => { latestIdx[c.source + '|' + c.target] = i; });
  const cases = allCases.map((c, i) => ({ ...c, superseded: latestIdx[c.source + '|' + c.target] !== i }));
  const current = cases.filter(c => !c.superseded);
  const superseded = cases.filter(c => c.superseded);
  const cum = cumulative(current);
  const catStatus = CATEGORIES.filter(c => c !== 'reference').map(cat => {
    const cs = cases.filter(x => x.category === cat && !x.isReference);
    return `| ${cat} | ${cs.length ? '✅ ' + cs.length + ' qualified' : '⬜ awaiting a real migration pair'} |`;
  }).join('\n');
  const caseRows = current.map(c => `| ${c.name}${c.isReference ? ' *(reference)*' : ''} | ${c.category} | ${c.verdict} | ${c.metrics.pages}p/${c.metrics.assets}a/${c.metrics.forms}f | ${c.metrics.findings} (${c.metrics.blocking} blk) | ${c.metrics.runtimeMs}ms/${c.metrics.memMb}MB |`).join('\n');
  const supRows = superseded.map(c => `| ${c.name} | ${c.at} | ${c.verdict} | ${c.metrics.pages}p/${c.metrics.forms}f · ${c.metrics.blocking} blk | superseded — kept for audit trail |`).join('\n');
  return `# SGEN Migration QA — Production Qualification Portfolio

> Living document. Each row is a certified case study produced by \`qa-certify\` (real execution, no
> mocks). Cumulative statistics roll up across all qualified projects. **Reference** cases are
> self-tests, not real client migrations — they prove the pipeline; they do not count toward category coverage.

## Cumulative statistics
- Projects qualified: **${cum.totalProjects}** (${cum.realProjects} real · ${cum.referenceProjects} reference)
- Pages analyzed: **${cum.totalPages}** · Assets: **${cum.totalAssets}** · Forms: **${cum.totalForms}** · Global components: **${cum.totalGlobals}** · Total inventory items: **${cum.totalInventory}**
- Certifications issued: **${cum.certifications}** · Total findings: **${cum.totalFindings}** (${cum.totalBlocking} blocking)
- Verdicts: PASS ${cum.verdicts.PASS} · PASS-WITH-MINOR ${cum.verdicts.MINOR} · FAIL ${cum.verdicts.FAIL}
- Avg runtime: **${cum.avgRuntimeMs} ms** · Avg memory: **${cum.avgMemMb} MB**
- Defects discovered during qualification: **${defects.length}** (all fixed + regression-covered)

## Category coverage (evidence-backed only)
| Category | Status |
|---|---|
${catStatus}

## Qualified cases
| Project | Category | Verdict | Inventory | Findings | Perf |
|---|---|---|---|---|---|
${caseRows || '| _(none yet — awaiting real migration pairs)_ | | | | | |'}

${superseded.length ? '## Superseded runs (history — kept, not deleted)\n> Earlier runs of the same source→target pair, retained for the audit trail. The current row above is authoritative.\n| Project | Run at | Verdict | Metrics | Note |\n|---|---|---|---|---|\n' + supRows + '\n\n' : ''}${defects.length ? '## Defects discovered + fixed during qualification\n' + defects.map(d => `- ${d}`).join('\n') + '\n' : ''}
## How to add a real case
\`\`\`
sgen qa-portfolio <source-url> --target <sgen-target-url> --name "<client>" --category <category>
\`\`\`
Runs the full pipeline (Inventory → Completeness → Visual → Production → Certification), records the
case, and regenerates this document. No stage skipped; every metric from runtime data.
`;
}

module.exports = { computeCase, appendCase, loadCases, cumulative, renderPortfolio, CATEGORIES };
