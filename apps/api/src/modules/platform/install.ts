import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { PlatformUpdateInstallStatus, PlatformUpdateSignature } from '@lan-detective/shared-types/programs';
import { z } from 'zod';
import { AppError } from '../../common/http.ts';
import { env } from '../../config/env.ts';
import { logger } from '../../infrastructure/logger.ts';
import { compareVersions, fetchVerifiedManifest, type ManifestPayload } from './updates.ts';

/**
 * Update download, verification, staging and hand-over (docs/operations/updates.md).
 *
 *  1. Download (admin, POST /platform/updates/download): the manifest is fetched and its Ed25519
 *     signature verified again; the configured component (the desktop app's NSIS installer) is
 *     downloaded over HTTPS only (every redirect too), never more than the size the signed manifest
 *     states or NIGAFIY_UPDATE_MAX_BYTES; its SHA-256 must equal the manifest's; when a publisher
 *     thumbprint is configured its Authenticode signature must be Valid and made by that
 *     certificate. Only then is it moved to <data>/updates/staged/Nigafiy-Update-<version>.exe.
 *  2. Install (admin, POST /platform/updates/install with confirm: true): the staged file is hashed
 *     again and handed to the engine (POST /v1/update/apply with the control token). The engine
 *     checks it once more, stops every part, and its update helper runs the installer silently over
 *     the same folder and starts everything again. Nothing is ever installed without this request.
 */

const STAGED_RE = /^Nigafiy-Update-\d+\.\d+\.\d+\.exe$/;
const MAX_REDIRECTS = 5;
const IDLE_TIMEOUT_MS = 60_000;

/** <data>/updates: the engine's data folder when the engine started the API, else <repo>/.data. */
export function updatesDir(dataDir: string | undefined = env.NIGAFIY_DATA_DIR): string {
  const base = dataDir ? path.resolve(dataDir) : path.resolve(import.meta.dirname, '../../../../../.data');
  return path.join(base, 'updates');
}
const stagingDir = (dir: string) => path.join(dir, 'staged');
const recordFile = (dir: string) => path.join(stagingDir(dir), 'staged.json');

const stagedRecordSchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  file: z.string().regex(STAGED_RE),
  size: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  component: z.string(),
  signature: z.object({ status: z.string().max(64), thumbprint: z.string().max(64).nullable(), checked: z.boolean() }),
  staged_at: z.string(),
  staged_by: z.string().max(320),
});
export type StagedRecord = z.infer<typeof stagedRecordSchema>;

// ── HTTPS download ───────────────────────────────────────────────────────────

export interface DownloadOptions {
  url: string;
  size: number;
  sha256: string;
  dest: string;
  maxBytes: number;
  /** Extra trusted CA (tests: a local HTTPS server). */
  ca?: string | Buffer;
  onProgress?: (received: number) => void;
}

export class DownloadError extends Error {}

function get(url: URL, ca: DownloadOptions['ca']): Promise<import('node:http').IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { ca, headers: { 'user-agent': 'nigafiy-updater', accept: 'application/octet-stream' } }, resolve);
    req.setTimeout(IDLE_TIMEOUT_MS, () => req.destroy(new DownloadError('the download stalled')));
    req.on('error', reject);
  });
}

/**
 * Downloads `url` to `dest` over HTTPS only. Fails (and leaves nothing at dest) when a redirect
 * leaves HTTPS, when more bytes arrive than the signed size (or the limit), when fewer arrive, or
 * when the SHA-256 differs.
 */
