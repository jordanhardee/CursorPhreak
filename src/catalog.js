'use strict';
// Read-only access to the packed asset bundle produced by tools/build_catalog.py.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

class Catalog {
  constructor(dir) {
    this.dir = dir;
    const data = JSON.parse(fs.readFileSync(path.join(dir, 'catalog.json'), 'utf8'));
    this.size = data.size;
    this.cats = data.cats;
    this.cursors = data.c;
    this.previewFd = fs.openSync(path.join(dir, 'previews.pak'), 'r');
    this.framesFd = fs.openSync(path.join(dir, 'frames.pak'), 'r');
  }

  has(id) {
    return Object.prototype.hasOwnProperty.call(this.cursors, id);
  }

  // Tree + minimal per-cursor info for the renderer.
  tree() {
    return this.cats;
  }

  preview(id) {
    const e = this.cursors[id];
    if (!e) return null;
    const buf = Buffer.alloc(e[1]);
    fs.readSync(this.previewFd, buf, 0, e[1], e[0]);
    return { data: buf, mime: e[2] === 0 ? 'image/gif' : 'image/png' };
  }

  cursor(id) {
    const e = this.cursors[id];
    if (!e) throw new Error(`Unknown cursor ${id}`);
    const comp = Buffer.alloc(e[4]);
    fs.readSync(this.framesFd, comp, 0, e[4], e[3]);
    const raw = zlib.inflateSync(comp);
    const n = e[5];
    const fsz = this.size * this.size * 4;
    const frames = [];
    for (let i = 0; i < n; i++) frames.push(raw.subarray(i * fsz, (i + 1) * fsz));
    return { id, w: this.size, h: this.size, frames, hx: e[6], hy: e[7], delays: e[8] };
  }
}

module.exports = { Catalog };
