'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Logo } from '@/components/logo';
import { Button, ErrorNote, Notice, SkeletonBlock } from '@/components/ui';
import { type ApiError, api } from '@/lib/api';
import { absoluteTime } from '@/lib/format';
import { fill, useI18n } from '@/lib/i18n';

// The page a notification button opens (UX review item 9). No session: the single-use token in the
// address is the authority. Opening the page only describes the button (link previews and mail
// scanners fetch links); the device changes only when the person presses the button here.

interface TokenInfo {
  kind: 'allow_device' | 'pause_device';
  device: { id: string; label: string; ip: string | null; mac: string | null };
  expires_at: string;
  used: boolean;
  expired: boolean;
}

interface ActionResult {
  kind: 'allow_device' | 'pause_device';
  device: { id: string; label: string };
  paused_until?: string;
}

export default function NotificationActionPage() {
  const { t, locale, setLocale } = useI18n();
  const params = useParams<{ token: string }>();
  const token = typeof params?.token === 'string' ? params.token : '';
  const [info, setInfo] = useState<TokenInfo | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [done, setDone] = useState<ActionResult | null>(null);

  useEffect(() => {
    if (!token) return;
    api<TokenInfo>(`/notification-actions/${encodeURIComponent(token)}`)
      .then(setInfo)
      .catch((err: unknown) => setLoadError(err as ApiError));
  }, [token]);

  async function press() {
    setBusy(true);
    setError(null);
    try {
      setDone(await api<ActionResult>(`/notification-actions/${encodeURIComponent(token)}`, { method: 'POST' }));
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  }

  const name = (label: string, ip: string | null) => (ip && ip !== label ? `${label} (${ip})` : label);
  const deviceLink = (id: string) => (
    <Link
      href={`/radar/devices/${id}`}
      className="inline-flex h-9 w-full items-center justify-center rounded-[var(--radius-control)] border border-line-strong bg-surface px-3.5 text-[13px] font-medium text-fg hover:bg-raised"
    >
      {t('nact.openDevice')}
    </Link>
  );

  let body: React.ReactNode;
  if (loadError || !token) {
    body = <ErrorNote error={loadError ?? new Error(t('nact.expired'))} />;
  } else if (!info) {
    body = (
      <div role="status" aria-label={t('nact.loading')}>
        <SkeletonBlock lines={3} />
      </div>
    );
  } else if (done) {
    body = (
      <div className="space-y-4">
        <Notice>
          {done.kind === 'allow_device'
            ? fill(t('nact.allowedDone'), { device: done.device.label })
            : fill(t('nact.pausedDone'), { device: done.device.label, time: absoluteTime(done.paused_until ?? null, locale) })}
        </Notice>
        {deviceLink(done.device.id)}
      </div>
    );
  } else if (info.used || info.expired) {
    body = (
      <div className="space-y-4">
        <ErrorNote error={new Error(info.used ? t('nact.used') : t('nact.expired'))} />
        {deviceLink(info.device.id)}
      </div>
    );
  } else {
    const allow = info.kind === 'allow_device';
    const device = name(info.device.label, info.device.ip);
    body = (
      <div className="space-y-4">
        <div>
          <h1 className="text-lg font-semibold tracking-[-0.01em]" dir="auto">
            {fill(t(allow ? 'nact.allowQuestion' : 'nact.pauseQuestion'), { device })}
          </h1>
          <p className="mt-1 text-[13px] text-muted">{t(allow ? 'nact.allowBody' : 'nact.pauseBody')}</p>
          {info.device.mac && (
            <p className="mono mt-1 text-xs text-faint" dir="ltr">
              {info.device.mac}
            </p>
          )}
        </div>
        {error && <ErrorNote error={error} />}
        <Button variant={allow ? 'primary' : 'danger'} busy={busy} className="w-full" onClick={() => void press()}>
          {t(allow ? 'nact.allow' : 'nact.pause')}
        </Button>
        <p className="text-xs text-faint">{t('nact.once')}</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-between">
          <Logo />
          <button
            type="button"
            onClick={() => setLocale(locale === 'en' ? 'ar' : 'en')}
            className="rounded-[5px] px-1.5 py-1 text-xs text-muted hover:bg-raised hover:text-fg"
            lang={locale === 'en' ? 'ar' : 'en'}
          >
            {locale === 'en' ? 'العربية' : 'English'}
          </button>
        </div>
        <div className="rounded-[var(--radius-card)] border border-line bg-surface p-6 shadow-[var(--shadow-card)]">
          <p className="mb-3 text-xs font-medium uppercase tracking-wide text-faint">{t('nact.title')}</p>
          {body}
        </div>
      </div>
    </div>
  );
}
