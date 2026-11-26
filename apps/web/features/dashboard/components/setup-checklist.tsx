'use client';

import clsx from 'clsx';
import { Check, X } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useSyncExternalStore } from 'react';
import type { DashboardGuidance, GuidanceStep } from '@nigafiy/shared-types';
import { BUTTON_BASE, BUTTON_SIZE, BUTTON_VARIANT } from '@/components/ui';
import { type Query, useApp } from '@/lib/app';
import { absoluteTime, relativeTime } from '@/lib/format';
import { type Key, fill, useI18n } from '@/lib/i18n';

/**
 * Hiding the checklist is the one thing remembered here, per browser. The progress itself is never
 * stored: every step is worked out by the API from what already happened (GET /dashboard/guidance).
 */
const DISMISS_KEY = 'nigafiy:setup-checklist-dismissed';
const CHANGE_EVENT = 'nigafiy:setup-checklist';
let memory = false;

const readDismissed = () => {
  if (memory) return true;
  try {
    return window.localStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    return false;
  }
};
const subscribe = (on: () => void) => {
  window.addEventListener('storage', on);
  window.addEventListener(CHANGE_EVENT, on);
  return () => {
    window.removeEventListener('storage', on);
    window.removeEventListener(CHANGE_EVENT, on);
  };
};

function useDismissed(): [boolean, () => void] {
  // Server render and first paint read "dismissed", so a hidden checklist never flashes in.
  const dismissed = useSyncExternalStore(subscribe, readDismissed, () => true);
  const dismiss = useCallback(() => {
    try {
      window.localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      memory = true;
    }
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }, []);
  return [dismissed, dismiss];
}

/** Whether the checklist is on screen; the dashboard uses it so "Next" does not ask for the same thing twice. */
export function useChecklistVisible(guidance: Query<DashboardGuidance>): boolean {
  const [dismissed] = useDismissed();
  return !!guidance.data && !guidance.data.complete && !dismissed;
}

interface Row {
  step: GuidanceStep;
  title: Key;
  note: string;
  href?: string;
  button?: Key;
}

function rowsFor(g: DashboardGuidance, t: (k: Key) => string, tn: (k: Key, n: number) => string, locale: 'en' | 'ar', admin: boolean): Row[] {
  const f = g.facts;
  const when = (at: string | null) => (at ? relativeTime(at, locale) : '—');
  return g.steps.map((step): Row => {
    switch (step.key) {
      case 'installed':
        return { step, title: 'dash.setup.installed', note: fill(t('dash.setup.installed.done'), { at: step.at ? absoluteTime(step.at, locale) : '—' }) };
      case 'scanned':
        return step.done
          ? { step, title: 'dash.setup.scanned', note: fill(t('dash.setup.scanned.done'), { at: when(step.at) }) }
          : { step, title: 'dash.setup.scanned', note: t('dash.setup.scanned.todo'), href: '/radar/discovery', button: 'dash.setup.scanned.do' };
      case 'reviewed':
        if (step.done) return { step, title: 'dash.setup.reviewed', note: t('dash.setup.reviewed.done') };
        if (f.devices_total === 0) return { step, title: 'dash.setup.reviewed', note: t('dash.setup.reviewed.empty') };
        return {
          step,
          title: 'dash.setup.reviewed',
          note: fill(tn('dash.setup.reviewed.todo', f.devices_unreviewed), { count: f.devices_unreviewed }),
          href: '/radar/devices?trust=unreviewed',
          button: 'dash.setup.reviewed.do',
        };
      case 'alerts':
        if (step.done) return { step, title: 'dash.setup.alerts', note: fill(tn('dash.setup.alerts.done', f.alert_channels), { count: f.alert_channels }) };
        return admin
          ? { step, title: 'dash.setup.alerts', note: t('dash.setup.alerts.todo'), href: '/watch/notifications', button: 'dash.setup.alerts.do' }
          : { step, title: 'dash.setup.alerts', note: t('dash.setup.alerts.todoViewer') };
      default: // 'report', the last step
        return step.done
          ? { step, title: 'dash.setup.report', note: fill(t('dash.setup.report.done'), { at: when(step.at) }) }
          : { step, title: 'dash.setup.report', note: t(f.weekly_summary ? 'dash.setup.report.todo' : 'dash.setup.report.todoOff'), href: '/watch/reports', button: 'dash.setup.report.do' };
    }
  });
}

/**
 * Getting started: install → network scanned → devices reviewed → alerts set up → first report.
 * Gone once every step is done, or once hidden.
 */
export function SetupChecklist({ guidance }: { guidance: Query<DashboardGuidance> }) {
  const { t, tn, locale } = useI18n();
  const { can } = useApp();
  const [dismissed, dismiss] = useDismissed();
  const g = guidance.data;
  if (!g || g.complete || dismissed) return null;
  const rows = rowsFor(g, t, tn, locale, can('admin'));
  const done = rows.filter((r) => r.step.done).length;
  // Only the first open step carries a filled button; later ones get a quieter one.
  const firstOpen = rows.find((r) => !r.step.done && r.href)?.step.key;
  return (
    <section aria-labelledby="setup-title" className="rounded-[var(--radius-card)] border border-line bg-surface shadow-[var(--shadow-card)]">
      <header className="flex min-h-11 items-center gap-3 border-b border-line px-4 py-2 sm:px-5">
        <h2 id="setup-title" className="text-[13.5px] font-semibold text-fg">
          {t('dash.setup.title')}
        </h2>
        <span className="tnum text-xs text-muted">{fill(t('dash.setup.progress'), { done, total: rows.length })}</span>
        <span className="ms-auto hidden h-1.5 w-28 overflow-hidden rounded-full bg-sunken sm:block" aria-hidden>
          <span className="block h-full rounded-full bg-ok transition-[width] duration-300" style={{ width: `${(done / rows.length) * 100}%` }} />
        </span>
        <button type="button" onClick={dismiss} title={t('dash.setup.dismiss')} aria-label={t('dash.setup.dismiss')} className="ms-auto inline-flex size-7 items-center justify-center rounded-full text-faint hover:bg-raised hover:text-fg sm:ms-0">
          <X className="size-4" aria-hidden />
        </button>
      </header>
      <ol className="divide-y divide-line">
        {rows.map((r, i) => (
          <li key={r.step.key} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-4 sm:px-5">
            <div className="flex min-w-0 flex-1 items-start gap-3">
              <span
                className={clsx(
                  'tnum mt-px flex size-6 shrink-0 items-center justify-center rounded-full border text-[11.5px] font-medium',
                  r.step.done ? 'border-transparent bg-ok text-on-accent' : 'border-line bg-sunken text-muted',
                )}
                aria-hidden
              >
                {r.step.done ? <Check className="size-3.5" /> : i + 1}
              </span>
              <div className="min-w-0">
                <p className={clsx('text-[13.5px] font-medium leading-snug', r.step.done ? 'text-muted' : 'text-fg')} dir="auto">
                  <span className="sr-only">{r.step.done ? '✓ ' : ''}</span>
                  {t(r.title)}
                </p>
                <p className="mt-0.5 text-xs leading-relaxed text-muted" dir="auto">
                  {r.note}
                </p>
              </div>
            </div>
            {r.href && r.button && (
              <Link href={r.href} className={clsx(BUTTON_BASE, BUTTON_SIZE.sm, r.step.key === firstOpen ? BUTTON_VARIANT.primary : BUTTON_VARIANT.secondary, 'ms-9 self-start sm:ms-0 sm:self-auto')}>
                {t(r.button)}
              </Link>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
