'use strict';
// collectors/network.js — THE NETWORK COLLECTOR (ADR-0005, governed by ADR-0004).
//
// The first inhabitant of the Collector layer, and the first module in this engine whose declared job
// is acquisition and NOTHING else. It sits ABOVE the determinism boundary (ADR-0004 §D3): it is allowed
// to touch the browser and the clock, and it is the only layer that is. It therefore contains — and
// must forever contain — no rule, no finding, no severity, no threshold, no score and no formatting.
// Everything it produces is raw observation; every judgement about that observation belongs to a
// provider, a rule or a view.
//
// WHAT THIS REPLACES. `checks-render.js` has attached listeners to every request and response on every
// scan since 2.0, and thrown the records away:
//     pg.on('response', r => { …; if (cl > 0) totalBytes += cl; });   // record discarded
//     if (weigh) pg.on('request', () => { reqCount++; });             // URL discarded
// Two aggregates survived (PERF-006's request count and byte floor); the per-request facts that make
// third-party attribution, cache analysis, waterfalls and migration payload deltas possible were
// observed and dropped, once per page, on every scan this engine has ever run. This module retains
// them. It adds no new browser work — it is the same events, kept.
//
// UNAVAILABLE IS NOT EMPTY. Several fields a complete ledger wants are simply not exposed by
// Playwright's public API on a Response: wire protocol (h2/h3), cache provenance, and the request
// initiator chain all live behind CDP. They are recorded as `null`, never as '' or 0, because a
// falsy-but-present value is how "we did not measure this" silently becomes "this is zero". The same
// distinction the CWV `lcpSeen` flag exists to protect. A child ADR may add a CDP collector; until
// then the ledger says it does not know.

const { COLLECTION_SCHEMA_VERSION } = require('../version');

// Per-page cap. Consistent with every other bound in this engine (ISSUE_SHOT_CAP 8, items.slice(0,25),
// linkAudit's 300/80): a pathological page must not be able to exhaust memory, and a truncated ledger
// must SAY it was truncated rather than quietly under-reporting.
const RECORD_CAP = 600;

// `documentUrl` is beyond the minimum field set and is here deliberately: a request record that cannot
// say which PAGE asked for it is nearly useless for the things this ledger exists to enable (per-page
// weight, third-party attribution, migration payload deltas). It is evidence, not identity — the
// provider keys items on method+url alone, so the same asset requested by two pages stays ONE logical
// request, with both document URLs reachable through its records.
const NETWORK_RECORD_FIELDS = [
  'url', 'documentUrl', 'method', 'resourceType', 'status', 'mimeType', 'headers',
  'sizeBytes', 'timing', 'initiator', 'fromCache', 'protocol', 'capturedAt',
  'context', 'failure',
];

// Strip the fragment only. Query is LOAD-BEARING for a network record (a cache-busted or
// differently-parameterised asset is a different request), so it is preserved — this is deliberately
// NOT the aggressive normalisation `lib/fingerprint.js` applies to page URLs.
function normalizeUrl(u) {
  const s = String(u == null ? '' : u);
  const i = s.indexOf('#');
  return i === -1 ? s : s.slice(0, i);
}

function mimeOf(headers) {
  const ct = headers && (headers['content-type'] || headers['Content-Type']);
  if (!ct) return null;
  return String(ct).split(';')[0].trim().toLowerCase() || null;
}

