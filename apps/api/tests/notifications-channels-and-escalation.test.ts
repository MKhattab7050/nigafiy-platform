import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { systemPool } from '../src/infrastructure/db.ts';
import {
  dispatchNotifications,
  renderDiscordPayload,
  renderNtfyMessage,
  renderSlackPayload,
  renderTelegramPayload,
  runEscalations,
} from '../src/modules/notifications/index.ts';
import { CSRF, newAccount } from './helpers.ts';

interface CapturedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function fakeReceiver(captured: CapturedRequest[]) {
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk.toString('utf8')));
    req.on('end', () => {
      captured.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
}

describe('instant notification channels and escalation policies', () => {
  it('renders safe payloads for Telegram, Slack, Discord and ntfy', () => {
    const ev = {
      id: '1',
      type: 'check_down',
      severity: 'critical',
      title: '<script>alert(1)</script> Gateway down',
      details: { target: '192.168.1.1', loss_pct: 100 },
      occurred_at: '2026-11-22T00:00:00Z',
      site_name: 'Main Office',
    };
    const tg = renderTelegramPayload(ev, 'Acme', '-100123456', 42, 'https://nms.example');
    expect(tg.chat_id).toBe('-100123456');
    expect(tg.message_thread_id).toBe(42);
    expect(String(tg.text)).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(String(tg.text)).not.toContain('<script>');
    expect(String(tg.text)).toContain('https://nms.example/watch/events?type=check_down');

    const slack = renderSlackPayload(ev, 'Acme', 'https://nms.example');
    expect((slack.attachments as { color: string }[])[0]?.color).toBe('#e53e3e');

    const discord = renderDiscordPayload(ev, 'Acme', 'https://nms.example');
    expect((discord.embeds as { color: number; title: string }[])[0]?.color).toBe(0xe53e3e);

    // EXT-6: a device-supplied name cannot mention people or forge a link in Slack or Discord.
    const hostile = { ...ev, title: '<!channel> <@U123> <https://evil.example|click> PC & co', details: { host: '<!here>' }, site_name: '<@U999>' };
    const s2 = JSON.stringify(renderSlackPayload(hostile, 'Acme', 'https://nms.example'));
    for (const bad of ['<!channel>', '<@U123>', '<https://evil.example', '<!here>', '<@U999>']) expect(s2).not.toContain(bad);
    expect(s2).toContain('&lt;!channel&gt; &lt;@U123&gt;');
    expect(s2).toContain('PC &amp; co');
    expect(renderDiscordPayload(hostile, 'Acme').allowed_mentions).toEqual({ parse: [] });

    const ntfy = renderNtfyMessage(ev, 'Acme', 'https://nms.example');
    expect(ntfy.headers['X-Priority']).toBe('5');
    expect(ntfy.headers['X-Tags']).toBe('rotating_light');
    expect(ntfy.headers['X-Click']).toBe('https://nms.example/watch/events?type=check_down');
  });

  it('creates, seals secrets for, and dispatches Telegram, Slack, Discord and ntfy channels', async () => {
    const captured: CapturedRequest[] = [];
    const server = fakeReceiver(captured);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const a = await newAccount('multi-ch');
      const post = (body: Record<string, unknown>) => a.agent.post('/api/v1/notification-channels').set(CSRF).send(body);

      const tgToken = '123456789:AAH_super_secret_telegram_token_xyz';
      const slackSecret = `${base}/services/T000/B000/SLACKSECRETTOKEN99`;
      const discordSecret = `${base}/api/webhooks/111/DISCORDSECRETTOKEN88`;
      const ntfyToken = 'tk_ntfy_super_secret_77';

      const tg = await post({ kind: 'telegram', name: 'Ops Telegram', bot_token: tgToken, chat_id: '-100999888', message_thread_id: 7, api_base: base, min_severity: 'info' });
      expect(tg.status).toBe(201);
      const sl = await post({ kind: 'slack', name: 'Ops Slack', webhook_url: slackSecret, min_severity: 'info' });
      expect(sl.status).toBe(201);
      const dc = await post({ kind: 'discord', name: 'Ops Discord', webhook_url: discordSecret, min_severity: 'info' });
      expect(dc.status).toBe(201);
      const nt = await post({ kind: 'ntfy', name: 'Ops Push', server_url: base, topic: 'nigafiy-alerts', token: ntfyToken, min_severity: 'info' });
      expect(nt.status).toBe(201);

      // Secrets must never appear in API list, DB config/url, or audit logs.
      const listed = JSON.stringify((await a.agent.get('/api/v1/notification-channels')).body);
      const audits = JSON.stringify((await systemPool.query(`SELECT metadata::text FROM audit_logs WHERE organization_id = $1`, [a.organizationId])).rows);
      for (const secret of [tgToken, 'SLACKSECRETTOKEN99', 'DISCORDSECRETTOKEN88', ntfyToken]) {
        expect(listed).not.toContain(secret);
        expect(audits).not.toContain(secret);
      }

      for (const ch of [tg.body.channel, sl.body.channel, dc.body.channel, nt.body.channel]) {
        expect((await a.agent.post(`/api/v1/notification-channels/${ch.id}/test`).set(CSRF)).status).toBe(202);
      }
      await dispatchNotifications();
      expect(captured).toHaveLength(4);
      expect(captured.some((r) => r.url === `/bot${tgToken}/sendMessage` && r.body.includes('"-100999888"'))).toBe(true);
      expect(captured.some((r) => r.url === '/services/T000/B000/SLACKSECRETTOKEN99' && r.body.includes('attachments'))).toBe(true);
      expect(captured.some((r) => r.url === '/api/webhooks/111/DISCORDSECRETTOKEN88' && r.body.includes('embeds'))).toBe(true);
      expect(captured.some((r) => r.url === '/nigafiy-alerts' && r.headers.authorization === `Bearer ${ntfyToken}` && r.headers['x-priority'] === '3')).toBe(true);
    } finally {
      server.close();
    }
  });

  it('escalates unacknowledged open incidents on schedule, repeats up to max_repeats, and stops once acknowledged', async () => {
    const captured: CapturedRequest[] = [];
    const server = fakeReceiver(captured);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const a = await newAccount('escalate');
      const chRes = await a.agent
        .post('/api/v1/notification-channels')
        .set(CSRF)
        .send({ kind: 'ntfy', name: 'Manager Push', server_url: base, topic: 'manager-oncall', min_severity: 'critical' });
      expect(chRes.status).toBe(201);
      const channelId = chRes.body.channel.id as string;

      // Validation: max_repeats > 1 needs repeat_interval_minutes.
      const bad = await a.agent
        .post('/api/v1/notifications/escalations')
        .set(CSRF)
        .send({ name: 'Bad', channel_id: channelId, min_severity: 'critical', delay_minutes: 10, max_repeats: 3 });
      expect(bad.status).toBe(400);

      const polRes = await a.agent
        .post('/api/v1/notifications/escalations')
        .set(CSRF)
        .send({ name: 'Escalate criticals', channel_id: channelId, min_severity: 'critical', delay_minutes: 15, repeat_interval_minutes: 10, max_repeats: 2 });
      expect(polRes.status).toBe(201);

      const t0 = new Date('2026-11-22T01:00:00Z');
      const inc = await systemPool.query<{ id: string }>(
        `INSERT INTO incidents (organization_id, site_id, number, kind, correlation_key, status, severity, title, opened_at)
         VALUES ($1,$2,1,'network','net:site1','open','critical','Internet down at HQ',$3) RETURNING id`,
        [a.organizationId, a.siteId, t0],
      );
      const incidentId = inc.rows[0]!.id;

      // Before delay_minutes (10 min elapsed): should NOT escalate.
      expect(await runEscalations(new Date(t0.getTime() + 10 * 60_000))).toBe(0);

      // At 16 min elapsed: step 1 fires and delivers to ntfy!
      expect(await runEscalations(new Date(t0.getTime() + 16 * 60_000))).toBe(1);
      await dispatchNotifications();
      expect(captured).toHaveLength(1);
      expect(captured[0]!.body).toContain('Escalation #1: INC-1 Internet down at HQ');

      // 5 min later (< repeat_interval_minutes=10): no repeat yet.
      expect(await runEscalations(new Date(t0.getTime() + 21 * 60_000))).toBe(0);

      // 11 min after first escalation (27 min total): step 2 fires.
      expect(await runEscalations(new Date(t0.getTime() + 27 * 60_000))).toBe(1);
      await dispatchNotifications();
      expect(captured).toHaveLength(2);
      expect(captured[1]!.body).toContain('Escalation #2: INC-1 Internet down at HQ');

      // Max repeats reached (2/2): no 3rd escalation.
      expect(await runEscalations(new Date(t0.getTime() + 60 * 60_000))).toBe(0);

      // Tenant isolation on escalation list & delete.
      const other = await newAccount('escalate-other');
      expect((await other.agent.get('/api/v1/notifications/escalations')).body.items).toEqual([]);
      expect((await other.agent.delete(`/api/v1/notifications/escalations/${polRes.body.id}`).set(CSRF)).status).toBe(404);

      // Acknowledge incident and add a fresh policy -> must NOT fire for acknowledged incident.
      await systemPool.query(`UPDATE incidents SET status = 'acknowledged', acknowledged_at = now() WHERE id = $1`, [incidentId]);
      const pol2 = await a.agent
        .post('/api/v1/notifications/escalations')
        .set(CSRF)
        .send({ name: 'Second tier', channel_id: channelId, min_severity: 'critical', delay_minutes: 1, max_repeats: 1 });
      expect(pol2.status).toBe(201);
      expect(await runEscalations(new Date(t0.getTime() + 90 * 60_000))).toBe(0);
    } finally {
      server.close();
    }
  });
});
