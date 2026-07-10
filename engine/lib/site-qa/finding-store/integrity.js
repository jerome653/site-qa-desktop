'use strict';
// integrity.js — verification + recovery for the immutable Finding Store.
// Verify answers "is the finding history internally consistent, untampered, and lifecycle-legal?"
// Recovery repairs only the safe classes (partial writes, stale/torn indexes, torn manifest tail);
// tampering / deletion / illegal transitions are REPORTED, never silently "fixed".
const fs = require('fs');
const path = require('path');
const { FindingStore } = require('./store');
const { sha256 } = require('./digest');
const { recordForDigest } = require('./record');
const { canTransition } = require('./lifecycle');

function asStore(s) { return s instanceof FindingStore ? s : new FindingStore(s); }

function verify(store, opts = {}) {
  store = asStore(store);
  const scanStore = opts.scanStore || null; // optional: to detect orphaned scan references
  const issues = [];
  const manifest = store.manifest();
  const committed = manifest.filter(m => !m.__torn);
  const torn = manifest.filter(m => m.__torn);
  const storedIds = store.storedIds();
  const storedSet = new Set(storedIds);
  const committedSet = new Set(committed.map(m => m.recordId));

  // Torn manifest tail = truncation / partial commit.
  for (const t of torn) issues.push({ type: 'torn-manifest', detail: 'unparseable manifest line (truncation/partial commit)' });

  // Duplicate recordId in manifest.
  const seenRec = new Set();
  for (const m of committed) {
    if (seenRec.has(m.recordId)) issues.push({ type: 'duplicate', recordId: m.recordId, detail: 'recordId appears more than once in manifest' });
    seenRec.add(m.recordId);
  }
  // Missing (manifest → no record) and orphan (record → no manifest).
  for (const m of committed) if (!storedSet.has(m.recordId)) issues.push({ type: 'missing', recordId: m.recordId, detail: 'manifest references a record not on disk (deleted)' });
  for (const id of storedIds) if (!committedSet.has(id)) issues.push({ type: 'orphan', recordId: id, detail: 'record on disk never committed to manifest' });

  // Partial writes.
  for (const f of fs.readdirSync(store.storageDir)) if (f.endsWith('.tmp')) issues.push({ type: 'partial-write', file: f, detail: 'interrupted write (temp never renamed)' });

  // Per-record: digest (tamper/forge), content-address (forge), duplicate identity conflict.
  const bySeqKey = new Map(); // findingId|seq → recordId
  for (const id of storedIds) {
    let rec; try { rec = store.get(id); } catch (e) { issues.push({ type: 'unreadable', recordId: id, detail: String(e.message || e) }); continue; }
    if (rec.digest !== sha256(recordForDigest(rec))) issues.push({ type: 'digest-mismatch', recordId: id, detail: 'record content does not match its digest (modified/forged)' });
    // recordId is content-addressed: recompute from its own fields.
    const expectId = sha256(`${rec.findingId}|${rec.seq}|${rec.newState}|${rec.evidenceRef.evidenceDigest}|${rec.timestamp}`).slice(0, 32);
    if (expectId !== rec.recordId) issues.push({ type: 'address-mismatch', recordId: id, detail: 'recordId not derivable from content (forged append)' });
    const k = rec.findingId + '|' + rec.seq;
    if (bySeqKey.has(k) && bySeqKey.get(k) !== id) issues.push({ type: 'identity-conflict', recordId: id, detail: `two records claim ${k} (duplicate identity conflict)` });
    bySeqKey.set(k, id);
    if (scanStore && rec.scanRef.scanId && !scanStore.has(rec.scanRef.scanId)) issues.push({ type: 'orphaned-reference', recordId: id, detail: 'scanRef points to a scan not in the Scan Store' });
  }

  // Per-finding chain: contiguous seq, legal transitions, intact parent links (reorder + illegal-transition + broken-chain).
  const findingIds = new Set(committed.map(m => m.findingId));
  for (const fid of findingIds) {
    const recs = store.recordsFor(fid);
    for (let i = 0; i < recs.length; i++) {
      const r = recs[i];
      if (r.seq !== i) { issues.push({ type: 'reorder', findingId: fid, detail: `seq gap/reorder at position ${i} (seq=${r.seq})` }); break; }
      const prevState = i === 0 ? null : recs[i - 1].newState;
      if (r.previousState !== prevState) issues.push({ type: 'broken-chain', findingId: fid, recordId: r.recordId, detail: 'previousState does not match the prior record' });
      if (!canTransition(prevState, r.newState)) issues.push({ type: 'invalid-transition', findingId: fid, recordId: r.recordId, detail: `illegal ${prevState} → ${r.newState}` });
      const expectParent = i === 0 ? null : recs[i - 1].recordId;
      if ((r.parentRecordId || null) !== expectParent) issues.push({ type: 'broken-chain', findingId: fid, recordId: r.recordId, detail: 'parentRecordId does not link to the prior record' });
    }
  }

  const byType = {};
  for (const i of issues) byType[i.type] = (byType[i.type] || 0) + 1;
  return { ok: issues.length === 0, records: storedIds.length, committed: committed.length, findings: findingIds.size, issues, summary: byType };
}

function recover(store) {
  store = asStore(store);
  const actions = [];
  // 1) Remove interrupted temp writes.
  for (const f of fs.readdirSync(store.storageDir)) if (f.endsWith('.tmp')) { fs.unlinkSync(path.join(store.storageDir, f)); actions.push({ action: 'removed-partial-write', file: f }); }
  // 2) Truncate a torn manifest tail (drop only the trailing unparseable line — valid history preserved).
  if (fs.existsSync(store.manifestPath)) {
    const lines = fs.readFileSync(store.manifestPath, 'utf8').split('\n');
    let changed = false;
    while (lines.length) {
      const last = lines[lines.length - 1];
      if (last === '') { lines.pop(); continue; }
      try { JSON.parse(last); break; } catch (_) { lines.pop(); changed = true; }
    }
    if (changed) { fs.writeFileSync(store.manifestPath, lines.join('\n') + (lines.length ? '\n' : '')); actions.push({ action: 'truncated-torn-manifest-tail' }); }
  }
  // 3) Rebuild indexes from committed records.
  const r = store.rebuildIndexes();
  actions.push({ action: 'rebuilt-indexes', count: r.rebuilt });
  // 4) Re-verify; surface the unrepairable.
  const post = verify(store);
  const unrepairable = post.issues.filter(i => ['digest-mismatch', 'address-mismatch', 'missing', 'broken-chain', 'invalid-transition', 'identity-conflict', 'reorder'].includes(i.type));
  return { actions, verified: post.ok, remaining: unrepairable, summary: post.summary };
}

module.exports = { verify, recover };
