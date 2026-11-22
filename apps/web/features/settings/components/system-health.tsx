'use client';

import { Activity, ArrowRight } from 'lucide-react';
import Link from 'next/link';
import { Async, Badge, Card, DataTable, PageHeader, type Tone } from '@/components/ui';
import { useQuery } from '@/lib/app';
import { absoluteTime, relativeTime } from '@/lib/format';
import { type Key, fill, useI18n } from '@/lib/i18n';

interface JobHealth {
  name: string;
  module: string;
  interval_seconds: number;
  state: 'not_scheduled' | 'idle' | 'running';
  runs: number;
  failures: number;
  consecutive_failures: number;
  last_started_at: string | null;
  last_finished_at: string | null;
  last_success_at: string | null;
  last_skipped_at: string | null;
  last_error: { at: string; message: string } | null;
  /** Computed by the server: no start within interval × grace (infrastructure/scheduler.ts). */
  overdue: boolean;
  overdue_at: string | null;
}

interface ModuleStatus {
  name: string;
  api: boolean;
  public_path: string | null;
  gateway_path: string | null;
  jobs: string[];
}

type Verdict = 'running' | 'ok' | 'failing' | 'overdue' | 'waiting' | 'not_scheduled';

const TONE: Record<Verdict, Tone> = { running: 'info', ok: 'ok', failing: 'crit', overdue: 'warn', waiting: 'idle', not_scheduled: 'warn' };

/** How a job is doing, from the facts the server reports (overdue is the server's own flag). */
function verdictOf(job: JobHealth): Verdict {
  if (job.state === 'not_scheduled') return 'not_scheduled';
  if (job.overdue) return 'overdue';
  if (job.state === 'running') return 'running';
  if (job.consecutive_failures > 0) return 'failing';
  if (!job.last_started_at) return 'waiting';
  return 'ok';
}

type Report = { modules: ModuleStatus[]; jobs: JobHealth[] };

const problemCount = (jobs: JobHealth[]) =>
  jobs.map(verdictOf).filter((v) => v === 'failing' || v === 'overdue' || v === 'not_scheduled').length;

