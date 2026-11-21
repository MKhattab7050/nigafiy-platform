import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { waitForCommandSignal } from '../src/modules/endpoints/commands/service.ts';
import { endpointsModule } from '../src/modules/endpoints/index.ts';
import { COMMAND_DONE_CHANNEL } from '../src/modules/endpoints/repo.ts';
import { isListening } from '../src/infrastructure/pg-listen.ts';

// A result uploaded to ANOTHER API instance reaches this one only through PostgreSQL NOTIFY.
// The "other instance" here is a separate database connection that commits a pg_notify.
describe('cross-instance command wake-up (LISTEN/NOTIFY)', () => {
  afterAll(async () => {
    await endpointsModule.lifecycle.stop();
  });

  it('wakes a waiter on this instance when another connection notifies the command id', async () => {
    await endpointsModule.lifecycle.start();
    expect(isListening()).toBe(true);

    const id = crypto.randomUUID();
    const started = Date.now();
    const waiting = waitForCommandSignal(id, 10_000);

    const other = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await other.connect();
    try {
      await other.query('BEGIN');
      await other.query('SELECT pg_notify($1, $2)', [COMMAND_DONE_CHANNEL, id]);
      await other.query('COMMIT');
    } finally {
      await other.end();
    }

    await waiting;
    // Far below the 10 s timeout: the notification, not the timer, resolved the wait.
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});
