'use strict';
// lifecycle.js — the inventory-item lifecycle state machine (frozen spec, governance req #2).
// Every inventory item has a lifecycle, not just "exists". Fail-closed: an illegal transition throws
// (like finding-store). This is what lets certification answer "WHY did it fail?" — each item carries
// its state + the reason it got there, not just a boolean.
//
//   AUDIT path (one site):      DISCOVERED → VALIDATED → EVIDENCE_COLLECTED → PASSED|WARNING|FAILED|MANUAL
//   COMPARE path (two sites):   DISCOVERED → MATCHED → COMPARED → VALIDATED → EVIDENCE_COLLECTED → …
//   any state → IGNORED | APPROVED_EXCEPTION   (an explicit human decision)
const STATES = [
  'DISCOVERED', 'MATCHED', 'COMPARED', 'VALIDATED', 'EVIDENCE_PENDING', 'EVIDENCE_COLLECTED',
  'PASSED', 'WARNING', 'FAILED', 'MANUAL_VERIFICATION_REQUIRED', 'IGNORED', 'APPROVED_EXCEPTION',
];
const TERMINAL = new Set(['PASSED', 'WARNING', 'FAILED', 'MANUAL_VERIFICATION_REQUIRED', 'IGNORED', 'APPROVED_EXCEPTION']);

// null = birth. Only DISCOVERED may be born. Flow (layered, per constitution):
//   Provider→DISCOVERED · Comparison→MATCHED|COMPARED · Audit→VALIDATED · Evidence→EVIDENCE_PENDING→EVIDENCE_COLLECTED
//   · Certification→PASSED|WARNING|FAILED|MANUAL_VERIFICATION_REQUIRED · human→IGNORED|APPROVED_EXCEPTION
const ALLOWED = {
  'null': ['DISCOVERED'],
  DISCOVERED: ['MATCHED', 'COMPARED', 'VALIDATED', 'MANUAL_VERIFICATION_REQUIRED', 'IGNORED', 'APPROVED_EXCEPTION', 'FAILED'],
  MATCHED: ['COMPARED', 'VALIDATED', 'MANUAL_VERIFICATION_REQUIRED', 'IGNORED', 'APPROVED_EXCEPTION'],
  COMPARED: ['VALIDATED', 'MANUAL_VERIFICATION_REQUIRED', 'IGNORED', 'APPROVED_EXCEPTION'],
  VALIDATED: ['EVIDENCE_PENDING', 'EVIDENCE_COLLECTED', 'MANUAL_VERIFICATION_REQUIRED', 'IGNORED', 'APPROVED_EXCEPTION'],
  EVIDENCE_PENDING: ['EVIDENCE_COLLECTED', 'MANUAL_VERIFICATION_REQUIRED', 'IGNORED', 'APPROVED_EXCEPTION'],
  EVIDENCE_COLLECTED: ['PASSED', 'WARNING', 'FAILED', 'MANUAL_VERIFICATION_REQUIRED', 'IGNORED', 'APPROVED_EXCEPTION'],
  // terminal states accept only human overrides
  PASSED: ['IGNORED', 'APPROVED_EXCEPTION'],
  WARNING: ['IGNORED', 'APPROVED_EXCEPTION', 'FAILED'],
  FAILED: ['APPROVED_EXCEPTION', 'IGNORED'],
  MANUAL_VERIFICATION_REQUIRED: ['PASSED', 'WARNING', 'FAILED', 'APPROVED_EXCEPTION', 'IGNORED'],
  IGNORED: [],
  APPROVED_EXCEPTION: [],
};

function isState(s) { return STATES.includes(s); }
function isTerminal(s) { return TERMINAL.has(s); }
function canTransition(from, to) {
  const key = from == null ? 'null' : from;
  if (!isState(to)) return false;
  if (from != null && !isState(from)) return false;
  return (ALLOWED[key] || []).includes(to);
}
function assertTransition(from, to) {
  if (!canTransition(from, to)) throw new Error(`invalid inventory lifecycle transition: ${from == null ? '(birth)' : from} → ${to}`);
  return to;
}

module.exports = { STATES, TERMINAL, ALLOWED, isState, isTerminal, canTransition, assertTransition };
