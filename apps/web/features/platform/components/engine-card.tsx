'use client';

import type { EngineChildState, PlatformEngineResponse, PlatformUpdatesResponse } from '@lan-detective/shared-types/programs';
import { useState } from 'react';
import { Async, Badge, Button, Card, SkeletonBlock, type Tone } from '@/components/ui';
import { api } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { absoluteTime, relativeTime } from '@/lib/format';
import { type Key, fill, useI18n } from '@/lib/i18n';

const STATE_TONE: Record<EngineChildState, Tone> = { running: 'ok', starting: 'info', backoff: 'warn', failed: 'crit', stopped: 'idle' };

function childLabel(name: string, t: (k: Key) => string): string {
  if (name === 'stack') return t('platform.child.stack');
  if (name === 'sensor') return t('platform.child.sensor');
  return name;
}

function EngineStatus({ data }: { data: PlatformEngineResponse }) {
  const { t, locale } = useI18n();
  if (!data.reachable) return <p className="text-[13px] leading-relaxed text-muted">{t(`platform.engine.${data.reason}`)}</p>;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <Badge tone="info" dot={false}>
          {t(`platform.mode.${data.mode}`)}
        </Badge>
        <span dir="ltr">{fill(t('platform.version'), { v: data.version })}</span>
        <span title={absoluteTime(data.started_at, locale)}>{fill(t('platform.since'), { t: relativeTime(data.started_at, locale) })}</span>
      </div>
      <ul className="divide-y divide-line rounded-[8px] border border-line">
        {data.children.map((c) => (
          <li key={c.name} className="flex flex-wrap items-start justify-between gap-2 px-3 py-2.5">
            <div className="min-w-0">
              <p className="text-[13px] font-medium text-fg">{childLabel(c.name, t)}</p>
              {c.restarts > 0 && <p className="text-xs text-muted">{fill(t('platform.restarts'), { n: c.restarts })}</p>}
              {c.last_error && (
                <p className="mt-0.5 break-words text-xs text-muted" dir="auto">
                  {fill(t('platform.lastError'), { e: c.last_error })}
                </p>
              )}
            </div>
            <Badge tone={STATE_TONE[c.state]}>{t(`platform.state.${c.state}`)}</Badge>
          </li>
        ))}
      </ul>
    </div>
  );
}

function UpdateStatus({ data, onCheck, checking }: { data: PlatformUpdatesResponse; onCheck?: () => void; checking: boolean }) {
  const { t, locale } = useI18n();
  let line: React.ReactNode;
  if (!data.configured) line = t(`platform.updates.${data.reason}`);
  else if (!data.ok) line = t(`platform.updates.error.${data.error}`);
  else if (data.update_available) line = fill(t('platform.updates.available'), { v: data.latest_version });
  else line = fill(t('platform.updates.upToDate'), { v: data.latest_version });
  const tone: Tone = !data.configured ? 'idle' : !data.ok ? 'warn' : data.update_available ? 'info' : 'ok';
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Badge tone={tone}>{t('platform.updates')}</Badge>
        {onCheck && data.configured && (
          <Button size="sm" onClick={onCheck} busy={checking}>
            {t('platform.updates.checkNow')}
          </Button>
        )}
      </div>
      <p className="text-[13px] leading-relaxed text-fg">{line}</p>
      <p className="text-xs text-muted">
        <span dir="ltr">{fill(t('platform.updates.current'), { v: data.current_version })}</span>
        {data.configured && <> · {fill(t('platform.updates.checked'), { t: relativeTime(data.checked_at, locale) })}</>}
        {data.configured && data.ok && data.notes_url && (
          <>
            {' · '}
            <a href={data.notes_url} target="_blank" rel="noopener noreferrer" className="text-accent-hover underline">
              {t('platform.updates.notes')}
            </a>
          </>
        )}
      </p>
    </div>
  );
}

/** Hub home: the engine's health (each supervised service) and the update check. */
export function EngineCard() {
  const { t } = useI18n();
  const { can } = useApp();
  const engine = useQuery<PlatformEngineResponse>('/platform/engine', [], 15_000);
  const updates = useQuery<PlatformUpdatesResponse>('/platform/updates', [], 3600_000);
  const [checking, setChecking] = useState(false);

  const checkNow = async () => {
    setChecking(true);
    try {
      await api('/platform/updates/check', { method: 'POST' });
      updates.reload();
    } finally {
      setChecking(false);
    }
  };

  return (
    <Card title={t('platform.engine')} description={t('platform.engineHint')}>
      <div className="space-y-4">
        <Async query={engine} skeleton={<SkeletonBlock lines={3} />}>
          {(data) => <EngineStatus data={data} />}
        </Async>
        <div className="border-t border-line pt-3">
          <Async query={updates} skeleton={<SkeletonBlock lines={2} />}>
            {(data) => <UpdateStatus data={data} checking={checking} onCheck={can('admin') ? checkNow : undefined} />}
          </Async>
        </div>
      </div>
    </Card>
  );
}
