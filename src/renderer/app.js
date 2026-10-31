'use strict';
/* global cp */

const $ = (s) => document.querySelector(s);
const treeEl = $('#tree');
const gridEl = $('#grid');
const codeEl = $('#code');
const currentImg = $('#current-img');

let cats = [];
let rows = []; // flat list of visible tree rows for keyboard navigation
let selectedKey = null;
let currentId = null;
let platformName = '';
let applying = false;
let snippetSet = null; // { css, js } for the current cursor

const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem(k);
      return v === null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch { /* ignore */ }
  },
};
const openKeys = new Set(store.get('open', []));

const previewUrl = (id) => `cp://p/${encodeURIComponent(id)}`;

// ---------------- Tree ----------------
function findNode(key) {
  for (const c of cats) {
    if (c.k === key) return c;
    for (const ch of c.c) if (ch.k === key) return ch;
  }
  return null;
}

function makeRow(node, hasChildren) {
  const row = document.createElement('div');
  row.className = 'row';
  row.dataset.key = node.k;
  row.setAttribute('role', 'treeitem');
  if (hasChildren) {
    const box = document.createElement('span');
    box.className = 'box';
    box.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      toggle(node.k);
    });
    row.appendChild(box);
  }
  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = node.n;
  row.appendChild(label);
  label.addEventListener('mousedown', () => select(node.k));
  label.addEventListener('dblclick', () => hasChildren && toggle(node.k));
  return row;
}

function buildTree() {
  treeEl.textContent = '';
  for (const c of cats) {
    const n = document.createElement('div');
    n.className = 'node';
    n.dataset.key = c.k;
    if (openKeys.has(c.k)) n.classList.add('open');
    n.appendChild(makeRow(c, c.c.length > 0));
    const kids = document.createElement('div');
    kids.className = 'children';
    for (const ch of c.c) kids.appendChild(makeRow(ch, false));
    n.appendChild(kids);
    treeEl.appendChild(n);
  }
  refreshRows();
}

function refreshRows() {
  rows = [...treeEl.querySelectorAll('.row')].filter((r) => r.offsetParent !== null);
}

function toggle(key, force) {
  const n = treeEl.querySelector(`.node[data-key="${key}"]`);
  if (!n) return;
  const open = force === undefined ? !n.classList.contains('open') : force;
  n.classList.toggle('open', open);
  if (open) openKeys.add(key);
  else openKeys.delete(key);
  store.set('open', [...openKeys]);
  refreshRows();
  // If the selection got hidden inside a collapsed node, move it to the parent.
  if (!open && selectedKey && n.querySelector(`.children .row[data-key="${selectedKey}"]`)) select(key);
}

function select(key) {
  const node = findNode(key);
  if (!node) return;
  selectedKey = key;
  store.set('cat', key);
  for (const r of treeEl.querySelectorAll('.row.sel')) r.classList.remove('sel');
  const row = treeEl.querySelector(`.row[data-key="${key}"]`);
  if (row) {
    row.classList.add('sel');
    const top = row.offsetTop;
    if (top < treeEl.scrollTop) treeEl.scrollTop = top;
    else if (top + 18 > treeEl.scrollTop + treeEl.clientHeight) treeEl.scrollTop = top + 18 - treeEl.clientHeight;
  }
  renderGrid(node.i);
}

treeEl.addEventListener('keydown', (e) => {
  const idx = rows.findIndex((r) => r.dataset.key === selectedKey);
  const key = selectedKey;
  const isTop = cats.some((c) => c.k === key);
  if (e.key === 'ArrowDown' && idx < rows.length - 1) select(rows[idx + 1].dataset.key);
  else if (e.key === 'ArrowUp' && idx > 0) select(rows[idx - 1].dataset.key);
  else if (e.key === 'ArrowRight' && isTop) toggle(key, true);
  else if (e.key === 'ArrowLeft') {
    if (isTop) toggle(key, false);
    else {
      const parent = cats.find((c) => c.c.some((ch) => ch.k === key));
      if (parent) select(parent.k);
    }
  } else if (e.key === 'Enter' && isTop) toggle(key);
  else return;
  e.preventDefault();
});

