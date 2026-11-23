'use strict';
// Nigafiy programs in the desktop runtime (Milestone 4, spec §6.2 and Part C).
//
//  - One runtime process, one window per program. `--program=<id>` picks the window a launch opens;
//    without it the Hub window opens.
//  - Each window has its own taskbar identity: AppUserModelID `Nigafiy.<Program>`, the program's icon,
//    and a relaunch command that opens the same program again.
//  - `nigafiy://<program>/<path>[?query]` links open (or focus) that program's window on the path.
//    The parser is strict: a known program, path segments of unreserved characters only, no `.` or
//    `..`, and a plain query, so a link can never point the window anywhere outside the app.
//
// No Electron imports here: the module is plain data and functions, tested by test/programs.test.cjs,
// which also checks that the tables below equal the shared route table (packages/shared-types/src/routes.ts).

const path = require('node:path');

/** Same ids, prefixes and homes as `@nigafiy/shared-types/routes` (a test keeps them equal). */
const PROGRAM_IDS = Object.freeze(['hub', 'radar', 'watch', 'guard', 'fleet', 'mind', 'toolbox']);
const PROGRAM_PREFIX = Object.freeze({ hub: '', radar: '/radar', watch: '/watch', guard: '/guard', fleet: '/fleet', mind: '/mind', toolbox: '/toolbox' });
const PROGRAM_HOME = Object.freeze({
  hub: '/',
  radar: '/radar/devices',
  watch: '/watch/monitoring',
  guard: '/guard/security',
  fleet: '/fleet/endpoints',
  mind: '/mind/knowledge',
  toolbox: '/toolbox',
});
const PROGRAM_NAME = Object.freeze({
  hub: 'Nigafiy Hub',
  radar: 'Nigafiy Radar',
  watch: 'Nigafiy Watch',
  guard: 'Nigafiy Guard',
  fleet: 'Nigafiy Fleet',
  mind: 'Nigafiy Mind',
  toolbox: 'Nigafiy Toolbox',
});

const PROTOCOL = 'nigafiy';
const SEGMENT = /^[A-Za-z0-9._~-]+$/;
const QUERY = /^\?[A-Za-z0-9._~\-=&%+]*$/;

const isProgramId = (v) => typeof v === 'string' && PROGRAM_IDS.includes(v);

/**
 * `nigafiy://<program>/<path>[?query]` → `{ program, path }` (the app path, 1:1 with the web URL
 * scheme: `nigafiy://hub/settings` → `/settings`, `nigafiy://guard/devices/7/block` →
 * `/guard/devices/7/block`, which the web app redirects to the card with `?action=block`).
 * null for anything that is not one of ours.
 */
