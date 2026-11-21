'use client';

import { Moon, Pause, Play } from 'lucide-react';
import { useState } from 'react';
import { Badge, Button, ErrorNote } from '@/components/ui';
import { type ApiError, api } from '@/lib/api';
import { absoluteTime } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { accessText } from '../text';

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
  const [error, setError] = useState<ApiError | null>(null);
  const paused = Boolean(pausedUntil && new Date(pausedUntil) > new Date());
  async function send(minutes: number | null) {
    setBusy(true);
    setError(null);
    try {
      await api(path, { method: 'POST', body: { minutes } });
      setOpen(false);
      onChanged();
    } catch (e) {
      setError(e as ApiError);
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
      {error && (
        <div className="w-full">
          <ErrorNote error={error} />
        </div>
      )}
    </div>
  );
}
