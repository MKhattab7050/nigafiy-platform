'use client';

import { BellOff, Moon, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Async, Badge, Button, Card, ErrorNote, Field, Input, Notice, Select, Switch } from '@/components/ui';
import { type ApiError, api } from '@/lib/api';
import { useQuery } from '@/lib/app';
import { EVENT_TYPE_LABEL, absoluteTime, relativeTime } from '@/lib/format';
import { type Key, fill, useI18n } from '@/lib/i18n';

/**
 * Calm alerts (UX review item 12; API GET/PUT /notifications/calm, /notifications/mutes): what is sent at
 * once, what waits for the end of quiet hours or the weekly summary, collapsing repeats, and mutes.
 * Organizations created before this feature have no settings (settings: null) and keep the old rules
 * until the owner saves here.
 */

type Mode = 'immediate' | 'weekly';
interface Settings {
  info_mode: Mode;
  warning_mode: Mode;
  dedup_minutes: number;
  quiet_enabled: boolean;
  quiet_start: string;
  quiet_end: string;
  timezone: string | null;
  weekly_summary: boolean;
  weekly_day: number;
  weekly_hour: number;
}
interface Hold {
  id: string;
  reason: 'quiet' | 'weekly' | 'muted' | 'duplicate';
  created_at: string;
  released_at: string | null;
  channel_name: string;
  type: string;
  severity: string;
  title: string;
}
interface CalmState {
  settings: (Settings & { last_weekly_at: string }) | null;
  defaults: Settings;
  effective_timezone: string;
  waiting: { quiet?: number; weekly?: number };
  recent_holds: Hold[];
}
interface Mute {
  id: string;
  device_id: string | null;
  device_label: string | null;
  event_type: string | null;
  until: string | null;
}

const DEDUP = [0, 15, 30, 60, 240, 1440] as const;
const DAYS = [0, 1, 2, 3, 4, 5, 6] as const;
const pick = (s: Settings): Settings => ({
  info_mode: s.info_mode,
  warning_mode: s.warning_mode,
  dedup_minutes: s.dedup_minutes,
  quiet_enabled: s.quiet_enabled,
  quiet_start: s.quiet_start,
  quiet_end: s.quiet_end,
  timezone: s.timezone,
  weekly_summary: s.weekly_summary,
  weekly_day: s.weekly_day,
  weekly_hour: s.weekly_hour,
});

export function CalmAlertsCard() {
  const { t } = useI18n();
  const query = useQuery<CalmState>('/notifications/calm', ['events'], 60_000);
  return (
    <Card
      title={
        <span className="inline-flex items-center gap-2">
          <Moon className="size-4 text-accent" aria-hidden />
          {t('calm.title')}
        </span>
      }
    >
      <p className="mb-3 text-[13px] text-muted">{t('calm.intro')}</p>
      <Async query={query}>{(state) => <CalmForm state={state} onSaved={query.reload} />}</Async>
      <Mutes />
      <Async query={query}>{(state) => <Held holds={state.recent_holds} />}</Async>
    </Card>
  );
}

