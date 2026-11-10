'use client';

import { Moon, Pause, Play, Plus, X } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import type { AccessPage, ScheduleWindow } from '@lan-detective/shared-types';
import { Badge, Button, Input, Select, Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import { accessText } from '@/lib/access-text';
import { useApp, useQuery } from '@/lib/app';
import { absoluteTime } from '@/lib/format';
import { useI18n } from '@/lib/i18n';

export const linesToList = (s: string) =>
  s
    .split(/[\n,]+/)
    .map((x) => x.trim())
    .filter(Boolean);

export function CategoryPicker({ all, value, onChange, disabled }: { all: string[]; value: string[]; onChange: (v: string[]) => void; disabled?: boolean }) {
  const { locale } = useI18n();
  const tx = accessText(locale);
  return (
    <div className="flex flex-wrap gap-1.5">
      {all.map((c) => {
        const on = value.includes(c);
        return (
          <button
            key={c}
            type="button"
            disabled={disabled}
            aria-pressed={on}
            onClick={() => onChange(on ? value.filter((x) => x !== c) : [...value, c])}
            className={`rounded-full border px-3 py-1 text-xs transition-colors disabled:opacity-60 ${on ? 'border-crit/50 bg-crit/10 text-crit' : 'border-line-strong text-muted hover:text-fg'}`}
          >
            {tx.cat[c] ?? c}
          </button>
        );
      })}
    </div>
  );
}

export function ScheduleEditor({ value, onChange, disabled }: { value: ScheduleWindow[]; onChange: (v: ScheduleWindow[]) => void; disabled?: boolean }) {
  const { locale } = useI18n();
  const tx = accessText(locale);
  const set = (i: number, w: ScheduleWindow) => onChange(value.map((x, j) => (j === i ? w : x)));
  return (
    <div className="space-y-2">
      {value.map((w, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2 rounded-md border border-line p-2">
          <div className="flex flex-wrap gap-1">
            {tx.days.map((d, day) => {
              const on = w.days.includes(day);
              return (
                <button
                  key={day}
                  type="button"
                  disabled={disabled}
                  aria-pressed={on}
                  onClick={() => set(i, { ...w, days: on ? w.days.filter((x) => x !== day) : [...w.days, day].sort() })}
                  className={`h-7 min-w-10 rounded border px-1.5 text-[11px] ${on ? 'border-accent bg-accent/15 text-fg' : 'border-line-strong text-faint'}`}
                >
                  {d}
                </button>
              );
            })}
          </div>
          <label className="flex items-center gap-1 text-xs text-muted">
            {tx.from}
            <Input type="time" value={w.from} disabled={disabled} onChange={(e) => set(i, { ...w, from: e.target.value })} className="!h-7 !w-28" />
          </label>
          <label className="flex items-center gap-1 text-xs text-muted">
            {tx.to}
            <Input type="time" value={w.to} disabled={disabled} onChange={(e) => set(i, { ...w, to: e.target.value })} className="!h-7 !w-28" />
          </label>
          <Button size="sm" variant="ghost" disabled={disabled} onClick={() => onChange(value.filter((_, j) => j !== i))} aria-label={tx.remove}>
            <X className="size-3.5" aria-hidden />
          </Button>
        </div>
      ))}
      <Button size="sm" disabled={disabled} onClick={() => onChange([...value, { days: [0, 1, 2, 3, 4], from: '22:00', to: '07:00' }])}>
        <Plus className="size-3.5" aria-hidden />
        {tx.addWindow}
      </Button>
    </div>
  );
}

/** Internet state + pause/resume for a device or a profile. */
export function PauseControl({
  path,
  pausedUntil,
  internetOff,
  canPause,
  onChanged,
}: {
  path: string;
  pausedUntil: string | null;
  internetOff?: 'paused' | 'schedule' | null;
  canPause: boolean;
  onChanged: () => void;
}) {
  const { locale } = useI18n();
  const tx = accessText(locale);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const paused = Boolean(pausedUntil && new Date(pausedUntil) > new Date());
  async function send(minutes: number | null) {
    setBusy(true);
    try {
      await api(path, { method: 'POST', body: { minutes } });
      setOpen(false);
      onChanged();
    } finally {
      setBusy(false);
    }
  }
  const forever = 7 * 24 * 60;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {paused ? (
        <Badge tone="crit">
          {tx.pausedUntil}{' '}
          {new Date(pausedUntil!).getTime() - Date.now() > 6 * 24 * 3600_000 ? '…' : absoluteTime(pausedUntil!, locale)}
        </Badge>
      ) : internetOff === 'schedule' ? (
        <Badge tone="warn">
          <Moon className="size-3" aria-hidden /> {tx.bedtimeNow}
        </Badge>
      ) : null}
      {canPause &&
        (paused ? (
          <Button size="sm" busy={busy} onClick={() => send(null)}>
            <Play className="size-3.5" aria-hidden />
            {tx.resume}
          </Button>
        ) : open ? (
          <span className="flex flex-wrap gap-1">
            {[
              [30, tx.min30],
              [60, tx.hour1],
              [180, tx.hours3],
              [forever, tx.untilResumed],
            ].map(([m, label]) => (
              <Button key={m} size="sm" variant="danger" busy={busy} onClick={() => send(m as number)}>
                {label}
              </Button>
            ))}
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
              {tx.cancel}
            </Button>
          </span>
        ) : (
          <Button size="sm" onClick={() => setOpen(true)}>
            <Pause className="size-3.5" aria-hidden />
            {tx.pause}
          </Button>
        ))}
    </div>
  );
}

