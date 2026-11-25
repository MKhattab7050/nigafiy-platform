'use client';

import type { Incident, Paginated } from '@nigafiy/shared-types';
import { type Column, ColumnChart } from '@/components/charts';
import { qs } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { fill, useI18n } from '@/lib/i18n';

const DAY = 86_400_000;
/** The API returns at most 100 incidents per page; the chart is drawn only when one page holds them all. */
const PAGE = 100;

/**
 * Incidents opened per day over the last `days` days, stacked by severity
 * (GET /incidents?status=all&page_size=100). If the organisation has more incidents than one page,
 * the chart is not drawn rather than drawn from a partial list.
 */
export function IncidentTrend({ days = 14, height = 96, framed }: { days?: number; height?: number; /** Draw inside its own card (only when there is a chart to show). */ framed?: boolean }) {
  const { t, tn, locale } = useI18n();
  const { siteId } = useApp();
  const query = useQuery<Paginated<Incident>>(`/incidents${qs({ status: 'all', site_id: siteId, page_size: PAGE })}`, ['events', 'checks', 'collectors'], 60_000);
  const page = query.data;
  if (!page || page.total > page.items.length) return null;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = today.getTime() - (days - 1) * DAY;
  const fmt = new Intl.DateTimeFormat(locale === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB', { day: 'numeric' });
  const full = new Intl.DateTimeFormat(locale === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  const counts = Array.from({ length: days }, () => ({ critical: 0, warning: 0, info: 0 }));
  let inWindow = 0;
  for (const i of page.items) {
    const at = new Date(i.opened_at).getTime();
    if (at < start) continue;
    const d = Math.floor((at - start) / DAY);
    if (d < 0 || d >= days) continue;
    counts[d]![i.severity] += 1;
    inWindow += 1;
  }
  const columns: Column[] = counts.map((c, d) => {
    const day = new Date(start + d * DAY);
    return {
      key: String(d),
      label: fmt.format(day),
      title: full.format(day),
      parts: [
        { key: 'critical', label: t('severity.critical'), value: c.critical, color: 'var(--color-crit)' },
        { key: 'warning', label: t('severity.warning'), value: c.warning, color: 'var(--color-warn)' },
        { key: 'info', label: t('severity.info'), value: c.info, color: 'var(--color-accent)' },
      ],
    };
  });
  return (
    <div className={framed ? 'mb-5 rounded-[var(--radius-card)] border border-line bg-surface p-4 shadow-[var(--shadow-card)]' : undefined}>
      <p className="mb-2 text-xs font-medium text-muted">{fill(tn('dash.incidentsDays', days), { days })}</p>
      {inWindow === 0 ? <p className="text-xs text-faint">{fill(tn('dash.incidentsNoneDays', days), { days })}</p> : <ColumnChart columns={columns} label={fill(tn('dash.incidentsDays', days), { days })} height={height} valueLabel={t('chart.count')} />}
    </div>
  );
}
