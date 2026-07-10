'use strict';
// backup.js — tamper-evident backup / restore / verify for the append-only stores. A backup is a
// byte-copy of the store tree plus a manifest of per-file sha256 digests and an overall digest, so a
// backup can be VERIFIED (not just assumed intact) and a RESTORE is confirmed before it is trusted.
// Append-only + content-addressed stores make this safe: nothing mutates, so a copy is a true point.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function sha256File(p) { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); }

// Recursively list files (sorted, relative) under root.
function listFiles(root, base = root) {
  const out = [];
  for (const name of fs.readdirSync(root).sort()) {
    const p = path.join(root, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) out.push(...listFiles(p, base));
    else out.push(path.relative(base, p).replace(/\\/g, '/'));
  }
  return out;
}

function copyFile(src, dest) { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(src, dest); }

// Create a backup of storeRoot into destDir. Returns the manifest (also written to destDir/BACKUP-MANIFEST.json).
function backup(storeRoot, destDir, opts = {}) {
  if (!fs.existsSync(storeRoot)) throw new Error('store root does not exist: ' + storeRoot);
  fs.mkdirSync(destDir, { recursive: true });
  const rels = listFiles(storeRoot);
  const files = [];
  for (const rel of rels) {
    const src = path.join(storeRoot, rel);
    copyFile(src, path.join(destDir, 'data', rel));
    files.push({ rel, sha256: sha256File(src), size: fs.statSync(src).size });
  }
  const manifest = { source: path.resolve(storeRoot), createdAt: opts.createdAt || '', fileCount: files.length, files };
  manifest.digest = crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex');
  fs.writeFileSync(path.join(destDir, 'BACKUP-MANIFEST.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

// Verify a backup: every file present, every sha256 matches, overall digest matches. Detects
// corruption, truncation, deletion, or tampering of the backup itself.
function verifyBackup(destDir) {
  const mp = path.join(destDir, 'BACKUP-MANIFEST.json');
  if (!fs.existsSync(mp)) return { ok: false, issues: [{ type: 'no-manifest' }] };
  const manifest = JSON.parse(fs.readFileSync(mp, 'utf8'));
  const issues = [];
  if (manifest.digest !== crypto.createHash('sha256').update(JSON.stringify(manifest.files)).digest('hex')) issues.push({ type: 'manifest-digest-mismatch' });
  for (const f of manifest.files) {
    const p = path.join(destDir, 'data', f.rel);
    if (!fs.existsSync(p)) { issues.push({ type: 'missing-file', rel: f.rel }); continue; }
    if (sha256File(p) !== f.sha256) issues.push({ type: 'corrupt-file', rel: f.rel });
  }
  // extra files not in the manifest = tampering
  const present = new Set(manifest.files.map(f => f.rel));
  const dataDir = path.join(destDir, 'data');
  if (fs.existsSync(dataDir)) for (const rel of listFiles(dataDir)) if (!present.has(rel)) issues.push({ type: 'unexpected-file', rel });
  return { ok: issues.length === 0, fileCount: manifest.files.length, issues };
}

// Restore a verified backup into targetRoot. Refuses to restore a backup that fails verification.
// If a store verify function is supplied, the restored store is integrity-checked before success.
function restore(destDir, targetRoot, opts = {}) {
  const v = verifyBackup(destDir);
  if (!v.ok) return { ok: false, reason: 'backup verification failed', issues: v.issues };
  const dataDir = path.join(destDir, 'data');
  for (const rel of listFiles(dataDir)) copyFile(path.join(dataDir, rel), path.join(targetRoot, rel));
  let storeVerified = null;
  if (typeof opts.verifyStore === 'function') { const r = opts.verifyStore(targetRoot); storeVerified = !!(r && r.ok); if (!storeVerified) return { ok: false, reason: 'restored store failed integrity verify', storeResult: r }; }
  return { ok: true, restored: v.fileCount, storeVerified };
}

module.exports = { backup, verifyBackup, restore, listFiles, sha256File };
