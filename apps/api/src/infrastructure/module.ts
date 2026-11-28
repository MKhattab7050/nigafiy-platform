import type { Router } from 'express';

/**
 * The contract every feature module fulfils. A module's `index.ts` exports exactly one manifest;
 * `modules/registry.ts` lists them and `app.ts` / `main.ts` are built from that list only.
 *
 * Modules never import each other's internals: they import another module's `index.ts`, or the
 * shared `common/`, `infrastructure/` and `config/` layers.
 */
export interface ModuleManifest {
  /** Stable, unique, kebab-case name (shown by GET /api/v1/system/modules). */
  readonly name: string;

  /**
   * Routes reachable WITHOUT a session (sign-in, registration…), mounted under `/api/v1<path>`
   * after the JSON body parser and before `requireSession`.
   */
  readonly publicApi?: { readonly path: `/${string}`; readonly router: Router };

  /** Session-authenticated routes, mounted under `/api/v1` after `requireSession`. Paths are absolute within /api/v1. */
  readonly api?: Router;

  /**
   * Credential-authenticated machine gateway (collector, endpoint agent). Mounted at `path` before the
   * user API's JSON body parser, with its own per-minute rate limit; the router parses its own body.
   */
  readonly gateway?: { readonly path: `/${string}`; readonly rateLimitPerMinute: number; readonly router: Router };

  /** Background jobs owned by the module, run by the shared scheduler (infrastructure/scheduler.ts). */
  readonly jobs?: readonly JobDefinition[];

  /** Process-lifetime resources (listeners, connections) started after the HTTP server listens. */
  readonly lifecycle?: { readonly start?: () => Promise<void>; readonly stop?: () => Promise<void> };
}

export interface JobDefinition {
  /** Unique job name; also the name used in logs and in the job-health report. */
  readonly name: string;
  readonly everyMs: number;
  /** Stable key for the PostgreSQL advisory lock that makes the job single-runner across API instances. */
  readonly lockKey: number;
  /**
   * Gets a signal that aborts when the run passes its deadline (`timeoutMs`, else the scheduler's
   * RUN_DEADLINE_MS). Jobs that wait on the network should hand it on; the scheduler stops waiting
   * at the deadline either way.
   */
  readonly run: (signal: AbortSignal) => Promise<void>;
  /** Total time one run may take before the scheduler gives up on it. Default RUN_DEADLINE_MS. */
  readonly timeoutMs?: number;
}

export const defineModule = <M extends ModuleManifest>(manifest: M): M => manifest;

/**
 * Registry invariants, checked once at start-up: unique module names, job names and job lock keys,
 * and unique gateway/public mount paths. A violation is a programming error and fails fast.
 */
export function validateModules<T extends readonly ModuleManifest[]>(modules: T): T {
  const seen = (what: string) => {
    const set = new Set<string | number>();
    return (value: string | number) => {
      if (set.has(value)) throw new Error(`Module registry: duplicate ${what} "${value}"`);
      set.add(value);
    };
  };
  const name = seen('module name');
  const job = seen('job name');
  const lock = seen('job lock key');
  const path = seen('mount path');
  for (const m of modules) {
    if (!/^[a-z][a-z0-9-]*$/.test(m.name)) throw new Error(`Module registry: invalid module name "${m.name}"`);
    name(m.name);
    if (m.gateway) path(m.gateway.path);
    if (m.publicApi) path(`/api/v1${m.publicApi.path}`);
    for (const j of m.jobs ?? []) {
      job(j.name);
      lock(j.lockKey);
    }
  }
  return modules;
}
