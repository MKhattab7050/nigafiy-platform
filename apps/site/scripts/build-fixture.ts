// Builds the site a second time into out-fixture/ with the populated test release
// (tests/fixtures/release.json), so the browser tests can check the Downloads page both ways.
// The fixture's hashes and host (downloads.example.com) are obviously not real; out-fixture/ is
// never published.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { SITE_DIR } from '../lib/paths.ts';

const r = spawnSync('pnpm', ['exec', 'next', 'build'], {
  cwd: SITE_DIR,
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: {
    ...process.env,
    SITE_DIST_DIR: 'out-fixture',
    NIGAFIY_SITE_RELEASE: path.join(SITE_DIR, 'tests', 'fixtures', 'release.json'),
    NEXT_TELEMETRY_DISABLED: '1',
  },
});
process.exit(r.status ?? 1);
