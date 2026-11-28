import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { clearStartupFailures, recordStartupFailure } from '../src/infrastructure/startup.ts';
import { app } from './helpers.ts';

describe('/readyz and failed start-up steps', () => {
  afterEach(() => clearStartupFailures());

  it('ready while nothing failed to start', async () => {
    const res = await request(app).get('/readyz');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ready', database: 'ok', failed_steps: [] });
  });

  it('not ready, with the failed step, when a module or the jobs did not start', async () => {
    recordStartupFailure('module:notifications', new Error('listener could not connect\nto postgres://app:secret@db/x'));
    recordStartupFailure('jobs', 'no jobs');
    const res = await request(app).get('/readyz');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('not_ready');
    expect(res.body.database).toBe('ok');
    expect(res.body.failed_steps).toHaveLength(2);
    expect(res.body.failed_steps[0]).toMatchObject({ step: 'module:notifications' });
    // One line, no credentials (the same scrubbing as the job-health report).
    expect(res.body.failed_steps[0].message).toBe('listener could not connect to postgres://[redacted]@db/x');
    expect(res.body.failed_steps[1]).toMatchObject({ step: 'jobs', message: 'no jobs' });
    // Liveness is unaffected: the process is up.
    expect((await request(app).get('/healthz')).status).toBe(200);
  });
});
