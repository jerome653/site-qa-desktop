'use strict';
// events.js — audit lifecycle event bus (Phase 2 additional requirement).
// A low-cost extension point: today it's an in-process EventEmitter, tomorrow the same events feed
// live progress, background workers, WebSockets, plugins, dashboards, notifications, distributed
// scanning — without redesigning the engine. Emitting is always safe: no listener = a no-op.
const { EventEmitter } = require('events');

const EVENTS = Object.freeze([
  'scan.started', 'page.started', 'rule.started', 'rule.completed',
  'finding.created', 'page.completed', 'scan.completed',
]);

class AuditBus extends EventEmitter {
  constructor() { super(); this.setMaxListeners(0); }
  // guarded emit — a throwing listener can never break a scan
  fire(event, payload) { try { this.emit(event, payload); } catch (e) { /* listener error is non-fatal */ } return this; }
}

function createBus() { return new AuditBus(); }

module.exports = { createBus, AuditBus, EVENTS };
