import { Router } from 'express';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { defineModule, validateModules } from '../src/infrastructure/module.ts';
import { type JobHealth, jobHealth, runJobOnce, safeErrorMessage, type ScheduledJob, startJobs, stopJobs } from '../src/infrastructure/scheduler.ts';
import { modules } from '../src/modules/registry.ts';
import { scheduledJobsOf } from '../src/modules/system/index.ts';
import { app, CSRF, newAccount, setRole } from './helpers.ts';

describe('module registry', () => {
  it('boots every module with unique names, jobs and lock keys', () => {
    expect(() => createApp(modules)).not.toThrow();
    const names = modules.map((m) => m.name);
    expect(new Set(names).size).toBe(names.length);
    const jobs = scheduledJobsOf(modules);
    expect(jobs.map((j) => [j.name, j.everyMs, j.lockKey, j.module]).sort()).toEqual(
      [
        ['collector-watch', 15_000, 727101, 'collectors'],
        ['config-backup', 300_000, 727122, 'config-backup'],
        ['maintenance-watch', 30_000, 727105, 'maintenance'],
        ['notification-dispatch', 5_000, 727102, 'notifications'],
        ['notification-escalation', 60_000, 727106, 'notifications'],
        ['playbook-engine', 5_000, 727140, 'playbooks'],
        ['quarantine-auto-release', 60_000, 727161, 'ports'],
        ['retention', 3_600_000, 727103, 'system'],
        ['router-schedules', 30_000, 727150, 'routers'],
        ['rollup', 600_000, 727104, 'monitoring'],
      ].sort(),
    );
  });

  it('rejects duplicate module names, job names, lock keys and mount paths', () => {
    const noop = async () => {};
    expect(() => validateModules([defineModule({ name: 'a' }), defineModule({ name: 'a' })])).toThrow(/duplicate module name/);
    expect(() => validateModules([defineModule({ name: 'Bad Name' })])).toThrow(/invalid module name/);
    expect(() =>
      validateModules([
        defineModule({ name: 'a', jobs: [{ name: 'j', everyMs: 1000, lockKey: 1, run: noop }] }),
        defineModule({ name: 'b', jobs: [{ name: 'j', everyMs: 1000, lockKey: 2, run: noop }] }),
      ]),
    ).toThrow(/duplicate job name/);
    expect(() =>
      validateModules([
        defineModule({ name: 'a', jobs: [{ name: 'j1', everyMs: 1000, lockKey: 1, run: noop }] }),
        defineModule({ name: 'b', jobs: [{ name: 'j2', everyMs: 1000, lockKey: 1, run: noop }] }),
      ]),
    ).toThrow(/duplicate job lock key/);
    expect(() =>
      validateModules([
        defineModule({ name: 'a', gateway: { path: '/x', rateLimitPerMinute: 1, router: Router() } }),
        defineModule({ name: 'b', gateway: { path: '/x', rateLimitPerMinute: 1, router: Router() } }),
      ]),
    ).toThrow(/duplicate mount path/);
  });
});

