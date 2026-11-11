'use client';

import clsx from 'clsx';
import {
  ArrowLeft,
  Download,
  ExternalLink,
  FileText,
  Lock,
  LogOut,
  MessageSquare,
  PackagePlus,
  Play,
  Power,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  Square,
  Terminal,
  Trash2,
  Wifi,
} from 'lucide-react';
import Link from 'next/link';
import { use, useMemo, useState } from 'react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type {
  CapabilityState,
  EndpointCommand,
  EndpointCommandStatus,
  EndpointDetail,
  EndpointSeriesPoint,
} from '@lan-detective/shared-types';
import { RemoteDesktopConsole } from '@/components/remote-desktop-console';
import { RemoteFileManager } from '@/components/remote-file-manager';
import {
  Async,
  Badge,
  Button,
  Card,
  ErrorNote,
  Fact,
  Field,
  Input,
  PageHeader,
  Segmented,
  Select,
  Textarea,
  type Tone,
} from '@/components/ui';
import { type ApiError, api } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { endpointsText } from '@/lib/endpoints-text';
import { clockTime, pct, relativeTime } from '@/lib/format';
import { useI18n } from '@/lib/i18n';

type Tab =
  | 'overview'
  | 'desktop'
  | 'files'
  | 'processes'
  | 'services'
  | 'connections'
  | 'software'
  | 'diagnostics'
  | 'security'
  | 'commands';

function cmdTone(status: EndpointCommandStatus): Tone {
  if (status === 'completed') return 'ok';
  if (status === 'failed' || status === 'expired') return 'crit';
  return 'info';
}

function capStateTone(state: CapabilityState): Tone {
  if (state === 'tested' || state === 'supported' || state === 'implemented') return 'ok';
  if (
    state === 'partially_supported' ||
    state === 'requires_permissions' ||
    state === 'requires_enterprise_enrollment' ||
    state === 'requires_external_config'
  ) {
    return 'warn';
  }
  if (state === 'unsupported_by_os') return 'crit';
  return 'idle';
}

