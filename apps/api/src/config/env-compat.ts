/**
 * Environment variables after the rename (docs/architecture/naming.md): every `LD_*` variable is now
 * `NIGAFIY_*`. The new name wins; the old one is still read so existing launch scripts, services and
 * `.env` files keep working, and logs one deprecation line per name.
 *
 * Copies of this table live where TypeScript cannot be imported: `scripts/local.mjs` (bundled on its
 * own into the desktop app) and `apps/desktop/src/env-compat.cjs`. The Go side has its own tables
 * (`config.Getenv` in the Sensor and the Agent, `engine` for the data and bundle folders).
 */
export const LEGACY_ENV: Readonly<Record<string, string>> = {
  NIGAFIY_DATA_DIR: 'LD_DATA_DIR',
  NIGAFIY_BUNDLE_DIR: 'LD_BUNDLE_DIR',
  NIGAFIY_PG_DIR: 'LD_PG_DIR',
  NIGAFIY_PG_BIN_DIR: 'LD_PG_BIN_DIR',
  NIGAFIY_SETUP_EMAIL: 'LD_SETUP_EMAIL',
  NIGAFIY_SETUP_PASSWORD: 'LD_SETUP_PASSWORD',
  NIGAFIY_DESKTOP_NO_ENGINE: 'LD_DESKTOP_NO_ENGINE',
  NIGAFIY_DESKTOP_AUTO_CONSENT: 'LD_DESKTOP_AUTO_CONSENT',
  NIGAFIY_TEST_PG_PORT: 'LD_TEST_PG_PORT',
  NIGAFIY_TEST_REDIS_URL: 'LD_TEST_REDIS_URL',
  NIGAFIY_TEST_AGENT_LOGS: 'LD_TEST_AGENT_LOGS',
};

const warned = new Set<string>();

/** Test hook: forget which deprecation lines were already printed. */
export function resetEnvWarnings(): void {
  warned.clear();
}

/**
 * The value of `name` (a new `NIGAFIY_*` name), else of its legacy `LD_*` name, else undefined.
 * Empty strings count as unset. Reading the legacy name logs one warning per name per process.
 */
export function readEnv(name: string, env: NodeJS.ProcessEnv = process.env, warn: (message: string) => void = console.warn): string | undefined {
  const value = env[name];
  if (value !== undefined && value !== '') return value;
  const legacy = LEGACY_ENV[name];
  if (!legacy) return undefined;
  const old = env[legacy];
  if (old === undefined || old === '') return undefined;
  if (!warned.has(legacy)) {
    warned.add(legacy);
    warn(`[env] ${legacy} is deprecated, use ${name} (the old name still works)`);
  }
  return old;
}

/** A copy of `env` where every legacy name that is set fills its new name when that is unset. */
export function withNewNames(env: NodeJS.ProcessEnv = process.env, warn: (message: string) => void = console.warn): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const name of Object.keys(LEGACY_ENV)) {
    const v = readEnv(name, env, warn);
    if (v !== undefined) out[name] = v;
  }
  return out;
}
