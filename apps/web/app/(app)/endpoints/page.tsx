'use client';

import clsx from 'clsx';
import { Cpu, Plus, KeyRound, Ban } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { EndpointCreated, EndpointSummary } from '@lan-detective/shared-types';
import { Async, Badge, Button, Card, CopyBlock, EmptyState, ErrorNote, Field, Input, Modal, PageHeader, Select, type Tone } from '@/components/ui';
import { type ApiError, api, qs } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { endpointsText } from '@/lib/endpoints-text';
import { pct, relativeTime } from '@/lib/format';
import { useI18n } from '@/lib/i18n';

function epTone(ep: EndpointSummary): Tone {
  if (ep.status === 'revoked') return 'crit';
  if (ep.status === 'pending') return 'warn';
  return ep.connection_state === 'online' ? 'ok' : 'crit';
}

function Meter({ value, label }: { value: number | null; label: string }) {
  if (value === null || value === undefined) return <span className="text-xs text-faint">—</span>;
  const tone = value >= 90 ? 'bg-crit' : value >= 75 ? 'bg-warn' : 'bg-ok';
  return (
    <div className="min-w-24">
      <div className="mb-1 flex items-center justify-between text-[11px]">
        <span className="text-muted">{label}</span>
        <span className="mono text-fg">{pct(value, 0)}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-bg">
        <div className={clsx('h-full rounded-full transition-all', tone)} style={{ width: `${Math.min(100, Math.max(2, value))}%` }} />
      </div>
    </div>
  );
}

