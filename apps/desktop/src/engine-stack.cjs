'use strict';
// The desktop app's way to the local stack through the Nigafiy engine (docs/desktop/engine.md).
//
//   - An engine already answers on its control address (the Windows service, or one left running):
//     use its stack and leave it running when the app quits.
//   - None answers: start `nigafiy-engine run` as a child, wait until its stack is ready, and shut it
//     down through the control API on quit (the same lifetime the stack had before the engine).
//
// Same interface as LocalStack (start() → { webUrl, apiUrl }, stop()), so main.cjs can use either.
// No Electron imports here, so this file can be tested with plain Node.
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_CONTROL_URL = 'http://127.0.0.1:47140';
const START_TIMEOUT_MS = 120_000;

/** The stack's parts as the engine reports them (Milestone 5: db, api, web; earlier engines: one "stack"). */
const PARTS = {
  db: { label: 'the database', starting: 'Starting the database…' },
  api: { label: 'the API', starting: 'Starting the API (first start runs the database migrations)…' },
  web: { label: 'the web console', starting: 'Starting the web console…' },
  stack: { label: 'the database, API and web console', starting: 'Starting the database, API and web console…' },
};

/**
 * Where the engine's start-up is: the first part that has failed for good, the latest error, and a
 * message for the part being started (or waited for).
 * @param {any} s /v1/status body, or null
 */
function stackProgress(s) {
  const parts = (s?.children ?? []).filter((c) => c && Object.hasOwn(PARTS, c.name));
  const out = { failed: null, lastError: null, message: null };
  for (const c of parts) {
    if (c.last_error) out.lastError = `${PARTS[c.name].label}: ${c.last_error}`;
    if (c.state === 'failed' && !out.failed) out.failed = { ...c, label: PARTS[c.name].label };
    if (!out.message && (c.state === 'starting' || c.state === 'backoff')) out.message = PARTS[c.name].starting;
  }
  return out;
}

const CHILD_STATES = new Set(['stopped', 'starting', 'running', 'backoff', 'failed']);
const clip = (v, max = 400) => (typeof v === 'string' ? v.slice(0, max) : null);

/**
 * What the desktop panel shows of an engine status: each part's state, health, restarts and last
 * error. Only known fields, length-limited (the panel renders them as text only).
 * @param {any} s /v1/status body, or null when no engine answers
 */
function summarizeEngine(s) {
  if (!s || typeof s !== 'object' || !Array.isArray(s.children)) return { reachable: false };
  return {
    reachable: true,
    mode: s.mode === 'service' ? 'service' : 'foreground',
    version: clip(s.version, 64),
    children: s.children.slice(0, 16).map((c) => ({
      name: clip(c?.name, 32) ?? '?',
      state: CHILD_STATES.has(c?.state) ? c.state : 'stopped',
      health: c?.health === 'ok' || c?.health === 'failing' ? c.health : null,
      restarts: Number.isInteger(c?.restarts) && c.restarts >= 0 ? c.restarts : 0,
      lastError: clip(c?.last_error),
      healthError: clip(c?.health_error),
      waitingFor: clip(c?.waiting_for, 32),
    })),
  };
}

/** The child engine's command line. */
function engineArgs(o) {
  const args = [
    'run',
    `--data-dir=${o.dataDir}`,
    `--node=${o.nodePath}`,
    `--stack-script=${o.script}`,
    // The desktop app runs the Sensor itself (its panel shows enrollment and activity); a
    // child engine only runs the stack. The service-mode engine runs the Sensor (Milestone 5 installer).
    '--no-sensor',
  ];
  // Installed app: the engine needs the bundle folder for updates and the installed programs
  // (audit item 5, 2026-11-27: it used to get none and refused every update).
  if (o.env?.NIGAFIY_BUNDLE_DIR) args.push(`--bundle-dir=${o.env.NIGAFIY_BUNDLE_DIR}`);
  if (o.controlUrl !== DEFAULT_CONTROL_URL) args.push(`--control-addr=${new URL(o.controlUrl).host}`);
  return args;
}

