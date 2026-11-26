import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import type { Insight } from '@nigafiy/shared-types';
import { closePools, systemPool } from '../src/infrastructure/db.ts';
import type { JobHealth } from '../src/infrastructure/scheduler.ts';
import { healthActions, schedulerSummary } from '../src/modules/system/health.ts';
import { generateWeeklyReport, generateWeeklyReports, mergeGaps, weeklyEvents, weeklyImprovements } from '../src/modules/weekly-report/index.ts';
import type { WeeklyFacts } from '../src/modules/weekly-report/rules.ts';
import { app, CSRF, heartbeat, newAccount, newCollector, setRole } from './helpers.ts';

afterAll(closePools);

const H = 3600_000;
const DAY = 24 * H;

const job = (over: Partial<JobHealth>): JobHealth => ({
  name: 'j',
  module: 'm',
  interval_seconds: 60,
  state: 'idle',
  runs: 10,
  failures: 0,
  consecutive_failures: 0,
  last_started_at: '2026-11-26T10:00:00.000Z',
  last_finished_at: '2026-11-26T10:00:01.000Z',
  last_success_at: '2026-11-26T10:00:01.000Z',
  last_skipped_at: null,
  last_error: null,
  overdue: false,
  overdue_at: '2026-11-26T10:03:00.000Z',
  ...over,
});

describe('System Health: scheduler verdict', () => {
  it('not_running when this process schedules nothing, ok when all run', () => {
    expect(schedulerSummary([job({ state: 'not_scheduled' })]).state).toBe('not_running');
    expect(schedulerSummary([job({}), job({ name: 'k' })])).toMatchObject({ state: 'ok', jobs: 2, late: [], failing: [] });
  });

  it('degraded with a late or failing job, stalled when half or more are late', () => {
    const failing = job({ name: 'f', consecutive_failures: 2, last_error: { at: '2026-11-26T10:05:00.000Z', message: 'boom' } });
    const late = job({ name: 'l', overdue: true });
    const s = schedulerSummary([job({}), job({ name: 'k' }), failing, late]);
    expect(s.state).toBe('degraded');
    expect(s.late).toEqual([{ name: 'l', module: 'm', since: '2026-11-26T10:03:00.000Z' }]);
    expect(s.failing).toMatchObject([{ name: 'f', failures: 2, message: 'boom' }]);
    expect(schedulerSummary([job({}), late, job({ name: 'l2', overdue: true })]).state).toBe('stalled');
  });

  it('asks the user to act only on what lasts', () => {
    const base = {
      api: { running: true as const, started_at: '', version: null },
      database: { reachable: true, latency_ms: 1 },
      monitoring: { active: true, sensors: [{ id: 'x', name: 'edge', state: 'online' as const, last_heartbeat_at: null }], last_gap: null },
      outside_heartbeat: { configured: false, ok: null, last_ping_at: null },
      instant_channels: 0,
    };
    const oneFailure = job({ consecutive_failures: 1, last_error: { at: 'x', message: 'once' } });
    expect(healthActions({ ...base, scheduler: schedulerSummary([job({}), oneFailure]) })).toEqual([]);
    const keepsFailing = job({ consecutive_failures: 3, last_error: { at: 'x', message: 'again' } });
    expect(healthActions({ ...base, scheduler: schedulerSummary([job({}), keepsFailing]) }).map((a) => a.code)).toEqual(['jobs_stuck']);
  });
});

