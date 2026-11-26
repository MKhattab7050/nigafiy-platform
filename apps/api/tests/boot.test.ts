import { type ChildProcess, spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { newAccount } from './helpers.ts';

/**
 * The API as it really runs: `node src/main.ts`, with every module started and every background job
 * scheduled. The other tests build the app with createApp() and never start the scheduler, so they
 * passed while the real API hung after boot (the jobs held every database connection and sign-in
 * waited forever). This one signs in while all jobs are running.
 */

const API_DIR = path.resolve(import.meta.dirname, '..');

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

async function waitUntil(what: string, ok: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await ok().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('real boot (main.ts with the scheduler)', () => {
  let child: ChildProcess | undefined;
  let output = '';

  afterAll(() => {
    child?.kill();
  });

  it('answers sign-in in under 2 s while every background job runs', { timeout: 120_000 }, async () => {
    const account = await newAccount('boot');
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;

    child = spawn(process.execPath, ['src/main.ts'], {
      cwd: API_DIR,
      // Each job run waits 30 s as if a router or the Internet were slow: real runs overlap like this.
      env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', HTTPS_PORT: '', LOG_LEVEL: 'warn', TEST_LOGS: '1', NIGAFIY_TEST_JOB_WAIT_MS: '30000' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (d: Buffer) => (output = (output + d.toString()).slice(-20_000)));
    child.stderr?.on('data', (d: Buffer) => (output = (output + d.toString()).slice(-20_000)));
    const exited = new Promise<number | null>((resolve) => child!.once('exit', resolve));

    try {
      await waitUntil('the API to listen', async () => (await fetch(`${base}/healthz`)).ok, 60_000);
      // Every job has had its first run start by now (they start 1 s + 250 ms apart).
      await sleep(10_000);
      expect(child.exitCode, `API exited:\n${output}`).toBeNull();

      const ready = await fetch(`${base}/readyz`, { signal: AbortSignal.timeout(10_000) });
      const readyBody = (await ready.json()) as { status: string; database: string; scheduler: { state: string } };
      expect(ready.status, JSON.stringify(readyBody)).toBe(200);
      expect(readyBody.database).toBe('ok');
      expect(readyBody.scheduler.state).not.toBe('not_running');

      for (let i = 0; i < 3; i++) {
        const started = performance.now();
        const res = await fetch(`${base}/api/v1/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-LD-CSRF': '1' },
          body: JSON.stringify({ email: account.email, password: 'correct horse battery' }),
          signal: AbortSignal.timeout(10_000),
        });
        const ms = performance.now() - started;
        expect(res.status, await res.text()).toBe(200);
        expect(ms, `sign-in took ${Math.round(ms)} ms`).toBeLessThan(2000);
        await sleep(1000);
      }
    } catch (err) {
      throw new Error(`${(err as Error).message}\n--- API output ---\n${output}`, { cause: err });
    } finally {
      child.kill();
      await Promise.race([exited, sleep(10_000)]);
    }
  });
});