// ---------------- Grid ----------------
function renderGrid(ids) {
  gridEl.textContent = '';
  gridEl.scrollTop = 0;
  if (!ids.length) {
    const p = document.createElement('div');
    p.className = 'empty';
    p.textContent = 'Pick a sub-category on the left.';
    gridEl.appendChild(p);
    return;
  }
  const frag = document.createDocumentFragment();
  for (const id of ids) {
    const cell = document.createElement('div');
    cell.className = 'cell';
    cell.dataset.id = id;
    cell.setAttribute('role', 'option');
    if (id === currentId) cell.classList.add('sel');
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.decoding = 'async';
    img.src = previewUrl(id);
    img.alt = '';
    img.draggable = false;
    cell.appendChild(img);
    frag.appendChild(cell);
  }
  gridEl.appendChild(frag);
}

gridEl.addEventListener('click', (e) => {
  const cell = e.target.closest('.cell');
  if (cell) applyCursor(cell.dataset.id, cell);
});

async function applyCursor(id, cell) {
  if (applying) return;
  applying = true;
  if (cell) cell.classList.add('busy');
  try {
    const res = await cp.apply(id);
    setCurrent(id, res.snippet);
    if (res.note) showDialog('Heads up', `<p>${escapeHtml(res.note)}</p>`);
  } catch (err) {
    showDialog('Couldn’t change your cursor', `<p>${escapeHtml(cleanErr(err))}</p>`);
  } finally {
    applying = false;
    if (cell) cell.classList.remove('busy');
  }
}

function setCurrent(id, snippets) {
  currentId = id;
  snippetSet = id ? snippets : null;
  for (const c of gridEl.querySelectorAll('.cell.sel')) c.classList.remove('sel');
  if (id) {
    const c = gridEl.querySelector(`.cell[data-id="${CSS.escape(id)}"]`);
    if (c) c.classList.add('sel');
    currentImg.src = previewUrl(id);
  } else {
    currentImg.removeAttribute('src');
  }
  showCode();
}

// ---------------- Copy as CSS / JS ----------------
// The box shows the format last copied; clicking CSS or JS switches to it and copies in one go.
let codeFormat = store.get('fmt', 'css') === 'js' ? 'js' : 'css';
function showCode() {
  for (const b of document.querySelectorAll('.fmt')) b.setAttribute('aria-pressed', String(b.dataset.fmt === codeFormat));
  codeEl.value = snippetSet ? snippetSet[codeFormat] || '' : '';
  codeEl.scrollTop = 0;
}
for (const b of document.querySelectorAll('.fmt')) {
  b.addEventListener('click', async () => {
    codeFormat = b.dataset.fmt;
    store.set('fmt', codeFormat);
    showCode();
    if (!codeEl.value) return;
    await cp.copy(codeEl.value);
    codeEl.select();
    b.classList.add('done');
    b.textContent = 'Copied!';
    clearTimeout(b._t);
    b._t = setTimeout(() => {
      b.classList.remove('done');
      b.textContent = b.dataset.label;
    }, 1400);
  });
}
showCode();

// ---------------- Buttons ----------------
$('#close').addEventListener('click', () => cp.close());

$('#btn-default').addEventListener('click', async () => {
  try {
    const res = await cp.restore();
    setCurrent(null);
    if (res && res.note) showDialog('Default Cursor', `<p>${escapeHtml(res.note)}</p>`);
  } catch (err) {
    showDialog('Couldn’t restore your cursor', `<p>${escapeHtml(cleanErr(err))}</p>`);
  }
});

$('#btn-friend').addEventListener('click', () => cp.mail());

$('#btn-new').addEventListener('click', () => {
  const total = new Set(cats.flatMap((c) => [...c.i, ...c.c.flatMap((ch) => ch.i)])).size;
  showDialog(
    'What’s New',
    `<h4>CursorPhreak 1.0</h4>
     <ul>
       <li>${total.toLocaleString()} classic cursors in ${cats.length} categories, rescued from the CursorMania archive.</li>
       <li>Works on Windows 10/11, macOS 12 and later (including Tahoe), Linux, FreeBSD and OpenBSD (GNOME, KDE Plasma, Xfce, Cinnamon, MATE, Hyprland, Sway and plain X11 window managers).</li>
       <li>Animated cursors stay animated.</li>
       <li>Old white-box cursors now have transparent backgrounds.</li>
       <li>No toolbar, no adware, no pop-ups. You're welcome.</li>
     </ul>`
  );
});

