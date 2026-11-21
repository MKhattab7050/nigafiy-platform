'use client';

import { ArrowLeft, History } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { Async, Badge, Button, Card, DataTable, ErrorNote, Fact, Modal, Notice, PageHeader, type Tone } from '@/components/ui';
import { type ApiError, api, qs } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { absoluteTime, ms, relativeTime } from '@/lib/format';
import { type Key, fill, useI18n } from '@/lib/i18n';
import { CredentialsCard } from '../components/credentials-form';
import { HostKeyPanel } from '../components/host-key-panel';
import { TargetStatusBadge, VendorLabel } from '../components/status';
import { ADDED_CODES, type AddedCode, TargetSettingsCard, hourText } from '../components/target-form';
import { VersionList } from '../components/version-list';
import type { BackupRun, Target, TargetDetail } from '../types';

const RUN_TONE: Record<BackupRun['status'], Tone> = { pending: 'info', ok: 'ok', failed: 'crit', expired: 'warn' };
const ADDED_KEY: Record<AddedCode, Key> = { queued: 'cb.added.queued', noCollector: 'cb.added.noCollector', noCreds: 'cb.added.noCreds' };

function RunsCard({ runs }: { runs: BackupRun[] }) {
  const { t, locale } = useI18n();
  return (
    <Card title={t('cb.runs')} padded={false}>
      {runs.length === 0 ? (
        <p className="px-4 py-4 text-[13px] text-muted">{t('cb.run.none')}</p>
      ) : (
        <DataTable stack>
          <thead>
            <tr>
              <th>{t('cb.status')}</th>
              <th>{t('cb.v.captured')}</th>
              <th>{t('cb.lastError')}</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id}>
                <td data-label={t('cb.status')}>
                  <Badge tone={RUN_TONE[r.status]}>{t(`cb.run.status.${r.status}` as Key)}</Badge>
                  {r.outcome && <span className="ms-1.5 text-xs text-muted">{t(`cb.run.outcome.${r.outcome}` as Key)}</span>}
                </td>
                <td data-label={t('cb.v.captured')} title={absoluteTime(r.created_at, locale)}>
                  {relativeTime(r.created_at, locale)}
                  <span className="block text-xs text-faint" dir="auto">
                    {r.trigger === 'scheduled' ? t('cb.run.scheduled') : r.created_by_email ? fill(t('cb.run.by'), { who: r.created_by_email }) : ''}
                    {r.collector_name ? ` · ${r.collector_name}` : ''}
                    {r.duration_ms !== null ? ` · ${ms(r.duration_ms)}` : ''}
                  </span>
                </td>
                <td data-label={t('cb.lastError')}>
                  {r.error_kind ? (
                    <>
                      <span className="text-[13px]">{t(`cb.err.${r.error_kind}` as Key)}</span>
                      {r.error && (
                        <span className="mono block break-words text-xs text-muted" dir="auto">
                          {r.error}
                        </span>
                      )}
                    </>
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}
    </Card>
  );
}

function StatusCard({ target: x }: { target: TargetDetail }) {
  const { t, locale } = useI18n();
  const detection = x.detection;
  return (
    <Card title={t('cb.status')} action={<TargetStatusBadge target={x} />}>
      {x.readiness !== 'ready' && <p className="mb-3 rounded-[var(--radius-control)] border border-warn/30 bg-warn/[0.06] px-3 py-2 text-[13px]">{t(`cb.readyHint.${x.readiness}` as Key)}</p>}
      {x.pending_run_id && <Notice className="mb-3">{t('cb.running')}</Notice>}
      <dl>
        <Fact label={t('cb.col.address')}>
          <span className="mono" dir="ltr">
            {x.address}:{x.port}
          </span>
        </Fact>
        {x.device_id && (
          <Fact label={t('cb.device')}>
            <Link href={`/devices/${x.device_id}`} className="text-accent-hover hover:underline" dir="auto">
              {x.device_label ?? x.device_id}
            </Link>
          </Fact>
        )}
        <Fact label={t('cb.col.vendor')}>
          <VendorLabel target={x} />
        </Fact>
        {x.server_version && (
          <Fact label={t('cb.serverVersion')}>
            <span className="mono text-xs" dir="ltr">
              {x.server_version}
            </span>
          </Fact>
        )}
        {detection?.evidence && detection.evidence.length > 0 && (
          <Fact label={t('cb.detection')}>
            <ul className="space-y-0.5 text-xs text-muted">
              {detection.evidence.map((e, i) => (
                <li key={i}>
                  <span className="text-faint">{e.source.replace(/_/g, ' ')}</span>{' '}
                  <span className="mono break-words" dir="ltr">
                    {e.detail}
                  </span>
                </li>
              ))}
            </ul>
          </Fact>
        )}
        <Fact label={t('cb.lastSuccess')}>
          <span title={absoluteTime(x.last_success_at, locale)}>{x.last_success_at ? relativeTime(x.last_success_at, locale) : t('common.never')}</span>
        </Fact>
        <Fact label={t('cb.lastChanged')}>
          <span title={absoluteTime(x.last_changed_at, locale)}>{x.last_changed_at ? relativeTime(x.last_changed_at, locale) : '—'}</span>
        </Fact>
        <Fact label={t('cb.col.schedule')}>
          {x.schedule === 'daily' ? fill(t('cb.schedule.daily'), { hour: hourText(x.schedule_hour) }) : t('cb.schedule.off')}
          {x.next_run_at && x.enabled && (
            <span className="block text-xs text-muted">
              {t('cb.nextRun')}: {absoluteTime(x.next_run_at, locale)}
            </span>
          )}
        </Fact>
        {x.last_status === 'failed' && (
          <Fact label={t('cb.lastError')}>
            {x.last_error_kind && <span className="block">{t(`cb.err.${x.last_error_kind}` as Key)}</span>}
            {x.last_error && (
              <span className="mono block break-words text-xs text-muted" dir="auto">
                {x.last_error}
              </span>
            )}
          </Fact>
        )}
      </dl>
    </Card>
  );
}

function TargetView({ id }: { id: string }) {
  const { t } = useI18n();
  const { can } = useApp();
  const router = useRouter();
  const params = useSearchParams();
  const added = params.get('added') as AddedCode | null;
  const [refresh, setRefresh] = useState(30_000);
  const query = useQuery<TargetDetail>(`/config-backup/targets/${id}`, ['devices'], refresh);
  const siteId = query.data?.site_id ?? null;
  const others = useQuery<{ items: Target[] }>(can('admin') && siteId ? `/config-backup/targets${qs({ site_id: siteId })}` : null, ['devices'], 0);
  const [busy, setBusy] = useState<'run' | 'delete' | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<string | null>(added && ADDED_CODES.includes(added) ? t(ADDED_KEY[added]) : null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Poll quickly while a backup waits for the collector.
  const pending = Boolean(query.data?.pending_run_id);
  useEffect(() => setRefresh(pending ? 4000 : 30_000), [pending]);

  const runNow = async () => {
    setBusy('run');
    setError(null);
    setNotice(null);
    try {
      const r = await api<{ run_id: string; collector?: string; already_pending: boolean }>(`/config-backup/targets/${id}/run`, { method: 'POST' });
      setNotice(r.already_pending ? t('cb.alreadyPending') : fill(t('cb.queued'), { collector: r.collector ?? '—' }));
      query.reload();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    setBusy('delete');
    setError(null);
    try {
      await api(`/config-backup/targets/${id}`, { method: 'DELETE' });
      router.push('/config-backup');
    } catch (e) {
      setError(e as ApiError);
      setBusy(null);
    }
  };

  return (
    <>
      <Link href="/config-backup" className="mb-3 inline-flex items-center gap-1.5 text-xs text-muted hover:text-fg">
        <ArrowLeft className="size-3.5 rtl:-scale-x-100" aria-hidden />
        {t('cb.back')}
      </Link>
      <Async query={query}>
        {(x) => (
          <>
            <PageHeader
              icon={<History className="size-[18px]" aria-hidden />}
              title={x.name}
              description={`${x.address}:${x.port}`}
              actions={
                <>
                  {can('technician') && (
                    <Button variant="primary" size="sm" busy={busy === 'run'} disabled={pending} onClick={() => void runNow()}>
                      {t('cb.backupNow')}
                    </Button>
                  )}
                  {can('admin') && (
                    <Button variant="danger" size="sm" onClick={() => (setError(null), setConfirmDelete(true))}>
                      {t('cb.delete')}
                    </Button>
                  )}
                </>
              }
            />
            <div className="space-y-4">
              {notice && <Notice>{notice}</Notice>}
              {error && !confirmDelete && <ErrorNote error={error} />}
              {!can('admin') && <p className="text-xs text-muted">{t('cb.onlyAdmins')}</p>}
              <div className="grid gap-4 xl:grid-cols-2">
                <div className="min-w-0 space-y-4">
                  <StatusCard target={x} />
                  <HostKeyPanel target={x} onChanged={query.reload} />
                </div>
                <div className="min-w-0 space-y-4">
                  {can('admin') && <CredentialsCard target={x} others={others.data?.items ?? []} onSaved={query.reload} />}
                  {can('admin') && <TargetSettingsCard key={x.updated_at} target={x} drivers={x.drivers} onSaved={query.reload} />}
                </div>
              </div>
              <VersionList key={x.latest_version_id ?? 'none'} targetId={x.id} />
              <RunsCard runs={x.runs} />
            </div>
            {confirmDelete && (
              <Modal title={t('cb.deleteTitle')} onClose={() => setConfirmDelete(false)}>
                <div className="space-y-3">
                  <p className="text-[13px]">{fill(t('cb.deleteBody'), { n: x.version_count })}</p>
                  <ErrorNote error={error} />
                  <div className="flex justify-end gap-2">
                    <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
                      {t('common.cancel')}
                    </Button>
                    <Button variant="danger" busy={busy === 'delete'} onClick={() => void remove()}>
                      {t('cb.deleteConfirm')}
                    </Button>
                  </div>
                </div>
              </Modal>
            )}
          </>
        )}
      </Async>
    </>
  );
}

export function ConfigTargetScreen({ id }: { id: string }) {
  return (
    <Suspense>
      <TargetView id={id} />
    </Suspense>
  );
}
