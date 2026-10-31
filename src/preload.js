'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cp', {
  catalog: () => ipcRenderer.invoke('catalog'),
  apply: (id) => ipcRenderer.invoke('apply', id),
  restore: () => ipcRenderer.invoke('restore'),
  snippet: (id) => ipcRenderer.invoke('snippet', id),
  copy: (text) => ipcRenderer.invoke('copy', text),
  mail: () => ipcRenderer.invoke('mail'),
  close: () => ipcRenderer.send('close'),
  minimize: () => ipcRenderer.send('minimize'),
});
