'use strict';
// macOS cursor logic, independent of the native bindings so it can be tested with a fake `cgs`.
//
// The window server draws the arrow from a registered cursor named com.apple.coregraphics.Arrow.
// Since macOS 26 (Tahoe) it uses com.apple.coregraphics.ArrowS instead and ignores the old name,
// so we theme both (ArrowS only where the system has it). Before replacing anything we copy the
// original into a backup name inside the window server, and "Default Cursor" copies it back.

const { scaleNearest } = require('../encoders');

const ARROW_NAMES = ['com.apple.coregraphics.Arrow', 'com.apple.coregraphics.ArrowS'];
const BACKUP_PREFIX = 'app.cursorphreak.backup.';
const MAX_FRAMES = 24; // the window server refuses longer animations

function gcd(a, b) {
  while (b) [a, b] = [b, a % b];
  return a;
}

/**
 * macOS animates with a single frame duration and at most 24 frames, while GIFs have per-frame
 * delays. Re-time the animation onto a uniform clock, keeping its overall speed.
 */
function retime(frames, delaysMs, max = MAX_FRAMES) {
  if (frames.length === 1) return { frames, duration: 1.0 };
  const delays = delaysMs.map((d) => Math.max(20, Math.round(d / 10) * 10));
  const total = delays.reduce((a, b) => a + b, 0);
  const unit = delays.reduce(gcd);
  let out = [];
  let step;
  if (total / unit <= max) {
    step = unit;
    frames.forEach((f, i) => {
      for (let k = 0; k < delays[i] / unit; k++) out.push(f);
    });
  } else {
    // Too many ticks: sample the animation at `max` evenly spaced moments.
    step = total / max;
    const starts = [];
    let t = 0;
    for (const d of delays) {
      starts.push(t);
      t += d;
    }
    for (let i = 0; i < max; i++) {
      const at = (i + 0.5) * step;
      let idx = starts.length - 1;
      while (idx > 0 && starts[idx] > at) idx--;
      out.push(frames[idx]);
    }
  }
  if (out.length > max) out = out.slice(0, max);
  return { frames: out, duration: step / 1000 };
}

/** Stack frames vertically (Mousecape's cape layout) and premultiply alpha. */
function sprite(frames, w, h) {
  const out = Buffer.alloc(w * h * 4 * frames.length);
  frames.forEach((f, i) => {
    const base = i * w * h * 4;
    for (let p = 0; p < w * h; p++) {
      const a = f[p * 4 + 3];
      const o = base + p * 4;
      out[o] = Math.round((f[p * 4] * a) / 255);
      out[o + 1] = Math.round((f[p * 4 + 1] * a) / 255);
      out[o + 2] = Math.round((f[p * 4 + 2] * a) / 255);
      out[o + 3] = a;
    }
  });
  return out;
}

/** Turn a catalog cursor into what CGSRegisterCursorWithImages wants: 1x and 2x vertical strips. */
function prepare(cur) {
  const { frames, duration } = retime(cur.frames, cur.delays);
  const reps = [1, 2].map((s) => {
    const scaled = s === 1 ? frames : frames.map((f) => scaleNearest(f, cur.w, cur.h, s));
    return { width: cur.w * s, height: cur.h * s * frames.length, rgba: sprite(scaled, cur.w * s, cur.h * s) };
  });
  return {
    size: { width: cur.w, height: cur.h }, // in points
    hotspot: { x: cur.hx, y: cur.hy },
    frameCount: frames.length,
    frameDuration: duration,
    reps,
  };
}

function backup(cgs, name) {
  const b = BACKUP_PREFIX + name;
  if (!cgs.isRegistered(name) || cgs.isRegistered(b)) return;
  const c = cgs.copy(name);
  if (!c) return;
  try {
    cgs.register(b, c);
  } finally {
    cgs.release(c.images);
  }
}

/** Replace the system arrow with `cur`. Returns the names that were themed. */
function apply(cgs, cur) {
  const p = prepare(cur);
  const targets = ARROW_NAMES.filter((n, i) => i === 0 || cgs.isRegistered(n));
  for (const n of targets) backup(cgs, n);
  const arr = cgs.createImageArray(p.reps);
  try {
    for (const n of targets) cgs.register(n, { ...p, images: arr.array });
  } finally {
    cgs.releaseImageArray(arr);
  }
  cgs.refresh();
  return targets;
}

/** Put the original arrow back. Returns { restored: [...names], note? }. */
function restore(cgs) {
  const restored = [];
  for (const n of ARROW_NAMES) {
    const b = BACKUP_PREFIX + n;
    if (!cgs.isRegistered(b)) continue;
    const c = cgs.copy(b);
    if (!c) continue;
    try {
      cgs.register(n, c);
      restored.push(n);
    } finally {
      cgs.release(c.images);
    }
    cgs.remove(b);
  }
  let note;
  if (restored.length === 0) {
    cgs.resetCore();
    note = 'Your normal arrow will be fully back the next time you log in.';
  }
  cgs.refresh();
  return { restored, note };
}

module.exports = { apply, restore, prepare, retime, ARROW_NAMES, BACKUP_PREFIX, MAX_FRAMES };
