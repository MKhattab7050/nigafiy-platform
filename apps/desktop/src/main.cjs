'use strict';
// Nigafiy desktop app.
//
//  - Dashboard window: the Nigafiy web app, loaded from the configured server.
//    It is remote content, so it runs sandboxed with no preload and no desktop access.
//  - Collector panel: a local page that manages the Sensor on this computer (`nigafiy-engine sensor`).
//  - Tray icon: the collector keeps monitoring while the windows are closed.
//  - Local mode (running from a source checkout, no remote server configured): opening the app starts
//    Nigafiy itself on this computer (database, API, web app), signs in with a local account,
//    asks once to scan the home network, enrolls this computer's collector and shows the dashboard.
//  - Nigafiy programs (src/programs.cjs): one window per program, each with its own taskbar identity
//    (AppUserModelID Nigafiy.<Program>). `--program=<id>` picks the window a launch opens, and
//    `nigafiy://<program>/<path>` links open that program's window on the path. The protocol is
//    registered only by a packaged build, never from a source checkout or a test run.
const { app, BrowserWindow, Menu, Tray, ipcMain, shell, nativeImage, dialog, safeStorage, session, powerMonitor, powerSaveBlocker } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { CollectorManager, isLocalServerUrl } = require('./collector-manager.cjs');
const { LocalStack, findRepoRoot, findNode, signIn, homeNetwork, enrollThisComputer } = require('./local-stack.cjs');
const { EngineStack, summarizeEngine } = require('./engine-stack.cjs');
const { trayLine: updateTrayLine, noticeFor: updateNoticeFor, CHECK_EVERY_MS: UPDATE_CHECK_MS } = require('./update-notice.cjs');
const { readEnv } = require('./env-compat.cjs');
const { CHOICES, readInstallSettings, selectedIds, writePrograms } = require('./install-settings.cjs');
const { MOVE_FLAG, findLegacyInstalls, moveProfile, offerText, planProfileMove, prefsStore, shouldOffer } = require('./legacy-import.cjs');
const { resolveDataDir, DEV_PROFILE_NAME, LEGACY_DEV_PROFILE_NAME } = require('./data-dir.cjs');
const { NOTICE_FILE, noticeText, otherInstallFolders, storeDataDir, storeRuntime } = require('./store-package.cjs');
const { PROTOCOL, PROGRAM_HOME, PROGRAM_IDS, PROGRAM_NAME, ProgramWindows, launchRequest, parseNigafiyUrl, programUrl, windowDetails } = require('./programs.cjs');

// An explicit --user-data-dir (tests, a second profile) is never moved, imported or asked about.
const EXPLICIT_DATA_DIR = app.commandLine.hasSwitch('user-data-dir');
// The Microsoft Store package (src/store-package.cjs): its own profile folder, no profile move, the
// link handler from the package manifest, updates from the Store.
const STORE = app.isPackaged && process.platform === 'win32' ? storeRuntime({ windowsStore: process.windowsStore, execPath: process.execPath }) : null;
// "Move my data" (src/legacy-import.cjs) relaunches with --move-legacy-profile: the rename happens
// here, before the profile is chosen or opened. On any failure the old folder stays in use.
let legacyMoveResult = null;
if (!EXPLICIT_DATA_DIR && !STORE && app.isPackaged && process.argv.includes(MOVE_FLAG)) {
  const plan = planProfileMove({ appData: app.getPath('appData'), exists: (p) => fs.existsSync(p) });
  legacyMoveResult = plan ? moveProfile(plan) : { ok: false, error: 'there was nothing to move' };
  console.info(legacyMoveResult.ok ? `[profile] moved ${plan.from} to ${plan.to}` : `[profile] not moved: ${legacyMoveResult.error}`);
}

// The profile folder, before anything reads userData (or takes the single-instance lock, which is
// per profile): the legacy one from before the rename while only that exists (src/data-dir.cjs). An explicit
// --user-data-dir always wins.
if (!app.commandLine.hasSwitch('user-data-dir') && STORE) {
  const profile = storeDataDir({ localAppData: process.env.LOCALAPPDATA, appData: app.getPath('appData'), familyName: STORE.familyName });
  fs.mkdirSync(profile.dir, { recursive: true });
  app.setPath('userData', profile.dir);
  console.info(`[profile] Microsoft Store package ${STORE.fullName ?? '(development registration)'}: profile ${profile.dir}`);
} else if (!app.commandLine.hasSwitch('user-data-dir')) {
  const profile = resolveDataDir({
    appData: app.getPath('appData'),
    exists: (p) => fs.existsSync(p),
    ...(app.isPackaged ? {} : { name: DEV_PROFILE_NAME, legacyName: LEGACY_DEV_PROFILE_NAME }),
  });
  app.setPath('userData', profile.dir);
  if (profile.legacy) console.info(`[profile] using the profile folder from before the rename (${profile.dir}); it is migrated in a later update`);
}

