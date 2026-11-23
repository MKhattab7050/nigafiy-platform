import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { systemPool } from '../src/infrastructure/db.ts';
import { ensureLanTls } from '../src/infrastructure/lan-tls.ts';
import {
  checkPublisher,
  downloadVerified,
  installStatus,
  prepareDownload,
  readStaged,
  requestInstall,
  resetInstallState,
  startDownload,
  type UpdateConfig,
} from '../src/modules/platform/install.ts';
import { CSRF, newAccount, setRole } from './helpers.ts';

// A local HTTPS server (tests only) with a CA made for it; nothing leaves this computer.
const root = mkdtempSync(path.join(os.tmpdir(), 'ld-updates-'));
const tlsMat = ensureLanTls(path.join(root, 'tls'), { hostnames: ['localhost'], ipAddresses: ['127.0.0.1'] });
const ca = readFileSync(tlsMat.caFile);
const cert = readFileSync(tlsMat.certFile);
const key = readFileSync(tlsMat.keyFile);

const servers: Array<http.Server | https.Server> = [];
afterEach(async () => {
  resetInstallState();
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

async function serveHttps(handler: http.RequestListener): Promise<string> {
  const s = https.createServer({ cert, key }, handler);
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return `https://127.0.0.1:${(s.address() as AddressInfo).port}`;
}
async function serveHttp(handler: http.RequestListener): Promise<string> {
  const s = http.createServer(handler);
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

const INSTALLER = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200_000, 7)]);
const SHA = createHash('sha256').update(INSTALLER).digest('hex');
const tmp = () => mkdtempSync(path.join(root, 'case-'));

function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { publicKey: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64'), privateKey };
}
function signedManifest(privateKey: ReturnType<typeof keyPair>['privateKey'], payload: unknown) {
  const bytes = Buffer.from(JSON.stringify(payload));
  return JSON.stringify({ payload: bytes.toString('base64'), signature: sign(null, bytes, privateKey).toString('base64') });
}