interface Activity {
  hours: number;
  queries: number;
  blocked: number;
  domains: { domain: string; count: number; blocked: number; category: string | null; reason: string | null; last_seen: string }[];
}

/** Device page card: internet state, pause, profile and what the device used recently. */
export function DeviceAccessCard({ deviceId, siteId }: { deviceId: string; siteId: string }) {
  const { locale } = useI18n();
  const tx = accessText(locale);
  const { can } = useApp();
  const page = useQuery<AccessPage>(`/access?site_id=${siteId}`, ['devices'], 30_000);
  const activity = useQuery<Activity>(`/devices/${deviceId}/activity?hours=24`, [], 60_000);
  const d = page.data?.devices.find((x) => x.id === deviceId);
  const [saving, setSaving] = useState(false);
  if (!page.data) return <Spinner />;
  if (!page.data.settings.enabled || !d)
    return (
      <div className="space-y-2 text-sm text-muted">
        <p>{tx.deviceCardOff}</p>
        <Link href="/access" className="text-accent hover:underline">
          {tx.setUp}
        </Link>
      </div>
    );
  async function setProfile(profile_id: string) {
    setSaving(true);
    try {
      await api(`/devices/${deviceId}/access`, { method: 'PATCH', body: { profile_id: profile_id || null } });
      page.reload();
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="space-y-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={d.protected ? 'ok' : 'idle'}>{d.protected ? tx.protected : tx.notProtected}</Badge>
        {!d.internet_off && !d.paused_until && <Badge tone="ok">{tx.internetOn}</Badge>}
      </div>
      <PauseControl path={`/devices/${deviceId}/pause`} pausedUntil={d.paused_until} internetOff={d.internet_off} canPause={can('technician')} onChanged={page.reload} />
      <label className="block text-xs text-muted">
        {tx.profile}
        <Select value={d.profile_id ?? ''} disabled={!can('admin') || saving} onChange={(e) => setProfile(e.target.value)} className="mt-1 !h-8 text-xs">
          <option value="">{tx.noProfile}</option>
          {page.data.profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
      </label>
      <div>
        <p className="mb-1 text-xs font-medium text-muted">{tx.activity}</p>
        {!activity.data || activity.data.queries === 0 ? (
          <p className="text-xs text-faint">{tx.noActivity}</p>
        ) : (
          <>
            <p className="mb-2 text-xs text-muted tnum">
              {activity.data.queries} {tx.queries} · {activity.data.blocked} {tx.blocked}
            </p>
            <ul className="max-h-64 space-y-1 overflow-y-auto">
              {activity.data.domains.map((x) => (
                <li key={x.domain} className="flex items-center justify-between gap-2 text-xs">
                  <span className={`mono truncate ${x.blocked ? 'text-crit' : ''}`} dir="ltr">
                    {x.domain}
                  </span>
                  <span className="shrink-0 text-faint tnum">
                    {x.blocked ? `${tx.reasons[x.reason as keyof typeof tx.reasons] ?? ''}${x.category ? ` · ${tx.cat[x.category] ?? x.category}` : ''} · ` : ''}
                    {x.count}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
