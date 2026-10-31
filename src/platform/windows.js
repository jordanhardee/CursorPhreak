'use strict';
// Windows: write the cursor as .cur/.ani, point HKCU\Control Panel\Cursors\Arrow at it,
// then ask Windows to reload the cursor scheme (SPI_SETCURSORS). Persists across reboots.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { curImage, aniFile } = require('../encoders');

const REG_KEY = 'HKCU\\Control Panel\\Cursors';
const SPI_SETCURSORS = 0x0057;
const SPIF_UPDATEINIFILE = 0x01;
const SPIF_SENDCHANGE = 0x02;

const OCR_NORMAL = 32512;

let native = null;
function nativeApi() {
  if (native !== null) return native;
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    const spi = user32.func('__stdcall', 'SystemParametersInfoW', 'bool', ['uint32', 'uint32', 'void *', 'uint32']);
    const load = user32.func('__stdcall', 'LoadCursorFromFileW', 'void *', ['str16']);
    const setSys = user32.func('__stdcall', 'SetSystemCursor', 'bool', ['void *', 'uint32']);
    native = {
      reloadScheme: () => spi(SPI_SETCURSORS, 0, null, SPIF_UPDATEINIFILE | SPIF_SENDCHANGE),
      setArrowFromFile: (file) => {
        const h = load(file);
        return h ? setSys(h, OCR_NORMAL) : false; // SetSystemCursor takes ownership of h
      },
    };
  } catch (e) {
    console.warn('koffi unavailable, falling back to PowerShell:', e.message);
    native = false;
  }
  return native;
}

function powershell(script) {
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    windowsHide: true,
  });
}

/**
 * Make Windows pick up the new Arrow value right now. The registry write already makes it permanent.
 * Primary: reload the whole cursor scheme from the registry. Fallback: load the file and swap the arrow directly.
 */
function reloadCursors(file) {
  const api = nativeApi();
  if (api) {
    if (api.reloadScheme()) return;
    if (file && api.setArrowFromFile(file)) return;
    throw new Error('Windows refused to reload the cursor (SystemParametersInfo and SetSystemCursor both failed).');
  }
  powershell(
    'Add-Type -Namespace CP -Name U -MemberDefinition \'[DllImport("user32.dll")] public static extern bool SystemParametersInfo(uint a, uint b, System.IntPtr c, uint d);\'; ' +
      `[void][CP.U]::SystemParametersInfo(${SPI_SETCURSORS}, 0, [System.IntPtr]::Zero, ${SPIF_UPDATEINIFILE | SPIF_SENDCHANGE})`
  );
}

function regQuery(name) {
  try {
    const out = execFileSync('reg.exe', ['query', REG_KEY, '/v', name], { windowsHide: true, encoding: 'utf8' });
    const line = out.split(/\r?\n/).find((l) => l.trim().toLowerCase().startsWith(name.toLowerCase() + ' '));
    if (!line) return '';
    const m = line.match(/REG_(?:EXPAND_)?SZ\s+(.*)$/);
    return m ? m[1].trim() : '';
  } catch {
    return '';
  }
}

function regSet(name, value) {
  execFileSync('reg.exe', ['add', REG_KEY, '/v', name, '/t', 'REG_EXPAND_SZ', '/d', value, '/f'], { windowsHide: true });
}

function create({ dataDir, state, saveState }) {
  const cursorDir = path.join(dataDir, 'cursors');

  return {
    name: 'windows',

    apply(cur) {
      fs.mkdirSync(cursorDir, { recursive: true });
      const animated = cur.frames.length > 1;
      const safeId = cur.id.replace(/[^A-Za-z0-9_-]/g, '_');
      const file = path.join(cursorDir, `cp_${safeId}.${animated ? 'ani' : 'cur'}`);
      const data = animated
        ? aniFile(cur.frames, cur.delays, cur.w, cur.h, cur.hx, cur.hy, `CursorPhreak ${cur.id}`)
        : curImage(cur.frames[0], cur.w, cur.h, cur.hx, cur.hy);
      fs.writeFileSync(file, data);

      if (state.win === undefined) {
        // Remember what the user had before we touched anything, so "Default Cursor" can restore it.
        let original = regQuery('Arrow');
        if (original.toLowerCase().includes(cursorDir.toLowerCase())) original = ''; // state was lost; fall back to the system default
        state.win = { originalArrow: original };
        saveState();
      }
      regSet('Arrow', file);
      reloadCursors(file);

      // Keep the cursors folder tidy: only the active cursor's file is needed.
      for (const f of fs.readdirSync(cursorDir)) {
        if (path.join(cursorDir, f) !== file) {
          try { fs.unlinkSync(path.join(cursorDir, f)); } catch { /* in use; next time */ }
        }
      }
      return { file };
    },

    restore() {
      const original = state.win ? state.win.originalArrow : '';
      regSet('Arrow', original || '');
      const expanded = (original || '').replace(/%([^%]+)%/g, (m, v) => process.env[v] || m);
      delete state.win;
      saveState();
      let note;
      try {
        reloadCursors(expanded && fs.existsSync(expanded) ? expanded : null);
      } catch {
        note = 'Your normal arrow is restored. Windows will show it the next time you sign in.';
      }
      try { fs.rmSync(cursorDir, { recursive: true, force: true }); } catch { /* still in use */ }
      return { note };
    },
  };
}

module.exports = { create };