$('#btn-help').addEventListener('click', () => {
  const unix = (name) => `<h4>${name} notes</h4>
     <p>CursorPhreak makes a small cursor theme in <code>~/.icons</code> that only replaces the arrow and borrows every other pointer from your current theme. Some apps only pick up the new cursor after they're reopened.</p>`;
  const notes = {
    linux: unix('Linux'),
    freebsd: unix('FreeBSD'),
    openbsd: unix('OpenBSD'),
    netbsd: unix('NetBSD'),
    dragonfly: unix('DragonFly BSD'),
    win32: `<h4>Windows notes</h4>
     <p>Only the Normal Select arrow is replaced. Your other pointers (text, busy, resize, link) stay as they are.</p>`,
    darwin: `<h4>Mac notes</h4>
     <p>Only the arrow is replaced. macOS has no official way to change cursors, so CursorPhreak uses the same hidden system feature as the Mousecape app. A tiny background helper (listed as CursorPhreak under Login Items) puts your cursor back after you log in, wake the Mac, or plug in a display. <b>Default Cursor</b> removes the helper.</p>
     <p>Keep CursorPhreak in your Applications folder so the helper can find it.</p>`,
  };
  showDialog(
    'Help & Feedback',
    `<h4>Changing your cursor</h4>
     <p>Pick a category on the left, then click any cursor. Your mouse pointer changes right away and stays changed after a restart.</p>
     <h4>Going back to normal</h4>
     <p>Click <b>Default Cursor</b> to put back the pointer you had before.</p>
     <h4>Lefties</h4>
     <p>Cursors in the Lefties category point to the upper-right, for left-handed mousers.</p>
     ${notes[platformName] || ''}
     <h4>The code box</h4>
     <p>The code below the buttons makes the cursor you picked the mouse pointer on a web page, animation included. Click <b>CSS</b> to copy it for places that only allow styles (most profiles and blogs), or <b>JS</b> where scripts are allowed. Either way the cursor is built into the code itself, so nothing is loaded from another website.</p>`
  );
});

// ---------------- Dialog ----------------
function showDialog(title, html) {
  $('#dlg-title').textContent = title;
  $('#dlg-body').innerHTML = html;
  $('#modal').hidden = false;
  $('#dlg-ok').focus();
}
$('#dlg-ok').addEventListener('click', () => ($('#modal').hidden = true));
$('#modal').addEventListener('mousedown', (e) => {
  if (e.target.id === 'modal') $('#modal').hidden = true;
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#modal').hidden) $('#modal').hidden = true;
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
function cleanErr(err) {
  return String((err && err.message) || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

// What does this engine do for "CP Tahoma" bold?
//   real Tahoma Bold installed (Windows, macOS): glyphs much wider -> nothing to do
//   Chromium (Electron on Linux) synthesizes bold                  -> just tighten letter spacing
//   WebKitGTK (the BSD build) doesn't synthesize bold in page text -> thicken strokes with CSS
function boldMode() {
  const g = document.createElement('canvas').getContext('2d');
  g.font = '400 40px "CP Tahoma"';
  const reg = g.measureText('mmmmmmmmmm').width;
  g.font = '700 40px "CP Tahoma"';
  const bold = g.measureText('mmmmmmmmmm').width;
  if (bold - reg > 40) return 'real';
  return /Chrome\//.test(navigator.userAgent) ? 'synth-bold' : 'fake-bold';
}

// ---------------- Boot ----------------
(async function init() {
  const data = await cp.catalog();
  cats = data.cats;
  platformName = data.platform;
  await document.fonts.ready;
  const bold = boldMode();
  if (bold !== 'real') document.body.classList.add(bold);
  buildTree();
  const startKey = findNode(store.get('cat', '')) ? store.get('cat') : cats[0].k;
  // Make sure a remembered sub-category is visible.
  const parent = cats.find((c) => c.c.some((ch) => ch.k === startKey));
  if (parent) toggle(parent.k, true);
  select(startKey);
  if (data.current) {
    const snippet = await cp.snippet(data.current);
    setCurrent(data.current, snippet);
  }
  treeEl.focus();
})();
