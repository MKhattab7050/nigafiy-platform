import { Writable } from 'node:stream';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { loggerOptions } from '../src/infrastructure/logger.ts';

// EXT-9: SNMP communities, router passwords and the other credentials never reach a log line.
describe('logger redaction', () => {
  it('redacts secret fields at the top level and nested two levels', () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        lines.push(chunk.toString());
        cb();
      },
    });
    const log = pino({ level: 'info', ...loggerOptions }, sink);
    log.info({ community: 'public', router: { password: 'hunter2', host: '10.0.0.1' }, body: { snmp: { community: 'private', auth_key: 'k3y', priv_key: 'p4v' } } }, 'snmp');
    log.info({ oidc_client_secret: 'oidc-s3cret', webhook_url: 'https://hooks.slack.com/services/T/B/XYZSECRET', mfa_token: 'mfa-tok', recovery_codes: ['AAAA-BBBB'] }, 'misc');
    log.info({ req: { headers: { authorization: 'Bearer lda_x.y', cookie: 'ld_session=abc' } } }, 'req');
    const out = lines.join('\n');
    for (const secret of ['public', 'hunter2', 'private', 'k3y', 'p4v', 'oidc-s3cret', 'XYZSECRET', 'mfa-tok', 'AAAA-BBBB', 'lda_x.y', 'ld_session=abc']) {
      expect(out, secret).not.toContain(secret);
    }
    expect(out).toContain('10.0.0.1');
    expect(out).toContain('[redacted]');
  });
});
