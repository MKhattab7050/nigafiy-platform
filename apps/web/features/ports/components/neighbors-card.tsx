'use client';

import type { MndpListenerStatus, NeighborProtocol, NeighborsReport } from '@nigafiy/shared-types';
import { useState } from 'react';
import { DeviceLink } from '@/components/device-link';
import { Badge, Card, ErrorNote, Notice, Switch, type Tone } from '@/components/ui';
import { type ApiError, api, qs } from '@/lib/api';
import { useQuery } from '@/lib/app';
import { absoluteTime, relativeTime } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { neighborsText } from '../neighbors-text';

const PROTOCOL_TONE: Record<NeighborProtocol, Tone> = { lldp: 'info', cdp: 'info', mikrotik: 'info' };
const STATE_TONE: Record<NonNullable<MndpListenerStatus['status']>['state'], Tone> = { listening: 'ok', disabled: 'idle', bind_failed: 'warn', stopped: 'warn' };

export function ProtocolBadge({ protocol }: { protocol: NeighborProtocol | undefined }) {
  const { locale } = useI18n();
  const p = protocol ?? 'lldp';
  return (
    <Badge tone={PROTOCOL_TONE[p]} dot={false}>
      {neighborsText(locale).protocol[p]}
    </Badge>
  );
}

const cell = 'px-3 py-2 align-top';
const head = 'px-3 py-2 text-start text-xs font-medium text-muted';

/**
 * Neighbours of the site (GET /neighbors): switch neighbour tables with their protocol, MikroTik
 * MNDP announcements heard by the collectors, each collector's listener status, and the site switch
 * (PUT /neighbors/settings, admin).
 */
