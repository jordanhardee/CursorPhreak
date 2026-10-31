'use strict';
// Linux: build a tiny Xcursor theme that only overrides the arrow and inherits everything else
// from the user's current theme, then switch the desktop to it. Two theme slots (A/B) are used
// alternately, because desktops only reload cursors when the theme *name* changes.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { xcursorFile } = require('../encoders');

const THEME_PREFIX = 'CursorPhreak';
const ARROW_NAMES = ['left_ptr', 'default', 'arrow', 'top_left_arrow', 'left-arrow'];

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 8000 }).trim();
  } catch {
    return null;
  }
}

function has(cmd) {
  return run('sh', ['-c', `command -v ${cmd}`]) ? true : false;
}

function desktop() {
  return `${process.env.XDG_CURRENT_DESKTOP || ''}:${process.env.DESKTOP_SESSION || ''}`.toLowerCase();
}

function unquote(s) {
  return s ? s.replace(/^'(.*)'$/, '$1').trim() : s;
}

function cursorSize() {
  const g = has('gsettings') && run('gsettings', ['get', 'org.gnome.desktop.interface', 'cursor-size']);
  const n = parseInt(g || process.env.XCURSOR_SIZE || '24', 10);
  return Number.isFinite(n) && n > 0 ? n : 24;
}

function iconDirs() {
  const home = os.homedir();
  const dataHome = process.env.XDG_DATA_HOME || path.join(home, '.local/share');
  const dataDirs = (process.env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':');
  return [path.join(home, '.icons'), path.join(dataHome, 'icons'), ...dataDirs.map((d) => path.join(d, 'icons')), '/usr/share/pixmaps'];
}

function themeExists(name) {
  return iconDirs().some((d) => fs.existsSync(path.join(d, name, 'cursors')) || fs.existsSync(path.join(d, name, 'index.theme')));
}