class EngineStack {
  /**
   * @param {{
   *   engineExe: string,           nigafiy-engine executable
   *   dataDir: string,             the stack's data folder (database, logs, engine token)
   *   nodePath: string,            Node 24 (checkout) or Electron's exe (installed, with ELECTRON_RUN_AS_NODE=1 in env)
   *   script: string,              scripts/local.mjs or resources/backend/local.mjs
   *   env?: Record<string,string>,
   *   onStatus?: (msg: string) => void,
   *   controlUrl?: string,
   *   fetchImpl?: typeof fetch,
   *   spawnImpl?: typeof spawn,
   *   pollMs?: number,
   * }} options
   */
  constructor(options) {
    this.o = { controlUrl: DEFAULT_CONTROL_URL, fetchImpl: fetch, spawnImpl: spawn, pollMs: 500, env: {}, onStatus: () => undefined, ...options };
    this.child = null;
    this.attached = false;
    this.urls = null;
    this.startingPromise = null;
  }

  /** The engine's /v1/status, or null when no engine answers. */
  async status() {
    try {
      const res = await this.o.fetchImpl(`${this.o.controlUrl}/v1/status`, { signal: AbortSignal.timeout(3500) });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  start() {
    if (this.urls) return Promise.resolve(this.urls);
    this.startingPromise ??= this.#start().finally(() => {
      this.startingPromise = null;
    });
    return this.startingPromise;
  }

  async #start() {
    const existing = await this.status();
    let spawned = null;
    if (existing) {
      this.attached = true;
      this.o.onStatus(existing.mode === 'service' ? 'Connecting to the Nigafiy engine service…' : 'Connecting to the running Nigafiy engine…');
    } else {
      spawned = this.#spawn();
      this.o.onStatus('Starting the Nigafiy engine…');
    }
    const end = Date.now() + START_TIMEOUT_MS;
    let lastError = null;
    while (Date.now() < end) {
      if (spawned && spawned.exitCode !== null) {
        throw new Error(`The engine stopped while starting (exit code ${spawned.exitCode}).${this.stderr ? `\n${this.stderr.trim().slice(-600)}` : ''}`);
      }
      const s = await this.status();
      if (s?.stack?.web_url && s.stack.api_url) {
        this.urls = { webUrl: s.stack.web_url, apiUrl: s.stack.api_url };
        return this.urls;
      }
      const progress = stackProgress(s);
      if (progress.lastError) lastError = progress.lastError;
      if (progress.failed) throw new Error(`The engine could not start ${progress.failed.label}: ${progress.failed.last_error ?? 'unknown error'}`);
      if (progress.message) this.o.onStatus(progress.message);
      await new Promise((r) => setTimeout(r, this.o.pollMs));
    }
    throw new Error(lastError ?? 'Timed out waiting for the Nigafiy engine to start the stack (120 s).');
  }

  #spawn() {
    const env = { ...process.env, ...this.o.env };
    const args = engineArgs(this.o);
    const child = this.o.spawnImpl(this.o.engineExe, args, { env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    this.stderr = '';
    child.stderr?.on('data', (d) => {
      this.stderr = (this.stderr + d).slice(-4000);
    });
    child.on('exit', () => {
      if (this.child === child) {
        this.child = null;
        this.urls = null;
      }
    });
    this.child = child;
    return child;
  }

  /** Engine the app started: shut it down. Engine that was already running (service): leave it. */
  async stop() {
    this.urls = null;
    const child = this.child;
    if (this.attached || !child) return;
    const exited = new Promise((resolve) => {
      if (child.exitCode !== null) resolve();
      else child.once('exit', resolve);
    });
    let asked = false;
    try {
      const token = fs.readFileSync(path.join(this.o.dataDir, 'engine', 'control-token'), 'utf8').trim();
      const res = await this.o.fetchImpl(`${this.o.controlUrl}/v1/shutdown`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5000),
      });
      asked = res.ok;
    } catch {
      asked = false;
    }
    let timeout;
    const timer = new Promise((resolve) => {
      timeout = setTimeout(resolve, asked ? 30_000 : 0);
    });
    await Promise.race([exited, timer]);
    clearTimeout(timeout);
    if (child.exitCode === null) {
      // Last resort, by PID only (never by image name: the installed app runs the same binaries).
      if (process.platform === 'win32' && child.pid) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      else child.kill('SIGKILL');
      await exited;
    }
  }
}

module.exports = { EngineStack, DEFAULT_CONTROL_URL, engineArgs, stackProgress, summarizeEngine };
