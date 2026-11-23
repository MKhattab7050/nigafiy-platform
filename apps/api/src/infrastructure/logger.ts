import { pino } from 'pino';
import { env } from '../config/env.ts';

// Structured JSON logs. Anything that could carry a credential is redacted at the logger level,
// so a careless `logger.info({ req })` cannot leak it.
export const logger = pino({
  level: env.NODE_ENV === 'test' && !process.env.TEST_LOGS ? 'silent' : env.LOG_LEVEL,
  redact: {
    paths: [
      'password',
      '*.password',
      'token',
      '*.token',
      'enrollment_token',
      '*.enrollment_token',
      'credential',
      '*.credential',
      'secret',
      '*.secret',
      'headers.authorization',
      'headers.cookie',
      'req.headers.authorization',
      'req.headers.cookie',
    ],
    censor: '[redacted]',
  },
  base: { service: 'nigafiy-api' },
});