const SMOKE = process.argv.includes('--smoke');
// Non-interactive check of local mode: consent comes from NIGAFIY_DESKTOP_AUTO_CONSENT=1 (legacy LD_DESKTOP_AUTO_CONSENT), then it reports and quits.
const LOCAL_SMOKE = process.argv.includes('--local-smoke');
// Apps & features "Modify" (the ModifyPath the installer writes): only the program chooser opens.
const CHOOSE_PROGRAMS = process.argv.includes('--choose-programs');
// Started by Windows at sign-in: run in the tray and keep monitoring without opening a window.
const STARTED_HIDDEN = process.argv.includes('--hidden');
const LOGIN_ITEM = { args: ['--hidden'] };
/** Sign-in start is set by the app for the normal installed copy (the Store package would need a StartupTask). */
const CAN_START_AT_LOGIN = app.isPackaged && !STORE && process.platform === 'win32';
const CHOOSER_FILE = path.join(__dirname, 'chooser', 'index.html');
const CHOOSER_URL = pathToFileURL(CHOOSER_FILE).href;
const PANEL_FILE = path.join(__dirname, 'panel', 'index.html');
const PANEL_URL = pathToFileURL(PANEL_FILE).href;
const ICON = path.join(__dirname, '..', 'assets', 'icon.png');

/** What this launch asked for: `--program=<id>` or a `nigafiy://` link (Hub by default). */
const launch = launchRequest(process.argv);
/** The program of the start-up window (`dashboard`); other programs get windows of their own. */
const startProgram = launch.program;
const ICON_DIR = app.isPackaged ? path.join(process.resourcesPath, 'icons') : path.join(__dirname, '..', '..', '..', 'packages', 'brand', 'ico');
/** A request to open a program window that arrived before the server was ready. */
let pendingOpen = null;

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
/** @type {LocalStack | EngineStack | null} */
let localStack = null;
/** @type {{ webUrl: string, apiUrl: string } | null} */
let localUrls = null;
let localApi = null;
let localMode = false;
let localShown = false;
let localError = null;

/** The Nigafiy engine (docs/desktop/engine.md): runs the stack; null when it is not built/bundled. */
function engineBinary() {
  const name = process.platform === 'win32' ? 'nigafiy-engine.exe' : 'nigafiy-engine';
  const file = app.isPackaged ? path.join(process.resourcesPath, 'engine', name) : path.join(__dirname, '..', '..', '..', 'engine', 'bin', name);
  return fs.existsSync(file) ? file : null;
}

/** Engine when available (it can also be the Windows service), the direct launcher otherwise. */
function makeStack({ script, nodePath, env, dataDir }) {
  const engineExe = engineBinary();
  const onStatus = (m) => setSplash(m);
  if (engineExe && !readEnv('NIGAFIY_DESKTOP_NO_ENGINE')) {
    return new EngineStack({ engineExe, dataDir, nodePath, script, env: { ...env, NIGAFIY_DATA_DIR: dataDir }, onStatus });
  }
  return new LocalStack({ script, nodePath, env, onStatus });
}

/**
 * The Sensor is the engine executable run as `nigafiy-engine sensor` (one program for both,
 * docs/architecture/engine-sensor.md). The path is returned even when the file is missing, so the
 * panel can say the program is missing from this installation.
 */
function collectorBinary() {
  const name = process.platform === 'win32' ? 'nigafiy-engine.exe' : 'nigafiy-engine';
  return app.isPackaged ? path.join(process.resourcesPath, 'engine', name) : path.join(__dirname, '..', '..', '..', 'engine', 'bin', name);
}

function serverOrigin() {
  if (localMode) return localUrls ? new URL(localUrls.webUrl).origin : null;
  try {
    return new URL(collector.settings.serverUrl).origin;
  } catch {
    return null;
  }
}

/** Taskbar identity of a program window (Windows): its own AppUserModelID, icon and relaunch command. */
function applyProgramIdentity(win, program) {
  if (process.platform !== 'win32' || typeof win.setAppDetails !== 'function') return;
  win.setAppDetails(windowDetails(program, { execPath: process.execPath, appPath: app.isPackaged ? null : app.getAppPath(), iconDir: ICON_DIR }));
}

/** The first page of the start-up window: the link's path, or the program's home. */
function startUrl(origin) {
  return programUrl(origin, launch.path ?? PROGRAM_HOME[startProgram]);
}

/** Stay on the configured server. Anything else opens in the user's own browser (https only). */
function guardContents(contents) {
  const external = (url) => {
    try {
      if (new URL(url).protocol === 'https:') void shell.openExternal(url);
    } catch {
      /* ignore malformed URL */
    }
  };
  contents.on('will-navigate', (event, url) => {
    let targetOrigin = null;
    try {
      targetOrigin = new URL(url).origin;
    } catch {
      event.preventDefault();
      return;
    }
    if (targetOrigin !== serverOrigin()) {
      event.preventDefault();
      external(url);
    }
  });
  contents.setWindowOpenHandler(({ url }) => {
    external(url);
    return { action: 'deny' };
  });
  contents.session.setPermissionRequestHandler((_wc, permission, callback) => callback(permission === 'clipboard-sanitized-write'));
}