function CalmForm({ state, onSaved }: { state: CalmState; onSaved: () => void }) {
  const { t } = useI18n();
  const [form, setForm] = useState<Settings>(() => pick(state.settings ?? state.defaults));
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  useEffect(() => setForm(pick(state.settings ?? state.defaults)), [state.settings, state.defaults]);
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => {
    setSaved(false);
    setForm((f) => ({ ...f, [k]: v }));
  };

  const modeSelect = (key: 'info_mode' | 'warning_mode', label: string) => (
    <Field label={label}>
      {(id) => (
        <Select id={id} value={form[key]} onChange={(e) => set(key, e.target.value as Mode)}>
          <option value="immediate">{t('calm.mode.immediate')}</option>
          <option value="weekly">{t('calm.mode.weekly')}</option>
        </Select>
      )}
    </Field>
  );

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        api('/notifications/calm', { method: 'PUT', body: { ...form, timezone: form.timezone?.trim() || null } })
          .then(() => {
            setSaved(true);
            onSaved();
          })
          .catch((err) => setError(err as ApiError))
          .finally(() => setBusy(false));
      }}
    >
      {!state.settings && <Notice>{t('calm.legacy')}</Notice>}
      {error && <ErrorNote error={error} />}

      <div className="grid gap-3 sm:grid-cols-3">
        <Field label={t('calm.critical')}>{() => <p className="py-2 text-[13px] text-muted">{t('calm.criticalAlways')}</p>}</Field>
        {modeSelect('warning_mode', t('calm.warning'))}
        {modeSelect('info_mode', t('calm.info'))}
      </div>

      <Field label={t('calm.dedup')} hint={t('calm.dedupHint')}>
        {(id) => (
          <Select id={id} value={String(form.dedup_minutes)} onChange={(e) => set('dedup_minutes', Number(e.target.value))} className="sm:w-56">
            {!DEDUP.includes(form.dedup_minutes as (typeof DEDUP)[number]) && <option value={form.dedup_minutes}>{form.dedup_minutes} min</option>}
            {DEDUP.map((m) => (
              <option key={m} value={m}>
                {t(`calm.dedup.${m}` as Key)}
              </option>
            ))}
          </Select>
        )}
      </Field>

      <div className="space-y-3 rounded-md border border-line px-3 py-3">
        <Switch checked={form.quiet_enabled} onChange={(v) => set('quiet_enabled', v)} label={t('calm.quiet')} />
        <p className="text-xs text-muted">{t('calm.quietHint')}</p>
        {form.quiet_enabled && (
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label={t('calm.quietFrom')}>{(id) => <Input id={id} type="time" dir="ltr" value={form.quiet_start} onChange={(e) => set('quiet_start', e.target.value)} required />}</Field>
            <Field label={t('calm.quietTo')}>{(id) => <Input id={id} type="time" dir="ltr" value={form.quiet_end} onChange={(e) => set('quiet_end', e.target.value)} required />}</Field>
            <Field label={t('calm.timezone')} hint={fill(t('calm.timezoneHint'), { tz: state.effective_timezone })}>
              {(id) => <Input id={id} dir="ltr" value={form.timezone ?? ''} placeholder="Africa/Cairo" maxLength={64} onChange={(e) => set('timezone', e.target.value || null)} />}
            </Field>
          </div>
        )}
      </div>

      <div className="space-y-3 rounded-md border border-line px-3 py-3">
        <Switch checked={form.weekly_summary} onChange={(v) => set('weekly_summary', v)} label={t('calm.weekly')} />
        <p className="text-xs text-muted">{form.weekly_summary ? t('calm.weeklyHint') : t('calm.weeklyOffNote')}</p>
        {form.weekly_summary && (
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label={t('calm.weeklyDay')}>
              {(id) => (
                <Select id={id} value={String(form.weekly_day)} onChange={(e) => set('weekly_day', Number(e.target.value))}>
                  {DAYS.map((d) => (
                    <option key={d} value={d}>
                      {t(`calm.day.${d}` as Key)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label={t('calm.weeklyHour')}>
              {(id) => (
                <Select id={id} value={String(form.weekly_hour)} onChange={(e) => set('weekly_hour', Number(e.target.value))}>
                  {Array.from({ length: 24 }, (_, h) => (
                    <option key={h} value={h}>
                      {`${String(h).padStart(2, '0')}:00`}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
        )}
      </div>

      {(state.waiting.quiet || state.waiting.weekly) ? (
        <p className="text-xs text-muted">{fill(t('calm.waiting'), { quiet: state.waiting.quiet ?? 0, weekly: state.waiting.weekly ?? 0 })}</p>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary" busy={busy}>
          {state.settings ? t('calm.save') : t('calm.useDefaults')}
        </Button>
        {saved && <span className="text-xs text-ok">{t('calm.saved')}</span>}
      </div>
    </form>
  );
}

function Mutes() {
  const { t, locale } = useI18n();
  const query = useQuery<{ items: Mute[] }>('/notifications/mutes', ['events'], 60_000);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState('');
  const typeLabel = (type: string) => EVENT_TYPE_LABEL[type]?.[locale] ?? type;
  return (
    <div className="mt-5 border-t border-line pt-4">
      <p className="mb-2 inline-flex items-center gap-2 text-[13px] font-medium text-fg">
        <BellOff className="size-4 text-muted" aria-hidden />
        {t('calm.mutes')}
      </p>
      {error && (
        <div className="mb-2">
          <ErrorNote error={error} />
        </div>
      )}
      <Async query={query}>
        {({ items }) =>
          items.length ? (
            <ul className="divide-y divide-line rounded-md border border-line">
              {items.map((m) => {
                const device = m.device_label ?? m.device_id ?? '';
                const what =
                  m.device_id && m.event_type
                    ? fill(t('calm.muteBoth'), { type: typeLabel(m.event_type), device })
                    : m.device_id
                      ? fill(t('calm.muteDevice'), { device })
                      : fill(t('calm.muteType'), { type: typeLabel(m.event_type ?? '') });
                return (
                  <li key={m.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-[13px]">
                    <span dir="auto">{what}</span>
                    <span className="text-xs text-muted" title={m.until ? absoluteTime(m.until, locale) : undefined}>
                      {m.until ? fill(t('calm.until'), { when: absoluteTime(m.until, locale) }) : t('calm.forever')}
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="ms-auto"
                      busy={busy === m.id}
                      onClick={() => {
                        setBusy(m.id);
                        setError(null);
                        api(`/notifications/mutes/${m.id}`, { method: 'DELETE' })
                          .then(() => query.reload())
                          .catch((err) => setError(err as ApiError))
                          .finally(() => setBusy(''));
                      }}
                    >
                      <Trash2 className="size-3.5" aria-hidden />
                      {t('calm.unmute')}
                    </Button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-xs text-muted">{t('calm.mutesEmpty')}</p>
          )
        }
      </Async>
    </div>
  );
}

function Held({ holds }: { holds: Hold[] }) {
  const { t, locale } = useI18n();
  return (
    <div className="mt-5 border-t border-line pt-4">
      <p className="mb-2 text-[13px] font-medium text-fg">{t('calm.held')}</p>
      {holds.length ? (
        <ul className="max-h-72 divide-y divide-line overflow-y-auto rounded-md border border-line">
          {holds.map((h) => (
            <li key={h.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-[13px]">
              <Badge tone={h.reason === 'muted' || h.reason === 'duplicate' ? 'idle' : 'info'} dot={false}>
                {t(`calm.reason.${h.reason}` as Key)}
              </Badge>
              <span className="min-w-0 flex-1 truncate" dir="auto">
                {h.title}
              </span>
              <span className="text-xs text-muted">{h.channel_name}</span>
              <span className="text-xs text-muted" title={absoluteTime(h.created_at, locale)}>
                {relativeTime(h.created_at, locale)}
              </span>
              {h.released_at && <span className="text-xs text-faint">{t('calm.released')}</span>}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted">{t('calm.heldEmpty')}</p>
      )}
    </div>
  );
}
