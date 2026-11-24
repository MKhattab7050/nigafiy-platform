'use strict';
// Bridge for the program chooser window (src/chooser/index.html): two calls, nothing else.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nigafiyPrograms', {
  load: () => ipcRenderer.invoke('programs:load'),
  save: (ids) => ipcRenderer.invoke('programs:save', Array.isArray(ids) ? ids.map(String) : []),
  close: () => ipcRenderer.invoke('programs:close'),
});
