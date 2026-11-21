'use client';

import { Cable, HelpCircle, KeyRound, Wifi } from 'lucide-react';
import Link from 'next/link';
import { ErrorNote, type Tone } from '@/components/ui';
import { ApiError } from '@/lib/api';
import { absoluteTime } from '@/lib/format';
import { type Key, fill, useI18n } from '@/lib/i18n';
import type { Delivery, DeviceResult, RouterHealth, SiteRouter } from '../types';

export const HEALTH_TONE: Record<RouterHealth, Tone> = {
  never: 'idle',
  ok: 'ok',
  unreachable: 'crit',
  login_failed: 'crit',
  locked_out: 'warn',
  certificate: 'crit',
  not_authorized: 'warn',
  error: 'warn',
};

export const DELIVERY_TONE: Record<Delivery, Tone> = { active: 'ok', disabled: 'idle', out_of_scope: 'warn', awaiting_certificate: 'warn', login_paused: 'crit' };

/** Translates a key that may not exist (an API code we did not anticipate) with a fallback. */
export function useMaybe() {
  const { t } = useI18n();
  return (key: string, fallback: string) => {
    const value = t(key as Key);
    return value === key ? fallback : value;
  };
}

/** The delivery state of a router explained in one sentence (why the collector does or does not act on it). */
export function deliveryText(r: Pick<SiteRouter, 'delivery' | 'login_paused_reason' | 'login_paused_until'>, t: (k: Key) => string, locale: 'en' | 'ar'): string {
  if (r.delivery === 'login_paused') {
    return r.login_paused_reason === 'locked_out'
      ? fill(t('routers.deliveryText.login_paused.locked_out'), { until: absoluteTime(r.login_paused_until, locale) })
      : t('routers.deliveryText.login_paused.bad_credentials');
  }
  return t(`routers.deliveryText.${r.delivery}` as Key);
}

/** An API error from a routers endpoint, in the user's language, with what to do next. */
export function RouterErrorNote({ error, routerId, onRetry }: { error: unknown; routerId?: string; onRetry?: () => void }) {
  const { t, locale } = useI18n();
  const maybe = useMaybe();
  if (!error) return null;
  if (!(error instanceof ApiError)) return <ErrorNote error={error as Error} onRetry={onRetry} />;
  let message = maybe(`routers.err.${error.code}`, error.message);
  const note = typeof error.info?.note === 'string' ? error.info.note : null;
  if (error.code === 'unsupported_on_router' && note) message = `${message} ${note}`;
  if (error.code === 'router_login_paused' && error.info?.reason === 'locked_out' && typeof error.info.until === 'string') {
    message = fill(t('routers.deliveryText.login_paused.locked_out'), { until: absoluteTime(error.info.until, locale) });
  }
  const paused = error.code === 'router_login_paused';
  return (
    <div className="space-y-2">
      {/* A login pause is not fixed by trying again: it needs new credentials. */}
      <ErrorNote error={new ApiError(error.status, error.code, message, error.details)} onRetry={paused ? undefined : onRetry} />
      {paused && routerId && <UpdateCredentialsLink routerId={routerId} />}
    </div>
  );
}

export function UpdateCredentialsLink({ routerId }: { routerId: string }) {
  const { t } = useI18n();
  return (
    <Link href={`/routers/${routerId}?edit=credentials`} className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-control)] border border-line-strong bg-surface px-3 text-xs font-medium text-fg hover:bg-raised">
      <KeyRound className="size-3.5" aria-hidden />
      {t('routers.updateCredentials')}
    </Link>
  );
}

/** Per-device refusal from POST /routers/:id/block|unblock, translated (falls back to the API's message). */
export function useRefusalText() {
  const maybe = useMaybe();
  return (r: DeviceResult) => maybe(`routers.refusal.${r.code ?? ''}`, r.message ?? r.code ?? '');
}

const WIFI = /wifi|wlan|wireless|2\.4|5g|6g|802\.11/i;

/** Connection type with an icon; the word is always shown too. */
export function ConnectionLabel({ connection, iface }: { connection: string; iface?: string | null }) {
  const { t } = useI18n();
  const maybe = useMaybe();
  const wifi = WIFI.test(connection);
  const wired = /wire|lan|eth/i.test(connection) && !wifi;
  const Icon = wifi ? Wifi : wired ? Cable : HelpCircle;
  const label = maybe(`routers.conn.${connection}`, wired ? t('routers.conn.wired') : wifi ? t('routers.conn.wifi') : connection || t('routers.conn.unknown'));
  return (
    <span className="inline-flex items-center gap-1.5">
      <Icon className="size-3.5 shrink-0 text-faint" aria-hidden />
      <span>{label}</span>
      {iface && (
        <span className="text-[11px] text-faint" dir="auto">
          · {iface}
        </span>
      )}
    </span>
  );
}

/** Lease time remaining, compact. */
export function leaseText(seconds: number | null, source: string | null, t: (k: Key) => string): string {
  if (source === 'static') return t('routers.client.leaseStatic');
  if (seconds === null || seconds === undefined) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const time = h >= 48 ? `${Math.floor(h / 24)}d` : h > 0 ? `${h}h ${m}m` : `${m}m`;
  return fill(t('routers.client.leaseRemaining'), { time });
}

/** The fingerprint grouped for reading aloud and comparing: colon pairs, four pairs per group. */
export function Fingerprint({ value }: { value: string }) {
  const pairs = value.split(':');
  const groups: string[] = [];
  for (let i = 0; i < pairs.length; i += 8) groups.push(pairs.slice(i, i + 8).join(':'));
  return (
    <code className="mono block break-all rounded-[var(--radius-control)] border border-line-strong bg-sunken px-3 py-2 text-[12px] leading-relaxed text-fg" dir="ltr">
      {groups.map((g, i) => (
        <span key={i} className="block">
          {g}
        </span>
      ))}
    </code>
  );
}
