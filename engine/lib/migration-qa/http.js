'use strict';
// migration-qa/http.js — shared fetch helpers + concurrency pool.
// Lifted from W2 docs-qa-crawl.js (get/getText/abs/pool) and hardened with a timeout.
// Anonymous by default (no cookies) — that is the attacker/customer perspective, and it
// means public + staging surfaces need no creds. Node 18+ global fetch/AbortController.

const UA = 'Mozilla/5.0 (SGEN-migration-QA production-ready check)';
const DEFAULT_TIMEOUT = 20000;

async function get(url, opts = {}) {
  const { timeout = DEFAULT_TIMEOUT, ...rest } = opts;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': UA },
      redirect: 'manual',
      signal: ctl.signal,
      ...rest,
    });
    return r;
  } finally {
    clearTimeout(t);
  }
}

// Classify a fetch rejection into a stable code the diagnostics layer can act on.
// Necessary because undici collapses a DNS failure and a refused connection into the SAME message
// ("fetch failed") and hangs the real reason off e.cause — so e.message alone cannot tell a typo'd
// domain from a blackholed route, and a caller reading only the message will blame the URL for a
// network fault. Verified on Node 24: a bad name -> cause.code 'ENOTFOUND'; an aborted request ->
// AbortError carrying no cause at all. get()'s AbortController is the only aborter in this module,
// so AbortError here always means OUR timeout elapsed. Returns '' when the cause is unknowable —
// callers must treat '' as "no evidence" and not guess.
function failureCode(e) {
  if (!e) return '';
  if (e.name === 'AbortError') return 'ETIMEDOUT';
  const code = e.cause && e.cause.code;
  return code ? String(code) : '';
}

// Full GET: returns status, body, a plain-object header map, final URL, redirect location.
async function getText(url, opts = {}) {
  try {
    const r = await get(url, opts);
    let body = '';
    try { body = await r.text(); } catch (e) {}
    const headers = {};
    r.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
    return {
      ok: true,
      status: r.status,
      body,
      headers,
      finalUrl: r.url || url,
      location: r.headers.get('location') || null,
      contentType: (headers['content-type'] || ''),
    };
  } catch (e) {
    return { ok: false, status: 0, body: '', headers: {}, finalUrl: url, location: null, contentType: '', error: String(e && e.message || e), errorCode: failureCode(e) };
  }
}

// HEAD probe with GET fallback on 405/501 (some CDNs reject HEAD). Returns status number or 'ERR:..'.
async function head(url, opts = {}) {
  try {
    let r = await get(url, { method: 'HEAD', ...opts });
    if (r.status === 405 || r.status === 501) r = await get(url, { method: 'GET', ...opts });
    return r.status;
  } catch (e) {
    return 'ERR:' + String(e && e.message || e).slice(0, 40);
  }
}

function abs(src, pageUrl) {
  try { return new URL(src, pageUrl).href; } catch (e) { return null; }
}

// Bounded-concurrency map. Never throws — a failing item resolves to { error }.
async function pool(items, conc, fn) {
  const ret = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      try { ret[idx] = await fn(items[idx], idx); }
      catch (e) { ret[idx] = { error: String(e && e.message || e) }; }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, conc) }, worker));
  return ret;
}

module.exports = { UA, get, getText, head, abs, pool, failureCode };
