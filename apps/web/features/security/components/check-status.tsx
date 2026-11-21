'use client';

import Link from 'next/link';
import { Badge, Button, Card, ToneIcon } from '@/components/ui';
import { absoluteTime, ms, relativeTime } from '@/lib/format';
import { type Key, fill, useI18n } from '@/lib/i18n';
import type { CheckKind, CheckRun, ScheduleEntry } from '../types';

export function intervalText(seconds: number, t: (k: Key) => string): string {
  const minutes = Math.round(seconds / 60);
  return minutes >= 60 && minutes % 60 === 0 ? fill(t('security.hours'), { n: minutes / 60 }) : fill(t('security.min'), { n: minutes });
}

const num = (v: unknown) => (typeof v === 'number' ? v : 0);
const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);

/** One line of what the last run measured (the API's `summary`). Device-supplied text stays plain text. */
function summaryText(check: CheckKind, s: Record<string, unknown>, t: (k: Key) => string): string {
  switch (check) {
    case 'rogue_dhcp':
      return fill(t('security.sum.rogue_dhcp'), { interfaces: num(s.interfaces_probed), offers: num(s.offers), servers: list(s.servers).join(', ') || '—' });
    case 'upnp':
      return fill(t('security.sum.upnp'), { gateways: num(s.gateways), mappings: num(s.mappings) });
    case 'wifi':
      return s.connected ? fill(t('security.sum.wifiOn'), { ssid: String(s.ssid ?? '') || t('security.wifi.hidden'), networks: num(s.networks) }) : fill(t('security.sum.wifiOff'), { networks: num(s.networks) });
    case 'banners':
      return fill(t('security.sum.banners'), { probed: num(s.probed), answered: num(s.answered) });
    case 'dhcp_fingerprints':
      return fill(t('security.sum.dhcp_fingerprints'), { clients: num(s.clients) });
  }
}

/** Problems the collector reported inside a run that still completed (per interface / gateway). */
function summaryProblems(check: CheckKind, s: Record<string, unknown>): string[] {
  if (check === 'rogue_dhcp') return list(s.listen_errors);
  if (check === 'upnp') return list(s.errors);
  return [];
}

function RunLine({ run, check }: { run: CheckRun; check: CheckKind }) {
  const { t, locale } = useI18n();
  const problems = summaryProblems(check, run.summary ?? {});
  return (
    <li className="space-y-1 py-2 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <ToneIcon tone={run.ok ? 'ok' : 'crit'} className="size-3.5" />
        <span className="font-medium text-fg">{run.ok ? t('security.ok') : t('security.failed')}</span>
        <span title={absoluteTime(run.ran_at, locale)}>{relativeTime(run.ran_at, locale)}</span>
        <span>· {t(`security.trigger.${run.trigger}` as Key)}</span>
        {run.duration_ms !== null && <span>· {fill(t('security.took'), { d: ms(run.duration_ms) })}</span>}
        <span className="text-faint" dir="auto">
          · {run.collector_name}
        </span>
      </div>
      {run.ok ? (
        <p className="text-[13px] text-fg" dir="auto">
          {summaryText(check, run.summary ?? {}, t)}
        </p>
      ) : (
        <div className="space-y-1 rounded-[var(--radius-control)] border border-warn/30 bg-warn/[0.06] px-2.5 py-2 text-[12.5px]">
          {run.error_kind && <p className="text-fg">{t(`security.error.${run.error_kind}` as Key)}</p>}
          {run.error && (
            <p className="mono break-words text-xs text-muted" dir="auto">
              {run.error}
            </p>
          )}
          <p className="text-[11.5px] text-faint">{t('security.notMeasured')}</p>
        </div>
      )}
      {problems.length > 0 && (
        <div className="text-xs">
          <p className="text-muted">{t('security.sum.problems')}:</p>
          <ul className="mono list-inside list-disc text-warn" dir="ltr">
            {problems.map((p, i) => (
              <li key={i} className="break-words">
                {p}
              </li>
            ))}
          </ul>
        </div>
      )}
    </li>
  );
}

/** Status card of one check: schedule, the last run per collector (or why it could not measure), and "Run now". */
export function CheckStatus({
  check,
  schedule,
  runs,
  requestedAt,
  canRun,
  running,
  onRun,
}: {
  check: CheckKind;
  schedule: ScheduleEntry;
  runs: CheckRun[];
  requestedAt: string | null;
  canRun: boolean;
  running: boolean;
  onRun: (() => void) | null;
}) {
  const { t, locale } = useI18n();
  const failing = runs.some((r) => !r.ok);
  return (
    <Card
      title={t(`security.check.${check}` as Key)}
      description={t(`security.checkHint.${check}` as Key)}
      action={
        onRun && canRun ? (
          <Button size="sm" busy={running} onClick={onRun}>
            {t('security.runNow')}
          </Button>
        ) : undefined
      }
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {schedule.enabled ? (
            <Badge tone="ok">{fill(t('security.scheduleOn'), { interval: intervalText(schedule.interval_seconds, t) })}</Badge>
          ) : (
            <Badge tone="idle">{t('security.scheduleOff')}</Badge>
          )}
          {check === 'banners' && schedule.due_devices !== undefined && <span className="text-muted">{fill(t('security.dueDevices'), { n: schedule.due_devices })}</span>}
          {failing && <Badge tone="warn">{t('security.failed')}</Badge>}
          <Link href="/mind/automation" className="text-accent-hover hover:underline">
            {t('security.changeSchedule')}
          </Link>
        </div>
        {requestedAt && <p className="text-xs text-accent-hover">{fill(t('security.pending'), { when: relativeTime(requestedAt, locale) })}</p>}
        {runs.length === 0 ? (
          <p className="text-[13px] text-muted">{t(`security.neverRun${schedule.enabled ? '' : 'Off'}${onRun && canRun ? '' : 'Passive'}` as Key)}</p>
        ) : (
          <div>
            <p className="mb-1 text-xs font-medium text-muted">{t('security.lastRun')}</p>
            <ul className="divide-y divide-line">
              {runs.map((r) => (
                <RunLine key={r.collector_id} run={r} check={check} />
              ))}
            </ul>
          </div>
        )}
      </div>
    </Card>
  );
}