describe('GET /api/v1/system/health', () => {
  it('requires a session', async () => {
    expect((await request(app).get('/api/v1/system/health')).status).toBe(401);
  });

  it('answers for any role: no Sensor yet, then monitoring active with the last gap', async () => {
    const a = await newAccount('syshealth');
    await setRole(a.email, a.organizationId, 'viewer');
    let res = await a.agent.get('/api/v1/system/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ api: { running: true }, database: { reachable: true }, monitoring: { active: false, sensors: [], last_gap: null } });
    expect(res.body.scheduler.state).toBe('not_running'); // the test process runs no scheduler
    expect(res.body.actions.map((x: { code: string }) => x.code)).toEqual(['scheduler_stopped', 'no_sensor']);

    const c = await newCollector(a);
    expect((await heartbeat(c)).status).toBe(200);
    const from = new Date(Date.now() - 2 * H);
    const to = new Date(from.getTime() + 7 * 60_000);
    await systemPool.query(`INSERT INTO monitoring_gaps (organization_id, kind, started_at, ended_at) VALUES ($1, 'api', $2, $3)`, [a.organizationId, from, to]);
    res = await a.agent.get('/api/v1/system/health');
    expect(res.body.monitoring).toMatchObject({ active: true, sensors: [{ name: 'edge-1', state: 'online' }] });
    expect(res.body.monitoring.last_gap).toEqual({ kind: 'api', started_at: from.toISOString(), ended_at: to.toISOString(), duration_seconds: 420 });
    expect(res.body.actions.map((x: { code: string }) => x.code)).not.toContain('no_sensor');
    expect(res.body.outside_heartbeat).toEqual({ configured: false, ok: null, last_ping_at: null });
  });
});

const facts = (over: Partial<WeeklyFacts> = {}): WeeklyFacts => ({
  timezone: 'UTC',
  score: 82,
  previousScore: null,
  incidents: { opened: 0, resolved: 0, stillOpen: 0, longest: null, domains: [] },
  newDevices: { n: 0, unreviewed: 0 },
  gaps: { n: 0, totalSeconds: 0, longest: null },
  insights: [],
  heartbeatConfigured: false,
  ...over,
});

const insight = (code: string, severity: Insight['severity'], category: Insight['category'] = 'setup'): Insight => ({
  id: code,
  code,
  params: {},
  severity,
  category,
  title: `${code} title`,
  detail: `${code} detail`,
  evidence: [],
  actions: [{ code: 'open', label: 'Open', kind: 'link', href: `/x/${code}` }],
});

describe('weekly report rules', () => {
  it('a quiet week is one line besides the score', () => {
    expect(weeklyEvents(facts()).map((l) => l.text)).toEqual(['Health score: 82/100.', 'A quiet week: nothing needed you.']);
  });

  it('one sentence per main event, with the score change and the Doctor’s fault domain', () => {
    const lines = weeklyEvents(
      facts({
        previousScore: 75,
        incidents: { opened: 3, resolved: 2, stillOpen: 1, longest: { title: 'Internet down', seconds: 5400, open: false }, domains: [{ domain: 'wan_isp', n: 2 }] },
        newDevices: { n: 2, unreviewed: 1 },
        gaps: { n: 1, totalSeconds: 420, longest: { from: new Date('2026-11-24T15:39:00Z'), to: new Date('2026-11-24T15:46:00Z') } },
      }),
    );
    expect(lines.map((l) => l.code)).toEqual(['score_up', 'problems', 'longest', 'doctor_domain', 'new_devices', 'monitoring_off']);
    expect(lines.map((l) => l.text)).toEqual([
      'Health score went up from 75 to 82.',
      '3 problems started; 2 solved, 1 still open.',
      'Longest problem: "Internet down" (1 h 30 min).',
      'The Network Doctor traced 2 of them to the internet provider.',
      '2 new devices joined the network; 1 not reviewed yet.',
      'Monitoring was off for 7 min, from Tue 15:39 to Tue 15:46.',
    ]);
  });

  it('top 3 improvements: most severe first, the outside heartbeat after a gap', () => {
    const list = weeklyImprovements(
      facts({
        insights: [insight('a_info', 'info'), insight('b_warn', 'warning', 'inventory'), insight('c_crit', 'critical'), insight('d_warn_sec', 'warning', 'security')],
        gaps: { n: 1, totalSeconds: 600, longest: { from: new Date(), to: new Date() } },
      }),
    );
    expect(list.map((i) => i.code)).toEqual(['c_crit', 'd_warn_sec', 'b_warn']);
    expect(list[0]!.href).toBe('/x/c_crit');
    const withRoom = weeklyImprovements(facts({ insights: [insight('c_crit', 'critical')], gaps: { n: 1, totalSeconds: 600, longest: { from: new Date(), to: new Date() } } }));
    expect(withRoom.map((i) => i.code)).toEqual(['c_crit', 'setup_outside_heartbeat']);
    expect(weeklyImprovements(facts({ heartbeatConfigured: true, gaps: { n: 1, totalSeconds: 1, longest: { from: new Date(), to: new Date() } } }))).toEqual([]);
  });

  it('merges overlapping gaps and clips them to the week', () => {
    const d = (h: number) => new Date(Date.UTC(2026, 10, 23) + h * H);
    expect(mergeGaps([{ started_at: d(-2), ended_at: d(1) }, { started_at: d(0.5), ended_at: d(2) }, { started_at: d(5), ended_at: d(6) }], d(0), d(168))).toEqual([
      { from: d(0), to: d(2) },
      { from: d(5), to: d(6) },
    ]);
  });
});

describe('weekly report job and endpoints', () => {
  // Thursday 2026-11-26 12:00 UTC: the last finished week is Mon 2026-11-16 .. Mon 2026-11-23.
  const now = new Date('2026-11-26T12:00:00Z');

  async function watchedAccount(label: string) {
    const a = await newAccount(label);
    const c = await newCollector(a);
    await heartbeat(c);
    await systemPool.query(`UPDATE collectors SET created_at = $2 WHERE id = $1`, [c.id, new Date('2026-11-01T00:00:00Z')]);
    await systemPool.query(`UPDATE sites SET timezone = 'UTC' WHERE organization_id = $1`, [a.organizationId]);
    return a;
  }

  it('makes one report per organization and week (idempotent), readable by any role', async () => {
    const a = await watchedAccount('weekly');
    await systemPool.query(
      `INSERT INTO monitoring_gaps (organization_id, kind, started_at, ended_at) VALUES ($1, 'api', '2026-11-18T15:39:00Z', '2026-11-18T15:46:00Z')`,
      [a.organizationId],
    );
    await systemPool.query(
      `INSERT INTO incidents (organization_id, site_id, number, kind, correlation_key, status, severity, title, opened_at, resolved_at, diagnosis)
       VALUES ($1, $2, 1, 'network', 'k1', 'resolved', 'warning', 'Internet down', '2026-11-17T08:00:00Z', '2026-11-17T09:30:00Z', '{"fault_domain":"wan_isp"}'),
              ($1, $2, 2, 'network', 'k2', 'resolved', 'warning', 'Internet slow', '2026-11-19T08:00:00Z', '2026-11-19T08:20:00Z', '{"fault_domain":"wan_isp"}'),
              ($1, $2, 3, 'network', 'k3', 'resolved', 'warning', 'Last week', '2026-11-10T08:00:00Z', '2026-11-10T08:20:00Z', NULL)`,
      [a.organizationId, a.siteId],
    );

    expect(await generateWeeklyReport(a.organizationId, now)).toBe(true);
    expect(await generateWeeklyReport(a.organizationId, now)).toBe(false);
    expect(await generateWeeklyReports(new Date(now.getTime() + H))).toBeGreaterThanOrEqual(0);
    const rows = await systemPool.query(`SELECT week_start::text AS w FROM weekly_reports WHERE organization_id = $1`, [a.organizationId]);
    expect(rows.rows).toEqual([{ w: '2026-11-16' }]);

    await setRole(a.email, a.organizationId, 'viewer');
    const view = (await a.agent.get('/api/v1/reports/weekly')).body;
    expect(view.settings).toEqual({ notify: false });
    expect(view.reports).toHaveLength(1);
    expect(view.latest).toMatchObject({ week_start: '2026-11-16', final: true, period_from: '2026-11-16T00:00:00.000Z', period_to: '2026-11-23T00:00:00.000Z', notified_at: null });
    const codes = view.latest.events.map((l: { code: string }) => l.code);
    expect(codes).toEqual(['score', 'problems', 'longest', 'doctor_domain', 'monitoring_off']);
    expect(view.latest.events[1].text).toBe('2 problems started and all are solved.');
    expect(view.latest.events[4].text).toBe('Monitoring was off for 7 min, from Wed 15:39 to Wed 15:46.');
    expect(view.latest.improvements.length).toBeLessThanOrEqual(3);
    expect(view.latest.improvements.map((i: { code: string }) => i.code)).toContain('setup_outside_heartbeat');

    expect((await a.agent.get('/api/v1/reports/weekly/2026-11-16')).body.id).toBe(view.latest.id);
    expect((await a.agent.get('/api/v1/reports/weekly/2026-11-09')).status).toBe(404);
    const current = (await a.agent.get('/api/v1/reports/weekly/current')).body;
    expect(current).toMatchObject({ final: false, id: null });
    // A viewer may read but not change the setting.
    expect((await a.agent.put('/api/v1/reports/weekly/settings').set(CSRF).send({ notify: true })).status).toBe(403);
  });

  it('sends nothing unless notify is on; then one event to the enabled channels', async () => {
    const a = await watchedAccount('weekly-notify');
    const ch = await a.agent
      .post('/api/v1/notifications/channels')
      .set(CSRF)
      .send({ name: 'hook', kind: 'webhook', config: { url: 'https://example.com/hook' }, min_severity: 'critical' });
    expect(ch.status).toBe(201);
    expect((await a.agent.put('/api/v1/reports/weekly/settings').set(CSRF).send({ notify: true })).body).toEqual({ notify: true });
    expect((await a.agent.get('/api/v1/reports/weekly')).body).toMatchObject({ settings: { notify: true }, channels: 1 });

    expect(await generateWeeklyReport(a.organizationId, now)).toBe(true);
    const ev = await systemPool.query<{ id: string; title: string; details: Record<string, unknown> }>(
      `SELECT id, title, details FROM network_events WHERE organization_id = $1 AND type = 'weekly_report'`,
      [a.organizationId],
    );
    expect(ev.rows).toHaveLength(1);
    expect(ev.rows[0]!.title).toMatch(/^Weekly report: score \d+, no problems$/);
    expect(ev.rows[0]!.details).toMatchObject({ week: '2026-11-16', quiet: 'A quiet week: nothing needed you.' });
    const deliveries = await systemPool.query(`SELECT 1 FROM notification_deliveries WHERE event_id = $1`, [ev.rows[0]!.id]);
    expect(deliveries.rowCount).toBe(1);
    expect((await a.agent.get('/api/v1/reports/weekly')).body.latest.notified_at).not.toBeNull();

    // The next week's report sees this one's score as the previous one.
    expect(await generateWeeklyReport(a.organizationId, new Date(now.getTime() + 7 * DAY))).toBe(true);
    const latest = (await a.agent.get('/api/v1/reports/weekly')).body.latest;
    expect(latest.week_start).toBe('2026-11-23');
    expect(latest.previous_score).not.toBeNull();
    expect(latest.events[0].code).toMatch(/^score_(up|down|same)$/);
  });

  it('makes no report for a week nothing was watched in', async () => {
    const a = await newAccount('weekly-none');
    const c = await newCollector(a);
    await heartbeat(c);
    // The Sensor was enrolled after that week ended (it is "now" in real time).
    expect(await generateWeeklyReport(a.organizationId, now)).toBe(false);
  });
});
