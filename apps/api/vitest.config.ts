import { defineConfig } from 'vitest/config';

// Integration tests run against a real, throw-away PostgreSQL server (see tests/global-setup.ts).
// Nothing here is mocked: HTTP → Express → SQL → Row Level Security is exercised end to end.
export default defineConfig({
  test: {
    globalSetup: './tests/global-setup.ts',
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 180_000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://postgres:postgres@127.0.0.1:5439/lan_detective_test',
      APP_DATABASE_URL: 'postgres://lan_app:test-app-password@127.0.0.1:5439/lan_detective_test',
      APP_ENCRYPTION_KEY: '0f'.repeat(32),
      WEB_ORIGIN: 'http://localhost:3100',
      ALLOW_LOOPBACK_SCOPES: 'false',
      ALLOW_PRIVATE_WEBHOOKS: 'true',
      SMTP_ALLOW_PRIVATE_HOSTS: 'true',
    },
  },
});
