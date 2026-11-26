'use client';

import clsx from 'clsx';
import { ChevronDown, PowerOff } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import type { DashboardGuidance, EndpointSummary, InsightsReport, Overview, Paginated } from '@nigafiy/shared-types';
import { ProportionBar, RingGauge } from '@/components/charts';
import { ErrorNote, Skeleton, ToneIcon, type Tone } from '@/components/ui';
import { qs } from '@/lib/api';
import { type Query, useApp, useQuery } from '@/lib/app';
import { absoluteTime, duration, pct, relativeTime } from '@/lib/format';
import { fill, useI18n } from '@/lib/i18n';
import { localizeDeductionReason } from '@/lib/localize';
import { reasonText } from '../guidance-text';
import { type Basis, Explain, every } from './explain';

export const VERDICT_TONE: Record<InsightsReport['verdict'], Tone> = { healthy: 'ok', attention: 'warn', urgent: 'crit' };

/** Score ring, verdict in words, and the deductions that produced the score (GET /insights). */
function ScoreBlock({ insights }: { insights: Query<InsightsReport> }) {
  const { t, tn, locale } = useI18n();
  // Open by default: the reasons are the most useful thing next to the number.
  const [why, setWhy] = useState(true);
  const r = insights.data;
  if (!r) {
    return (
      <div className="flex items-center gap-5 p-5">
        {insights.error ? (
          <ErrorNote error={insights.error} onRetry={insights.reload} />
        ) : (
          <>
            <Skeleton className="size-[116px] rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-3.5 w-28" />
            </div>
          </>
        )}
      </div>
    );
  }
  // Discovery not set up (rules.ts deduction "setup"): nothing has been measured, so a red score would
  // alarm a brand-new account for no reason. Say what is missing and link to the fix instead.
  if (r.score_breakdown.some((d) => d.code === 'setup')) {
    return (
      <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center lg:flex-col lg:items-stretch xl:flex-row xl:items-center">
        <RingGauge value={0} tone="idle" size={116} label={t('dash.state.setup')}>
          <span className="text-[34px] font-semibold leading-none text-faint" aria-hidden>
            –
          </span>
          <span className="mt-1 text-[11px] text-faint">{t('dash.scoreOutOf')}</span>
        </RingGauge>
        <div className="min-w-0 flex-1">
          <p className="text-xs text-muted">{t('ins.score')}</p>
          <p className="mt-0.5 text-[17px] font-semibold leading-snug text-fg">{t('dash.state.setup')}</p>
          <p className="mt-1 text-xs text-muted">{t('dash.setupHint')}</p>
          <Link href="/radar/discovery" className="mt-3 inline-flex h-8 items-center rounded-[var(--radius-control)] bg-accent px-3 text-xs font-medium text-on-accent transition-colors hover:bg-accent-strong">
            {t('dash.setupAction')}
          </Link>
        </div>
      </div>
    );
  }
  const tone = VERDICT_TONE[r.verdict];
  const deductions = [...r.score_breakdown].sort((a, b) => b.points - a.points);
  const sentence = (d: InsightsReport['score_breakdown'][number]) => {
    const w = reasonText(d);
    if (!w) return localizeDeductionReason(d, locale);
    return fill(w.plural ? tn(w.key, Number(w.params.count ?? 1)) : t(w.key), w.params);
  };
  const scoreBasis = (): Basis => ({
    from: t('dash.explain.score.from'),
    window: fill(t('dash.explain.score.window'), { at: relativeTime(r.generated_at, locale) }),
    counted: (
      <>
        {t('dash.explain.score.counted')}
        {deductions.length === 0 ? (
          <span className="mt-1 block text-muted">{t('dash.explain.score.none')}</span>
        ) : (
          <span className="tnum mt-2 block space-y-1">
            {deductions.map((b) => (
              <span key={b.code} className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 text-muted">{sentence(b)}</span>
                <span className="shrink-0 font-medium text-crit" dir="ltr">{fill(t('dash.why.points'), { points: b.points })}</span>
              </span>
            ))}
          </span>
        )}
      </>
    ),
    left: t('dash.explain.score.left'),
  });
  return (
    <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center lg:flex-col lg:items-stretch xl:flex-row xl:items-center">
      <RingGauge value={r.score} tone={tone} size={116} label={`${t('ins.score')}: ${r.score} / 100`}>
        <span className="tnum text-[34px] font-semibold leading-none tracking-[-0.03em] text-fg">{r.score}</span>
        <span className="mt-1 text-[11px] text-faint">{t('dash.scoreOutOf')}</span>
      </RingGauge>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1 text-xs text-muted">
          {t('ins.score')}
          <Explain title={t('dash.explain.score.title')} basis={scoreBasis} className="-my-1" />
        </p>
        <p className={clsx('mt-0.5 flex items-center gap-1.5 text-[17px] font-semibold leading-snug', tone === 'ok' ? 'text-ok' : tone === 'warn' ? 'text-warn' : 'text-crit')}>
          <ToneIcon tone={tone} className="size-[18px]" />
          {t(`dash.state.${r.verdict}`)}
        </p>
        <p className="mt-1 text-[11.5px] text-faint">
          {t('dash.updated')} {relativeTime(r.generated_at, locale)}
        </p>
        {deductions.length > 0 ? (
          <>
            <button type="button" onClick={() => setWhy(!why)} aria-expanded={why} className="mt-2.5 inline-flex items-center gap-1 rounded text-xs font-medium text-accent-hover hover:underline">
              {t('dash.deductions')}
              <ChevronDown className={clsx('size-3.5 transition-transform duration-150', why && 'rotate-180')} aria-hidden />
            </button>
            {why && (
              <ul className="tnum mt-2 space-y-1.5 text-xs">
                {deductions.map((b) => (
                  <li key={b.code} className="flex items-baseline justify-between gap-3">
                    <span className="min-w-0 leading-snug text-muted" dir="auto">
                      {sentence(b)}
                    </span>
                    <span className="shrink-0 font-medium text-crit">
                      <span aria-hidden dir="ltr">{fill(t('dash.why.points'), { points: b.points })}</span>
                      <span className="sr-only">{fill(t('dash.why.pointsSr'), { points: b.points })}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <p className="mt-2.5 text-xs text-muted">{t('dash.noDeductions')}</p>
        )}
      </div>
    </div>
  );
}

/**
 * "Monitoring was off from X to Y": shown for 24 hours after Nigafiy (or the Sensor) was not running,
 * e.g. the computer was off. Calm wording; device history labels that time "monitoring off".
 */
function MonitoringOffNote({ gap }: { gap: NonNullable<Overview['monitoring_off']> }) {
  const { t, locale } = useI18n();
  return (
    <div role="status" className="flex items-start gap-2.5 border-b border-line bg-sunken/60 px-5 py-3 text-[13px] lg:col-span-2">
      <PowerOff className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
      <div className="min-w-0">
        <p className="text-fg">{fill(t('dash.monitoringOff'), { from: absoluteTime(gap.started_at, locale), to: absoluteTime(gap.ended_at, locale), duration: duration(gap.started_at, gap.ended_at) })}</p>
        <p className="mt-0.5 text-xs text-muted">{t('dash.monitoringOffHint')}</p>
      </div>
    </div>
  );
}

/** A key counter: big number, what it counts, and one small visual or fact under it. */
export function StatTile({ label, value, sub, tone = 'idle', href, explain, children }: { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: Tone; href?: string; explain?: React.ReactNode; children?: React.ReactNode }) {
  const color = tone === 'ok' ? 'text-ok' : tone === 'warn' ? 'text-warn' : tone === 'crit' ? 'text-crit' : 'text-fg';
  const body = (
    <>
      <span className="flex items-center gap-1.5 text-xs text-muted">
        {tone !== 'idle' && tone !== 'info' && <ToneIcon tone={tone} className="size-3.5" />}
        {label}
      </span>
      <span className="mt-2 flex items-baseline gap-1.5">
        <span className={clsx('tnum text-[28px] font-semibold leading-none tracking-[-0.03em]', color)}>{value}</span>
        {sub && <span className="tnum text-xs text-faint">{sub}</span>}
      </span>
      {children && <span className="mt-3 block">{children}</span>}
    </>
  );
  const cls = 'block min-w-0 p-4 sm:p-5';
  const tile = href ? (
    <Link href={href} className={clsx(cls, 'h-full transition-colors hover:bg-raised/60')}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
  // The "how is this worked out" button sits beside the link, never inside it (no button in a link).
  return explain ? (
    <div className="relative min-w-0">
      {tile}
      <span className="absolute end-2 top-2 sm:end-3 sm:top-3">{explain}</span>
    </div>
  ) : (
    tile
  );
}

const loadingValue = <Skeleton className="inline-block h-7 w-12 align-middle" />;

/**
 * The top of the dashboard: overall state and the four counters an administrator checks first.
 * Every figure comes from an existing endpoint: /insights, /overview, /incidents, /endpoints.
 */
export function StatusHeader({ insights, guidance }: { insights: Query<InsightsReport>; guidance?: Query<DashboardGuidance> }) {
  const { t, tn, locale } = useI18n();
  const { siteId } = useApp();
  const overview = useQuery<Overview>(`/overview${qs({ site_id: siteId })}`, ['events', 'devices', 'checks', 'collectors']);
  const incidents = useQuery<Paginated<unknown>>(`/incidents${qs({ status: 'active', site_id: siteId, page_size: 1 })}`, ['events', 'checks', 'collectors'], 60_000);
  const endpoints = useQuery<{ items: EndpointSummary[] }>(`/endpoints${qs({ site_id: siteId })}`, ['devices'], 30_000);

  const o = overview.data;
  const failing = o ? o.checks.down + o.checks.degraded : null;
  const eps = endpoints.data?.items.filter((e) => e.status !== 'revoked');
  const epsOnline = eps?.filter((e) => e.status === 'active' && e.connection_state === 'online').length;
  const epsOffline = eps?.filter((e) => e.status === 'active' && e.connection_state !== 'online').length;
  // Computers waiting for enrollment are neither online nor offline: say so instead of "0 offline".
  const epsPending = eps?.filter((e) => e.status !== 'active').length ?? 0;
  const f = guidance?.data?.facts;
  const devicesBasis = (): Basis => ({
    from: f?.last_sweep_at
      ? fill(t('dash.explain.devices.from'), { at: relativeTime(f.last_sweep_at, locale), interval: f.sweep_interval_seconds ? every(f.sweep_interval_seconds) : '—' })
      : t('dash.explain.devices.fromNone'),
    window: fill(tn('dash.explain.devices.window', f?.sweeps_24h ?? 0), { count: f?.sweeps_24h ?? 0 }),
    counted: (
      <>
        {fill(t('dash.explain.devices.counted'), { total: o?.devices.total ?? f?.devices_total ?? 0 })}
        {f && <span className="mt-1 block">{fill(t('dash.explain.devices.identify'), { untyped: f.devices_untyped, unreviewed: f.devices_unreviewed })}</span>}
      </>
    ),
    left: t('dash.explain.devices.left'),
  });

  return (
    <section aria-label={t('overview.healthTitle')} className="grid overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface shadow-[var(--shadow-card)] lg:grid-cols-[minmax(17rem,22rem)_1fr]">
      {o?.monitoring_off && <MonitoringOffNote gap={o.monitoring_off} />}
      <div className="border-b border-line lg:border-b-0 lg:border-e">
        <ScoreBlock insights={insights} />
      </div>
      <div className="grid grid-cols-2 divide-line xl:grid-cols-4 [&>*]:border-line [&>*:nth-child(odd)]:border-e [&>*:nth-child(-n+2)]:border-b xl:[&>*]:border-b-0 xl:[&>*:not(:last-child)]:border-e">
        <StatTile
          label={t('dash.tile.devices')}
          value={o ? o.devices.online : loadingValue}
          sub={o ? fill(t('dash.tile.ofTotal'), { total: o.devices.total }) : undefined}
          tone={o && o.devices.offline > 0 ? 'warn' : 'idle'}
          href="/radar/devices?status=online"
          explain={o && <Explain title={t('dash.explain.devices.title')} basis={devicesBasis} />}
        >
          {o && o.devices.total > 0 && (
            <ProportionBar
              label={t('nav.devices')}
              legend={false}
              height={6}
              slices={[
                { key: 'online', label: t('status.online'), value: o.devices.online, color: 'var(--color-ok)' },
                { key: 'offline', label: t('status.offline'), value: o.devices.offline, color: 'var(--color-crit)' },
                { key: 'unknown', label: t('status.unknown'), value: o.devices.unknown, color: 'var(--color-idle)' },
              ]}
            />
          )}
          {o && <span className="tnum mt-2 block text-[11.5px] text-muted">{[`${o.devices.offline} ${t('status.offline')}`, o.devices.unknown > 0 ? `${o.devices.unknown} ${t('status.unknown')}` : null, `${o.devices.new_24h} ${t('overview.new24h')}`].filter(Boolean).join(' · ')}</span>}
        </StatTile>
        <StatTile
          label={t('dash.tile.incidents')}
          value={incidents.data ? incidents.data.total : loadingValue}
          tone={incidents.data ? (incidents.data.total > 0 ? 'crit' : 'ok') : 'idle'}
          href="/watch/incidents"
        >
          {o && <span className="tnum block text-[11.5px] text-muted">{`${t('overview.openProblems')}: ${o.open_problems}`}</span>}
        </StatTile>
        <StatTile
          label={t('dash.tile.checks')}
          value={failing ?? loadingValue}
          sub={o ? fill(t('dash.tile.ofTotal'), { total: o.checks.total }) : undefined}
          tone={failing === null ? 'idle' : o!.checks.down > 0 ? 'crit' : failing > 0 ? 'warn' : 'ok'}
          href="/watch/monitoring"
        >
          {o && <span className="tnum block text-[11.5px] text-muted">{`${t('overview.availability')}: ${pct(o.availability_24h_pct, 2)}`}</span>}
        </StatTile>
        <StatTile
          label={t('dash.tile.computers')}
          value={eps ? epsOnline : loadingValue}
          sub={eps ? fill(t('dash.tile.ofTotal'), { total: eps.length }) : undefined}
          href="/fleet/endpoints"
        >
          {eps && eps.length > 0 && (
            <ProportionBar
              label={t('dash.tile.computers')}
              legend={false}
              height={6}
              slices={[
                { key: 'online', label: t('status.online'), value: epsOnline ?? 0, color: 'var(--color-ok)' },
                { key: 'offline', label: t('status.offline'), value: epsOffline ?? 0, color: 'var(--color-idle)' },
              ]}
            />
          )}
          {eps && eps.length > 0 && (
            <span className="tnum mt-2 block text-[11.5px] text-muted">
              {[epsOffline ? `${epsOffline} ${t('status.offline')}` : null, epsPending ? fill(t('dash.tile.pendingEnroll'), { count: epsPending }) : null]
                .filter(Boolean)
                .join(' · ') || `0 ${t('status.offline')}`}
            </span>
          )}
        </StatTile>
      </div>
    </section>
  );
}
