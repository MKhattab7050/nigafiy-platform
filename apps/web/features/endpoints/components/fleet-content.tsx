'use client';

import clsx from 'clsx';
import { Ban, KeyRound, Plus, ShieldAlert, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { useMemo } from 'react';
import type { EndpointComplianceStatus, EndpointPlatform, EndpointSummary } from '@nigafiy/shared-types';
import { Donut, Legend, ProportionBar, SERIES } from '@/components/charts';
import { PlatformIcon } from '@/components/device-icon';
import { DeviceLink } from '@/components/device-link';
import { SetupArt } from '@/components/illustrations';
import { Badge, Button, Card, EmptyState, Segmented } from '@/components/ui';
import { relativeTime } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { localizeComplianceReason } from '@/lib/localize';
import { endpointsText } from '../text';
import { Meter, complianceTone, epTone } from './endpoint-tones';

export function FleetContent({
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

  const active = useMemo(() => items.filter((e) => e.status !== 'revoked'), [items]);

  const stats = useMemo(() => {
    const online = active.filter((e) => e.status === 'active' && e.connection_state === 'online').length;
    const offline = active.length - online;
    const nonCompliant = active.filter((e) => e.compliance_status === 'non_compliant').length;
    const attention = active.filter(
      (e) =>
        e.compliance_status === 'attention' ||
        e.compliance_status === 'non_compliant' ||
        (e.status === 'active' && e.connection_state === 'offline'),
    ).length;
    const byPlatform: Record<EndpointPlatform, number> = {
      windows: 0,
      linux: 0,
      macos: 0,
    };
    for (const e of active) {
      const p = e.platform ?? 'windows';
      byPlatform[p] = (byPlatform[p] ?? 0) + 1;
    }
    return { total: active.length, online, offline, nonCompliant, attention, byPlatform };
  }, [active]);

  const complianceSlices = (['compliant', 'attention', 'non_compliant', 'unknown'] as const).map((c) => ({
    key: c,
    label: tx.complianceStatus[c],
    value: active.filter((e) => e.compliance_status === c).length,
    color: c === 'compliant' ? 'var(--color-ok)' : c === 'attention' ? 'var(--color-warn)' : c === 'non_compliant' ? 'var(--color-crit)' : 'var(--color-idle)',
  }));

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
          illustration={<SetupArt />}
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
      {/* Fleet summary: reachability counters, compliance split and platform mix, all from GET /endpoints. */}
      <section className="grid gap-px overflow-hidden rounded-[var(--radius-card)] border border-line bg-line shadow-[var(--shadow-card)] lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)] [&>div]:bg-surface">
        <div className="grid grid-cols-2 gap-x-4 gap-y-4 p-5 sm:grid-cols-3 lg:grid-cols-2 xl:grid-cols-3">
          {[
            { label: tx.fleetStats.total, value: stats.total, cls: 'text-fg' },
            { label: tx.fleetStats.online, value: stats.online, cls: 'text-ok' },
            { label: tx.fleetStats.offline, value: stats.offline, cls: 'text-muted' },
            { label: tx.fleetStats.attention, value: stats.attention, cls: stats.attention > 0 ? 'text-warn' : 'text-fg' },
            { label: tx.fleetStats.nonCompliant, value: stats.nonCompliant, cls: stats.nonCompliant > 0 ? 'text-crit' : 'text-ok' },
          ].map((k) => (
            <div key={k.label} className="min-w-0">
              <div className={clsx('tnum text-[26px] font-semibold leading-none tracking-[-0.02em]', k.cls)}>{k.value}</div>
              <div className="mt-1.5 text-xs text-muted">{k.label}</div>
            </div>
          ))}
        </div>
        <div className="p-5">
          <p className="mb-3 text-xs font-medium text-muted">{t('dash.compliance')}</p>
          <div className="flex items-center gap-4">
            <Donut slices={complianceSlices} size={84} thickness={11} label={`${t('dash.compliance')}: ${complianceSlices.map((c) => `${c.label} ${c.value}`).join(', ')}`} />
            <div className="min-w-0 flex-1">
              <Legend slices={complianceSlices} total={stats.total} />
            </div>
          </div>
        </div>
        <div className="p-5">
          <p className="mb-3 text-xs font-medium text-muted">{t('dash.platforms')}</p>
          <ProportionBar label={t('dash.platforms')} slices={(['windows', 'linux', 'macos'] as const).map((p, i) => ({ key: p, label: tx.platforms[p], value: stats.byPlatform[p], color: SERIES[i]! }))} />
        </div>
      </section>

      {/* Platform Breakdown & Filters */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Segmented<'all' | EndpointPlatform>
          value={platformFilter}
          label={tx.platformLabel}
          onChange={setPlatformFilter}
          options={[
            { value: 'all', label: `${t('common.all')} (${stats.total})` },
            { value: 'windows', label: `Windows (${stats.byPlatform.windows})` },
            { value: 'linux', label: `Linux (${stats.byPlatform.linux})` },
            { value: 'macos', label: `macOS (${stats.byPlatform.macos})` },
          ]}
        />

        <Segmented<'all' | EndpointComplianceStatus>
          value={complianceFilter}
          label={t('dash.compliance')}
          onChange={setComplianceFilter}
          options={[
            { value: 'all', label: t('common.all') },
            { value: 'compliant', label: tx.complianceStatus.compliant },
            { value: 'attention', label: tx.complianceStatus.attention },
            { value: 'non_compliant', label: tx.complianceStatus.non_compliant },
            { value: 'unknown', label: tx.complianceStatus.unknown },
          ]}
        />
      </div>

      {/* Endpoint Cards */}
      <div className="grid gap-4 md:grid-cols-2">
        {filtered.map((ep) => {
          const statusLabel =
            ep.status === 'revoked'
              ? tx.revoked
              : ep.status === 'pending'
                ? tx.pending
                : ep.connection_state === 'online'
                  ? tx.online
                  : tx.offline;

          return (
            <Card
              key={ep.id}
              title={
                <span className="flex flex-wrap items-center gap-2">
                  <PlatformIcon platform={ep.platform} className="size-4 text-muted" />
                  <Link href={`/fleet/endpoints/${ep.id}`} className="font-semibold text-fg hover:text-accent-hover hover:underline">
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
                      <Button
                        size="sm"
                        busy={busy === `reissue-${ep.id}`}
                        disabled={busy === `revoke-${ep.id}`}
                        onClick={() => void onReissue(ep.id)}
                      >
                        <KeyRound className="size-3.5" aria-hidden />
                        {tx.newToken}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="danger"
                      busy={busy === `revoke-${ep.id}`}
                      disabled={busy === `reissue-${ep.id}`}
                      onClick={() => void onRevoke(ep.id)}
                    >
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
                    <code dir="ltr" className="mono text-fg">
                      {ep.primary_ip}
                    </code>
                  )}
                </div>

                {ep.status === 'active' && (
                  <>
                    <div className="grid grid-cols-3 gap-4 rounded-[8px] border border-line bg-sunken p-3">
                      <Meter value={ep.cpu_pct} label={tx.cpu} />
                      <Meter value={ep.ram_pct} label={tx.memory} />
                      <Meter value={ep.disk_used_pct} label={tx.disk} />
                    </div>

                    {ep.compliance_reasons && ep.compliance_reasons.length > 0 && (
                      <div className="rounded-[6px] border border-warn/30 bg-warn/[0.08] px-2.5 py-1.5 text-xs text-fg" dir="auto">
                        {ep.compliance_reasons.map((r) => localizeComplianceReason(r, locale)).join(' · ')}
                      </div>
                    )}

                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                      <span className="text-muted">
                        {tx.loggedInUser}:{' '}
                        <span className="font-medium text-fg">
                          {ep.logged_in_users.length > 0 ? ep.logged_in_users.join(', ') : tx.noUser}
                        </span>
                      </span>
                      <span className="text-faint">
                        {tx.lastCheckIn}: {relativeTime(ep.last_heartbeat_at, locale)}
                      </span>
                    </div>
                  </>
                )}

                <div className="flex items-center justify-between border-t border-line pt-2.5 text-xs">
                  {ep.device_id ? (
                    <DeviceLink id={ep.device_id} className="text-muted hover:text-fg hover:underline">
                      {tx.openDevice}
                    </DeviceLink>
                  ) : (
                    <span />
                  )}
                  <Link href={`/fleet/endpoints/${ep.id}`} className="font-medium text-accent-hover hover:underline">
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
