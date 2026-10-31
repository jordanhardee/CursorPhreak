// Stand-in for the macOS CoreGraphics/CoreFoundation/SkyLight functions CursorPhreak calls, so the
// koffi bindings can be exercised on Linux. Acts as an in-memory "window server" cursor registry
// and checks every argument it receives. Build: gcc -shared -fPIC -o fake_macos.so fake_macos.c
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct { double width, height; } CGSize;
typedef struct { double x, y; } CGPoint;
enum { T_DATA = 1, T_ARRAY, T_STRING, T_IMAGE, T_PROVIDER, T_SPACE };
typedef struct { int type; int refs; } Obj;
typedef struct { Obj o; uint8_t *bytes; long len; } Data;
typedef struct { Obj o; void **vals; long n; int owns; } Array;
typedef struct { Obj o; char *s; } String;
typedef struct { Obj o; Data *data; } Provider;
typedef struct { Obj o; size_t w, h; uint32_t info; uint8_t *px; size_t len; } Image;

static int live[8];
static char errors[4096];
static void fail(const char *m) { strncat(errors, m, sizeof(errors) - strlen(errors) - 2); strcat(errors, ";"); }
static void *mk(int type, size_t sz) { Obj *o = calloc(1, sz); o->type = type; o->refs = 1; live[type]++; return o; }

void CFRelease(void *p) {
  if (!p) { fail("CFRelease(NULL)"); return; }
  Obj *o = p;
  if (o->refs <= 0) { fail("over-release"); return; }
  if (--o->refs == 0) {
    live[o->type]--;
    if (o->type == T_PROVIDER) CFRelease(((Provider *)o)->data);
    if (o->type == T_ARRAY) { Array *a = (Array *)o; if (a->owns) for (long i = 0; i < a->n; i++) CFRelease(a->vals[i]); free(a->vals); }
  }
}
void *CFDataCreate(void *a, const uint8_t *b, long n) { Data *d = mk(T_DATA, sizeof *d); d->bytes = malloc(n); memcpy(d->bytes, b, n); d->len = n; return d; }
void *CFArrayCreate(void *a, void **v, long n, void *cb) {
  Array *r = mk(T_ARRAY, sizeof *r); r->vals = malloc(sizeof(void *) * (n ? n : 1)); r->n = n;
  for (long i = 0; i < n; i++) { r->vals[i] = v[i]; if (!v[i] || ((Obj *)v[i])->type != T_IMAGE) fail("array item is not an image"); }
  if (cb) ((void)0); // callbacks NULL in our use
  return r;
}
long CFArrayGetCount(void *a) { return ((Array *)a)->n; }
void *CFStringCreateWithCString(void *a, const char *s, uint32_t enc) { if (enc != 0x08000100) fail("bad encoding"); String *r = mk(T_STRING, sizeof *r); r->s = strdup(s); return r; }
void *CGColorSpaceCreateWithName(void *name) { if (strcmp(((String *)name)->s, "kCGColorSpaceSRGB")) fail("bad colorspace name"); return mk(T_SPACE, sizeof(Obj)); }
void *CGColorSpaceCreateDeviceRGB(void) { return mk(T_SPACE, sizeof(Obj)); }
void *CGDataProviderCreateWithCFData(void *d) { Provider *p = mk(T_PROVIDER, sizeof *p); p->data = d; ((Obj *)d)->refs++; return p; }
void *CGImageCreate(size_t w, size_t h, size_t bpc, size_t bpp, size_t bpr, void *cs, uint32_t info, void *prov, const double *dec, bool interp, int intent) {
  Provider *p = prov;
  if (bpc != 8 || bpp != 32 || bpr != w * 4) fail("bad image geometry");
  if ((size_t)p->data->len != bpr * h) fail("image data length mismatch");
  if (info != (1 | (4 << 12))) fail("bad bitmap info");
  if (!cs) fail("no colorspace");
  Image *im = mk(T_IMAGE, sizeof *im); im->w = w; im->h = h; im->info = info;
  im->len = p->data->len; im->px = malloc(im->len); memcpy(im->px, p->data->bytes, im->len);
  return im;
}

// ---- cursor registry ----
typedef struct { char name[200]; CGSize size; CGPoint hot; size_t frames; double dur; int n; size_t w[4], h[4]; uint8_t *px[4]; size_t len[4]; } Entry;
static Entry reg[32]; static int nreg;
static int scaleSets; static float lastScale = 1.0f; static int coreResets;
static Entry *find(const char *n) { for (int i = 0; i < nreg; i++) if (!strcmp(reg[i].name, n)) return &reg[i]; return NULL; }

