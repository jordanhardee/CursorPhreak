'use strict';
// Pure-JS encoders for cursor formats. Input frames are 32-bit RGBA buffers (row-major, top-down).

const zlib = require('zlib');

// ---------- Windows .cur (single image, 32bpp BGRA + AND mask) ----------
function curImage(rgba, w, h, hx, hy) {
  const xorRow = w * 4;
  const andRow = Math.ceil(w / 32) * 4;
  const xorSize = xorRow * h;
  const andSize = andRow * h;
  const bmpSize = 40 + xorSize + andSize;
  const buf = Buffer.alloc(6 + 16 + bmpSize);
  // ICONDIR
  buf.writeUInt16LE(0, 0);
  buf.writeUInt16LE(2, 2); // 2 = cursor
  buf.writeUInt16LE(1, 4);
  // ICONDIRENTRY
  buf.writeUInt8(w >= 256 ? 0 : w, 6);
  buf.writeUInt8(h >= 256 ? 0 : h, 7);
  buf.writeUInt8(0, 8);
  buf.writeUInt8(0, 9);
  buf.writeUInt16LE(hx, 10);
  buf.writeUInt16LE(hy, 12);
  buf.writeUInt32LE(bmpSize, 14);
  buf.writeUInt32LE(22, 18);
  // BITMAPINFOHEADER
  let o = 22;
  buf.writeUInt32LE(40, o);
  buf.writeInt32LE(w, o + 4);
  buf.writeInt32LE(h * 2, o + 8); // XOR + AND
  buf.writeUInt16LE(1, o + 12);
  buf.writeUInt16LE(32, o + 14);
  buf.writeUInt32LE(0, o + 16);
  buf.writeUInt32LE(xorSize + andSize, o + 20);
  o += 40;
  // XOR bitmap, bottom-up, BGRA
  for (let y = 0; y < h; y++) {
    const src = (h - 1 - y) * w * 4;
    for (let x = 0; x < w; x++) {
      const s = src + x * 4;
      const a = rgba[s + 3];
      const d = o + y * xorRow + x * 4;
      if (a === 0) continue; // fully transparent stays 0,0,0,0
      buf[d] = rgba[s + 2];
      buf[d + 1] = rgba[s + 1];
      buf[d + 2] = rgba[s];
      buf[d + 3] = a;
    }
  }
  o += xorSize;
  // AND mask, bottom-up, 1 = transparent
  for (let y = 0; y < h; y++) {
    const src = (h - 1 - y) * w * 4;
    for (let x = 0; x < w; x++) {
      if (rgba[src + x * 4 + 3] < 128) buf[o + y * andRow + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return buf;
}

function chunk(id, data) {
  const pad = data.length & 1 ? 1 : 0;
  const b = Buffer.alloc(8 + data.length + pad);
  b.write(id, 0, 'ascii');
  b.writeUInt32LE(data.length, 4);
  data.copy(b, 8);
  return b;
}

function list(type, chunks) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), ...chunks]);
  return chunk('LIST', body);
}

// ---------- Windows .ani (RIFF ACON) ----------
function aniFile(frames, delaysMs, w, h, hx, hy, title) {
  const n = frames.length;
  const jiffies = delaysMs.map((ms) => Math.max(1, Math.round((ms * 60) / 1000)));
  const anih = Buffer.alloc(36);
  anih.writeUInt32LE(36, 0); // cbSize
  anih.writeUInt32LE(n, 4); // nFrames
  anih.writeUInt32LE(n, 8); // nSteps
  anih.writeUInt32LE(0, 12); // iWidth  (ignored with AF_ICON)
  anih.writeUInt32LE(0, 16); // iHeight
  anih.writeUInt32LE(0, 20); // iBitCount
  anih.writeUInt32LE(0, 24); // nPlanes
  anih.writeUInt32LE(jiffies[0], 28); // iDispRate (default)
  anih.writeUInt32LE(1, 32); // bfAttributes: AF_ICON
  const rate = Buffer.alloc(4 * n);
  jiffies.forEach((j, i) => rate.writeUInt32LE(j, i * 4));
  const parts = [];
  if (title) {
    parts.push(list('INFO', [chunk('INAM', Buffer.from(title + '\0', 'latin1'))]));
  }
  parts.push(chunk('anih', anih));
  parts.push(chunk('rate', rate));
  parts.push(list('fram', frames.map((f) => chunk('icon', curImage(f, w, h, hx, hy)))));
  const body = Buffer.concat([Buffer.from('ACON', 'ascii'), ...parts]);
  const riff = Buffer.alloc(8);
  riff.write('RIFF', 0, 'ascii');
  riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}