// content-length is a FLOOR, not the transfer size: a chunked or compressed response omits it, and a
// present value describes the encoded body only. `checks-render.js` already labels its page-weight
// finding "(content-length floor)" for exactly this reason. Absent header -> null, never 0.
function sizeOf(headers) {
  const raw = headers && (headers['content-length'] || headers['Content-Length']);
  if (raw == null) return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// makeNetworkRecord — pure. Exported so the record shape is testable without a browser, and so the
// shape has exactly ONE definition (a second construction site is how two half-compatible record
// shapes get born).
function makeNetworkRecord({ url, documentUrl, method, resourceType, status, headers, timing, context, failure, capturedAt }) {
  const h = headers || null;
  return {
    url: normalizeUrl(url),
    documentUrl: documentUrl ? normalizeUrl(documentUrl) : null,
    method: method || null,
    resourceType: resourceType || null,
    status: typeof status === 'number' ? status : null,
    mimeType: h ? mimeOf(h) : null,
    headers: h,
    sizeBytes: h ? sizeOf(h) : null,
    timing: timing || null,
    // NOT EXPOSED by Playwright's public Response API — see the header. A child ADR may add a CDP
    // collector; recording null is the honest state, and it is distinguishable from a measured value.
    initiator: null,
    fromCache: null,
    protocol: null,
    capturedAt: capturedAt || null,
    context: context || null,     // which emulation context observed it (metrics / a device group)
    failure: failure || null,     // requestfailed reason, else null
  };
}

// createNetworkSink() — the collector's accumulator. Owns the cap and the truncation flag so no caller
// has to remember either.
function createNetworkSink() {
  const records = [];
  let seen = 0;
  return {
    push(rec) {
      seen++;
      if (records.length < RECORD_CAP) records.push(rec);
      return rec;
    },
    get records() { return records; },
    get seen() { return seen; },
    get capped() { return seen > records.length; },
    // The channel payload, ready to hand to makeCollection({ network, collected:['network'] }).
    drain() { return records.slice(); },
  };
}

// attachNetworkCollector(page, sink, { context, now }) — wire the collector onto ONE Playwright page.
// `now` is injectable so a test can pin the clock; the collector is the layer allowed to read it, and
// injecting it is how the layer stays testable without becoming impure below the boundary.
//
// Deliberately additive: it attaches its OWN listeners and mutates nothing the existing render pass
// owns. Wiring it into `checks-render.js` therefore cannot move a single finding.
function attachNetworkCollector(page, sink, { context = null, documentUrl = null, now = () => new Date().toISOString() } = {}) {
  if (!page || typeof page.on !== 'function') throw new TypeError('attachNetworkCollector: expected a Playwright page');
  if (!sink || typeof sink.push !== 'function') throw new TypeError('attachNetworkCollector: expected a sink from createNetworkSink()');

  page.on('response', (res) => {
    try {
      const req = typeof res.request === 'function' ? res.request() : null;
      let timing = null;
      try { timing = req && typeof req.timing === 'function' ? req.timing() : null; } catch (_) { timing = null; }
      sink.push(makeNetworkRecord({
        url: typeof res.url === 'function' ? res.url() : null,
        method: req && typeof req.method === 'function' ? req.method() : null,
        resourceType: req && typeof req.resourceType === 'function' ? req.resourceType() : null,
        status: typeof res.status === 'function' ? res.status() : null,
        headers: typeof res.headers === 'function' ? res.headers() : null,
        timing, context, documentUrl, capturedAt: now(),
      }));
    } catch (_) { /* a collector must never break the run it is observing */ }
  });

  page.on('requestfailed', (req) => {
    try {
      const f = typeof req.failure === 'function' ? req.failure() : null;
      sink.push(makeNetworkRecord({
        url: typeof req.url === 'function' ? req.url() : null,
        method: typeof req.method === 'function' ? req.method() : null,
        resourceType: typeof req.resourceType === 'function' ? req.resourceType() : null,
        status: null,                          // a failed request never produced one — null, not 0
        headers: null,
        timing: null, context, documentUrl, capturedAt: now(),
        failure: (f && f.errorText) || 'request failed',
      }));
    } catch (_) { /* never break the run */ }
  });

  return sink;
}

module.exports = {
  attachNetworkCollector, createNetworkSink, makeNetworkRecord,
  normalizeUrl, mimeOf, sizeOf,
  RECORD_CAP, NETWORK_RECORD_FIELDS, COLLECTION_SCHEMA_VERSION,
};
