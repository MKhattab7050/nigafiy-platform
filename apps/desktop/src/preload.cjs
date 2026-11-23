'use strict';
// Loaded ONLY into the local "Collector" panel — never into the dashboard window, which shows
// remote content and gets no access to the desktop at all.
const { contextBridge, ipcRenderer } = require('electron');

const subscribe = (channel) => (handler) => {
  const listener = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('desktop', {
  getState: () => ipcRenderer.invoke('collector:state'),
  getEngineState: () => ipcRenderer.invoke('engine:state'),
  saveSettings: (settings) => ipcRenderer.invoke('collector:save-settings', settings),
  start: (enrollmentToken) => ipcRenderer.invoke('collector:start', enrollmentToken),
  stop: () => ipcRenderer.invoke('collector:stop'),
  resetIdentity: () => ipcRenderer.invoke('collector:reset'),
  setupLocalScan: () => ipcRenderer.invoke('local:setup-scan'),
  resetScanPrompt: () => ipcRenderer.invoke('local:reset-scan-prompt'),
  openDashboard: () => ipcRenderer.invoke('app:open-dashboard'),
  onState: subscribe('collector:state-changed'),
});
