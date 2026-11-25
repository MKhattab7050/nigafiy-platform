'use client';

import { CalendarClock, Download, Pause, Play, Plus, RotateCcw, XCircle } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { FleetJob, FleetJobDetail, FleetJobResult, FleetJobState } from '@nigafiy/shared-types';
import { Async, Badge, Button, Card, DataTable, PageHeader, Tabs, type Tone, useConfirm } from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { absoluteTime, relativeTime } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { ltr } from '@/lib/localize/bidi';
import { JobDialog, jobsError } from '../components/fleet-jobs/job-dialog';
import { jobsText } from '../components/fleet-jobs/jobs-text';

const JOB_TONE: Record<FleetJobState, Tone> = { active: 'ok', paused: 'warn', cancelled: 'idle', finished: 'idle' };
const RESULT_TONE: Record<string, Tone> = { pending: 'warn', queued: 'warn', succeeded: 'ok', failed: 'crit', expired: 'crit', cancelled: 'idle', skipped: 'idle' };

/** Nigafiy Fleet → Jobs (technicians and up; viewers have no access). */
export function FleetJobsScreen() {
  const { locale } = useI18n();
  const tx = jobsText(locale);
  const router = useRouter();
  const [state, setState] = useState<FleetJobState | 'all'>('active');
  const q = useQuery<{ jobs: FleetJob[] }>(`/fleet/jobs${state === 'all' ? '' : `?state=${state}`}`, ['devices'], 10_000);
  const [creating, setCreating] = useState(false);
  const fmt = (iso: string) => absoluteTime(iso, locale);

  return (
    <div className="space-y-5">
      <PageHeader
        title={tx.jobsTitle}
        description={tx.jobsSubtitle}
        icon={<CalendarClock className="size-5" aria-hidden />}
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Plus className="size-4" aria-hidden />
            {tx.newJob}
          </Button>
        }
      />
      <Card padded={false}>
        <div className="border-b border-line px-4 py-2">
          <Tabs<FleetJobState | 'all'>
            label={tx.jobsTitle}
            value={state}
            onChange={setState}
            options={(['active', 'paused', 'finished', 'cancelled', 'all'] as const).map((s) => ({ value: s, label: s === 'all' ? tx.allStates : tx.jobState[s] }))}
          />
        </div>
        <Async query={q}>
          {({ jobs }) =>
            jobs.length === 0 ? (
              <p className="p-5 text-sm text-muted">{tx.noJobs}</p>
            ) : (
              <DataTable stack minWidth={760}>
                <thead>
                  <tr>
                    <th>{tx.name}</th>
                    <th>{tx.schedule}</th>
                    <th>{tx.lastRun}</th>
                    <th>{tx.nextRun}</th>
                    <th>{tx.createdBy}</th>
                  </tr>
                </thead>
                <tbody>
                  {jobs.map((j) => (
                    <tr key={j.id}>
                      <td data-label={tx.name}>
                        <Link href={`/fleet/jobs/${j.id}`} className="font-medium text-accent-hover hover:underline" dir="auto">
                          {j.name}
                        </Link>
                        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted">
                          <Badge tone={JOB_TONE[j.state]}>{tx.jobState[j.state]}</Badge>
                          <span dir="auto">{j.script_name}</span>
                          <span className="mono">{ltr(tx.version(j.script_version))}</span>
                          <span>{j.fleet_group_name ?? tx.targetSelected(j.endpoint_ids.length)}</span>
                        </div>
                      </td>
                      <td data-label={tx.schedule} className="text-xs">
                        {tx.scheduleText(j, fmt)}
                        {j.maintenance_only && <div className="text-faint">{tx.maintenanceOnly}</div>}
                      </td>
                      <td data-label={tx.lastRun} className="text-xs">
                        {j.last_run ? (
                          <>
                            <div title={fmt(j.last_run.created_at)}>{relativeTime(j.last_run.created_at, locale)}</div>
                            <div className="text-muted">{tx.counts(j.last_run.counts)}</div>
                          </>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td data-label={tx.nextRun} className="text-xs">
                        {j.next_run_at && j.state === 'active' ? fmt(j.next_run_at) : '—'}
                      </td>
                      <td data-label={tx.createdBy} className="text-xs">
                        {j.created_by_email}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </DataTable>
            )
          }
        </Async>
      </Card>
      {creating && <JobDialog onClose={() => setCreating(false)} onCreated={(job) => router.push(`/fleet/jobs/${job.id}`)} />}
    </div>
  );
}

/** One job: its runs and the result of every computer (download the full output, rerun failed, cancel, pause, run now). */
export function FleetJobDetailScreen({ id }: { id: string }) {
  const confirm = useConfirm();
  const { locale } = useI18n();
  const tx = jobsText(locale);
  const { can, me } = useApp();
  const q = useQuery<FleetJobDetail>(`/fleet/jobs/${id}`, ['devices'], 5_000);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const fmt = (iso: string) => absoluteTime(iso, locale);

  async function act(what: string, path: string, body: unknown = {}) {
    setBusy(what);
    setError(null);
    try {
      await api(`/fleet/jobs/${id}/${path}`, { method: 'POST', body });
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, 'error', String(err)));
    } finally {
      setBusy('');
      void q.reload();
    }
  }

  return (
    <Async query={q}>
      {(j) => {
        const mine = can('admin') || j.created_by_email.toLowerCase() === me.user.email.toLowerCase();
        const open = j.state === 'active' || j.state === 'paused';
        return (
          <div className="space-y-5">
            <PageHeader
              title={j.name}
              description={`${j.script_name} · ${tx.version(j.script_version)} · ${tx.scheduleText(j, fmt)}`}
              icon={<CalendarClock className="size-5" aria-hidden />}
              actions={
                mine && j.state !== 'cancelled' ? (
                  <div className="flex flex-wrap gap-1.5">
                    <Button size="sm" variant="primary" busy={busy === 'run'} onClick={() => void act('run', 'run-now')}>
                      <Play className="size-3.5" aria-hidden />
                      {tx.runNow}
                    </Button>
                    <Button size="sm" busy={busy === 'rerun'} disabled={!j.runs[0] || j.runs[0].counts.failed + j.runs[0].counts.expired + j.runs[0].counts.cancelled === 0} onClick={() => void act('rerun', 'rerun', { run_id: j.runs[0]!.id })}>
                      <RotateCcw className="size-3.5" aria-hidden />
                      {tx.rerunFailed}
                    </Button>
                    {open && j.schedule_kind === 'recurring' && (
                      <Button size="sm" busy={busy === 'pause'} onClick={() => void act('pause', 'pause', { paused: j.state === 'active' })}>
                        <Pause className="size-3.5" aria-hidden />
                        {j.state === 'active' ? tx.pause : tx.resume}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      busy={busy === 'cancel'}
                      onClick={async () => {
                        if ((await confirm(tx.cancelConfirm, { destructive: true }))) void act('cancel', 'cancel');
                      }}
                    >
                      <XCircle className="size-3.5" aria-hidden />
                      {tx.cancelJob}
                    </Button>
                  </div>
                ) : undefined
              }
            />
            {error && (
              <p role="alert" className="rounded-md border border-crit/30 bg-crit/[0.07] px-3 py-2 text-sm">
                {jobsError(tx, error, locale)}
              </p>
            )}
            <Card>
              <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
                <div>
                  <dt className="text-xs text-muted">{tx.schedule}</dt>
                  <dd>
                    <Badge tone={JOB_TONE[j.state]}>{tx.jobState[j.state]}</Badge> {tx.scheduleText(j, fmt)}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted">{tx.nextRun}</dt>
                  <dd>{j.next_run_at && j.state === 'active' ? fmt(j.next_run_at) : '—'}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted">{tx.expiry}</dt>
                  <dd>{ltr(j.expiry_minutes)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted">{tx.createdBy}</dt>
                  <dd>
                    {j.created_by_email} · {fmt(j.created_at)}
                  </dd>
                </div>
                <div className="sm:col-span-2">
                  <dt className="text-xs text-muted">{tx.parametersUsed}</dt>
                  <dd className="mono text-xs" dir="ltr">
                    {Object.keys(j.parameters).length === 0
                      ? '—'
                      : Object.entries(j.parameters)
                          .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
                          .join('  ')}
                  </dd>
                </div>
              </dl>
            </Card>
            <Card title={tx.runs} padded={false}>
              {j.runs.length === 0 ? (
                <p className="p-5 text-sm text-muted">{tx.noRuns}</p>
              ) : (
                <div className="divide-y divide-line">
                  {j.runs.map((r) => (
                    <section key={r.id} className="space-y-2 px-4 py-3">
                      <header className="flex flex-wrap items-center gap-2 text-sm">
                        <Badge tone="idle">{tx.runKind[r.kind]}</Badge>
                        <span title={fmt(r.created_at)}>{relativeTime(r.created_at, locale)}</span>
                        <span className="text-xs text-muted">{tx.counts(r.counts)}</span>
                        <span className="text-xs text-faint">
                          {tx.expires} {fmt(r.expires_at)}
                        </span>
                      </header>
                      <ul className="space-y-2">
                        {r.results.map((x) => (
                          <ResultRow key={x.id} jobId={j.id} result={x} />
                        ))}
                      </ul>
                    </section>
                  ))}
                </div>
              )}
            </Card>
          </div>
        );
      }}
    </Async>
  );
}

function ResultRow({ jobId, result: r }: { jobId: string; result: FleetJobResult }) {
  const { locale } = useI18n();
  const tx = jobsText(locale);
  const [open, setOpen] = useState(r.state === 'failed');
  const done = r.state === 'succeeded' || r.state === 'failed' || r.state === 'cancelled';
  return (
    <li className="rounded-md border border-line">
      <button type="button" className="flex w-full flex-wrap items-center gap-2 px-3 py-2 text-start text-sm" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Badge tone={RESULT_TONE[r.state] ?? 'idle'}>{tx.resultState[r.state]}</Badge>
        <Link href={`/fleet/endpoints/${r.endpoint_id}`} className="font-medium text-accent-hover hover:underline" dir="auto" onClick={(e) => e.stopPropagation()}>
          {r.endpoint_name}
        </Link>
        {r.waiting_for && <span className="text-xs text-muted">{tx.waitingFor[r.waiting_for]}</span>}
        {r.skip_reason && (
          <span className="text-xs text-muted" dir="auto">
            {r.skip_reason}
          </span>
        )}
        {r.exit_code !== null && (
          <span className="mono text-xs">
            {tx.exitCode} {ltr(r.exit_code)}
          </span>
        )}
        {r.duration_ms !== null && <span className="text-xs text-muted">{ltr(tx.ms(r.duration_ms))}</span>}
        {r.error && (
          <span className="text-xs text-crit" dir="auto">
            {r.error}
          </span>
        )}
      </button>
      {open && done && (
        <div className="space-y-2 border-t border-line px-3 py-2">
          {(['stdout', 'stderr'] as const).map((stream) => {
            const text = stream === 'stdout' ? r.stdout_preview : r.stderr_preview;
            const bytes = stream === 'stdout' ? r.stdout_bytes : r.stderr_bytes;
            if (!text && !bytes) return null;
            return (
              <div key={stream} className="space-y-1">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="font-medium">{stream === 'stdout' ? tx.stdout : tx.stderr}</span>
                  {bytes !== null && <span className="text-faint">{tx.bytes(bytes)}</span>}
                  <a className="inline-flex items-center gap-1 text-accent-hover hover:underline" href={`/api/v1/fleet/jobs/${jobId}/results/${r.id}/output?stream=${stream}`} download>
                    <Download className="size-3" aria-hidden />
                    {tx.download(stream === 'stdout' ? tx.stdout : tx.stderr)}
                  </a>
                </div>
                <pre className="mono max-h-64 overflow-auto whitespace-pre-wrap rounded bg-sunken p-2 text-[11px]" dir="ltr">
                  {text}
                </pre>
              </div>
            );
          })}
          {r.truncated && <p className="text-xs text-muted">{tx.truncated}</p>}
          {r.output_capped && <p className="text-xs text-warn">{tx.capped}</p>}
        </div>
      )}
    </li>
  );
}
