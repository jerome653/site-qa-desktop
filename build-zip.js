// Build engine.zip with SPEC-COMPLIANT forward-slash entry names.
//
// Windows PowerShell 5's Compress-Archive writes backslashes into entry names, which violates
// APPNOTE 4.4.17.1 ("The name of the file, with optional relative path... using forward slashes /").
// Verified: my Compress-Archive zip produced `lib\manual.html`; the known-good shipped 2.5.13 zip
// has `lib/manual.html`. Extractors that follow the spec would emit ONE flat file literally named
// "lib\manual.html" instead of a lib/ tree — breaking every install on next launch.
//
// No archiver dep is available (and adding one would not ship), so write the zip by hand with
// zlib.deflateRaw. Stored central directory + local headers, no ZIP64 needed at this size.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = process.argv[2];   // dir whose CHILDREN become the archive root
const OUT = process.argv[3];

function walk(dir, base = '') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    const rel = base ? base + '/' + e.name : e.name;      // ALWAYS forward slash
    if (e.isDirectory()) {
      if (e.name === 'node_modules') continue;
      out.push(...walk(abs, rel));
    } else out.push({ abs, rel });
  }
  return out;
}

const crcTable = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[i] = c; }
  return t;
})();
const crc32 = (buf) => { let c = ~0; for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ crcTable[(c ^ buf[i]) & 0xFF]; return ~c >>> 0; };

const files = walk(ROOT).sort((a, b) => a.rel.localeCompare(b.rel));
const locals = [];
const central = [];
let offset = 0;

for (const f of files) {
  const data = fs.readFileSync(f.abs);
  const comp = zlib.deflateRawSync(data, { level: 9 });
  const name = Buffer.from(f.rel, 'utf8');
  const crc = crc32(data);

  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6);
  lh.writeUInt16LE(8, 8); lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12);
  lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22);
  lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
  locals.push(lh, name, comp);

  const ch = Buffer.alloc(46);
  ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
  ch.writeUInt16LE(0, 8); ch.writeUInt16LE(8, 10); ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0, 14);
  ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24);
  ch.writeUInt16LE(name.length, 28); ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32);
  ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36); ch.writeUInt32LE(0, 38);
  ch.writeUInt32LE(offset, 42);
  central.push(ch, name);

  offset += lh.length + name.length + comp.length;
}

const localBuf = Buffer.concat(locals);
const centralBuf = Buffer.concat(central);
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);
eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
eocd.writeUInt32LE(centralBuf.length, 12); eocd.writeUInt32LE(localBuf.length, 16);
eocd.writeUInt16LE(0, 20);

fs.writeFileSync(OUT, Buffer.concat([localBuf, centralBuf, eocd]));
console.log(`  wrote ${path.basename(OUT)}  ${files.length} entries  ${(fs.statSync(OUT).size / 1024).toFixed(0)} KB`);
console.log(`  sample entries: ${files.slice(0, 3).map(f => f.rel).join(' | ')}`);
