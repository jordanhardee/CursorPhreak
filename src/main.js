'use strict';

const { app, BrowserWindow, ipcMain, protocol, clipboard, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { Catalog } = require('./catalog');
const { snippets } = require('./snippets');

if (process.platform === 'linux' && process.getuid && process.getuid() === 0) {
  app.commandLine.appendSwitch('no-sandbox');
}

protocol.registerSchemesAsPrivileged([
  { scheme: 'cp', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

const assetsDir = app.isPackaged ? path.join(process.resourcesPath, 'assets') : path.join(__dirname, '..', 'assets');
let catalog;
let platform;
let state = {};
let statePath;

function loadState() {
  statePath = path.join(app.getPath('userData'), 'state.json');
  try {
    state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    state = {};
  }
}

function saveState() {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function loadPlatform() {
  const ctx = { dataDir: app.getPath('userData'), state, saveState, statePath, assetsDir };
  if (process.platform === 'win32') return require('./platform/windows').create(ctx);
  if (process.platform === 'linux') return require('./platform/linux').create(ctx);
  if (process.platform === 'darwin') {
    // The agent runs outside the asar archive (see asarUnpack in package.json).
    ctx.agentScript = app.isPackaged
      ? path.join(process.resourcesPath, 'app.asar.unpacked', 'src', 'mac-agent.js')
      : path.join(__dirname, 'mac-agent.js');
    return require('./platform/macos').create(ctx);
  }
  return {
    name: process.platform,
    apply() {
      throw new Error('Changing the system cursor is only supported on Windows, macOS and Linux.');
    },
    restore() {},
  };
}

function snippet(id) {
  return snippets(catalog.cursor(id)); // { css, js }, both self-contained
}

function createWindow() {
  const win = new BrowserWindow({
    width: 426,
    height: 530,
    useContentSize: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    frame: false,
    show: false,
    title: 'CursorPhreak',
    transparent: true, // lets the rounded window corners show through, like the original skin
    backgroundColor: '#00000000',
    hasShadow: true,
    icon: path.join(__dirname, 'renderer', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setMenu(null);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  if (!app.isPackaged && process.env.CP_SCREENSHOT) {
    // Dev-only: run optional JS in the page, capture the window, and exit (used for visual checks).
    win.webContents.once('did-finish-load', async () => {
      await new Promise((r) => setTimeout(r, 1500));
      if (process.env.CP_SCREENSHOT_JS) await win.webContents.executeJavaScript(process.env.CP_SCREENSHOT_JS);
      await new Promise((r) => setTimeout(r, 1200));
      const img = await win.webContents.capturePage();
      fs.writeFileSync(process.env.CP_SCREENSHOT, img.toPNG());
      app.quit();
    });
  }
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

const single = app.requestSingleInstanceLock();
if (!single) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const w = BrowserWindow.getAllWindows()[0];
    if (w) {
      if (w.isMinimized()) w.restore();
      w.focus();
    }
  });

  app.whenReady().then(() => {
    loadState();
    catalog = new Catalog(assetsDir);
    platform = loadPlatform();

    protocol.handle('cp', (req) => {
      const u = new URL(req.url);
      const id = decodeURIComponent(u.pathname.replace(/^\//, ''));
      const p = u.host === 'p' ? catalog.preview(id) : null;
      if (!p) return new Response('not found', { status: 404 });
      return new Response(p.data, { headers: { 'content-type': p.mime, 'cache-control': 'max-age=31536000' } });
    });

    const favorites = () => (Array.isArray(state.favorites) ? state.favorites : []).filter((id) => catalog.has(id));
    ipcMain.handle('catalog', () => ({
      cats: catalog.tree(),
      current: state.current || null,
      favorites: favorites(),
      platform: platform.name,
    }));
    // Newest favorite first. Returns the updated list.
    ipcMain.handle('favorite', (_e, id, on) => {
      if (!catalog.has(id)) throw new Error('Unknown cursor');
      const list = favorites().filter((x) => x !== id);
      if (on) list.unshift(id);
      state.favorites = list;
      saveState();
      return list;
    });
    ipcMain.handle('apply', (_e, id) => {
      if (!catalog.has(id)) throw new Error('Unknown cursor');
      const res = platform.apply(catalog.cursor(id));
      state.current = id;
      saveState();
      return { ok: true, ...res, snippet: snippet(id) };
    });
    ipcMain.handle('restore', () => {
      const res = platform.restore() || {};
      delete state.current;
      saveState();
      return { ok: true, ...res };
    });
    ipcMain.handle('snippet', (_e, id) => (catalog.has(id) ? snippet(id) : null));
    ipcMain.handle('copy', (_e, text) => {
      clipboard.writeText(String(text));
      return true;
    });
    ipcMain.handle('mail', () =>
      shell.openExternal(
        'mailto:?subject=' +
          encodeURIComponent('Check out CursorPhreak!') +
          '&body=' +
          encodeURIComponent('I just found CursorPhreak: over 11,000 classic CursorMania cursors for Windows, Mac, Linux and BSD. One click and your mouse pointer is a sparkly rainbow arrow (or a pig, or a pizza).')
      )
    );
    ipcMain.on('close', () => app.quit());
    ipcMain.on('minimize', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize());

    createWindow();
  });

  app.on('window-all-closed', () => app.quit());
}
