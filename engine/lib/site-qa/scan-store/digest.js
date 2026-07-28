'use strict';
// digest.js — ADR-0008 ADAPTER. The canonical-serialisation + sha256 implementation this file used to
// carry now lives ONCE in immutable-store/, because all four store copies were verified functionally
// identical (8 value shapes, both functions) before the extraction. Re-exported rather than deleted so
// every existing caller — and the "byte-identical hashing across stores" contract those copies each
// documented in prose — keeps working unchanged, and is now guaranteed by construction instead of by
// four files agreeing to stay in step.
const { canonical, sha256 } = require('../immutable-store');
module.exports = { canonical, sha256 };