int CGSMainConnectionID(void) { return 42; }
int CGSRegisterCursorWithImages(int cid, const char *name, bool global, bool instant, CGSize size, CGPoint hot, size_t fc, double fd, void *images, int *seed) {
  if (cid != 42) fail("bad connection id");
  if (!global || !instant) fail("expected global+instant");
  if (fc < 1 || fc > 24) return 1000;
  Array *a = images;
  if (!a || a->o.type != T_ARRAY || a->n < 1 || a->n > 4) { fail("bad image array"); return 1000; }
  Entry *e = find(name); if (!e) { e = &reg[nreg++]; memset(e, 0, sizeof *e); strncpy(e->name, name, 199); }
  e->size = size; e->hot = hot; e->frames = fc; e->dur = fd; e->n = (int)a->n;
  for (int i = 0; i < a->n; i++) {
    Image *im = a->vals[i];
    if (im->h % fc) fail("image height not a multiple of frame count");
    e->w[i] = im->w; e->h[i] = im->h; e->len[i] = im->len; e->px[i] = malloc(im->len); memcpy(e->px[i], im->px, im->len);
  }
  if (seed) *seed = 7;
  return 0;
}
int CGSCopyRegisteredCursorImages(int cid, const char *name, CGSize *size, CGPoint *hot, size_t *fc, double *fd, void **out) {
  Entry *e = find(name); if (!e) return 1000;
  *size = e->size; *hot = e->hot; *fc = e->frames; *fd = e->dur;
  void *vals[4];
  for (int i = 0; i < e->n; i++) {
    Image *im = mk(T_IMAGE, sizeof *im); im->w = e->w[i]; im->h = e->h[i]; im->len = e->len[i]; im->px = malloc(im->len); memcpy(im->px, e->px[i], im->len); vals[i] = im;
  }
  Array *a = CFArrayCreate(NULL, vals, e->n, NULL);
  a->owns = 1; // like kCFTypeArrayCallBacks: releasing the array releases the images
  *out = a; return 0;
}
int CGSGetRegisteredCursorDataSize(int cid, const char *name, size_t *size) {
  Entry *e = find(name); if (!e) { *size = 0; return 1000; }
  size_t s = 0; for (int i = 0; i < e->n; i++) s += e->len[i]; *size = s; return 0;
}
int CGSRemoveRegisteredCursor(int cid, const char *name, bool f) {
  for (int i = 0; i < nreg; i++) if (!strcmp(reg[i].name, name)) { reg[i] = reg[--nreg]; return 0; }
  return 1000;
}
int CoreCursorUnregisterAll(int cid) { coreResets++; return 0; }
int CoreCursorSet(int cid, int n) { return 0; }
int CGSGetCursorScale(int cid, float *s) { *s = lastScale; return 0; }
int CGSSetCursorScale(int cid, float s) { lastScale = s; scaleSets++; return 0; }

// ---- run loop ----
typedef void (*TimerCb)(void *, void *);
typedef void (*ReconfCb)(uint32_t, uint32_t, void *);
static TimerCb timerCb; static ReconfCb reconfCb; static double timerInterval;
void *CFRunLoopGetCurrent(void) { return (void *)0x1; }
double CFAbsoluteTimeGetCurrent(void) { return 1000.0; }
void *CFRunLoopTimerCreate(void *a, double fire, double interval, uint64_t flags, long order, TimerCb cb, void *ctx) { timerCb = cb; timerInterval = interval; if (fire != 1000.0 + interval) fail("bad fire date"); return mk(T_DATA, sizeof(Data)); }
void CFRunLoopAddTimer(void *rl, void *t, void *mode) { if (strcmp(((String *)mode)->s, "kCFRunLoopDefaultMode")) fail("bad run loop mode"); }
int CGDisplayRegisterReconfigurationCallback(ReconfCb cb, void *info) { reconfCb = cb; return 0; }
// Simulate: a display change (begin + end), then the window server dropping our cursor, then two timer ticks.
void CFRunLoopRun(void) {
  if (reconfCb) { reconfCb(1, 1, NULL); reconfCb(1, 0x10, NULL); }
  Entry *e = find("com.apple.coregraphics.Arrow"); if (e && e->n) { e->n = 1; e->len[0] /= 2; } // "reset" by window server
  if (timerCb) { timerCb(NULL, NULL); timerCb(NULL, NULL); }
}

// ---- test helpers ----
void fake_seed(const char *name, int w, int h, int frames) {
  Entry *e = &reg[nreg++]; memset(e, 0, sizeof *e); strncpy(e->name, name, 199);
  e->size.width = w; e->size.height = h; e->hot.x = 4; e->hot.y = 5; e->frames = frames; e->dur = 0.5; e->n = 1;
  e->w[0] = w; e->h[0] = h * frames; e->len[0] = (size_t)w * h * frames * 4; e->px[0] = calloc(1, e->len[0]); e->px[0][3] = 0xAB;
}
const char *fake_report(void) {
  static char buf[16384]; int o = 0;
  o += snprintf(buf + o, sizeof buf - o, "{\"errors\":\"%s\",\"live\":{\"data\":%d,\"array\":%d,\"image\":%d,\"provider\":%d},\"scaleSets\":%d,\"lastScale\":%.2f,\"coreResets\":%d,\"timerInterval\":%.1f,\"reg\":[",
                errors, live[T_DATA], live[T_ARRAY], live[T_IMAGE], live[T_PROVIDER], scaleSets, lastScale, coreResets, timerInterval);
  for (int i = 0; i < nreg; i++) {
    Entry *e = &reg[i];
    o += snprintf(buf + o, sizeof buf - o, "%s{\"name\":\"%s\",\"size\":[%g,%g],\"hot\":[%g,%g],\"frames\":%zu,\"dur\":%g,\"reps\":[", i ? "," : "", e->name, e->size.width, e->size.height, e->hot.x, e->hot.y, e->frames, e->dur);
    for (int j = 0; j < e->n; j++) o += snprintf(buf + o, sizeof buf - o, "%s[%zu,%zu,%u]", j ? "," : "", e->w[j], e->h[j], e->px[j][3]);
    o += snprintf(buf + o, sizeof buf - o, "]}");
  }
  snprintf(buf + o, sizeof buf - o, "]}");
  return buf;
}
