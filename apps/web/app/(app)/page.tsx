'use client';

import { ArrowRight, Radar } from 'lucide-react';
import Link from 'next/link';
import type { CheckState, InsightsReport, Overview } from '@lan-detective/shared-types';
import { EventList } from '@/components/event-list';
import { InsightsPanel } from '@/components/insights';
import { IncidentRow } from '@/components/incident-row';
import { Async, Card, Dot, EmptyState, PageHeader, StateBadge, StatusBadge, type Tone, stateTone } from '@/components/ui';
import { qs } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { ms, pct } from '@/lib/format';
import { type Key, useI18n } from '@/lib/i18n';

function Stat({ label, value, hint, tone, children }: { label: string; value: string; hint?: string; tone?: Tone; children?: React.ReactNode }) {
  const color = tone === 'crit' ? 'text-crit' : tone === 'warn' ? 'text-warn' : tone === 'ok' ? 'text-ok' : 'text-fg';
  return (
    <div className="rounded-lg border border-line bg-surface p-4" title={hint}>
      <p className="text-xs text-muted">{label}</p>
      <p className={`tnum mt-1.5 text-[26px] font-semibold leading-none tracking-tight ${color}`}>{value}</p>
      {children && <div className="mt-3">{children}</div>}
    </div>
  );
}

function HealthCard({ title, state, latency, loss, samples }: { title: string; state: CheckState | null; latency: number | null; loss?: number | null; samples: number }) {
  const { t } = useI18n();
  return (
    <div className="rounded-lg border border-line bg-surface p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[13px] font-semibold">{title}</p>
        <StateBadge state={state} />
      </div>
      {samples === 0 ? (
        <p className="mt-3 text-xs text-faint">{t('common.noData')}</p>
      ) : (
        <dl className="mt-3 grid grid-cols-2 gap-3">
          <div>
            <dt className="text-[11px] text-muted">{t('overview.latency')}</dt>
            <dd className="tnum mt-0.5 text-base font-medium">{ms(latency)}</dd>
          </div>
          {loss !== undefined && (
            <div>
              <dt className="text-[11px] text-muted">{t('overview.loss')}</dt>
              <dd className={`tnum mt-0.5 text-base font-medium ${loss && loss > 0 ? 'text-warn' : ''}`}>{pct(loss)}</dd>
            </div>
          )}
        </dl>
      )}
      {samples > 0 && (
        <p className="tnum mt-2 text-[11px] text-faint">
          {samples} {t('overview.samples')}
        </p>
      )}
    </div>
  );
}

/**
 * First step towards Network Doctor: a fixed, explainable rule that turns the three path checks
 * into a fault domain. It never claims more than the check states support.
 */
function faultDomain(o: Overview): { key: Key; tone: Tone } {
  const { gateway: g, internet: i, dns: d } = o;
  if (!g.state || !i.state || g.state === 'unknown' || i.state === 'unknown') return { key: 'overview.fd.nodata', tone: 'idle' };
  if (g.state === 'down') return { key: 'overview.fd.lan', tone: 'crit' };
  if (i.state === 'down') return { key: 'overview.fd.wan', tone: 'crit' };
  if (d.state === 'down' || d.state === 'degraded') return { key: 'overview.fd.dns', tone: d.state === 'down' ? 'crit' : 'warn' };
  if (g.state === 'degraded' || i.state === 'degraded') return { key: 'overview.fd.degraded', tone: 'warn' };
  return { key: 'overview.fd.allGood', tone: 'ok' };
}

