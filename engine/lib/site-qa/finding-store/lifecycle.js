'use strict';
// lifecycle.js — the deterministic finding lifecycle state machine. Fails CLOSED: any transition not
// explicitly permitted is rejected (no record is written). Identity is ruleId-based (WP-001); state
// is derived only from the append-only record chain (WP-002/003 laws — no hidden state).
//
//   OPEN → CONFIRMED → ACTIVE
//   ACTIVE   → UPDATED | RESOLVED | DUPLICATE | SUPERSEDED   (and ACTIVE→ACTIVE = repeated observation)
//   UPDATED  → ACTIVE | RESOLVED | DUPLICATE | SUPERSEDED
//   RESOLVED → REOPENED
//   REOPENED → ACTIVE
//   DUPLICATE, SUPERSEDED = terminal
const STATES = ['OPEN', 'CONFIRMED', 'ACTIVE', 'UPDATED', 'RESOLVED', 'REOPENED', 'DUPLICATE', 'SUPERSEDED'];

// null = "no prior record" (birth). Only OPEN may be born.
const ALLOWED = {
  'null': ['OPEN'],
  OPEN: ['CONFIRMED'],
  CONFIRMED: ['ACTIVE'],
  ACTIVE: ['ACTIVE', 'UPDATED', 'RESOLVED', 'DUPLICATE', 'SUPERSEDED'],
  UPDATED: ['ACTIVE', 'RESOLVED', 'DUPLICATE', 'SUPERSEDED'],
  RESOLVED: ['REOPENED'],
  REOPENED: ['ACTIVE'],
  DUPLICATE: [],
  SUPERSEDED: [],
};

const TERMINAL = new Set(['DUPLICATE', 'SUPERSEDED']);

function isState(s) { return STATES.includes(s); }
function isTerminal(s) { return TERMINAL.has(s); }

function canTransition(from, to) {
  const key = from == null ? 'null' : from;
  if (!isState(to)) return false;
  if (from != null && !isState(from)) return false;
  return (ALLOWED[key] || []).includes(to);
}

// Throws (fails closed) on an illegal transition — the caller never gets a record to append.
function assertTransition(from, to) {
  if (!canTransition(from, to)) {
    throw new Error(`invalid lifecycle transition: ${from == null ? '(birth)' : from} → ${to}`);
  }
  return to;
}

module.exports = { STATES, ALLOWED, TERMINAL, isState, isTerminal, canTransition, assertTransition };