export async function downloadVerified(o: DownloadOptions): Promise<void> {
  if (o.size > o.maxBytes) throw new DownloadError(`the release is ${o.size} bytes, more than the ${o.maxBytes}-byte limit`);
  let url = new URL(o.url);
  let res: import('node:http').IncomingMessage | null = null;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (url.protocol !== 'https:') throw new DownloadError('update downloads must use HTTPS (a redirect left HTTPS)');
    res = await get(url, o.ca);
    const code = res.statusCode ?? 0;
    if (code >= 300 && code < 400 && res.headers.location) {
      res.resume();
      url = new URL(res.headers.location, url);
      res = null;
      continue;
    }
    break;
  }
  if (!res) throw new DownloadError('too many redirects');
  if (res.statusCode !== 200) {
    res.resume();
    throw new DownloadError(`the download server answered HTTP ${res.statusCode}`);
  }
  const declared = Number(res.headers['content-length'] ?? 0);
  if (declared && declared !== o.size) {
    res.resume();
    throw new DownloadError(`the server announces ${declared} bytes, the signed manifest ${o.size}`);
  }
  const part = `${o.dest}.part`;
  rmSync(part, { force: true });
  const hash = createHash('sha256');
  let received = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      received += chunk.length;
      if (received > o.size) {
        cb(new DownloadError(`more data than the ${o.size} bytes in the signed manifest`));
        return;
      }
      hash.update(chunk);
      o.onProgress?.(received);
      cb(null, chunk);
    },
  });
  try {
    await pipeline(res, meter, createWriteStream(part, { mode: 0o600 }));
    if (received !== o.size) throw new DownloadError(`received ${received} bytes, the signed manifest says ${o.size}`);
    const got = hash.digest('hex');
    if (got !== o.sha256) throw new DownloadError(`SHA-256 ${got} does not match the signed manifest (${o.sha256})`);
    rmSync(o.dest, { force: true });
    renameSync(part, o.dest);
  } catch (err) {
    rmSync(part, { force: true });
    throw err;
  }
}

export async function hashFile(file: string): Promise<string> {
  const h = createHash('sha256');
  await pipeline(createReadStream(file), h);
  return h.digest('hex');
}

// ── Authenticode ─────────────────────────────────────────────────────────────

export type SignatureChecker = (file: string) => Promise<{ status: string; thumbprint: string | null }>;

/** Get-AuthenticodeSignature (built into Windows PowerShell); the path is passed in the environment. */
export const checkAuthenticode: SignatureChecker = (file) =>
  new Promise((resolve, reject) => {
    if (process.platform !== 'win32') {
      reject(new Error('Authenticode signatures can only be checked on Windows'));
      return;
    }
    const script =
      "$ErrorActionPreference='Stop'; $s = Get-AuthenticodeSignature -LiteralPath $env:NIGAFIY_VERIFY_PATH; " +
      "$t = ''; if ($s.SignerCertificate) { $t = $s.SignerCertificate.Thumbprint }; " +
      '[pscustomobject]@{ status = [string]$s.Status; thumbprint = [string]$t } | ConvertTo-Json -Compress';
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { env: { ...process.env, NIGAFIY_VERIFY_PATH: file }, windowsHide: true, timeout: 60_000 },
      (err, stdout) => {
        if (err) {
          reject(new Error(`Get-AuthenticodeSignature failed: ${err.message}`));
          return;
        }
        try {
          const j = JSON.parse(stdout.trim()) as { status?: string; thumbprint?: string };
          resolve({ status: String(j.status ?? ''), thumbprint: j.thumbprint ? String(j.thumbprint).toUpperCase() : null });
        } catch {
          reject(new Error('Get-AuthenticodeSignature gave no readable answer'));
        }
      },
    );
  });

/** Checks the installer's signer against the configured publisher. Throws with the reason. */
export async function checkPublisher(file: string, publisher: string | undefined, check: SignatureChecker): Promise<PlatformUpdateSignature> {
  if (!publisher) return { status: 'not_checked', thumbprint: null, checked: false };
  const sig = await check(file);
  if (sig.status !== 'Valid') throw new DownloadError(`the installer's Authenticode signature is ${sig.status || 'missing'}, not Valid (the publisher certificate must be trusted on this computer)`);
  if (sig.thumbprint !== publisher) throw new DownloadError(`the installer is signed by ${sig.thumbprint ?? 'nobody'}, not by the configured publisher ${publisher}`);
  return { status: sig.status, thumbprint: sig.thumbprint, checked: true };
}

// ── Staging state ────────────────────────────────────────────────────────────

type DownloadState =
  | { state: 'idle' }
  | { state: 'downloading'; version: string; received: number; total: number; started_at: string }
  | { state: 'failed'; version: string; error: string; at: string };

let download: DownloadState = { state: 'idle' };

export function resetInstallState(): void {
  download = { state: 'idle' };
}

/** The staged update, if its record is valid and its file is still there with the right size. */
export function readStaged(dir: string = updatesDir()): StagedRecord | null {
  try {
    const rec = stagedRecordSchema.parse(JSON.parse(readFileSync(recordFile(dir), 'utf8')));
    const file = path.join(stagingDir(dir), rec.file);
    if (!existsSync(file) || statSync(file).size !== rec.size) return null;
    return rec;
  } catch {
    return null;
  }
}

