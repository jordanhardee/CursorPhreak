'use strict';
// Thin koffi bindings to the (private) CoreGraphics / SkyLight cursor API that the window server
// uses for system cursors. This is the same mechanism Mousecape uses. Only loaded on macOS.

const koffi = require('koffi');

const FW = '/System/Library/Frameworks';
const CG_PATH = `${FW}/CoreGraphics.framework/CoreGraphics`;
const CF_PATH = `${FW}/CoreFoundation.framework/CoreFoundation`;
const SKYLIGHT_PATH = '/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight';

const kCFStringEncodingUTF8 = 0x08000100;
const kCGImageAlphaPremultipliedLast = 1;
const kCGBitmapByteOrder32Big = 4 << 12;
const kCGDisplayBeginConfigurationFlag = 1;

let cached = null;

function loadCgs() {
  if (cached) return cached;

  const CGSize = koffi.struct('CGSize', { width: 'double', height: 'double' });
  const CGPoint = koffi.struct('CGPoint', { x: 'double', y: 'double' });
  void CGSize;
  void CGPoint;

  // CP_FAKE_MACOS_LIB lets tools/test_macos.js swap in a stand-in library on Linux.
  const fake = process.env.CP_FAKE_MACOS_LIB;
  const cg = koffi.load(fake || CG_PATH);
  const cf = fake ? cg : koffi.load(CF_PATH);
  let sky = null;
  try {
    sky = fake ? null : koffi.load(SKYLIGHT_PATH);
  } catch { /* older systems: everything lives in CoreGraphics */ }

  // Private functions: try the CoreGraphics name first, then SkyLight's CGS/SLS names.
  function priv(proto, { optional = false } = {}) {
    const m = proto.match(/^\s*[\w\s*]+?\b(CGS|Core)(\w+)\s*\(/);
    const name = m ? m[1] + m[2] : null;
    const candidates = [[cg, proto]];
    if (sky) {
      candidates.push([sky, proto]);
      if (name && name.startsWith('CGS')) candidates.push([sky, proto.replace(name, 'SLS' + name.slice(3))]);
    }
    for (const [lib, p] of candidates) {
      try {
        return lib.func(p);
      } catch { /* try next */ }
    }
    if (optional) return null;
    throw new Error(`macOS cursor API not found: ${name}`);
  }

  const api = {
    mainConnection: priv('int CGSMainConnectionID()'),
    register: priv(
      'int CGSRegisterCursorWithImages(int cid, const char *name, bool setGlobally, bool instantly, CGSize size, CGPoint hotspot, size_t frameCount, double frameDuration, void *images, _Out_ int *seed)'
    ),
    copyImages: priv(
      'int CGSCopyRegisteredCursorImages(int cid, const char *name, _Out_ CGSize *size, _Out_ CGPoint *hotspot, _Out_ size_t *frameCount, _Out_ double *frameDuration, _Out_ void **images)'
    ),
    dataSize: priv('int CGSGetRegisteredCursorDataSize(int cid, const char *name, _Out_ size_t *size)'),
    remove: priv('int CGSRemoveRegisteredCursor(int cid, const char *name, bool flag)', { optional: true }),
    coreUnregisterAll: priv('int CoreCursorUnregisterAll(int cid)', { optional: true }),
    coreSet: priv('int CoreCursorSet(int cid, int cursor)', { optional: true }),
    getScale: priv('int CGSGetCursorScale(int cid, _Out_ float *scale)', { optional: true }),
    setScale: priv('int CGSSetCursorScale(int cid, float scale)', { optional: true }),

    CFRelease: cf.func('void CFRelease(void *ref)'),
    CFDataCreate: cf.func('void *CFDataCreate(void *alloc, const uint8_t *bytes, long length)'),
    CFArrayCreate: cf.func('void *CFArrayCreate(void *alloc, void **values, long count, void *callbacks)'),
    CFArrayGetCount: cf.func('long CFArrayGetCount(void *array)'),
    CFStringCreateWithCString: cf.func('void *CFStringCreateWithCString(void *alloc, const char *str, uint32_t encoding)'),
    CFRunLoopGetCurrent: cf.func('void *CFRunLoopGetCurrent()'),
    CFRunLoopRun: cf.func('void CFRunLoopRun()'),
    CFAbsoluteTimeGetCurrent: cf.func('double CFAbsoluteTimeGetCurrent()'),
    CFRunLoopAddTimer: cf.func('void CFRunLoopAddTimer(void *rl, void *timer, void *mode)'),

    CGColorSpaceCreateWithName: cg.func('void *CGColorSpaceCreateWithName(void *name)'),
    CGColorSpaceCreateDeviceRGB: cg.func('void *CGColorSpaceCreateDeviceRGB()'),
    CGDataProviderCreateWithCFData: cg.func('void *CGDataProviderCreateWithCFData(void *data)'),
    CGImageCreate: cg.func(
      'void *CGImageCreate(size_t width, size_t height, size_t bpc, size_t bpp, size_t bpr, void *space, uint32_t bitmapInfo, void *provider, const double *decode, bool interpolate, int intent)'
    ),
  };

  const TimerCallback = koffi.proto('void CPTimerCallback(void *timer, void *info)');
  const ReconfigCallback = koffi.proto('void CPReconfigCallback(uint32_t display, uint32_t flags, void *info)');
  api.CFRunLoopTimerCreate = cf.func(
    'void *CFRunLoopTimerCreate(void *alloc, double fireDate, double interval, uint64_t flags, long order, CPTimerCallback *callout, void *context)'
  );
  api.CGDisplayRegisterReconfigurationCallback = cg.func(
    'int CGDisplayRegisterReconfigurationCallback(CPReconfigCallback *cb, void *info)'
  );

  const cid = api.mainConnection();
  const cfstr = (s) => api.CFStringCreateWithCString(null, s, kCFStringEncodingUTF8);
  let colorSpace = null;
  function srgb() {
    if (colorSpace) return colorSpace;
    const name = cfstr('kCGColorSpaceSRGB'); // CG compares names by value
    colorSpace = api.CGColorSpaceCreateWithName(name) || api.CGColorSpaceCreateDeviceRGB();
    return colorSpace;
  }
  const keep = []; // keep JS callbacks alive for the life of the process

  cached = {
    isRegistered(name) {
      const out = [0];
      const err = api.dataSize(cid, name, out);
      return err === 0 && Number(out[0]) > 0;
    },
    registeredSize(name) {
      const out = [0];
      return api.dataSize(cid, name, out) === 0 ? Number(out[0]) : -1;
    },
    /** Returns { images (CFArrayRef, caller releases), size, hotspot, frameCount, frameDuration } or null. */
    copy(name) {
      const size = {};
      const hot = {};
      const frames = [0];
      const dur = [0];
      const imgs = [null];
      const err = api.copyImages(cid, name, size, hot, frames, dur, imgs);
      if (err !== 0 || !imgs[0] || api.CFArrayGetCount(imgs[0]) < 1) {
        if (imgs[0]) api.CFRelease(imgs[0]);
        return null;
      }
      return { images: imgs[0], size, hotspot: hot, frameCount: Number(frames[0]), frameDuration: dur[0] };
    },
    register(name, c) {
      const seed = [0];
      const err = api.register(cid, name, true, true, c.size, c.hotspot, c.frameCount, c.frameDuration, c.images, seed);
      if (err !== 0) throw new Error(`macOS refused the cursor for ${name} (CGError ${err}).`);
    },
    remove(name) {
      if (api.remove) api.remove(cid, name, false);
    },
    /** reps: [{ width, height, rgba (premultiplied RGBA Buffer) }] -> CFArrayRef of CGImages */
    createImageArray(reps) {
      const images = reps.map((r) => {
        const data = api.CFDataCreate(null, r.rgba, r.rgba.length);
        const provider = api.CGDataProviderCreateWithCFData(data);
        const img = api.CGImageCreate(
          r.width, r.height, 8, 32, r.width * 4, srgb(),
          kCGImageAlphaPremultipliedLast | kCGBitmapByteOrder32Big, provider, null, false, 0
        );
        api.CFRelease(provider);
        api.CFRelease(data);
        if (!img) throw new Error('Could not create cursor image');
        return img;
      });
      // No callbacks: the array does not retain the images, so they're released in releaseImageArray.
      const array = api.CFArrayCreate(null, images, images.length, null);
      return { array, images };
    },
    releaseImageArray({ array, images }) {
      api.CFRelease(array);
      for (const i of images) api.CFRelease(i);
    },
    release(ref) {
      if (ref) api.CFRelease(ref);
    },
    resetCore() {
      if (api.coreUnregisterAll) api.coreUnregisterAll(cid);
      if (api.coreSet) api.coreSet(cid, 0);
    },
    /** Wiggle the cursor scale so the window server redraws the pointer right away (as Mousecape does). */
    refresh() {
      if (!api.getScale || !api.setScale) return;
      const s = [1];
      if (api.getScale(cid, s) !== 0) return;
      const scale = s[0] > 0 ? s[0] : 1;
      api.setScale(cid, scale + 0.3);
      api.setScale(cid, scale);
    },

    // ---- run loop helpers for the background agent ----
    onDisplayReconfigured(fn) {
      const cb = koffi.register((display, flags) => {
        if (flags & kCGDisplayBeginConfigurationFlag) return;
        fn();
      }, koffi.pointer(ReconfigCallback));
      keep.push(cb);
      api.CGDisplayRegisterReconfigurationCallback(cb, null);
    },
    every(seconds, fn) {
      const cb = koffi.register(() => fn(), koffi.pointer(TimerCallback));
      keep.push(cb);
      const timer = api.CFRunLoopTimerCreate(null, api.CFAbsoluteTimeGetCurrent() + seconds, seconds, 0, 0, cb, null);
      api.CFRunLoopAddTimer(api.CFRunLoopGetCurrent(), timer, cfstr('kCFRunLoopDefaultMode'));
    },
    runForever() {
      api.CFRunLoopRun();
    },
  };
  return cached;
}

module.exports = { loadCgs };
