'use client';

import { ArrowLeft, ExternalLink, RefreshCw, ShieldAlert, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import type { EndpointCommand, EndpointDetail, EndpointSeriesPoint } from '@nigafiy/shared-types';
import clsx from 'clsx';
import { PlatformIcon } from '@/components/device-icon';
import { Async, BUTTON_BASE, BUTTON_SIZE, BUTTON_VARIANT, Badge, Button, ErrorNote, Notice, PageHeader, SkeletonBlock, Tabs, type Tone } from '@/components/ui';
import { type ApiError, api } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { useI18n } from '@/lib/i18n';
import { Tab, SendCommand } from '../components/endpoint-detail/helpers';
import { OverviewTab } from '../components/endpoint-detail/overview-tab';
import { DiagnosticsTab } from '../components/endpoint-detail/diagnostics-tab';
import { CommandsTab } from '../components/endpoint-detail/commands-tab';
import { SecurityAndCapabilitiesTab } from '../components/endpoint-detail/security-tab';
import { ProcessesTab } from '../components/endpoint-detail/processes-tab';
import { ServicesTab } from '../components/endpoint-detail/services-tab';
import { ConnectionsTab } from '../components/endpoint-detail/connections-tab';
import { SoftwareTab } from '../components/endpoint-detail/software-tab';
import { HardwareTab } from '../components/endpoint-detail/hardware-tab';
import { RemoteFileManager } from '../components/remote-files/remote-file-manager';
import { ShellPanel } from '../components/fleet-shell/shell-panel';
import { jobsText } from '../components/fleet-jobs/jobs-text';
import { EndpointGroupPicker } from '../components/fleet-policy/group-assign';
import { RemoteDesktopConsole } from '../components/remote-desktop/remote-desktop-console';
import { reachText } from '../components/reach/reach-text';
import { endpointsText } from '../text';
import { DeviceLink } from '@/components/device-link';

export function EndpointDetailScreen({ id }: { id: string }) {
  const { locale, t } = useI18n();
  const isAr = locale === 'ar';
  const tx = endpointsText(locale);
  const { can } = useApp();

  const query = useQuery<EndpointDetail>(`/endpoints/${id}`, ['devices'], 4_000);
  const [range, setRange] = useState<'15m' | '1h' | '24h' | '7d'>('1h');
  const seriesQuery = useQuery<{ points: EndpointSeriesPoint[] }>(`/endpoints/${id}/series?range=${range}`, ['devices'], 15_000);

  // ?tab=desktop / ?tab=files: opened from a device card's Fleet action (remote desktop, files).
  // ?connect=1: connect by name, Nigafiy ID or code (Fleet, the Hub search) opens the connect dialog.
  const params = useSearchParams();
  const requested = params.get('tab');
  const autoConnect = params.get('connect') === '1';
  const rx = reachText(locale);
  const [tab, setTab] = useState<Tab>(() => (autoConnect ? 'desktop' : ((requested as Tab | null) ?? 'overview')));
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

  const sendCommand: SendCommand = async (key, body, successNotice, waitMs = 0) => {
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
  };

  return (
    <>
      <Link href="/fleet/endpoints" className="mb-4 inline-flex items-center gap-1.5 rounded text-xs font-medium text-muted hover:text-fg">
        <ArrowLeft className="size-3.5 rtl:-scale-x-100" aria-hidden />
        {tx.back}
      </Link>

      <Async query={query} skeleton={<SkeletonBlock chart lines={5} />}>
        {(ep) => {
          const online = ep.status === 'active' && ep.connection_state === 'online';
          const statusLabel =
            ep.status === 'revoked' ? tx.revoked : ep.status === 'pending' ? tx.pending : online ? tx.online : tx.offline;
          const tone: Tone = ep.status === 'revoked' ? 'crit' : ep.status === 'pending' ? 'warn' : online ? 'ok' : 'crit';

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
            { value: 'hardware', label: tx.tabs.hardware },
            ...(capEnabled('diagnostics_logs') ? [{ value: 'diagnostics' as Tab, label: tx.tabs.diagnostics }] : []),
            { value: 'security', label: tx.tabs.security },
            { value: 'commands', label: `${tx.tabs.commands} (${ep.commands.length})` },
            // Remote shell: admins only (the API refuses everyone else and audits it).
            ...(can('admin') ? [{ value: 'shell' as Tab, label: jobsText(locale).shellTitle }] : []),
          ];
          // A requested tab this endpoint does not offer (capability off, unknown name) opens the overview.
          const shown: Tab = availableTabs.some((o) => o.value === tab) ? tab : 'overview';

          return (
            <>
              <PageHeader
                icon={<PlatformIcon platform={ep.platform} className="size-[18px]" />}
                title={ep.name}
                description={`${ep.site_name} · ${tx.platforms[ep.platform] ?? ep.platform}${ep.hostname ? ` · ${ep.hostname}` : ''}${ep.nigafiy_id ? ` · ${rx.nigafiyId} ${rx.idValue(ep.nigafiy_id)}` : ''}`}
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
                      {ep.compliance_status === 'compliant' ? <ShieldCheck className="size-3" aria-hidden /> : <ShieldAlert className="size-3" aria-hidden />}
                      {tx.complianceStatus[ep.compliance_status] ?? ep.compliance_status}
                    </Badge>
                    {ep.status !== 'revoked' && <EndpointGroupPicker endpointId={ep.id} groupId={ep.fleet_group_id} groupName={ep.fleet_group_name} onChanged={query.reload} />}
                    {ep.device_id && (
                      <DeviceLink
                        id={ep.device_id}
                        className={clsx(BUTTON_BASE, BUTTON_SIZE.sm, BUTTON_VARIANT.secondary)}
                      >
                        {tx.openDevice}
                        <ExternalLink className="size-3.5" aria-hidden />
                      </DeviceLink>
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
              {notice && <Notice className="mb-4">{notice}</Notice>}

              {/* Up to a dozen tabs: they scroll sideways inside their strip instead of widening the page. */}
              <Tabs<Tab> value={shown} label={tx.title} onChange={setTab} options={availableTabs} />

              {shown === 'overview' && (
                <OverviewTab
                  ep={ep}
                  online={online}
                  busy={busy}
                  sendCommand={sendCommand}
                  range={range}
                  setRange={setRange}
                  seriesQuery={seriesQuery}
                  message={{ title: msgTitle, setTitle: setMsgTitle, body: msgBody, setBody: setMsgBody }}
                />
              )}

              {shown === 'desktop' && (
                <RemoteDesktopConsole
                  ep={ep}
                  online={online}
                  canControl={can('technician')}
                  autoConnect={autoConnect}
                  onReload={query.reload}
                />
              )}

              {shown === 'files' && (
                <RemoteFileManager
                  ep={ep}
                  online={online}
                  canWrite={can('technician')}
                  canUpload={can('admin')}
                  canDelete={can('admin')}
                />
              )}

              {shown === 'processes' && (
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

              {shown === 'services' && (
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

              {shown === 'connections' && (
                <ConnectionsTab ep={ep} search={connSearch} setSearch={setConnSearch} />
              )}

              {shown === 'software' && (
                <SoftwareTab
                  ep={ep}
                  online={online}
                  canAdmin={can('admin')}
                  search={swSearch}
                  setSearch={setSwSearch}
                  pkgId={pkgId}
                  setPkgId={setPkgId}
                  busy={busy}
                  onSoftwareAction={(action, packageId) =>
                    void sendCommand(`sw-${action}`, { kind: 'software_action', action, package_id: packageId })
                  }
                />
              )}

              {shown === 'hardware' && <HardwareTab ep={ep} locale={locale} />}

              {shown === 'diagnostics' && (
                <DiagnosticsTab
                  ep={ep}
                  online={online}
                  busy={busy}
                  sendCommand={sendCommand}
                  diag={{ tool: diagTool, setTool: setDiagTool, target: diagTarget, setTarget: setDiagTarget, output: diagOutput, setOutput: setDiagOutput }}
                  logs={{ source: logSource, setSource: setLogSource, output: logOutput, setOutput: setLogOutput }}
                />
              )}

              {shown === 'security' && (
                <SecurityAndCapabilitiesTab ep={ep} canAdmin={can('admin')} onReload={query.reload} />
              )}

              {shown === 'commands' && (
                <CommandsTab ep={ep} />
              )}

              {shown === 'shell' && <ShellPanel endpoint={{ id: ep.id, name: ep.name, online }} />}
            </>
          );
        }}
      </Async>
    </>
  );
}
