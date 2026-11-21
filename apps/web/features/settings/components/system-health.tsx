'use client';

import { Async, Badge, Card, DataTable, type Tone } from '@/components/ui';
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

/** How a job is doing, from the facts the server reports. Overdue: last start older than twice its interval (plus a minute of slack). */
function verdictOf(job: JobHealth, now: number): Verdict {
  if (job.state === 'not_scheduled') return 'not_scheduled';
  if (job.state === 'running') return 'running';
  if (job.consecutive_failures > 0) return 'failing';
  if (!job.last_started_at) return 'waiting';
  if (now - new Date(job.last_started_at).getTime() > job.interval_seconds * 2000 + 60_000) return 'overdue';
  return 'ok';
}

function every(seconds: number): string {
  if (seconds % 86_400 === 0) return `${seconds / 86_400}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

/** Settings: GET /system/modules — registered parts and background-job health of this API process. */
export function SystemHealth() {
  const { t } = useI18n();
  const query = useQuery<{ modules: ModuleStatus[]; jobs: JobHealth[] }>('/system/modules', [], 30_000);
  return (
    <Card title={t('settings.system.title')} description={t('settings.system.desc')} padded={false}>
      <Async query={query}>{(data) => <Report modules={data.modules} jobs={data.jobs} />}</Async>
    </Card>
  );
}

function Report({ modules, jobs }: { modules: ModuleStatus[]; jobs: JobHealth[] }) {
  const { t, locale } = useI18n();
  const now = Date.now();
  const rows = jobs.map((j) => ({ job: j, verdict: verdictOf(j, now) }));
  const problems = rows.filter((r) => r.verdict === 'failing' || r.verdict === 'overdue' || r.verdict === 'not_scheduled').length;
  return (
    <div>
      <p className={`border-b border-line px-4 py-3 text-[13px] ${problems ? 'text-warn' : 'text-ok'}`}>
        {jobs.length === 0 ? t('settings.system.noJobs') : problems ? fill(t('settings.system.problems'), { n: problems }) : t('settings.system.allOk')}
      </p>
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
      <details className="border-t border-line px-4 py-3">
        <summary className="cursor-pointer text-[13px] font-medium">
          {t('settings.system.modules')} <span className="text-xs font-normal text-muted">({fill(t('settings.system.modulesCount'), { n: modules.length })})</span>
        </summary>
        <ul className="mt-2 grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
          {modules.map((m) => (
            <li key={m.name} className="flex flex-wrap items-center gap-1.5 text-xs">
              <span className="mono" dir="ltr">
                {m.name}
              </span>
              {m.api && <Badge tone="idle" dot={false}>{t('settings.system.api')}</Badge>}
              {m.public_path && <Badge tone="idle" dot={false}>{t('settings.system.public')}</Badge>}
              {m.gateway_path && <Badge tone="idle" dot={false}>{t('settings.system.gateway')}</Badge>}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