// ---------- Xcursor (X11 / Wayland compositors) ----------
const XCURSOR_IMAGE_TYPE = 0xfffd0002;

function scaleNearest(rgba, w, h, f) {
  const W = w * f;
  const H = h * f;
  const out = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const s = (((y / f) | 0) * w + ((x / f) | 0)) * 4;
      const d = (y * W + x) * 4;
      out[d] = rgba[s];
      out[d + 1] = rgba[s + 1];
      out[d + 2] = rgba[s + 2];
      out[d + 3] = rgba[s + 3];
    }
  }
  return out;
}

/**
 * frames: RGBA buffers at base size w x h. scales: integer multipliers to embed (e.g. [1, 2]).
 * Each scale becomes its own nominal size so Xcursor can pick the best match for the user's cursor size.
 */
function xcursorFile(frames, delaysMs, w, h, hx, hy, scales = [2, 1]) {
  const images = [];
  for (const s of scales) {
    for (let i = 0; i < frames.length; i++) {
      images.push({
        nominal: w * s,
        w: w * s,
        h: h * s,
        hx: hx * s,
        hy: hy * s,
        delay: frames.length > 1 ? delaysMs[i] : 0,
        rgba: s === 1 ? frames[i] : scaleNearest(frames[i], w, h, s),
      });
    }
  }
  const ntoc = images.length;
  const headerSize = 16;
  let pos = headerSize + ntoc * 12;
  const tocs = [];
  const chunks = [];
  for (const im of images) {
    const c = Buffer.alloc(36 + im.w * im.h * 4);
    c.writeUInt32LE(36, 0);
    c.writeUInt32LE(XCURSOR_IMAGE_TYPE, 4);
    c.writeUInt32LE(im.nominal, 8);
    c.writeUInt32LE(1, 12);
    c.writeUInt32LE(im.w, 16);
    c.writeUInt32LE(im.h, 20);
    c.writeUInt32LE(im.hx, 24);
    c.writeUInt32LE(im.hy, 28);
    c.writeUInt32LE(im.delay, 32);
    let o = 36;
    for (let p = 0; p < im.w * im.h; p++) {
      const r = im.rgba[p * 4];
      const g = im.rgba[p * 4 + 1];
      const b = im.rgba[p * 4 + 2];
      const a = im.rgba[p * 4 + 3];
      // premultiplied ARGB, little-endian => bytes B,G,R,A
      c[o] = Math.round((b * a) / 255);
      c[o + 1] = Math.round((g * a) / 255);
      c[o + 2] = Math.round((r * a) / 255);
      c[o + 3] = a;
      o += 4;
    }
    tocs.push([XCURSOR_IMAGE_TYPE, im.nominal, pos]);
    chunks.push(c);
    pos += c.length;
  }
  const head = Buffer.alloc(headerSize + ntoc * 12);
  head.write('Xcur', 0, 'ascii');
  head.writeUInt32LE(headerSize, 4);
  head.writeUInt32LE(0x00010000, 8);
  head.writeUInt32LE(ntoc, 12);
  tocs.forEach((t, i) => {
    head.writeUInt32LE(t[0], 16 + i * 12);
    head.writeUInt32LE(t[1], 20 + i * 12);
    head.writeUInt32LE(t[2], 24 + i * 12);
  });
  return Buffer.concat([head, ...chunks]);
}

// ---------- Minimal PNG (for the CSS snippet / icons) ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}

function pngFile(rgba, w, h) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

module.exports = { curImage, aniFile, xcursorFile, pngFile, scaleNearest };
