'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desktop', {
  current: () => ipcRenderer.invoke('server:get'),
  save: (address) => ipcRenderer.invoke('server:set', address),
});
