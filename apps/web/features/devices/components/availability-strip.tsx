'use client';

import clsx from 'clsx';
import type { DeviceDetail } from '@nigafiy/shared-types';
import { ChartTable } from '@/components/charts';
import { EmptyState, statusTone } from '@/components/ui';
import { absoluteTime, duration } from '@/lib/format';
import { useI18n } from '@/lib/i18n';

export const WEEK_MS = 7 * 86_400_000;
export const BAR = { ok: 'bg-ok/80', crit: 'bg-crit', idle: 'bg-idle/50', warn: 'bg-warn', info: 'bg-accent' } as const;

/** Share of the last 7 days the device was seen online, out of the time its state was known. */
export function weekAvailability(device: DeviceDetail): number | null {
  const end = Date.now();
  const start = end - WEEK_MS;
  let online = 0;
  let known = 0;
  for (const a of device.availability) {
    const from = Math.max(start, new Date(a.started_at).getTime());
    const to = a.ended_at ? Math.min(end, new Date(a.ended_at).getTime()) : end;
    if (to <= from || a.status === 'unknown') continue;
    known += to - from;
    if (a.status === 'online') online += to - from;
  }
  return known > 0 ? (online / known) * 100 : null;
}

/** Striped light grey: monitoring itself was off (Nigafiy not running or the Sensor silent), so the device was not observed. */
const MONITOR_OFF_BAR = 'bg-[repeating-linear-gradient(135deg,var(--color-idle)_0_2px,transparent_2px_5px)] opacity-60';

/** 7-day strip built from recorded status intervals. Gaps = before the device was first seen. */
export function AvailabilityStrip({ device }: { device: DeviceDetail }) {
  const { t, locale } = useI18n();
  const end = Date.now();
  const start = end - WEEK_MS;
  const segments = device.availability
    .map((a) => {
      const from = Math.max(start, new Date(a.started_at).getTime());
      const to = a.ended_at ? Math.min(end, new Date(a.ended_at).getTime()) : end;
      return { ...a, from, to };
    })
    .filter((s) => s.to > s.from);
  if (!segments.length) return <EmptyState title={t('common.noData')} />;
  const totals = { online: 0, offline: 0, unknown: 0 };
  let monitorOff = 0;
  for (const s of segments) {
    if (s.monitor_off) monitorOff += s.to - s.from;
    else totals[s.status] += s.to - s.from;
  }
  const label = (s: (typeof segments)[number]) => (s.monitor_off ? t('device.monitorOff') : t(`status.${s.status}`));
  const known = totals.online + totals.offline;
  const day = new Intl.DateTimeFormat(locale === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB', { weekday: 'short' });
  return (
    <div>
      <div className="relative h-9 overflow-hidden rounded-[6px] border border-line bg-sunken" dir="ltr" role="img" aria-label={`${t('device.availability')}: ${known > 0 ? `${((totals.online / known) * 100).toFixed(2)}%` : t('common.noData')}`}>
        {segments.map((s, i) => (
          <span
            key={i}
            className={clsx('absolute inset-y-1', s.monitor_off ? MONITOR_OFF_BAR : BAR[statusTone(s.status)])}
            style={{ left: `${((s.from - start) / WEEK_MS) * 100}%`, width: `${Math.max(0.15, ((s.to - s.from) / WEEK_MS) * 100)}%` }}
            title={`${label(s)} · ${absoluteTime(s.started_at, locale)} → ${s.ended_at ? absoluteTime(s.ended_at, locale) : '…'} (${duration(s.started_at, s.ended_at)})`}
          />
        ))}
        {/* day boundaries */}
        {Array.from({ length: 6 }, (_, i) => (
          <span key={i} className="absolute inset-y-0 w-px bg-bg/70" style={{ left: `${((i + 1) / 7) * 100}%` }} aria-hidden />
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[11px] text-faint" dir="ltr" aria-hidden>
        {Array.from({ length: 7 }, (_, i) => (
          <span key={i} className="flex-1 text-center">
            {day.format(new Date(start + (i + 0.5) * 86_400_000))}
          </span>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
        {(['online', 'offline', 'unknown'] as const).map((s) => (
          <span key={s} className="tnum flex items-center gap-1.5">
            <span className={`size-2.5 rounded-[2px] ${BAR[statusTone(s)]}`} aria-hidden />
            {t(`status.${s}`)} {duration(new Date(0).toISOString(), new Date(totals[s]).toISOString())}
          </span>
        ))}
        {monitorOff > 0 && (
          <span className="tnum flex items-center gap-1.5" title={t('device.monitorOffHint')}>
            <span className={`size-2.5 rounded-[2px] border border-line ${MONITOR_OFF_BAR}`} aria-hidden />
            {t('device.monitorOff')} {duration(new Date(0).toISOString(), new Date(monitorOff).toISOString())}
          </span>
        )}
        {known > 0 && <span className="tnum ms-auto text-[13px] font-semibold text-fg">{((totals.online / known) * 100).toFixed(2)}%</span>}
      </div>
      <ChartTable
        caption={t('device.availability')}
        columns={[t('devices.status'), t('chart.time'), '']}
        rows={segments.map((s) => [label(s), `${absoluteTime(s.started_at, locale)} → ${s.ended_at ? absoluteTime(s.ended_at, locale) : '…'}`, duration(s.started_at, s.ended_at)])}
      />
    </div>
  );
}
