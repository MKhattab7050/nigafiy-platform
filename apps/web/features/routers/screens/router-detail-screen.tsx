'use client';

import { ArrowLeft, Ban, CheckCircle2, Lock, Pencil, RefreshCw, Router, Search, ShieldOff, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { Async, Badge, Button, Card, DataTable, EmptyState, Fact, Input, PageHeader, SkeletonBlock, StatusBadge, Tabs } from '@/components/ui';
import { api } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { absoluteTime, relativeTime } from '@/lib/format';
import { type Key, fill, useI18n } from '@/lib/i18n';
import { BlockDialog } from '../components/block-dialog';
import { RequestProgress } from '../components/request-progress';
import { CertTrustModal, DeleteRouterModal, EditRouterModal } from '../components/router-modals';
import { RouterSettingsPanel } from '../components/router-settings-panel';
import { ConnectionLabel, DELIVERY_TONE, Fingerprint, HEALTH_TONE, RouterErrorNote, deliveryText, leaseText } from '../components/text';
import type { DeviceRef, QueuedRequest, RouterClient, RouterDetail } from '../types';
import { DeviceLink } from '@/components/device-link';
import { driverMaturity } from '../assistant';
import { DriverMaturityBadge } from '../components/router-assistant';

type DetailTab = 'clients' | 'settings' | 'blocks' | 'identity' | 'requests';

function RouterDetailView({ id }: { id: string }) {
  const { t, locale } = useI18n();
  const routerNav = useRouter();
  const searchParams = useSearchParams();
  const { can } = useApp();

  const detailQuery = useQuery<RouterDetail>(`/routers/${id}`, ['devices', 'collectors'], 15_000);
  const clientsQuery = useQuery<{ router_id: string; refreshed_at: string | null; items: RouterClient[] }>(
    `/routers/${id}/clients`,
    ['devices', 'collectors'],
    15_000,
  );

  const [tab, setTab] = useState<DetailTab>('clients');
  const [search, setSearch] = useState('');
  const [selectedDeviceIds, setSelectedDeviceIds] = useState<Set<string>>(new Set());
  const [dialogState, setDialogState] = useState<{ action: 'block' | 'unblock'; devices: DeviceRef[] } | null>(null);
  const [editing, setEditing] = useState(false);
  const [replaceCredsOnOpen, setReplaceCredsOnOpen] = useState(false);
  const [trusting, setTrusting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [activeReq, setActiveReq] = useState<QueuedRequest | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);

  useEffect(() => {
    if (searchParams.get('edit') === 'credentials') {
      setReplaceCredsOnOpen(true);
      setEditing(true);
    }
  }, [searchParams]);

  const reloadAll = () => {
    detailQuery.reload();
    clientsQuery.reload();
  };

  async function readNow() {
    setActionError(null);
    try {
      const q = await api<QueuedRequest>(`/routers/${id}/refresh`, { method: 'POST' });
      setActiveReq(q);
    } catch (err) {
      setActionError(err);
    }
  }

  return (
    <Async query={detailQuery} skeleton={<SkeletonBlock lines={8} />}>
      {(r) => (
        <RouterDetailBody
          router={r}
          clients={clientsQuery.data?.items ?? []}
          clientsRefreshedAt={clientsQuery.data?.refreshed_at ?? r.clients_refreshed_at}
          canTech={can('technician')}
          canAdmin={can('admin')}
          locale={locale}
          tab={tab}
          setTab={setTab}
          search={search}
          setSearch={setSearch}
          selectedDeviceIds={selectedDeviceIds}
          setSelectedDeviceIds={setSelectedDeviceIds}
          dialogState={dialogState}
          setDialogState={setDialogState}
          editing={editing}
          setEditing={(v) => {
            if (!v) setReplaceCredsOnOpen(false);
            setEditing(v);
          }}
          replaceCredsOnOpen={replaceCredsOnOpen}
          trusting={trusting}
          setTrusting={setTrusting}
          deleting={deleting}
          setDeleting={setDeleting}
          activeReq={activeReq}
          actionError={actionError}
          readNow={readNow}
          onReload={reloadAll}
          onDeleted={() => routerNav.push('/guard/routers')}
        />
      )}
    </Async>
  );
}

function RouterDetailBody({
  router: r,
  clients,
  clientsRefreshedAt,
  canTech,
  canAdmin,
  locale,
  tab,
  setTab,
  search,
  setSearch,
  selectedDeviceIds,
  setSelectedDeviceIds,
  dialogState,
  setDialogState,
  editing,
  setEditing,
  replaceCredsOnOpen,
  trusting,
  setTrusting,
  deleting,
  setDeleting,
  activeReq,
  actionError,
  readNow,
  onReload,
  onDeleted,
}: {
  router: RouterDetail;
  clients: RouterClient[];
  clientsRefreshedAt: string | null;
  canTech: boolean;
  canAdmin: boolean;
  locale: 'en' | 'ar';
  tab: DetailTab;
  setTab: (t: DetailTab) => void;
  search: string;
  setSearch: (s: string) => void;
  selectedDeviceIds: Set<string>;
  setSelectedDeviceIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  dialogState: { action: 'block' | 'unblock'; devices: DeviceRef[] } | null;
  setDialogState: (s: { action: 'block' | 'unblock'; devices: DeviceRef[] } | null) => void;
  editing: boolean;
  setEditing: (v: boolean) => void;
  replaceCredsOnOpen: boolean;
  trusting: boolean;
  setTrusting: (v: boolean) => void;
  deleting: boolean;
  setDeleting: (v: boolean) => void;
  activeReq: QueuedRequest | null;
  actionError: unknown;
  readNow: () => Promise<void>;
  onReload: () => void;
  onDeleted: () => void;
}) {
  const { t } = useI18n();

  const filteredClients = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return clients;
    return clients.filter((c) =>
      [c.device_label, c.hostname, c.ip, c.mac, c.connection, c.interface].some((v) => v?.toLowerCase().includes(q)),
    );
  }, [clients, search]);

  const clientToDeviceRef = (c: RouterClient): DeviceRef | null =>
    c.device_id
      ? {
          id: c.device_id,
          label: c.device_label || c.hostname || c.ip || c.mac,
          ip: c.ip,
          mac: c.mac,
        }
      : null;

  const selectableClients = useMemo(() => filteredClients.filter((c) => c.device_id !== null), [filteredClients]);

  const selectedDevices = useMemo(
    () =>
      clients
        .filter((c) => c.device_id && selectedDeviceIds.has(c.device_id))
        .map((c) => clientToDeviceRef(c)!)
        .filter(Boolean),
    [clients, selectedDeviceIds],
  );

  const toggleDevice = (deviceId: string) => {
    setSelectedDeviceIds((prev) => {
      const next = new Set(prev);
      if (next.has(deviceId)) next.delete(deviceId);
      else next.add(deviceId);
      return next;
    });
  };

  return (
    <>
      <div className="mb-3">
        <Link href="/guard/routers" className="inline-flex items-center gap-1.5 text-xs font-medium text-muted hover:text-fg">
          <ArrowLeft className="size-3.5 rtl:-scale-x-100" aria-hidden />
          {t('routers.back')}
        </Link>
      </div>

      <PageHeader
        icon={<Router className="size-[18px]" aria-hidden />}
        title={r.name}
        description={`${r.address}${r.port ? `:${r.port}` : ''} · ${r.identity?.model ?? t('routers.identityUnknown')}${r.identity?.firmware ? ` (${r.identity.firmware})` : ''}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={HEALTH_TONE[r.status]}>{t(`routers.status.${r.status}` as Key)}</Badge>
            <Badge tone={DELIVERY_TONE[r.delivery]}>{t(`routers.delivery.${r.delivery}` as Key)}</Badge>
            {canTech && (
              <Button size="sm" variant="secondary" onClick={() => void readNow()}>
                <RefreshCw className="size-3.5" aria-hidden />
                {t('routers.readNow')}
              </Button>
            )}
            {canAdmin && (
              <>
                {r.transport !== 'http' && (
                  <Button
                    size="sm"
                    variant={r.delivery === 'awaiting_certificate' || r.status === 'certificate' ? 'primary' : 'secondary'}
                    onClick={() => setTrusting(true)}
                  >
                    <Lock className="size-3.5" aria-hidden />
                    {t('routers.cert.title')}
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
                  <Pencil className="size-3.5" aria-hidden />
                  {t('routers.edit')}
                </Button>
                <Button size="sm" variant="danger" onClick={() => setDeleting(true)}>
                  <Trash2 className="size-3.5" aria-hidden />
                  {t('routers.delete')}
                </Button>
              </>
            )}
          </div>
        }
      />

      {r.delivery !== 'active' && (
        <div className="mb-4 rounded-[var(--radius-card)] border border-warn/40 bg-warn/10 px-4 py-3 text-xs leading-relaxed text-fg" dir="auto">
          {deliveryText(r, t, locale)}
        </div>
      )}

      {r.last_error && r.status !== 'ok' && (
        <div className="mb-4 rounded-[var(--radius-card)] border border-crit/30 bg-crit/[0.07] px-4 py-3 text-xs text-fg">
          <span className="font-semibold">{t('routers.lastError')}: </span>
          <span dir="auto">{r.last_error}</span>
        </div>
      )}

      {activeReq && (
        <div className="mb-4">
          <RequestProgress
            requestId={activeReq.request_id}
            routerId={r.id}
            collector={activeReq.collector}
            onSettled={() => onReload()}
          />
        </div>
      )}

      <RouterErrorNote error={actionError} routerId={r.id} />

      <Tabs
        value={tab}
        onChange={setTab}
        label={r.name}
        options={[
          { value: 'clients', label: t('routers.clients'), count: clients.length },
          { value: 'settings', label: t('routers.tab.settings') },
          { value: 'blocks', label: t('routers.blocksOnRouter'), count: r.blocked_entries?.length ?? 0 },
          { value: 'identity', label: t('routers.identity') },
          { value: 'requests', label: t('routers.requests'), count: r.recent_requests.length },
        ]}
      />

      {tab === 'clients' && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="relative min-w-64 flex-1 sm:max-w-sm">
              <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-faint" aria-hidden />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t('common.search')}
                aria-label={t('common.search')}
                className="ps-9"
              />
            </div>

            {clientsRefreshedAt && (
              <span className="text-xs text-muted" title={absoluteTime(clientsRefreshedAt, locale)}>
                {fill(t('routers.clientsRefreshed'), { when: relativeTime(clientsRefreshedAt, locale) })}
              </span>
            )}

            {canAdmin && selectedDevices.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 rounded-[var(--radius-control)] border border-line-strong bg-raised px-3 py-1.5">
                <span className="text-xs font-medium text-fg">
                  {fill(t('routers.selected'), { count: selectedDevices.length })}
                </span>
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => setDialogState({ action: 'block', devices: selectedDevices })}
                >
                  <Ban className="size-3.5" aria-hidden />
                  {t('routers.block')}
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => setDialogState({ action: 'unblock', devices: selectedDevices })}
                >
                  <ShieldOff className="size-3.5" aria-hidden />
                  {t('routers.unblock')}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setSelectedDeviceIds(new Set())}>
                  {t('routers.clearSelection')}
                </Button>
              </div>
            )}
          </div>

          <Card padded={false}>
            {filteredClients.length === 0 ? (
              <EmptyState title={t('routers.clientsNone')} />
            ) : (
              <DataTable stack>
                <thead>
                  <tr>
                    {canAdmin && (
                      <th scope="col" className="w-10">
                        <input
                          type="checkbox"
                          aria-label={t('common.all')}
                          checked={selectableClients.length > 0 && selectableClients.every((c) => c.device_id && selectedDeviceIds.has(c.device_id))}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setSelectedDeviceIds(new Set(selectableClients.map((c) => c.device_id!)));
                            } else {
                              setSelectedDeviceIds(new Set());
                            }
                          }}
                        />
                      </th>
                    )}
                    <th scope="col">{t('routers.client.name')}</th>
                    <th scope="col">{t('routers.client.blocked')}</th>
                    <th scope="col">{t('routers.client.connection')}</th>
                    <th scope="col">{t('routers.client.signal')}</th>
                    <th scope="col">{t('routers.client.ip')}</th>
                    <th scope="col">{t('routers.client.mac')}</th>
                    <th scope="col">{t('routers.client.lease')}</th>
                    {canAdmin && <th scope="col" className="text-end" />}
                  </tr>
                </thead>
                <tbody>
                  {filteredClients.map((c) => {
                    const ref = clientToDeviceRef(c);
                    return (
                      <tr key={c.mac}>
                        {canAdmin && (
                          <td>
                            {c.device_id ? (
                              <input
                                type="checkbox"
                                aria-label={c.device_label || c.hostname || c.mac}
                                checked={selectedDeviceIds.has(c.device_id)}
                                onChange={() => toggleDevice(c.device_id!)}
                              />
                            ) : null}
                          </td>
                        )}
                        <td>
                          <div className="min-w-0">
                            {c.device_id ? (
                              <DeviceLink id={c.device_id} className="font-medium text-fg hover:text-accent-hover hover:underline" dir="auto">
                                {c.device_label || c.hostname || c.ip || c.mac}
                              </DeviceLink>
                            ) : (
                              <span className="font-medium text-fg" dir="auto">
                                {c.hostname || c.ip || c.mac}
                              </span>
                            )}
                            <span className="block text-xs text-muted">
                              {c.device_id ? t('routers.linkInferred') : t('routers.noDevice')}
                              {c.active === false ? ` · ${t('routers.client.inactive')}` : ''}
                            </span>
                          </div>
                        </td>
                        <td data-label={t('routers.client.blocked')}>
                          {c.blocked ? (
                            <Badge tone="crit">
                              <Ban className="size-3" aria-hidden />
                              {c.ledger ? (c.ledger.pre_existing ? t('routers.blockedBy.administrator') : t('routers.blockedBy.lan-detective')) : t('routers.client.blocked')}
                            </Badge>
                          ) : (
                            <Badge tone="ok">
                              <CheckCircle2 className="size-3" aria-hidden />
                              {t('routers.notBlocked')}
                            </Badge>
                          )}
                        </td>
                        <td data-label={t('routers.client.connection')}>
                          <ConnectionLabel connection={c.connection} iface={c.interface} />
                        </td>
                        <td data-label={t('routers.client.signal')}>
                          <span className="mono">{c.signal_dbm !== null ? `${c.signal_dbm} dBm` : '—'}</span>
                        </td>
                        <td data-label={t('routers.client.ip')}>
                          <span className="mono">{c.ip ?? '—'}</span>
                        </td>
                        <td data-label={t('routers.client.mac')}>
                          <span className="mono text-xs">{c.mac}</span>
                        </td>
                        <td data-label={t('routers.client.lease')}>
                          <span>{leaseText(c.lease_remaining_seconds, c.lease_source, t)}</span>
                        </td>
                        {canAdmin && (
                          <td>
                            <div className="flex justify-end">
                              {ref &&
                                (c.blocked ? (
                                  <Button
                                    size="sm"
                                    variant="primary"
                                    onClick={() => setDialogState({ action: 'unblock', devices: [ref] })}
                                  >
                                    {t('routers.unblock')}
                                  </Button>
                                ) : (
                                  <Button
                                    size="sm"
                                    variant="danger"
                                    onClick={() => setDialogState({ action: 'block', devices: [ref] })}
                                  >
                                    {t('routers.block')}
                                  </Button>
                                ))}
                            </div>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </DataTable>
            )}
          </Card>
        </div>
      )}

      {tab === 'settings' && <RouterSettingsPanel router={r} clients={clients} canAdmin={canAdmin} onChanged={onReload} />}

      {tab === 'blocks' && (
        <div className="space-y-5">
          <Card title={t('routers.blocksOnRouter')} padded={false}>
            {!r.blocked_entries || r.blocked_entries.length === 0 ? (
              <EmptyState title={t('routers.blocksNone')} />
            ) : (
              <DataTable stack>
                <thead>
                  <tr>
                    <th scope="col">{t('routers.client.mac')}</th>
                    <th scope="col">{t('routers.client.name')}</th>
                    <th scope="col">{t('routers.cap.mechanism')}</th>
                    <th scope="col">{t('devices.status')}</th>
                  </tr>
                </thead>
                <tbody>
                  {r.blocked_entries.map((b) => (
                    <tr key={`${b.mac}-${b.mechanism}`}>
                      <td data-label={t('routers.client.mac')}>
                        <span className="mono text-xs font-medium">{b.mac}</span>
                      </td>
                      <td data-label={t('routers.client.name')}>
                        <span dir="auto">{b.name || '—'}</span>
                      </td>
                      <td data-label={t('routers.cap.mechanism')}>
                        <span dir="auto">{b.mechanism}</span>
                        {b.detail && <span className="block text-xs text-muted">{b.detail}</span>}
                      </td>
                      <td data-label={t('devices.status')}>
                        <div className="flex flex-wrap gap-1.5">
                          <Badge tone={b.owner === 'lan-detective' ? 'crit' : 'warn'}>
                            {t(`routers.blockedBy.${b.owner}` as Key)}
                          </Badge>
                          {b.partial && <Badge tone="warn">{t('routers.partial')}</Badge>}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </DataTable>
            )}
          </Card>

          <Card title={t('routers.ledger')} description={t('routers.ledgerHint')} padded={false}>
            {r.blocks.length === 0 ? (
              <EmptyState title={t('routers.ledgerNone')} />
            ) : (
              <DataTable stack>
                <thead>
                  <tr>
                    <th scope="col">{t('routers.client.mac')}</th>
                    <th scope="col">{t('routers.cap.mechanism')}</th>
                    <th scope="col">{t('routers.ledger.applied')}</th>
                    <th scope="col">{t('routers.ledger.released')}</th>
                  </tr>
                </thead>
                <tbody>
                  {r.blocks.map((entry) => (
                    <tr key={entry.id}>
                      <td data-label={t('routers.client.mac')}>
                        {entry.device_id ? (
                          <DeviceLink id={entry.device_id} className="mono text-xs font-medium text-accent-hover hover:underline">
                            {entry.mac}
                          </DeviceLink>
                        ) : (
                          <span className="mono text-xs">{entry.mac}</span>
                        )}
                      </td>
                      <td data-label={t('routers.cap.mechanism')}>
                        <span>{entry.mechanism ?? '—'}</span>
                        {entry.pre_existing && (
                          <span className="block text-xs text-muted">{t('routers.ledger.preExisting')}</span>
                        )}
                      </td>
                      <td data-label={t('routers.ledger.applied')}>
                        <div>
                          <span title={absoluteTime(entry.applied_at, locale)}>
                            {relativeTime(entry.applied_at, locale)}
                          </span>
                          {entry.applied_by_email && (
                            <span className="block text-xs text-muted">
                              {fill(t('routers.by'), { who: entry.applied_by_email })}
                            </span>
                          )}
                        </div>
                      </td>
                      <td data-label={t('routers.ledger.released')}>
                        {entry.released_at ? (
                          <div>
                            <span title={absoluteTime(entry.released_at, locale)}>
                              {relativeTime(entry.released_at, locale)}
                            </span>
                            <span className="block text-xs text-muted">
                              {entry.released_by_email ? `${fill(t('routers.by'), { who: entry.released_by_email })} · ` : ''}
                              {entry.released_via ? t(`routers.ledger.via.${entry.released_via}` as Key) : ''}
                            </span>
                          </div>
                        ) : (
                          <Badge tone="crit">{t('routers.ledger.open')}</Badge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </DataTable>
            )}
          </Card>
        </div>
      )}

      {tab === 'identity' && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card title={t('routers.identity')}>
            <dl>
              <Fact label={t('routers.address')}>
                <span className="mono">
                  {r.address}
                  {r.port ? `:${r.port}` : ''}
                </span>
              </Fact>
              <Fact label={t('routers.transport')}>{t(`routers.transport.${r.transport}` as Key)}</Fact>
              <Fact label={t('routers.vendor')}>{r.identity?.vendor ?? r.vendor}</Fact>
              <Fact label={t('routers.model')}>
                <span className="inline-flex flex-wrap items-center gap-2">
                  {r.identity?.model ?? t('routers.identityUnknown')}
                  <DriverMaturityBadge maturity={driverMaturity(r.vendor, r.identity?.model)} />
                </span>
              </Fact>
              <Fact label={t('routers.firmware')}>
                <span className="mono">{r.identity?.firmware ?? '—'}</span>
              </Fact>
              <Fact label={t('routers.credentials')}>
                <span title={absoluteTime(r.credentials.updated_at, locale)}>
                  {fill(t('routers.credentialsSaved'), { when: relativeTime(r.credentials.updated_at, locale) })}
                </span>
              </Fact>
            </dl>
            {r.certificate.pinned && (
              <div className="mt-4 space-y-1.5">
                <p className="text-xs font-medium text-muted">{t('routers.cert.trusted')}</p>
                <Fingerprint value={r.certificate.pinned} />
              </div>
            )}
          </Card>

          <Card title={t('routers.capabilities')}>
            {!r.capabilities || r.capabilities.length === 0 ? (
              <p className="text-[13px] text-muted">{t('routers.capabilitiesUnknown')}</p>
            ) : (
              <dl>
                {r.capabilities.map((cap) => (
                  <Fact key={cap.capability} label={t(`routers.cap.${cap.capability}` as Key)} source={cap.mechanism ?? cap.note}>
                    <Badge tone={cap.supported ? 'ok' : 'idle'}>
                      {t(cap.supported ? 'routers.cap.supported' : 'routers.cap.unsupported')}
                    </Badge>
                  </Fact>
                ))}
              </dl>
            )}
          </Card>
        </div>
      )}

      {tab === 'requests' && (
        <Card title={t('routers.requests')} padded={false}>
          {r.recent_requests.length === 0 ? (
            <EmptyState title={t('routers.requestsNone')} />
          ) : (
            <DataTable stack>
              <thead>
                <tr>
                  <th scope="col">{t('devices.type')}</th>
                  <th scope="col">{t('routers.client.mac')}</th>
                  <th scope="col">{t('devices.status')}</th>
                  <th scope="col">{t('routers.col.lastRead')}</th>
                  <th scope="col">{t('device.notes')}</th>
                </tr>
              </thead>
              <tbody>
                {r.recent_requests.map((req) => (
                  <tr key={req.id}>
                    <td data-label={t('devices.type')}>
                      <span className="font-medium">{t(`routers.action.${req.action}` as Key)}</span>
                      {req.created_by_email && (
                        <span className="block text-xs text-muted">{fill(t('routers.by'), { who: req.created_by_email })}</span>
                      )}
                    </td>
                    <td data-label={t('routers.client.mac')}>
                      <span className="mono text-xs">{req.mac ?? '—'}</span>
                    </td>
                    <td data-label={t('devices.status')}>
                      <Badge tone={req.status === 'completed' ? 'ok' : req.status === 'failed' ? 'crit' : req.status === 'expired' ? 'warn' : 'info'}>
                        {t(`routers.req.${req.status}` as Key)}
                      </Badge>
                    </td>
                    <td data-label={t('routers.col.lastRead')} title={absoluteTime(req.created_at, locale)}>
                      <span>{relativeTime(req.created_at, locale)}</span>
                    </td>
                    <td data-label={t('device.notes')}>
                      <span className="text-xs text-muted" dir="auto">
                        {req.error ?? req.result?.change?.detail ?? '—'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          )}
        </Card>
      )}

      {dialogState && (
        <BlockDialog
          routerId={r.id}
          action={dialogState.action}
          devices={dialogState.devices}
          onClose={() => setDialogState(null)}
          onDone={() => {
            setSelectedDeviceIds(new Set());
            onReload();
          }}
        />
      )}

      {editing && (
        <EditRouterModal
          router={r}
          initialReplaceCredentials={replaceCredsOnOpen}
          onClose={() => setEditing(false)}
          onSaved={onReload}
        />
      )}

      {trusting && (
        <CertTrustModal
          router={r}
          onClose={() => setTrusting(false)}
          onTrusted={onReload}
        />
      )}

      {deleting && (
        <DeleteRouterModal
          router={r}
          onClose={() => setDeleting(false)}
          onDeleted={onDeleted}
        />
      )}
    </>
  );
}

export function RouterDetailScreen({ id }: { id: string }) {
  return (
    <Suspense>
      <RouterDetailView id={id} />
    </Suspense>
  );
}
