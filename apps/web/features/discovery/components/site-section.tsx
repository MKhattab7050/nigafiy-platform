'use client';

import { ChevronDown, Pencil, Plus, ScanSearch, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { Collector, CollectorCreated, NetworkScope, Site } from '@lan-detective/shared-types';
import { Badge, Button, Card, ErrorNote, Field, Input } from '@/components/ui';
import { type ApiError, api } from '@/lib/api';
import { useApp } from '@/lib/app';
import { absoluteTime, browserTimeZone, relativeTime } from '@/lib/format';
import { fill, useI18n } from '@/lib/i18n';
import { ScopeSuggestionList, useScopeSuggestions } from './scope-suggestions';
import { SiteEditModal } from './site-edit';

/** "Collector N": the first N not already used at this site, so the token can be issued in one click. */
function nextCollectorName(template: string, collectors: Collector[]): string {
  const taken = new Set(collectors.map((c) => c.name.trim().toLowerCase()));
  let n = collectors.length + 1;
  while (taken.has(fill(template, { n }).toLowerCase())) n++;
  return fill(template, { n });
}

export function SiteSection({ site, scopes, collectors, reload, onToken }: { site: Site; scopes: NetworkScope[]; collectors: Collector[]; reload: () => void; onToken: (c: CollectorCreated) => void }) {
  const { t, locale } = useI18n();
  const { can } = useApp();
  const admin = can('admin');
  const suggestions = useScopeSuggestions(site.id);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [cidr, setCidr] = useState('');
  const [label, setLabel] = useState('');
  const [attested, setAttested] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  // null = untouched: shows the generated default name (still editable).
  const [collectorName, setCollectorName] = useState<string | null>(null);
  const [interval, setIntervalValue] = useState(String(site.discovery_interval_seconds));
  const [editing, setEditing] = useState(false);
  const defaultCollectorName = nextCollectorName(t('discovery.collectorDefault'), collectors);
  const collectorValue = collectorName ?? defaultCollectorName;
  const suggested = suggestions.data?.items ?? [];
  const browserZone = browserTimeZone();

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

  const manualForm = (
    <form
      className="space-y-2.5"
      onSubmit={(e) => {
        e.preventDefault();
        void act(
          'scope',
          () => api(`/sites/${site.id}/scopes`, { method: 'POST', body: { cidr, label: label || undefined, authorization_confirmed: attested } }),
          () => {
            setCidr('');
            setLabel('');
            setAttested(false);
            suggestions.reload();
          },
        );
      }}
    >
      <div className="grid items-end gap-2 sm:grid-cols-[12rem_1fr_auto]">
        <Field label={t('discovery.cidr')}>{(id) => <Input id={id} value={cidr} onChange={(e) => setCidr(e.target.value)} placeholder="192.168.1.0/24" required dir="ltr" className="mono" />}</Field>
        <Field label={t('discovery.label')}>{(id) => <Input id={id} value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} />}</Field>
        <Button type="submit" busy={busy === 'scope'} disabled={!attested || !cidr}>
          <Plus className="size-4" aria-hidden />
          {t('discovery.addScope')}
        </Button>
      </div>
      <label className="flex cursor-pointer items-start gap-2 text-[13px] text-muted">
        <input type="checkbox" checked={attested} onChange={(e) => setAttested(e.target.checked)} className="mt-0.5 size-4 shrink-0 accent-[var(--color-accent)]" />
        {t('discovery.attest')}
      </label>
    </form>
  );

  return (
    <Card
      title={<span dir="auto">{site.name}</span>}
      action={
        admin && (
          <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
            <Pencil className="size-3.5" aria-hidden />
            {t('discovery.site.edit')}
          </Button>
        )
      }
    >
      <div className="space-y-6">
        {error && <ErrorNote error={error} />}
        {notice && <p role="status" className="rounded-md border border-accent/30 bg-accent/10 px-3 py-2 text-[13px]">{notice}</p>}

        <div className="text-[13px]">
          <p>
            <span className="text-muted">{t('discovery.site.timezone')}: </span>
            <span className="mono" dir="ltr">
              {site.timezone}
            </span>
            {browserZone === site.timezone && <span className="ms-2 text-xs text-faint">{t('discovery.site.timezoneMatches')}</span>}
          </p>
          <p className="mt-0.5 max-w-3xl text-xs leading-relaxed text-faint">
            {t('discovery.site.timezoneOrigin')} {site.timezone === 'UTC' ? t('discovery.site.timezoneUtc') : ''}
          </p>
        </div>

        <section>
          <h3 className="mb-2 text-xs font-semibold text-faint">{t('discovery.scopes')}</h3>
          {scopes.length === 0 ? (
            <p className="text-[13px] text-muted">{t('discovery.noScopes')}</p>
          ) : (
            <ul className="divide-y divide-line rounded-md border border-line">
              {scopes.map((s) => (
                <li key={s.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2.5">
                  <span className="mono text-[13px] font-medium">{s.cidr}</span>
                  {s.label && <span className="text-[13px] text-muted" dir="auto">{s.label}</span>}
                  <span className="text-xs text-faint" title={absoluteTime(s.authorized_at, locale)}>
                    {t('discovery.attestedBy')} {s.authorized_by_name ?? '—'}
                  </span>
                  <span className="text-xs text-faint">
                    {t('discovery.lastSweep')}: {s.last_run_finished_at ? relativeTime(s.last_run_finished_at, locale) : t('common.never')}
                  </span>
                  {admin && (
                    <span className="ms-auto flex items-center gap-1">
                      <Button size="sm" variant="ghost" busy={busy === s.id} onClick={() => void act(s.id, () => api(`/scopes/${s.id}`, { method: 'PATCH', body: { enabled: !s.enabled } }))}>
                        {s.enabled ? t('common.enabled') : t('common.disabled')}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`${t('common.delete')}: ${s.cidr}`}
                        onClick={() => window.confirm(t('discovery.confirmRemoveScope')) && void act(s.id, () => api(`/scopes/${s.id}`, { method: 'DELETE' }), suggestions.reload)}
                      >
                        <Trash2 className="size-3.5" aria-hidden />
                      </Button>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}

          {suggested.length > 0 && (
            <div className="mt-4">
              <h4 className="text-xs font-semibold text-fg">{t('discovery.sugg.title')}</h4>
              <p className="mb-2 mt-0.5 text-xs text-muted">{t('discovery.sugg.intro')}</p>
              <ScopeSuggestionList
                siteId={site.id}
                items={suggested}
                admin={admin}
                onAuthorized={() => {
                  suggestions.reload();
                  reload();
                }}
              />
            </div>
          )}
          {suggestions.error && !suggestions.data && (
            <div className="mt-3">
              <ErrorNote error={suggestions.error} onRetry={suggestions.reload} />
            </div>
          )}

          {admin &&
            (suggested.length > 0 ? (
              <div className="mt-3">
                <button
                  type="button"
                  onClick={() => setManualOpen(!manualOpen)}
                  aria-expanded={manualOpen}
                  className="inline-flex h-8 items-center gap-1 rounded px-1 text-xs font-medium text-muted hover:text-fg"
                >
                  {t('discovery.manual')}
                  <ChevronDown className={`size-3.5 transition-transform duration-150 ${manualOpen ? 'rotate-180' : ''}`} aria-hidden />
                </button>
                {manualOpen && <div className="mt-2">{manualForm}</div>}
              </div>
            ) : (
              <div className="mt-3">
                <h4 className="mb-2 text-xs font-semibold text-fg">{t('discovery.manual')}</h4>
                {manualForm}
              </div>
            ))}
        </section>

        <section>
          <h3 className="mb-2 text-xs font-semibold text-faint">{t('discovery.collectors')}</h3>
          {collectors.length === 0 ? (
            <p className="text-[13px] text-muted">{t('discovery.noCollectors')}</p>
          ) : (
            <ul className="divide-y divide-line rounded-md border border-line">
              {collectors.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-3 py-2.5">
                  <span className="text-[13px] font-medium" dir="auto">{c.name}</span>
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
              <Field label={t('discovery.collectorName')}>
                {(id) => <Input id={id} value={collectorValue} onChange={(e) => setCollectorName(e.target.value)} required maxLength={80} />}
              </Field>
              <Button type="submit" variant="primary" busy={busy === 'collector'} disabled={!collectorValue.trim()}>
                <Plus className="size-4" aria-hidden />
                {t('discovery.addCollector')}
              </Button>
              {collectorName === null && <p className="text-xs text-faint sm:col-span-2">{t('common.prefilled')}</p>}
            </form>
          )}
        </section>

        {admin && (
          <form
            className="flex flex-wrap items-end gap-2 border-t border-line pt-4"
            onSubmit={(e) => {
              e.preventDefault();
              void act('interval', () => api(`/sites/${site.id}`, { method: 'PATCH', body: { discovery_interval_seconds: Number(interval) } }));
            }}
          >
            <Field label={t('discovery.interval')} hint={t('discovery.intervalUnit')}>
              {(id) => <Input id={id} type="number" min={60} max={86400} value={interval} onChange={(e) => setIntervalValue(e.target.value)} className="w-32" dir="ltr" />}
            </Field>
            <Button type="submit" busy={busy === 'interval'} className="mb-5" disabled={Number(interval) === site.discovery_interval_seconds}>
              {t('common.save')}
            </Button>
          </form>
        )}
      </div>
      {editing && <SiteEditModal site={site} onClose={() => setEditing(false)} onSaved={reload} />}
    </Card>
  );
}
