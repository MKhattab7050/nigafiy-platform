'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');
const {
  PROGRAM_HOME,
  PROGRAM_IDS,
  PROGRAM_PREFIX,
  ProgramWindows,
  appUserModelId,
  findNigafiyUrl,
  launchRequest,
  parseNigafiyUrl,
  parseProgramArg,
  programUrl,
  windowDetails,
} = require('../src/programs.cjs');

const ROUTES_TS = path.join(__dirname, '..', '..', '..', 'packages', 'shared-types', 'src', 'routes.ts');
const ICON_DIR = path.join(__dirname, '..', '..', '..', 'packages', 'brand', 'ico');

/** The shared route table (Node 24 strips the types). */
const shared = () => import(pathToFileURL(ROUTES_TS).href);

test('the program table equals the shared route table', async () => {
  const routes = await shared();
  assert.deepEqual([...PROGRAM_IDS], [...routes.ROUTE_PROGRAM_IDS]);
  assert.deepEqual({ ...PROGRAM_PREFIX }, { ...routes.PROGRAM_PREFIX });
  assert.deepEqual({ ...PROGRAM_HOME }, { ...routes.PROGRAM_HOME });
});

test('nigafiy:// links map 1:1 to app paths, like the shared parser', async () => {
  const routes = await shared();
  const good = [
    ['nigafiy://fleet/endpoints/7', { program: 'fleet', path: '/fleet/endpoints/7' }],
    ['nigafiy://guard/devices/123/block', { program: 'guard', path: '/guard/devices/123/block' }],
    ['nigafiy://hub/settings', { program: 'hub', path: '/settings' }],
    ['nigafiy://hub', { program: 'hub', path: '/' }],
    ['nigafiy://hub/', { program: 'hub', path: '/' }],
    ['nigafiy://radar/', { program: 'radar', path: '/radar' }],
    ['nigafiy://radar/devices?trust=unreviewed', { program: 'radar', path: '/radar/devices?trust=unreviewed' }],
    ['NIGAFIY://Toolbox/subnet', { program: 'toolbox', path: '/toolbox/subnet' }],
    ['nigafiy://watch/incidents/9#timeline', { program: 'watch', path: '/watch/incidents/9' }],
    // Empty segments collapse: still an app path on the same origin.
    ['nigafiy://radar//evil.test', { program: 'radar', path: '/radar/evil.test' }],
  ];
  for (const [link, want] of good) {
    assert.deepEqual(parseNigafiyUrl(link), want, link);
    assert.deepEqual(routes.nigafiyUrlToPath(link), want, `shared: ${link}`);
  }
});

test('nigafiy:// links that could leave the app are refused', async () => {
  const routes = await shared();
  const bad = [
    'nigafiy://evil/x',
    'nigafiy://radar/../settings',
    'nigafiy://radar/./devices',
    'nigafiy://radar/%2e%2e/x',
    'nigafiy://radar/a b',
    'nigafiy://radar/x?<script>',
    'nigafiy://radar/x\\..\\y',
    'nigafiy:radar',
    'https://radar/devices',
    'javascript:alert(1)',
    'nigafiy://radar/x?a="1"',
    '',
  ];
  for (const link of bad) {
    assert.equal(parseNigafiyUrl(link), null, link);
    assert.equal(routes.nigafiyUrlToPath(link), null, `shared: ${link}`);
  }
  assert.equal(parseNigafiyUrl(`nigafiy://radar/${'a'.repeat(3000)}`), null);
  assert.equal(parseNigafiyUrl(undefined), null);
  assert.equal(parseNigafiyUrl(42), null);
});

test('launch arguments: --program, a link, or Hub', () => {
  assert.equal(parseProgramArg(['electron.exe', '.', '--program=guard']), 'guard');
  assert.equal(parseProgramArg(['Nigafiy.exe', '--program', 'fleet']), 'fleet');
  assert.equal(parseProgramArg(['Nigafiy.exe', '--program=RADAR']), 'radar');
  assert.equal(parseProgramArg(['Nigafiy.exe', '--program=evil']), 'hub');
  assert.equal(parseProgramArg(['Nigafiy.exe']), 'hub');
  assert.equal(parseProgramArg(undefined), 'hub');
  assert.equal(findNigafiyUrl(['Nigafiy.exe', '--allow-file-access', 'nigafiy://mind/knowledge/3']), 'nigafiy://mind/knowledge/3');
  assert.equal(findNigafiyUrl(['Nigafiy.exe']), null);
  assert.deepEqual(launchRequest(['Nigafiy.exe', '--program=watch', 'nigafiy://guard/devices/5/pause']), { program: 'guard', path: '/guard/devices/5/pause', link: true });
  assert.deepEqual(launchRequest(['Nigafiy.exe', 'nigafiy://guard/../../etc']), { program: 'hub', path: null, link: true, rejected: true });
  assert.deepEqual(launchRequest(['Nigafiy.exe', '--program=toolbox']), { program: 'toolbox', path: null, link: false });
});

