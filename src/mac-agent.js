'use strict';
// CursorPhreak background agent for macOS. launchd starts it at login (the app binary running in
// plain Node mode, so there's no window or Dock icon). It applies the chosen cursor, then sleeps in
// a CoreFoundation run loop and re-applies whenever the displays reconfigure (wake, monitor plugged
// in, resolution change) or the window server has otherwise dropped our cursor.
// Usage: CursorPhreak mac-agent.js <assetsDir> <state.json>

const fs = require('fs');
const { Catalog } = require('./catalog');
const { loadCgs } = require('./platform/macos-cgs');
const core = require('./platform/macos-core');

const [assetsDir, statePath] = process.argv.slice(2);
const log = (...a) => console.error(new Date().toISOString(), ...a);

function readState() {
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return {};
  }
}

const cgs = loadCgs();
const catalog = new Catalog(assetsDir);
let appliedId = null;
let expectedSize = null;

function sync(force, why) {
  const st = readState();
  if (!st.current || !catalog.has(st.current)) {
    log('no cursor selected any more; exiting');
    process.exit(0); // launchd won't restart a clean exit
  }
  const size = cgs.registeredSize(core.ARROW_NAMES[0]);
  if (!force && st.current === appliedId && size === expectedSize) return;
  try {
    core.apply(cgs, catalog.cursor(st.current));
    appliedId = st.current;
    expectedSize = cgs.registeredSize(core.ARROW_NAMES[0]);
    log(`applied ${st.current} (${why})`);
  } catch (e) {
    log('apply failed:', e.message);
  }
}

sync(true, 'login');
cgs.onDisplayReconfigured(() => sync(true, 'display change'));
cgs.every(20, () => sync(false, 'check'));
cgs.runForever();
