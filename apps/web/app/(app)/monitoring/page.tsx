'use client';

import { Activity, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Area, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { CheckSeriesPoint, MonitoringCheck } from '@lan-detective/shared-types';
import { Async, Button, Card, EmptyState, ErrorNote, Field, Input, Modal, PageHeader, Segmented, Select, StateBadge, Tag } from '@/components/ui';
import { type ApiError, api, qs } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { absoluteTime, clockTime, ms, pct, relativeTime } from '@/lib/format';
import { type Key, useI18n } from '@/lib/i18n';

const RANGES = ['15m', '1h', '24h', '7d', '30d', '90d'] as const;
type Range = (typeof RANGES)[number];
interface Series {
  from: string;
  to: string;
  bucket_seconds: number;
  points: CheckSeriesPoint[];
}

function CheckChart({ check, range }: { check: MonitoringCheck; range: Range }) {
  const { t, locale } = useI18n();
  const query = useQuery<Series>(`/checks/${check.id}/series?range=${range}`, [], 30_000);
  const withDate = range === '7d' || range === '30d' || range === '90d';
  return (
    <Async query={query}>
      {(series) => {
        if (!series.points.length) return <p className="py-8 text-center text-xs leading-relaxed text-faint">{t('monitoring.noSamples')}</p>;
        const total = series.points.reduce((n, p) => n + p.samples, 0);
        const okSamples = series.points.reduce((n, p) => n + p.samples * p.ok_ratio, 0);
        const data = series.points.map((p) => ({ ...p, t: new Date(p.ts).getTime(), fail: p.ok_ratio < 1 ? (1 - p.ok_ratio) * 100 : null }));
        return (
          <div>
            <div className="h-44" dir="ltr">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={data} margin={{ top: 6, right: 4, bottom: 0, left: -14 }}>
                  <CartesianGrid stroke="var(--color-line)" vertical={false} />
                  <XAxis
                    dataKey="t"
                    type="number"
                    scale="time"
                    domain={[new Date(series.from).getTime(), new Date(series.to).getTime()]}
                    tickFormatter={(v: number) => clockTime(new Date(v).toISOString(), locale, withDate)}
                    tick={{ fill: 'var(--color-faint)', fontSize: 11 }}
                    stroke="var(--color-line)"
                    tickLine={false}
                    minTickGap={48}
                  />
                  <YAxis yAxisId="ms" tick={{ fill: 'var(--color-faint)', fontSize: 11 }} stroke="var(--color-line)" tickLine={false} axisLine={false} width={48} unit=" ms" />
                  <YAxis yAxisId="pct" orientation="right" domain={[0, 100]} hide />
                  <Tooltip
                    cursor={{ stroke: 'var(--color-line-strong)' }}
                    contentStyle={{ background: 'var(--color-raised)', border: '1px solid var(--color-line-strong)', borderRadius: 6, fontSize: 12 }}
                    labelStyle={{ color: 'var(--color-muted)' }}
                    labelFormatter={(v) => absoluteTime(new Date(Number(v)).toISOString(), locale)}
                    formatter={(value, name) => [name === 'fail' ? pct(Number(value)) : ms(Number(value)), name === 'fail' ? '✕' : name === 'latency_max_ms' ? t('monitoring.latencyMax') : t('monitoring.latency')]}
                  />
                  {/* Failed samples are drawn as a red band: gaps in the line are real outages, not missing data. */}
                  <Area yAxisId="pct" dataKey="fail" type="step" stroke="none" fill="var(--color-crit)" fillOpacity={0.28} isAnimationActive={false} connectNulls={false} />
                  <Line yAxisId="ms" dataKey="latency_max_ms" stroke="var(--color-line-strong)" strokeWidth={1} dot={false} isAnimationActive={false} connectNulls={false} />
                  <Line yAxisId="ms" dataKey="latency_ms" stroke="var(--color-accent)" strokeWidth={1.75} dot={data.length < 3} isAnimationActive={false} connectNulls={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
            <p className="tnum mt-2 text-[11px] text-faint">
              {t('monitoring.success')}: <span className="text-muted">{pct((okSamples / total) * 100, 2)}</span> · {total} {t('overview.samples')}
            </p>
          </div>
        );
      }}
    </Async>
  );
}

function AddCheck({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { t } = useI18n();
  const { sites, siteId } = useApp();
  const [kind, setKind] = useState<'icmp' | 'tcp' | 'dns'>('icmp');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    const num = (v?: string) => (v ? Number(v) : null);
    setBusy(true);
    setError(null);
    try {
      await api('/checks', {
        method: 'POST',
        body: {
          site_id: f.site_id,
          name: f.name,
          kind,
          role: f.role,
          target: f.target,
          port: kind === 'tcp' ? num(f.port) : null,
          interval_seconds: Number(f.interval_seconds),
          latency_warn_ms: num(f.latency_warn_ms),
          loss_warn_pct: kind === 'icmp' ? num(f.loss_warn_pct) : null,
        },
      });
      onCreated();
      onClose();
    } catch (err) {
      setError(err as ApiError);
      setBusy(false);
    }
  }

  return (
    <Modal title={t('monitoring.addCheck')} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3.5">
        <Field label={t('common.site')}>
          {(id) => (
            <Select id={id} name="site_id" defaultValue={siteId ?? sites[0]?.id} required>
              {sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('common.name')}>{(id) => <Input id={id} name="name" required maxLength={80} />}</Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('monitoring.kind')}>
            {(id) => (
              <Select id={id} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
                {(['icmp', 'tcp', 'dns'] as const).map((k) => (
                  <option key={k} value={k}>
                    {t(`monitoring.kind.${k}`)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('monitoring.role')}>
            {(id) => (
              <Select id={id} name="role" defaultValue="service">
                {(['service', 'gateway', 'internet', 'dns'] as const).map((r) => (
                  <option key={r} value={r}>
                    {t(`monitoring.role.${r}`)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <div className={kind === 'tcp' ? 'grid grid-cols-[1fr_6rem] gap-3' : ''}>
          <Field label={t('monitoring.target')} hint={kind === 'icmp' ? `IPv4 / hostname / auto:gateway` : undefined}>
            {(id) => <Input id={id} name="target" required maxLength={253} dir="ltr" placeholder={kind === 'dns' ? 'example.com' : '192.168.1.10'} />}
          </Field>
          {kind === 'tcp' && <Field label={t('monitoring.port')}>{(id) => <Input id={id} name="port" type="number" min={1} max={65535} required dir="ltr" />}</Field>}
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Field label={t('monitoring.interval')}>{(id) => <Input id={id} name="interval_seconds" type="number" min={15} max={3600} defaultValue={60} required dir="ltr" />}</Field>
          <Field label={t('monitoring.latencyWarn')}>{(id) => <Input id={id} name="latency_warn_ms" type="number" min={1} max={60000} dir="ltr" />}</Field>
          {kind === 'icmp' && <Field label={t('monitoring.lossWarn')}>{(id) => <Input id={id} name="loss_warn_pct" type="number" min={0} max={100} dir="ltr" />}</Field>}
        </div>
        <p className="text-xs text-faint">{t('monitoring.measuredFrom')}</p>
        <ErrorNote error={error} />
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" variant="primary" busy={busy}>
            {t('common.add')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export default function MonitoringPage() {
  const { t, locale } = useI18n();
  const { siteId, can, sites } = useApp();
  const [range, setRange] = useState<Range>('1h');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const query = useQuery<{ items: MonitoringCheck[] }>(`/checks${qs({ site_id: siteId })}`, ['checks']);

  const act = (fn: () => Promise<unknown>) => {
    setError(null);
    fn().then(query.reload).catch((e: ApiError) => setError(e));
  };

  return (
    <>
      <PageHeader
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
      <Async query={query}>
        {({ items }) =>
          items.length === 0 ? (
            <Card>
              <EmptyState icon={<Activity className="size-8" />} title={t('monitoring.empty')} />
            </Card>
          ) : (
            <div className="grid gap-4 xl:grid-cols-2">
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
                  <dl className="mb-3 grid grid-cols-3 gap-3">
                    <div>
                      <dt className="text-[11px] text-muted">{t('monitoring.latency')}</dt>
                      <dd className="tnum text-base font-medium">{ms(c.last_latency_ms)}</dd>
                    </div>
                    <div>
                      <dt className="text-[11px] text-muted">{t('monitoring.loss')}</dt>
                      <dd className={`tnum text-base font-medium ${c.last_loss_pct ? 'text-warn' : ''}`}>{pct(c.last_loss_pct)}</dd>
                    </div>
                    <div>
                      <dt className="text-[11px] text-muted">{t('monitoring.lastResult')}</dt>
                      <dd className="text-[13px]" title={absoluteTime(c.last_result_at, locale)}>
                        {c.last_result_at ? relativeTime(c.last_result_at, locale) : t('common.never')}
                      </dd>
                    </div>
                  </dl>
                  {c.last_error && c.state !== 'ok' && <p className="mono mb-3 rounded border border-crit/30 bg-crit/10 px-2 py-1.5 text-start text-xs text-fg">{c.last_error}</p>}
                  <CheckChart check={c} range={range} />
                </Card>
              ))}
            </div>
          )
        }
      </Async>
      {adding && <AddCheck onClose={() => setAdding(false)} onCreated={query.reload} />}
    </>
  );
}
