import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { systemPool } from '../src/infrastructure/db.ts';
import { dispatchNotifications } from '../src/modules/notifications/index.ts';
import { eventPageUrl, renderEmail } from '../src/modules/notifications/email.ts';
import { CSRF, newAccount } from './helpers.ts';

interface Mail {
  from: string;
  to: string[];
  data: string;
}

/** A minimal SMTP server (no TLS, no login) that records what it is given. Test double for a LAN mail relay. */
function fakeSmtp(received: Mail[]) {
  return net.createServer((socket) => {
    let buffer = '';
    let mail: Mail = { from: '', to: [], data: '' };
    let inData = false;
    socket.write('220 test ESMTP\r\n');
    socket.on('error', () => undefined);
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end < 0) return;
          mail.data = buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          inData = false;
          received.push(mail);
          mail = { from: '', to: [], data: '' };
          socket.write('250 queued\r\n');
          continue;
        }
        const nl = buffer.indexOf('\r\n');
        if (nl < 0) return;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 2);
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === 'EHLO' || verb === 'HELO') socket.write('250 test\r\n');
        else if (verb === 'MAIL') {
          mail.from = /<(.*)>/.exec(line)?.[1] ?? '';
          socket.write('250 ok\r\n');
        } else if (verb === 'RCPT') {
          mail.to.push(/<(.*)>/.exec(line)?.[1] ?? '');
          socket.write('250 ok\r\n');
        } else if (verb === 'DATA') {
          inData = true;
          socket.write('354 go ahead\r\n');
        } else if (verb === 'QUIT') socket.end('221 bye\r\n');
        else socket.write('250 ok\r\n');
      }
    });
  });
}

describe('email notifications', () => {
  it('renders plain text and keeps event text out of the headers', () => {
    const mail = renderEmail(
      { id: '1', type: 'device_offline', severity: 'critical', title: 'printer\r\nBcc: attacker@example.com is offline', details: { ip: '10.0.0.5', evidence: ['a', 'b'], nested: { last_seen: 'x' } }, occurred_at: '2026-01-02T03:04:05Z', site_name: 'HQ' },
      'Acme',
    );
    expect(mail.subject).toBe('[LAN Detective] CRITICAL: printer Bcc: attacker@example.com is offline');
    expect(mail.subject).not.toMatch(/[\r\n]/);
    expect(mail.text).toContain('Where:     Acme / HQ');
    expect(mail.text).toContain('ip: 10.0.0.5');
    expect(mail.text).toContain('evidence: a, b');
    expect(mail.text).toContain('last seen: x');
    // The link opens the Milestone 4 URL (Watch's event timeline for an event without a device).
    expect(mail.text).toMatch(/Open in Nigafiy: https?:\/\/[^\s]+\/watch\/events\?type=device_offline/);
  });

  it('links a device event to the device card in Radar and a check event to Watch', () => {
    const id = '3f2c7a1e-0000-4000-8000-000000000001';
    expect(eventPageUrl({ type: 'device_offline', device_id: id }, 'https://nms.example/')).toBe(`https://nms.example/radar/devices/${id}`);
    expect(eventPageUrl({ type: 'check_down', check_id: id }, 'https://nms.example')).toBe('https://nms.example/watch/monitoring');
    expect(eventPageUrl({ type: 'x y', device_id: 'not-a-uuid' }, 'https://nms.example')).toBe('https://nms.example/watch/events?type=x%20y');
  });

  it('sends matching events by email, stores the password encrypted and reports failures', async () => {
    const received: Mail[] = [];
    const server = fakeSmtp(received);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const a = await newAccount('mail');
      const post = (body: Record<string, unknown>) => a.agent.post('/api/v1/notification-channels').set(CSRF).send(body);
      const smtp = { host: '127.0.0.1', port, security: 'none', from: 'lan-detective@example.test' };
      const base = { kind: 'email', name: 'IT team', recipients: ['it@example.test', 'boss@example.test'], min_severity: 'info' };

      expect((await post({ ...base, recipients: [] })).status).toBe(400);
      expect((await post({ ...base, recipients: ['not-an-address'], smtp })).status).toBe(400);
      expect((await post({ ...base, smtp: { ...smtp, host: 'bad host;rm' } })).status).toBe(400);
      // A password is never sent over an unencrypted connection, and needs a user name.
      expect((await post({ ...base, smtp: { ...smtp, username: 'u', password: 'p' } })).status).toBe(400);
      expect((await post({ ...base, smtp: { ...smtp, security: 'tls', password: 'p' } })).status).toBe(400);

      const withLogin = await post({ ...base, name: 'With login', smtp: { ...smtp, security: 'starttls', username: 'mailer', password: 'smtp-secret-77' } });
      expect(withLogin.status).toBe(201);
      expect(withLogin.body.signing_secret).toBeNull();
      const stored = await systemPool.query(`SELECT secret_encrypted, config::text AS config FROM notification_channels WHERE id = $1`, [withLogin.body.channel.id]);
      expect(stored.rows[0].secret_encrypted).toMatch(/^v1:/);
      expect(stored.rows[0].config).not.toContain('smtp-secret-77');
      const listed = JSON.stringify((await a.agent.get('/api/v1/notification-channels')).body);
      expect(listed).not.toContain('smtp-secret-77');
      const audits = await systemPool.query(`SELECT metadata::text AS m FROM audit_logs WHERE organization_id = $1`, [a.organizationId]);
      expect(JSON.stringify(audits.rows)).not.toContain('smtp-secret-77');
      await a.agent.delete(`/api/v1/notification-channels/${withLogin.body.channel.id}`).set(CSRF);

      const created = await post({ ...base, smtp });
      expect(created.status).toBe(201);
      expect(created.body.channel).toMatchObject({ kind: 'email', url: 'mailto:it@example.test,boss@example.test', config: { host: '127.0.0.1', port, security: 'none', username: null, from: 'lan-detective@example.test' } });

      expect((await a.agent.post(`/api/v1/notification-channels/${created.body.channel.id}/test`).set(CSRF)).status).toBe(202);
      await dispatchNotifications();
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({ from: 'lan-detective@example.test', to: ['it@example.test', 'boss@example.test'] });
      expect(received[0]!.data).toContain('Subject: [LAN Detective] INFO: Test notification from LAN Detective');
      expect(received[0]!.data).toContain('Where:     mail corp');
      expect(received[0]!.data).not.toContain('text/html');
      expect((await a.agent.get('/api/v1/notification-channels')).body.items[0]).toMatchObject({ last_delivery_status: 'delivered' });

      // The relay goes away: the delivery stays pending for a retry and the reason is visible.
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await a.agent.post(`/api/v1/notification-channels/${created.body.channel.id}/test`).set(CSRF);
      await dispatchNotifications();
      const after = (await a.agent.get('/api/v1/notification-channels')).body.items[0];
      expect(after.last_delivery_status).toBe('pending');
      expect(after.last_delivery_error).toBeTruthy();

      // Roles and tenants.
      const other = await newAccount('mail-other');
      expect((await other.agent.post(`/api/v1/notification-channels/${created.body.channel.id}/test`).set(CSRF)).status).toBe(404);
    } finally {
      if (server.listening) server.close();
    }
  });
});
