'use strict';
// reporting — additive reporting depth for the SGEN Site Auditor: deterministic executive summary +
// scan-diff renderers over the immutable history layer. Does NOT touch the frozen report.js (the
// per-scan HTML report). Self-contained output; pure functions.
const { execSummary, renderText, renderHTML, renderScanDiffText, esc } = require('./summary');

const REPORTING_VERSION = '1.0.0';

module.exports = { REPORTING_VERSION, execSummary, renderText, renderHTML, renderScanDiffText, esc };
