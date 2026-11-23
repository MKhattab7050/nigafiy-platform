'use client';

import { Activity, Pencil, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { DefaultChecksRestored, MonitoringCheck } from '@nigafiy/shared-types';
import { SetupArt } from '@/components/illustrations';
import { Async, Button, Card, EmptyState, ErrorNote, Notice, PageHeader, Segmented, StateBadge, Tag } from '@/components/ui';
import { type ApiError, api, qs } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { absoluteTime, ms, pct, relativeTime } from '@/lib/format';
import { type Key, fill, useI18n } from '@/lib/i18n';
import { RANGES, Range, CheckChart } from '../components/check-chart';
import { AddCheck } from '../components/add-check';
import { EditCheck } from '../components/edit-check';
import { WatchEvidence, useWatchValue } from '../components/watch-result';

export function MonitoringScreen() {
  const { t, locale } = useI18n();
  const { siteId, can, sites } = useApp();
  const [range, setRange] = useState<Range>('1h');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [editing, setEditing] = useState<MonitoringCheck | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [restoreNote, setRestoreNote] = useState('');
  const query = useQuery<{ items: MonitoringCheck[] }>(`/checks${qs({ site_id: siteId })}`, ['checks']);

  const act = (fn: () => Promise<unknown>) => {
    setError(null);
    fn().then(query.reload).catch((e: ApiError) => setError(e));
  };

  /** POST /sites/:id/default-checks for each site: re-creates only the starter checks that are missing. */
  const restore = (siteIds: string[]) => {
    setError(null);
    setRestoreNote('');
    setRestoring(true);
    (async () => {
      const created: string[] = [];
      for (const id of siteIds) created.push(...(await api<DefaultChecksRestored>(`/sites/${id}/default-checks`, { method: 'POST' })).created);
      setRestoreNote(created.length ? fill(t('monitoring.restored'), { names: created.join(', ') }) : t('monitoring.restoredNone'));
    })()
      .then(query.reload)
      .catch((e: ApiError) => setError(e))
      .finally(() => setRestoring(false));
  };

  const restoreButton = (siteIds: string[]) =>
    can('admin') && siteIds.length > 0 ? (
      <Button variant="primary" busy={restoring} onClick={() => restore(siteIds)}>
        <RotateCcw className="size-4" aria-hidden />
        {t('monitoring.restore')}
      </Button>
    ) : undefined;

  return (
    <>
      <PageHeader
        icon={<Activity className="size-[18px]" />}
        title={t('monitoring.title')}
        description={t('monitoring.measuredFrom')}
        actions={
          <>
            <Segmented label={t('monitoring.range')} value={range} onChange={setRange} options={RANGES.map((r) => ({ value: r, label: r }))} />
            {can('admin') && sites.length > 0 && (
              <Button variant="primary" onClick={() => setAdding(true)}>
                <Plus className="size-4" aria-hidden />
                {t('monitoring.addCheck')}
              </Button>
            )}
          </>
        }
      />
      {error && (
        <div className="mb-3">
          <ErrorNote error={error} />
        </div>
      )}
      {restoreNote && <Notice className="mb-3">{restoreNote}</Notice>}
      <Async query={query}>
        {({ items }) => {
          const bare = siteId ? [] : sites.filter((s) => !items.some((c) => c.site_id === s.id));
          return items.length === 0 ? (
            <Card>
              <EmptyState illustration={<SetupArt />} title={t('monitoring.empty')} action={restoreButton(siteId ? [siteId] : sites.map((s) => s.id))}>
                {can('admin') && sites.length > 0 && <p>{t('monitoring.emptyHint')}</p>}
              </EmptyState>
            </Card>
          ) : (
            <>
            {bare.map((s) => (
              <div key={s.id} className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-control)] border border-line-strong bg-raised px-3 py-2">
                <p className="text-[13px] text-muted" dir="auto">
                  {fill(t('monitoring.noChecksSite'), { site: s.name })}
                </p>
                {restoreButton([s.id])}
              </div>
            ))}
            <div className="grid gap-5 xl:grid-cols-2">
              {items.map((c) => (
                <Card
                  key={c.id}
                  title={
                    <span className="flex flex-wrap items-center gap-2">
                      <span dir="auto">{c.name}</span>
                      <StateBadge state={c.enabled ? c.state : null} />
                    </span>
                  }
                  action={
                    can('admin') && (
                      <span className="flex items-center gap-1">
                        <Button size="sm" variant="ghost" aria-label={`${t('monitoring.edit')}: ${c.name}`} onClick={() => setEditing(c)}>
                          <Pencil className="size-3.5" aria-hidden />
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => act(() => api(`/checks/${c.id}`, { method: 'PATCH', body: { enabled: !c.enabled } }))}>
                          {c.enabled ? t('common.enabled') : t('common.disabled')}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`${t('common.delete')}: ${c.name}`}
                          onClick={() => window.confirm(t('monitoring.confirmDelete')) && act(() => api(`/checks/${c.id}`, { method: 'DELETE' }))}
                        >
                          <Trash2 className="size-3.5" aria-hidden />
                        </Button>
                      </span>
                    )
                  }
                >
                  <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                    {!siteId && <Tag>{c.site_name}</Tag>}
                    <span>{t(`monitoring.kind.${c.kind}` as Key)}</span>
                    <span className="mono">
                      {c.target === 'auto:gateway' ? (c.last_resolved_target ?? t('monitoring.autoGateway')) : c.target}
                      {c.port ? `:${c.port}` : ''}
                    </span>
                    <span className="tnum">
                      {t('monitoring.every')} {c.interval_seconds}s
                    </span>
                  </div>
                  <CheckFigures check={c} />
                  {c.last_error && c.state !== 'ok' && <p className="mono mb-3 rounded-[6px] border border-crit/30 bg-crit/[0.07] px-2.5 py-1.5 text-start text-xs text-fg">{c.last_error}</p>}
                  <WatchEvidence check={c} />
                  <CheckChart check={c} range={range} />
                </Card>
              ))}
            </div>
            </>
          );
        }}
      </Async>
      {adding && <AddCheck onClose={() => setAdding(false)} onCreated={query.reload} />}
      {editing && <EditCheck check={editing} onClose={() => setEditing(null)} onSaved={query.reload} />}
    </>
  );
}

