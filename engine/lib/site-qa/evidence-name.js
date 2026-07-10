'use strict';
// site-qa/evidence-name.js — ONE canonical evidence filename scheme, reused by every capture site.
// Pattern:  <page>--<section>--<component>[--issue-<issue>]--<viewport>.png
// Plain evidence reads   home--hero--full--desktop.png
// Issue evidence reads   home--hero--btn-cta--issue-tap-target-small--mobile.png
// Every part is sanitized independently so a selector or heading text can never break the path.

const MAXPART = 48;

function part(s, fallback) {
  const p = String(s == null ? '' : s)
    .toLowerCase()
    .replace(/["'“”]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAXPART)
    .replace(/-+$/g, '');
  return p || fallback;
}

// page: URL slug · section: page region (heading/landmark) · component: element/selector or 'full'
// issue: check/rule name when the shot proves a finding · viewport: desktop/tablet/mobile/engine
function evidenceName({ page, section, component, issue, viewport } = {}) {
  const bits = [part(page, 'page'), part(section, 'page'), part(component, 'full')];
  if (issue) bits.push('issue-' + part(issue, 'finding'));
  bits.push(part(viewport, 'shot'));
  return bits.join('--') + '.png';
}

module.exports = { evidenceName, part };
