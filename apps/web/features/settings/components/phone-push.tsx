'use client';

import type { PushSettings } from '@nigafiy/shared-types';
import { BellRing, Download, Smartphone, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Async, Badge, Button, Card, ErrorNote, useConfirm } from '@/components/ui';
import { type ApiError, api } from '@/lib/api';
import { useQuery } from '@/lib/app';
import { absoluteTime, relativeTime } from '@/lib/format';
import { type Key, fill, useI18n } from '@/lib/i18n';
import { currentSubscription, endpointHash, isStandalone, type PushSupport, pushSupport, subscribe } from '@/lib/push';

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
}

const SUPPORT_TEXT: Record<Exclude<PushSupport, 'ok'>, Key> = {
  dev: 'push.devBuild',
  insecure: 'push.insecure',
  unsupported: 'push.unsupported',
  'ios-install': 'push.iosInstall',
};

/**
 * Phone notifications through the browser's own push service (UX review item 11) and how to install
 * the web app on a phone. Turning push on adds this browser to the "Phones (push)" channel, which keeps
 * the usual severity and event filters in the channel list above.
 */
export function PhonePushCard() {
  const confirm = useConfirm();
  const { t, locale } = useI18n();
  const query = useQuery<PushSettings>('/notifications/push', ['events'], 30_000);
  const [support, setSupport] = useState<PushSupport | null>(null);
  const [mine, setMine] = useState<string | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const [message, setMessage] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null);
  const [installEvent, setInstallEvent] = useState<InstallPromptEvent | null>(null);
  const [standalone, setStandalone] = useState(false);

  useEffect(() => {
    setSupport(pushSupport());
    setStandalone(isStandalone());
    void currentSubscription().then(async (s) => setMine(s ? await endpointHash(s.endpoint) : null));
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setInstallEvent(e as InstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    return () => window.removeEventListener('beforeinstallprompt', onPrompt);
  }, []);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    setMessage(null);
    try {
      await fn();
      query.reload();
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'push_denied') setMessage({ tone: 'warn', text: t('push.denied') });
      else if (code === 'push_unsupported') setMessage({ tone: 'warn', text: t('push.unsupported') });
      else if (err instanceof Error && !('status' in err)) setMessage({ tone: 'warn', text: err.message });
      else setError(err as ApiError);
    } finally {
      setBusy('');
    }
  };

  const turnOn = (publicKey: string) =>
    run('on', async () => {
      const sub = await subscribe(publicKey);
      const json = sub.toJSON();
      await api('/notifications/push/subscriptions', {
        method: 'POST',
        body: { endpoint: json.endpoint, keys: json.keys, language: locale === 'ar' ? 'ar' : 'en', label: navigator.platform || null },
      });
      setMine(await endpointHash(sub.endpoint));
    });

  const turnOff = () =>
    run('off', async () => {
      const sub = await currentSubscription();
      if (sub) {
        await api('/notifications/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } });
        await sub.unsubscribe();
      }
      setMine(null);
    });

  return (
    <Card
      title={
        <span className="inline-flex items-center gap-2">
          <BellRing className="size-4 text-accent" aria-hidden />
          {t('push.title')}
        </span>
      }
    >
      <p className="mb-3 text-[13px] text-muted">{t('push.intro')}</p>
      {error && (
        <div className="mb-3">
          <ErrorNote error={error} />
        </div>
      )}
      {message && (
        <p role="status" className={`mb-3 rounded-md border px-3 py-2 text-[13px] ${message.tone === 'ok' ? 'border-accent/30 bg-accent/10' : 'border-warn/40 bg-warn/10'}`}>
          {message.text}
        </p>
      )}
      <Async query={query}>
        {(push) => {
          const onHere = mine !== null && push.subscriptions.some((s) => s.endpoint_hash === mine);
          return (
            <>
              <div className="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-line px-3 py-2.5">
                <Smartphone className="size-4 text-muted" aria-hidden />
                <span className="text-[13px] font-medium">{t('push.thisDevice')}</span>
                <Badge tone={onHere ? 'ok' : 'idle'}>{onHere ? t('push.on') : t('push.off')}</Badge>
                <span className="ms-auto flex flex-wrap gap-1">
                  {support === 'ok' && !onHere && (
                    <Button size="sm" variant="primary" busy={busy === 'on'} onClick={() => void turnOn(push.public_key)}>
                      {t('push.turnOn')}
                    </Button>
                  )}
                  {support === 'ok' && onHere && (
                    <Button size="sm" busy={busy === 'off'} onClick={() => void turnOff()}>
                      {t('push.turnOff')}
                    </Button>
                  )}
                  {push.channel && push.subscriptions.length > 0 && (
                    <Button
                      size="sm"
                      busy={busy === 'test'}
                      onClick={() =>
                        void run('test', async () => {
                          await api(`/notification-channels/${push.channel?.id}/test`, { method: 'POST' });
                          setMessage({ tone: 'ok', text: t('push.testQueued') });
                        })
                      }
                    >
                      {t('push.test')}
                    </Button>
                  )}
                </span>
                {support && support !== 'ok' && <p className="basis-full text-xs text-muted">{t(SUPPORT_TEXT[support])}</p>}
              </div>

              <h3 className="mb-1.5 text-xs font-medium text-muted">{t('push.devices')}</h3>
              {push.subscriptions.length === 0 ? (
                <p className="mb-3 text-[13px] text-muted">{t('push.none')}</p>
              ) : (
                <ul className="mb-2 divide-y divide-line rounded-md border border-line">
                  {push.subscriptions.map((s) => (
                    <li key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                      <span className="text-[13px]" dir="auto">
                        {s.label || s.endpoint_host}
                      </span>
                      {s.endpoint_hash === mine && <Badge tone="info" dot={false}>{t('push.thisDevice')}</Badge>}
                      {s.user_email && (
                        <span className="text-xs text-faint" dir="ltr">
                          {s.user_email}
                        </span>
                      )}
                      <span className="text-xs text-muted" title={s.last_success_at ? absoluteTime(s.last_success_at, locale) : undefined}>
                        {s.last_success_at ? fill(t('push.lastOk'), { when: relativeTime(s.last_success_at, locale) }) : t('push.never')}
                      </span>
                      {s.last_error && (
                        <span className="basis-full text-xs text-warn" dir="ltr">
                          {s.last_error}
                        </span>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        className="ms-auto"
                        aria-label={t('push.remove')}
                        busy={busy === `rm-${s.id}`}
                        onClick={async () => {
                          if (!(await confirm(t('push.removeConfirm'), { title: t('push.remove'), destructive: true, confirmLabel: t('push.remove') }))) return;
                          void run(`rm-${s.id}`, async () => {
                            await api(`/notifications/push/subscriptions/${s.id}`, { method: 'DELETE' });
                            if (s.endpoint_hash === mine) {
                              await (await currentSubscription())?.unsubscribe();
                              setMine(null);
                            }
                          });
                        }}
                      >
                        <Trash2 className="size-3.5" aria-hidden />
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
              {push.channel && <p className="text-xs text-faint">{t('push.severityHint')}</p>}
            </>
          );
        }}
      </Async>

      <div className="mt-4 border-t border-line pt-3">
        <h3 className="mb-1.5 inline-flex items-center gap-2 text-[13px] font-medium">
          <Download className="size-4 text-accent" aria-hidden />
          {t('push.installTitle')}
        </h3>
        {standalone ? (
          <p className="text-[13px] text-muted">{t('push.installed')}</p>
        ) : (
          <>
            {installEvent && (
              <Button
                size="sm"
                variant="primary"
                className="mb-2"
                onClick={() => {
                  void installEvent.prompt();
                  setInstallEvent(null);
                }}
              >
                {t('push.installNow')}
              </Button>
            )}
            <ul className="list-disc space-y-1 ps-5 text-[13px] text-muted">
              <li>{t('push.installAndroid')}</li>
              <li>{t('push.installIos')}</li>
              <li>{t('push.installDesktop')}</li>
            </ul>
          </>
        )}
      </div>
    </Card>
  );
}
