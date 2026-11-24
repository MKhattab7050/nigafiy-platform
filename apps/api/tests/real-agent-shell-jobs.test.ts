import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { systemPool } from '../src/infrastructure/db.ts';
import { ShellHub } from '../src/modules/endpoints/fleet-shell/hub.ts';
import { endpointsModule } from '../src/modules/endpoints/index.ts';
import { StreamHub } from '../src/modules/endpoints/remote-desktop/stream-hub.ts';
import { CSRF, app, newAccount } from './helpers.ts';

const binPath = path.resolve(import.meta.dirname, '../../../agents/endpoint-agent/bin', process.platform === 'win32' ? 'nigafiy-agent.exe' : 'nigafiy-agent');

// The compiled Go agent on this Windows desktop, end to end: a remote shell (real Windows
// PowerShell in a real pseudo console, the real banner for a few seconds, the real WebSocket hub,
// the sealed transcript), then a script job whose hostile parameter value comes back as data.
// Nothing here touches the network: the API listens on 127.0.0.1 and the script only echoes.
describe.skipIf(process.platform !== 'win32' || !existsSync(binPath))('real Go agent: remote shell and script job (run `pnpm build:agent` first)', () => {
  it('opens PowerShell over ConPTY, relays a command and its exit, then runs a job with a hostile parameter', async () => {
    await endpointsModule.lifecycle.start();
    const srv = http.createServer(app);
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
    const { port } = srv.address() as AddressInfo;
    const serverUrl = `http://127.0.0.1:${port}`;
    const shellHub = new ShellHub();
    shellHub.start();
    new StreamHub({ peerUrl: serverUrl, shell: shellHub }).attach(srv);
    const stateDir = mkdtempSync(path.join(os.tmpdir(), 'ld-agent-shell-'));
    let child: ReturnType<typeof spawn> | null = null;
    const logs: string[] = [];
    const until = async <T>(fn: () => Promise<T | undefined | null | false> | T | undefined | null | false, what: string, ms = 30_000): Promise<T> => {
      const end = Date.now() + ms;
      for (;;) {
        const v = await fn();
        if (v) return v;
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}\n${logs.join('')}`);
        await new Promise((r) => setTimeout(r, 200));
      }
    };
    try {
      const a = await newAccount('real-shell');
      const created = await a.agent.post('/api/v1/endpoints').set(CSRF).send({ site_id: a.siteId, name: 'Real shell host', platform: 'windows' });
      const epId: string = created.body.endpoint.id;
      const g = (await a.agent.post('/api/v1/fleet/groups').set(CSRF).send({ name: 'Real shell', shell_enabled: true })).body.group;
      await a.agent.post('/api/v1/fleet/groups/assign').set(CSRF).send({ endpoint_ids: [epId], fleet_group_id: g.id });
      child = spawn(binPath, ['-server', serverUrl, '-allow-insecure-http', '-token', created.body.enrollment_token, '-state-dir', stateDir, '-log-level', 'info'], { stdio: 'pipe' });
      child.stdout?.on('data', (d) => logs.push(String(d)));
      child.stderr?.on('data', (d) => logs.push(String(d)));
      await until(async () => (await a.agent.get(`/api/v1/endpoints/${epId}`)).body.connection_state === 'online', 'the agent online');

      // ── Remote shell ──
      const profiles = (await a.agent.get('/api/v1/fleet/profiles')).body.profiles as Array<{ id: string; builtin_key: string }>;
      const opened = await a.agent
        .post(`/api/v1/endpoints/${epId}/shell`)
        .set(CSRF)
        .send({ reason: 'Nigafiy real shell test', profile_id: profiles.find((p) => p.builtin_key === 'full_admin')!.id, cols: 100, rows: 30 });
      expect(opened.status, JSON.stringify(opened.body)).toBe(201);
      const shell = opened.body as { id: string; public_id: string };
      const row = await until(async () => {
        const s = (await a.agent.get(`/api/v1/endpoints/${epId}/shell/${shell.id}`)).body;
        return s.state === 'open' && s.pty ? s : null;
      }, 'the shell open');
      expect(row.pty).toBe('conpty');
      expect(String(row.shell).toLowerCase()).toContain('powershell.exe');

      const login = await request(app).post('/api/v1/auth/login').set(CSRF).send({ email: a.email, password: 'correct horse battery' });
      const cookie = (login.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('ld_session='))!.split(';')[0]!;
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/endpoints/${epId}/shell/stream?shell=${shell.public_id}`, { headers: { Cookie: cookie, Origin: 'http://localhost:3100' } });
      const out: Buffer[] = [];
      let closed: number | null = null;
      ws.on('message', (data, bin) => {
        if (bin) out.push(data as Buffer);
      });
      ws.on('close', (code) => (closed = code));
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve());
        ws.once('error', reject);
      });
      const text = () => Buffer.concat(out).toString('utf8');
      // The prompt, then a command whose output is not its own echo.
      await until(() => text().includes('PS '), 'the PowerShell prompt');
      ws.send(Buffer.from("Write-Output ('nigafiy-' + (40+2))\r"), { binary: true });
      await until(() => text().includes('nigafiy-42'), 'the command output');
      ws.send(Buffer.from('exit 4\r'), { binary: true });
      const ended = await until(async () => {
        const s = (await a.agent.get(`/api/v1/endpoints/${epId}/shell/${shell.id}`)).body;
        return s.state === 'closed' ? s : null;
      }, 'the shell to end');
      expect(ended).toMatchObject({ end_reason: 'exited', exit_code: 4 });
      await until(() => closed !== null, 'the operator socket closed', 5000);

      // The transcript has the command; the plain audit never does.
      const t = await a.agent.get(`/api/v1/endpoints/${epId}/shell/${shell.id}/transcript`);
      const joined = (t.body.chunks as Array<{ direction: string; text: string }>).map((c) => c.text).join('');
      expect(joined).toContain("Write-Output ('nigafiy-' + (40+2))");
      expect(joined).toContain('nigafiy-42');
      const audit = await systemPool.query<{ metadata: unknown }>(`SELECT metadata FROM audit_logs WHERE organization_id = $1`, [a.organizationId]);
      expect(JSON.stringify(audit.rows)).not.toContain('nigafiy-42');
      expect(JSON.stringify(audit.rows)).not.toContain('Write-Output');

      // ── Script job: the value is data, never code ──
      const hostile = `C:\\Temp'; Remove-Item C:\\nope -Recurse; $(whoami) \`n "q" & echo pwned`;
      const script = await a.agent
        .post('/api/v1/fleet/scripts')
        .set(CSRF)
        .send({
          name: 'Echo back',
          os: 'windows',
          body: "param([string]$Path, [int]$Days)\r\nWrite-Output (\"PATH=\" + $Path)\r\nWrite-Output (\"DAYS=\" + ($Days * 2))\r\nexit 0\r\n",
          parameters: [
            { name: 'Path', type: 'string', required: true },
            { name: 'Days', type: 'int', default: 3 },
          ],
          timeout_s: 120,
        });
      expect(script.status, JSON.stringify(script.body)).toBe(201);
      const job = await a.agent
        .post('/api/v1/fleet/jobs')
        .set(CSRF)
        .send({ script_id: script.body.id, parameters: { Path: hostile, Days: 21 }, target: { kind: 'endpoints', endpoint_ids: [epId] }, schedule: { kind: 'now' } });
      expect(job.status, JSON.stringify(job.body)).toBe(201);
      const result = await until(async () => {
        const d = (await a.agent.get(`/api/v1/fleet/jobs/${job.body.id}`)).body;
        const r = d.runs?.[0]?.results?.[0];
        return r && ['succeeded', 'failed'].includes(r.state) ? r : null;
      }, 'the job result', 60_000);
      expect(result.state, JSON.stringify(result)).toBe('succeeded');
      expect(result.exit_code).toBe(0);
      expect(result.stdout_preview).toContain(`PATH=${hostile}`);
      expect(result.stdout_preview).toContain('DAYS=42');
      // Nothing in the value ran: no line of its own from `echo pwned` or `whoami`.
      expect(String(result.stdout_preview).split(/\r?\n/)).not.toContain('pwned');
      expect(String(result.stdout_preview).split(/\r?\n/).filter((l) => l.trim()).length).toBe(2);
      console.info(`[real shell] ${row.shell} over ${row.pty}; [real job] ${result.duration_ms} ms, exit ${result.exit_code}`);
    } finally {
      child?.kill();
      await new Promise((r) => setTimeout(r, 500));
      await shellHub.stop();
      await new Promise<void>((resolve) => srv.close(() => resolve()));
      await endpointsModule.lifecycle.stop();
      rmSync(stateDir, { recursive: true, force: true });
    }
  }, 180_000);
});
