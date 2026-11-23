'use client';

import { Globe, Router, ShieldQuestion, Wifi } from 'lucide-react';
import type { Confidence } from '@nigafiy/shared-types';
import { Badge, DataTable, EmptyState, InferredBadge, severityTone } from '@/components/ui';
import { absoluteTime, pct, relativeTime } from '@/lib/format';
import { type Key, fill, useI18n } from '@/lib/i18n';
import type { Banner, DhcpServer, Fingerprint, SecurityOverview, UpnpGateway, WifiLinkRow } from '../types';
import { DeviceLink } from '@/components/device-link';

// The raw measurements behind the findings. Everything a device or a nearby network said about
// itself (SSIDs, page titles, UPnP descriptions, host names, server headers) is rendered as plain
// text; addresses and MACs are kept left-to-right in Arabic.

const Mono = ({ children }: { children: React.ReactNode }) => (
  <span className="mono text-xs" dir="ltr">
    {children}
  </span>
);

const When = ({ iso }: { iso: string | null }) => {
  const { locale } = useI18n();
  return <span title={absoluteTime(iso, locale)}>{relativeTime(iso, locale)}</span>;
};

export function DhcpServers({ dhcp }: { dhcp: SecurityOverview['dhcp'] }) {
  const { t, locale } = useI18n();
  const statusOf = (s: DhcpServer) =>
    s.expected ? (
      <Badge tone="ok">{t(`security.dhcp.expected.${s.expected}` as Key)}</Badge>
    ) : s.rogue_open ? (
      <Badge tone="crit">{t('security.dhcp.rogue')}</Badge>
    ) : (
      <Badge tone="idle">{t('security.dhcp.quiet')}</Badge>
    );
  return (
    <div className="space-y-2">
      {dhcp.probe && (
        <p className="px-4 pt-3 text-xs text-muted">
          {fill(t('security.dhcp.probes'), { n: dhcp.probe.probes, when: relativeTime(dhcp.probe.last_probe_at, locale) })}
          {dhcp.probe.no_offer_open && <span className="ms-2 text-warn">{fill(t('security.dhcp.noOffer'), { n: dhcp.probe.consecutive_no_offer })}</span>}
        </p>
      )}
      {dhcp.servers.length === 0 ? (
        <EmptyState icon={<Router />} title={t('security.dhcp.none')}>
          <p>{t('security.dhcp.noneHint')}</p>
        </EmptyState>
      ) : (
        <DataTable stack>
          <thead>
            <tr>
              <th>{t('security.dhcp.server')}</th>
              <th>{t('security.dhcp.status')}</th>
              <th>{t('security.dhcp.offered')}</th>
              <th>{t('security.dhcp.gateway')}</th>
              <th>{t('security.dhcp.dns')}</th>
              <th>{t('security.dhcp.clients')}</th>
              <th>{t('security.dhcp.lastOffer')}</th>
            </tr>
          </thead>
          <tbody>
            {dhcp.servers.map((s) => (
              <tr key={s.id}>
                <td data-label={t('security.dhcp.server')}>
                  <Mono>{s.server_id}</Mono>
                  {s.server_mac && (
                    <span className="block">
                      <Mono>{s.server_mac}</Mono>
                    </span>
                  )}
                  {s.domain && (
                    <span className="block text-xs text-muted" dir="auto">
                      {s.domain}
                    </span>
                  )}
                </td>
                <td data-label={t('security.dhcp.status')}>{statusOf(s)}</td>
                <td data-label={t('security.dhcp.offered')}>
                  <Mono>{s.offered_ip ?? '—'}</Mono>
                </td>
                <td data-label={t('security.dhcp.gateway')}>
                  <Mono>{s.routers.join(', ') || '—'}</Mono>
                </td>
                <td data-label={t('security.dhcp.dns')}>
                  <Mono>{s.dns_servers.join(', ') || '—'}</Mono>
                </td>
                <td data-label={t('security.dhcp.clients')} className="tnum">
                  {s.clients_choosing}
                </td>
                <td data-label={t('security.dhcp.lastOffer')}>
                  <When iso={s.last_offer_at} />
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}
    </div>
  );
}

function GatewayBlock({ g }: { g: UpnpGateway }) {
  const { t, locale } = useI18n();
  return (
    <div className="space-y-2 px-4 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-[13.5px] font-medium">
          <span dir="auto">{g.friendly_name ?? g.model ?? g.address}</span> <Mono>({g.address})</Mono>
        </p>
        <p className="text-xs text-muted">{fill(t('security.upnp.via'), { collector: g.collector_name ?? '—', when: relativeTime(g.last_seen_at, locale) })}</p>
      </div>
      <p className="text-xs text-muted">
        {[g.manufacturer, g.model].filter(Boolean).length > 0 && <span dir="auto">{[g.manufacturer, g.model].filter(Boolean).join(' · ')} · </span>}
        {t('security.upnp.external')}: <Mono>{g.external_ip ?? '—'}</Mono>
      </p>
      {g.last_error && (
        <p className="text-xs text-warn" dir="auto">
          {t('security.upnp.error')}: {g.last_error}
        </p>
      )}
      {g.mappings_truncated && <p className="text-xs text-warn">{t('security.upnp.truncated')}</p>}
      {g.mappings.length === 0 ? (
        <p className="text-[13px] text-muted">{t('security.upnp.noMappings')}</p>
      ) : (
        <DataTable stack>
          <thead>
            <tr>
              <th>{t('security.upnp.risk')}</th>
              <th>{t('security.upnp.protocol')}</th>
              <th>{t('security.upnp.extPort')}</th>
              <th>{t('security.upnp.internal')}</th>
              <th>{t('security.upnp.description')}</th>
            </tr>
          </thead>
          <tbody>
            {g.mappings.map((m) => (
              <tr key={m.id}>
                <td data-label={t('security.upnp.risk')}>
                  <Badge tone={severityTone(m.risk)}>{t(`security.sev.${m.risk}` as Key)}</Badge>
                  {m.risk_reason && (
                    <span className="mt-0.5 block text-xs text-muted" dir="auto">
                      {m.risk_reason}
                    </span>
                  )}
                </td>
                <td data-label={t('security.upnp.protocol')}>
                  <Mono>{m.protocol}</Mono>
                  {!m.enabled && <span className="ms-1 text-xs text-faint">({t('security.upnp.off')})</span>}
                </td>
                <td data-label={t('security.upnp.extPort')}>
                  <Mono>{m.external_port}</Mono>
                </td>
                <td data-label={t('security.upnp.internal')}>
                  <Mono>
                    {m.internal_client}:{m.internal_port}
                  </Mono>
                  {m.device_id && (
                    <DeviceLink id={m.device_id} className="ms-1.5 text-xs text-accent-hover hover:underline" dir="auto">
                      {m.device_name ?? ''}
                    </DeviceLink>
                  )}
                </td>
                <td data-label={t('security.upnp.description')} dir="auto" className="break-words">
                  {m.description ?? '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}
    </div>
  );
}

export function UpnpGateways({ gateways }: { gateways: UpnpGateway[] }) {
  const { t } = useI18n();
  if (gateways.length === 0)
    return (
      <EmptyState icon={<Router />} title={t('security.upnp.none')}>
        <p>{t('security.upnp.noneHint')}</p>
      </EmptyState>
    );
  return (
    <div className="divide-y divide-line">
      {gateways.map((g) => (
        <GatewayBlock key={g.id} g={g} />
      ))}
    </div>
  );
}

const ssidText = (ssid: string | null | undefined, hidden: string) => (ssid ? ssid : hidden);

function WifiBlock({ w }: { w: WifiLinkRow }) {
  const { t, locale } = useI18n();
  return (
    <div className="space-y-3 px-4 py-3">
      <p className="text-xs text-muted" dir="auto">
        {fill(t('security.wifi.measured'), { when: relativeTime(w.observed_at, locale), collector: w.collector_name })}
        {w.interface && (
          <>
            {' · '}
            <span dir="auto">{w.interface}</span>
          </>
        )}
      </p>
      {w.connected ? (
        <dl className="grid gap-x-6 gap-y-1.5 text-[13px] sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <dt className="text-xs text-muted">{t('security.wifi.ssid')}</dt>
            <dd dir="auto" className="break-words">
              {ssidText(w.ssid, t('security.wifi.hidden'))}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted">{t('security.wifi.bssid')}</dt>
            <dd>
              <Mono>{w.bssid ?? '—'}</Mono>
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted">{t('security.wifi.channel')}</dt>
            <dd>
              <Mono>
                {w.channel ?? '—'}
                {w.band ? ` (${w.band} GHz)` : ''}
              </Mono>
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted">{t('security.wifi.signal')}</dt>
            <dd>
              <Mono>{[w.signal_pct !== null ? pct(w.signal_pct, 0) : null, w.rssi_dbm !== null ? `${w.rssi_dbm} dBm` : null].filter(Boolean).join(' · ') || '—'}</Mono>
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted">{t('security.wifi.rate')}</dt>
            <dd>
              <Mono>{w.rx_mbps !== null || w.tx_mbps !== null ? `↓ ${w.rx_mbps ?? '—'} / ↑ ${w.tx_mbps ?? '—'} Mbps` : '—'}</Mono>
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted">{t('security.wifi.security')}</dt>
            <dd dir="auto">{[w.auth ?? w.security, w.cipher].filter(Boolean).join(' / ') || '—'}</dd>
          </div>
        </dl>
      ) : (
        <p className="text-[13px] text-muted">{t('security.wifi.notConnected')}</p>
      )}
      {w.networks.length > 0 && (
        <div>
          <p className="mb-1.5 text-xs font-medium text-muted">
            {t('security.wifi.nearby')} ({w.networks.length})
          </p>
          <DataTable stack>
            <thead>
              <tr>
                <th>{t('security.wifi.ssid')}</th>
                <th>{t('security.wifi.bssid')}</th>
                <th>{t('security.wifi.channel')}</th>
                <th>{t('security.wifi.signal')}</th>
                <th>{t('security.wifi.security')}</th>
              </tr>
            </thead>
            <tbody>
              {w.networks.map((n) => (
                <tr key={n.bssid}>
                  <td data-label={t('security.wifi.ssid')} dir="auto" className="break-words">
                    {ssidText(n.ssid, t('security.wifi.hidden'))}
                  </td>
                  <td data-label={t('security.wifi.bssid')}>
                    <Mono>{n.bssid}</Mono>
                  </td>
                  <td data-label={t('security.wifi.channel')}>
                    <Mono>
                      {n.channel ?? '—'}
                      {n.band ? ` (${n.band} GHz)` : ''}
                    </Mono>
                  </td>
                  <td data-label={t('security.wifi.signal')}>
                    <Mono>{[n.signal_pct !== null ? pct(n.signal_pct, 0) : null, n.rssi_dbm !== null ? `${n.rssi_dbm} dBm` : null].filter(Boolean).join(' · ') || '—'}</Mono>
                  </td>
                  <td data-label={t('security.wifi.security')} dir="auto">
                    {[n.auth ?? n.security, n.cipher].filter(Boolean).join(' / ') || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        </div>
      )}
    </div>
  );
}

export function WifiLinks({ wifi }: { wifi: WifiLinkRow[] }) {
  const { t } = useI18n();
  if (wifi.length === 0)
    return (
      <EmptyState icon={<Wifi />} title={t('security.wifi.none')}>
        <p>{t('security.wifi.noneHint')}</p>
      </EmptyState>
    );
  return (
    <div className="divide-y divide-line">
      {wifi.map((w) => (
        <WifiBlock key={w.collector_id} w={w} />
      ))}
    </div>
  );
}

export function Banners({ banners }: { banners: Banner[] }) {
  const { t } = useI18n();
  if (banners.length === 0)
    return (
      <EmptyState icon={<Globe />} title={t('security.banners.none')}>
        <p>{t('security.banners.noneHint')}</p>
      </EmptyState>
    );
  return (
    <DataTable stack>
      <thead>
        <tr>
          <th>{t('security.f.device')}</th>
          <th>{t('security.banners.address')}</th>
          <th>{t('security.banners.status')}</th>
          <th>{t('security.banners.title')}</th>
          <th>{t('security.banners.server')}</th>
          <th>{t('security.banners.tls')}</th>
          <th>{t('security.banners.probed')}</th>
        </tr>
      </thead>
      <tbody>
        {banners.map((b) => (
          <tr key={`${b.device_id}-${b.ip}-${b.port}`}>
            <td data-label={t('security.f.device')}>
              <DeviceLink id={b.device_id} className="text-accent-hover hover:underline" dir="auto">
                {b.device_name ?? b.ip}
              </DeviceLink>
            </td>
            <td data-label={t('security.banners.address')}>
              <Mono>
                {b.scheme}://{b.ip}:{b.port}
              </Mono>
            </td>
            <td data-label={t('security.banners.status')}>
              <Mono>{b.status ?? '—'}</Mono>
            </td>
            <td data-label={t('security.banners.title')} dir="auto" className="break-words">
              {b.title ?? '—'}
            </td>
            <td data-label={t('security.banners.server')} dir="auto" className="break-words">
              {b.server ?? '—'}
            </td>
            <td data-label={t('security.banners.tls')} className="break-words text-xs">
              {b.scheme === 'https' ? (
                <>
                  <span dir="auto">{b.tls_subject ?? '—'}</span>
                  {b.tls_self_signed && (
                    <span className="ms-1">
                      <Badge tone="warn" dot={false}>
                        {t('security.banners.selfSigned')}
                      </Badge>
                    </span>
                  )}
                </>
              ) : (
                '—'
              )}
            </td>
            <td data-label={t('security.banners.probed')}>
              <When iso={b.probed_at} />
            </td>
          </tr>
        ))}
      </tbody>
    </DataTable>
  );
}

const CONF: Confidence[] = ['high', 'medium', 'low'];

export function Fingerprints({ items }: { items: Fingerprint[] }) {
  const { t } = useI18n();
  if (items.length === 0)
    return (
      <EmptyState icon={<ShieldQuestion />} title={t('security.fp.none')}>
        <p>{t('security.fp.noneHint')}</p>
      </EmptyState>
    );
  return (
    <DataTable stack>
      <thead>
        <tr>
          <th>{t('security.fp.mac')}</th>
          <th>{t('security.fp.hostname')}</th>
          <th>{t('security.fp.os')}</th>
          <th>{t('security.fp.vendorClass')}</th>
          <th>{t('security.fp.prl')}</th>
          <th>{t('security.fp.server')}</th>
          <th>{t('security.fp.seen')}</th>
        </tr>
      </thead>
      <tbody>
        {items.map((f) => (
          <tr key={f.mac}>
            <td data-label={t('security.fp.mac')}>
              <Mono>{f.mac}</Mono>
              {f.device_id && (
                <DeviceLink id={f.device_id} className="block text-xs text-accent-hover hover:underline" dir="auto">
                  {f.device_name ?? ''}
                </DeviceLink>
              )}
            </td>
            <td data-label={t('security.fp.hostname')} dir="auto" className="break-words">
              {f.hostname ?? '—'}
            </td>
            <td data-label={t('security.fp.os')}>
              {f.os_family ? (
                <span className="inline-flex flex-wrap items-center gap-1.5">
                  <span dir="auto">{f.os_family}</span>
                  <InferredBadge confidence={CONF.includes(f.confidence as Confidence) ? (f.confidence as Confidence) : null} />
                </span>
              ) : (
                '—'
              )}
            </td>
            <td data-label={t('security.fp.vendorClass')} dir="auto" className="break-words">
              {f.vendor_class ?? '—'}
            </td>
            <td data-label={t('security.fp.prl')}>
              <span className="mono break-all text-xs" dir="ltr">
                {f.prl}
              </span>
            </td>
            <td data-label={t('security.fp.server')}>
              <Mono>{f.server_id ?? '—'}</Mono>
            </td>
            <td data-label={t('security.fp.seen')}>
              <When iso={f.seen_at} />
            </td>
          </tr>
        ))}
      </tbody>
    </DataTable>
  );
}