const TONE = { ok: '', warn: 'text-warn', crit: 'text-crit' } as const;

/** Latency, then loss (ping) or the measured value (watch checks), then the time of the last result. */
function CheckFigures({ check: c }: { check: MonitoringCheck }) {
  const { t, locale } = useI18n();
  const watch = useWatchValue(c);
  return (
    <dl className="mb-4 grid grid-cols-3 gap-3 rounded-[8px] border border-line bg-sunken px-3 py-2.5">
      <div>
        <dt className="text-[11px] text-muted">{t('monitoring.latency')}</dt>
        <dd className="tnum mt-0.5 text-lg font-semibold leading-tight">{ms(c.last_latency_ms)}</dd>
      </div>
      {watch ? (
        <div>
          <dt className="text-[11px] text-muted">{watch.label}</dt>
          <dd className={`tnum mt-0.5 text-lg font-semibold leading-tight ${watch.tone ? TONE[watch.tone] : ''}`} dir="auto">
            {watch.value}
          </dd>
        </div>
      ) : (
        <div>
          <dt className="text-[11px] text-muted">{t('monitoring.loss')}</dt>
          <dd className={`tnum mt-0.5 text-lg font-semibold leading-tight ${c.last_loss_pct ? 'text-warn' : ''}`}>{pct(c.last_loss_pct)}</dd>
        </div>
      )}
      <div>
        <dt className="text-[11px] text-muted">{t('monitoring.lastResult')}</dt>
        <dd className="mt-1 text-[13px]" title={absoluteTime(c.last_result_at, locale)}>
          {c.last_result_at ? relativeTime(c.last_result_at, locale) : t('common.never')}
        </dd>
      </div>
    </dl>
  );
}
