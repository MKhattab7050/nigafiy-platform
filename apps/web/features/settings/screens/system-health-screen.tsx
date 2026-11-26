'use client';

import type { SystemHealthReport } from '@nigafiy/shared-types';
import { ArrowRight, CalendarCheck, HeartPulse } from 'lucide-react';
import Link from 'next/link';
import { Async, Card, PageHeader, ToneIcon, type Tone } from '@/components/ui';
import { useApp, useQuery } from '@/lib/app';
import { absoluteTime, ms, relativeTime } from '@/lib/format';
import { type Key, fill, useI18n } from '@/lib/i18n';
import { OutsideHeartbeatCard } from '../components/outside-heartbeat';
import { reportLineText, spanText } from '../report-text';

/** One plain sentence with its tone mark. */
function Line({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2.5 py-1.5 text-[13px]">
      <ToneIcon tone={tone} className="mt-0.5 size-4 shrink-0" />
      <span className="min-w-0" dir="auto">
        {children}
      </span>
    </li>
  );
}

/**
 * /system/health: plain answers about Nigafiy itself, from GET /system/health (the scheduler's job
 * health, as on /system/modules, plus Sensors, the last monitoring gap and the outside heartbeat).
 * The sentences come first; the job names and errors stay behind "Details".
 */
export function SystemHealthScreen() {
  const { t, locale } = useI18n();
  const { can } = useApp();
  const query = useQuery<SystemHealthReport>('/system/health', ['collectors'], 30_000);
  return (
    <>
      <PageHeader icon={<HeartPulse className="size-[18px]" aria-hidden />} title={t('health.title')} description={t('health.desc')} />
      <div className="space-y-4">
        <Async query={query}>
          {(h) => {
            const sched = h.scheduler.state;
            const outside: { tone: Tone; key: Key } = !h.outside_heartbeat.configured
              ? { tone: 'idle', key: 'health.outside.none' }
              : h.outside_heartbeat.ok === false
                ? { tone: 'warn', key: 'health.outside.failing' }
                : { tone: 'ok', key: 'health.outside.ok' };
            return (
              <>
                <Card>
                  <p className={`flex items-center gap-2 text-[15px] font-semibold ${h.actions.length ? 'text-warn' : 'text-ok'}`}>
                    <ToneIcon tone={h.actions.length ? 'warn' : 'ok'} className="size-5 shrink-0" />
                    {t(h.actions.length ? 'health.verdict.act' : 'health.verdict.ok')}
                  </p>
                  {h.actions.length > 0 && (
                    <div className="mt-3">
                      <h3 className="mb-1 text-xs font-medium text-muted">{t('health.needsYou')}</h3>
                      <ul>
                        {h.actions.map((a) => (
                          <Line key={a.code} tone={a.code === 'no_sensor' ? 'info' : 'warn'}>
                            {reportLineText(a, locale)}
                          </Line>
                        ))}
                      </ul>
                    </div>
                  )}
                </Card>

                <Card title={t('health.parts')}>
                  <ul>
                    <Line tone="ok">
                      {fill(t('health.api'), { when: relativeTime(h.api.started_at, locale) })}
                      {h.api.version && (
                        <span className="text-muted">
                          {' '}
                          {fill(t('health.version'), { v: h.api.version })}
                        </span>
                      )}
                    </Line>
                    <Line tone={h.database.reachable ? 'ok' : 'crit'}>
                      {h.database.reachable ? fill(t('health.db.ok'), { ms: ms(h.database.latency_ms) }) : t('health.db.down')}
                    </Line>
                    <Line tone={sched === 'ok' ? 'ok' : sched === 'degraded' ? 'warn' : 'crit'}>
                      {t(sched === 'ok' ? 'health.sched.ok' : sched === 'degraded' ? 'health.sched.degraded' : 'health.sched.stopped')}
                    </Line>
                    <Line tone={h.monitoring.active ? 'ok' : h.monitoring.sensors.length ? 'warn' : 'info'}>
                      {t(h.monitoring.active ? 'health.mon.active' : h.monitoring.sensors.length ? 'health.mon.off' : 'health.mon.none')}
                    </Line>
                    <Line tone="idle">
                      {h.monitoring.last_gap ? (
                        <span title={absoluteTime(h.monitoring.last_gap.started_at, locale)}>
                          {fill(t('health.gap'), {
                            when: relativeTime(h.monitoring.last_gap.started_at, locale),
                            duration: spanText(h.monitoring.last_gap.duration_seconds, locale),
                            why: t(h.monitoring.last_gap.kind === 'api' ? 'health.gap.api' : 'health.gap.collector'),
                          })}
                        </span>
                      ) : (
                        t('health.gap.none')
                      )}
                    </Line>
                    <Line tone={outside.tone}>{t(outside.key)}</Line>
                  </ul>

                  <details className="group mt-3 rounded-md border border-line">
                    <summary className="cursor-pointer select-none px-3 py-2 text-[13px] font-medium text-fg">{t('health.details')}</summary>
                    <div className="space-y-3 border-t border-line px-3 py-3 text-xs">
                      {h.scheduler.late.length > 0 && (
                        <div>
                          <h3 className="mb-1 font-medium text-muted">{t('health.d.late')}</h3>
                          <ul className="space-y-1">
                            {h.scheduler.late.map((j) => (
                              <li key={`${j.module}/${j.name}`}>
                                <bdi className="mono" dir="ltr">
                                  {j.module}/{j.name}
                                </bdi>{' '}
                                <span className="text-warn" title={absoluteTime(j.since, locale)}>
                                  {fill(t('health.d.lateSince'), { when: relativeTime(j.since, locale) })}
                                </span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {h.scheduler.failing.length > 0 && (
                        <div>
                          <h3 className="mb-1 font-medium text-muted">{t('health.d.failing')}</h3>
                          <ul className="space-y-1.5">
                            {h.scheduler.failing.map((j) => (
                              <li key={`${j.module}/${j.name}`}>
                                <bdi className="mono" dir="ltr">
                                  {j.module}/{j.name}
                                </bdi>{' '}
                                <span className="text-muted">{fill(t('health.d.failures'), { n: j.failures })}</span>
                                <span className="mono mt-0.5 block break-all text-crit" dir="ltr">
                                  {j.message}
                                </span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {h.monitoring.sensors.length > 0 && (
                        <div>
                          <h3 className="mb-1 font-medium text-muted">{t('health.d.sensors')}</h3>
                          <ul className="space-y-1">
                            {h.monitoring.sensors.map((s) => (
                              <li key={s.id}>
                                <bdi dir="auto">{s.name}</bdi>: {t(`health.d.sensor.${s.state}` as Key)}
                                {s.last_heartbeat_at && <span className="text-muted"> · {fill(t('health.d.lastSeen'), { when: relativeTime(s.last_heartbeat_at, locale) })}</span>}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                      <p className="text-faint" title={absoluteTime(h.checked_at, locale)}>
                        {fill(t('health.d.checked'), { when: relativeTime(h.checked_at, locale) })}
                      </p>
                      <Link href="/system/modules" className="inline-flex items-center gap-1 font-medium text-accent-hover hover:underline">
                        {t('health.d.allJobs')}
                        <ArrowRight className="size-3.5 rtl:-scale-x-100" aria-hidden />
                      </Link>
                    </div>
                  </details>
                </Card>
              </>
            );
          }}
        </Async>

        <div id="outside-heartbeat" className="scroll-mt-20">
          {can('admin') ? (
            <OutsideHeartbeatCard />
          ) : (
            <Card title={t('hb.title')}>
              <p className="text-[13px] text-muted">{t('health.outsideAdmin')}</p>
            </Card>
          )}
        </div>

        <Card
          title={
            <span className="inline-flex items-center gap-2">
              <CalendarCheck className="size-4 text-accent" aria-hidden />
              {t('health.weekly')}
            </span>
          }
          action={
            <Link href="/system/weekly" className="inline-flex items-center gap-1 text-[13px] font-medium text-accent-hover hover:underline">
              {t('health.weeklyOpen')}
              <ArrowRight className="size-3.5 rtl:-scale-x-100" aria-hidden />
            </Link>
          }
        >
          <p className="text-[13px] text-muted">{t('health.weeklyDesc')}</p>
        </Card>
      </div>
    </>
  );
}