test('each program has its own taskbar identity and icon', () => {
  const ids = PROGRAM_IDS.map(appUserModelId);
  assert.deepEqual(ids, ['Nigafiy.Hub', 'Nigafiy.Radar', 'Nigafiy.Watch', 'Nigafiy.Guard', 'Nigafiy.Fleet', 'Nigafiy.Mind', 'Nigafiy.Toolbox']);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(appUserModelId('evil'), 'Nigafiy.Hub');
  for (const id of PROGRAM_IDS) {
    const d = windowDetails(id, { execPath: 'C:\\Program Files\\Nigafiy\\Nigafiy.exe', iconDir: ICON_DIR });
    assert.equal(d.appId, appUserModelId(id));
    assert.ok(fs.existsSync(d.appIconPath), `${id}.ico exists in @nigafiy/brand`);
    assert.equal(d.relaunchCommand, `"C:\\Program Files\\Nigafiy\\Nigafiy.exe" --program=${id}`);
    assert.match(d.relaunchDisplayName, /^Nigafiy /);
  }
  // From a source checkout the relaunch command reopens the same app folder.
  const dev = windowDetails('radar', { execPath: 'D:\\x\\electron.exe', appPath: 'D:\\my repo\\apps\\desktop', iconDir: ICON_DIR });
  assert.equal(dev.relaunchCommand, 'D:\\x\\electron.exe "D:\\my repo\\apps\\desktop" --program=radar');
});

test('program URLs stay on the origin', () => {
  assert.equal(programUrl('http://127.0.0.1:3100/', '/guard/security'), 'http://127.0.0.1:3100/guard/security');
  assert.equal(programUrl('http://127.0.0.1:3100', '//evil.test/x'), 'http://127.0.0.1:3100/');
  assert.equal(programUrl('http://127.0.0.1:3100', 'https://evil.test'), 'http://127.0.0.1:3100/');
  assert.equal(programUrl('http://127.0.0.1:3100', null), 'http://127.0.0.1:3100/');
});

/** A stand-in for BrowserWindow with just what ProgramWindows uses. */
function fakeWindow(program) {
  const handlers = {};
  return {
    program,
    loaded: [],
    shown: 0,
    focused: 0,
    destroyed: false,
    minimized: false,
    restored: 0,
    loadURL(url) {
      this.loaded.push(url);
      return Promise.resolve();
    },
    show() {
      this.shown++;
    },
    focus() {
      this.focused++;
    },
    isDestroyed() {
      return this.destroyed;
    },
    isMinimized() {
      return this.minimized;
    },
    restore() {
      this.restored++;
      this.minimized = false;
    },
    on(event, fn) {
      handlers[event] = fn;
    },
    close() {
      this.destroyed = true;
      handlers.closed?.();
    },
  };
}

test('one window per program: reused, focused, navigated, recreated after close', () => {
  const created = [];
  const windows = new ProgramWindows({
    create: (program) => {
      const w = fakeWindow(program);
      created.push(w);
      return w;
    },
  });
  const hub = fakeWindow('hub');
  windows.adopt('hub', hub);

  const a = windows.open('guard', 'http://o/guard/security');
  assert.equal(a.created, true);
  const b = windows.open('guard', 'http://o/guard/devices/1?action=block');
  assert.equal(b.created, false);
  assert.equal(a.win, b.win);
  assert.deepEqual(a.win.loaded, ['http://o/guard/security', 'http://o/guard/devices/1?action=block']);
  assert.equal(a.win.focused, 2);

  // Focusing without a URL keeps the page the person was on.
  windows.open('hub');
  assert.deepEqual(hub.loaded, []);
  assert.equal(hub.focused, 1);

  a.win.minimized = true;
  windows.open('guard');
  assert.equal(a.win.restored, 1);

  a.win.close();
  assert.equal(windows.get('guard'), null);
  const c = windows.open('guard', 'http://o/guard/security');
  assert.equal(c.created, true);
  assert.notEqual(c.win, a.win);
  assert.equal(created.length, 2);
  assert.deepEqual(
    windows.all().map((w) => w.program),
    ['hub', 'guard'],
  );
  assert.throws(() => windows.open('evil'), /unknown program/);
});

test('the protocol is registered only by a packaged build, and not by the Store package (its manifest declares it)', () => {
  // Static check of main.cjs: a source checkout or a test run must never write HKCU\Software\Classes\nigafiy.
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.cjs'), 'utf8');
  const calls = main.split('\n').filter((l) => l.includes('setAsDefaultProtocolClient'));
  assert.equal(calls.length, 1, 'exactly one registration call');
  assert.match(calls[0], /if \(app\.isPackaged && !STORE\)/);
  assert.doesNotMatch(main, /removeAsDefaultProtocolClient/);
});