function every(seconds: number): string {
  if (seconds % 86_400 === 0) return `${seconds / 86_400}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

function Summary({ jobs }: { jobs: JobHealth[] }) {
  const { t } = useI18n();
  const problems = problemCount(jobs);
  return (
    <p className={`border-b border-line px-4 py-3 text-[13px] ${problems ? 'text-warn' : 'text-ok'}`}>
      {jobs.length === 0 ? t('settings.system.noJobs') : problems ? fill(t('settings.system.problems'), { n: problems }) : t('settings.system.allOk')}
    </p>
  );
}

/** Settings: a one-line verdict from GET /system/modules and the way to the full self-check page. */
export function SystemHealth() {
  const { t } = useI18n();
  const query = useQuery<Report>('/system/modules', [], 30_000);
  return (
    <Card
      title={t('settings.system.title')}
      description={t('settings.system.desc')}
      padded={false}
      action={
        <Link href="/system/modules" className="inline-flex items-center gap-1 text-[13px] font-medium text-accent-hover hover:underline">
          {t('settings.system.open')}
          <ArrowRight className="size-3.5 rtl:-scale-x-100" aria-hidden />
        </Link>
      }
    >
      <Async query={query}>{(data) => <Summary jobs={data.jobs} />}</Async>
    </Card>
  );
}

/** Hub page /system/modules: every registered module and every background job with last run, last error and overdue. */
export function SystemModulesScreen() {
  const { t } = useI18n();
  const query = useQuery<Report>('/system/modules', [], 15_000);
  return (
    <>
      <PageHeader icon={<Activity className="size-[18px]" aria-hidden />} title={t('settings.system.title')} description={t('settings.system.pageDesc')} />
      <Async query={query}>
        {(data) => (
          <div className="space-y-4">
            <Card title={t('settings.system.jobs')} padded={false}>
              <Jobs jobs={data.jobs} />
            </Card>
            <Card title={t('settings.system.modules')} description={fill(t('settings.system.modulesCount'), { n: data.modules.length })} padded={false}>
              <Modules modules={data.modules} />
            </Card>
          </div>
        )}
      </Async>
    </>
  );
}

function Jobs({ jobs }: { jobs: JobHealth[] }) {
  const { t, locale } = useI18n();
  const rows = jobs.map((j) => ({ job: j, verdict: verdictOf(j) }));
  return (
    <div>
      <Summary jobs={jobs} />
      {jobs.length > 0 && (
        <DataTable stack minWidth={820}>
          <thead>
            <tr>
              <th>{t('settings.system.job')}</th>
              <th>{t('settings.system.every')}</th>
              <th>{t('settings.system.state')}</th>
              <th>{t('settings.system.lastRun')}</th>
              <th>{t('settings.system.lastSuccess')}</th>
              <th>{t('settings.system.runs')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ job, verdict }) => (
              <tr key={`${job.module}/${job.name}`}>
                <td data-label={t('settings.system.job')}>
                  <span className="mono text-[13px]" dir="ltr">
                    {job.name}
                  </span>
                  <span className="block text-xs text-muted" dir="ltr">
                    {job.module}
                  </span>
                </td>
                <td data-label={t('settings.system.every')} className="tnum text-xs" dir="ltr">
                  {every(job.interval_seconds)}
                </td>
                <td data-label={t('settings.system.state')}>
                  <div className="space-y-1">
                    <Badge tone={TONE[verdict]}>{t(`settings.system.state.${verdict}` as Key)}</Badge>
                    {verdict === 'not_scheduled' && <p className="max-w-xs text-xs text-muted">{t('settings.system.notScheduledHint')}</p>}
                    {verdict === 'overdue' && <p className="max-w-xs text-xs text-muted">{t('settings.system.overdueHint')}</p>}
                    {job.overdue_at && !job.overdue && (
                      <p className="text-xs text-faint" title={absoluteTime(job.overdue_at, locale)}>
                        {fill(t('settings.system.overdueAt'), { when: relativeTime(job.overdue_at, locale) })}
                      </p>
                    )}
                    {verdict === 'failing' && <p className="max-w-xs text-xs text-muted">{fill(t('settings.system.failingHint'), { n: job.consecutive_failures })}</p>}
                    {job.last_error && (
                      <p className="max-w-sm text-xs text-crit">
                        <span className="font-medium">{t('settings.system.lastError')}</span> ({relativeTime(job.last_error.at, locale)}):{' '}
                        <span className="mono break-all" dir="ltr">
                          {job.last_error.message}
                        </span>
                      </p>
                    )}
                    {job.last_skipped_at && <p className="text-xs text-muted">{fill(t('settings.system.skipped'), { when: relativeTime(job.last_skipped_at, locale) })}</p>}
                  </div>
                </td>
                <td data-label={t('settings.system.lastRun')} className="text-xs text-muted" title={absoluteTime(job.last_started_at, locale)}>
                  {job.last_started_at ? relativeTime(job.last_started_at, locale) : t('common.never')}
                </td>
                <td data-label={t('settings.system.lastSuccess')} className="text-xs text-muted" title={absoluteTime(job.last_success_at, locale)}>
                  {job.last_success_at ? relativeTime(job.last_success_at, locale) : t('common.never')}
                </td>
                <td data-label={t('settings.system.runs')} className="tnum text-xs">
                  {job.runs} / <span className={job.failures ? 'text-crit' : undefined}>{job.failures}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}
    </div>
  );
}

function Modules({ modules }: { modules: ModuleStatus[] }) {
  const { t } = useI18n();
  return (
    <DataTable stack minWidth={640}>
      <thead>
        <tr>
          <th>{t('settings.system.module')}</th>
          <th>{t('settings.system.paths')}</th>
          <th>{t('settings.system.jobs')}</th>
        </tr>
      </thead>
      <tbody>
        {modules.map((m) => (
          <tr key={m.name}>
            <td data-label={t('settings.system.module')}>
              <span className="mono text-[13px]" dir="ltr">
                {m.name}
              </span>
            </td>
            <td data-label={t('settings.system.paths')}>
              <div className="flex flex-wrap items-center gap-1.5 text-xs">
                {m.api && <Badge tone="idle" dot={false}>{t('settings.system.api')}</Badge>}
                {m.public_path && (
                  <Badge tone="idle" dot={false}>
                    {t('settings.system.public')}{' '}
                    <bdi className="mono" dir="ltr">
                      {m.public_path}
                    </bdi>
                  </Badge>
                )}
                {m.gateway_path && (
                  <Badge tone="idle" dot={false}>
                    {t('settings.system.gateway')}{' '}
                    <bdi className="mono" dir="ltr">
                      {m.gateway_path}
                    </bdi>
                  </Badge>
                )}
              </div>
            </td>
            <td data-label={t('settings.system.jobs')} className="text-xs">
              {m.jobs.length ? (
                <span className="mono" dir="ltr">
                  {m.jobs.join(', ')}
                </span>
              ) : (
                <span className="text-muted">—</span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </DataTable>
  );
}