describe('update download: HTTPS only, signed size and SHA-256', () => {
  it('downloads and verifies, following an HTTPS redirect', async () => {
    const base = await serveHttps((req, res) => {
      if (req.url === '/latest') {
        res.writeHead(302, { location: '/files/setup.exe' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-length': INSTALLER.length });
      res.end(INSTALLER);
    });
    const dest = path.join(tmp(), 'out.exe');
    let progress = 0;
    await downloadVerified({ url: `${base}/latest`, size: INSTALLER.length, sha256: SHA, dest, maxBytes: 10_000_000, ca, onProgress: (n) => (progress = n) });
    expect(createHash('sha256').update(readFileSync(dest)).digest('hex')).toBe(SHA);
    expect(progress).toBe(INSTALLER.length);
  });

  it('refuses a redirect that leaves HTTPS, a wrong hash, too many or too few bytes, and an over-limit size', async () => {
    const plain = await serveHttp((_req, res) => res.end(INSTALLER));
    const base = await serveHttps((req, res) => {
      if (req.url === '/to-http') {
        res.writeHead(301, { location: `${plain}/x.exe` });
        res.end();
      } else if (req.url === '/more') {
        res.write(INSTALLER); // chunked: no length announced, so only the byte count can catch it
        res.end(Buffer.from('extra'));
      } else if (req.url === '/less') {
        res.end(INSTALLER.subarray(0, 1000));
      } else if (req.url === '/missing') {
        res.writeHead(404);
        res.end();
      } else res.end(INSTALLER);
    });
    const dir = tmp();
    const dest = path.join(dir, 'out.exe');
    const opts = { size: INSTALLER.length, sha256: SHA, dest, maxBytes: 10_000_000, ca };
    await expect(downloadVerified({ ...opts, url: `${base}/to-http` })).rejects.toThrow(/HTTPS/);
    await expect(downloadVerified({ ...opts, url: `${base}/more` })).rejects.toThrow(/more data than/);
    await expect(downloadVerified({ ...opts, url: `${base}/less` })).rejects.toThrow(/the server announces|received 1000 bytes/);
    await expect(downloadVerified({ ...opts, url: `${base}/ok`, sha256: 'b'.repeat(64) })).rejects.toThrow(/does not match the signed manifest/);
    await expect(downloadVerified({ ...opts, url: `${base}/missing` })).rejects.toThrow(/HTTP 404/);
    await expect(downloadVerified({ ...opts, url: `${base}/ok`, maxBytes: 1000 })).rejects.toThrow(/limit/);
    // A server whose certificate is not trusted is refused.
    await expect(downloadVerified({ ...opts, url: `${base}/ok`, ca: undefined })).rejects.toThrow();
    // Nothing half-downloaded or unverified is left behind.
    expect(() => readFileSync(dest)).toThrow();
    expect(() => readFileSync(`${dest}.part`)).toThrow();
  });

  it('checks the Authenticode signer only when a publisher is pinned', async () => {
    const tp = 'A'.repeat(40);
    expect(await checkPublisher('x', undefined, async () => ({ status: 'NotSigned', thumbprint: null }))).toEqual({ status: 'not_checked', thumbprint: null, checked: false });
    await expect(checkPublisher('x', tp, async () => ({ status: 'NotSigned', thumbprint: null }))).rejects.toThrow(/NotSigned, not Valid/);
    await expect(checkPublisher('x', tp, async () => ({ status: 'Valid', thumbprint: 'B'.repeat(40) }))).rejects.toThrow(/not by the configured publisher/);
    expect(await checkPublisher('x', tp, async () => ({ status: 'Valid', thumbprint: tp }))).toEqual({ status: 'Valid', thumbprint: tp, checked: true });
  });
});

describe('update staging and hand-over to the engine', () => {
  it('stages a verified release and hands it to the engine with the control token', async () => {
    const keys = keyPair();
    const files = await serveHttps((_req, res) => res.end(INSTALLER));
    const manifestUrl = await serveHttp((_req, res) =>
      res.end(signedManifest(keys.privateKey, { schema: 1, product: 'nigafiy', version: '0.2.0', components: [{ id: 'desktop-windows-x64', version: '0.2.0', url: `${files}/setup.exe`, size: INSTALLER.length, sha256: SHA }] })),
    );
    const dir = tmp();
    const cfg: UpdateConfig = { manifestUrl, publicKey: keys.publicKey, component: 'desktop-windows-x64', maxBytes: 10_000_000, currentVersion: '0.1.0', dir, ca, checkSignature: async () => ({ status: 'NotSigned', thumbprint: null }) };

    const release = await prepareDownload(cfg);
    expect(release.payload.version).toBe('0.2.0');
    let done: { ok: boolean; error?: string } | null = null;
    await startDownload(cfg, release, 'owner@example.test', (r) => (done = r));
    expect(done).toEqual({ ok: true });
    const staged = readStaged(dir);
    expect(staged).toMatchObject({ version: '0.2.0', sha256: SHA, size: INSTALLER.length, file: 'Nigafiy-Update-0.2.0.exe', staged_by: 'owner@example.test', signature: { checked: false } });

    // The engine side: a stand-in control API that records what it is asked.
    let applied: { auth?: string; body?: Record<string, string> } = {};
    const engineUrl = await serveHttp((req, res) => {
      if (req.url === '/v1/status') {
        res.end(JSON.stringify({ update: { state: 'idle', version: null, last: { version: '0.1.0', ok: true, error: null, finished_at: '2026-11-20T00:00:00Z', restarted: true, exit_code: 0 } } }));
        return;
      }
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        applied = { auth: req.headers.authorization, body: JSON.parse(b) };
        res.writeHead(202, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ state: 'applying', version: '0.2.0', last: null }));
      });
    });
    const tokenFile = path.join(dir, 'control-token');
    writeFileSync(tokenFile, 'f'.repeat(64));
    const engine = { controlUrl: engineUrl, tokenFile };

    await expect(requestInstall('0.3.0', dir, engine)).rejects.toMatchObject({ code: 'version_mismatch' });
    expect(await requestInstall('0.2.0', dir, engine)).toEqual({ version: '0.2.0' });
    expect(applied.auth).toBe(`Bearer ${'f'.repeat(64)}`);
    expect(applied.body).toEqual({ installer: path.join(dir, 'staged', 'Nigafiy-Update-0.2.0.exe'), sha256: SHA, version: '0.2.0' });

    const status = await installStatus(cfg, engine);
    expect(status.staged?.version).toBe('0.2.0');
    expect(status.engine).toEqual({ state: 'idle', version: null, last: { version: '0.1.0', ok: true, error: null, finished_at: '2026-11-20T00:00:00Z', restarted: true } });

    // A staged file changed after verification is deleted, never handed over.
    writeFileSync(path.join(dir, 'staged', 'Nigafiy-Update-0.2.0.exe'), Buffer.concat([INSTALLER.subarray(0, -1), Buffer.from([1])]));
    await expect(requestInstall('0.2.0', dir, engine)).rejects.toMatchObject({ code: 'staged_changed' });
    expect(readStaged(dir)).toBeNull();
  });

  it('maps the engine refusing or rejecting, and a missing engine', async () => {
    const dir = tmp();
    mkdirSync(path.join(dir, 'staged'), { recursive: true });
    writeFileSync(path.join(dir, 'staged', 'Nigafiy-Update-0.2.0.exe'), INSTALLER);
    writeFileSync(
      path.join(dir, 'staged', 'staged.json'),
      JSON.stringify({ version: '0.2.0', file: 'Nigafiy-Update-0.2.0.exe', size: INSTALLER.length, sha256: SHA, component: 'desktop-windows-x64', signature: { status: 'not_checked', thumbprint: null, checked: false }, staged_at: new Date().toISOString(), staged_by: 'a@b.c' }),
    );
    const tokenFile = path.join(dir, 'tok');
    await expect(requestInstall('0.2.0', dir, { controlUrl: 'http://127.0.0.1:1', tokenFile })).rejects.toMatchObject({ code: 'no_engine' });
    writeFileSync(tokenFile, 'x');
    let code = 409;
    const url = await serveHttp((_req, res) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'x', message: 'this engine runs from a source checkout' } }));
    });
    await expect(requestInstall('0.2.0', dir, { controlUrl: url, tokenFile })).rejects.toMatchObject({ code: 'engine_refused', status: 409 });
    code = 422;
    await expect(requestInstall('0.2.0', dir, { controlUrl: url, tokenFile })).rejects.toMatchObject({ code: 'update_rejected', status: 422 });
    await expect(requestInstall('0.2.0', dir, { controlUrl: 'http://127.0.0.1:47198', tokenFile })).rejects.toMatchObject({ code: 'engine_unreachable' });
  });

  it('does not stage a release whose signer is not the pinned publisher, nor an older or foreign release', async () => {
    const keys = keyPair();
    const files = await serveHttps((_req, res) => res.end(INSTALLER));
    let version = '0.2.0';
    let id = 'desktop-windows-x64';
    const manifestUrl = await serveHttp((_req, res) =>
      res.end(signedManifest(keys.privateKey, { schema: 1, product: 'nigafiy', version, components: [{ id, version, url: `${files}/s.exe`, size: INSTALLER.length, sha256: SHA }] })),
    );
    const dir = tmp();
    const cfg: UpdateConfig = {
      manifestUrl,
      publicKey: keys.publicKey,
      component: 'desktop-windows-x64',
      publisher: 'C'.repeat(40),
      maxBytes: 10_000_000,
      currentVersion: '0.1.0',
      dir,
      ca,
      checkSignature: async () => ({ status: 'Valid', thumbprint: 'D'.repeat(40) }),
    };
    let done: { ok: boolean; error?: string } | null = null;
    await startDownload(cfg, await prepareDownload(cfg), 'a@b.c', (r) => (done = r));
    expect(done).toMatchObject({ ok: false, error: expect.stringMatching(/not by the configured publisher/) });
    expect(readStaged(dir)).toBeNull();
    expect((await installStatus(cfg, { controlUrl: 'off', tokenFile: 'x' })).download).toMatchObject({ state: 'failed', version: '0.2.0' });

    version = '0.1.0';
    await expect(prepareDownload(cfg)).rejects.toMatchObject({ code: 'no_update' });
    version = '0.3.0';
    id = 'something-else';
    await expect(prepareDownload(cfg)).rejects.toMatchObject({ code: 'no_component' });
    await expect(prepareDownload({ ...cfg, publicKey: keyPair().publicKey })).rejects.toMatchObject({ code: 'manifest_bad_signature' });
    await expect(prepareDownload({ ...cfg, manifestUrl: undefined })).rejects.toMatchObject({ code: 'updates_off' });
  });
});