/** Windows of the other programs: same session (one sign-in), same navigation rules, own taskbar group. */
const programWindows = new ProgramWindows({
  create: (program) => {
    const win = new BrowserWindow({
      width: 1440,
      height: 900,
      minWidth: 420,
      minHeight: 600,
      title: PROGRAM_NAME[program],
      backgroundColor: '#070d1a',
      icon: ICON,
      autoHideMenuBar: true,
      show: !SMOKE && !LOCAL_SMOKE,
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, partition: 'persist:dashboard' },
    });
    guardContents(win.webContents);
    applyProgramIdentity(win, program);
    return win;
  },
});

/** Open (or focus) a program's window, on `appPath` when given. Waits for the server in local mode. */
function openProgram(program, appPath = null) {
  const origin = serverOrigin();
  if (!origin || (localMode && !localShown)) {
    pendingOpen = { program, path: appPath };
    showDashboard();
    return;
  }
  if (program === startProgram) {
    showDashboard();
    if (appPath && dashboard) void dashboard.webContents.loadURL(programUrl(origin, appPath));
    return;
  }
  const existing = programWindows.get(program);
  programWindows.open(program, !existing || appPath ? programUrl(origin, appPath ?? PROGRAM_HOME[program]) : undefined);
}

function openPending() {
  if (!pendingOpen) return;
  const next = pendingOpen;
  pendingOpen = null;
  openProgram(next.program, next.path);
}

// ── an install from before the rename (src/legacy-import.cjs) ────────────────
async function offerLegacyImport() {
  const locale = app.getLocale().toLowerCase().startsWith('ar') ? 'ar' : 'en';
  if (STORE) return storeNotice(locale);
  if (legacyMoveResult && !legacyMoveResult.ok) {
    const t = require('./legacy-import.cjs').STRINGS[locale];
    await dialog.showMessageBox({ type: 'warning', title: t.title, message: t.moveFailed(legacyMoveResult.error) });
  }
  const prefs = prefsStore(app.getPath('userData'));
  const exists = (p) => fs.existsSync(p);
  const move = planProfileMove({ appData: app.getPath('appData'), exists });
  const installs = findLegacyInstalls({ localAppData: process.env.LOCALAPPDATA, programFiles: process.env.ProgramW6432 || process.env.ProgramFiles, installDir: path.dirname(process.execPath), exists });
  if (!shouldOffer({ packaged: app.isPackaged, explicitDataDir: EXPLICIT_DATA_DIR, smoke: SMOKE || LOCAL_SMOKE || CHOOSE_PROGRAMS, neverAsk: prefs.load().neverAsk, move, installs })) return;
  const text = offerText({ locale, move, installs });
  const { response } = await dialog.showMessageBox({ type: 'question', title: text.title, message: text.message, buttons: text.buttons.map((b) => b.label), cancelId: text.buttons.findIndex((b) => b.id === 'later'), noLink: true });
  const choice = text.buttons[response]?.id;
  if (choice === 'never') prefs.save({ neverAsk: true });
  else if (choice === 'remove') {
    // The old copy's own uninstaller with its own window (and its own UAC prompt for an all-users copy).
    for (const i of installs.filter((x) => x.uninstaller)) {
      const r = await shell.openPath(i.uninstaller);
      if (r) console.warn(`[legacy] could not start ${i.uninstaller}: ${r}`);
    }
  } else if (choice === 'move') {
    app.relaunch({ args: [...process.argv.slice(1).filter((a) => a !== MOVE_FLAG), MOVE_FLAG] });
    await quit();
  }
}

/**
 * Store package: says once where another installation's data is (nothing is moved, imported or
 * removed from inside the package; src/store-package.cjs).
 */
async function storeNotice(locale) {
  if (EXPLICIT_DATA_DIR || SMOKE || LOCAL_SMOKE || CHOOSE_PROGRAMS) return;
  const file = path.join(app.getPath('userData'), NOTICE_FILE);
  try {
    if (JSON.parse(fs.readFileSync(file, 'utf8')).neverShow === true) return;
  } catch {
    /* not shown yet */
  }
  const exists = (p) => fs.existsSync(p);
  const installs = findLegacyInstalls({ localAppData: process.env.LOCALAPPDATA, programFiles: process.env.ProgramW6432 || process.env.ProgramFiles, installDir: path.dirname(process.execPath), exists });
  const folders = otherInstallFolders({ appData: app.getPath('appData'), exists, legacyInstalls: installs });
  if (folders.length === 0) return;
  const text = noticeText({ locale, folders });
  const { response } = await dialog.showMessageBox({ type: 'info', title: text.title, message: text.message, buttons: text.buttons, cancelId: 0, noLink: true });
  if (response === 1) fs.writeFileSync(file, JSON.stringify({ neverShow: true }));
}

