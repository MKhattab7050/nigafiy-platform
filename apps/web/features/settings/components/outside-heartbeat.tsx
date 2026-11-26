'use client';

import type { OutsideHeartbeat } from '@nigafiy/shared-types';
import { HeartPulse, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Async, Badge, Button, Card, ErrorNote, Field, Input, useConfirm } from '@/components/ui';
import { type ApiError, api } from '@/lib/api';
import { useQuery } from '@/lib/app';
import { absoluteTime, relativeTime } from '@/lib/format';
import { fill, useI18n } from '@/lib/i18n';

/**
 * Optional outside heartbeat (GET/PUT/DELETE /notifications/heartbeat). Nigafiy runs on one computer;
 * when it is off nothing inside can warn anyone, so an outside service that expects a ping every
 * minute does it instead. The saved URL is never shown again (it may hold a secret token), only its host.
 */
export function OutsideHeartbeatCard() {
  const confirm = useConfirm();
  const { t, locale } = useI18n();
  const query = useQuery<OutsideHeartbeat>('/notifications/heartbeat', ['collectors'], 60_000);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState<ApiError | null>(null);

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      query.reload();
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy('');
    }
  };

  return (
    <Card
      title={
        <span className="inline-flex items-center gap-2">
          <HeartPulse className="size-4 text-accent" aria-hidden />
          {t('settings.heartbeat.title')}
        </span>
      }
    >
      <p className="mb-1 text-[13px] text-muted">{t('settings.heartbeat.intro')}</p>
      <p className="mb-3 text-xs text-faint">{t('settings.heartbeat.how')}</p>
      {error && (
        <div className="mb-3">
          <ErrorNote error={error} />
        </div>
      )}
      <Async query={query}>
        {(hb) => (
          <>
            {hb.configured && (
              <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md border border-line px-3 py-2.5">
                <span className="mono text-[13px]" dir="ltr">
                  {hb.url_host}
                </span>
                {hb.last_ping_at === null ? (
                  <Badge tone="idle">{t('settings.heartbeat.notYet')}</Badge>
                ) : hb.last_error ? (
                  <Badge tone="warn">{t('settings.heartbeat.failed')}</Badge>
                ) : (
                  <Badge tone="ok">{t('settings.heartbeat.ok')}</Badge>
                )}
                {hb.last_ping_at && (
                  <span className="text-xs text-muted" title={absoluteTime(hb.last_ping_at, locale)}>
                    {fill(t('settings.heartbeat.lastPing'), { when: relativeTime(hb.last_ping_at, locale) })}
                  </span>
                )}
                {hb.last_error && (
                  <span className="w-full text-xs text-warn" dir="auto">
                    {hb.last_error}
                  </span>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  className="ms-auto"
                  busy={busy === 'remove'}
                  onClick={async () => {
                    if (!(await confirm(t('settings.heartbeat.removeConfirm'), { title: t('settings.heartbeat.remove'), destructive: true }))) return;
                    void act('remove', () => api('/notifications/heartbeat', { method: 'DELETE' }));
                  }}
                >
                  <Trash2 className="size-3.5" aria-hidden />
                  {t('settings.heartbeat.remove')}
                </Button>
              </div>
            )}
            <form
              className="flex flex-col gap-3 sm:flex-row sm:items-end"
              onSubmit={(e) => {
                e.preventDefault();
                void act('save', async () => {
                  await api('/notifications/heartbeat', { method: 'PUT', body: { url: url.trim() } });
                  setUrl('');
                });
              }}
            >
              <div className="min-w-0 flex-1">
                <Field label={hb.configured ? t('settings.heartbeat.replaceUrl') : t('settings.heartbeat.url')} hint={t('settings.heartbeat.urlHint')}>
                  {(id) => (
                    <Input id={id} dir="ltr" type="url" inputMode="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://hc-ping.com/…" maxLength={500} required />
                  )}
                </Field>
              </div>
              <Button type="submit" variant="primary" busy={busy === 'save'} disabled={!url.trim()}>
                {t('settings.heartbeat.save')}
              </Button>
            </form>
          </>
        )}
      </Async>
    </Card>
  );
}
