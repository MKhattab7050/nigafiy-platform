'use client';

import clsx from 'clsx';
import { Ban, BatteryCharging, Cpu, Download, KeyRound, Laptop, Plus, ShieldAlert, ShieldCheck, Smartphone } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import type {
  EndpointComplianceStatus,
  EndpointCreated,
  EndpointManagementMode,
  EndpointPlatform,
  EndpointSummary,
} from '@lan-detective/shared-types';
import {
  Async,
  Badge,
  Button,
  Card,
  CopyBlock,
  EmptyState,
  ErrorNote,
  Field,
  Input,
  Modal,
  PageHeader,
  Segmented,
  Select,
  type Tone,
} from '@/components/ui';
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

function complianceTone(status: EndpointComplianceStatus): Tone {
  if (status === 'compliant') return 'ok';
  if (status === 'non_compliant') return 'crit';
  if (status === 'attention') return 'warn';
  return 'idle';
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

const PLATFORM_MODES: Record<EndpointPlatform, EndpointManagementMode[]> = {
  windows: ['agent'],
  linux: ['agent'],
  macos: ['agent', 'macos_mdm'],
  android: ['android_device_owner', 'android_work_profile', 'android_companion'],
  ios: ['ios_supervised_mdm', 'ios_byod_mdm'],
};

export default function EndpointsPage() {
  const { locale, t } = useI18n();
  const tx = endpointsText(locale);
  const { sites, siteId, can } = useApp();
  const query = useQuery<{ items: EndpointSummary[] }>(`/endpoints${qs({ site_id: siteId })}`, ['devices'], 8_000);

  const [platformFilter, setPlatformFilter] = useState<'all' | EndpointPlatform>('all');
  const [complianceFilter, setComplianceFilter] = useState<'all' | EndpointComplianceStatus>('all');

  const [showAdd, setShowAdd] = useState(false);
  const [chosenSite, setChosenSite] = useState('');
  const [name, setName] = useState('');
  const [platform, setPlatform] = useState<EndpointPlatform>('windows');
  const [managementMode, setManagementMode] = useState<EndpointManagementMode>('agent');
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

  function handlePlatformChange(next: EndpointPlatform) {
    setPlatform(next);
    setManagementMode(PLATFORM_MODES[next][0]!);
  }

  async function createEndpoint(e: React.FormEvent) {
    e.preventDefault();
    if (!activeSite || !name.trim()) return;
    setBusy('create');
    setError(null);
    try {
      const created = await api<EndpointCreated>('/endpoints', {
        method: 'POST',
        body: {
          site_id: activeSite,
          name: name.trim(),
          platform,
          management_mode: managementMode,
          device_id: deviceId,
        },
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
        {({ items }) => (
          <FleetContent
            items={items}
            platformFilter={platformFilter}
            setPlatformFilter={setPlatformFilter}
            complianceFilter={complianceFilter}
            setComplianceFilter={setComplianceFilter}
            busy={busy}
            canAdmin={can('admin')}
            onAdd={() => setShowAdd(true)}
            onReissue={reissueToken}
            onRevoke={revokeEndpoint}
          />
        )}
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
            <Field label={tx.platformLabel}>
              {(id) => (
                <Select id={id} value={platform} onChange={(e) => handlePlatformChange(e.target.value as EndpointPlatform)}>
                  <option value="windows">Windows (Desktop / Laptop / Server)</option>
                  <option value="linux">Linux (Ubuntu / Debian / RHEL / Server)</option>
                  <option value="macos">macOS (MacBook / iMac / Mac mini)</option>
                  <option value="android">Android Enterprise (Smartphone / Tablet)</option>
                  <option value="ios">Apple iOS / iPadOS (iPhone / iPad MDM)</option>
                </Select>
              )}
            </Field>
            <Field label={tx.managementModeLabel}>
              {(id) => (
                <Select id={id} value={managementMode} onChange={(e) => setManagementMode(e.target.value as EndpointManagementMode)}>
                  {PLATFORM_MODES[platform].map((m) => (
                    <option key={m} value={m}>
                      {tx.managementModes[m]}
                    </option>
                  ))}
                </Select>
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

            {(issued.endpoint.platform === 'windows' ||
              issued.endpoint.platform === 'linux' ||
              issued.endpoint.platform === 'macos') && (
              <>
                <CopyBlock
                  label={tx.installLocal}
                  multiline
                  value={`pnpm build:agent && ./agents/endpoint-agent/bin/endpoint-agent -server http://localhost:4100 -allow-insecure-http -token ${issued.enrollment_token}`}
                />
                {issued.endpoint.platform === 'windows' && (
                  <CopyBlock
                    label={tx.installWindows}
                    multiline
                    value={`endpoint-agent.exe -server http://localhost:4100 -allow-insecure-http -token ${issued.enrollment_token}`}
                  />
                )}
                {issued.endpoint.platform === 'linux' && (
                  <CopyBlock
                    label={tx.installLinux}
                    multiline
                    value={`sudo ./endpoint-agent -server https://your-lan-detective-server -token ${issued.enrollment_token}`}
                  />
                )}
                {issued.endpoint.platform === 'macos' && (
                  <CopyBlock
                    label={tx.installMacos}
                    multiline
                    value={`sudo ./endpoint-agent -server https://your-lan-detective-server -token ${issued.enrollment_token}`}
                  />
                )}
              </>
            )}

            {issued.endpoint.platform === 'android' && issued.android_provisioning && (
              <>
                <CopyBlock
                  label={tx.androidProvisioningLabel}
                  multiline
                  value={JSON.stringify(issued.android_provisioning, null, 2)}
                />
                <CopyBlock
                  label={tx.androidConnectHint}
                  multiline
                  value={`curl -X POST http://localhost:4100/api/v1/agent/mdm/connect -H "Content-Type: application/json" -d '{"enrollment_token":"${issued.enrollment_token}","os":"android","os_version":"Android 14","device_name":"${issued.endpoint.name}","manufacturer":"Samsung","model":"Galaxy Enterprise","device_owner":true,"passcode_compliant":true,"battery_pct":92}'`}
                />
              </>
            )}

            {(issued.endpoint.platform === 'ios' || issued.endpoint.management_mode === 'macos_mdm') &&
              issued.apple_mdm_profile_url && (
                <div className="space-y-3 rounded-md border border-line bg-bg/60 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs font-medium text-fg">{tx.appleMdmDownload}</span>
                    <a
                      href={`/api/v1${issued.apple_mdm_profile_url.replace(/^\/api\/v1/, '')}`}
                      download
                      className="inline-flex h-8 items-center gap-1.5 rounded-md bg-accent px-3 text-xs font-medium text-white hover:bg-accent-hover"
                    >
                      <Download className="size-3.5" aria-hidden />
                      .mobileconfig
                    </a>
                  </div>
                  <p className="text-xs text-muted">{tx.appleMdmPrereqNote}</p>
                </div>
              )}
          </div>
        </Modal>
      )}
    </>
  );
}

function FleetContent({
  items,
  platformFilter,
  setPlatformFilter,
  complianceFilter,
  setComplianceFilter,
  busy,
  canAdmin,
  onAdd,
  onReissue,
  onRevoke,
}: {
  items: EndpointSummary[];
  platformFilter: 'all' | EndpointPlatform;
  setPlatformFilter: (v: 'all' | EndpointPlatform) => void;
  complianceFilter: 'all' | EndpointComplianceStatus;
  setComplianceFilter: (v: 'all' | EndpointComplianceStatus) => void;
  busy: string;
  canAdmin: boolean;
  onAdd: () => void;
  onReissue: (id: string) => Promise<void>;
  onRevoke: (id: string) => Promise<void>;
}) {
  const { locale, t } = useI18n();
  const tx = endpointsText(locale);

  const stats = useMemo(() => {
    const online = items.filter((e) => e.status === 'active' && e.connection_state === 'online').length;
    const offline = items.length - online;
    const nonCompliant = items.filter((e) => e.compliance_status === 'non_compliant').length;
    const attention = items.filter(
      (e) =>
        e.compliance_status === 'attention' ||
        e.compliance_status === 'non_compliant' ||
        (e.status === 'active' && e.connection_state === 'offline'),
    ).length;
    const byPlatform: Record<EndpointPlatform, number> = {
      windows: 0,
      linux: 0,
      macos: 0,
      android: 0,
      ios: 0,
    };
    for (const e of items) {
      const p = e.platform ?? 'windows';
      byPlatform[p] = (byPlatform[p] ?? 0) + 1;
    }
    return { total: items.length, online, offline, nonCompliant, attention, byPlatform };
  }, [items]);

  const filtered = useMemo(() => {
    return items.filter((e) => {
      if (platformFilter !== 'all' && e.platform !== platformFilter) return false;
      if (complianceFilter !== 'all' && e.compliance_status !== complianceFilter) return false;
      return true;
    });
  }, [items, platformFilter, complianceFilter]);

  if (items.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={<Cpu className="size-8" />}
          title={tx.emptyTitle}
          action={
            canAdmin ? (
              <Button variant="primary" onClick={onAdd}>
                <Plus className="size-4" aria-hidden />
                {tx.addEndpoint}
              </Button>
            ) : undefined
          }
        >
          {tx.emptyBody}
        </EmptyState>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {/* Fleet KPI Summary Bar */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <div className="rounded-lg border border-line bg-surface p-3">
          <div className="text-xs text-muted">{tx.fleetStats.total}</div>
          <div className="mt-1 text-2xl font-semibold mono text-fg">{stats.total}</div>
        </div>
        <div className="rounded-lg border border-line bg-surface p-3">
          <div className="text-xs text-muted">{tx.fleetStats.online}</div>
          <div className="mt-1 text-2xl font-semibold mono text-ok">{stats.online}</div>
        </div>
        <div className="rounded-lg border border-line bg-surface p-3">
          <div className="text-xs text-muted">{tx.fleetStats.offline}</div>
          <div className="mt-1 text-2xl font-semibold mono text-muted">{stats.offline}</div>
        </div>
        <div className="rounded-lg border border-line bg-surface p-3">
          <div className="text-xs text-muted">{tx.fleetStats.attention}</div>
          <div className={clsx('mt-1 text-2xl font-semibold mono', stats.attention > 0 ? 'text-warn' : 'text-fg')}>
            {stats.attention}
          </div>
        </div>
        <div className="rounded-lg border border-line bg-surface p-3">
          <div className="text-xs text-muted">{tx.fleetStats.nonCompliant}</div>
          <div className={clsx('mt-1 text-2xl font-semibold mono', stats.nonCompliant > 0 ? 'text-crit' : 'text-ok')}>
            {stats.nonCompliant}
          </div>
        </div>
      </div>

      {/* Platform Breakdown & Filters */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-surface px-3 py-2.5">
        <Segmented<'all' | EndpointPlatform>
          value={platformFilter}
          label={tx.platformLabel}
          onChange={setPlatformFilter}
          options={[
            { value: 'all', label: `${t('common.all')} (${stats.total})` },
            { value: 'windows', label: `Windows (${stats.byPlatform.windows})` },
            { value: 'linux', label: `Linux (${stats.byPlatform.linux})` },
            { value: 'macos', label: `macOS (${stats.byPlatform.macos})` },
            { value: 'android', label: `Android (${stats.byPlatform.android})` },
            { value: 'ios', label: `iOS (${stats.byPlatform.ios})` },
          ]}
        />

        <Segmented<'all' | EndpointComplianceStatus>
          value={complianceFilter}
          label="Compliance"
          onChange={setComplianceFilter}
          options={[
            { value: 'all', label: t('common.all') },
            { value: 'compliant', label: tx.complianceStatus.compliant },
            { value: 'attention', label: tx.complianceStatus.attention },
            { value: 'non_compliant', label: tx.complianceStatus.non_compliant },
          ]}
        />
      </div>

      {/* Endpoint Cards */}
      <div className="grid gap-3 md:grid-cols-2">
        {filtered.map((ep) => {
          const statusLabel =
            ep.status === 'revoked'
              ? tx.revoked
              : ep.status === 'pending'
                ? tx.pending
                : ep.connection_state === 'online'
                  ? tx.online
                  : tx.offline;
          const isMobile = ep.platform === 'android' || ep.platform === 'ios';

          return (
            <Card
              key={ep.id}
              title={
                <span className="flex flex-wrap items-center gap-2">
                  {isMobile ? (
                    <Smartphone className="size-4 text-accent" aria-hidden />
                  ) : (
                    <Laptop className="size-4 text-accent" aria-hidden />
                  )}
                  <Link href={`/endpoints/${ep.id}`} className="font-semibold text-fg hover:text-accent-hover hover:underline">
                    {ep.name}
                  </Link>
                  <Badge tone="info">{tx.platforms[ep.platform] ?? ep.platform}</Badge>
                  <Badge tone={epTone(ep)}>{statusLabel}</Badge>
                  <Badge tone={complianceTone(ep.compliance_status)}>
                    {ep.compliance_status === 'compliant' ? (
                      <ShieldCheck className=" me-1 inline size-3" aria-hidden />
                    ) : (
                      <ShieldAlert className="me-1 inline size-3" aria-hidden />
                    )}
                    {tx.complianceStatus[ep.compliance_status] ?? ep.compliance_status}
                  </Badge>
                </span>
              }
              action={
                canAdmin && ep.status !== 'revoked' ? (
                  <div className="flex items-center gap-1.5">
                    {ep.status === 'pending' && (
                      <Button size="sm" busy={busy === ep.id} onClick={() => void onReissue(ep.id)}>
                        <KeyRound className="size-3.5" aria-hidden />
                        {tx.newToken}
                      </Button>
                    )}
                    <Button size="sm" variant="danger" busy={busy === ep.id} onClick={() => void onRevoke(ep.id)}>
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
                    {ep.manufacturer || ep.model ? ` · ${[ep.manufacturer, ep.model].filter(Boolean).join(' ')}` : ''}
                    {ep.os_version || ep.os ? ` · ${ep.os_version ?? ep.os}` : ''}
                  </span>
                  {ep.primary_ip && (
                    <code dir="ltr" className="mono rounded bg-raised px-1.5 py-0.5 text-fg">
                      {ep.primary_ip}
                    </code>
                  )}
                </div>

                <div className="text-[11px] text-faint">
                  {tx.managementModes[ep.management_mode] ?? ep.management_mode}
                  {ep.security_patch_level ? ` · Patch: ${ep.security_patch_level}` : ''}
                </div>

                {ep.status === 'active' && (
                  <>
                    <div className="grid grid-cols-3 gap-3 rounded-md border border-line bg-bg/60 p-2.5">
                      {isMobile && ep.battery_pct !== null ? (
                        <Meter
                          value={ep.battery_pct}
                          label={`${tx.battery}${ep.battery_charging ? ' ⚡' : ''}`}
                        />
                      ) : (
                        <Meter value={ep.cpu_pct} label={tx.cpu} />
                      )}
                      <Meter value={ep.ram_pct} label={tx.memory} />
                      <Meter value={ep.disk_used_pct} label={tx.disk} />
                    </div>

                    {ep.compliance_reasons && ep.compliance_reasons.length > 0 && (
                      <div className="rounded border border-warn/30 bg-warn/10 px-2.5 py-1.5 text-xs text-warn">
                        {ep.compliance_reasons.join(' · ')}
                      </div>
                    )}

                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                      <span className="text-muted">
                        {isMobile ? (
                          <span className="inline-flex items-center gap-1">
                            <BatteryCharging className="size-3.5 text-muted" aria-hidden />
                            {ep.serial_number ? `SN: ${ep.serial_number}` : ep.model ?? 'Mobile Device'}
                          </span>
                        ) : (
                          <>
                            {tx.loggedInUser}:{' '}
                            <span className="font-medium text-fg">
                              {ep.logged_in_users.length > 0 ? ep.logged_in_users.join(', ') : tx.noUser}
                            </span>
                          </>
                        )}
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
    </div>
  );
}
