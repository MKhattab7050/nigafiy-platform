'use client';

import { ArrowRight, Plus, ScanSearch } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import type { Collector, CollectorCreated, Site } from '@lan-detective/shared-types';
import { Badge, Button, ErrorNote, Field, Input } from '@/components/ui';
import { type ApiError, api } from '@/lib/api';
import { useApp } from '@/lib/app';
import { absoluteTime, relativeTime } from '@/lib/format';
import { fill, useI18n } from '@/lib/i18n';

/** "Collector N": the first N not already used at this site, so the token can be issued in one click. */
function nextCollectorName(template: string, collectors: Collector[]): string {
  const taken = new Set(collectors.map((c) => c.name.trim().toLowerCase()));
  let n = collectors.length + 1;
  while (taken.has(fill(template, { n }).toLowerCase())) n++;
  return fill(template, { n });
}

/**
 * One site's Sensors (network collectors): state, last heartbeat, scan now, and — with `manage` —
 * add a Sensor (issues its enrollment token), re-issue a pending token, revoke. Managing Sensors is
 * Hub's (`/sensors`, spec §5); Radar's Discovery shows the same list with "scan now" and a pointer.
 */
export function SiteSensors({
  site,
  collectors,
  reload,
  onToken,
  manage,
}: {
  site: Site;
  collectors: Collector[];
  reload: () => void;
  onToken: (c: CollectorCreated) => void;
  manage: boolean;
}) {
  const { t, locale } = useI18n();
  const { can } = useApp();
  const admin = can('admin') && manage;
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  // null = untouched: shows the generated default name (still editable).
  const [collectorName, setCollectorName] = useState<string | null>(null);
  const defaultCollectorName = nextCollectorName(t('discovery.collectorDefault'), collectors);
  const collectorValue = collectorName ?? defaultCollectorName;

  const act = async (key: string, fn: () => Promise<unknown>, after?: () => void) => {
    setBusy(key);
    setError(null);
    setNotice('');
    try {
      await fn();
      after?.();
      reload();
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy('');
    }
  };

  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold text-faint">{t('discovery.collectors')}</h3>
      {error && (
        <div className="mb-2">
          <ErrorNote error={error} />
        </div>
      )}
      {notice && (
        <p role="status" className="mb-2 rounded-md border border-accent/30 bg-accent/10 px-3 py-2 text-[13px]">
          {notice}
        </p>
      )}
      {collectors.length === 0 ? (
        <p className="text-[13px] text-muted">{t('discovery.noCollectors')}</p>
      ) : (
        <ul className="divide-y divide-line rounded-md border border-line">
          {collectors.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-3 py-2.5">
              <span className="text-[13px] font-medium" dir="auto">
                {c.name}
              </span>
              {c.status === 'pending' ? (
                <Badge tone="info">{t('discovery.pending')}</Badge>
              ) : c.status === 'revoked' ? (
                <Badge tone="idle">{t('discovery.revoked')}</Badge>
              ) : (
                <Badge tone={c.connection_state === 'online' ? 'ok' : c.connection_state === 'offline' ? 'crit' : 'idle'}>{t(`discovery.conn.${c.connection_state}`)}</Badge>
              )}
              {c.hostname && (
                <span className="mono text-xs text-muted">
                  {c.hostname} · {c.os}/{c.arch} · v{c.version}
                </span>
              )}
              {c.status === 'active' && (
                <span className="text-xs text-faint" title={absoluteTime(c.last_heartbeat_at, locale)}>
                  {t('discovery.lastHeartbeat')}: {c.last_heartbeat_at ? relativeTime(c.last_heartbeat_at, locale) : t('common.never')}
                  {c.spool_depth ? ` · ${c.spool_depth} ${t('discovery.buffered')}` : ''}
                </span>
              )}
              {c.status === 'pending' && c.enrollment_expires_at && (
                <span className="text-xs text-faint">
                  {t('discovery.tokenExpires')}: {relativeTime(c.enrollment_expires_at, locale)}
                </span>
              )}
              <span className="ms-auto flex items-center gap-1">
                {c.status === 'active' && can('technician') && (
                  <Button size="sm" busy={busy === `scan-${c.id}`} onClick={() => void act(`scan-${c.id}`, () => api(`/collectors/${c.id}/scan`, { method: 'POST' }), () => setNotice(t('discovery.scanQueued')))}>
                    <ScanSearch className="size-3.5" aria-hidden />
                    {t('discovery.scanNow')}
                  </Button>
                )}
                {c.status === 'pending' && admin && (
                  <Button size="sm" busy={busy === `tok-${c.id}`} onClick={() => void act(`tok-${c.id}`, async () => onToken(await api<CollectorCreated>(`/collectors/${c.id}/enrollment-token`, { method: 'POST' })))}>
                    {t('discovery.newToken')}
                  </Button>
                )}
                {c.status !== 'revoked' && admin && (
                  <Button size="sm" variant="danger" onClick={() => window.confirm(t('discovery.confirmRevoke')) && void act(c.id, () => api(`/collectors/${c.id}/revoke`, { method: 'POST' }))}>
                    {t('discovery.revoke')}
                  </Button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {admin && (
        <form
          className="mt-3 grid items-end gap-2 sm:grid-cols-[1fr_auto]"
          onSubmit={(e) => {
            e.preventDefault();
            void act('collector', async () => onToken(await api<CollectorCreated>('/collectors', { method: 'POST', body: { site_id: site.id, name: collectorValue.trim() } })), () => setCollectorName(null));
          }}
        >
          <Field label={t('discovery.collectorName')}>{(id) => <Input id={id} value={collectorValue} onChange={(e) => setCollectorName(e.target.value)} required maxLength={80} />}</Field>
          <Button type="submit" variant="primary" busy={busy === 'collector'} disabled={!collectorValue.trim()}>
            <Plus className="size-4" aria-hidden />
            {t('discovery.addCollector')}
          </Button>
          {collectorName === null && <p className="text-xs text-faint sm:col-span-2">{t('common.prefilled')}</p>}
        </form>
      )}
      {!manage && can('admin') && (
        <Link href="/sensors" className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-accent-hover hover:underline">
          {t('platform.sensors.manage')}
          <ArrowRight className="size-3.5 rtl:-scale-x-100" aria-hidden />
        </Link>
      )}
    </section>
  );
}
