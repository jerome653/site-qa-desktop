'use strict';
// indexability/robots.js — a REAL robots.txt matcher, per search agent (RFC 9309).
//
// WHY THIS EXISTS SEPARATELY. checks-static.js already parses robots.txt, but only to answer one
// question: "does a blanket `Disallow: /` sit in a group a search crawler obeys?" That is a site-level
// yes/no. The question this module answers is per-URL and per-agent: **is THIS path crawlable by
// Googlebot, and separately by Bingbot?** Those two answers differ on real sites — a group that names
// `googlebot` and one that names `*` are different rule sets, and a site can (and does) block one
// engine while allowing the other. A site-level boolean cannot express that, so it was not extended;
// it was joined by this.
//
// THE MATCHING RULES, as specified (RFC 9309 §2.2.2), because getting them approximately right is how
// a tool tells someone their page is blocked when it is not:
//   • GROUP SELECTION — the group whose user-agent token is the LONGEST case-insensitive match for the
//     crawler name wins. `*` is the fallback and only applies when no named group matched. A crawler
//     obeys exactly ONE group; it does not union them.
//   • PATH MATCHING — `*` matches any run of characters, `$` anchors the end. Everything else is a
//     literal prefix match.
//   • PRECEDENCE — the LONGEST matching rule wins, whether Allow or Disallow. On an exact-length tie,
//     ALLOW wins. `Disallow:` with an empty value matches nothing (it is an explicit "allow all").
//   • NO robots.txt / 4xx robots.txt — everything is allowed. A 5xx is a different claim (unavailable),
//     and callers are told which of the two they got rather than being handed a bare `true`.
//
// AI-TRAINING AGENTS ARE NOT SEARCH AGENTS. `Google-Extended`, `Applebot-Extended`, `GPTBot`,
// `ClaudeBot`, `CCBot`, `PerplexityBot` and friends control training/answer corpora, NOT the search
// index. Blocking them is a deliberate policy choice and must never be reported as a crawlability
// defect — checks-static.js learned that the hard way on sgen.com (see its SEARCH_AGENTS comment).
// This module keeps the two populations in separate lists so no caller can conflate them by accident.

// The agents whose verdicts the product reports as SEARCH indexability. Two, deliberately: the user
// asked "Google and Bing", and every extra agent here is another column nobody reads.
const SEARCH_AGENTS = [
  { key: 'google', token: 'googlebot', label: 'Google' },
  { key: 'bing', token: 'bingbot', label: 'Bing' },
];

// Declared, never scored. Presence/absence here is reported as the site's stated AI policy.
const AI_AGENTS = [
  { token: 'gptbot', label: 'GPTBot (OpenAI, training)' },
  { token: 'oai-searchbot', label: 'OAI-SearchBot (OpenAI, search)' },
  { token: 'chatgpt-user', label: 'ChatGPT-User (OpenAI, on-demand fetch)' },
  { token: 'claudebot', label: 'ClaudeBot (Anthropic, training)' },
  { token: 'claude-searchbot', label: 'Claude-SearchBot (Anthropic, search)' },
  { token: 'claude-user', label: 'Claude-User (Anthropic, on-demand fetch)' },
  { token: 'google-extended', label: 'Google-Extended (Gemini/Vertex training)' },
  { token: 'applebot-extended', label: 'Applebot-Extended (Apple Intelligence training)' },
  { token: 'perplexitybot', label: 'PerplexityBot' },
  { token: 'ccbot', label: 'CCBot (Common Crawl)' },
  { token: 'bytespider', label: 'Bytespider (ByteDance)' },
  { token: 'amazonbot', label: 'Amazonbot' },
  { token: 'meta-externalagent', label: 'Meta-ExternalAgent' },
];

// ---------------------------------------------------------------------------------------------
// Parse robots.txt into groups. A group is one or more consecutive `User-agent:` lines followed by
// the rules that apply to all of them — a blank line or a rule line closes the agent block, which is
// why `pendingAgents` is reset on the first rule rather than on the blank line alone (real files are
// inconsistent about blank lines and every major crawler tolerates it).
function parseRobots(body) {
  const groups = [];           // { agents: [token], rules: [{ allow, path }] }
  const sitemaps = [];
  const crawlDelay = {};       // agent token -> seconds (reported, never scored)
  let pendingAgents = [];
  let current = null;

  for (const rawLine of String(body || '').split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (field === 'user-agent') {
      // A user-agent line after rules starts a NEW group; consecutive ones join the same group.
      if (current) { current = null; pendingAgents = []; }
      pendingAgents.push(value.toLowerCase());
      continue;
    }
    if (field === 'sitemap') { if (value) sitemaps.push(value); continue; }

    if (field === 'allow' || field === 'disallow') {
      if (pendingAgents.length && !current) {
        current = { agents: pendingAgents.slice(), rules: [] };
        groups.push(current);
      }
      if (!current) continue;                       // a rule with no group — ignored, as specified
      current.rules.push({ allow: field === 'allow', path: value });
      continue;
    }
    if (field === 'crawl-delay') {
      const n = Number(value);
      if (Number.isFinite(n)) for (const a of (current ? current.agents : pendingAgents)) crawlDelay[a] = n;
    }
  }
  return { groups, sitemaps, crawlDelay };
}

