'use client';

import { Plus, Radar, ScanSearch, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { Collector, CollectorCreated, NetworkScope, Site } from '@lan-detective/shared-types';
import { Async, Badge, Button, Card, CopyBlock, EmptyState, ErrorNote, Field, Input, Modal, PageHeader } from '@/components/ui';
import { type ApiError, api } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { absoluteTime, relativeTime } from '@/lib/format';
import { useI18n } from '@/lib/i18n';

function TokenModal({ created, onClose }: { created: CollectorCreated; onClose: () => void }) {
  const { t } = useI18n();
  const server = typeof window === 'undefined' ? '' : window.location.origin;
  const docker = `docker run -d --name lan-collector --restart unless-stopped \\\n  --network host --cap-add NET_RAW \\\n  -v lan-collector:/var/lib/lan-collector \\\n  -e LAN_COLLECTOR_SERVER_URL=${server} \\\n  -e LAN_COLLECTOR_ENROLLMENT_TOKEN=${created.enrollment_token} \\\n  lan-detective/lan-collector`;
  const binary = `LAN_COLLECTOR_SERVER_URL=${server} \\\nLAN_COLLECTOR_ENROLLMENT_TOKEN=${created.enrollment_token} \\\n./lan-collector -config collector.yaml`;
  const local = /^(localhost|127.0.0.1|[::1])$/.test(typeof window === 'undefined' ? '' : window.location.hostname);
  return (
    <Modal title={`${t('discovery.tokenTitle')} — ${created.collector.name}`} onClose={onClose} wide>
      <div className="space-y-4">
        <p className="rounded-md border border-warn/30 bg-warn/10 px-3 py-2 text-[13px] text-fg">{t('discovery.tokenOnce')}</p>
        <CopyBlock label={t('discovery.tokenLabel')} value={created.enrollment_token} />
        {local && <CopyBlock label={t('discovery.installLocal')} value={`pnpm local --token ${created.enrollment_token}`} />}
        <CopyBlock label={t('discovery.installDocker')} value={docker} multiline />
        <CopyBlock label={t('discovery.installBinary')} value={binary} multiline />
        <div className="flex justify-end">
          <Button variant="primary" onClick={onClose}>
            {t('common.close')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function SiteSection({ site, scopes, collectors, reload, onToken }: { site: Site; scopes: NetworkScope[]; collectors: Collector[]; reload: () => void; onToken: (c: CollectorCreated) => void }) {
  const { t, locale } = useI18n();
  const { can } = useApp();
  const admin = can('admin');
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [cidr, setCidr] = useState('');
  const [label, setLabel] = useState('');
  const [attested, setAttested] = useState(false);
  const [collectorName, setCollectorName] = useState('');
  const [interval, setIntervalValue] = useState(String(site.discovery_interval_seconds));

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
    <Card title={site.name}>
      <div className="space-y-6">
        {error && <ErrorNote error={error} />}
        {notice && <p role="status" className="rounded-md border border-accent/30 bg-accent/10 px-3 py-2 text-[13px]">{notice}</p>}

        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-faint">{t('discovery.scopes')}</h3>
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
                        onClick={() => window.confirm(t('discovery.confirmRemoveScope')) && void act(s.id, () => api(`/scopes/${s.id}`, { method: 'DELETE' }))}
                      >
                        <Trash2 className="size-3.5" aria-hidden />
                      </Button>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {admin && (
            <form
              className="mt-3 space-y-2.5"
              onSubmit={(e) => {
                e.preventDefault();
                void act('scope', () => api(`/sites/${site.id}/scopes`, { method: 'POST', body: { cidr, label: label || undefined, authorization_confirmed: attested } }), () => {
                  setCidr('');
                  setLabel('');
                  setAttested(false);
                });
              }}
            >
              <div className="grid gap-2 sm:grid-cols-[12rem_1fr_auto]">
                <Input value={cidr} onChange={(e) => setCidr(e.target.value)} placeholder="192.168.1.0/24" aria-label={t('discovery.cidr')} required dir="ltr" className="mono" />
                <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t('discovery.label')} aria-label={t('discovery.label')} maxLength={80} />
                <Button type="submit" busy={busy === 'scope'} disabled={!attested || !cidr}>
                  <Plus className="size-4" aria-hidden />
                  {t('discovery.addScope')}
                </Button>
              </div>
              <label className="flex cursor-pointer items-start gap-2 text-[13px] text-muted">
                <input type="checkbox" checked={attested} onChange={(e) => setAttested(e.target.checked)} className="mt-0.5 size-4 accent-[var(--color-accent)]" />
                {t('discovery.attest')}
              </label>
            </form>
          )}
        </section>

        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-faint">{t('discovery.collectors')}</h3>
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
              className="mt-3 grid gap-2 sm:grid-cols-[1fr_auto]"
              onSubmit={(e) => {
                e.preventDefault();
                void act('collector', async () => onToken(await api<CollectorCreated>('/collectors', { method: 'POST', body: { site_id: site.id, name: collectorName } })), () => setCollectorName(''));
              }}
            >
              <Input value={collectorName} onChange={(e) => setCollectorName(e.target.value)} placeholder={t('discovery.collectorName')} aria-label={t('discovery.collectorName')} required maxLength={80} />
              <Button type="submit" variant="primary" busy={busy === 'collector'} disabled={!collectorName.trim()}>
                <Plus className="size-4" aria-hidden />
                {t('discovery.addCollector')}
              </Button>
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
    </Card>
  );
}

export default function DiscoveryPage() {
  const { t } = useI18n();
  const { sites, siteId, reloadSites, can } = useApp();
  const scopes = useQuery<{ items: NetworkScope[] }>('/scopes', ['collectors', 'devices']);
  const collectors = useQuery<{ items: Collector[] }>('/collectors', ['collectors'], 15_000);
  const [token, setToken] = useState<CollectorCreated | null>(null);
  const [siteName, setSiteName] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const reload = () => {
    scopes.reload();
    collectors.reload();
    reloadSites();
  };
  const visible = sites.filter((s) => !siteId || s.id === siteId);

  return (
    <>
      <PageHeader title={t('discovery.title')} description={t('discovery.intro')} />
      <Async query={scopes}>
        {(sc) => (
          <Async query={collectors}>
            {(co) => (
              <div className="space-y-4">
                {visible.length === 0 && (
                  <Card>
                    <EmptyState icon={<Radar className="size-8" />} title={t('common.noData')} />
                  </Card>
                )}
                {visible.map((site) => (
                  <SiteSection
                    key={site.id}
                    site={site}
                    scopes={sc.items.filter((s) => s.site_id === site.id)}
                    collectors={co.items.filter((c) => c.site_id === site.id)}
                    reload={reload}
                    onToken={setToken}
                  />
                ))}
                {can('admin') && (
                  <form
                    className="flex flex-wrap items-center gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      setError(null);
                      api('/sites', { method: 'POST', body: { name: siteName } })
                        .then(() => {
                          setSiteName('');
                          reload();
                        })
                        .catch((err: ApiError) => setError(err));
                    }}
                  >
                    <Input value={siteName} onChange={(e) => setSiteName(e.target.value)} placeholder={t('discovery.siteName')} aria-label={t('discovery.siteName')} maxLength={80} className="w-64" />
                    <Button type="submit" disabled={!siteName.trim()}>
                      <Plus className="size-4" aria-hidden />
                      {t('discovery.addSite')}
                    </Button>
                    {error && <ErrorNote error={error} />}
                  </form>
                )}
              </div>
            )}
          </Async>
        )}
      </Async>
      {token && <TokenModal created={token} onClose={() => setToken(null)} />}
    </>
  );
}
