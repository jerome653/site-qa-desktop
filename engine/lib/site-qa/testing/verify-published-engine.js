'use strict';
// POST-PUBLISH VERIFICATION. The version number is never evidence of the payload — this repo has a
// scar for exactly that (three checksums agreeing over an archive whose packageVersion was stale).
// So: fetch the feed anonymously and cache-busted, hash the bytes we actually received, and read the
// version strings out of the archive itself. Entry names are read from the RAW CENTRAL DIRECTORY,
// because an extractor normalises separators and would hide the APPNOTE 4.4.17.1 backslash trap that
// once shipped a payload no spec-following extractor could unpack.
const https = require('https');
const crypto = require('crypto');
const zlib = require('zlib');

const BASE = 'https://github.com/jerome653/migration-qa/releases/download/engine-latest';
const cb = () => '?cb=' + crypto.randomBytes(8).toString('hex');

function get(url, redirects = 0) {
  return new Promise((res, rej) => {
    https.get(url, { headers: { 'user-agent': 'sgen-verify' } }, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && redirects < 6) {
        r.resume(); return res(get(r.headers.location, redirects + 1));
      }
      if (r.statusCode !== 200) { r.resume(); return rej(new Error(url.split('?')[0] + ' -> HTTP ' + r.statusCode)); }
      const chunks = []; r.on('data', (c) => chunks.push(c)); r.on('end', () => res(Buffer.concat(chunks)));
    }).on('error', rej);
  });
}

// Minimal zip reader: walk the End-Of-Central-Directory -> central directory entries.
function entries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('no EOCD — not a zip');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('central directory desync at entry ' + i);
    const nLen = buf.readUInt16LE(off + 28), eLen = buf.readUInt16LE(off + 30), cLen = buf.readUInt16LE(off + 32);
    const method = buf.readUInt16LE(off + 10), csize = buf.readUInt32LE(off + 20), lho = buf.readUInt32LE(off + 42);
    out.push({ name: buf.slice(off + 46, off + 46 + nLen).toString('utf8'), method, csize, lho });
    off += 46 + nLen + eLen + cLen;
  }
  return out;
}

function read(buf, e) {
  const nLen = buf.readUInt16LE(e.lho + 26), eLen = buf.readUInt16LE(e.lho + 28);
  const start = e.lho + 30 + nLen + eLen;
  const raw = buf.slice(start, start + e.csize);
  return e.method === 0 ? raw : zlib.inflateRawSync(raw);
}

(async () => {
  const want = process.argv[2];
  const version = (await get(BASE + '/version.txt' + cb())).toString().trim();
  const shaAsset = (await get(BASE + '/engine.zip.sha256' + cb())).toString().trim().split(/\s+/)[0].toLowerCase();
  const zip = await get(BASE + '/engine.zip' + cb());
  const shaActual = crypto.createHash('sha256').update(zip).digest('hex');

  const list = entries(zip);
  const backslash = list.filter((e) => e.name.includes('\\'));
  const dnsFiles = list.filter((e) => e.name.startsWith('lib/dns/'));
  const pkgEntry = list.find((e) => e.name === 'package.json');
  const metaEntry = list.find((e) => e.name === 'lib/site-qa/release-metadata.json');
  const pkgVer = pkgEntry ? JSON.parse(read(zip, pkgEntry).toString('utf8')).version : null;
  const metaVer = metaEntry ? JSON.parse(read(zip, metaEntry).toString('utf8')).packageVersion : null;
  const rulesEntry = list.find((e) => e.name === 'lib/dns/rules.js');
  const ruleCount = rulesEntry ? new Set(read(zip, rulesEntry).toString('utf8').match(/R\('DNS-\d{3}'/g) || []).size : null;

  const line = (label, val, good) => console.log(`  ${good ? 'OK  ' : 'BAD '} ${label.padEnd(34)} ${val}`);
  console.log('\nfeed: ' + BASE + '\n');
  line('version.txt', version, !want || version === want);
  line('sha256 asset == bytes received', shaActual, shaAsset === shaActual);
  line('package.json INSIDE the zip', pkgVer, !want || pkgVer === want);
  line('release-metadata INSIDE the zip', metaVer, !want || metaVer === want);
  line('entries', list.length + ' (' + backslash.length + ' with backslashes)', backslash.length === 0);
  line('lib/dns/ files', dnsFiles.length, dnsFiles.length >= 9);
  line('DNS rules declared in payload', ruleCount, ruleCount === 31);

  const bad = (want && (version !== want || pkgVer !== want || metaVer !== want)) || shaAsset !== shaActual || backslash.length || dnsFiles.length < 9 || ruleCount !== 31;
  console.log('\n' + (bad ? '❌ PAYLOAD DOES NOT MATCH THE CLAIM' : '✅ published payload verified from its own bytes'));
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error('verify failed: ' + e.message); process.exit(2); });
