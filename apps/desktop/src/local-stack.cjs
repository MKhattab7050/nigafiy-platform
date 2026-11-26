'use strict';
// Runs Nigafiy itself (database, API, web app) on this computer for the desktop app, and does
// the one-time setup so the person sees their network without creating tokens by hand.
// No Electron imports here, so this file can be tested with plain Node.
const { fork, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const dgram = require('node:dgram');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** The repository root when the app runs from a source checkout; null in an installed build. */
function findRepoRoot(start) {
  let dir = start;
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'scripts', 'local.mjs')) && fs.existsSync(path.join(dir, 'apps', 'api'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/** A Node.js 24+ executable on this computer (the API runs TypeScript natively). */
function findNode() {
  const candidates = ['node', ...(process.platform === 'win32' ? ['C:\\Program Files\\nodejs\\node.exe'] : ['/usr/local/bin/node', '/opt/homebrew/bin/node'])];
  for (const candidate of candidates) {
    const r = spawnSync(candidate, ['-p', 'process.versions.node'], { encoding: 'utf8', windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } });
    if (r.status === 0 && Number(String(r.stdout).split('.')[0]) >= 24) return candidate;
  }
  return null;
}

class LocalStack {
  /**
   * @param {{ script: string, nodePath: string, env?: Record<string, string>, onStatus?: (msg: string) => void }} options
   *   script: the launcher (scripts/local.mjs in a checkout, resources/backend/local.mjs when installed).
   *   nodePath: a Node.js executable — system Node 24 in a checkout, Electron itself (ELECTRON_RUN_AS_NODE) when installed.
   */
  constructor({ script, nodePath, env, onStatus }) {
    this.script = script;
    this.nodePath = nodePath;
    this.extraEnv = env ?? {};
    this.onStatus = onStatus ?? (() => undefined);
    this.child = null;
    this.urls = null;
    this.startingPromise = null;
  }

  /** Starts (or reuses) database, API and web app. Resolves with { webUrl, apiUrl }. */
  start() {
    if (this.urls) return Promise.resolve(this.urls);
    if (this.startingPromise) return this.startingPromise;
    this.startingPromise = new Promise((resolve, reject) => {
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      Object.assign(env, this.extraEnv);
      const child = fork(this.script, ['--no-open', '--no-collector'], {
        cwd: path.dirname(this.script),
        execPath: this.nodePath,
        env,
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        windowsHide: true,
      });
      this.child = child;
      let lastError = null;
      const timeout = setTimeout(() => {
        this.startingPromise = null;
        void this.stop();
        reject(new Error(lastError ?? 'Timed out waiting for Nigafiy to start (60s).'));
      }, 60_000);
      child.on('message', (msg) => {
        if (msg?.type === 'status') this.onStatus(String(msg.message));
        if (msg?.type === 'error') lastError = String(msg.message);
        if (msg?.type === 'ready') {
          clearTimeout(timeout);
          this.startingPromise = null;
          this.urls = { webUrl: msg.webUrl, apiUrl: msg.apiUrl };
          resolve(this.urls);
        }
      });
      child.on('error', (err) => {
        clearTimeout(timeout);
        this.startingPromise = null;
        reject(err);
      });
      child.on('exit', (code) => {
        clearTimeout(timeout);
        this.startingPromise = null;
        this.child = null;
        if (!this.urls) reject(new Error(lastError ?? `Nigafiy could not start (exit code ${code}). The logs folder has details.`));
        this.urls = null;
      });
    });
    return this.startingPromise;
  }

  /** Stops what start() launched (services that were already running are left alone by the launcher). */
  stop() {
    const child = this.child;
    if (!child) return Promise.resolve();
    return new Promise((resolve) => {
      const killTree = () => {
        if (process.platform === 'win32' && child.pid) {
          spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        }
        child.kill();
      };
      const force = setTimeout(() => {
        killTree();
        resolve();
      }, 25_000);
      child.once('exit', () => {
        clearTimeout(force);
        resolve();
      });
      if (child.connected) child.send('stop');
      else killTree();
    });
  }
}

// ── API helpers ──────────────────────────────────────────────────────────────
function apiClient(apiUrl, webUrl) {
  let cookie = '';
  async function call(method, url, body) {
    const res = await fetch(`${apiUrl}/api/v1${url}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-LD-CSRF': '1', Origin: webUrl, ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    const set = res.headers.getSetCookie?.().find((x) => x.startsWith('ld_session='));
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON */
    }
    return { status: res.status, json };
  }
  return { call, session: () => (cookie.includes('=') ? cookie.slice(cookie.indexOf('=') + 1) : '') };
}

/**
 * Signs in with the app's own local account, creating it on first use. The account exists only in
 * the local database; its password is random and kept (encrypted) by the desktop app.
 *
 * Once the owner chooses their own password ("Set your own password" in the web app), /auth/login
 * takes only theirs; the API keeps this computer's stored password for /auth/login/desktop, so the
 * app still signs in by itself. If neither works (two-factor sign-in is on, or the account no longer
 * accepts this computer's password) the result is { api: null, needsSignIn: true } and the app shows
 * the normal sign-in page instead of an error. A new account is created only when no account can be
 * used and the server still allows the first sign-up (no stored account, or the database was reset).
 * @param {{ load: () => ({email: string, password: string} | null), save: (a: {email: string, password: string}) => void }} store
 * @returns {Promise<{ api: ReturnType<typeof apiClient> | null, created: boolean, needsSignIn?: boolean }>}
 */
async function signIn(apiUrl, webUrl, store) {
  const api = apiClient(apiUrl, webUrl);
  let account = store.load();
  if (account) {
    let r = await api.call('POST', '/auth/login', account);
    if (r.status === 401) {
      const viaDesktop = await api.call('POST', '/auth/login/desktop', account);
      if (viaDesktop.status !== 404) r = viaDesktop; // 404: an API from before /auth/login/desktop
    }
    if (r.status === 200) return r.json?.ok === false ? { api: null, created: false, needsSignIn: true } : { api, created: false };
    if (r.status !== 401) throw new Error(`Could not sign in to the local account: ${r.json?.error?.message ?? r.status}`);
    // Not accepted. Only an empty (reset) database may get a new account; otherwise the person signs in.
    const options = await api.call('GET', '/auth/options');
    if (options.status !== 200 || !options.json?.allow_registration) return { api: null, created: false, needsSignIn: true };
  }
  // First run (or the local database was reset): create the owner account for this computer.
  account = { email: `owner-${crypto.randomBytes(4).toString('hex')}@nigafiy.local`, password: crypto.randomBytes(24).toString('base64url') };
  const name = os.userInfo().username || 'Me';
  const r = await api.call('POST', '/auth/register', { ...account, display_name: name, organization_name: 'My home', site_name: 'Home' });
  if (r.status !== 201 && r.status !== 200) throw new Error(`Could not create the local account: ${r.json?.error?.message ?? r.status}`);
  store.save(account);
  return { api, created: true };
}

// ── home network ─────────────────────────────────────────────────────────────
const ipToInt = (ip) => ip.split('.').reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
const intToIp = (n) => [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.');
const isPrivate = (ip) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);

function networkFor(address, interfaces = os.networkInterfaces()) {
  for (const [name, addrs] of Object.entries(interfaces)) {
    const hit = addrs?.find((a) => (a.family === 'IPv4' || a.family === 4) && a.address === address);
    if (!hit) continue;
    let prefix = Number(hit.cidr?.split('/')[1] ?? 24);
    if (prefix < 20) prefix = 24; // Nigafiy scans at most a /20; a home LAN is almost always a /24
    const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
    return { iface: name, address, cidr: `${intToIp(ipToInt(address) & mask)}/${prefix}`, private: isPrivate(address) };
  }
  return null;
}

function fallbackHomeNetwork(interfaces = os.networkInterfaces()) {
  for (const addrs of Object.values(interfaces)) {
    for (const a of addrs ?? []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal && isPrivate(a.address)) {
        const net = networkFor(a.address, interfaces);
        if (net) return net;
      }
    }
  }
  return null;
}

/** The IPv4 network of the interface that carries the default route, falling back to the first active private IPv4 interface when offline. */
function homeNetwork(interfaces) {
  return new Promise((resolve) => {
    let s;
    let done = false;
    const finish = (net) => {
      if (done) return;
      done = true;
      try {
        s?.close();
      } catch {
        /* ignore */
      }
      resolve(net ?? fallbackHomeNetwork(interfaces ?? os.networkInterfaces()));
    };
    try {
      s = dgram.createSocket('udp4');
      s.on('error', () => finish(null));
      // connect() on UDP only selects a route; no packet is sent.
      s.connect(53, '1.1.1.1', (err) => {
        if (err) return finish(null);
        try {
          const address = s.address().address;
          if (!address || address === '0.0.0.0') return finish(null);
          finish(networkFor(address, interfaces ?? os.networkInterfaces()));
        } catch {
          finish(null);
        }
      });
    } catch {
      finish(null);
    }
  });
}

/** Authorizes the home range and creates a collector for this computer. Returns its enrollment token. */
async function enrollThisComputer(api, cidr) {
  const sites = await api.call('GET', '/sites');
  const site = sites.json?.items?.[0];
  if (!site) throw new Error('No site found in the local account');
  const scope = await api.call('POST', `/sites/${site.id}/scopes`, { cidr, label: 'Home network', authorization_confirmed: true });
  if (scope.status >= 300 && scope.status !== 409) throw new Error(`Could not authorize ${cidr}: ${scope.json?.error?.message ?? scope.status}`);
  const created = await api.call('POST', '/collectors', { site_id: site.id, name: `${os.hostname()} (this computer)` });
  if (!created.json?.enrollment_token) throw new Error(`Could not create the collector: ${created.json?.error?.message ?? created.status}`);
  return created.json.enrollment_token;
}

module.exports = { LocalStack, findRepoRoot, findNode, signIn, homeNetwork, networkFor, enrollThisComputer };
