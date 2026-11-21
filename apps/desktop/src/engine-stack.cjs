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
      const stack = s?.children?.find((c) => c.name === 'stack');
      if (stack?.last_error) lastError = stack.last_error;
      if (stack?.state === 'failed') throw new Error(`The engine could not start the database, API and web console: ${stack.last_error ?? 'unknown error'}`);
      if (stack?.state === 'starting') this.o.onStatus('Starting the database, API and web console…');
      await new Promise((r) => setTimeout(r, this.o.pollMs));
    }
    throw new Error(lastError ?? 'Timed out waiting for the Nigafiy engine to start the stack (120 s).');
  }

  #spawn() {
    const env = { ...process.env, ...this.o.env };
    const args = [
      'run',
      `--data-dir=${this.o.dataDir}`,
      `--node=${this.o.nodePath}`,
      `--stack-script=${this.o.script}`,
      // The desktop app runs the Sensor itself (its panel shows enrollment and activity); a
      // child engine only runs the stack. The service-mode engine runs the Sensor (Milestone 5 installer).
      '--no-sensor',
    ];
    if (this.o.controlUrl !== DEFAULT_CONTROL_URL) args.push(`--control-addr=${new URL(this.o.controlUrl).host}`);
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

module.exports = { EngineStack, DEFAULT_CONTROL_URL };
