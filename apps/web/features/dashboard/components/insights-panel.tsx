'use client';

import clsx from 'clsx';
import { ChevronDown, ExternalLink, Lightbulb } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import type { DeviceMonitorBulk, DeviceMonitorResult, Insight, InsightAction, InsightsReport } from '@lan-detective/shared-types';
import { AllClearArt } from '@/components/illustrations';
import { BUTTON_BASE, BUTTON_SIZE, BUTTON_VARIANT, Badge, Button, ErrorNote, InferredBadge, Notice, SkeletonBlock, ToneIcon, severityTone } from '@/components/ui';
import { type ApiError, api } from '@/lib/api';
import { type Query, useApp } from '@/lib/app';
import { DEVICE_TYPE_LABEL } from '@/lib/format';
import { type Key, fill, useI18n } from '@/lib/i18n';
import { localizeInsightEvidence } from '@/lib/localize';
import { actionText, insightText } from '../insights-text';
import { DeviceLink } from '@/components/device-link';

export const INITIAL = 4;

/** With `onResult`, the API response goes to the caller (which shows the outcome) instead of `onDone` being called. */
export function Action({ action, onDone, onResult }: { action: InsightAction; onDone: () => void; onResult?: (data: unknown) => void }) {
  const { locale } = useI18n();
  const { can } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const text = actionText(action, locale);
  const cls = clsx(BUTTON_BASE, BUTTON_SIZE.sm, BUTTON_VARIANT.secondary);

  if (action.kind === 'link')
    return (
      <Link href={action.href} className={cls}>
        {text.label}
      </Link>
    );
  if (action.kind === 'external')
    return (
      <a href={action.href} target="_blank" rel="noreferrer noopener" className={cls}>
        {text.label}
        <ExternalLink className="size-3" aria-hidden />
      </a>
    );
  // Creating checks in bulk (POST /devices/monitor) is an admin action on the API.
  if (!can(action.code === 'monitor_all' ? 'admin' : 'technician')) return null;
  return (
    <span className="inline-flex flex-col">
      <Button
        size="sm"
        variant="primary"
        busy={busy}
        onClick={async () => {
          if (text.confirm && !window.confirm(text.confirm)) return;
          setBusy(true);
          setError(null);
          try {
            const data = await api<unknown>(action.href.replace(/^\/api\/v1/, ''), { method: 'POST', body: action.body ?? {} });
            if (onResult) onResult(data);
            else onDone();
          } catch (err) {
            setError(err as ApiError);
          } finally {
            setBusy(false);
          }
        }}
      >
        {text.label}
      </Button>
      {error && (
        <span className="mt-2">
          <ErrorNote error={error} />
        </span>
      )}
    </span>
  );
}

const DEVICES_SHOWN = 6;

