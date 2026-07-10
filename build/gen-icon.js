'use strict';
// gen-icon.js — build the branded app icon from the UI's own mark: red rounded square (#C8181C) with
// the white checkmark. Renders the SVG at multiple sizes via sharp and packs a multi-size Windows .ico
// (crisp at 16/32/48 taskbar sizes + 256 for large views) + a 512 png for electron-builder.
const sharp = require('D:/AI/_dist/siteqa-app/engine/node_modules/sharp');
const fs = require('fs');
const path = require('path');

const OUT = __dirname;
// matches the UI .mark: brand-solid #C8181C bg, white check path "M5 12.5l4.2 4.2L19 7" (24-box) scaled.
const svg = (s) => `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 512 512">
  <rect x="24" y="24" width="464" height="464" rx="104" fill="#C8181C"/>
  <path d="M150 268 L228 344 L372 168" fill="none" stroke="#ffffff" stroke-width="52" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

const SIZES = [16, 24, 32, 48, 64, 128, 256];

// minimal ICO encoder: ICONDIR + N ICONDIRENTRY + concatenated PNG blobs (PNG-in-ICO, Vista+).
function encodeIco(pngs) {
  const count = pngs.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(count, 4);
  const entries = Buffer.alloc(16 * count);
  let offset = 6 + 16 * count;
  pngs.forEach((p, i) => {
    const b = entries.subarray(i * 16, i * 16 + 16);
    b.writeUInt8(p.size >= 256 ? 0 : p.size, 0); // width (0 = 256)
    b.writeUInt8(p.size >= 256 ? 0 : p.size, 1); // height
    b.writeUInt8(0, 2); b.writeUInt8(0, 3);      // colors, reserved
    b.writeUInt16LE(1, 4); b.writeUInt16LE(32, 6); // planes, bpp
    b.writeUInt32LE(p.data.length, 8);           // bytes in resource
    b.writeUInt32LE(offset, 12);                 // offset
    offset += p.data.length;
  });
  return Buffer.concat([header, entries, ...pngs.map(p => p.data)]);
}

(async () => {
  const pngs = [];
  for (const size of SIZES) pngs.push({ size, data: await sharp(Buffer.from(svg(size))).resize(size, size).png().toBuffer() });
  fs.writeFileSync(path.join(OUT, 'icon.ico'), encodeIco(pngs));
  fs.writeFileSync(path.join(OUT, 'icon.png'), await sharp(Buffer.from(svg(512))).resize(512, 512).png().toBuffer());
  console.log('generated build/icon.ico (' + SIZES.join('/') + ') + icon.png (512)');
})();
