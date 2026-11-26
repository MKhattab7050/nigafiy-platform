import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { systemPool, withSystem } from '../src/infrastructure/db.ts';
import { emitEvent } from '../src/modules/events/index.ts';
import { decide, dispatchNotifications, localParts, quietActive, releaseCalmSummaries, summaryTitle, weeklyDue } from '../src/modules/notifications/index.ts';
import { CSRF, type TestAccount, newAccount, setRole } from './helpers.ts';

/**
 * Calm alerts (UX review 2026-11-26 item 12): severities, collapsing repeats, quiet hours with one
 * summary when they end, mutes, the weekly summary, and the old behaviour for organizations that
 * have no settings row.
 */

const SETTINGS = {
  info_mode: 'weekly',
  warning_mode: 'immediate',
  dedup_minutes: 30,
  quiet_enabled: false,
  quiet_start: '22:00',
  quiet_end: '07:00',
  timezone: 'UTC',
  weekly_summary: true,
  weekly_day: 0,
  weekly_hour: 9,
  last_weekly_at: new Date(),
} as const;

describe('calm alert rules (pure)', () => {
  it('quiet hours, also across midnight and in the chosen time zone', () => {
    const s = { quiet_enabled: true, quiet_start: '22:00', quiet_end: '07:00' };
    expect(quietActive(s, new Date('2026-11-26T23:30:00Z'), 'UTC')).toBe(true);
    expect(quietActive(s, new Date('2026-11-26T06:59:00Z'), 'UTC')).toBe(true);
    expect(quietActive(s, new Date('2026-11-26T07:00:00Z'), 'UTC')).toBe(false);
    expect(quietActive(s, new Date('2026-11-26T12:00:00Z'), 'UTC')).toBe(false);
    // 20:30 UTC is 22:30 in Cairo (UTC+2 in November).
    expect(quietActive(s, new Date('2026-11-26T20:30:00Z'), 'Africa/Cairo')).toBe(true);
    expect(quietActive({ ...s, quiet_enabled: false }, new Date('2026-11-26T23:30:00Z'), 'UTC')).toBe(false);
    expect(quietActive({ quiet_enabled: true, quiet_start: '13:00', quiet_end: '15:00' }, new Date('2026-11-26T14:00:00Z'), 'UTC')).toBe(true);
    expect(localParts(new Date('2026-11-29T09:15:00Z'), 'UTC')).toEqual({ weekday: 0, hour: 9, minute: 15 });
  });

  it('decides by mute, severity, quiet hours, weekly mode and repeats', () => {
    const none = { muted: false, quiet: false, recentDuplicate: false };
    expect(decide({ severity: 'critical' }, SETTINGS, { ...none, quiet: true, recentDuplicate: true })).toEqual({ send: true });
    expect(decide({ severity: 'critical' }, SETTINGS, { ...none, muted: true })).toEqual({ send: false, reason: 'muted' });
    expect(decide({ severity: 'warning' }, SETTINGS, { ...none, quiet: true })).toEqual({ send: false, reason: 'quiet' });
    expect(decide({ severity: 'info' }, SETTINGS, none)).toEqual({ send: false, reason: 'weekly' });
    expect(decide({ severity: 'warning' }, SETTINGS, none)).toEqual({ send: true });
    expect(decide({ severity: 'warning' }, SETTINGS, { ...none, recentDuplicate: true })).toEqual({ send: false, reason: 'duplicate' });
    // "Weekly" with the summary off would hold forever: it is sent instead.
    expect(decide({ severity: 'info' }, { ...SETTINGS, weekly_summary: false }, none)).toEqual({ send: true });
    // No settings row: the old behaviour (only a mute holds).
    expect(decide({ severity: 'info' }, null, { ...none, quiet: true, recentDuplicate: true })).toEqual({ send: true });
    expect(decide({ severity: 'info' }, null, { ...none, muted: true })).toEqual({ send: false, reason: 'muted' });
  });

  it('weekly summary is due on its local day and hour, once, or after a missed week', () => {
    const base = { weekly_summary: true, weekly_day: 0, weekly_hour: 9 };
    const sunday9 = new Date('2026-11-29T09:10:00Z');
    expect(weeklyDue({ ...base, last_weekly_at: new Date('2026-11-22T09:01:00Z') }, sunday9, 'UTC')).toBe(true);
    expect(weeklyDue({ ...base, last_weekly_at: new Date('2026-11-29T09:01:00Z') }, sunday9, 'UTC')).toBe(false);
    expect(weeklyDue({ ...base, last_weekly_at: new Date('2026-11-25T09:00:00Z') }, new Date('2026-11-27T12:00:00Z'), 'UTC')).toBe(false);
    expect(weeklyDue({ ...base, last_weekly_at: new Date('2026-11-10T09:00:00Z') }, new Date('2026-11-27T12:00:00Z'), 'UTC')).toBe(true);
    expect(weeklyDue({ ...base, weekly_summary: false, last_weekly_at: new Date('2026-11-01T09:00:00Z') }, sunday9, 'UTC')).toBe(false);
    expect(summaryTitle('weekly', 3, { muted: 2, duplicate: 1 })).toBe('Weekly summary: 3 notifications (2 muted, 1 repeat collapsed)');
    expect(summaryTitle('quiet_hours', 1, { muted: 0, duplicate: 0 })).toBe('While quiet hours were on: 1 notification');
  });
});