// ── program chooser (docs/operations/installers.md, "Choose programs") ──────
let chooser = null;
let chooserIpc = false;
function showProgramChooser() {
  if (chooser) {
    chooser.show();
    chooser.focus();
    return chooser;
  }
  if (!chooserIpc) {
    chooserIpc = true;
    const allow = (event) => {
      if (event.senderFrame?.url !== CHOOSER_URL) throw new Error('not allowed');
    };
    const installDir = path.dirname(process.execPath);
    ipcMain.handle('programs:load', async (event) => {
      allow(event);
      const s = app.isPackaged ? await readInstallSettings({ installDir, store: Boolean(STORE) }) : { scope: 'unknown', programs: 'all', writable: false };
      return { ...s, selected: selectedIds(s.programs), choices: CHOICES, locale: app.getLocale().toLowerCase().startsWith('ar') ? 'ar' : 'en' };
    });
    ipcMain.handle('programs:save', async (event, ids) => {
      allow(event);
      if (!app.isPackaged) return { ok: false, error: 'unknown install' };
      const s = await readInstallSettings({ installDir, store: Boolean(STORE) });
      const r = await writePrograms({ scope: s.scope, ids: Array.isArray(ids) ? ids : [] });
      // The value only (program ids), never anything typed: the choice goes to the app log.
      console.info(r.ok ? `[programs] saved ${r.programs} (${s.scope})` : `[programs] not saved: ${r.error}`);
      return r;
    });
    ipcMain.handle('programs:close', (event) => {
      allow(event);
      chooser?.close();
    });
  }
  chooser = new BrowserWindow({
    width: 560,
    height: 560,
    resizable: false,
    title: 'Nigafiy',
    backgroundColor: '#070d1a',
    icon: ICON,
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'chooser-preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  chooser.webContents.on('will-navigate', (event) => event.preventDefault());
  chooser.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  chooser.on('closed', () => {
    chooser = null;
    if (CHOOSE_PROGRAMS) void quit(); // opened from Apps & features only: nothing else was started
  });
  void chooser.loadFile(CHOOSER_FILE);
  return chooser;
}

function showPanel() {
  if (panel) {
    panel.show();
    panel.focus();
    emitPanelState();
    return panel;
  }
  panel = new BrowserWindow({
    width: 760,
    height: 780,
    minWidth: 520,
    minHeight: 560,
    title: 'Nigafiy — Collector',
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
    if (origin && (!localMode || localShown)) {
      let currentOrigin = null;
      try {
        currentOrigin = new URL(dashboard.webContents.getURL() || 'about:blank').origin;
      } catch {
        currentOrigin = null;
      }
      if (currentOrigin !== origin) void dashboard.webContents.loadURL(startUrl(origin));
    }
    dashboard.show();
    dashboard.focus();
    return dashboard;
  }
  dashboard = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 420,
    minHeight: 600,
    title: startProgram === 'hub' ? 'Nigafiy' : PROGRAM_NAME[startProgram],
    backgroundColor: '#070d1a',
    icon: ICON,
    autoHideMenuBar: true,
    show: !SMOKE && !LOCAL_SMOKE,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, partition: 'persist:dashboard' },
  });
  applyProgramIdentity(dashboard, startProgram);
  programWindows.adopt(startProgram, dashboard);
  const contents = dashboard.webContents;
  guardContents(contents);
  contents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
    const activeOrigin = serverOrigin();
    if (!isMainFrame || code === -3 || !activeOrigin) return; // -3 = navigation aborted (normal)
    void dialog
      .showMessageBox(dashboard, {
        type: 'warning',
        title: 'Nigafiy',
        message: 'Cannot reach the Nigafiy server',
        detail: `${activeOrigin}\n${description}\n\nThe local collector keeps monitoring and will upload its results when the server is reachable again.`,
        buttons: ['Try again', 'Server settings', 'Close'],
        defaultId: 0,
      })
      .then(({ response }) => {
        if (response === 0) void contents.loadURL(startUrl(activeOrigin));
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
  void contents.loadURL(
    origin && (!localMode || localShown)
      ? startUrl(origin)
      : splashUrl(localError ?? 'Starting Nigafiy…', Boolean(localError)),
  );
  return dashboard;
}

function refreshTray() {
  if (!tray) return;
  const state = collector.getState();
  const running = state.status === 'running' || state.status === 'starting';
  const summary = !state.enrolled ? 'Collector: not enrolled' : running ? (state.connected === false ? 'Collector: running, server unreachable' : 'Collector: running') : 'Collector: stopped';
  const modeLabel = localMode ? 'Mode: local (this computer)' : state.settings.serverUrl ? `Server: ${state.settings.serverUrl}` : 'Server: not configured';
  tray.setToolTip(`Nigafiy${localMode ? ' (Local)' : ''}\n${summary}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open dashboard', click: () => showDashboard() },
      { label: 'Collector on this computer…', click: () => showPanel() },
      { label: 'Open program', submenu: PROGRAM_IDS.map((id) => ({ label: PROGRAM_NAME[id], click: () => openProgram(id) })) },
      // The Store package has no Apps & features "Modify" entry, so the chooser is offered here.
      ...(STORE ? [{ label: app.getLocale().toLowerCase().startsWith('ar') ? 'اختيار البرامج…' : 'Choose programs…', click: () => void showProgramChooser() }] : []),
      { type: 'separator' },
      { label: modeLabel, enabled: false },
      { label: summary, enabled: false },
      running
        ? { label: 'Stop collector', click: () => void collector.stop() }
        : { label: 'Start collector', enabled: state.enrolled && Boolean(state.settings.serverUrl), click: () => tryStart() },
      ...updateTrayItems(),
      // Installed copy: opens Settings → Backups, where "Back up now" runs with the owner's sign-in.
      ...(localMode ? [{ label: app.getLocale().toLowerCase().startsWith('ar') ? 'نسخ احتياطي الآن…' : 'Back up now…', click: () => openProgram(startProgram, '/settings#backups') }] : []),
      { type: 'separator' },
      ...(CAN_START_AT_LOGIN
        ? [{ label: 'Start with Windows', type: 'checkbox', checked: app.getLoginItemSettings(LOGIN_ITEM).openAtLogin, click: (item) => setStartAtLogin(item.checked) }]
        : []),
      { label: 'Keep this PC awake while monitoring', type: 'checkbox', checked: localPrefsStore().load().keepAwake, click: (item) => setKeepAwake(item.checked) },
      { type: 'separator' },
      { label: 'Quit Nigafiy', click: () => quit() },
    ]),
  );
}

// ── updates (UX review item 14): a tray line, and one Windows notice per new version ─────────
let updateStatus = null;
let updateTimer = null;

function updateTrayItems() {
  const line = updateTrayLine(updateStatus, app.getLocale());
  if (!line) return [];
  return [{ label: line.label, enabled: line.enabled, click: line.opens ? () => showDashboard() : undefined }];
}

/** Asks the local API (cached there for 6 h) what it knows about updates; the dashboard shows the same status and installs. */
async function checkUpdates() {
  const api = localApi;
  if (!api) return;
  try {
    const r = await api.call('GET', '/platform/updates');
    if (r.status !== 200 || !r.json || api !== localApi) return;
    updateStatus = r.json;
    refreshTray();
    const notice = updateNoticeFor(updateStatus, localPrefsStore().load().notifiedUpdate, app.getLocale());
    const { Notification } = require('electron');
    if (notice && Notification.isSupported()) {
      const n = new Notification({ title: notice.title, body: notice.body });
      n.on('click', () => showDashboard());
      n.show();
      localPrefsStore().save({ notifiedUpdate: notice.version });
    }
  } catch {
    // The tray keeps the last status; the next check tries again.
  }
}

function startUpdateChecks() {
  clearInterval(updateTimer);
  void checkUpdates();
  updateTimer = setInterval(() => void checkUpdates(), UPDATE_CHECK_MS);
}

function stopUpdateChecks() {
  clearInterval(updateTimer);
  updateTimer = null;
  updateStatus = null;
}

// ── running unattended: start at sign-in, stay awake, come back after sleep ─────────
function setStartAtLogin(on) {
  app.setLoginItemSettings({ ...LOGIN_ITEM, openAtLogin: on });
  localPrefsStore().save({ loginItemDone: true });
  refreshTray();
}

/** First run of the installed app: start with Windows (hidden in the tray). Turned off in the tray, it stays off. */
function ensureStartAtLogin() {
  if (!CAN_START_AT_LOGIN || localPrefsStore().load().loginItemDone) return;
  setStartAtLogin(true);
}

let awakeBlocker = null;
/** While the Sensor runs (and the owner did not turn it off), Windows does not put the PC to sleep; the screen still turns off. */
function updateKeepAwake() {
  const state = collector?.getState();
  const want = Boolean(state) && (state.status === 'running' || state.status === 'starting') && localPrefsStore().load().keepAwake;
  if (want && awakeBlocker === null) awakeBlocker = powerSaveBlocker.start('prevent-app-suspension');
  if (!want && awakeBlocker !== null) {
    powerSaveBlocker.stop(awakeBlocker);
    awakeBlocker = null;
  }
}

function setKeepAwake(on) {
  localPrefsStore().save({ keepAwake: on });
  updateKeepAwake();
  refreshTray();
}

function recoverCollector(options) {
  void collector?.recover(options).catch((err) => {
    collector.lastError = err.message;
    collector.emitState();
  });
}

function watchPower() {
  // After sleep the Sensor's sockets and the PC's address may be stale: restart it once the network is back.
  powerMonitor.on('resume', () => setTimeout(() => recoverCollector({ restartRunning: true }), 8000));
  // A Sensor that gave up after repeated crashes is tried again every few minutes instead of staying off.
  setInterval(() => recoverCollector(), 5 * 60_000);
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
  if (quitting) return;
  quitting = true;
  await collector?.stop().catch(() => undefined);
  await localStack?.stop().catch(() => undefined);
  app.quit();
}

// ── local mode ───────────────────────────────────────────────────────────────
function splashUrl(message, error = false) {
  const esc = (t) => String(t).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
  const spinner = error
    ? ''
    : '<div class="spin"></div><style>.spin{width:28px;height:28px;margin:0 auto 16px;border:3px solid #22406e;border-top-color:#4f8cff;border-radius:50%;animation:s 1s linear infinite}@keyframes s{to{transform:rotate(360deg)}}@media (prefers-reduced-motion:reduce){.spin{animation:none}}</style>';
  const html = `<!doctype html><meta charset="utf-8"><title>Nigafiy</title>
<body style="margin:0;height:100vh;display:grid;place-items:center;background:#070d1a;color:#e6edf7;font:15px system-ui,'Segoe UI',sans-serif">
<div style="text-align:center;max-width:520px;padding:24px">
<div style="font-size:22px;font-weight:600;margin-bottom:16px">Nigafiy</div>${spinner}
<div style="color:${error ? '#ff8a8a' : '#9fb0c8'};white-space:pre-line">${esc(message)}</div></div></body>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}
function setSplash(message, error = false) {
  localError = error ? message : null;
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

function localPrefsStore() {
  const file = path.join(app.getPath('userData'), 'local-prefs.json');
  return {
    load() {
      try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        const r = raw && typeof raw === 'object' ? raw : {};
        return { scanDeclined: Boolean(r.scanDeclined), loginItemDone: Boolean(r.loginItemDone), keepAwake: r.keepAwake !== false, notifiedUpdate: typeof r.notifiedUpdate === 'string' ? r.notifiedUpdate : null };
      } catch {
        return { scanDeclined: false, loginItemDone: false, keepAwake: true, notifiedUpdate: null };
      }
    },
    save(patch) {
      const next = { ...this.load(), ...patch };
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(next, null, 2), { mode: 0o600 });
      return next;
    },
  };
}

function panelState() {
  const state = collector.getState();
  const prefs = localPrefsStore().load();
  return {
    ...state,
    localMode,
    localWebUrl: localMode ? localUrls?.webUrl ?? null : null,
    localApiUrl: localMode ? localUrls?.apiUrl ?? null : null,
    localCanScan: localMode && Boolean(localUrls) && Boolean(localApi) && state.binaryAvailable && !state.enrolled,
    scanDeclined: localMode && Boolean(prefs.scanDeclined) && !state.enrolled,
  };
}

function emitPanelState() {
  panel?.webContents.send('collector:state-changed', panelState());
}

async function exitLocalMode() {
  if (!localMode) return;
  localMode = false;
  localShown = false;
  localError = null;
  localApi = null;
  stopUpdateChecks();
  localUrls = null;
  await localStack?.stop().catch(() => undefined);
  localStack = null;
  const origin = serverOrigin();
  if (dashboard && origin && dashboard.isVisible()) {
    void dashboard.webContents.loadURL(origin);
  }
  refreshTray();
  emitPanelState();
}

async function askToScan(net, parentWindow = dashboard) {
  if (LOCAL_SMOKE) return readEnv('NIGAFIY_DESKTOP_AUTO_CONSENT') === '1';
  const parent = parentWindow && !parentWindow.isDestroyed() && parentWindow.isVisible() ? parentWindow : undefined;
  const { response } = await dialog.showMessageBox(parent, {
    type: 'question',
    title: 'Nigafiy',
    message: `Scan your network ${net.cidr}?\nفحص شبكتك ${net.cidr}؟`,
    detail:
      `This computer is connected to ${net.cidr} (${net.iface}). Nigafiy will discover and monitor the devices on it from this computer.\n\n` +
      'Only continue if this is your own network or you are allowed to scan it.\nتابع فقط إذا كانت هذه شبكتك أو مسموح لك بفحصها.',
    buttons: ['Scan my network / افحص شبكتي', 'Not now / ليس الآن'],
    defaultId: 0,
    cancelId: 1,
  });
  return response === 0;
}

async function enrollOnNetwork(api, net, onProgress) {
  localPrefsStore().save({ scanDeclined: false });
  onProgress?.(`Setting up scanning of ${net.cidr}…`);
  const token = await enrollThisComputer(api, net.cidr);
  if (!localMode || !localUrls) return;
  await collector.saveSettings({ serverUrl: localUrls.apiUrl, allowedCidrs: [net.cidr], autoStart: true });
  if (!localMode) return;
  tryStart(token);
}

async function startLocal() {
  if (!STARTED_HIDDEN) showDashboard();
  if (hasBundle) {
    // Installed: Electron's own Node runs everything; data lives in the user's profile.
    const dataDir = path.join(app.getPath('userData'), 'data');
    localStack = makeStack({
      script: path.join(bundleDir, 'local.mjs'),
      nodePath: process.execPath,
      env: { ELECTRON_RUN_AS_NODE: '1', NIGAFIY_BUNDLE_DIR: bundleDir, NIGAFIY_DATA_DIR: dataDir },
      dataDir,
    });
  } else {
    const nodePath = findNode();
    if (!nodePath) {
      setSplash('Node.js 24 or newer is needed to run Nigafiy from source.\nInstall it from nodejs.org, then open the app again.', true);
      return;
    }
    localStack = makeStack({ script: path.join(repoRoot, 'scripts', 'local.mjs'), nodePath, env: {}, dataDir: path.join(repoRoot, '.data') });
  }
  try {
    localUrls = await localStack.start();
    if (!localMode) return;
    emitPanelState();
    setSplash('Signing in…');
    // A collector identity issued by some other server is useless here: forget it and set up again.
    if (collector.isEnrolled() && collector.settings.serverUrl && collector.settings.serverUrl !== localUrls.apiUrl) await collector.resetIdentity();
    if (!localMode) return;
    const store = accountStore();
    let api = null;
    // Sign in automatically with the app's own account. If this computer was set up from the command
    // line with a personal account instead, the person signs in with that account themselves.
    if (store.load() || !collector.isEnrolled()) {
      // api is null when the account no longer takes this computer's password (or asks for a second
      // factor): the web app then shows its sign-in page, and any session the person has stays.
      api = (await signIn(localUrls.apiUrl, localUrls.webUrl, store)).api;
      if (!localMode) return;
      if (api) await session.fromPartition('persist:dashboard').cookies.set({
        url: localUrls.webUrl,
        name: 'ld_session',
        value: api.session(),
        httpOnly: true,
        sameSite: 'lax',
        expirationDate: Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
      });
    }
    if (!localMode) return;
    localApi = api;
    if (api) startUpdateChecks();
    emitPanelState();
    const prefs = localPrefsStore();
    if (collector.binaryAvailable()) {
      if (collector.isEnrolled()) {
        if (prefs.load().scanDeclined) prefs.save({ scanDeclined: false });
        if (collector.settings.serverUrl !== localUrls.apiUrl) {
          await collector.saveSettings({ ...collector.settings, serverUrl: localUrls.apiUrl }, { preserveIdentity: true });
        }
        if (localMode && collector.settings.autoStart) tryStart();
      } else if (api && (LOCAL_SMOKE || !prefs.load().scanDeclined)) {
        const net = await homeNetwork();
        if (!localMode) return;
        if (net?.private) {
          if (await askToScan(net, dashboard)) {
            if (!localMode) return;
            await enrollOnNetwork(api, net, setSplash);
          } else if (!LOCAL_SMOKE) {
            prefs.save({ scanDeclined: true });
          }
        }
      }
    }
    if (!localMode) return;
    localShown = true;
    emitPanelState();
    refreshTray();
    if (!dashboard) {
      if (!STARTED_HIDDEN) showDashboard();
    } else await dashboard.webContents.loadURL(startUrl(localUrls.webUrl));
    openPending();
  } catch (err) {
    if (!localMode) return;
    setSplash(`Nigafiy could not start:\n${err.message}`, true);
    // Started hidden at sign-in: a failure must not stay invisible.
    if (!dashboard) showDashboard();
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
  // A second launch (a program launcher, a taskbar relaunch, a clicked nigafiy:// link) is handed here.
  app.on('second-instance', (_event, argv) => {
    if (argv.includes('--choose-programs') || CHOOSE_PROGRAMS) return void showProgramChooser();
    const req = launchRequest(argv);
    if (req.rejected) return void showDashboard(); // a nigafiy:// link that is not one of ours opens nothing else
    const asked = req.link || argv.some((a) => typeof a === 'string' && a.startsWith('--program'));
    if (asked) openProgram(req.program, req.path);
    else showDashboard();
  });
  app.on('open-url', (event, url) => {
    event.preventDefault();
    const parsed = parseNigafiyUrl(url);
    if (parsed && app.isReady()) openProgram(parsed.program, parsed.path);
  });
  app.on('before-quit', (e) => {
    if (!quitting) {
      e.preventDefault();
      void quit();
    }
  });
  app.on('window-all-closed', () => {
    /* keep running in the tray */
  });

  app.whenReady().then(() => {
    app.setAppUserModelId('com.nigafiy.hub');
    if (CHOOSE_PROGRAMS) return void showProgramChooser();
    void offerLegacyImport().catch((err) => console.warn(`[legacy] ${err?.message ?? err}`));
    // nigafiy:// is registered by the installed app only; a source checkout or a test run never writes HKCU\Software\Classes\nigafiy.
    // The Store package declares nigafiy:// in its manifest (a packaged app's HKCU writes are private).
    if (app.isPackaged && !STORE) app.setAsDefaultProtocolClient(PROTOCOL);
    collector = new CollectorManager({
      binaryPath: collectorBinary(),
      binaryArgs: ['sensor'],
      // In a source checkout the collector identity is shared with `pnpm local`.
      dataDir: repoRoot ? path.join(repoRoot, '.data', 'collector') : path.join(app.getPath('userData'), 'collector'),
    });
    const configured = collector.settings.serverUrl;
    localMode = Boolean(repoRoot || hasBundle) && !SMOKE && (!configured || isLocalServerUrl(configured));
    collector.on('state', (state) => {
      if (localMode && state.enrolled && localPrefsStore().load().scanDeclined) {
        localPrefsStore().save({ scanDeclined: false });
      }
      emitPanelState();
      refreshTray();
      updateKeepAwake();
    });

    handle('collector:state', () => panelState());
    // The Nigafiy engine's parts (database, API, web console, Sensor) for the panel's engine card.
    handle('engine:state', async () => {
      if (!localMode || !(localStack instanceof EngineStack)) return { available: false };
      return { available: true, ...summarizeEngine(await localStack.status()) };
    });
    handle('collector:save-settings', async (settings) => {
      const prevLocalMode = localMode;
      const nextState = await collector.saveSettings(settings ?? {});
      const switchedFromLocal = prevLocalMode && !isLocalServerUrl(nextState.settings.serverUrl);
      if (switchedFromLocal) await exitLocalMode();
      const out = panelState();
      if (switchedFromLocal) out.switchedFromLocal = true;
      return out;
    });
    handle('collector:start', async (token) => {
      if (localMode && !collector.settings.serverUrl && localUrls?.apiUrl) {
        await collector.saveSettings({ ...collector.settings, serverUrl: localUrls.apiUrl }, { preserveIdentity: true });
      }
      tryStart(typeof token === 'string' ? token : '');
      if (localMode) localPrefsStore().save({ scanDeclined: false });
      return panelState();
    });
    handle('collector:stop', async () => {
      await collector.stop();
      return panelState();
    });
    handle('collector:reset', async () => {
      await collector.resetIdentity();
      if (localMode) localPrefsStore().save({ scanDeclined: false });
      return panelState();
    });
    handle('local:setup-scan', async () => {
      if (!localMode || !localUrls || !localApi) throw new Error('Local server is not ready yet.');
      if (!collector.binaryAvailable()) throw new Error('The collector program is missing from this installation.');
      const prefs = localPrefsStore();
      prefs.save({ scanDeclined: false });
      if (collector.isEnrolled()) {
        if (collector.settings.serverUrl !== localUrls.apiUrl) {
          await collector.saveSettings({ ...collector.settings, serverUrl: localUrls.apiUrl }, { preserveIdentity: true });
        }
        tryStart();
        return panelState();
      }
      const net = await homeNetwork();
      if (!net) throw new Error('No active private network was found on this computer. Connect to your home network and try again.');
      if (!net.private) throw new Error(`This computer’s address (${net.address}) is not a private network address, so automatic scanning is skipped.`);
      if (await askToScan(net, panel ?? dashboard)) {
        await enrollOnNetwork(localApi, net);
      } else {
        prefs.save({ scanDeclined: true });
      }
      return panelState();
    });
    handle('local:reset-scan-prompt', () => {
      localPrefsStore().save({ scanDeclined: false });
      emitPanelState();
      return panelState();
    });
    handle('app:open-dashboard', () => {
      showDashboard();
    });

    const image = nativeImage.createFromPath(ICON);
    tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image.resize({ width: 16, height: 16 }));
    tray.on('double-click', () => showDashboard());
    if (!SMOKE && !LOCAL_SMOKE) {
      ensureStartAtLogin();
      watchPower();
    }
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
    if (!STARTED_HIDDEN) showDashboard();
    openPending();

    if (SMOKE) {
      // Start-up self-check used by `pnpm smoke`: prints what the app sees, then exits.
      setTimeout(async () => {
        const state = collector.getState();
        console.log(JSON.stringify({ smoke: 'ok', binaryAvailable: state.binaryAvailable, enrolled: state.enrolled, status: state.status, hasServer: Boolean(state.settings.serverUrl), windows: BrowserWindow.getAllWindows().length, tray: Boolean(tray), program: startProgram, protocolRegistered: app.isPackaged, store: STORE ? (STORE.fullName ?? 'development registration') : null }));
        await quit();
      }, 2500);
    }
  });
}