export default function EndpointsPage() {
  const { locale, t } = useI18n();
  const tx = endpointsText(locale);
  const { sites, siteId, can } = useApp();
  const query = useQuery<{ items: EndpointSummary[] }>(`/endpoints${qs({ site_id: siteId })}`, ['devices'], 10_000);

  const [showAdd, setShowAdd] = useState(false);
  const [chosenSite, setChosenSite] = useState('');
  const [name, setName] = useState('');
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const [issued, setIssued] = useState<EndpointCreated | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const enrollName = params.get('enroll_name');
    const enrollSite = params.get('site_id');
    const enrollDevice = params.get('device_id');
    if (enrollName && can('admin')) {
      setName(enrollName);
      if (enrollSite) setChosenSite(enrollSite);
      if (enrollDevice) setDeviceId(enrollDevice);
      setShowAdd(true);
    }
  }, [can]);

  const activeSite = chosenSite || siteId || sites[0]?.id || '';

  async function createEndpoint(e: React.FormEvent) {
    e.preventDefault();
    if (!activeSite || !name.trim()) return;
    setBusy('create');
    setError(null);
    try {
      const created = await api<EndpointCreated>('/endpoints', {
        method: 'POST',
        body: { site_id: activeSite, name: name.trim(), device_id: deviceId },
      });
      setShowAdd(false);
      setName('');
      setDeviceId(null);
      setIssued(created);
      query.reload();
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy('');
    }
  }

  async function reissueToken(id: string) {
    setBusy(id);
    setError(null);
    try {
      const res = await api<EndpointCreated>(`/endpoints/${id}/enrollment-token`, { method: 'POST' });
      setIssued(res);
      query.reload();
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy('');
    }
  }

  async function revokeEndpoint(id: string) {
    if (!window.confirm(tx.revokeConfirm)) return;
    setBusy(id);
    setError(null);
    try {
      await api(`/endpoints/${id}/revoke`, { method: 'POST' });
      query.reload();
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy('');
    }
  }

  return (
    <>
      <PageHeader
        title={tx.title}
        description={tx.subtitle}
        actions={
          can('admin') ? (
            <Button variant="primary" onClick={() => setShowAdd(true)}>
              <Plus className="size-4" aria-hidden />
              {tx.addEndpoint}
            </Button>
          ) : undefined
        }
      />

      {error && (
        <div className="mb-4">
          <ErrorNote error={error} />
        </div>
      )}

      <Async query={query}>
        {({ items }) =>
          items.length === 0 ? (
            <Card>
              <EmptyState
                icon={<Cpu className="size-8" />}
                title={tx.emptyTitle}
                action={
                  can('admin') ? (
                    <Button variant="primary" onClick={() => setShowAdd(true)}>
                      <Plus className="size-4" aria-hidden />
                      {tx.addEndpoint}
                    </Button>
                  ) : undefined
                }
              >
                {tx.emptyBody}
              </EmptyState>
            </Card>
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              {items.map((ep) => {
                const statusLabel =
                  ep.status === 'revoked' ? tx.revoked : ep.status === 'pending' ? tx.pending : ep.connection_state === 'online' ? tx.online : tx.offline;
                return (
                  <Card
                    key={ep.id}
                    title={
                      <span className="flex flex-wrap items-center gap-2">
                        <Link href={`/endpoints/${ep.id}`} className="font-semibold text-fg hover:text-accent-hover hover:underline">
                          {ep.name}
                        </Link>
                        <Badge tone={epTone(ep)}>{statusLabel}</Badge>
                      </span>
                    }
                    action={
                      can('admin') && ep.status !== 'revoked' ? (
                        <div className="flex items-center gap-1.5">
                          {ep.status === 'pending' && (
                            <Button size="sm" busy={busy === ep.id} onClick={() => void reissueToken(ep.id)}>
                              <KeyRound className="size-3.5" aria-hidden />
                              {tx.newToken}
                            </Button>
                          )}
                          <Button size="sm" variant="danger" busy={busy === ep.id} onClick={() => void revokeEndpoint(ep.id)}>
                            <Ban className="size-3.5" aria-hidden />
                            {tx.revoke}
                          </Button>
                        </div>
                      ) : undefined
                    }
                  >
                    <div className="space-y-3">
                      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
                        <span>
                          {ep.site_name}
                          {ep.hostname ? ` · ${ep.hostname}` : ''}
                          {ep.os_version || ep.os ? ` · ${ep.os_version ?? ep.os}` : ''}
                        </span>
                        {ep.primary_ip && (
                          <code dir="ltr" className="mono rounded bg-raised px-1.5 py-0.5 text-fg">
                            {ep.primary_ip}
                          </code>
                        )}
                      </div>

                      {ep.status === 'active' && (
                        <>
                          <div className="grid grid-cols-3 gap-3 rounded-md border border-line bg-bg/60 p-2.5">
                            <Meter value={ep.cpu_pct} label={tx.cpu} />
                            <Meter value={ep.ram_pct} label={tx.memory} />
                            <Meter value={ep.disk_used_pct} label={tx.disk} />
                          </div>

                          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                            <span className="text-muted">
                              {tx.loggedInUser}:{' '}
                              <span className="font-medium text-fg">{ep.logged_in_users.length > 0 ? ep.logged_in_users.join(', ') : tx.noUser}</span>
                            </span>
                            <span className="text-faint">
                              {tx.lastCheckIn}: {relativeTime(ep.last_heartbeat_at, locale)}
                            </span>
                          </div>
                        </>
                      )}

                      <div className="flex items-center justify-between border-t border-line pt-2.5 text-xs">
                        {ep.device_id ? (
                          <Link href={`/devices/${ep.device_id}`} className="text-muted hover:text-fg hover:underline">
                            {tx.openDevice}
                          </Link>
                        ) : (
                          <span />
                        )}
                        <Link href={`/endpoints/${ep.id}`} className="font-medium text-accent-hover hover:underline">
                          {tx.tabs.overview} →
                        </Link>
                      </div>
                    </div>
                  </Card>
                );
              })}
            </div>
          )
        }
      </Async>

      {showAdd && (
        <Modal title={tx.addEndpoint} onClose={() => setShowAdd(false)}>
          <form onSubmit={createEndpoint} className="space-y-4">
            {sites.length > 1 && (
              <Field label={t('common.site')}>
                {(id) => (
                  <Select id={id} value={activeSite} onChange={(e) => setChosenSite(e.target.value)}>
                    {sites.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            )}
            <Field label={tx.endpointName}>
              {(id) => (
                <Input
                  id={id}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={tx.endpointNamePlaceholder}
                  maxLength={80}
                  required
                />
              )}
            </Field>
            <div className="flex justify-end gap-2">
              <Button onClick={() => setShowAdd(false)}>{t('common.cancel')}</Button>
              <Button type="submit" variant="primary" busy={busy === 'create'}>
                {tx.create}
              </Button>
            </div>
          </form>
        </Modal>
      )}

      {issued && (
        <Modal title={tx.tokenModalTitle} onClose={() => setIssued(null)} wide>
          <div className="space-y-4">
            <p className="text-[13px] text-muted">{tx.tokenOnce}</p>
            <CopyBlock label={tx.tokenLabel} value={issued.enrollment_token} />
            <CopyBlock
              label={tx.installLocal}
              multiline
              value={`pnpm build:agent && ./agents/endpoint-agent/bin/endpoint-agent -server http://localhost:4100 -allow-insecure-http -token ${issued.enrollment_token}`}
            />
            <CopyBlock
              label={tx.installWindows}
              multiline
              value={`endpoint-agent.exe -server https://your-lan-detective-server -token ${issued.enrollment_token}`}
            />
            <CopyBlock
              label={tx.installLinux}
              multiline
              value={`./endpoint-agent -server https://your-lan-detective-server -token ${issued.enrollment_token}`}
            />
          </div>
        </Modal>
      )}
    </>
  );
}

