'use strict';
// Writes sample .cur/.ani/Xcursor files for a few catalog cursors so they can be checked by an independent parser.
const fs = require('fs');
const path = require('path');
const { Catalog } = require('../src/catalog');
const { curImage, aniFile, xcursorFile, pngFile } = require('../src/encoders');

const out = process.argv[2] || path.join(__dirname, '..', 'test-out');
fs.mkdirSync(out, { recursive: true });
const cat = new Catalog(path.join(__dirname, '..', 'assets'));
const ids = process.argv.slice(3).length ? process.argv.slice(3) : ['11967a', '45[1]', '11500a', '3875'];
const manifest = [];
for (const id of ids) {
  const c = cat.cursor(id);
  const safe = id.replace(/[^A-Za-z0-9_-]/g, '_');
  fs.writeFileSync(path.join(out, `${safe}.cur`), curImage(c.frames[0], c.w, c.h, c.hx, c.hy));
  fs.writeFileSync(path.join(out, `${safe}.ani`), aniFile(c.frames, c.delays, c.w, c.h, c.hx, c.hy, `CursorPhreak ${id}`));
  fs.writeFileSync(path.join(out, `${safe}.xcur`), xcursorFile(c.frames, c.delays, c.w, c.h, c.hx, c.hy, [1, 2]));
  fs.writeFileSync(path.join(out, `${safe}.png`), pngFile(Buffer.from(c.frames[0]), c.w, c.h));
  manifest.push({ id, safe, frames: c.frames.length, delays: c.delays, hx: c.hx, hy: c.hy });
}
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 1));
console.log(`wrote ${ids.length} cursors to ${out}`);
