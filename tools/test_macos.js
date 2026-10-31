'use strict';
// Exercises the macOS cursor code on Linux against tools/fake_macos.c (a stand-in for the private
// CoreGraphics API that records and checks every call).
//   gcc -shared -fPIC -o /tmp/fake_macos.so tools/fake_macos.c
//   node tools/test_macos.js /tmp/fake_macos.so
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const [libPath, mode] = process.argv.slice(2);
if (!libPath) throw new Error('usage: test_macos.js <fake_macos.so> [scenario]');

function fake() {
  const koffi = require('koffi');
  const lib = koffi.load(libPath);
  return {
    seed: lib.func('void fake_seed(const char *name, int w, int h, int frames)'),
    report: () => JSON.parse(lib.func('const char *fake_report()')()),
  };
}

function scenario(name) {
  process.env.CP_FAKE_MACOS_LIB = libPath;
  const { Catalog } = require(path.join(root, 'src/catalog'));
  const core = require(path.join(root, 'src/platform/macos-core'));
  const { loadCgs } = require(path.join(root, 'src/platform/macos-cgs'));
  const catalog = new Catalog(path.join(root, 'assets'));
  const f = fake();
  const ARROW = 'com.apple.coregraphics.Arrow';
  const ARROWS = 'com.apple.coregraphics.ArrowS';
  const B = core.BACKUP_PREFIX;
  const byName = (r, n) => r.reg.find((e) => e.name === n);

  if (name === 'classic' || name === 'tahoe') {
    f.seed(ARROW, 24, 24, 1);
    if (name === 'tahoe') f.seed(ARROWS, 24, 24, 1);
    const cgs = loadCgs();

    // 1) animated cursor
    const anim = catalog.cursor('11967a');
    const themed = core.apply(cgs, anim);
    let r = f.report();
    assert.strictEqual(r.errors, '', r.errors);
    assert.deepStrictEqual(themed, name === 'tahoe' ? [ARROW, ARROWS] : [ARROW]);
    const a = byName(r, ARROW);
    assert.ok(a.frames >= 2 && a.frames <= 24, `frames ${a.frames}`);
    assert.deepStrictEqual(a.size, [32, 32]);
    assert.deepStrictEqual(a.hot, [anim.hx, anim.hy]);
    assert.deepStrictEqual(a.reps.map((x) => x.slice(0, 2)), [[32, 32 * a.frames], [64, 64 * a.frames]]);
    assert.ok(a.dur > 0 && a.dur < 1, `duration ${a.dur}`);
    assert.strictEqual(byName(r, B + ARROW).reps[0][2], 0xab, 'original arrow backed up');
    assert.strictEqual(!!byName(r, ARROWS), name === 'tahoe', 'ArrowS only themed where it exists');
    if (name === 'tahoe') assert.strictEqual(byName(r, B + ARROWS).reps[0][2], 0xab);
    assert.deepStrictEqual(r.live, { data: 0, array: 0, image: 0, provider: 0 }, 'no leaked CF objects');
    assert.ok(r.scaleSets >= 2 && Math.abs(r.lastScale - 1) < 1e-6, 'refresh wiggles and restores scale');

    // 2) static cursor on top: backup must still be the original
    core.apply(cgs, catalog.cursor('216'));
    r = f.report();
    assert.strictEqual(byName(r, ARROW).frames, 1);
    assert.strictEqual(byName(r, B + ARROW).reps[0][2], 0xab, 'backup not overwritten');

    // 3) restore
    let res = core.restore(cgs);
    r = f.report();
    assert.strictEqual(r.errors, '', r.errors);
    assert.deepStrictEqual(res.restored, name === 'tahoe' ? [ARROW, ARROWS] : [ARROW]);
    assert.strictEqual(byName(r, ARROW).reps[0][2], 0xab, 'original arrow is back');
    assert.deepStrictEqual(byName(r, ARROW).hot, [4, 5]);
    assert.ok(!byName(r, B + ARROW), 'backup removed');
    assert.deepStrictEqual(r.live, { data: 0, array: 0, image: 0, provider: 0 }, 'no leaked CF objects');

    // 4) restore with nothing to restore
    res = core.restore(cgs);
    assert.ok(res.note && f.report().coreResets === 1);
    console.log(`  ${name}: apply/apply/restore/restore OK — ${a.frames} frames @ ${(a.dur * 1000).toFixed(1)}ms`);
    return;
  }
  throw new Error('unknown scenario ' + name);
}