export interface UpdateConfig {
  manifestUrl?: string;
  publicKey?: string;
  component: string;
  publisher?: string;
  maxBytes: number;
  currentVersion: string;
  dir: string;
  ca?: string | Buffer;
  checkSignature: SignatureChecker;
}

export function configuredUpdate(currentVersion: string): UpdateConfig {
  return {
    manifestUrl: env.NIGAFIY_UPDATE_MANIFEST_URL,
    publicKey: env.NIGAFIY_UPDATE_PUBLIC_KEY,
    component: env.NIGAFIY_UPDATE_COMPONENT,
    publisher: env.NIGAFIY_UPDATE_PUBLISHER_THUMBPRINT,
    maxBytes: env.NIGAFIY_UPDATE_MAX_BYTES,
    currentVersion,
    dir: updatesDir(),
    checkSignature: checkAuthenticode,
  };
}

/**
 * Checks everything that can be checked before a download starts and returns the release and its
 * component. Throws an AppError the operator can act on.
 */
export async function prepareDownload(cfg: UpdateConfig): Promise<{ payload: ManifestPayload; component: ManifestPayload['components'][number] }> {
  if (!cfg.manifestUrl || !cfg.publicKey) throw new AppError(409, 'updates_off', 'Update checks are off: no update source or signing key is configured.');
  if (download.state === 'downloading') throw new AppError(409, 'download_in_progress', 'An update is already being downloaded.');
  const m = await fetchVerifiedManifest(cfg.manifestUrl, cfg.publicKey);
  if (!m.ok) throw new AppError(502, `manifest_${m.error}`, `The release manifest could not be used (${m.error}).`);
  if (compareVersions(m.payload.version, cfg.currentVersion) <= 0) throw new AppError(409, 'no_update', `This computer already runs ${cfg.currentVersion}; the newest signed release is ${m.payload.version}.`);
  const component = m.payload.components.find((c) => c.id === cfg.component);
  if (!component) throw new AppError(409, 'no_component', `The signed release ${m.payload.version} has no "${cfg.component}" installer.`);
  if (component.size > cfg.maxBytes) throw new AppError(409, 'too_large', `The installer is ${component.size} bytes, more than the ${cfg.maxBytes}-byte limit.`);
  return { payload: m.payload, component };
}

/**
 * Runs the download in the background (it can take minutes). The returned promise settles when it
 * is over; the HTTP request does not wait for it.
 */
export function startDownload(cfg: UpdateConfig, release: Awaited<ReturnType<typeof prepareDownload>>, stagedBy: string, onDone?: (r: { ok: boolean; error?: string }) => void): Promise<void> {
  const { payload, component } = release;
  download = { state: 'downloading', version: payload.version, received: 0, total: component.size, started_at: new Date().toISOString() };
  const staging = stagingDir(cfg.dir);
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  const name = `Nigafiy-Update-${payload.version}.exe`;
  const dest = path.join(staging, name);
  return (async () => {
    try {
      await downloadVerified({
        url: component.url,
        size: component.size,
        sha256: component.sha256,
        dest,
        maxBytes: cfg.maxBytes,
        ca: cfg.ca,
        onProgress: (received) => {
          if (download.state === 'downloading') download.received = received;
        },
      });
      let signature: PlatformUpdateSignature;
      try {
        signature = await checkPublisher(dest, cfg.publisher, cfg.checkSignature);
      } catch (err) {
        rmSync(dest, { force: true });
        throw err;
      }
      // One staged update at a time: older installers go.
      for (const f of readdirSync(staging)) if (f !== name && (STAGED_RE.test(f) || f.endsWith('.part'))) rmSync(path.join(staging, f), { force: true });
      const record: StagedRecord = {
        version: payload.version,
        file: name,
        size: component.size,
        sha256: component.sha256,
        component: component.id,
        signature,
        staged_at: new Date().toISOString(),
        staged_by: stagedBy,
      };
      writeFileSync(recordFile(cfg.dir), JSON.stringify(record, null, 2), { mode: 0o600 });
      download = { state: 'idle' };
      logger.info({ version: payload.version, sha256: component.sha256 }, 'update staged');
      onDone?.({ ok: true });
    } catch (err) {
      const error = (err as Error).message.slice(0, 500);
      download = { state: 'failed', version: payload.version, error, at: new Date().toISOString() };
      logger.warn({ version: payload.version, err: error }, 'update download failed');
      onDone?.({ ok: false, error });
    }
  })();
}

// ── Hand-over to the engine ──────────────────────────────────────────────────

