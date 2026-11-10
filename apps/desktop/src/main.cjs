'use strict';
// LAN Detective desktop app.
//
//  - Dashboard window: the LAN Detective web app, loaded from the configured server.
//    It is remote content, so it runs sandboxed with no preload and no desktop access.
//  - Collector panel: a local page that manages the bundled lan-collector program on this computer.
//  - Tray icon: the collector keeps monitoring while the windows are closed.
//  - Local mode (running from a source checkout, no remote server configured): opening the app starts
//    LAN Detective itself on this computer (database, API, web app), signs in with a local account,
//    asks once to scan the home network, enrolls this computer's collector and shows the dashboard.
const { app, BrowserWindow, Menu, Tray, ipcMain, shell, nativeImage, dialog, safeStorage, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { CollectorManager } = require('./collector-manager.cjs');
const { LocalStack, findRepoRoot, findNode, signIn, homeNetwork, enrollThisComputer } = require('./local-stack.cjs');

const SMOKE = process.argv.includes('--smoke');
// Non-interactive check of local mode: consent comes from LD_DESKTOP_AUTO_CONSENT=1, then it reports and quits.
const LOCAL_SMOKE = process.argv.includes('--local-smoke');
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
const repoRoot = app.isPackaged ? null : findRepoRoot(__dirname);
/** Installed app: the packaged database/API/web server (apps/desktop/scripts/bundle-backend.mjs). */
const bundleDir = app.isPackaged ? path.join(process.resourcesPath, 'backend') : null;
const hasBundle = Boolean(bundleDir && fs.existsSync(path.join(bundleDir, 'local.mjs')));
/** @type {LocalStack | null} */
let localStack = null;
/** @type {{ webUrl: string, apiUrl: string } | null} */
let localUrls = null;
let localMode = false;
let localShown = false;

function collectorBinary() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'collector', BINARY_NAME)
    : path.join(__dirname, '..', '..', '..', 'collectors', 'lan-collector', 'bin', BINARY_NAME);
}

function serverOrigin() {
  if (localMode) return localUrls ? new URL(localUrls.webUrl).origin : null;
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
    show: !SMOKE && !LOCAL_SMOKE,
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
  if (!origin && !localMode) return showPanel(); // first run: ask for the server address
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
    show: !SMOKE && !LOCAL_SMOKE,
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
    if (!isMainFrame || code === -3 || !origin) return; // -3 = navigation aborted (normal)
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
  void contents.loadURL(origin && (!localMode || localShown) ? origin : splashUrl('Starting LAN Detective…'));
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
  await localStack?.stop().catch(() => undefined);
  app.quit();
}