function retimeTests() {
  const { retime } = require(path.join(root, 'src/platform/macos-core'));
  const F = (n) => Array.from({ length: n }, (_, i) => `f${i}`);
  let r = retime(F(3), [100, 100, 100]);
  assert.deepStrictEqual([r.frames, r.duration], [['f0', 'f1', 'f2'], 0.1]);
  r = retime(F(2), [100, 200]);
  assert.deepStrictEqual([r.frames, r.duration], [['f0', 'f1', 'f1'], 0.1]);
  r = retime(F(12), [2000, ...Array(11).fill(150)]);
  assert.strictEqual(r.frames.length, 24);
  assert.ok(Math.abs(r.duration * 24 - 3.65) < 1e-9, 'total animation time preserved');
  assert.strictEqual(r.frames.filter((x) => x === 'f0').length, 13, 'long first frame keeps its share');
  r = retime(F(30), Array(30).fill(100));
  assert.strictEqual(r.frames.length, 24);
  r = retime(['only'], [100]);
  assert.deepStrictEqual(r.frames, ['only']);
  // every cursor in the catalog fits the 24-frame limit
  const { Catalog } = require(path.join(root, 'src/catalog'));
  const c = new Catalog(path.join(root, 'assets'));
  let worst = 0;
  for (const id of Object.keys(c.cursors)) {
    const e = c.cursors[id];
    if (e[5] < 2) continue;
    const t = retime(Array(e[5]).fill(0), e[8]);
    worst = Math.max(worst, t.frames.length);
    assert.ok(t.frames.length <= 24 && t.duration > 0);
  }
  console.log(`  retime OK (all ${Object.keys(c.cursors).length} cursors fit, max ${worst} frames)`);
}

function agentTest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-agent-'));
  const statePath = path.join(dir, 'state.json');
  // the agent logs to stderr; capture it via a wrapper
  const runCapture = () => {
    try {
      const out = execFileSync('sh', ['-c', `"${process.execPath}" "${path.join(root, 'src/mac-agent.js')}" "${path.join(root, 'assets')}" "${statePath}" 2>&1`], {
        env: { ...process.env, CP_FAKE_MACOS_LIB: libPath },
        encoding: 'utf8',
      });
      return { code: 0, out };
    } catch (e) {
      return { code: e.status, out: e.stdout };
    }
  };
  fs.writeFileSync(statePath, JSON.stringify({ current: '11967a' }));
  let r = runCapture();
  const lines = r.out.trim().split('\n').map((l) => l.replace(/^\S+ /, ''));
  assert.deepStrictEqual(lines, ['applied 11967a (login)', 'applied 11967a (display change)', 'applied 11967a (check)'], r.out);
  fs.writeFileSync(statePath, JSON.stringify({}));
  r = runCapture();
  assert.strictEqual(r.code, 0);
  assert.match(r.out, /no cursor selected/);
  console.log('  agent OK (applies at login, after display change, after window-server reset; exits when restored)');
}

if (mode) {
  scenario(mode);
} else {
  console.log('macOS cursor code vs. fake window server:');
  for (const s of ['classic', 'tahoe']) {
    process.stdout.write(execFileSync(process.execPath, [__filename, libPath, s], { encoding: 'utf8' }));
  }
  retimeTests();
  agentTest();
  console.log('ALL MACOS TESTS PASSED');
}
