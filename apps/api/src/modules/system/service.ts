import type { ModuleManifest } from '../../infrastructure/module.ts';
import { type JobHealth, type ScheduledJob, jobHealth } from '../../infrastructure/scheduler.ts';

export interface ModuleStatus {
  name: string;
  /** Session-authenticated routes under /api/v1. */
  api: boolean;
  /** Routes reachable without a session (e.g. "/api/v1/auth"). */
  public_path: string | null;
  /** Credential-authenticated machine gateway (e.g. "/api/v1/collector"). */
  gateway_path: string | null;
  jobs: string[];
}

export interface SystemModulesReport {
  modules: ModuleStatus[];
  jobs: JobHealth[];
}

/** Every job of every module, tagged with its owner, in registry order. */
export function scheduledJobsOf(modules: readonly ModuleManifest[]): ScheduledJob[] {
  return modules.flatMap((m) => (m.jobs ?? []).map((job) => ({ ...job, module: m.name })));
}

/** What is registered and how the background jobs are doing on this API instance. No secrets: names, paths, timestamps, bounded error text. */
export function modulesReport(modules: readonly ModuleManifest[]): SystemModulesReport {
  return {
    modules: modules.map((m) => ({
      name: m.name,
      api: Boolean(m.api),
      public_path: m.publicApi ? `/api/v1${m.publicApi.path}` : null,
      gateway_path: m.gateway?.path ?? null,
      jobs: (m.jobs ?? []).map((j) => j.name),
    })),
    jobs: jobHealth(scheduledJobsOf(modules)),
  };
}
