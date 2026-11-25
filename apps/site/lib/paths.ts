// Where the site and the repository are. `next build`, the scripts and the tests all run with the
// working directory set to apps/site (pnpm --filter runs there); from the repository root it also works.
import { existsSync } from 'node:fs';
import path from 'node:path';

function findSiteDir(): string {
  const cwd = process.cwd();
  if (existsSync(path.join(cwd, 'lib', 'paths.ts')) && existsSync(path.join(cwd, 'next.config.ts'))) return cwd;
  return path.resolve(cwd, 'apps', 'site');
}

export const SITE_DIR = findSiteDir();
export const REPO_ROOT = path.resolve(SITE_DIR, '..', '..');
