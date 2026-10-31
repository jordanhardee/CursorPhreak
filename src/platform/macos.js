'use strict';
// macOS: swap the system arrow through the window server's private cursor API (see macos-core.js),
// and install a small LaunchAgent that re-applies it at login and whenever macOS resets cursors
// (display changes, waking from sleep), because those registrations don't survive on their own.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const core = require('./macos-core');

const LABEL = 'app.cursorphreak.agent';

function xml(s) {
  return String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);
}

function launchctl(args) {
  try {
    execFileSync('/bin/launchctl', args, { stdio: 'ignore', timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

function create({ state, saveState, statePath, assetsDir, agentScript }) {
  const cgs = require('./macos-cgs').loadCgs();
  const home = os.homedir();
  const plistPath = path.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
  const domain = `gui/${process.getuid()}`;
  const translocated = process.execPath.includes('/AppTranslocation/');

  function agentPlist() {
    const args = [process.execPath, agentScript, assetsDir, statePath];
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${xml(a)}</string>`).join('\n')}
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>ELECTRON_RUN_AS_NODE</key><string>1</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
  <key>StandardErrorPath</key><string>${xml(path.join(home, 'Library', 'Logs', 'CursorPhreak-agent.log'))}</string>
</dict>
</plist>
`;
  }

  function installAgent() {
    const content = agentPlist();
    const current = fs.existsSync(plistPath) ? fs.readFileSync(plistPath, 'utf8') : null;
    const loaded = launchctl(['print', `${domain}/${LABEL}`]);
    if (current === content && loaded) return; // already running; it notices the new cursor itself
    fs.mkdirSync(path.dirname(plistPath), { recursive: true });
    fs.writeFileSync(plistPath, content);
    launchctl(['bootout', `${domain}/${LABEL}`]);
    if (!launchctl(['bootstrap', domain, plistPath])) launchctl(['load', '-w', plistPath]);
  }

  function removeAgent() {
    launchctl(['bootout', `${domain}/${LABEL}`]) || launchctl(['unload', plistPath]);
    fs.rmSync(plistPath, { force: true });
  }

  return {
    name: 'darwin',

    apply(cur) {
      const names = core.apply(cgs, cur);
      // Save before (re)starting the agent so it reads the new cursor, not the previous one.
      state.current = cur.id;
      saveState();
      let note;
      if (translocated) {
        note =
          'Your cursor changed, but it will reset when you log out because CursorPhreak is running from a temporary location. Drag CursorPhreak into your Applications folder, open it from there, and click the cursor again.';
      } else {
        try {
          installAgent();
        } catch (e) {
          note = `Your cursor changed, but CursorPhreak couldn't set itself up to keep it after a restart (${e.message}).`;
        }
      }
      return { names, note };
    },

    restore() {
      removeAgent(); // first, so it can't put the custom cursor back
      return core.restore(cgs);
    },
  };
}

module.exports = { create, LABEL };