describe('update routes', () => {
  it('admins only for download and install; install needs confirm and a staged update; refusals are audited', async () => {
    const { app } = await import('./helpers.ts');
    const request = (await import('supertest')).default;
    const acct = await newAccount('updroutes');
    const status = await acct.agent.get('/api/v1/platform/updates/install');
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ configured: false, component: 'desktop-windows-x64', download: { state: 'idle' } });

    // No update source in the test environment: a download is refused, never started.
    const dl = await acct.agent.post('/api/v1/platform/updates/download').set(CSRF);
    expect(dl.status).toBe(409);
    expect(dl.body.error.code).toBe('updates_off');

    expect((await acct.agent.post('/api/v1/platform/updates/install').set(CSRF).send({ version: '9.9.9' })).status).toBe(400);
    const none = await acct.agent.post('/api/v1/platform/updates/install').set(CSRF).send({ version: '9.9.9', confirm: true });
    expect(none.status).toBe(409);
    expect(none.body.error.code).toBe('nothing_staged');
    const rows = await systemPool.query(`SELECT action, metadata FROM audit_logs WHERE organization_id = $1 AND action LIKE 'platform.update.%'`, [acct.organizationId]);
    expect(rows.rows.map((r) => r.action)).toEqual(['platform.update.install_refused']);

    await setRole(acct.email, acct.organizationId, 'technician');
    expect((await acct.agent.post('/api/v1/platform/updates/download').set(CSRF)).status).toBe(403);
    expect((await acct.agent.post('/api/v1/platform/updates/install').set(CSRF).send({ version: '9.9.9', confirm: true })).status).toBe(403);
    expect((await acct.agent.get('/api/v1/platform/updates/install')).status).toBe(200);
    expect((await request(app).get('/api/v1/platform/updates/install')).status).toBe(401);
  });
});