function readIni(file, key) {
  try {
    const m = fs.readFileSync(file, 'utf8').match(new RegExp(`^\\s*${key}\\s*=\\s*(.+)$`, 'm'));
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

function detectCurrentTheme() {
  const d = desktop();
  const home = os.homedir();
  const candidates = [];
  if (d.includes('kde') || d.includes('plasma')) {
    candidates.push(run('kreadconfig6', ['--file', 'kcminputrc', '--group', 'Mouse', '--key', 'cursorTheme']));
    candidates.push(run('kreadconfig5', ['--file', 'kcminputrc', '--group', 'Mouse', '--key', 'cursorTheme']));
    candidates.push(readIni(path.join(home, '.config/kcminputrc'), 'cursorTheme'));
  }
  if (d.includes('xfce')) candidates.push(run('xfconf-query', ['-c', 'xsettings', '-p', '/Gtk/CursorThemeName']));
  if (d.includes('cinnamon')) candidates.push(unquote(run('gsettings', ['get', 'org.cinnamon.desktop.interface', 'cursor-theme'])));
  if (d.includes('mate')) candidates.push(unquote(run('gsettings', ['get', 'org.mate.peripherals-mouse', 'cursor-theme'])));
  if (has('gsettings')) candidates.push(unquote(run('gsettings', ['get', 'org.gnome.desktop.interface', 'cursor-theme'])));
  candidates.push(process.env.XCURSOR_THEME);
  candidates.push(readIni(path.join(home, '.icons/default/index.theme'), 'Inherits'));
  candidates.push(readIni(path.join(home, '.config/gtk-3.0/settings.ini'), 'gtk-cursor-theme-name'));
  for (const c of candidates) {
    if (c && !c.startsWith(THEME_PREFIX)) return c;
  }
  for (const fallback of ['Adwaita', 'breeze_cursors', 'DMZ-White', 'default']) {
    if (themeExists(fallback)) return fallback;
  }
  return 'Adwaita';
}

/** Switch every desktop setting we know about to `theme`. Returns the list of mechanisms that worked. */
function setTheme(theme, size) {
  const d = desktop();
  const done = [];
  const tryRun = (label, cmd, args) => {
    if (has(cmd) && run(cmd, args) !== null) done.push(label);
  };

  if (d.includes('kde') || d.includes('plasma')) {
    tryRun('plasma', 'plasma-apply-cursortheme', [theme]);
    if (!done.includes('plasma')) {
      tryRun('kwriteconfig6', 'kwriteconfig6', ['--file', 'kcminputrc', '--group', 'Mouse', '--key', 'cursorTheme', theme]);
      tryRun('kwriteconfig5', 'kwriteconfig5', ['--file', 'kcminputrc', '--group', 'Mouse', '--key', 'cursorTheme', theme]);
    }
  }
  if (d.includes('xfce')) {
    tryRun('xfconf', 'xfconf-query', ['-c', 'xsettings', '-p', '/Gtk/CursorThemeName', '-s', theme]);
  }
  if (d.includes('cinnamon')) {
    tryRun('cinnamon', 'gsettings', ['set', 'org.cinnamon.desktop.interface', 'cursor-theme', theme]);
  }
  if (d.includes('mate')) {
    tryRun('mate', 'gsettings', ['set', 'org.mate.peripherals-mouse', 'cursor-theme', theme]);
  }
  if (d.includes('hyprland') || process.env.HYPRLAND_INSTANCE_SIGNATURE) {
    tryRun('hyprland', 'hyprctl', ['setcursor', theme, String(size)]);
  }
  if (d.includes('sway') || process.env.SWAYSOCK) {
    tryRun('sway', 'swaymsg', ['seat', '*', 'xcursor_theme', theme, String(size)]);
  }
  // GNOME, Budgie, Pantheon, Unity, COSMIC, and GTK apps everywhere read this key.
  tryRun('gnome', 'gsettings', ['set', 'org.gnome.desktop.interface', 'cursor-theme', theme]);
  return done;
}

function create({ state, saveState }) {
  const home = os.homedir();
  const iconsRoot = path.join(home, '.icons');
  const defaultIndex = path.join(iconsRoot, 'default', 'index.theme');

  function writeTheme(slot, cur, base) {
    const name = `${THEME_PREFIX}-${slot}`;
    const dir = path.join(iconsRoot, name);
    const cdir = path.join(dir, 'cursors');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(cdir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'index.theme'),
      `[Icon Theme]\nName=${name}\nComment=CursorPhreak cursor ${cur.id} (over ${base})\nInherits=${base}\n`
    );
    fs.writeFileSync(path.join(cdir, ARROW_NAMES[0]), xcursorFile(cur.frames, cur.delays, cur.w, cur.h, cur.hx, cur.hy, [2, 1]));
    for (const alias of ARROW_NAMES.slice(1)) fs.symlinkSync(ARROW_NAMES[0], path.join(cdir, alias));
    return name;
  }

  return {
    name: 'linux',

    apply(cur) {
      if (!state.linux) {
        state.linux = { baseTheme: detectCurrentTheme(), slot: 'B' };
      }
      const base = state.linux.baseTheme;
      const slot = state.linux.slot === 'A' ? 'B' : 'A';
      const theme = writeTheme(slot, cur, base);
      const size = cursorSize();
      const used = setTheme(theme, size);

      const gnomeLike = /gnome|unity|budgie|pantheon|cosmic|ubuntu|pop|deepin|kde|plasma|xfce|cinnamon|mate|hyprland|sway/.test(desktop());
      const effective = used.filter((u) => u !== 'gnome' || gnomeLike);
      if (effective.length === 0) {
        // Bare X11 window manager: make it the default theme and update the root window.
        if (!state.linux.touchedDefaultIndex) {
          state.linux.touchedDefaultIndex = true;
          state.linux.previousDefaultIndex = fs.existsSync(defaultIndex) ? fs.readFileSync(defaultIndex, 'utf8') : null;
        }
        fs.mkdirSync(path.dirname(defaultIndex), { recursive: true });
        fs.writeFileSync(defaultIndex, `[Icon Theme]\nInherits=${theme}\n`);
        if (has('xsetroot')) run('xsetroot', ['-xcf', path.join(iconsRoot, theme, 'cursors', 'left_ptr'), String(size)]);
        used.push('x11-default');
      }

      // The desktop now points at the new slot, so the old one can go. (Already-drawn cursors live in the
      // display server's memory; anything that re-reads the old name just falls back to the base theme.)
      state.linux.slot = slot;
      saveState();
      fs.rmSync(path.join(iconsRoot, `${THEME_PREFIX}-${slot === 'A' ? 'B' : 'A'}`), { recursive: true, force: true });
      return { theme, base, via: used };
    },

    restore() {
      if (!state.linux) return;
      const { baseTheme, touchedDefaultIndex, previousDefaultIndex } = state.linux;
      setTheme(baseTheme, cursorSize());
      if (touchedDefaultIndex) {
        if (previousDefaultIndex === null || previousDefaultIndex === undefined) fs.rmSync(defaultIndex, { force: true });
        else fs.writeFileSync(defaultIndex, previousDefaultIndex);
        if (has('xsetroot')) run('xsetroot', ['-cursor_name', 'left_ptr']);
      }
      delete state.linux;
      saveState();
      for (const s of ['A', 'B']) fs.rmSync(path.join(iconsRoot, `${THEME_PREFIX}-${s}`), { recursive: true, force: true });
      try {
        fs.rmdirSync(path.dirname(defaultIndex)); // only succeeds if we left it empty
      } catch { /* not empty or not ours */ }
    },
  };
}

module.exports = { create, detectCurrentTheme };