interface Captured {
  url: string;
  body: string;
}

async function withReceiver(fn: (base: string, captured: Captured[]) => Promise<void>) {
  const captured: Captured[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c.toString('utf8')));
    req.on('end', () => {
      captured.push({ url: req.url ?? '', body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, captured);
  } finally {
    server.close();
  }
}

async function addDevice(a: TestAccount, ip: string): Promise<string> {
  const r = await systemPool.query<{ id: string }>(
    `INSERT INTO devices (organization_id, site_id, identity_basis, current_ip, hostname, device_type, type_source, first_seen_at, last_seen_at)
     VALUES ($1,$2,'ip',$3,$4,'unknown','manual',now(),now()) RETURNING id`,
    [a.organizationId, a.siteId, ip, `host-${ip}`],
  );
  return r.rows[0]!.id;
}

const emit = (a: TestAccount, deviceId: string | null, type: string, severity: 'info' | 'warning' | 'critical', title: string) =>
  withSystem((db) =>
    emitEvent(db, a.organizationId, { siteId: a.siteId, deviceId, type, severity, title, details: { evidence: ['test'] }, source: 'platform', occurredAt: new Date() }),
  );

const holds = async (eventId: string) =>
  (await systemPool.query<{ reason: string; released_at: Date | null }>(`SELECT reason, released_at FROM notification_holds WHERE event_id = $1`, [eventId])).rows;

const hhmm = (d: Date) => d.toISOString().slice(11, 16);

async function pushChannel(a: TestAccount, base: string, topic: string) {
  const r = await a.agent.post('/api/v1/notification-channels').set(CSRF).send({ kind: 'ntfy', name: 'Phone', server_url: base, topic, min_severity: 'info' });
  expect(r.status).toBe(201);
}

const sentTo = (captured: Captured[], topic: string, text: string) => captured.filter((c) => c.url === `/${topic}` && c.body.includes(text)).length;

describe('calm alerts end to end', () => {
  it('new organizations get calm defaults: info waits for the weekly summary, warnings collapse, criticals always go out', async () => {
    await withReceiver(async (base, captured) => {
      const a = await newAccount('calm');
      const calm = await a.agent.get('/api/v1/notifications/calm');
      expect(calm.status).toBe(200);
      expect(calm.body.settings).toMatchObject({ info_mode: 'weekly', warning_mode: 'immediate', dedup_minutes: 30, weekly_summary: true });
      await pushChannel(a, base, 'calm-a');
      const dev = await addDevice(a, '10.20.0.5');

      const info = await emit(a, dev, 'device_new', 'info', 'Calm: new device seen');
      const warn1 = await emit(a, dev, 'device_flapping', 'warning', 'Calm: flapping one');
      await dispatchNotifications();
      expect(sentTo(captured, 'calm-a', 'Calm: new device seen')).toBe(0);
      expect(await holds(info)).toEqual([{ reason: 'weekly', released_at: null }]);
      expect(sentTo(captured, 'calm-a', 'Calm: flapping one')).toBe(1);
      expect(await holds(warn1)).toEqual([]);

      // The same device + type again within 30 minutes collapses; another type does not.
      const warn2 = await emit(a, dev, 'device_flapping', 'warning', 'Calm: flapping two');
      const crit = await emit(a, dev, 'device_offline', 'critical', 'Calm: device offline');
      const crit2 = await emit(a, dev, 'device_offline', 'critical', 'Calm: device offline again');
      await dispatchNotifications();
      expect(sentTo(captured, 'calm-a', 'Calm: flapping two')).toBe(0);
      expect((await holds(warn2))[0]?.reason).toBe('duplicate');
      expect(sentTo(captured, 'calm-a', 'Calm: device offline')).toBe(2);
      expect(await holds(crit)).toEqual([]);
      expect(await holds(crit2)).toEqual([]);

      // The weekly summary (a week has passed) lists the held info item and counts the collapsed repeat.
      await systemPool.query(`UPDATE notification_settings SET last_weekly_at = now() - interval '8 days' WHERE organization_id = $1`, [a.organizationId]);
      await releaseCalmSummaries();
      await dispatchNotifications();
      const weekly = captured.filter((c) => c.url === '/calm-a' && c.body.includes('Weekly summary'));
      expect(weekly).toHaveLength(1);
      expect(weekly[0]!.body).toContain('1 notification (1 repeat collapsed)');
      expect(weekly[0]!.body).toContain('Calm: new device seen');
      expect((await holds(info))[0]?.released_at).not.toBeNull();
      // Not twice.
      await releaseCalmSummaries();
      await dispatchNotifications();
      expect(captured.filter((c) => c.url === '/calm-a' && c.body.includes('Weekly summary'))).toHaveLength(1);
    });
  });

  it('quiet hours hold everything but critical and send one summary when they end', async () => {
    await withReceiver(async (base, captured) => {
      const a = await newAccount('calm-quiet');
      await pushChannel(a, base, 'calm-q');
      const dev = await addDevice(a, '10.20.1.5');
      const now = new Date();
      const put = await a.agent
        .put('/api/v1/notifications/calm')
        .set(CSRF)
        .send({
          ...SETTINGS,
          last_weekly_at: undefined,
          info_mode: 'immediate',
          quiet_enabled: true,
          quiet_start: hhmm(new Date(now.getTime() - 60 * 60_000)),
          quiet_end: hhmm(new Date(now.getTime() + 60 * 60_000)),
        });
      expect(put.status).toBe(200);

      const warn = await emit(a, dev, 'port_opened', 'warning', 'Quiet: a port opened');
      const info = await emit(a, dev, 'device_renamed', 'info', 'Quiet: a device renamed');
      await emit(a, dev, 'device_offline', 'critical', 'Quiet: router down');
      await dispatchNotifications();
      expect(sentTo(captured, 'calm-q', 'Quiet: router down')).toBe(1);
      expect(sentTo(captured, 'calm-q', 'Quiet: a port opened')).toBe(0);
      expect((await holds(warn))[0]?.reason).toBe('quiet');
      expect((await holds(info))[0]?.reason).toBe('quiet');

      // Still quiet: nothing released.
      await releaseCalmSummaries();
      await dispatchNotifications();
      expect(sentTo(captured, 'calm-q', 'While quiet hours were on')).toBe(0);

      // Quiet hours end (switched off here): one summary with both items.
      expect((await a.agent.put('/api/v1/notifications/calm').set(CSRF).send({ ...SETTINGS, last_weekly_at: undefined, quiet_enabled: false })).status).toBe(200);
      await releaseCalmSummaries();
      await dispatchNotifications();
      const summary = captured.filter((c) => c.url === '/calm-q' && c.body.includes('While quiet hours were on: 2 notifications'));
      expect(summary).toHaveLength(1);
      expect(summary[0]!.body).toContain('Quiet: a port opened');
      expect((await holds(warn))[0]?.released_at).not.toBeNull();
    });
  });

  it('mutes a device, a type, or a type for one device; validates; admin only; tenant-scoped', async () => {
    await withReceiver(async (base, captured) => {
      const a = await newAccount('calm-mute');
      await pushChannel(a, base, 'calm-m');
      const dev = await addDevice(a, '10.20.2.5');
      const other = await addDevice(a, '10.20.2.6');

      expect((await a.agent.post('/api/v1/notifications/mutes').set(CSRF).send({})).status).toBe(400);
      expect((await a.agent.post('/api/v1/notifications/mutes').set(CSRF).send({ event_type: 'Bad Type' })).status).toBe(400);
      const m1 = await a.agent.post('/api/v1/notifications/mutes').set(CSRF).send({ device_id: dev, minutes: 60 });
      expect(m1.status).toBe(201);
      expect(m1.body).toMatchObject({ device_id: dev, event_type: null });
      const m2 = await a.agent.post('/api/v1/notifications/mutes').set(CSRF).send({ event_type: 'port_opened' });
      expect(m2.status).toBe(201);
      // Muting the same device again updates the one mute.
      expect((await a.agent.post('/api/v1/notifications/mutes').set(CSRF).send({ device_id: dev, minutes: 120 })).body.id).toBe(m1.body.id);
      expect((await a.agent.get('/api/v1/notifications/mutes')).body.items).toHaveLength(2);

      const e1 = await emit(a, dev, 'device_offline', 'critical', 'Muted: dev offline');
      const e2 = await emit(a, other, 'port_opened', 'warning', 'Muted: other port');
      const e3 = await emit(a, other, 'device_offline', 'critical', 'Muted: other offline');
      await dispatchNotifications();
      expect(sentTo(captured, 'calm-m', 'Muted: dev offline')).toBe(0);
      expect(sentTo(captured, 'calm-m', 'Muted: other port')).toBe(0);
      expect(sentTo(captured, 'calm-m', 'Muted: other offline')).toBe(1);
      expect((await holds(e1))[0]?.reason).toBe('muted');
      expect((await holds(e2))[0]?.reason).toBe('muted');
      expect(await holds(e3)).toEqual([]);

      // The record of held notifications is visible in settings.
      const calm = await a.agent.get('/api/v1/notifications/calm');
      expect(calm.body.recent_holds.map((h: { title: string }) => h.title)).toEqual(expect.arrayContaining(['Muted: dev offline', 'Muted: other port']));

      // Another organization sees none of it and cannot delete it.
      const b = await newAccount('calm-mute-other');
      expect((await b.agent.get('/api/v1/notifications/mutes')).body.items).toEqual([]);
      expect((await b.agent.delete(`/api/v1/notifications/mutes/${m1.body.id}`).set(CSRF)).status).toBe(404);
      expect((await b.agent.post('/api/v1/notifications/mutes').set(CSRF).send({ device_id: dev })).status).toBe(404);

      // Unmute: delivered again.
      expect((await a.agent.delete(`/api/v1/notifications/mutes/${m1.body.id}`).set(CSRF)).status).toBe(204);
      await emit(a, dev, 'device_offline', 'critical', 'Unmuted: dev offline');
      await dispatchNotifications();
      expect(sentTo(captured, 'calm-m', 'Unmuted: dev offline')).toBe(1);

      // Viewers cannot change notification rules.
      await setRole(a.email, a.organizationId, 'viewer');
      expect((await a.agent.post('/api/v1/notifications/mutes').set(CSRF).send({ event_type: 'port_opened' })).status).toBe(403);
      expect((await a.agent.put('/api/v1/notifications/calm').set(CSRF).send({ ...SETTINGS, last_weekly_at: undefined })).status).toBe(403);
    });
  });

  it('organizations without settings keep the old behaviour; bad time zones are refused', async () => {
    await withReceiver(async (base, captured) => {
      const a = await newAccount('calm-legacy');
      await systemPool.query(`DELETE FROM notification_settings WHERE organization_id = $1`, [a.organizationId]);
      expect((await a.agent.get('/api/v1/notifications/calm')).body.settings).toBeNull();
      await pushChannel(a, base, 'calm-l');
      const dev = await addDevice(a, '10.20.3.5');
      await emit(a, dev, 'device_new', 'info', 'Legacy: info one');
      await emit(a, dev, 'device_new', 'info', 'Legacy: info two');
      await dispatchNotifications();
      expect(sentTo(captured, 'calm-l', 'Legacy: info one')).toBe(1);
      expect(sentTo(captured, 'calm-l', 'Legacy: info two')).toBe(1);

      const bad = await a.agent.put('/api/v1/notifications/calm').set(CSRF).send({ ...SETTINGS, last_weekly_at: undefined, timezone: 'Mars/Olympus' });
      expect(bad.status).toBe(400);
      expect((await a.agent.put('/api/v1/notifications/calm').set(CSRF).send({ ...SETTINGS, last_weekly_at: undefined, quiet_start: '25:00' })).status).toBe(400);
    });
  });
});
