import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CSRF, app, newAccount } from './helpers.ts';

const binPath = path.resolve(
  import.meta.dirname,
  '../../../agents/endpoint-agent/bin',
  process.platform === 'win32' ? 'nigafiy-agent.exe' : 'nigafiy-agent',
);

// Needs an interactive Windows desktop and a binary built from the current source (`pnpm build:agent`).
describe.skipIf(process.platform !== 'win32' || !existsSync(binPath))('real Go Nigafiy Agent binary on Windows (end-to-end, run `pnpm build:agent` first)', () => {
  it(
    'spawns the compiled nigafiy-agent binary, enrolls, collects real host telemetry/inventory, and executes live File Manager, Remote Desktop, and Diagnostic commands',
    async () => {
      const srv = http.createServer(app);
      await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
      const { port } = srv.address() as AddressInfo;
      const serverUrl = `http://127.0.0.1:${port}`;

      const stateDir = mkdtempSync(path.join(os.tmpdir(), 'ld-agent-state-'));
      const testWorkspace = mkdtempSync(path.join(os.tmpdir(), 'ld-agent-fs-'));

      let child: ReturnType<typeof spawn> | null = null;
      try {
        const a = await newAccount('real-win-agent');
        const created = await a.agent.post('/api/v1/endpoints').set(CSRF).send({
          site_id: a.siteId,
          name: 'Local Windows Host (Real Binary)',
          platform: 'windows',
        });
        expect(created.status).toBe(201);
        const epId: string = created.body.endpoint.id;
        const token: string = created.body.enrollment_token;

        child = spawn(
          binPath,
          ['-server', serverUrl, '-allow-insecure-http', '-token', token, '-state-dir', stateDir, '-log-level', 'info'],
          { stdio: 'pipe' },
        );

        // Wait until the real binary enrolls and sends its first heartbeat + inventory
        let detail = (await a.agent.get(`/api/v1/endpoints/${epId}`)).body;
        const deadline = Date.now() + 25_000;
        while (Date.now() < deadline) {
          detail = (await a.agent.get(`/api/v1/endpoints/${epId}`)).body;
          if (detail.connection_state === 'online' && detail.processes && detail.processes.length > 0) {
            break;
          }
          await new Promise((r) => setTimeout(r, 400));
        }

        expect(detail.status).toBe('active');
        expect(detail.connection_state).toBe('online');
        expect(detail.hostname).toBeTruthy();
        expect(detail.processes.length).toBeGreaterThan(5);
        expect(detail.disks.length).toBeGreaterThanOrEqual(1);

        // 1. Live Remote File Manager: create a file, list directory, download & verify SHA-256, and delete
        const testFile = path.join(testWorkspace, 'e2e-real-test.txt');
        const payloadText = 'Verified by real Go Nigafiy Agent on Windows!';
        const touchRes = await a.agent.post(`/api/v1/endpoints/${epId}/commands?wait_ms=5000`).set(CSRF).send({
          kind: 'fs_op',
          op: 'touch',
          path: testFile,
          data_base64: Buffer.from(payloadText, 'utf8').toString('base64'),
        });
        expect(touchRes.status).toBe(200);
        expect(touchRes.body.status).toBe('completed');

        const listRes = await a.agent.post(`/api/v1/endpoints/${epId}/commands?wait_ms=5000`).set(CSRF).send({
          kind: 'fs_op',
          op: 'list',
          path: testWorkspace,
        });
        expect(listRes.status).toBe(200);
        expect(listRes.body.status).toBe('completed');
        expect(listRes.body.result_data.entries).toHaveLength(1);
        expect(listRes.body.result_data.entries[0].name).toBe('e2e-real-test.txt');

        const dlRes = await a.agent.post(`/api/v1/endpoints/${epId}/commands?wait_ms=5000`).set(CSRF).send({
          kind: 'fs_op',
          op: 'download',
          path: testFile,
          offset: 0,
          length: 4096,
        });
        expect(dlRes.status).toBe(200);
        expect(dlRes.body.status).toBe('completed');
        const downloadedText = Buffer.from(dlRes.body.result_data.data_base64, 'base64').toString('utf8');
        expect(downloadedText).toBe(payloadText);
        expect(dlRes.body.result_data.sha256).toHaveLength(64);

        const delRes = await a.agent.post(`/api/v1/endpoints/${epId}/commands?wait_ms=5000`).set(CSRF).send({
          kind: 'fs_op',
          op: 'delete',
          path: testFile,
          confirm_destructive: true,
        });
        expect(delRes.status).toBe(200);
        expect(delRes.body.status).toBe('completed');

        // 2. Live Remote Desktop screen frame capture from the real binary, inside a session
        //    (starting it shows the operator's name on this computer's screen).
        const rdStart = await a.agent.post(`/api/v1/endpoints/${epId}/remote-desktop/start`).set(CSRF).send({ reason: 'Fleet test session' });
        expect(rdStart.status, JSON.stringify(rdStart.body)).toBe(200);
        const rdRes = await a.agent.post(`/api/v1/endpoints/${epId}/commands?wait_ms=5000`).set(CSRF).send({
          kind: 'rd_capture',
          display_index: 0,
          quality: 65,
          scale: 0.5,
          // Opening the session already captured once; an idle screen would come back "unchanged".
          full_frame: true,
        });
        expect(rdRes.status).toBe(200);
        expect(rdRes.body.status).toBe('completed');
        expect(rdRes.body.result_data.width).toBeGreaterThan(0);
        expect(rdRes.body.result_data.jpeg_base64.length).toBeGreaterThan(100);
        const rdStop = await a.agent.post(`/api/v1/endpoints/${epId}/remote-desktop/stop`).set(CSRF).send({});
        expect(rdStop.status, JSON.stringify(rdStop.body)).toBe(200);

        // 3. Live Authorized Diagnostic command (whoami)
        const diagRes = await a.agent.post(`/api/v1/endpoints/${epId}/commands?wait_ms=5000`).set(CSRF).send({
          kind: 'diagnostic_command',
          tool: 'whoami',
        });
        expect(diagRes.status).toBe(200);
        expect(diagRes.body.status).toBe('completed');
        expect(diagRes.body.output.length).toBeGreaterThan(2);
      } finally {
        if (child) {
          child.kill();
        }
        await new Promise<void>((resolve) => srv.close(() => resolve()));
        try {
          rmSync(stateDir, { recursive: true, force: true });
          rmSync(testWorkspace, { recursive: true, force: true });
        } catch {
          // ignore cleanup lock
        }
      }
    },
    45_000,
  );
});