function parseNigafiyUrl(link) {
  if (typeof link !== 'string' || link.length > 2048) return null;
  const m = /^nigafiy:\/\/([a-z]+)(\/[^?#]*)?(\?[^#]*)?(#.*)?$/i.exec(link.trim());
  if (!m) return null;
  const program = m[1].toLowerCase();
  if (!isProgramId(program)) return null;
  const rest = (m[2] ?? '').replace(/\/+$/, '');
  const segments = rest.split('/').filter(Boolean);
  if (segments.some((s) => !SEGMENT.test(s) || s === '.' || s === '..')) return null;
  const query = m[3] && m[3].length > 1 ? m[3] : '';
  if (query && !QUERY.test(query)) return null;
  const base = PROGRAM_PREFIX[program];
  const appPath = segments.length ? `${base}/${segments.join('/')}` : base || '/';
  return { program, path: appPath + query };
}

/** The first `nigafiy://` link on a command line (Windows passes the clicked link as an argument). */
function findNigafiyUrl(argv) {
  if (!Array.isArray(argv)) return null;
  for (const arg of argv) {
    if (typeof arg === 'string' && arg.toLowerCase().startsWith(`${PROTOCOL}://`)) return arg;
  }
  return null;
}

/** `--program=<id>` (or `--program <id>`) → that id; anything unknown, or nothing, is Hub. */
function parseProgramArg(argv) {
  if (!Array.isArray(argv)) return 'hub';
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (typeof arg !== 'string') continue;
    let value = null;
    if (arg.startsWith('--program=')) value = arg.slice('--program='.length);
    else if (arg === '--program') value = argv[i + 1] ?? null;
    if (value !== null) return isProgramId(String(value).toLowerCase()) ? String(value).toLowerCase() : 'hub';
  }
  return 'hub';
}

/** What a launch asks for: a link wins over `--program`. */
function launchRequest(argv) {
  const link = findNigafiyUrl(argv);
  if (link) {
    const parsed = parseNigafiyUrl(link);
    return parsed ? { program: parsed.program, path: parsed.path, link: true } : { program: 'hub', path: null, link: true, rejected: true };
  }
  return { program: parseProgramArg(argv), path: null, link: false };
}

/** `Nigafiy.Radar`: one taskbar group per program. */
function appUserModelId(program) {
  const id = isProgramId(program) ? program : 'hub';
  return `Nigafiy.${id[0].toUpperCase()}${id.slice(1)}`;
}

const quoteArg = (v) => (/[\s"]/.test(v) ? `"${String(v).replace(/"/g, '\\"')}"` : v);

/**
 * The Windows taskbar details for a program's window (BrowserWindow.setAppDetails).
 * `execPath` is the runtime executable; in a source checkout `appPath` is the app folder Electron
 * was started with, so the relaunch command reopens the same checkout.
 */
function windowDetails(program, { execPath, appPath = null, iconDir }) {
  const id = isProgramId(program) ? program : 'hub';
  const args = [...(appPath ? [quoteArg(appPath)] : []), `--program=${id}`];
  return {
    appId: appUserModelId(id),
    appIconPath: path.join(iconDir, `${id}.ico`),
    appIconIndex: 0,
    relaunchCommand: `${quoteArg(execPath)} ${args.join(' ')}`,
    relaunchDisplayName: PROGRAM_NAME[id],
  };
}

/** The full URL a program window loads for an app path (the path always starts with `/`). */
function programUrl(origin, appPath) {
  const base = String(origin).replace(/\/+$/, '');
  const p = typeof appPath === 'string' && appPath.startsWith('/') && !appPath.startsWith('//') ? appPath : '/';
  return base + p;
}

/**
 * One window per program. `create(program)` makes a new window (the caller sets its web
 * preferences, navigation rules and taskbar details); `open(program, url)` shows that program's
 * window, creating it the first time, and navigates it when a URL is given.
 */
class ProgramWindows {
  constructor({ create }) {
    this.create = create;
    /** @type {Map<string, any>} */
    this.windows = new Map();
  }

  get(program) {
    const win = this.windows.get(program);
    if (win && typeof win.isDestroyed === 'function' && win.isDestroyed()) {
      this.windows.delete(program);
      return null;
    }
    return win ?? null;
  }

  /** Remember an existing window (the start-up window) as this program's. */
  adopt(program, win) {
    this.windows.set(program, win);
    if (typeof win.on === 'function') win.on('closed', () => this.windows.get(program) === win && this.windows.delete(program));
  }

  open(program, url) {
    if (!isProgramId(program)) throw new Error(`unknown program: ${program}`);
    let win = this.get(program);
    let created = false;
    if (!win) {
      win = this.create(program);
      this.adopt(program, win);
      created = true;
    }
    if (url) void win.loadURL(url);
    if (typeof win.isMinimized === 'function' && win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return { win, created };
  }

  all() {
    return [...this.windows.keys()].map((p) => this.get(p)).filter(Boolean);
  }
}

module.exports = {
  PROTOCOL,
  PROGRAM_IDS,
  PROGRAM_PREFIX,
  PROGRAM_HOME,
  PROGRAM_NAME,
  parseNigafiyUrl,
  findNigafiyUrl,
  parseProgramArg,
  launchRequest,
  appUserModelId,
  windowDetails,
  programUrl,
  ProgramWindows,
};
