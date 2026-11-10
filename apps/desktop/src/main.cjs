'use strict';
// LAN Detective desktop app.
//
//  - Dashboard window: the LAN Detective web app, loaded from the configured server.
//    It is remote content, so it runs sandboxed with no preload and no desktop access.
//  - Collector panel: a local page that manages the bundled lan-collector program on this computer.
//  - Tray icon: the collector keeps monitoring while the windows are closed.
const { app, BrowserWindow, Menu, Tray, ipcMain, shell, nativeImage, dialog } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { CollectorManager } = require('./collector-manager.cjs');

const SMOKE = process.argv.includes('--smoke');
const PANEL_FILE = path.join(__dirname, 'panel', 'index.html');
const PANEL_URL = pathToFileURL(PANEL_FILE).href;
const ICON = path.join(__dirname, '..', 'assets', 'icon.png');
const BINARY_NAME = process.platform === 'win32' ? 'lan-collector.exe' : 'lan-collector';

let dashboard = null;
let panel = null;
let tray = null;
let quitting = false;
/** @type {CollectorManager} */
let collector;

function collectorBinary() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'collector', BINARY_NAME)
    : path.join(__dirname, '..', '..', '..', 'collectors', 'lan-collector', 'bin', BINARY_NAME);
}

function serverOrigin() {
  try {
    return new URL(collector.settings.serverUrl).origin;
  } catch {
    return null;
  }
}

function showPanel() {
  if (panel) {
    panel.show();
    panel.focus();
    return panel;
  }
  panel = new BrowserWindow({
    width: 760,
    height: 780,
    minWidth: 520,
    minHeight: 560,
    title: 'LAN Detective — Collector',
    backgroundColor: '#070d1a',
    icon: ICON,
    autoHideMenuBar: true,
    show: !SMOKE,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  // The panel is a single local file. It never navigates anywhere else.
  panel.webContents.on('will-navigate', (event) => event.preventDefault());
  panel.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  panel.on('closed', () => (panel = null));
  void panel.loadFile(PANEL_FILE);
  return panel;
}

function showDashboard() {
  const origin = serverOrigin();
  if (!origin) return showPanel(); // first run: ask for the server address
  if (dashboard) {
    dashboard.show();
    dashboard.focus();
    return dashboard;
  }
  dashboard = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 420,
    minHeight: 600,
    title: 'LAN Detective',
    backgroundColor: '#070d1a',
    icon: ICON,
    autoHideMenuBar: true,
    show: !SMOKE,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, partition: 'persist:dashboard' },
  });
  const contents = dashboard.webContents;
  // Stay on the configured server. Anything else opens in the user's own browser (https only).
  const external = (url) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
  };
  contents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== serverOrigin()) {
      event.preventDefault();
      external(url);
    }
  });
  contents.setWindowOpenHandler(({ url }) => {
    external(url);
    return { action: 'deny' };
  });
  contents.session.setPermissionRequestHandler((_wc, permission, callback) => callback(permission === 'clipboard-sanitized-write'));
  contents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3 = navigation aborted (normal)
    void dialog
      .showMessageBox(dashboard, {
        type: 'warning',
        title: 'LAN Detective',
        message: 'Cannot reach the LAN Detective server',
        detail: `${origin}\n${description}\n\nThe local collector keeps monitoring and will upload its results when the server is reachable again.`,
        buttons: ['Try again', 'Server settings', 'Close'],
        defaultId: 0,
      })
      .then(({ response }) => {
        if (response === 0) void contents.loadURL(origin);
        if (response === 1) showPanel();
      });
  });
  dashboard.on('close', (event) => {
    // Closing the window keeps the app (and the collector) alive in the tray.
    if (!quitting && tray) {
      event.preventDefault();
      dashboard.hide();
    }
  });
  dashboard.on('closed', () => (dashboard = null));
  void contents.loadURL(origin);
  return dashboard;
}

function refreshTray() {
  if (!tray) return;
  const state = collector.getState();
  const running = state.status === 'running' || state.status === 'starting';
  const summary = !state.enrolled ? 'Collector: not enrolled' : running ? (state.connected === false ? 'Collector: running, server unreachable' : 'Collector: running') : 'Collector: stopped';
  tray.setToolTip(`LAN Detective\n${summary}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open dashboard', click: () => showDashboard() },
      { label: 'Collector on this computer…', click: () => showPanel() },
      { type: 'separator' },
      { label: summary, enabled: false },
      running
        ? { label: 'Stop collector', click: () => void collector.stop() }
        : { label: 'Start collector', enabled: state.enrolled && Boolean(state.settings.serverUrl), click: () => tryStart() },
      { type: 'separator' },
      { label: 'Quit LAN Detective', click: () => quit() },
    ]),
  );
}

function tryStart(token) {
  try {
    return collector.start(token ? { enrollmentToken: token } : {});
  } catch (err) {
    collector.lastError = err.message;
    collector.emitState();
    throw err;
  }
}

async function quit() {
  quitting = true;
  await collector.stop().catch(() => undefined);
  app.quit();
}

/** IPC is accepted only from the local panel page. */
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, payload) => {
    if (event.senderFrame?.url !== PANEL_URL) throw new Error('not allowed');
    return fn(payload);
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showDashboard());
  app.on('window-all-closed', () => {
    /* keep running in the tray */
  });

  app.whenReady().then(() => {
    app.setAppUserModelId('com.landetective.desktop');
    collector = new CollectorManager({ binaryPath: collectorBinary(), dataDir: path.join(app.getPath('userData'), 'collector') });
    collector.on('state', (state) => {
      panel?.webContents.send('collector:state-changed', state);
      refreshTray();
    });

    handle('collector:state', () => collector.getState());
    handle('collector:save-settings', (settings) => collector.saveSettings(settings ?? {}));
    handle('collector:start', (token) => tryStart(typeof token === 'string' ? token : ''));
    handle('collector:stop', () => collector.stop());
    handle('collector:reset', () => collector.resetIdentity());
    handle('app:open-dashboard', () => {
      // The server address may have changed: reload the dashboard on the new origin.
      if (dashboard && serverOrigin() && new URL(dashboard.webContents.getURL() || 'about:blank').origin !== serverOrigin()) {
        void dashboard.webContents.loadURL(serverOrigin());
      }
      showDashboard();
    });

    const image = nativeImage.createFromPath(ICON);
    tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image.resize({ width: 16, height: 16 }));
    tray.on('double-click', () => showDashboard());
    refreshTray();

    const { settings, enrolled } = collector.getState();
    if (settings.serverUrl && enrolled && settings.autoStart) {
      try {
        collector.start();
      } catch {
        /* shown in the panel */
      }
    }
    showDashboard();

    if (SMOKE) {
      // Start-up self-check used by `pnpm smoke`: prints what the app sees, then exits.
      setTimeout(async () => {
        const state = collector.getState();
        console.log(JSON.stringify({ smoke: 'ok', binaryAvailable: state.binaryAvailable, enrolled: state.enrolled, status: state.status, hasServer: Boolean(state.settings.serverUrl), windows: BrowserWindow.getAllWindows().length, tray: Boolean(tray) }));
        await quit();
      }, 2500);
    }
  });
}