export default function OverviewPage() {
  const { t } = useI18n();
  const { siteId } = useApp();
  const query = useQuery<Overview>(`/overview${qs({ site_id: siteId })}`, ['events', 'devices', 'checks', 'collectors']);
  const insights = useQuery<InsightsReport>('/insights', ['events', 'devices', 'checks', 'collectors']);

  return (
    <>
      <PageHeader title={t('overview.title')} />
      <Async query={query}>
        {(o) => {
          if (o.collectors.total === 0 && o.devices.total === 0) {
            return (
              <Card>
                <EmptyState
                  icon={<Radar className="size-8" />}
                  title={t('overview.setupTitle')}
                  action={
                    <Link href="/discovery" className="inline-flex h-9 items-center gap-1.5 rounded-md bg-accent px-3.5 text-[13px] font-medium text-white hover:bg-accent-hover">
                      {t('overview.setupCta')}
                      <ArrowRight className="size-4 rtl:-scale-x-100" aria-hidden />
                    </Link>
                  }
                >
                  {t('overview.setupBody')}
                </EmptyState>
                <ol className="mx-auto mb-4 grid max-w-2xl gap-2 text-[13px] text-muted sm:grid-cols-3">
                  {(['overview.setupStep1', 'overview.setupStep2', 'overview.setupStep3'] as const).map((key, i) => (
                    <li key={key} className="rounded-md border border-line bg-bg px-3 py-2.5">
                      <span className="tnum me-2 font-semibold text-accent-hover">{i + 1}</span>
                      {t(key)}
                    </li>
                  ))}
                </ol>
              </Card>
            );
          }
          const fd = faultDomain(o);
          const total = o.devices.total || 1;
          return (
            <div className="space-y-4">
              {insights.data && (
                <InsightsPanel
                  report={insights.data}
                  onChanged={() => {
                    insights.reload();
                    query.reload();
                  }}
                />
              )}
              <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
                <Stat label={t('overview.devices')} value={String(o.devices.total)}>
                  <div className="flex h-1.5 overflow-hidden rounded-full bg-line" aria-hidden>
                    <span className="bg-ok" style={{ width: `${(o.devices.online / total) * 100}%` }} />
                    <span className="bg-crit" style={{ width: `${(o.devices.offline / total) * 100}%` }} />
                    <span className="bg-idle" style={{ width: `${(o.devices.unknown / total) * 100}%` }} />
                  </div>
                  <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
                    {(['online', 'offline', 'unknown'] as const).map((s) => (
                      <Link key={s} href={`/devices?status=${s}`} className="tnum flex items-center gap-1.5 hover:text-fg">
                        <Dot tone={s === 'online' ? 'ok' : s === 'offline' ? 'crit' : 'idle'} />
                        {o.devices[s]} {t(`status.${s}`)}
                      </Link>
                    ))}
                  </div>
                </Stat>
                <Stat label={t('overview.new24h')} value={String(o.devices.new_24h)} />
                <Stat
                  label={t('overview.availability')}
                  hint={t('overview.availabilityHint')}
                  value={o.availability_24h_pct === null ? '—' : pct(o.availability_24h_pct, 2)}
                  tone={o.availability_24h_pct === null ? undefined : o.availability_24h_pct >= 99.5 ? 'ok' : o.availability_24h_pct >= 95 ? 'warn' : 'crit'}
                >
                  <p className="text-[11px] leading-snug text-faint">{o.availability_24h_pct === null ? t('common.noData') : t('overview.availabilityHint')}</p>
                </Stat>
                <Stat label={t('overview.openProblems')} hint={t('overview.openProblemsHint')} value={String(o.open_problems)} tone={o.open_problems > 0 ? 'crit' : 'ok'}>
                  <p className="tnum text-xs text-muted">
                    <Dot tone={o.collectors.online === o.collectors.total && o.collectors.total > 0 ? 'ok' : 'warn'} className="me-1.5" />
                    {t('overview.collectors')}: {o.collectors.online}/{o.collectors.total} {t('overview.collectorsOnline')}
                  </p>
                </Stat>
              </div>

              <div className={`flex items-start gap-3 rounded-lg border px-4 py-3 ${fd.tone === 'crit' ? 'border-crit/40 bg-crit/10' : fd.tone === 'warn' ? 'border-warn/40 bg-warn/10' : 'border-line bg-surface'}`}>
                <Dot tone={stateTone(fd.tone === 'ok' ? 'ok' : fd.tone === 'warn' ? 'degraded' : fd.tone === 'crit' ? 'down' : 'unknown')} className="mt-1.5" />
                <div>
                  <p className="text-[13px] font-semibold">{t('overview.faultDomain')}</p>
                  <p className="mt-0.5 text-[13px] leading-relaxed text-fg">{t(fd.key)}</p>
                  <p className="mt-1 text-[11px] text-faint">
                    {t('overview.fd.basis')}{' '}
                    <Link href="/doctor" className="text-accent-hover hover:underline">
                      {t('nav.doctor')}
                    </Link>
                  </p>
                </div>
              </div>

              {o.active_incidents.length > 0 && (
                <Card
                  title={t('overview.activeIncidents')}
                  padded={false}
                  action={
                    <Link href="/incidents" className="text-xs font-medium text-accent-hover hover:underline">
                      {t('overview.viewAll')}
                    </Link>
                  }
                >
                  <ul className="divide-y divide-line">
                    {o.active_incidents.map((i) => (
                      <li key={i.id}>
                        <IncidentRow incident={i} showSite={!siteId} />
                      </li>
                    ))}
                  </ul>
                </Card>
              )}

              <div className="grid gap-3 md:grid-cols-3">
                <HealthCard title={t('overview.gateway')} state={o.gateway.state} latency={o.gateway.avg_latency_ms} loss={o.gateway.avg_loss_pct} samples={o.gateway.samples} />
                <HealthCard title={t('overview.internet')} state={o.internet.state} latency={o.internet.avg_latency_ms} loss={o.internet.avg_loss_pct} samples={o.internet.samples} />
                <HealthCard title={t('overview.dns')} state={o.dns.state} latency={o.dns.avg_latency_ms} samples={o.dns.samples} />
              </div>

              <div className="grid gap-4 xl:grid-cols-[1.6fr_1fr]">
                <Card
                  title={t('overview.recentEvents')}
                  padded={false}
                  action={
                    <Link href="/events" className="text-xs font-medium text-accent-hover hover:underline">
                      {t('overview.viewAll')}
                    </Link>
                  }
                >
                  {o.recent_events.length ? <EventList events={o.recent_events} showSite={!siteId} /> : <EmptyState title={t('common.noData')} />}
                </Card>
                <Card title={t('overview.problemDevices')} padded={false}>
                  {o.problem_devices.length ? (
                    <ul className="divide-y divide-line">
                      {o.problem_devices.map((d) => (
                        <li key={d.id}>
                          <Link href={`/devices/${d.id}`} className="flex items-center justify-between gap-3 px-4 py-2.5 hover:bg-raised/60">
                            <span className="min-w-0">
                              <span className="block truncate text-[13px] text-fg" dir="auto">
                                {d.name}
                              </span>
                              <span className="mono text-xs text-muted">{d.current_ip ?? '—'}</span>
                            </span>
                            <span className="flex shrink-0 items-center gap-3">
                              <span className="tnum text-xs text-muted">
                                {d.offline_events_7d} {t('overview.offlineTimes')}
                              </span>
                              <StatusBadge status={d.status} />
                            </span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <EmptyState title={t('overview.noProblemDevices')} />
                  )}
                </Card>
              </div>
            </div>
          );
        }}
      </Async>
    </>
  );
}
