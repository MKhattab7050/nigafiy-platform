'use strict';
// Runs and supervises the bundled lan-collector binary. No Electron imports here, so this file
// can be tested with plain Node.
const { EventEmitter } = require('node:events');
const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const MAX_LOG_LINES = 400;
const SECRET_PATTERN = /ld(?:c|e|ea|a)_[A-Za-z0-9._-]{8,}/g;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const CIDR = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/;

/** https anywhere; plain http only for a server on this same machine (local development). */
function normalizeServerUrl(input) {
  let url;
  try {
    url = new URL(String(input).trim());
  } catch {
    throw new Error('Server address is not a valid URL (example: https://lan-detective.example.com)');
  }
  if (url.username || url.password) throw new Error('Server address must not contain a username or password');
  if (url.protocol === 'http:' && !LOCAL_HOSTS.has(url.hostname)) throw new Error('Server address must use https:// (http is only accepted for localhost)');
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Server address must start with https://');
  return url.origin;
}

/** True when the configured URL points to a plain HTTP server on this machine (local mode). */
function isLocalServerUrl(input) {
  if (!input || !String(input).trim()) return false;
  try {
    const url = new URL(String(input).trim());
    return url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

function parseCidrs(input) {
  const list = (Array.isArray(input) ? input : String(input ?? '').split(/[\s,،]+/)).map((s) => s.trim()).filter(Boolean);
  for (const cidr of list) {
    const m = CIDR.exec(cidr);
    const bits = m ? Number(m[5]) : -1;
    if (!m || m.slice(1, 5).some((o) => Number(o) > 255) || bits < 8 || bits > 32) throw new Error(`"${cidr}" is not a network range (example: 192.168.1.0/24)`);
  }
  return [...new Set(list)];
}

class CollectorManager extends EventEmitter {
  /** @param {{ binaryPath: string, dataDir: string }} options */
  constructor({ binaryPath, dataDir }) {
    super();
    this.binaryPath = binaryPath;
    this.dataDir = dataDir;
    this.stateDir = path.join(dataDir, 'state');
    this.configPath = path.join(dataDir, 'collector.yaml');
    this.settingsPath = path.join(dataDir, 'settings.json');
    fs.mkdirSync(dataDir, { recursive: true });
    this.child = null;
    this.status = 'stopped'; // stopped | starting | running | error
    this.lastError = null;
    this.connected = null; // null = not known yet
    this.lastSweep = null;
    this.logs = [];
    this.wanted = false;
    this.restarts = 0;
    this.restartTimer = null;
    this.pendingToken = null;
    this.settings = this.loadSettings();
  }

  loadSettings() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.settingsPath, 'utf8'));
      return { serverUrl: String(raw.serverUrl ?? ''), allowedCidrs: Array.isArray(raw.allowedCidrs) ? raw.allowedCidrs.map(String) : [], autoStart: raw.autoStart !== false };
    } catch {
      return { serverUrl: '', allowedCidrs: [], autoStart: true };
    }
  }

  binaryAvailable() {
    return fs.existsSync(this.binaryPath);
  }

  isEnrolled() {
    return fs.existsSync(path.join(this.stateDir, 'credential.json'));
  }

  renderConfig(settings, stateDir = this.stateDir) {
    const url = new URL(settings.serverUrl);
    return [
      '# Written by the LAN Detective desktop app. Change these values in the app, not here.',
      `server_url: ${JSON.stringify(settings.serverUrl)}`,
      `state_dir: ${JSON.stringify(stateDir)}`,
      `allowed_cidrs: [${settings.allowedCidrs.map((c) => JSON.stringify(c)).join(', ')}]`,
      `allow_insecure_http: ${url.protocol === 'http:'}`,
      'log_level: info',
      '',
    ].join('\n');
  }

  /** Validates with the collector's own config checker before anything is saved. */
  async saveSettings(input, options = {}) {
    const next = { serverUrl: normalizeServerUrl(input.serverUrl), allowedCidrs: parseCidrs(input.allowedCidrs), autoStart: input.autoStart !== false };
    if (!this.binaryAvailable()) throw new Error('The collector program is missing from this installation');
    const probe = path.join(this.dataDir, `collector.check.${process.pid}.${Date.now()}.yaml`);
    fs.writeFileSync(probe, this.renderConfig(next), { mode: 0o600 });
    try {
      await new Promise((resolve, reject) => {
        execFile(this.binaryPath, ['-config', probe, '-check-config'], { timeout: 10_000, windowsHide: true }, (err, _stdout, stderr) => {
          if (err) reject(new Error(this.redact(stderr.trim() || err.message)));
          else resolve();
        });
      });
    } finally {
      fs.rmSync(probe, { force: true });
    }
    const serverChanged = next.serverUrl !== this.settings.serverUrl;
    this.settings = next;
    fs.writeFileSync(this.settingsPath, JSON.stringify(next, null, 2), { mode: 0o600 });
    fs.writeFileSync(this.configPath, this.renderConfig(next), { mode: 0o600 });
    const wasRunning = this.child !== null;
    if (serverChanged && !options.preserveIdentity && (this.isEnrolled() || wasRunning)) {
      await this.resetIdentity();
    } else if (wasRunning) {
      await this.stop();
      if (this.isEnrolled()) this.start();
    }
    this.emitState();
    return this.getState();
  }

  redact(text) {
    let out = String(text);
    if (this.pendingToken) out = out.split(this.pendingToken).join('[redacted]');
    return out.replace(SECRET_PATTERN, '[redacted]');
  }

  pushLog(level, message, extra) {
    const entry = { at: new Date().toISOString(), level, message: this.redact(message), ...(extra ? { extra: this.redact(extra) } : {}) };
    this.logs.push(entry);
    if (this.logs.length > MAX_LOG_LINES) this.logs.splice(0, this.logs.length - MAX_LOG_LINES);
    this.emit('log', entry);
  }

  handleLine(line) {
    if (!line.trim()) return;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.pushLog('info', line);
      return;
    }
    const msg = String(parsed.msg ?? '');
    const detail = [parsed.cidr && `${parsed.cidr} — found ${parsed.found} of ${parsed.probed}`, parsed.error, parsed.reason].filter(Boolean).join(' · ');
    this.pushLog(String(parsed.level ?? 'INFO').toLowerCase(), msg, detail || undefined);
    if (msg === 'enrolled' || msg === 'using stored collector identity') this.connected = this.connected ?? true;
    if (msg.startsWith('lost contact with the cloud')) this.connected = false;
    if (msg.startsWith('contact with the cloud restored')) this.connected = true;
    if (msg.startsWith('the cloud refused this collector')) {
      this.connected = false;
      this.lastError = 'The server rejected this collector’s identity (it may have been revoked). Enroll again with a new token.';
    }
    if (msg === 'discovery sweep finished') this.lastSweep = { at: parsed.time ?? new Date().toISOString(), cidr: parsed.cidr, found: parsed.found, probed: parsed.probed };
    if (msg === 'collector stopped with an error' && parsed.error) this.lastError = this.redact(parsed.error);
    this.emitState();
  }

  /** @param {{ enrollmentToken?: string }} [options] The token is passed through the environment only; it is never written to disk or logged. */
  start(options = {}) {
    if (this.child) return this.getState();
    if (!this.settings.serverUrl) throw new Error('Set the server address first');
    if (!this.binaryAvailable()) throw new Error('The collector program is missing from this installation');
    const token = options.enrollmentToken ? String(options.enrollmentToken).trim() : '';
    if (!this.isEnrolled() && !token) throw new Error('This computer is not enrolled yet. Paste an enrollment token from LAN Detective → Discovery & Collectors.');
    if (token && !/^lde_[A-Za-z0-9_-]{20,200}$/.test(token)) throw new Error('That does not look like an enrollment token (it starts with "lde_")');

    fs.writeFileSync(this.configPath, this.renderConfig(this.settings), { mode: 0o600 });
    clearTimeout(this.restartTimer);
    this.wanted = true;
    this.status = 'starting';
    this.lastError = null;
    this.connected = null;
    this.pendingToken = token || null;

    const env = { ...process.env };
    delete env.LAN_COLLECTOR_ENROLLMENT_TOKEN;
    if (token) env.LAN_COLLECTOR_ENROLLMENT_TOKEN = token;
    const child = spawn(this.binaryPath, ['-config', this.configPath], { env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    this.child = child;
    const startedAt = Date.now();

    let buffer = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) this.handleLine(line);
    });
    const alive = setTimeout(() => {
      if (this.child === child) {
        this.status = 'running';
        this.emitState();
      }
    }, 1200);
    child.on('error', (err) => {
      clearTimeout(alive);
      if (this.child === child) {
        this.child = null;
        this.pendingToken = null;
        this.wanted = false;
      }
      this.status = 'error';
      this.lastError = `Could not start the collector: ${err.message}`;
      this.emitState();
    });
    child.on('exit', (code) => {
      clearTimeout(alive);
      if (buffer) this.handleLine(buffer);
      if (this.child !== child) return;
      this.child = null;
      this.pendingToken = null;
      if (!this.wanted) {
        this.status = 'stopped';
      } else {
        this.status = 'error';
        this.lastError ??= `The collector stopped unexpectedly (exit code ${code})`;
        // A collector that ran for a while and then died is restarted; one that fails immediately
        // (bad token, bad config) is not — retrying would only repeat the same failure.
        const ranFor = Date.now() - startedAt;
        if (ranFor > 60_000) this.restarts = 0;
        if (ranFor > 30_000 && this.isEnrolled() && this.restarts < 5) {
          this.restarts += 1;
          const delay = Math.min(60_000, 2000 * 2 ** this.restarts);
          this.pushLog('warn', `collector exited; restarting in ${Math.round(delay / 1000)} s`);
          this.restartTimer = setTimeout(() => {
            try {
              this.start();
            } catch (err) {
              this.lastError = err.message;
              this.emitState();
            }
          }, delay);
        } else {
          this.wanted = false;
        }
      }
      this.emitState();
    });
    this.emitState();
    return this.getState();
  }

  stop() {
    this.wanted = false;
    clearTimeout(this.restartTimer);
    const child = this.child;
    if (!child) {
      this.status = 'stopped';
      this.emitState();
      return Promise.resolve(this.getState());
    }
    return new Promise((resolve) => {
      const force = setTimeout(() => child.kill('SIGKILL'), 5000);
      child.once('exit', () => {
        clearTimeout(force);
        resolve(this.getState());
      });
      // On Windows this terminates the process directly. That is safe: every batch is written to
      // the collector's on-disk spool before upload, so at most a few seconds of samples are lost.
      child.kill();
    });
  }

  /** Forget this computer's collector identity (after it was revoked, or to move to another server). */
  async resetIdentity() {
    await this.stop();
    fs.rmSync(this.stateDir, { recursive: true, force: true });
    this.lastError = null;
    this.connected = null;
    this.lastSweep = null;
    this.pushLog('info', 'collector identity removed from this computer');
    this.emitState();
    return this.getState();
  }

  getState() {
    return {
      status: this.status,
      enrolled: this.isEnrolled(),
      connected: this.child ? this.connected : null,
      binaryAvailable: this.binaryAvailable(),
      lastError: this.lastError,
      lastSweep: this.lastSweep,
      settings: this.settings,
      logs: this.logs.slice(-150),
    };
  }

  emitState() {
    this.emit('state', this.getState());
  }
}

module.exports = { CollectorManager, normalizeServerUrl, isLocalServerUrl, parseCidrs };
