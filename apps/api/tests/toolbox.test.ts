import { describe, expect, it } from 'vitest';
import { systemPool } from '../src/infrastructure/db.ts';
import { CSRF, addScope, heartbeat, newAccount, newCollector, setRole, telemetry } from './helpers.ts';

describe('IT toolbox', () => {
  it('validates targets, tool-specific rules, roles, and requires an online collector', async () => {
    const a = await newAccount('toolbox-val');
    await addScope(a, '192.168.1.0/24');

    // No collector online yet
    const noColl = await a.agent.post('/api/v1/toolbox').set(CSRF).send({
      site_id: a.siteId,
      tool: 'ping',
      target: '192.168.1.1',
    });
    expect(noColl.status).toBe(409);
    expect(noColl.body.error.code).toBe('no_collector');

    const c = await newCollector(a);
    await heartbeat(c);

    // Option-flag injection attempt
    const flagTarget = await a.agent.post('/api/v1/toolbox').set(CSRF).send({
      site_id: a.siteId,
      tool: 'traceroute',
      target: '-h',
    });
    expect(flagTarget.status).toBe(400);

    // DNS requires a hostname, not an IPv4 address
    const dnsIp = await a.agent.post('/api/v1/toolbox').set(CSRF).send({
      site_id: a.siteId,
      tool: 'dns',
      target: '1.1.1.1',
    });
    expect(dnsIp.status).toBe(400);

    // Reverse DNS requires an IPv4 address
    const rdnsHost = await a.agent.post('/api/v1/toolbox').set(CSRF).send({
      site_id: a.siteId,
      tool: 'rdns',
      target: 'example.com',
    });
    expect(rdnsHost.status).toBe(400);

    // TCP requires a port; ping forbids a port
    const tcpNoPort = await a.agent.post('/api/v1/toolbox').set(CSRF).send({
      site_id: a.siteId,
      tool: 'tcp',
      target: '192.168.1.1',
    });
    expect(tcpNoPort.status).toBe(400);

    const pingWithPort = await a.agent.post('/api/v1/toolbox').set(CSRF).send({
      site_id: a.siteId,
      tool: 'ping',
      target: '192.168.1.1',
      port: 80,
    });
    expect(pingWithPort.status).toBe(400);

    // Viewer cannot run tools; technician can
    await setRole(a.email, a.organizationId, 'viewer');
    const viewerAttempt = await a.agent.post('/api/v1/toolbox').set(CSRF).send({
      site_id: a.siteId,
      tool: 'ping',
      target: '192.168.1.1',
    });
    expect(viewerAttempt.status).toBe(403);

    await setRole(a.email, a.organizationId, 'technician');
    const techAttempt = await a.agent.post('/api/v1/toolbox').set(CSRF).send({
      site_id: a.siteId,
      tool: 'ping',
      target: '192.168.1.1',
    });
    expect(techAttempt.status).toBe(202);
  });

  it('delivers run_tool to the collector, records telemetry results, expires stale runs, and isolates tenants', async () => {
    const a = await newAccount('toolbox-a');
    const b = await newAccount('toolbox-b');
    await addScope(a, '192.168.1.0/24');
    const cA = await newCollector(a, 'edge-a');
    const cB = await newCollector(b, 'edge-b');
    await heartbeat(cA);
    await heartbeat(cB);

    const created = await a.agent.post('/api/v1/toolbox').set(CSRF).send({
      site_id: a.siteId,
      tool: 'tcp',
      target: '192.168.1.10',
      port: 443,
    });
    expect(created.status).toBe(202);
    const runId: string = created.body.id;
    expect(created.body.status).toBe('pending');
    expect(created.body.collector_name).toBe('edge-a');

    // Tenant B cannot see Tenant A's run
    expect((await b.agent.get(`/api/v1/toolbox/${runId}`)).status).toBe(404);
    expect((await b.agent.get('/api/v1/toolbox')).body.items).toHaveLength(0);

    // Collector A receives the run_tool command on heartbeat
    const hb = await heartbeat(cA);
    const cmd = (hb.body.commands as { id: string; kind: string; payload: Record<string, unknown> }[]).find(
      (x) => x.kind === 'run_tool' && x.payload.run_id === runId,
    );
    expect(cmd).toBeDefined();
    expect(cmd!.payload).toEqual({ run_id: runId, tool: 'tcp', target: '192.168.1.10', port: 443 });

    // Tenant B's collector cannot spoof a result for Tenant A's run
    const spoof = await telemetry(cB, [
      {
        type: 'tool_result',
        ts: new Date().toISOString(),
        run_id: runId,
        ok: true,
        duration_ms: 5,
        output: { port: 443, open: true },
      },
    ]);
    expect(spoof.body.accepted).toBe(0);
    expect(spoof.body.rejected).toHaveLength(1);

    // Collector A uploads the real result and acknowledges the command
    const upload = await telemetry(cA, [
      {
        type: 'tool_result',
        ts: new Date().toISOString(),
        run_id: runId,
        ok: true,
        duration_ms: 14,
        output: { port: 443, open: true, connect_ms: 3.4, resolved: '192.168.1.10' },
      },
    ]);
    expect(upload.body.accepted).toBe(1);
    await heartbeat(cA, { completed_commands: [cmd!.id] });

    const done = await a.agent.get(`/api/v1/toolbox/${runId}`);
    expect(done.status).toBe(200);
    expect(done.body.status).toBe('completed');
    expect(done.body.duration_ms).toBe(14);
    expect(done.body.output).toEqual({ port: 443, open: true, connect_ms: 3.4, resolved: '192.168.1.10' });

    // Stale pending run expires after 5 minutes
    const stale = await a.agent.post('/api/v1/toolbox').set(CSRF).send({
      site_id: a.siteId,
      tool: 'traceroute',
      target: '192.168.1.1',
    });
    const staleId: string = stale.body.id;
    await systemPool.query(
      `UPDATE toolbox_runs SET created_at = now() - interval '6 minutes' WHERE id = $1`,
      [staleId],
    );
    const expired = await a.agent.get(`/api/v1/toolbox/${staleId}`);
    expect(expired.body.status).toBe('expired');
  });

  it('validates targets against the authorized network scopes of the site (API layer)', async () => {
    const a = await newAccount('toolbox-scope');
    await addScope(a, '192.168.70.0/24');
    const c = await newCollector(a);
    await heartbeat(c);
    const run = (tool: string, target: string, port: number | null = null) => a.agent.post('/api/v1/toolbox').set(CSRF).send({ site_id: a.siteId, tool, target, port });

    // Private address inside the scope: every tool.
    for (const [tool, port] of [['ping', null], ['traceroute', null], ['rdns', null], ['tcp', 22], ['ports', null]] as const) {
      expect((await run(tool, '192.168.70.5', port)).status, tool).toBe(202);
      await systemPool.query(`UPDATE toolbox_runs SET status = 'completed' WHERE organization_id = $1`, [a.organizationId]);
    }
    // Private address outside every scope: refused for every tool, including ping.
    for (const [tool, port] of [['ping', null], ['traceroute', null], ['rdns', null], ['tcp', 22], ['ports', null]] as const) {
      const r = await run(tool, '10.20.30.40', port);
      expect(r.status, tool).toBe(422);
      expect(r.body.error.code).toBe('out_of_scope');
    }
    // A disabled scope does not authorize.
    await systemPool.query(`UPDATE network_scopes SET enabled = false WHERE site_id = $1`, [a.siteId]);
    expect((await run('ping', '192.168.70.5')).status).toBe(422);
    await systemPool.query(`UPDATE network_scopes SET enabled = true WHERE site_id = $1`, [a.siteId]);
    // Public addresses: reachability diagnostics yes, port checks no.
    for (const tool of ['ping', 'traceroute', 'rdns']) {
      expect((await run(tool, '1.1.1.1')).status, tool).toBe(202);
      await systemPool.query(`UPDATE toolbox_runs SET status = 'completed' WHERE organization_id = $1`, [a.organizationId]);
    }
    expect((await run('tcp', '1.1.1.1', 443)).status).toBe(422);
    expect((await run('ports', '8.8.8.8')).status).toBe(422);
    // Host names: DNS / ping / traceroute go to the collector (it re-checks the resolved address); port checks need an address.
    expect((await run('dns', 'example.com')).status).toBe(202);
    await systemPool.query(`UPDATE toolbox_runs SET status = 'completed' WHERE organization_id = $1`, [a.organizationId]);
    expect((await run('tcp', 'nas.local', 445)).status).toBe(422);
    expect((await run('ports', 'nas.local')).status).toBe(422);
    // Special addresses and loopback (not allowed in this environment).
    for (const target of ['0.0.0.0', '255.255.255.255', '224.0.0.1', '240.0.0.1', '127.0.0.1']) expect((await run('ping', target)).status, target).toBe(422);
    // Every refusal leaves nothing queued for the collector.
    const queued = await systemPool.query(`SELECT target FROM toolbox_runs WHERE organization_id = $1`, [a.organizationId]);
    expect(queued.rows.map((r) => r.target)).not.toContain('10.20.30.40');
  });
});