// Group selection: longest matching user-agent token, `*` only as fallback (RFC 9309 §2.2.1).
// Matching is by PREFIX on the crawler name, which is how `googlebot` also governs `googlebot-image`.
function groupFor(parsed, agentToken) {
  const want = String(agentToken || '').toLowerCase();
  let best = null, bestLen = -1;
  for (const g of parsed.groups) {
    for (const a of g.agents) {
      if (a === '*') continue;
      if (want === a || want.startsWith(a)) {
        if (a.length > bestLen) { best = g; bestLen = a.length; }
      }
    }
  }
  if (best) return { group: best, matchedBy: 'name' };
  const star = parsed.groups.find(g => g.agents.includes('*'));
  return star ? { group: star, matchedBy: 'wildcard' } : { group: null, matchedBy: 'none' };
}

// Translate a robots path pattern into a regex. `*` = any run, `$` (only at the end) = end-anchor.
// Everything else is literal, and the pattern is a PREFIX match unless `$` anchored it.
function patternToRegex(pattern) {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const escaped = body.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp('^' + escaped + (anchored ? '$' : ''));
}

// The path (+ query) a robots rule is matched against — robots.txt governs path, not host.
// BOTH FORMS ACCEPTED, and that is load-bearing rather than convenience: site-level callers ask about
// the root as the bare path `'/'`, and `new URL('/')` THROWS without a base. The first version returned
// null there and fell through to "allowed", so a robots.txt that closed the whole site to Googlebot
// reported it as crawlable — the exact false green this module exists to prevent, in the module itself.
function pathOf(url) {
  const s = String(url || '');
  if (s.startsWith('/')) return s;                    // already a path
  try { const u = new URL(s); return u.pathname + (u.search || ''); } catch (e) { return null; }
}

// Decide one URL for one agent. Returns the WINNING rule so a caller can quote the exact line that
// blocked a page rather than asserting "robots.txt blocks this" with nothing behind it.
function decide(parsed, agentToken, url) {
  const p = pathOf(url);
  if (p == null) return { allowed: true, rule: null, reason: 'unparsable-url' };
  const { group, matchedBy } = groupFor(parsed, agentToken);
  if (!group) return { allowed: true, rule: null, reason: 'no-matching-group', matchedBy };

  let winner = null;
  for (const r of group.rules) {
    if (!r.path) continue;                          // `Disallow:` empty matches nothing (= allow all)
    let re;
    try { re = patternToRegex(r.path); } catch (e) { continue; }
    if (!re.test(p)) continue;
    // Longest match wins; on a tie Allow wins (RFC 9309 §2.2.2).
    const len = r.path.length;
    if (!winner || len > winner.len || (len === winner.len && r.allow && !winner.rule.allow)) {
      winner = { len, rule: r };
    }
  }
  if (!winner) return { allowed: true, rule: null, reason: 'no-matching-rule', matchedBy };
  return {
    allowed: winner.rule.allow,
    rule: `${winner.rule.allow ? 'Allow' : 'Disallow'}: ${winner.rule.path}`,
    reason: winner.rule.allow ? 'allowed-by-rule' : 'disallowed-by-rule',
    matchedBy,
  };
}

// ---------------------------------------------------------------------------------------------
// The object the rest of the module consumes. `state` is the honest three-way that a bare boolean
// cannot carry: a 404 robots.txt means EVERYTHING IS ALLOWED, a 5xx means the crawler does not know
// (Google treats a persistent 5xx as disallow-all), and those must not read the same.
function buildRobots({ status, body, error }) {
  const state = error || !status ? 'unreachable'
    : status >= 500 ? 'server-error'
    : status >= 400 ? 'absent'
    : 'present';
  const parsed = state === 'present' ? parseRobots(body) : { groups: [], sitemaps: [], crawlDelay: {} };

  return {
    state,
    status: status || null,
    sitemaps: parsed.sitemaps,
    crawlDelay: parsed.crawlDelay,
    groups: parsed.groups.map(g => ({ agents: g.agents.slice(), rules: g.rules.length })),
    // Which named agents the file actually addresses. Reported as-is — this is the site's declared
    // policy surface, not a score.
    namedAgents: [...new Set(parsed.groups.flatMap(g => g.agents))].sort(),
    // Per-URL, per-agent decision. A 5xx robots.txt is treated as "unknown, assume blocked" the way
    // Google documents it, and says so in `reason` instead of quietly flipping the answer.
    allows(agentToken, url) {
      if (state === 'server-error') return { allowed: false, rule: null, reason: 'robots-5xx-treated-as-disallow' };
      if (state !== 'present') return { allowed: true, rule: null, reason: `robots-${state}` };
      return decide(parsed, agentToken, url);
    },
    // Site-level AI-crawler policy. NOT a defect either way — reported so an operator can see what
    // they have actually declared, which is usually not what they think they declared.
    aiPolicy() {
      if (state !== 'present') return AI_AGENTS.map(a => ({ ...a, declared: false, blocked: false }));
      return AI_AGENTS.map(a => {
        const named = parsed.groups.some(g => g.agents.includes(a.token));
        // Only a group that NAMES the agent counts as a declaration. Falling under `*` is the default,
        // not a decision, and presenting it as one would invent an intent the operator never expressed.
        const d = named ? decide(parsed, a.token, '/') : null;
        return { ...a, declared: named, blocked: !!(d && !d.allowed) };
      });
    },
  };
}

module.exports = { buildRobots, parseRobots, decide, groupFor, patternToRegex, SEARCH_AGENTS, AI_AGENTS };