function formatUptime(seconds: number | null): string {
  if (!seconds || seconds <= 0) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export default function EndpointDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { locale, t } = useI18n();
  const isAr = locale === 'ar';
  const tx = endpointsText(locale);
  const { can } = useApp();

  const query = useQuery<EndpointDetail>(`/endpoints/${id}`, ['devices'], 4_000);
  const [range, setRange] = useState<'15m' | '1h' | '24h' | '7d'>('1h');
  const seriesQuery = useQuery<{ points: EndpointSeriesPoint[] }>(`/endpoints/${id}/series?range=${range}`, ['devices'], 15_000);

  const [tab, setTab] = useState<Tab>('overview');
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState<ApiError | null>(null);

  const [procSearch, setProcSearch] = useState('');
  const [svcSearch, setSvcSearch] = useState('');
  const [svcFilter, setSvcFilter] = useState<'all' | 'running' | 'stopped'>('all');
  const [connSearch, setConnSearch] = useState('');
  const [swSearch, setSwSearch] = useState('');
  const [pkgId, setPkgId] = useState('');

  const [msgTitle, setMsgTitle] = useState('');
  const [msgBody, setMsgBody] = useState('');

  const [diagTool, setDiagTool] = useState('ipconfig');
  const [diagTarget, setDiagTarget] = useState('');
  const [diagOutput, setDiagOutput] = useState<string>('');
  const [logSource, setLogSource] = useState<'system' | 'application' | 'security'>('system');
  const [logOutput, setLogOutput] = useState<string>('');

  async function sendCommand(
    key: string,
    body: Record<string, unknown>,
    successNotice?: string,
    waitMs = 0,
  ): Promise<EndpointCommand | null> {
    setBusy(key);
    setError(null);
    setNotice('');
    try {
      const url = waitMs > 0 ? `/endpoints/${id}/commands?wait_ms=${waitMs}` : `/endpoints/${id}/commands`;
      const cmd = await api<EndpointCommand>(url, { method: 'POST', body });
      if (successNotice) setNotice(successNotice);
      query.reload();
      return cmd;
    } catch (err) {
      setError(err as ApiError);
      return null;
    } finally {
      setBusy('');
    }
  }

  return (
    <>
      <Link href="/endpoints" className="mb-3 inline-flex items-center gap-1.5 text-xs text-muted hover:text-fg">
        <ArrowLeft className="size-3.5 rtl:-scale-x-100" aria-hidden />
        {tx.back}
      </Link>

      <Async query={query}>
        {(ep) => {
          const online = ep.status === 'active' && ep.connection_state === 'online';
          const statusLabel =
            ep.status === 'revoked' ? tx.revoked : ep.status === 'pending' ? tx.pending : online ? tx.online : tx.offline;
          const tone: Tone = ep.status === 'revoked' ? 'crit' : ep.status === 'pending' ? 'warn' : online ? 'ok' : 'crit';
          const isMobile = ep.platform === 'android' || ep.platform === 'ios';

          const capEnabled = (key: string) => ep.capabilities?.find((c) => c.key === key)?.enabled ?? false;

          const availableTabs: { value: Tab; label: string }[] = [
            { value: 'overview', label: tx.tabs.overview },
            ...(capEnabled('remote_desktop') ? [{ value: 'desktop' as Tab, label: tx.tabs.desktop }] : []),
            ...(capEnabled('remote_file_manager') ? [{ value: 'files' as Tab, label: tx.tabs.files }] : []),
            ...(capEnabled('processes_control')
              ? [{ value: 'processes' as Tab, label: `${tx.tabs.processes} (${ep.processes.length})` }]
              : []),
            ...(capEnabled('services_control')
              ? [{ value: 'services' as Tab, label: `${tx.tabs.services} (${ep.services.length})` }]
              : []),
            ...(capEnabled('network_connections')
              ? [{ value: 'connections' as Tab, label: `${tx.tabs.connections} (${ep.connections.length})` }]
              : []),
            { value: 'software', label: `${tx.tabs.software} (${ep.software.length})` },
            ...(capEnabled('diagnostics_logs') ? [{ value: 'diagnostics' as Tab, label: tx.tabs.diagnostics }] : []),
            { value: 'security', label: tx.tabs.security },
            { value: 'commands', label: `${tx.tabs.commands} (${ep.commands.length})` },
          ];

          return (
            <>
              <PageHeader
                title={ep.name}
                description={`${ep.site_name} · ${tx.platforms[ep.platform] ?? ep.platform} (${tx.managementModes[ep.management_mode] ?? ep.management_mode})${ep.hostname ? ` · ${ep.hostname}` : ''}`}
                actions={
                  <>
                    <Badge tone={tone}>{statusLabel}</Badge>
                    <Badge
                      tone={
                        ep.compliance_status === 'compliant'
                          ? 'ok'
                          : ep.compliance_status === 'non_compliant'
                            ? 'crit'
                            : 'warn'
                      }
                    >
                      {ep.compliance_status === 'compliant' ? (
                        <ShieldCheck className="me-1 inline size-3" aria-hidden />
                      ) : (
                        <ShieldAlert className="me-1 inline size-3" aria-hidden />
                      )}
                      {tx.complianceStatus[ep.compliance_status] ?? ep.compliance_status}
                    </Badge>
                    {ep.device_id && (
                      <Link
                        href={`/devices/${ep.device_id}`}
                        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line-strong bg-raised px-3 text-xs font-medium text-fg hover:bg-line"
                      >
                        {tx.openDevice}
                        <ExternalLink className="size-3.5" aria-hidden />
                      </Link>
                    )}
                    {can('technician') && (
                      <Button
                        size="sm"
                        busy={busy === 'refresh'}
                        disabled={!online}
                        onClick={() => void sendCommand('refresh', { kind: 'refresh_inventory' }, tx.refreshQueued)}
                      >
                        <RefreshCw className="size-3.5" aria-hidden />
                        {tx.refreshNow}
                      </Button>
                    )}
                  </>
                }
              />

              {error && (
                <div className="mb-4">
                  <ErrorNote error={error} />
                </div>
              )}
              {notice && (
                <p role="status" className="mb-4 rounded-md border border-accent/30 bg-accent/10 px-3 py-2 text-[13px]">
                  {notice}
                </p>
              )}

              {/* Up to a dozen tabs: they scroll sideways inside this strip instead of widening the page. */}
              <div className="mb-4 max-w-full overflow-x-auto pb-1">
                <Segmented<Tab> value={tab} label={tx.title} onChange={setTab} options={availableTabs} />
              </div>

              {tab === 'overview' && (
                <div className="grid gap-4 xl:grid-cols-[1.4fr_1fr]">
                  <div className="space-y-4">
                    <Card title={tx.hardwareTitle}>
                      <dl>
                        <Fact label={tx.hostname}>
                          <span className="mono">{ep.hostname ?? '—'}</span>
                        </Fact>
                        <Fact label={tx.platformLabel}>
                          <Badge tone="info">{tx.platforms[ep.platform] ?? ep.platform}</Badge>{' '}
                          <span className="text-xs text-muted">{tx.managementModes[ep.management_mode]}</span>
                        </Fact>
                        {(ep.manufacturer || ep.model) && (
                          <Fact label={tx.manufacturerModel}>
                            {[ep.manufacturer, ep.model].filter(Boolean).join(' · ')}
                          </Fact>
                        )}
                        {ep.serial_number && (
                          <Fact label={tx.serialNumber}>
                            <span className="mono">{ep.serial_number}</span>
                          </Fact>
                        )}
                        <Fact label={tx.os}>{ep.os_version ?? ep.os ?? '—'}</Fact>
                        {(ep.security_patch_level || ep.security?.os_build) && (
                          <Fact label={tx.securityPatch}>
                            <span className="mono">{ep.security_patch_level ?? ep.security?.os_build}</span>
                          </Fact>
                        )}
                        <Fact label={tx.arch}>
                          <span className="mono">{ep.arch ?? '—'}</span>
                        </Fact>
                        {!isMobile && (
                          <>
                            <Fact label={tx.cpuModel}>
                              {ep.cpu_model ?? '—'} {ep.cpu_cores ? `(${ep.cpu_cores} ${tx.cores})` : ''}
                            </Fact>
                            <Fact label={tx.totalRam}>
                              {ep.ram_total_mb
                                ? `${(ep.ram_total_mb / 1024).toFixed(1)} GB (${ep.ram_used_mb ?? 0} MB used · ${pct(ep.ram_pct, 0)})`
                                : '—'}
                            </Fact>
                            <Fact label={tx.loggedInUser}>
                              {ep.logged_in_users.length > 0 ? (
                                <span className="font-medium text-fg">{ep.logged_in_users.join(', ')}</span>
                              ) : (
                                <span className="text-muted">{tx.noUser}</span>
                              )}
                            </Fact>
                          </>
                        )}
                        {ep.battery_pct !== null && (
                          <Fact label={tx.battery}>
                            <span className="mono">
                              {pct(ep.battery_pct, 0)} {ep.battery_charging ? '(Charging ⚡)' : ''}
                            </span>
                          </Fact>
                        )}
                        <Fact label="IP / MAC">
                          <span dir="ltr" className="mono">
                            {ep.primary_ip ?? '—'} {ep.primary_mac ? `· ${ep.primary_mac}` : ''}
                          </span>
                        </Fact>
                        <Fact label={tx.uptime}>{formatUptime(ep.uptime_seconds)}</Fact>
                        <Fact label={tx.lastCheckIn}>{relativeTime(ep.last_heartbeat_at, locale)}</Fact>
                        <Fact label={tx.agentVersion}>
                          <span className="mono">{ep.agent_version ?? '—'}</span>
                        </Fact>
                      </dl>
                    </Card>

                    <Card title={tx.disksTitle}>
                      {ep.disks.length === 0 ? (
                        <p className="text-[13px] text-muted">{tx.noInventoryYet}</p>
                      ) : (
                        <div className="space-y-3">
                          {ep.disks.map((d) => {
                            const barColor = d.used_pct >= 90 ? 'bg-crit' : d.used_pct >= 75 ? 'bg-warn' : 'bg-ok';
                            const freeGb = d.free_gb ?? Math.max(0, d.total_gb - d.used_gb);
                            return (
                              <div key={d.mount} className="rounded-md border border-line bg-bg/50 p-3">
                                <div className="mb-1.5 flex items-center justify-between text-xs">
                                  <span dir="ltr" className="mono font-medium text-fg">
                                    {d.mount} {d.filesystem ? `(${d.filesystem})` : ''}
                                  </span>
                                  <span className="text-muted">
                                    {freeGb.toFixed(1)} GB {tx.free} {d.total_gb.toFixed(1)} GB ·{' '}
                                    <strong className="text-fg">{pct(d.used_pct, 0)}</strong>
                                  </span>
                                </div>
                                <div className="h-2 overflow-hidden rounded-full bg-bg">
                                  <div
                                    className={clsx('h-full rounded-full', barColor)}
                                    style={{ width: `${Math.min(100, Math.max(2, d.used_pct))}%` }}
                                  />
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </Card>

                    {!isMobile && (
                      <Card
                        title={tx.historyTitle}
                        action={
                          <Segmented
                            value={range}
                            label={t('monitoring.range')}
                            onChange={setRange}
                            options={[
                              { value: '15m', label: '15m' },
                              { value: '1h', label: '1h' },
                              { value: '24h', label: '24h' },
                              { value: '7d', label: '7d' },
                            ]}
                          />
                        }
                      >
                        <Async query={seriesQuery}>
                          {({ points }) =>
                            points.length === 0 ? (
                              <p className="py-6 text-center text-[13px] text-muted">{t('common.noData')}</p>
                            ) : (
                              <div className="h-52 w-full" dir="ltr">
                                <ResponsiveContainer width="100%" height="100%">
                                  <LineChart data={points}>
                                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                                    <XAxis
                                      dataKey="ts"
                                      tickFormatter={(v: string) => clockTime(v, locale, range === '7d')}
                                      stroke="#71717a"
                                      fontSize={11}
                                    />
                                    <YAxis domain={[0, 100]} unit="%" stroke="#71717a" fontSize={11} width={40} />
                                    <Tooltip
                                      contentStyle={{ backgroundColor: '#14171f', borderColor: '#272b38', fontSize: 12 }}
                                      labelFormatter={(v) => clockTime(String(v), locale, true)}
                                    />
                                    <Line type="monotone" dataKey="cpu_pct" name={tx.cpu} stroke="#38bdf8" strokeWidth={2} dot={false} />
                                    <Line type="monotone" dataKey="ram_pct" name={tx.memory} stroke="#a78bfa" strokeWidth={2} dot={false} />
                                  </LineChart>
                                </ResponsiveContainer>
                              </div>
                            )
                          }
                        </Async>
                      </Card>
                    )}
                  </div>

                  <div className="space-y-4">
                    {!isMobile ? (
                      <Card title={tx.powerTitle}>
                        {!can('technician') ? (
                          <p className="text-[13px] text-muted">{t('common.readOnly')}</p>
                        ) : (
                          <div className="grid gap-2 sm:grid-cols-2">
                            <Button
                              disabled={!online}
                              busy={busy === 'power-lock'}
                              onClick={() =>
                                window.confirm(tx.powerConfirm.lock) &&
                                void sendCommand('power-lock', { kind: 'power_action', action: 'lock' })
                              }
                            >
                              <Lock className="size-4" aria-hidden />
                              {tx.powerActions.lock}
                            </Button>
                            {ep.platform === 'windows' && (
                              <Button
                                disabled={!online}
                                busy={busy === 'power-logoff'}
                                onClick={() =>
                                  window.confirm(tx.powerConfirm.logoff) &&
                                  void sendCommand('power-logoff', { kind: 'power_action', action: 'logoff' })
                                }
                              >
                                <LogOut className="size-4" aria-hidden />
                                {tx.powerActions.logoff}
                              </Button>
                            )}
                            {can('admin') && (
                              <>
                                <Button
                                  variant="danger"
                                  disabled={!online}
                                  busy={busy === 'power-restart'}
                                  onClick={() =>
                                    window.confirm(tx.powerConfirm.restart) &&
                                    void sendCommand('power-restart', { kind: 'power_action', action: 'restart' })
                                  }
                                >
                                  <RotateCcw className="size-4" aria-hidden />
                                  {tx.powerActions.restart}
                                </Button>
                                <Button
                                  variant="danger"
                                  disabled={!online}
                                  busy={busy === 'power-shutdown'}
                                  onClick={() =>
                                    window.confirm(tx.powerConfirm.shutdown) &&
                                    void sendCommand('power-shutdown', { kind: 'power_action', action: 'shutdown' })
                                  }
                                >
                                  <Power className="size-4" aria-hidden />
                                  {tx.powerActions.shutdown}
                                </Button>
                              </>
                            )}
                          </div>
                        )}
                      </Card>
                    ) : (
                      <Card title={tx.mobileActionsTitle}>
                        {!can('technician') ? (
                          <p className="text-[13px] text-muted">{t('common.readOnly')}</p>
                        ) : (
                          <div className="grid gap-2 sm:grid-cols-2">
                            <Button
                              disabled={!online}
                              busy={busy === 'mob-lock'}
                              onClick={() => void sendCommand('mob-lock', { kind: 'mobile_action', action: 'lock_device' })}
                            >
                              <Lock className="size-4" aria-hidden />
                              {tx.mobileLock}
                            </Button>
                            <Button
                              disabled={
                                !online ||
                                (ep.platform === 'ios' && ep.management_mode !== 'ios_supervised_mdm' && !ep.security?.supervised)
                              }
                              busy={busy === 'mob-reboot'}
                              onClick={() => void sendCommand('mob-reboot', { kind: 'mobile_action', action: 'reboot_device' })}
                            >
                              <RotateCcw className="size-4" aria-hidden />
                              {tx.mobileReboot}
                            </Button>
                            <Button
                              disabled={
                                !online ||
                                (ep.platform === 'ios' && ep.management_mode !== 'ios_supervised_mdm' && !ep.security?.supervised)
                              }
                              busy={busy === 'mob-lost'}
                              onClick={() => {
                                const msg = window.prompt(
                                  isAr ? 'رسالة شاشة القفل لوضع الفقدان:' : 'Lost Mode lock-screen message:',
                                  'This corporate device is lost. Please return to IT Support.',
                                );
                                if (!msg) return;
                                void sendCommand('mob-lost', {
                                  kind: 'mobile_action',
                                  action: 'enable_lost_mode',
                                  lost_message: msg,
                                });
                              }}
                            >
                              <ShieldAlert className="size-4" aria-hidden />
                              {tx.mobileLostModeEnable}
                            </Button>
                            <Button
                              disabled={!online}
                              busy={busy === 'mob-wifi'}
                              onClick={() => void sendCommand('mob-wifi', { kind: 'mobile_action', action: 'push_wifi_profile' })}
                            >
                              <Wifi className="size-4" aria-hidden />
                              {tx.mobilePushWifi}
                            </Button>
                            {can('admin') && (
                              <Button
                                variant="danger"
                                className="sm:col-span-2"
                                disabled={!online}
                                busy={busy === 'mob-wipe'}
                                onClick={() => {
                                  if (!window.confirm(tx.mobileWipeConfirm)) return;
                                  void sendCommand('mob-wipe', {
                                    kind: 'mobile_action',
                                    action: 'enterprise_wipe',
                                    confirm_destructive: true,
                                  });
                                }}
                              >
                                <Trash2 className="size-4" aria-hidden />
                                {tx.mobileWipe}
                              </Button>
                            )}
                          </div>
                        )}
                      </Card>
                    )}

                    <Card title={tx.messageTitle}>
                      {!can('technician') ? (
                        <p className="text-[13px] text-muted">{t('common.readOnly')}</p>
                      ) : (
                        <form
                          onSubmit={(e) => {
                            e.preventDefault();
                            if (!msgBody.trim()) return;
                            void sendCommand(
                              'notify',
                              {
                                kind: 'notify_user',
                                title: msgTitle.trim() || tx.messageSubjectPlaceholder,
                                message: msgBody.trim(),
                              },
                              tx.messageQueued,
                            ).then(() => setMsgBody(''));
                          }}
                          className="space-y-3"
                        >
                          <Field label={tx.messageSubject}>
                            {(fid) => (
                              <Input
                                id={fid}
                                value={msgTitle}
                                onChange={(e) => setMsgTitle(e.target.value)}
                                placeholder={tx.messageSubjectPlaceholder}
                                maxLength={120}
                              />
                            )}
                          </Field>
                          <Field label={tx.messageBody}>
                            {(fid) => (
                              <Textarea
                                id={fid}
                                value={msgBody}
                                onChange={(e) => setMsgBody(e.target.value)}
                                placeholder={tx.messageBodyPlaceholder}
                                maxLength={600}
                                rows={3}
                                required
                              />
                            )}
                          </Field>
                          <Button
                            type="submit"
                            variant="primary"
                            disabled={!online || !msgBody.trim()}
                            busy={busy === 'notify'}
                          >
                            <MessageSquare className="size-4" aria-hidden />
                            {tx.sendMessage}
                          </Button>
                        </form>
                      )}
                    </Card>
                  </div>
                </div>
              )}

              {tab === 'desktop' && (
                <RemoteDesktopConsole
                  ep={ep}
                  online={online}
                  canControl={can('technician')}
                  onReload={query.reload}
                />
              )}

              {tab === 'files' && (
                <RemoteFileManager
                  ep={ep}
                  online={online}
                  canWrite={can('technician')}
                  canDelete={can('admin')}
                />
              )}

              {tab === 'processes' && (
                <ProcessesTab
                  ep={ep}
                  online={online}
                  canControl={can('technician')}
                  search={procSearch}
                  setSearch={setProcSearch}
                  busy={busy}
                  onKill={(pid, name) => {
                    if (!window.confirm(`${tx.killConfirm} ${name} (PID ${pid})?`)) return;
                    void sendCommand(`kill-${pid}`, { kind: 'kill_process', pid, name });
                  }}
                />
              )}

              {tab === 'services' && (
                <ServicesTab
                  ep={ep}
                  online={online}
                  canControl={can('technician')}
                  search={svcSearch}
                  setSearch={setSvcSearch}
                  filter={svcFilter}
                  setFilter={setSvcFilter}
                  busy={busy}
                  onServiceAction={(service, action) =>
                    void sendCommand(`svc-${service}-${action}`, { kind: 'service_action', service, action })
                  }
                />
              )}

              {tab === 'connections' && (
                <ConnectionsTab ep={ep} search={connSearch} setSearch={setConnSearch} />
              )}

              {tab === 'software' && (
                <SoftwareTab
                  ep={ep}
                  online={online}
                  canAdmin={can('admin')}
                  search={swSearch}
                  setSearch={setSwSearch}
                  pkgId={pkgId}
                  setPkgId={setPkgId}
                  busy={busy}
                  onSoftwareAction={(action, packageId) => {
                    if (isMobile) {
                      void sendCommand(`sw-${action}`, {
                        kind: 'mobile_action',
                        action: action === 'uninstall' ? 'remove_managed_app' : 'install_managed_app',
                        app_identifier: packageId,
                      });
                    } else {
                      void sendCommand(`sw-${action}`, {
                        kind: 'software_action',
                        action,
                        package_id: packageId,
                      });
                    }
                  }}
                />
              )}

              {tab === 'diagnostics' && (
                <div className="grid gap-4 lg:grid-cols-2">
                  <Card title={isAr ? 'طرفية التشخيص المعتمدة (Authorized Diagnostic Terminal)' : 'Authorized Diagnostic Terminal'}>
                    <div className="space-y-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <Select value={diagTool} onChange={(e) => setDiagTool(e.target.value)}>
                          <option value="ipconfig">ipconfig / ifconfig / ip addr</option>
                          <option value="route">route print / ip route</option>
                          <option value="arp">arp -a</option>
                          <option value="netstat">netstat -ano</option>
                          <option value="nslookup">nslookup</option>
                          <option value="whoami">whoami / id</option>
                          <option value="systeminfo">systeminfo / uname -a</option>
                          <option value="df">df -h / Get-PSDrive</option>
                          <option value="uptime">uptime</option>
                          {ep.platform === 'windows' && <option value="gpresult">gpresult /r</option>}
                        </Select>
                        {diagTool === 'nslookup' && (
                          <Input
                            dir="ltr"
                            className="mono w-48"
                            value={diagTarget}
                            onChange={(e) => setDiagTarget(e.target.value)}
                            placeholder="example.com"
                          />
                        )}
                        <Button
                          variant="primary"
                          disabled={!online || !can('technician')}
                          busy={busy === 'diag'}
                          onClick={async () => {
                            const res = await sendCommand(
                              'diag',
                              {
                                kind: 'diagnostic_command',
                                tool: diagTool,
                                ...(diagTool === 'nslookup' && diagTarget.trim() ? { target: diagTarget.trim() } : {}),
                              },
                              undefined,
                              5000,
                            );
                            if (res?.output) setDiagOutput(res.output);
                          }}
                        >
                          <Terminal className="size-4" aria-hidden />
                          {isAr ? 'تنفيذ الفحص' : 'Run Diagnostic'}
                        </Button>
                      </div>
                      <pre
                        dir="ltr"
                        className="mono max-h-96 min-h-48 overflow-auto rounded-md border border-line bg-black/80 p-3 text-xs text-emerald-300"
                      >
                        {diagOutput || (isAr ? '// اختر أداة تشخيص واضغط تنفيذ الفحص…' : '// Select an approved diagnostic tool and click Run…')}
                      </pre>
                    </div>
                  </Card>

                  <Card title={isAr ? 'سجلات أحداث النظام البعيد (System & Event Logs)' : 'Remote System & Event Logs'}>
                    <div className="space-y-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <Select
                          value={logSource}
                          onChange={(e) => setLogSource(e.target.value as 'system' | 'application' | 'security')}
                        >
                          <option value="system">System / Journald</option>
                          <option value="application">Application Logs</option>
                          <option value="security">Security / Auth Logs</option>
                        </Select>
                        <Button
                          variant="primary"
                          disabled={!online || !can('technician')}
                          busy={busy === 'logs'}
                          onClick={async () => {
                            const res = await sendCommand(
                              'logs',
                              { kind: 'fetch_logs', source: logSource, lines: 50 },
                              undefined,
                              5000,
                            );
                            if (res?.output) setLogOutput(res.output);
                          }}
                        >
                          <FileText className="size-4" aria-hidden />
                          {isAr ? 'جلب السجلات' : 'Fetch Logs'}
                        </Button>
                      </div>
                      <pre
                        dir="ltr"
                        className="mono max-h-96 min-h-48 overflow-auto rounded-md border border-line bg-black/80 p-3 text-xs text-sky-200"
                      >
                        {logOutput || (isAr ? '// اضغط جلب السجلات لقراءة أحدث أحداث النظام…' : '// Click Fetch Logs to retrieve recent system events…')}
                      </pre>
                    </div>
                  </Card>
                </div>
              )}

              {tab === 'security' && (
                <SecurityAndCapabilitiesTab ep={ep} canAdmin={can('admin')} onReload={query.reload} />
              )}

              {tab === 'commands' && (
                <Card title={tx.tabs.commands} padded={false}>
                  {ep.commands.length === 0 ? (
                    <p className="p-6 text-center text-[13px] text-muted">{tx.noCommands}</p>
                  ) : (
                    <ul className="divide-y divide-line">
                      {ep.commands.map((c) => (
                        <li key={c.id} className="space-y-1.5 px-4 py-3">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="flex items-center gap-2 text-[13px] font-medium text-fg">
                              {tx.commandKind[c.kind] ?? c.kind}
                              <Badge tone={cmdTone(c.status)}>{tx.commandStatus[c.status]}</Badge>
                            </span>
                            <span className="text-xs text-muted">
                              {c.created_by_name ? `${tx.requestedBy} ${c.created_by_name} · ` : ''}
                              {relativeTime(c.created_at, locale)}
                            </span>
                          </div>
                          {Object.keys(c.payload).length > 0 && (
                            <code dir="ltr" className="mono block text-xs text-muted">
                              {JSON.stringify(c.payload)}
                            </code>
                          )}
                          {c.output && (
                            <p dir="ltr" className="mono max-h-40 overflow-auto rounded bg-raised px-2.5 py-1.5 text-xs text-ok">
                              {c.output}
                            </p>
                          )}
                          {c.error && (
                            <p dir="ltr" className="mono rounded bg-crit/10 px-2.5 py-1.5 text-xs text-crit">
                              {c.error}
                            </p>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
              )}
            </>
          );
        }}
      </Async>
    </>
  );
}

function SecurityAndCapabilitiesTab({
  ep,
  canAdmin,
  onReload,
}: {
  ep: EndpointDetail;
  canAdmin: boolean;
  onReload: () => void;
}) {
  const { locale } = useI18n();
  const isAr = locale === 'ar';
  const tx = endpointsText(locale);

  const [rootsText, setRootsText] = useState((ep.policy?.allowed_fs_roots ?? []).join(', '));
  const [rdConsent, setRdConsent] = useState<'unattended' | 'prompt'>(ep.policy?.remote_desktop_consent ?? 'unattended');
  const [passcodeReq, setPasscodeReq] = useState<boolean>(ep.policy?.passcode_required ?? true);
  const [cameraDisabled, setCameraDisabled] = useState<boolean>(ep.policy?.camera_disabled ?? false);
  const [wifiSsid, setWifiSsid] = useState<string>(ep.policy?.wifi_ssid ?? '');
  const [vpnServer, setVpnServer] = useState<string>(ep.policy?.vpn_server ?? '');
  const [busy, setBusy] = useState(false);
  const [savedNotice, setSavedNotice] = useState('');

  async function savePolicy(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setSavedNotice('');
    try {
      const allowed_fs_roots = rootsText
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      await api(`/endpoints/${ep.id}/policy`, {
        method: 'PATCH',
        body: {
          allowed_fs_roots,
          remote_desktop_consent: rdConsent,
          passcode_required: passcodeReq,
          camera_disabled: cameraDisabled,
          ...(wifiSsid.trim() ? { wifi_ssid: wifiSsid.trim() } : {}),
          ...(vpnServer.trim() ? { vpn_server: vpnServer.trim() } : {}),
        },
      });
      setSavedNotice(isAr ? 'تم حفظ وتحديث سياسة الجهاز بنجاح.' : 'Endpoint management policy saved.');
      onReload();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={isAr ? 'حالة الأمان والامتثال (Security & Compliance)' : 'Security & Compliance Posture'}>
          <dl>
            <Fact label={isAr ? 'حالة الامتثال' : 'Compliance status'}>
              <Badge
                tone={
                  ep.compliance_status === 'compliant'
                    ? 'ok'
                    : ep.compliance_status === 'non_compliant'
                      ? 'crit'
                      : 'warn'
                }
              >
                {tx.complianceStatus[ep.compliance_status]}
              </Badge>
            </Fact>
            {ep.compliance_reasons.length > 0 && (
              <Fact label={isAr ? 'ملاحظات الامتثال' : 'Findings'}>
                <span className="text-warn">{ep.compliance_reasons.join(' · ')}</span>
              </Fact>
            )}
            <Fact label={isAr ? 'جدار الحماية (Firewall)' : 'Host Firewall'}>
              {ep.security?.firewall_enabled === true ? (
                <Badge tone="ok">{isAr ? 'مفعّل' : 'Enabled'}</Badge>
              ) : ep.security?.firewall_enabled === false ? (
                <Badge tone="warn">{isAr ? 'متوقف' : 'Disabled'}</Badge>
              ) : (
                '—'
              )}
            </Fact>
            <Fact label={isAr ? 'مكافح الفيروسات (Antivirus / XProtect)' : 'Antivirus / Endpoint Protection'}>
              {ep.security?.antivirus_enabled === true ? (
                <Badge tone="ok">{isAr ? 'مفعّل' : 'Active'}</Badge>
              ) : ep.security?.antivirus_enabled === false ? (
                <Badge tone="crit">{isAr ? 'معطّل' : 'Disabled'}</Badge>
              ) : (
                '—'
              )}
            </Fact>
            <Fact label={isAr ? 'تشفير القرص (BitLocker / FileVault / FBE)' : 'Storage Encryption'}>
              {ep.security?.disk_encrypted === true ? (
                <Badge tone="ok">{isAr ? 'مشفّر' : 'Encrypted'}</Badge>
              ) : (
                '—'
              )}
            </Fact>
            <Fact label={isAr ? 'آخر تحديث أمني' : 'Last OS / Security Patch'}>
              <span className="mono">{ep.security?.last_update_date ?? ep.security_patch_level ?? '—'}</span>
            </Fact>
            {(ep.platform === 'ios' || ep.platform === 'macos') && (
              <Fact label="Apple MDM Profile">
                <a
                  href={`/api/v1/endpoints/${ep.id}/apple-profile.mobileconfig`}
                  download
                  className="inline-flex items-center gap-1 text-xs font-medium text-accent-hover hover:underline"
                >
                  <Download className="size-3.5" aria-hidden />
                  {tx.appleMdmDownload}
                </a>
              </Fact>
            )}
          </dl>
        </Card>

        <Card title={isAr ? 'سياسات إدارة الجهاز (Management Policy)' : 'Endpoint Management & Governance Policy'}>
          <form onSubmit={savePolicy} className="space-y-3">
            <Field label={isAr ? 'تقييد مجلدات مدير الملفات (مفصولة بفاصلة)' : 'Allowed File Manager Roots (comma-separated, empty = full authorized access)'}>
              {(fid) => (
                <Input
                  id={fid}
                  dir="ltr"
                  className="mono"
                  disabled={!canAdmin}
                  value={rootsText}
                  onChange={(e) => setRootsText(e.target.value)}
                  placeholder="C:\Users\Public, D:\DepartmentShares"
                />
              )}
            </Field>
            <Field label={isAr ? 'سياسة موافقة سطح المكتب البعيد' : 'Remote Desktop Access Policy'}>
              {(fid) => (
                <Select
                  id={fid}
                  disabled={!canAdmin}
                  value={rdConsent}
                  onChange={(e) => setRdConsent(e.target.value as 'unattended' | 'prompt')}
                >
                  <option value="unattended">
                    {isAr
                      ? 'بدون انتظار موافقة (يظهر إشعار على الشاشة ويُسجَّل كل شيء)'
                      : 'No approval needed (on-screen notice, every session logged)'}
                  </option>
                  <option value="prompt">
                    {isAr
                      ? 'يتطلب موافقة المستخدم (غير مدعوم في الوكيل بعد: الجلسات تُرفض)'
                      : 'Require user approval (agent cannot ask yet: sessions are refused)'}
                  </option>
                </Select>
              )}
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label={isAr ? 'شبكة Wi-Fi المُدارة (SSID)' : 'Managed Wi-Fi SSID'}>
                {(fid) => (
                  <Input
                    id={fid}
                    disabled={!canAdmin}
                    value={wifiSsid}
                    onChange={(e) => setWifiSsid(e.target.value)}
                    placeholder="Corp-Enterprise-WiFi"
                  />
                )}
              </Field>
              <Field label={isAr ? 'خادم VPN المؤسسي' : 'Managed VPN Server'}>
                {(fid) => (
                  <Input
                    id={fid}
                    dir="ltr"
                    disabled={!canAdmin}
                    value={vpnServer}
                    onChange={(e) => setVpnServer(e.target.value)}
                    placeholder="vpn.corp.example.com"
                  />
                )}
              </Field>
            </div>
            <div className="flex flex-wrap items-center gap-4 text-xs">
              <label className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  disabled={!canAdmin}
                  checked={passcodeReq}
                  onChange={(e) => setPasscodeReq(e.target.checked)}
                />
                {isAr ? 'فرض رمز قفل الشاشة' : 'Require screen passcode'}
              </label>
              <label className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  disabled={!canAdmin}
                  checked={cameraDisabled}
                  onChange={(e) => setCameraDisabled(e.target.checked)}
                />
                {isAr ? 'تعطيل الكاميرا (MDM)' : 'Disable camera (MDM restriction)'}
              </label>
            </div>
            {savedNotice && <p className="text-xs text-ok">{savedNotice}</p>}
            {canAdmin && (
              <Button type="submit" variant="primary" busy={busy}>
                {isAr ? 'حفظ وتطبيق السياسة' : 'Save & Apply Policy'}
              </Button>
            )}
          </form>
        </Card>
      </div>

      {/* Dynamic Capability Matrix */}
      <Card
        title={
          isAr
            ? `مصفوفة القدرات الديناميكية لمنصة ${tx.platforms[ep.platform]} (${tx.managementModes[ep.management_mode]})`
            : `Dynamic Capability Matrix — ${tx.platforms[ep.platform]} (${tx.managementModes[ep.management_mode]})`
        }
        padded={false}
      >
        <div className="overflow-x-auto">
          <table className="w-full text-start text-xs">
            <thead className="border-b border-line bg-raised/60 text-muted">
              <tr>
                <th className="px-4 py-2.5 text-start font-medium">{isAr ? 'القدرة / الميزة' : 'Capability'}</th>
                <th className="w-52 px-4 py-2.5 text-start font-medium">{isAr ? 'الحالة' : 'Status'}</th>
                <th className="w-28 px-4 py-2.5 text-start font-medium">{isAr ? 'متاح بالواجهة' : 'Available'}</th>
                <th className="px-4 py-2.5 text-start font-medium">
                  {isAr ? 'التفاصيل التقنية ومتطلبات نظام التشغيل' : 'Platform Technical Details & Prerequisites'}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {ep.capabilities.map((cap) => (
                <tr key={cap.key} className="hover:bg-raised/40">
                  <td className="px-4 py-2.5 font-medium text-fg">{isAr ? cap.label_ar : cap.label_en}</td>
                  <td className="px-4 py-2.5">
                    <Badge tone={capStateTone(cap.state)}>{tx.capabilityStates[cap.state] ?? cap.state}</Badge>
                  </td>
                  <td className="px-4 py-2.5">
                    {cap.enabled ? (
                      <Badge tone="ok">{isAr ? 'مفعّل' : 'Enabled'}</Badge>
                    ) : (
                      <Badge tone="idle">{isAr ? 'محجوب' : 'Disabled'}</Badge>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-muted">{isAr ? cap.reason_ar : cap.reason_en}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function ProcessesTab({
  ep,
  online,
  canControl,
  search,
  setSearch,
  busy,
  onKill,
}: {
  ep: EndpointDetail;
  online: boolean;
  canControl: boolean;
  search: string;
  setSearch: (v: string) => void;
  busy: string;
  onKill: (pid: number, name: string) => void;
}) {
  const { locale } = useI18n();
  const tx = endpointsText(locale);
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return ep.processes;
    return ep.processes.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        String(p.pid).includes(q) ||
        (p.user && p.user.toLowerCase().includes(q)),
    );
  }, [ep.processes, search]);

  return (
    <Card
      title={tx.tabs.processes}
      action={
        <div className="w-64 max-w-full">
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={tx.searchProcesses} />
        </div>
      }
      padded={false}
    >
      {ep.processes.length === 0 ? (
        <p className="p-6 text-center text-[13px] text-muted">{tx.noInventoryYet}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-start text-xs">
            <thead className="border-b border-line bg-raised/60 text-muted">
              <tr>
                <th className="w-24 px-4 py-2.5 text-start font-medium">{tx.colPid}</th>
                <th className="px-4 py-2.5 text-start font-medium">{tx.colProcess}</th>
                <th className="px-4 py-2.5 text-start font-medium">{tx.colUser}</th>
                <th className="w-28 px-4 py-2.5 text-end font-medium">{tx.colCpu}</th>
                <th className="w-32 px-4 py-2.5 text-end font-medium">{tx.colMem}</th>
                {canControl && <th className="w-32 px-4 py-2.5 text-end font-medium">{tx.colAction}</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {filtered.map((p) => (
                <tr key={p.pid} className="hover:bg-raised/40">
                  <td dir="ltr" className="mono px-4 py-2 text-muted">
                    {p.pid}
                  </td>
                  <td dir="ltr" className="mono px-4 py-2 font-medium text-fg">
                    {p.name}
                  </td>
                  <td className="px-4 py-2 text-muted">{p.user ?? '—'}</td>
                  <td dir="ltr" className="mono px-4 py-2 text-end text-muted">
                    {p.cpu_pct !== undefined ? `${p.cpu_pct.toFixed(1)}%` : '—'}
                  </td>
                  <td dir="ltr" className="mono px-4 py-2 text-end text-fg">
                    {p.mem_mb.toFixed(1)} MB
                  </td>
                  {canControl && (
                    <td className="px-4 py-2 text-end">
                      <Button
                        size="sm"
                        variant="danger"
                        disabled={!online || p.pid <= 4}
                        busy={busy === `kill-${p.pid}`}
                        onClick={() => onKill(p.pid, p.name)}
                      >
                        <Trash2 className="size-3.5" aria-hidden />
                        {tx.killProcess}
                      </Button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function ServicesTab({
  ep,
  online,
  canControl,
  search,
  setSearch,
  filter,
  setFilter,
  busy,
  onServiceAction,
}: {
  ep: EndpointDetail;
  online: boolean;
  canControl: boolean;
  search: string;
  setSearch: (v: string) => void;
  filter: 'all' | 'running' | 'stopped';
  setFilter: (v: 'all' | 'running' | 'stopped') => void;
  busy: string;
  onServiceAction: (service: string, action: 'start' | 'stop' | 'restart') => void;
}) {
  const { locale, t } = useI18n();
  const tx = endpointsText(locale);
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return ep.services.filter((s) => {
      if (filter !== 'all' && s.state !== filter) return false;
      if (!q) return true;
      return s.name.toLowerCase().includes(q) || s.display_name.toLowerCase().includes(q);
    });
  }, [ep.services, search, filter]);

  return (
    <Card
      title={tx.tabs.services}
      action={
        <div className="flex flex-wrap items-center gap-2">
          <Segmented
            value={filter}
            label={tx.colState}
            onChange={setFilter}
            options={[
              { value: 'all', label: t('common.all') },
              { value: 'running', label: tx.svcRunning },
              { value: 'stopped', label: tx.svcStopped },
            ]}
          />
          <div className="w-56 max-w-full">
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={tx.searchServices} />
          </div>
        </div>
      }
      padded={false}
    >
      {ep.services.length === 0 ? (
        <p className="p-6 text-center text-[13px] text-muted">{tx.noInventoryYet}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-start text-xs">
            <thead className="border-b border-line bg-raised/60 text-muted">
              <tr>
                <th className="px-4 py-2.5 text-start font-medium">{tx.colServiceName}</th>
                <th className="px-4 py-2.5 text-start font-medium">{tx.colDisplayName}</th>
                <th className="w-28 px-4 py-2.5 text-start font-medium">{tx.colState}</th>
                <th className="w-28 px-4 py-2.5 text-start font-medium">{tx.colStartMode}</th>
                {canControl && <th className="w-52 px-4 py-2.5 text-end font-medium">{tx.colAction}</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {filtered.map((s) => (
                <tr key={s.name} className="hover:bg-raised/40">
                  <td dir="ltr" className="mono px-4 py-2 font-medium text-fg">
                    {s.name}
                  </td>
                  <td className="px-4 py-2 text-muted">{s.display_name}</td>
                  <td className="px-4 py-2">
                    <Badge tone={s.state === 'running' ? 'ok' : 'idle'}>
                      {s.state === 'running' ? tx.svcRunning : s.state === 'stopped' ? tx.svcStopped : tx.svcOther}
                    </Badge>
                  </td>
                  <td className="px-4 py-2 text-muted">{s.start_mode ?? '—'}</td>
                  {canControl && (
                    <td className="px-4 py-2 text-end">
                      <div className="inline-flex items-center gap-1">
                        {s.state !== 'running' && (
                          <Button
                            size="sm"
                            disabled={!online}
                            busy={busy === `svc-${s.name}-start`}
                            onClick={() => onServiceAction(s.name, 'start')}
                          >
                            <Play className="size-3" aria-hidden />
                            {tx.svcStart}
                          </Button>
                        )}
                        {s.state === 'running' && (
                          <Button
                            size="sm"
                            disabled={!online}
                            busy={busy === `svc-${s.name}-stop`}
                            onClick={() => onServiceAction(s.name, 'stop')}
                          >
                            <Square className="size-3" aria-hidden />
                            {tx.svcStop}
                          </Button>
                        )}
                        <Button
                          size="sm"
                          disabled={!online}
                          busy={busy === `svc-${s.name}-restart`}
                          onClick={() => onServiceAction(s.name, 'restart')}
                        >
                          <RotateCcw className="size-3" aria-hidden />
                          {tx.svcRestart}
                        </Button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function ConnectionsTab({ ep, search, setSearch }: { ep: EndpointDetail; search: string; setSearch: (v: string) => void }) {
  const { locale } = useI18n();
  const tx = endpointsText(locale);
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return ep.connections;
    return ep.connections.filter(
      (c) =>
        c.local_address.toLowerCase().includes(q) ||
        String(c.local_port).includes(q) ||
        (c.remote_address && c.remote_address.toLowerCase().includes(q)) ||
        (c.remote_port && String(c.remote_port).includes(q)) ||
        c.state.toLowerCase().includes(q) ||
        (c.process_name && c.process_name.toLowerCase().includes(q)),
    );
  }, [ep.connections, search]);

  return (
    <Card
      title={tx.tabs.connections}
      action={
        <div className="w-64 max-w-full">
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={tx.searchConnections} />
        </div>
      }
      padded={false}
    >
      {ep.connections.length === 0 ? (
        <p className="p-6 text-center text-[13px] text-muted">{tx.noInventoryYet}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-start text-xs">
            <thead className="border-b border-line bg-raised/60 text-muted">
              <tr>
                <th className="w-20 px-4 py-2.5 text-start font-medium">{tx.colProto}</th>
                <th className="px-4 py-2.5 text-start font-medium">{tx.colLocal}</th>
                <th className="px-4 py-2.5 text-start font-medium">{tx.colRemote}</th>
                <th className="w-32 px-4 py-2.5 text-start font-medium">{tx.colConnState}</th>
                <th className="px-4 py-2.5 text-start font-medium">{tx.colProcess}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {filtered.map((c, idx) => (
                <tr key={idx} className="hover:bg-raised/40">
                  <td dir="ltr" className="mono uppercase px-4 py-2 text-muted">
                    {c.proto}
                  </td>
                  <td dir="ltr" className="mono px-4 py-2 font-medium text-fg">
                    {c.local_address}:{c.local_port}
                  </td>
                  <td dir="ltr" className="mono px-4 py-2 text-muted">
                    {c.remote_address ? `${c.remote_address}:${c.remote_port ?? 0}` : '—'}
                  </td>
                  <td dir="ltr" className="mono px-4 py-2">
                    <Badge tone={c.state === 'ESTABLISHED' ? 'ok' : 'idle'}>{c.state}</Badge>
                  </td>
                  <td dir="ltr" className="mono px-4 py-2 text-fg">
                    {c.process_name ? `${c.process_name} (${c.pid ?? ''})` : c.pid ? `PID ${c.pid}` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function SoftwareTab({
  ep,
  online,
  canAdmin,
  search,
  setSearch,
  pkgId,
  setPkgId,
  busy,
  onSoftwareAction,
}: {
  ep: EndpointDetail;
  online: boolean;
  canAdmin: boolean;
  search: string;
  setSearch: (v: string) => void;
  pkgId: string;
  setPkgId: (v: string) => void;
  busy: string;
  onSoftwareAction: (action: 'install' | 'upgrade' | 'uninstall', packageId: string) => void;
}) {
  const { locale } = useI18n();
  const tx = endpointsText(locale);
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return ep.software;
    return ep.software.filter(
      (s) => s.name.toLowerCase().includes(q) || (s.publisher && s.publisher.toLowerCase().includes(q)),
    );
  }, [ep.software, search]);

  return (
    <div className="space-y-4">
      {canAdmin && (
        <Card title={locale === 'ar' ? 'نشر وتثبيت الحزم والتطبيقات المعتمدة' : 'Approved Package & Application Deployment'}>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              dir="ltr"
              className="mono w-80 max-w-full"
              value={pkgId}
              onChange={(e) => setPkgId(e.target.value)}
              placeholder={tx.swPackagePlaceholder}
            />
            <Button
              variant="primary"
              disabled={!online || !pkgId.trim()}
              busy={busy === 'sw-install'}
              onClick={() => onSoftwareAction('install', pkgId.trim())}
            >
              <PackagePlus className="size-4" aria-hidden />
              {tx.swInstall}
            </Button>
            <Button
              disabled={!online || !pkgId.trim()}
              busy={busy === 'sw-upgrade'}
              onClick={() => onSoftwareAction('upgrade', pkgId.trim())}
            >
              {tx.swUpgrade}
            </Button>
            <Button
              variant="danger"
              disabled={!online || !pkgId.trim()}
              busy={busy === 'sw-uninstall'}
              onClick={() => onSoftwareAction('uninstall', pkgId.trim())}
            >
              {tx.swUninstall}
            </Button>
          </div>
        </Card>
      )}

      <Card
        title={tx.tabs.software}
        action={
          <div className="w-64 max-w-full">
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={tx.searchSoftware} />
          </div>
        }
        padded={false}
      >
        {ep.software.length === 0 ? (
          <p className="p-6 text-center text-[13px] text-muted">{tx.noInventoryYet}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-start text-xs">
              <thead className="border-b border-line bg-raised/60 text-muted">
                <tr>
                  <th className="px-4 py-2.5 text-start font-medium">{tx.colAppName}</th>
                  <th className="w-40 px-4 py-2.5 text-start font-medium">{tx.colVersion}</th>
                  <th className="px-4 py-2.5 text-start font-medium">{tx.colPublisher}</th>
                  <th className="w-32 px-4 py-2.5 text-start font-medium">{tx.colInstalled}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {filtered.map((s) => (
                  <tr key={s.name} className="hover:bg-raised/40">
                    <td className="px-4 py-2 font-medium text-fg">{s.name}</td>
                    <td dir="ltr" className="mono px-4 py-2 text-muted">
                      {s.version || '—'}
                    </td>
                    <td className="px-4 py-2 text-muted">{s.publisher || '—'}</td>
                    <td dir="ltr" className="mono px-4 py-2 text-faint">
                      {s.install_date || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