// ── local mode ───────────────────────────────────────────────────────────────
function splashUrl(message, error = false) {
  const esc = (t) => String(t).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
  const spinner = error
    ? ''
    : '<div class="spin"></div><style>.spin{width:28px;height:28px;margin:0 auto 16px;border:3px solid #22406e;border-top-color:#4f8cff;border-radius:50%;animation:s 1s linear infinite}@keyframes s{to{transform:rotate(360deg)}}@media (prefers-reduced-motion:reduce){.spin{animation:none}}</style>';
  const html = `<!doctype html><meta charset="utf-8"><title>LAN Detective</title>
<body style="margin:0;height:100vh;display:grid;place-items:center;background:#070d1a;color:#e6edf7;font:15px system-ui,'Segoe UI',sans-serif">
<div style="text-align:center;max-width:520px;padding:24px">
<div style="font-size:22px;font-weight:600;margin-bottom:16px">LAN Detective</div>${spinner}
<div style="color:${error ? '#ff8a8a' : '#9fb0c8'};white-space:pre-line">${esc(message)}</div></div></body>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}
function setSplash(message, error = false) {
  if (dashboard && !localShown) void dashboard.webContents.loadURL(splashUrl(message, error));
}

/** The local account's password is random and kept encrypted with the OS keychain (DPAPI on Windows). */
function accountStore() {
  const file = path.join(app.getPath('userData'), 'local-account.bin');
  return {
    load() {
      try {
        const raw = fs.readFileSync(file);
        return JSON.parse(safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(raw) : raw.toString('utf8'));
      } catch {
        return null;
      }
    },
    save(account) {
      const text = JSON.stringify(account);
      fs.writeFileSync(file, safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(text) : text, { mode: 0o600 });
    },
  };
}

async function askToScan(net) {
  if (LOCAL_SMOKE) return process.env.LD_DESKTOP_AUTO_CONSENT === '1';
  const { response } = await dialog.showMessageBox(dashboard ?? undefined, {
    type: 'question',
    title: 'LAN Detective',
    message: `Scan your network ${net.cidr}?\nفحص شبكتك ${net.cidr}؟`,
    detail:
      `This computer is connected to ${net.cidr} (${net.iface}). LAN Detective will discover and monitor the devices on it from this computer.\n\n` +
      'Only continue if this is your own network or you are allowed to scan it.\nتابع فقط إذا كانت هذه شبكتك أو مسموح لك بفحصها.',
    buttons: ['Scan my network / افحص شبكتي', 'Not now / ليس الآن'],
    defaultId: 0,
    cancelId: 1,
  });
  return response === 0;
}

async function startLocal() {
  showDashboard();
  if (hasBundle) {
    // Installed: Electron's own Node runs everything; data lives in the user's profile.
    localStack = new LocalStack({
      script: path.join(bundleDir, 'local.mjs'),
      nodePath: process.execPath,
      env: { ELECTRON_RUN_AS_NODE: '1', LD_BUNDLE_DIR: bundleDir, LD_DATA_DIR: path.join(app.getPath('userData'), 'data') },
      onStatus: (m) => setSplash(m),
    });
  } else {
    const nodePath = findNode();
    if (!nodePath) {
      setSplash('Node.js 24 or newer is needed to run LAN Detective from source.\nInstall it from nodejs.org, then open the app again.', true);
      return;
    }
    localStack = new LocalStack({ script: path.join(repoRoot, 'scripts', 'local.mjs'), nodePath, onStatus: (m) => setSplash(m) });
  }
  try {
    localUrls = await localStack.start();
    setSplash('Signing in…');
    // A collector identity issued by some other server is useless here: forget it and set up again.
    if (collector.isEnrolled() && collector.settings.serverUrl && collector.settings.serverUrl !== localUrls.apiUrl) await collector.resetIdentity();
    const store = accountStore();
    let api = null;
    // Sign in automatically with the app's own account. If this computer was set up from the command
    // line with a personal account instead, the person signs in with that account themselves.
    if (store.load() || !collector.isEnrolled()) {
      api = (await signIn(localUrls.apiUrl, localUrls.webUrl, store)).api;
      await session.fromPartition('persist:dashboard').cookies.set({
        url: localUrls.webUrl,
        name: 'ld_session',
        value: api.session(),
        httpOnly: true,
        sameSite: 'lax',
        expirationDate: Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
      });
    }
    if (collector.binaryAvailable()) {
      if (collector.isEnrolled()) {
        if (collector.settings.serverUrl !== localUrls.apiUrl) await collector.saveSettings({ ...collector.settings, serverUrl: localUrls.apiUrl });
        collector.start();
      } else if (api) {
        const net = await homeNetwork();
        if (net?.private && (await askToScan(net))) {
          setSplash(`Setting up scanning of ${net.cidr}…`);
          const token = await enrollThisComputer(api, net.cidr);
          await collector.saveSettings({ serverUrl: localUrls.apiUrl, allowedCidrs: [net.cidr], autoStart: true });
          collector.start({ enrollmentToken: token });
        }
      }
    }
    localShown = true;
    if (!dashboard) showDashboard();
    else await dashboard.webContents.loadURL(localUrls.webUrl);
  } catch (err) {
    setSplash(`LAN Detective could not start:\n${err.message}`, true);
  }
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
    collector = new CollectorManager({
      binaryPath: collectorBinary(),
      // In a source checkout the collector identity is shared with `pnpm local`.
      dataDir: repoRoot ? path.join(repoRoot, '.data', 'collector') : path.join(app.getPath('userData'), 'collector'),
    });
    const configured = collector.settings.serverUrl;
    localMode = Boolean(repoRoot || hasBundle) && !SMOKE && (!configured || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(configured));
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

    if (localMode) {
      void startLocal().then(() => {
        if (!LOCAL_SMOKE) return;
        // Give the first discovery sweep time to finish, then report what the app shows and quit.
        setTimeout(async () => {
          const cookies = await session.fromPartition('persist:dashboard').cookies.get({ name: 'ld_session' });
          const title = await dashboard?.webContents.executeJavaScript('document.title').catch(() => null);
          const state = collector.getState();
          console.log(JSON.stringify({ localSmoke: 'ok', localUrls, page: dashboard?.webContents.getURL(), title, signedIn: cookies.length > 0, enrolled: state.enrolled, collector: state.status, lastSweep: state.lastSweep, lastError: state.lastError }));
          await quit();
        }, 30_000);
      });
      return;
    }
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