export interface EngineLink {
  controlUrl: string;
  tokenFile: string;
  fetchImpl?: typeof fetch;
}

export function configuredEngine(): EngineLink {
  const dataDir = env.NIGAFIY_DATA_DIR ? path.resolve(env.NIGAFIY_DATA_DIR) : path.dirname(updatesDir());
  return { controlUrl: env.ENGINE_CONTROL_URL, tokenFile: path.join(dataDir, 'engine', 'control-token') };
}

/** Re-hashes the staged installer and asks the engine to install it. */
export async function requestInstall(version: string, dir: string, engine: EngineLink): Promise<{ version: string }> {
  const rec = readStaged(dir);
  if (!rec) throw new AppError(409, 'nothing_staged', 'No downloaded update is waiting to be installed.');
  if (rec.version !== version) throw new AppError(409, 'version_mismatch', `The staged update is ${rec.version}, not ${version}.`);
  const file = path.join(stagingDir(dir), rec.file);
  const got = await hashFile(file);
  if (got !== rec.sha256) {
    rmSync(file, { force: true });
    rmSync(recordFile(dir), { force: true });
    throw new AppError(409, 'staged_changed', 'The staged installer changed on disk after it was verified; it was deleted. Download it again.');
  }
  if (engine.controlUrl === 'off') throw new AppError(409, 'no_engine', 'No Nigafiy Engine runs this installation, so it cannot install updates.');
  let token: string;
  try {
    token = readFileSync(engine.tokenFile, 'utf8').trim();
  } catch {
    throw new AppError(409, 'no_engine', 'No Nigafiy Engine runs this installation (its control token is missing), so it cannot install updates.');
  }
  let res: Response;
  try {
    res = await (engine.fetchImpl ?? fetch)(`${engine.controlUrl}/v1/update/apply`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ installer: file, sha256: rec.sha256, version: rec.version }),
      signal: AbortSignal.timeout(120_000),
      redirect: 'error',
    });
  } catch {
    throw new AppError(503, 'engine_unreachable', 'The Nigafiy Engine did not answer.');
  }
  if (res.status === 202) return { version: rec.version };
  let message = `HTTP ${res.status}`;
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    if (body.error?.message) message = String(body.error.message).slice(0, 500);
  } catch {
    /* keep the status */
  }
  if (res.status === 409) throw new AppError(409, 'engine_refused', `The engine refused: ${message}`);
  if (res.status === 422) throw new AppError(422, 'update_rejected', `The engine rejected the installer: ${message}`);
  throw new AppError(502, 'engine_error', `The engine could not start the installation: ${message}`);
}

/** What the Hub shows: download progress, the staged update, the engine's last installation. */
export async function installStatus(cfg: UpdateConfig, engine: EngineLink): Promise<PlatformUpdateInstallStatus> {
  const staged = readStaged(cfg.dir);
  let engineUpdate: PlatformUpdateInstallStatus['engine'] = null;
  if (engine.controlUrl !== 'off') {
    try {
      const res = await (engine.fetchImpl ?? fetch)(`${engine.controlUrl}/v1/status`, { signal: AbortSignal.timeout(3500), redirect: 'error' });
      if (res.ok) engineUpdate = parseEngineUpdate(((await res.json()) as { update?: unknown }).update);
    } catch {
      engineUpdate = null;
    }
  }
  return {
    configured: Boolean(cfg.manifestUrl && cfg.publicKey),
    component: cfg.component,
    publisher_pinned: Boolean(cfg.publisher),
    download: { ...download },
    staged: staged
      ? { version: staged.version, size: staged.size, sha256: staged.sha256, signature: staged.signature, staged_at: staged.staged_at, staged_by: staged.staged_by }
      : null,
    engine: engineUpdate,
  };
}

const str = (v: unknown, max = 500): string | null => (typeof v === 'string' ? v.slice(0, max) : null);

function parseEngineUpdate(raw: unknown): PlatformUpdateInstallStatus['engine'] {
  if (!raw || typeof raw !== 'object') return null;
  const u = raw as Record<string, unknown>;
  const last = u.last && typeof u.last === 'object' ? (u.last as Record<string, unknown>) : null;
  return {
    state: u.state === 'applying' ? 'applying' : 'idle',
    version: str(u.version, 40),
    last: last
      ? {
          version: str(last.version, 40) ?? '',
          ok: last.ok === true,
          error: str(last.error),
          finished_at: str(last.finished_at, 64),
          restarted: last.restarted === true,
        }
      : null,
  };
}
