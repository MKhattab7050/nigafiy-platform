'use client';

import clsx from 'clsx';
import { ArrowLeft, ExternalLink, Lock, LogOut, MessageSquare, Play, Power, RefreshCw, RotateCcw, Square, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { use, useMemo, useState } from 'react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { EndpointCommandStatus, EndpointDetail, EndpointSeriesPoint } from '@lan-detective/shared-types';
import { Async, Badge, Button, Card, ErrorNote, Fact, Field, Input, PageHeader, Segmented, Textarea, type Tone } from '@/components/ui';
import { type ApiError, api } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { endpointsText } from '@/lib/endpoints-text';
import { clockTime, pct, relativeTime } from '@/lib/format';
import { useI18n } from '@/lib/i18n';

type Tab = 'overview' | 'processes' | 'services' | 'connections' | 'software' | 'commands';

function cmdTone(status: EndpointCommandStatus): Tone {
  if (status === 'completed') return 'ok';
  if (status === 'failed' || status === 'expired') return 'crit';
  return 'info';
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

  const [msgTitle, setMsgTitle] = useState('');
  const [msgBody, setMsgBody] = useState('');

  async function sendCommand(key: string, body: Record<string, unknown>, successNotice?: string) {
    setBusy(key);
    setError(null);
    setNotice('');
    try {
      await api(`/endpoints/${id}/commands`, { method: 'POST', body });
      if (successNotice) setNotice(successNotice);
      query.reload();
    } catch (err) {
      setError(err as ApiError);
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

          return (
            <>
              <PageHeader
                title={ep.name}
                description={`${ep.site_name}${ep.hostname ? ` · ${ep.hostname}` : ''}${ep.os_version || ep.os ? ` · ${ep.os_version ?? ep.os}` : ''}`}
                actions={
                  <>
                    <Badge tone={tone}>{statusLabel}</Badge>
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

              <div className="mb-4 flex flex-wrap items-center gap-2">
                <Segmented<Tab>
                  value={tab}
                  label={tx.title}
                  onChange={setTab}
                  options={[
                    { value: 'overview', label: tx.tabs.overview },
                    { value: 'processes', label: `${tx.tabs.processes} (${ep.processes.length})` },
                    { value: 'services', label: `${tx.tabs.services} (${ep.services.length})` },
                    { value: 'connections', label: `${tx.tabs.connections} (${ep.connections.length})` },
                    { value: 'software', label: `${tx.tabs.software} (${ep.software.length})` },
                    { value: 'commands', label: `${tx.tabs.commands} (${ep.commands.length})` },
                  ]}
                />
              </div>

              {tab === 'overview' && (
                <div className="grid gap-4 xl:grid-cols-[1.4fr_1fr]">
                  <div className="space-y-4">
                    <Card title={tx.hardwareTitle}>
                      <dl>
                        <Fact label={tx.hostname}>
                          <span className="mono">{ep.hostname ?? '—'}</span>
                        </Fact>
                        <Fact label={tx.os}>{ep.os_version ?? ep.os ?? '—'}</Fact>
                        <Fact label={tx.arch}>
                          <span className="mono">{ep.arch ?? '—'}</span>
                        </Fact>
                        <Fact label={tx.cpuModel}>
                          {ep.cpu_model ?? '—'} {ep.cpu_cores ? `(${ep.cpu_cores} ${tx.cores})` : ''}
                        </Fact>
                        <Fact label={tx.totalRam}>
                          {ep.ram_total_mb ? `${(ep.ram_total_mb / 1024).toFixed(1)} GB (${ep.ram_used_mb ?? 0} MB used · ${pct(ep.ram_pct, 0)})` : '—'}
                        </Fact>
                        <Fact label={tx.loggedInUser}>
                          {ep.logged_in_users.length > 0 ? (
                            <span className="font-medium text-fg">{ep.logged_in_users.join(', ')}</span>
                          ) : (
                            <span className="text-muted">{tx.noUser}</span>
                          )}
                        </Fact>
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
                            return (
                              <div key={d.mount} className="rounded-md border border-line bg-bg/50 p-3">
                                <div className="mb-1.5 flex items-center justify-between text-xs">
                                  <span dir="ltr" className="mono font-medium text-fg">
                                    {d.mount} {d.filesystem ? `(${d.filesystem})` : ''}
                                  </span>
                                  <span className="text-muted">
                                    {d.free_gb.toFixed(1)} GB {tx.free} {d.total_gb.toFixed(1)} GB · <strong className="text-fg">{pct(d.used_pct, 0)}</strong>
                                  </span>
                                </div>
                                <div className="h-2 overflow-hidden rounded-full bg-bg">
                                  <div className={clsx('h-full rounded-full', barColor)} style={{ width: `${Math.min(100, Math.max(2, d.used_pct))}%` }} />
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </Card>

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
                  </div>

                  <div className="space-y-4">
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
                          <Button type="submit" variant="primary" disabled={!online || !msgBody.trim()} busy={busy === 'notify'}>
                            <MessageSquare className="size-4" aria-hidden />
                            {tx.sendMessage}
                          </Button>
                        </form>
                      )}
                    </Card>
                  </div>
                </div>
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
                <SoftwareTab ep={ep} search={swSearch} setSearch={setSwSearch} />
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
                            <p dir="ltr" className="mono rounded bg-raised px-2.5 py-1.5 text-xs text-ok">
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

function SoftwareTab({ ep, search, setSearch }: { ep: EndpointDetail; search: string; setSearch: (v: string) => void }) {
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
  );
}

