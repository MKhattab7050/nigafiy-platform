'use client';

import type { WeeklyReport, WeeklyReportsView } from '@nigafiy/shared-types';
import { ArrowRight, CalendarCheck } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Async, Card, EmptyState, ErrorNote, PageHeader, Segmented, Select, Switch, ToneIcon, severityTone } from '@/components/ui';
import { type ApiError, api } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { relativeTime } from '@/lib/format';
import { fill, useI18n } from '@/lib/i18n';
import { improvementText, reportLineText } from '../report-text';

type Tab = 'last' | 'current';

/** A day of the report, in the organization's time zone (the week is cut there, not in the browser's). */
function dateText(iso: string, locale: string, timeZone?: string): string {
  return new Intl.DateTimeFormat(locale === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone }).format(new Date(iso));
}

/** One report: period, score, the week's sentences and the top 3 improvements. */
function ReportBody({ r }: { r: WeeklyReport }) {
  const { t, locale } = useI18n();
  // period_to is exclusive (the next Monday); show the last day of the week.
  const lastDay = new Date(new Date(r.period_to).getTime() - 1).toISOString();
  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <p className="text-[13px] text-muted">{fill(t('weekly.period'), { from: dateText(r.period_from, locale, r.timezone), to: dateText(r.final ? lastDay : new Date().toISOString(), locale, r.timezone) })}</p>
          {r.score !== null && (
            <p className="text-[13px]">
              <span className="text-muted">{t('weekly.score')}: </span>
              <bdi dir="ltr">
                <span className="tnum text-[18px] font-semibold text-fg">{r.score}</span>
                <span className="text-muted">/100</span>
              </bdi>
            </p>
          )}
        </div>
        {r.notified_at && <p className="mt-1 text-xs text-faint">{fill(t('weekly.sentAt'), { when: relativeTime(r.notified_at, locale) })}</p>}
      </Card>

      <Card title={t('weekly.happened')}>
        <ul className="space-y-2">
          {r.events.map((e) => (
            <li key={e.code} className="text-[13px] leading-relaxed" dir="auto">
              {reportLineText(e, locale)}
            </li>
          ))}
        </ul>
      </Card>

      <Card title={t('weekly.improve')}>
        {r.improvements.length === 0 ? (
          <p className="text-[13px] text-muted">{t('weekly.improveNone')}</p>
        ) : (
          <ol className="space-y-3">
            {r.improvements.map((i) => {
              const text = improvementText(i, locale);
              return (
                <li key={i.code} className="flex items-start gap-2.5">
                  <ToneIcon tone={severityTone(i.severity)} className="mt-0.5 size-4 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-medium text-fg" dir="auto">
                      {text.title}
                    </p>
                    <p className="mt-0.5 text-xs text-muted" dir="auto">
                      {text.detail}
                    </p>
                    {i.href && (
                      <Link href={i.href} className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-accent-hover hover:underline">
                        {t('weekly.go')}
                        <ArrowRight className="size-3.5 rtl:-scale-x-100" aria-hidden />
                      </Link>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </Card>
    </div>
  );
}

function NotifySetting({ view, reload }: { view: WeeklyReportsView; reload: () => void }) {
  const { t } = useI18n();
  const { can } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  if (!can('admin')) {
    return (
      <Card>
        <p className="text-[13px] text-muted">{t('weekly.notifyAdmin')}</p>
      </Card>
    );
  }
  return (
    <Card>
      {error && (
        <div className="mb-3">
          <ErrorNote error={error} />
        </div>
      )}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <label htmlFor="weekly-notify" className="text-[13px] font-medium text-fg">
            {t('weekly.notify')}
          </label>
          <p className="mt-0.5 text-xs text-muted">{t('weekly.notifyHint')}</p>
          {view.channels === 0 && (
            <p className="mt-1 text-xs text-warn">
              {t('weekly.noChannels')}{' '}
              <Link href="/watch/notifications" className="font-medium text-accent-hover hover:underline">
                {t('weekly.addChannel')}
              </Link>
            </p>
          )}
        </div>
        <Switch
          id="weekly-notify"
          checked={view.settings.notify}
          disabled={busy}
          onChange={async (next) => {
            setBusy(true);
            setError(null);
            try {
              await api('/reports/weekly/settings', { method: 'PUT', body: { notify: next } });
              reload();
            } catch (err) {
              setError(err as ApiError);
            } finally {
              setBusy(false);
            }
          }}
        />
      </div>
    </Card>
  );
}

/** /system/weekly: the stored weekly reports, this week so far, and the optional notification. */
export function WeeklyReportScreen() {
  const { t, locale } = useI18n();
  const [tab, setTab] = useState<Tab>('last');
  const [week, setWeek] = useState<string | null>(null);
  const view = useQuery<WeeklyReportsView>('/reports/weekly', [], 300_000);
  const current = useQuery<WeeklyReport>(tab === 'current' ? '/reports/weekly/current' : null, [], 300_000);
  const chosen = useQuery<WeeklyReport>(tab === 'last' && week ? `/reports/weekly/${week}` : null, [], 300_000);

  return (
    <>
      <PageHeader icon={<CalendarCheck className="size-[18px]" aria-hidden />} title={t('weekly.title')} description={t('weekly.desc')} />
      <div className="space-y-4">
        <Async query={view}>
          {(v) => (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <Segmented
                  label={t('weekly.title')}
                  value={tab}
                  onChange={setTab}
                  options={[
                    { value: 'last', label: t('weekly.tab.last') },
                    { value: 'current', label: t('weekly.tab.current') },
                  ]}
                />
                {tab === 'last' && v.reports.length > 1 && (
                  <Select aria-label={t('weekly.week')} className="w-48" value={week ?? v.reports[0]!.week_start} onChange={(e) => setWeek(e.target.value === v.reports[0]!.week_start ? null : e.target.value)}>
                    {v.reports.map((r) => (
                      <option key={r.week_start} value={r.week_start}>
                        {dateText(`${r.week_start}T12:00:00Z`, locale)}
                      </option>
                    ))}
                  </Select>
                )}
              </div>
              {tab === 'current' ? (
                <Async query={current}>{(r) => <ReportBody r={r} />}</Async>
              ) : week ? (
                <Async query={chosen}>{(r) => <ReportBody r={r} />}</Async>
              ) : v.latest ? (
                <ReportBody r={v.latest} />
              ) : (
                <Card>
                  <EmptyState icon={<CalendarCheck className="size-5" aria-hidden />} title={t('weekly.title')}>
                    {t('weekly.none')}
                  </EmptyState>
                </Card>
              )}
              <NotifySetting view={v} reload={view.reload} />
            </>
          )}
        </Async>
      </div>
    </>
  );
}