export function NeighborsCard({ siteId, admin }: { siteId: string; admin: boolean }) {
  const { locale } = useI18n();
  const tx = neighborsText(locale);
  const q = useQuery<NeighborsReport>(`/neighbors${qs({ site_id: siteId })}`, ['devices', 'collectors'], 30_000);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [justOff, setJustOff] = useState(false);

  async function toggle(next: boolean) {
    setBusy(true);
    setError(null);
    try {
      await api('/neighbors/settings', { method: 'PUT', body: { site_id: siteId, mndp_listen: next } });
      setJustOff(!next);
      q.reload();
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  }

  if (q.error && !q.data) return <ErrorNote error={q.error} onRetry={q.reload} />;
  const data = q.data;
  if (!data) return null;

  return (
    <Card title={tx.title} description={tx.description} padded={false}>
      <section className="border-b border-line px-4 py-3">
        <h3 className="mb-2 text-xs font-semibold text-fg">{tx.switchTable}</h3>
        {data.switch_neighbors.length === 0 ? (
          <p className="text-xs text-muted">{tx.switchEmpty}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-[13px]">
              <thead>
                <tr className="border-b border-line">
                  <th className={head}>{tx.colSwitchPort}</th>
                  <th className={head}>{tx.colNeighbor}</th>
                  <th className={head}>{tx.colRemotePort}</th>
                  <th className={head}>{tx.colAddress}</th>
                  <th className={head}>{tx.colPlatform}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {data.switch_neighbors.map((n, i) => (
                  <tr key={`${n.target_id}-${n.if_index}-${i}`}>
                    <td className={cell}>
                      <span dir="auto">{n.switch_name}</span> · <span className="mono" dir="ltr">{n.port_name}</span>
                    </td>
                    <td className={cell}>
                      <span className="me-2 inline-block">
                        <ProtocolBadge protocol={n.protocol} />
                      </span>
                      <span dir="auto">{n.sys_name ?? ''}</span>
                      {n.chassis_id && (
                        <span className="mono block text-xs text-faint" dir="ltr">
                          {n.chassis_id}
                        </span>
                      )}
                    </td>
                    <td className={`${cell} mono text-xs`} dir="ltr">
                      {n.port_id ?? '—'}
                    </td>
                    <td className={`${cell} mono text-xs`} dir="ltr">
                      {n.address ?? '—'}
                    </td>
                    <td className={`${cell} text-xs text-muted`} dir="auto">
                      {n.platform ?? '—'}
                      {n.version && <span className="block text-faint">{n.version}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="space-y-3 px-4 py-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 max-w-2xl">
            <h3 className="text-xs font-semibold text-fg">{tx.mndpTitle}</h3>
            <p className="mt-0.5 text-xs text-muted">{tx.mndpExplain}</p>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted">
            <Switch id="mndp-listen" checked={data.mndp_listen} onChange={toggle} disabled={!admin || busy} label={tx.mndpToggle} />
            <span aria-hidden>{tx.mndpToggle}</span>
          </div>
        </div>
        {!admin && <p className="text-xs text-faint">{tx.onlyAdmins}</p>}
        <ErrorNote error={error} />
        {justOff && !data.mndp_listen && <Notice>{tx.mndpOff}</Notice>}

        <ul className="space-y-1 text-xs">
          {data.listeners.length === 0 && <li className="text-muted">{tx.noCollectors}</li>}
          {data.listeners.map((l) => (
            <li key={l.collector_id} className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="font-medium" dir="auto">
                {l.collector_name}
              </span>
              {l.status ? (
                <>
                  <Badge tone={STATE_TONE[l.status.state]}>{tx.state[l.status.state]}</Badge>
                  <span className="tnum text-muted">
                    {l.status.received} {tx.received} · {l.status.out_of_scope} {tx.outOfScope}
                    {l.status.malformed > 0 && ` · ${l.status.malformed} ${tx.malformed}`}
                  </span>
                  {l.status.error && (
                    <span className="text-warn" dir="auto">
                      {l.status.error}
                    </span>
                  )}
                  {l.status.state === 'listening' && l.status.received === 0 && <span className="basis-full text-faint">{tx.firewallHint}</span>}
                </>
              ) : (
                <span className="text-faint">{tx.notReported}</span>
              )}
            </li>
          ))}
        </ul>

        {data.mndp_listen &&
          (data.mndp.length === 0 ? (
            <p className="text-xs text-muted">{tx.mndpEmpty}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-[13px]">
                <thead>
                  <tr className="border-b border-line">
                    <th className={head}>{tx.colIdentity}</th>
                    <th className={head}>{tx.colBoard}</th>
                    <th className={head}>{tx.colAddress}</th>
                    <th className={head}>{tx.colInterface}</th>
                    <th className={head}>{tx.colDevice}</th>
                    <th className={head}>{tx.colHeardBy}</th>
                    <th className={head}>{tx.colSeen}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {data.mndp.map((n) => (
                    <tr key={`${n.collector_id}-${n.mac}`}>
                      <td className={cell}>
                        <span dir="auto">{n.identity ?? '—'}</span>
                        <span className="mono block text-xs text-faint" dir="ltr">
                          {n.mac}
                        </span>
                      </td>
                      <td className={`${cell} text-xs text-muted`} dir="auto">
                        {n.board ?? n.platform ?? '—'}
                        {n.version && <span className="block text-faint">{n.version}</span>}
                      </td>
                      <td className={`${cell} mono text-xs`} dir="ltr">
                        {n.ipv4 ?? n.source_ip ?? '—'}
                        {n.ipv6 && <span className="block text-faint">{n.ipv6}</span>}
                      </td>
                      <td className={`${cell} mono text-xs`} dir="ltr">
                        {n.interface_name ?? '—'}
                      </td>
                      <td className={`${cell} text-xs`}>
                        {n.device_id ? (
                          <DeviceLink id={n.device_id} className="hover:text-accent-hover" dir="auto">
                            {n.device_label ?? n.mac}
                          </DeviceLink>
                        ) : (
                          <span className="text-faint">{tx.notInInventory}</span>
                        )}
                      </td>
                      <td className={`${cell} text-xs`} dir="auto">
                        {n.collector_name}
                      </td>
                      <td className={`${cell} whitespace-nowrap text-xs text-muted`} title={absoluteTime(n.last_seen_at, locale)}>
                        {relativeTime(n.last_seen_at, locale)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
      </section>
    </Card>
  );
}
