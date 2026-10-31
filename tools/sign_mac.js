'use strict';
// Ad-hoc sign the macOS app bundles produced by `electron-builder --mac` and zip them.
// Apple Silicon refuses to run unsigned code, and electron-builder can't sign on Linux, so we use
// rcodesign (https://github.com/indygreg/apple-platform-rs), which runs anywhere.
// Without an Apple Developer ID the app isn't notarized: first launch needs
// System Settings → Privacy & Security → "Open Anyway".
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const pkg = require('../package.json');
const dist = path.join(__dirname, '..', 'dist');
const dirs = { 'mac-arm64': 'arm64', mac: 'x64' };

for (const [dir, arch] of Object.entries(dirs)) {
  const app = path.join(dist, dir, `${pkg.productName}.app`);
  if (!fs.existsSync(app)) continue;
  console.log(`signing ${arch}…`);
  execFileSync('rcodesign', ['sign', app], { stdio: ['ignore', 'ignore', 'inherit'] });
  const zip = path.join(dist, `${pkg.productName}-${pkg.version}-mac-${arch}.zip`);
  fs.rmSync(zip, { force: true });
  // -y keeps the framework symlinks intact (Finder's Archive Utility restores them)
  execFileSync('zip', ['-qry', zip, `${pkg.productName}.app`], { cwd: path.dirname(app) });
  console.log(`  ${path.basename(zip)} (${(fs.statSync(zip).size / 1e6).toFixed(0)} MB)`);
}
