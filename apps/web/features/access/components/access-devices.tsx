'use client';

import type { AccessPage } from '@nigafiy/shared-types';
import { MonitorSmartphone } from 'lucide-react';
import { useState } from 'react';
import { ProportionBar } from '@/components/charts';
import { DeviceLink } from '@/components/device-link';
import { Badge, Card, EmptyState, ErrorNote, Select, StatusBadge } from '@/components/ui';
import { type ApiError, api } from '@/lib/api';
import { fill, useI18n } from '@/lib/i18n';
import { accessText } from '../text';
import { PauseControl } from './pause-control';

export function Devices({ data, admin, canPause, onChanged }: { data: AccessPage; admin: boolean; canPause: boolean; onChanged: () => void }) {
  const { t, locale } = useI18n();
  const tx = accessText(locale);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  async function setProfile(id: string, profile_id: string) {
    setSaving(id);
    setError(null);
    try {
      await api(`/devices/${id}/access`, { method: 'PATCH', body: { profile_id: profile_id || null } });
      onChanged();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setSaving(null);
    }
  }
  if (!data.devices.length) return <EmptyState icon={<MonitorSmartphone />} title={tx.devices} />;
  return (
    <Card title={tx.devices} padded={false}>
      <p className="px-4 pt-3 text-xs text-muted">{tx.devicesHint}</p>
      {error && (
        <div className="px-4 pt-3">
          <ErrorNote error={error} />
        </div>
      )}
      <ul className="divide-y divide-line">
        {data.devices.map((d) => (
          <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <div className="min-w-0">
              <DeviceLink id={d.id} className="block truncate font-medium hover:text-accent-hover" dir="auto">
                {d.name}
              </DeviceLink>
              <p className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted">
                <StatusBadge status={d.status as 'online'} />
                <span className="mono">{d.ip ?? '—'}</span>
                {d.enforcement_mode && (
                  <Badge
                    tone={
                      d.enforcement_mode === 'router_and_dns'
                        ? 'ok'
                        : d.enforcement_mode === 'router_only'
                          ? 'info'
                          : d.enforcement_mode === 'dns_only'
                            ? 'warn'
                            : 'idle'
                    }
                    dot
                  >
                    {tx.enforcement.mode[d.enforcement_mode]}
                  </Badge>
                )}
                {d.router_blocked && (
                  <Badge tone="crit" dot={false}>
                    {tx.enforcement.deviceRouterBlocked}
                  </Badge>
                )}
                {d.router_scheduled && (
                  <Badge tone="info" dot={false}>
                    {tx.enforcement.deviceRouterScheduled}
                  </Badge>
                )}
                {d.doh_bypass_24h > 0 && (
                  <span title={d.doh_domains_24h.join(', ')}>
                    <Badge tone="warn" dot={false}>
                      {fill(tx.enforcement.deviceDohBadge, { n: d.doh_bypass_24h })}
                    </Badge>
                  </span>
                )}
                {(d.queries_24h > 0 || d.blocked_24h > 0) && (
                  <span className="tnum">
                    {d.queries_24h} {tx.queries} · <span className={d.blocked_24h ? 'text-crit' : ''}>{d.blocked_24h} {tx.blocked}</span> ({tx.activity24})
                  </span>
                )}
              </p>
              {d.queries_24h > 0 && (
                <div className="mt-2 w-48 max-w-full">
                  <ProportionBar
                    label={`${d.name}: ${t('dash.dnsBlocked')}`}
                    height={5}
                    legend={false}
                    slices={[
                      { key: 'allowed', label: t('dash.dnsAllowed'), value: Math.max(0, d.queries_24h - d.blocked_24h), color: 'var(--color-series-1)' },
                      { key: 'blocked', label: t('dash.dnsBlockedPart'), value: d.blocked_24h, color: 'var(--color-series-2)' },
                    ]}
                  />
                </div>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Select
                aria-label={tx.profile}
                value={d.profile_id ?? ''}
                disabled={!admin || saving === d.id}
                onChange={(e) => setProfile(d.id, e.target.value)}
                className="!h-8 w-44 text-xs"
              >
                <option value="">{tx.noProfile}</option>
                {data.profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
              <PauseControl path={`/devices/${d.id}/pause`} pausedUntil={d.paused_until} internetOff={d.internet_off} canPause={canPause} onChanged={onChanged} />
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}