export function InsightRow({
  insight,
  onDone,
  monitored = null,
  onMonitored,
}: {
  insight: Insight;
  onDone: () => void;
  /** Outcome of "Monitor them", held by the panel so it stays visible after the refreshed list drops this insight. */
  monitored?: DeviceMonitorBulk | null;
  onMonitored?: (result: DeviceMonitorBulk) => void;
}) {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const [allDevices, setAllDevices] = useState(false);
  const resultOf = new Map<string, DeviceMonitorResult>((monitored?.results ?? []).map((r) => [r.id, r]));
  const devices = insight.devices ?? [];
  const text = insightText(insight, locale);
  const tone = severityTone(insight.severity);
  return (
    <li className="px-4 py-3.5">
      <div className="flex items-start gap-3">
        <ToneIcon tone={tone} className="mt-0.5 size-4" />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold leading-snug text-fg" dir="auto">
            <span className="sr-only">{t(`severity.${insight.severity}`)}: </span>
            {text.title}
          </p>
          <p className="mt-1 text-[12.5px] leading-relaxed text-muted" dir="auto">
            {text.detail}
          </p>
          {devices.length > 0 && (
            <div className="mt-2.5">
              <p className="sr-only">{t('ins.devices')}</p>
              <ul className="divide-y divide-line rounded-[var(--radius-control)] border border-line">
                {(allDevices ? devices : devices.slice(0, DEVICES_SHOWN)).map((d) => {
                  const r = resultOf.get(d.device_id);
                  return (
                    <li key={d.device_id} className="flex flex-wrap items-center gap-x-2.5 gap-y-1 px-2.5 py-2 text-xs">
                      <DeviceLink id={d.device_id} className="min-w-0 truncate font-medium text-fg hover:underline" dir="auto">
                        {d.label}
                      </DeviceLink>
                      {d.ip && (
                        <span className="mono text-muted" dir="ltr">
                          {d.ip}
                        </span>
                      )}
                      <span className="text-muted">{DEVICE_TYPE_LABEL[d.device_type]?.[locale] ?? d.device_type}</span>
                      <InferredBadge confidence={d.type_confidence} />
                      {r && <Badge tone={r.status === 'created' ? 'ok' : r.status === 'exists' ? 'info' : 'warn'}>{t(`ins.monitor.${r.status}` as Key)}</Badge>}
                      {d.evidence && (
                        <span className="basis-full text-[11.5px] leading-relaxed text-faint" dir="auto">
                          {d.evidence}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
              {devices.length > DEVICES_SHOWN && (
                <button type="button" onClick={() => setAllDevices(!allDevices)} aria-expanded={allDevices} className="mt-1.5 text-xs font-medium text-accent-hover hover:underline">
                  {allDevices ? t('ins.showLess') : fill(t('ins.devicesMore'), { count: devices.length })}
                </button>
              )}
            </div>
          )}
          {monitored && (
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              <Notice className="min-w-0 flex-1">
                {fill(t('ins.monitor.summary'), {
                  created: monitored.created,
                  exists: monitored.results.filter((r) => r.status === 'exists').length,
                  skipped: monitored.results.filter((r) => r.status === 'not_found' || r.status === 'no_address').length,
                })}
              </Notice>
              <Button size="sm" onClick={onDone}>
                {t('ins.monitor.done')}
              </Button>
            </div>
          )}
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            {insight.actions.map((a) =>
              a.code === 'monitor_all' ? (
                !monitored && <Action key={a.code + a.href} action={a} onDone={onDone} onResult={(data) => (onMonitored ? onMonitored(data as DeviceMonitorBulk) : onDone())} />
              ) : (
                <Action key={a.code + a.href} action={a} onDone={onDone} />
              ),
            )}
            {insight.evidence.length > 0 && (
              <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="inline-flex h-8 items-center gap-1 rounded px-1.5 text-xs text-faint hover:text-fg">
                {t('ins.evidence')}
                <ChevronDown className={clsx('size-3.5 transition-transform duration-150', open && 'rotate-180')} aria-hidden />
              </button>
            )}
          </div>
          {open && (
            <ul className="mt-2 list-disc space-y-0.5 ps-5 text-xs text-muted" dir="auto">
              {insight.evidence.map((e) => (
                <li key={e}>{localizeInsightEvidence(e, locale)}</li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </li>
  );
}

/** The platform's own advice (GET /insights), each with the action that resolves it. The score itself sits in the status header. */
/** `expanded`: start with every insight shown (Watch, Insights); the Hub home starts with the first few. */
export function InsightsPanel({ insights, expanded = false }: { insights: Query<InsightsReport>; expanded?: boolean }) {
  const { t } = useI18n();
  const [all, setAll] = useState(expanded);
  const [kept, setKept] = useState<Record<string, { insight: Insight; result: DeviceMonitorBulk }>>({});
  const report = insights.data;
  const forget = (id: string) =>
    setKept((k) => {
      const { [id]: _gone, ...rest } = k;
      return rest;
    });
  // Insights whose action result is still on screen but that the refreshed report no longer contains.
  const stale = report ? Object.values(kept).filter((k) => !report.insights.some((i) => i.id === k.insight.id)) : [];
  return (
    <section aria-labelledby="insights-title" className="flex h-full min-w-0 flex-col rounded-[var(--radius-card)] border border-line bg-surface shadow-[var(--shadow-card)]">
      <header className="flex min-h-12 items-center gap-2.5 border-b border-line px-4 py-2.5">
        <span className="flex size-7 items-center justify-center rounded-[7px] bg-raised text-muted">
          <Lightbulb className="size-[15px]" aria-hidden />
        </span>
        <h2 id="insights-title" className="flex-1 text-[13.5px] font-semibold">
          {t('overview.healthTitle')}
        </h2>
        {report && report.insights.length > 0 && <span className="tnum text-xs text-faint">{report.insights.length}</span>}
      </header>
      {!report ? (
        <div className="p-4">{insights.error ? <ErrorNote error={insights.error} onRetry={insights.reload} /> : <SkeletonBlock lines={4} />}</div>
      ) : report.insights.length === 0 && stale.length === 0 ? (
        <div className="flex flex-col items-center px-4 py-8 text-center">
          <AllClearArt className="h-16 w-32 text-faint" />
          <p className="mt-3 max-w-xs text-[13px] text-muted">{t('ins.allGood')}</p>
        </div>
      ) : (
        <>
          <ul className="divide-y divide-line">
            {[...stale.map((k) => k.insight), ...(all ? report.insights : report.insights.slice(0, INITIAL))].map((i) => (
              <InsightRow
                key={i.id}
                insight={i}
                monitored={kept[i.id]?.result ?? null}
                onMonitored={(result) => setKept((k) => ({ ...k, [i.id]: { insight: i, result } }))}
                onDone={() => {
                  forget(i.id);
                  insights.reload();
                }}
              />
            ))}
          </ul>
          {report.insights.length > INITIAL && (
            <div className="mt-auto border-t border-line px-4 py-2.5">
              <button type="button" onClick={() => setAll(!all)} aria-expanded={all} className="text-xs font-medium text-accent-hover hover:underline">
                {all ? t('ins.showLess') : `${t('ins.showMore')} (${report.insights.length - INITIAL})`}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
