import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { PROGRAMS } from '@lan-detective/shared-types/programs';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { engineStatus } from '../src/modules/platform/engine.ts';
import { installedPrograms } from '../src/modules/platform/index.ts';
import { checkForUpdates, compareVersions } from '../src/modules/platform/updates.ts';
import { CSRF, app, newAccount, setRole } from './helpers.ts';

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

async function serve(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return { publicKey: raw.toString('base64'), privateKey };
}

function manifest(privateKey: ReturnType<typeof keyPair>['privateKey'], payload: unknown) {
  const bytes = Buffer.from(JSON.stringify(payload));
  return JSON.stringify({ payload: bytes.toString('base64'), signature: sign(null, bytes, privateKey).toString('base64') });
}

const RELEASE = {
  schema: 1,
  product: 'nigafiy',
  version: '0.3.0',
  released_at: '2026-11-20T10:00:00.000Z',
  notes_url: 'https://example.test/changelog',
  components: [{ id: 'hub', version: '0.3.0', url: 'https://example.test/hub.exe', size: 1234, sha256: 'a'.repeat(64) }],
};

describe('platform: programs, engine status, update check', () => {
  it('lists every program with its pages, all bundled with this install, to any role', async () => {
    const acct = await newAccount('platform');
    await setRole(acct.email, acct.organizationId, 'viewer');
    const res = await acct.agent.get('/api/v1/platform/programs');
    expect(res.status).toBe(200);
    expect(res.body.items.map((p: { id: string }) => p.id)).toEqual(['hub', 'radar', 'watch', 'guard', 'fleet', 'mind', 'toolbox']);
    for (const p of res.body.items) {
      expect(p.installed).toBe(true);
      expect(p.install_source).toBe('bundled');
      expect(p.pages).toContain(p.home);
    }
    // Every page belongs to exactly one program.
    const pages = PROGRAMS.flatMap((p) => p.pages);
    expect(new Set(pages).size).toBe(pages.length);
  });

  it('reports programs left out by NIGAFIY_PROGRAMS as not installed, and Hub always installed', () => {
    const some = installedPrograms('radar,watch');
    const state = Object.fromEntries(some.items.map((p) => [p.id, [p.installed, p.install_source]]));
    expect(state).toEqual({
      hub: [true, 'bundled'],
      radar: [true, 'bundled'],
      watch: [true, 'bundled'],
      guard: [false, null],
      fleet: [false, null],
      mind: [false, null],
      toolbox: [false, null],
    });
    // Not installed programs are still listed (with their pages) so the UI can offer "install".
    expect(some.items.find((p) => p.id === 'guard')?.pages).toContain('/guard/security');
    expect(installedPrograms('all').items.every((p) => p.installed)).toBe(true);
    expect(installedPrograms('hub').items.filter((p) => p.installed).map((p) => p.id)).toEqual(['hub']);
  });

  it('refuses to start with an unknown program id in NIGAFIY_PROGRAMS', () => {
    const run = (value: string) =>
      spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./src/config/env.ts')"], {
        cwd: path.resolve(import.meta.dirname, '..'),
        env: { ...process.env, NIGAFIY_PROGRAMS: value, DATABASE_URL: 'postgres://x', APP_DATABASE_URL: 'postgres://x', APP_ENCRYPTION_KEY: 'a'.repeat(64) },
        encoding: 'utf8',
      });
    const bad = run('hub,radar,bogus');
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toContain('NIGAFIY_PROGRAMS');
    expect(bad.stderr).not.toContain('a'.repeat(64));
    expect(run('Hub, Radar').status).toBe(0);
  });

  it('requires a session', async () => {
    expect((await request(app).get('/api/v1/platform/programs')).status).toBe(401);
    expect((await request(app).get('/api/v1/platform/engine')).status).toBe(401);
  });

  it('says the engine is not running when nothing listens on the control address', async () => {
    const acct = await newAccount('noengine');
    const res = await acct.agent.get('/api/v1/platform/engine');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ reachable: false, reason: 'not_running' });
  });

  it('passes on only the known, secret-free fields of the engine status', async () => {
    const url = await serve((req, res) => {
      expect(req.url).toBe('/v1/status');
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          version: '0.1.0',
          mode: 'service',
          data_dir: 'C:\\ProgramData\\Nigafiy',
          started_at: '2026-11-21T08:00:00Z',
          stack: { web_url: 'http://127.0.0.1:47130', api_url: 'http://127.0.0.1:47100' },
          children: [
            { name: 'stack', state: 'running', pid: 4242, restarts: 1, last_error: null, started_at: '2026-11-21T08:00:01Z', token: 'ldc_secret' },
            { name: 'sensor', state: 'stopped', pid: null, restarts: 0, last_error: 'not enrolled', started_at: null },
          ],
        }),
      );
    });
    const status = await engineStatus(url);
    expect(status).toEqual({
      reachable: true,
      version: '0.1.0',
      mode: 'service',
      started_at: '2026-11-21T08:00:00Z',
      children: [
        { name: 'stack', state: 'running', pid: 4242, restarts: 1, last_error: null, started_at: '2026-11-21T08:00:01Z' },
        { name: 'sensor', state: 'stopped', pid: null, restarts: 0, last_error: 'not enrolled', started_at: null },
      ],
    });
    expect(JSON.stringify(status)).not.toContain('ProgramData');
    expect(JSON.stringify(status)).not.toContain('ldc_');
  });

  it('reports a malformed or failing engine reply as bad_response, never as healthy', async () => {
    const broken = await serve((_req, res) => res.end('{"version":"1","children":"nope"}'));
    expect(await engineStatus(broken)).toEqual({ reachable: false, reason: 'bad_response' });
    const failing = await serve((_req, res) => {
      res.statusCode = 500;
      res.end();
    });
    expect(await engineStatus(failing)).toEqual({ reachable: false, reason: 'bad_response' });
    expect(await engineStatus('off')).toEqual({ reachable: false, reason: 'not_running' });
  });

  it('says update checks are off without a source or a key', async () => {
    expect(await checkForUpdates({ currentVersion: '0.1.0' })).toEqual({ configured: false, reason: 'no_source', current_version: '0.1.0' });
    expect(await checkForUpdates({ currentVersion: '0.1.0', manifestUrl: 'https://example.test/m.json' })).toEqual({
      configured: false,
      reason: 'no_key',
      current_version: '0.1.0',
    });
    const acct = await newAccount('updates');
    const res = await acct.agent.get('/api/v1/platform/updates');
    expect(res.status).toBe(200);
    expect(res.body.configured).toBe(false);
  });

  it('finds a newer signed release, and rejects a tampered or wrongly signed manifest', async () => {
    const keys = keyPair();
    const good = manifest(keys.privateKey, RELEASE);
    let body = good;
    const url = await serve((_req, res) => res.end(body));

    const found = await checkForUpdates({ currentVersion: '0.1.0', manifestUrl: url, publicKey: keys.publicKey }, new Date('2026-11-21T09:00:00Z'));
    expect(found).toEqual({
      configured: true,
      current_version: '0.1.0',
      checked_at: '2026-11-21T09:00:00.000Z',
      ok: true,
      latest_version: '0.3.0',
      update_available: true,
      released_at: '2026-11-20T10:00:00.000Z',
      notes_url: 'https://example.test/changelog',
    });
    const same = await checkForUpdates({ currentVersion: '0.3.0', manifestUrl: url, publicKey: keys.publicKey });
    expect(same.configured && same.ok && same.update_available).toBe(false);

    // Payload changed after signing.
    const envelope = JSON.parse(good);
    envelope.payload = Buffer.from(JSON.stringify({ ...RELEASE, version: '9.9.9' })).toString('base64');
    body = JSON.stringify(envelope);
    expect(await checkForUpdates({ currentVersion: '0.1.0', manifestUrl: url, publicKey: keys.publicKey })).toMatchObject({ ok: false, error: 'bad_signature' });

    // Signed by someone else.
    body = manifest(keyPair().privateKey, RELEASE);
    expect(await checkForUpdates({ currentVersion: '0.1.0', manifestUrl: url, publicKey: keys.publicKey })).toMatchObject({ ok: false, error: 'bad_signature' });

    // Correctly signed but not a valid manifest (component over plain http).
    body = manifest(keys.privateKey, { ...RELEASE, components: [{ ...RELEASE.components[0], url: 'http://example.test/hub.exe' }] });
    expect(await checkForUpdates({ currentVersion: '0.1.0', manifestUrl: url, publicKey: keys.publicKey })).toMatchObject({ ok: false, error: 'bad_manifest' });

    body = 'not json';
    expect(await checkForUpdates({ currentVersion: '0.1.0', manifestUrl: url, publicKey: keys.publicKey })).toMatchObject({ ok: false, error: 'bad_manifest' });
  });

  it('reports an unreachable update source as an error, not as up to date', async () => {
    const keys = keyPair();
    expect(await checkForUpdates({ currentVersion: '0.1.0', manifestUrl: 'http://127.0.0.1:47199/m.json', publicKey: keys.publicKey })).toMatchObject({
      configured: true,
      ok: false,
      error: 'unreachable',
    });
  });

  it('lets only admins force a re-check', async () => {
    const acct = await newAccount('recheck');
    expect((await acct.agent.post('/api/v1/platform/updates/check').set(CSRF)).status).toBe(200);
    await setRole(acct.email, acct.organizationId, 'technician');
    expect((await acct.agent.post('/api/v1/platform/updates/check').set(CSRF)).status).toBe(403);
  });

  it('compares versions numerically', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.2.3', '1.3.0')).toBe(-1);
  });
});