describe('release scripts (scripts/release)', () => {
  it('a manifest built and signed by sign-manifest verifies in the API, and keys stay out of the repository', async () => {
    const { pathToFileURL } = await import('node:url');
    const lib = await import(pathToFileURL(path.resolve(import.meta.dirname, '../../../scripts/release/manifest-lib.mjs')).href);
    const { fetchVerifiedManifest } = await import('../src/modules/platform/updates.ts');
    const dir = tmp();
    const file = path.join(dir, 'Nigafiy-Setup-1.4.0.exe');
    writeFileSync(file, INSTALLER);
    const { privatePem, publicKey } = lib.newKeyPair();
    const payload = await lib.buildPayload({ version: '1.4.0', components: [lib.parseComponentArg(`desktop-windows-x64=${file}@https://downloads.example.test/1.4.0/setup.exe`)], notesUrl: 'https://example.test/notes' });
    const body = JSON.stringify(lib.signPayload(payload, privatePem));
    const url = await serveHttp((_req, res) => res.end(body));
    const m = await fetchVerifiedManifest(url, publicKey);
    expect(m).toMatchObject({ ok: true, payload: { version: '1.4.0', components: [{ id: 'desktop-windows-x64', size: INSTALLER.length, sha256: SHA }] } });
    expect(await fetchVerifiedManifest(url, lib.newKeyPair().publicKey)).toEqual({ ok: false, error: 'bad_signature' });
    expect(lib.insideRepo(path.resolve(import.meta.dirname, 'x.pem'))).toBe(true);
    expect(lib.insideRepo(os.tmpdir())).toBe(false);
    await expect(lib.buildPayload({ version: '1.4', components: [] })).rejects.toThrow(/1\.2\.3/);
  });
});