describe('GET /api/v1/system/modules', () => {
  it('requires a session', async () => {
    const res = await request(app).get('/api/v1/system/modules');
    expect(res.status).toBe(401);
  });

  it('lists modules and job health for any role, without secrets', async () => {
    const a = await newAccount('sysmod');
    await setRole(a.email, a.organizationId, 'viewer');
    const res = await a.agent.get('/api/v1/system/modules');
    expect(res.status).toBe(200);
    const names = res.body.modules.map((m: { name: string }) => m.name);
    for (const expected of ['auth', 'ingest', 'endpoints', 'events', 'incidents', 'correlation', 'realtime', 'system']) expect(names).toContain(expected);
    expect(res.body.modules.find((m: { name: string }) => m.name === 'ingest').gateway_path).toBe('/api/v1/collector');
    expect(res.body.modules.find((m: { name: string }) => m.name === 'endpoints').gateway_path).toBe('/api/v1/agent');
    expect(res.body.modules.find((m: { name: string }) => m.name === 'auth').public_path).toBe('/api/v1/auth');
    const jobs = res.body.jobs as Array<{ name: string; state: string; last_error: unknown }>;
    expect(jobs.map((j) => j.name).sort()).toEqual([
      'collector-watch',
      'config-backup',
      'maintenance-watch',
      'notification-dispatch',
      'notification-escalation',
      'playbook-engine',
      'quarantine-auto-release',
      'retention',
      'rollup',
      'router-schedules',
    ]);
    for (const j of jobs) expect(j.state).toBe('not_scheduled'); // the test process does not run the scheduler
    expect(JSON.stringify(res.body)).not.toMatch(/postgres(ql)?:\/\//);
  });
});

describe('fault isolation', () => {
  it('a rejecting handler in one module becomes a 500 for that request only', async () => {
    const broken = Router();
    broken.get('/broken-module/boom', async () => {
      throw new Error('kaboom');
    });
    const isolated = createApp([...modules, defineModule({ name: 'broken-test', api: broken })]);
    const a = await newAccount('isolation');
    const agent = request.agent(isolated);
    // reuse the session cookie of the account created against the shared app
    const login = await agent.post('/api/v1/auth/login').set(CSRF).send({ email: a.email, password: 'correct horse battery' });
    expect(login.status).toBeLessThan(300);

    const boom = await agent.get('/api/v1/broken-module/boom');
    expect(boom.status).toBe(500);
    expect(boom.body.error.code).toBe('internal_error');
    expect(JSON.stringify(boom.body)).not.toContain('kaboom');

    const sites = await agent.get('/api/v1/sites');
    expect(sites.status).toBe(200);
  });

  describe('background jobs', () => {
    afterAll(async () => {
      await stopJobs();
    });

    it('records a failing job without throwing; other jobs still run', async () => {
      let okRuns = 0;
      const failing: ScheduledJob = {
        name: 'test-failing',
        module: 'test',
        everyMs: 60_000,
        lockKey: 990_001,
        run: async () => {
          throw new Error('connect to postgres://admin:hunter2@db:5432/x failed\nsecond line');
        },
      };
      const ok: ScheduledJob = { name: 'test-ok', module: 'test', everyMs: 60_000, lockKey: 990_002, run: async () => void okRuns++ };

      await expect(runJobOnce(failing)).resolves.toBeUndefined();
      await expect(runJobOnce(ok)).resolves.toBeUndefined();
      await expect(runJobOnce(failing)).resolves.toBeUndefined();
      expect(okRuns).toBe(1);

      const [f, o] = jobHealth([failing, ok]) as [JobHealth, JobHealth];
      expect(f.runs).toBe(2);
      expect(f.failures).toBe(2);
      expect(f.consecutive_failures).toBe(2);
      expect(f.last_success_at).toBeNull();
      expect(f.last_error?.message).toBe('connect to postgres://[redacted]@db:5432/x failed second line');
      expect(o.runs).toBe(1);
      expect(o.failures).toBe(0);
      expect(o.last_success_at).not.toBeNull();
      expect(o.last_error).toBeNull();

      // The advisory lock was released after the failure: the job can run again.
      await runJobOnce(failing);
      expect(jobHealth([failing])[0]?.runs).toBe(3);
    });

    it('a job that cannot be scheduled does not stop the others', () => {
      const bad: ScheduledJob = { name: 'test-bad-interval', module: 'test', everyMs: 0, lockKey: 990_003, run: async () => {} };
      const good: ScheduledJob = { name: 'test-good-interval', module: 'test', everyMs: 3_600_000, lockKey: 990_004, run: async () => {} };
      expect(() => startJobs([bad, good])).not.toThrow();
      const [b, g] = jobHealth([bad, good]) as [JobHealth, JobHealth];
      expect(b.state).toBe('not_scheduled');
      expect(b.last_error?.message).toMatch(/invalid interval/);
      expect(g.state).toBe('idle');
    });

    it('safeErrorMessage is single-line, bounded and redacts credentials', () => {
      expect(safeErrorMessage(new Error('a\r\nb'))).toBe('a b');
      expect(safeErrorMessage('x'.repeat(1000))).toHaveLength(300);
      expect(safeErrorMessage({})).toBe('Unknown error');
      expect(safeErrorMessage(new Error('postgresql://u:p@h/d'))).toBe('postgresql://[redacted]@h/d');
    });
  });
});
