'use client';

import clsx from 'clsx';
import { Ban, KeyRound, LifeBuoy, Plus, Search, ShieldAlert, ShieldCheck, Star } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import type { EndpointComplianceStatus, EndpointPlatform, EndpointSummary } from '@nigafiy/shared-types';
import { Donut, Legend, ProportionBar, SERIES } from '@/components/charts';
import { PlatformIcon } from '@/components/device-icon';
import { DeviceLink } from '@/components/device-link';
import { SetupArt } from '@/components/illustrations';
import { Badge, Button, Card, EmptyState, Input, Segmented, Select } from '@/components/ui';
import { api } from '@/lib/api';
import { relativeTime } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { localizeComplianceReason } from '@/lib/localize';
import { endpointsText } from '../text';
import { GroupTag, useFleetGroups } from './fleet-policy/group-assign';
import { policyText } from './fleet-policy/policy-text';
import { Meter, complianceTone, epTone } from './endpoint-tones';
import { BulkBar } from './reach/bulk-bar';
import { reachText } from './reach/reach-text';

export function FleetContent({
  items,
  platformFilter,
  setPlatformFilter,
  complianceFilter,
  setComplianceFilter,
  busy,
  canAdmin,
  canTech = canAdmin,
  onAdd,
  onReissue,
  onRevoke,
  onReload,
}: {
  items: EndpointSummary[];
  platformFilter: 'all' | EndpointPlatform;
  setPlatformFilter: (v: 'all' | EndpointPlatform) => void;
  complianceFilter: 'all' | EndpointComplianceStatus;
  setComplianceFilter: (v: 'all' | EndpointComplianceStatus) => void;
  busy: string;
  canAdmin: boolean;
  /** Technicians and above: favourites, selection and the bulk bar. */
  canTech?: boolean;
  onAdd: () => void;
  onReissue: (id: string) => Promise<void>;
  onRevoke: (id: string) => Promise<void>;
  onReload?: () => void;
}) {
  const { locale, t } = useI18n();
  const tx = endpointsText(locale);
  const px = policyText(locale);
  const rx = reachText(locale);
  const groupsQ = useFleetGroups();
  const [q, setQ] = useState('');
  const [siteFilter, setSiteFilter] = useState('all');
  const [tagFilter, setTagFilter] = useState('all');
  const [userFilter, setUserFilter] = useState('all');
  const [view, setView] = useState<'all' | 'favourites' | 'recent'>('all');
  const [favBusy, setFavBusy] = useState('');
  const groups = groupsQ.data?.groups ?? [];
  const [groupFilter, setGroupFilter] = useState<string>('all');
  const [selected, setSelected] = useState<string[]>([]);
  const toggle = (id: string, on: boolean) => setSelected((s) => (on ? [...new Set([...s, id])] : s.filter((x) => x !== id)));

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
      android: 0,
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

  // Address book: what the filters offer comes from the computers themselves.
  const sitesSeen = useMemo(() => [...new Set(items.map((e) => e.site_name))].sort(), [items]);
  const tagsSeen = useMemo(() => [...new Set(items.flatMap((e) => e.tags ?? []))].sort(), [items]);
  const usersSeen = useMemo(() => [...new Set(items.flatMap((e) => [...e.logged_in_users, ...(e.user_sessions ?? []).flatMap((s) => (s.user ? [s.user] : []))]))].sort(), [items]);

  async function toggleFavourite(id: string, on: boolean) {
    setFavBusy(id);
    try {
      await api(`/fleet/favourites/${id}`, { method: on ? 'PUT' : 'DELETE' });
      onReload?.();
    } finally {
      setFavBusy('');
    }
  }

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const digits = needle.replace(/[\s-]/g, '');
    const list = items.filter((e) => {
      if (needle) {
        const hay = [e.name, e.hostname, e.primary_ip, e.site_name, ...(e.tags ?? []), ...e.logged_in_users].filter(Boolean).join(' ').toLowerCase();
        if (!hay.includes(needle) && !(digits.length >= 3 && /^\d+$/.test(digits) && (e.nigafiy_id ?? '').includes(digits))) return false;
      }
      if (siteFilter !== 'all' && e.site_name !== siteFilter) return false;
      if (tagFilter !== 'all' && !(e.tags ?? []).includes(tagFilter)) return false;
      if (userFilter !== 'all' && !e.logged_in_users.includes(userFilter) && !(e.user_sessions ?? []).some((s) => s.user === userFilter)) return false;
      if (view === 'favourites' && !e.favourite) return false;
      if (view === 'recent' && !e.my_last_session_at) return false;
      if (platformFilter !== 'all' && e.platform !== platformFilter) return false;
      if (complianceFilter !== 'all' && e.compliance_status !== complianceFilter) return false;
      if (groupFilter === 'none' && e.fleet_group_id) return false;
      if (groupFilter !== 'all' && groupFilter !== 'none' && e.fleet_group_id !== groupFilter) return false;
      return true;
    });
    if (view === 'recent') list.sort((a, b) => (b.my_last_session_at ?? '').localeCompare(a.my_last_session_at ?? ''));
    return list;
  }, [items, platformFilter, complianceFilter, groupFilter, q, siteFilter, tagFilter, userFilter, view]);

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
          <ProportionBar label={t('dash.platforms')} slices={(['windows', 'linux', 'macos', 'android'] as const).map((p, i) => ({ key: p, label: tx.platforms[p], value: stats.byPlatform[p], color: SERIES[i]! }))} />
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
            { value: 'android', label: `Android (${stats.byPlatform.android})` },
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

      {/* Address book: search, site, tag, signed-in user, favourites and my recent sessions. */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-64 flex-1">
          <Search className="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-faint" aria-hidden />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={rx.search} aria-label={rx.search} className="ps-8" dir="auto" />
        </div>
        {sitesSeen.length > 1 && (
          <Select value={siteFilter} onChange={(e) => setSiteFilter(e.target.value)} aria-label={rx.allSites} className="w-44">
            <option value="all">{rx.allSites}</option>
            {sitesSeen.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
        )}
        {tagsSeen.length > 0 && (
          <Select value={tagFilter} onChange={(e) => setTagFilter(e.target.value)} aria-label={rx.allTags} className="w-40">
            <option value="all">{rx.allTags}</option>
            {tagsSeen.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
        )}
        {usersSeen.length > 0 && (
          <Select value={userFilter} onChange={(e) => setUserFilter(e.target.value)} aria-label={rx.anyUser} className="w-48">
            <option value="all">{rx.anyUser}</option>
            {usersSeen.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
        )}
        {canTech && (
          <Segmented<'all' | 'favourites' | 'recent'>
            value={view}
            label={rx.viewLabel}
            onChange={setView}
            options={[
              { value: 'all', label: rx.view.all },
              { value: 'favourites', label: rx.view.favourites },
              { value: 'recent', label: rx.view.recent },
            ]}
          />
        )}
      </div>

      {/* Fleet groups: filter, and bulk actions on a selection. */}
      {(groups.length > 0 || canTech) && (
        <div className="flex flex-wrap items-center gap-2">
          <Select value={groupFilter} onChange={(e) => setGroupFilter(e.target.value)} aria-label={px.group} className="w-64">
            <option value="all">{px.allGroups}</option>
            <option value="none">{px.noGroup}</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </Select>
          {canTech && (
            <Button size="sm" onClick={() => setSelected(filtered.filter((e) => e.status !== 'revoked').map((e) => e.id))}>
              {px.selectAll}
            </Button>
          )}
        </div>
      )}
      {canTech && selected.length > 0 && (
        <BulkBar
          selected={selected}
          names={Object.fromEntries(items.map((e) => [e.id, e.name]))}
          groups={groupsQ.data ? groups : null}
          canAdmin={canAdmin}
          onClear={() => setSelected([])}
          onDone={() => onReload?.()}
        />
      )}
      {filtered.length === 0 && <p className="text-sm text-muted">{rx.noMatch}</p>}

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
              // Even density: every card in a row is the same height, footer pinned to the bottom.
              className="flex flex-col [&>div]:flex [&>div]:flex-1 [&>div]:flex-col"
              title={
                <span className="flex flex-wrap items-center gap-2">
                  {canTech && ep.status !== 'revoked' && (
                    <input type="checkbox" checked={selected.includes(ep.id)} onChange={(e) => toggle(ep.id, e.target.checked)} aria-label={px.select(ep.name)} />
                  )}
                  <PlatformIcon platform={ep.platform} className="size-4 text-muted" />
                  <Link href={`/fleet/endpoints/${ep.id}`} className="font-semibold text-fg hover:text-accent-hover hover:underline">
                    {ep.name}
                  </Link>
                  {canTech && ep.status !== 'revoked' && (
                    <button
                      type="button"
                      className="rounded p-0.5 text-faint hover:text-warn disabled:opacity-50"
                      aria-pressed={Boolean(ep.favourite)}
                      aria-label={ep.favourite ? rx.unfavourite(ep.name) : rx.favourite(ep.name)}
                      title={ep.favourite ? rx.unfavourite(ep.name) : rx.favourite(ep.name)}
                      disabled={favBusy === ep.id}
                      onClick={() => void toggleFavourite(ep.id, !ep.favourite)}
                    >
                      <Star className={clsx('size-4', ep.favourite && 'fill-warn text-warn')} aria-hidden />
                    </button>
                  )}
                  <Badge tone="info">{tx.platforms[ep.platform] ?? ep.platform}</Badge>
                  <Badge tone={epTone(ep)}>{statusLabel}</Badge>
                  {(ep.open_help_requests ?? 0) > 0 && (
                    <Link href="/fleet/requests" className="inline-flex">
                      <Badge tone="warn">
                        <LifeBuoy className="me-1 inline size-3" aria-hidden />
                        {rx.helpOpen(ep.open_help_requests ?? 0)}
                      </Badge>
                    </Link>
                  )}
                  {groupsQ.data && <GroupTag name={ep.fleet_group_name} color={groups.find((g) => g.id === ep.fleet_group_id)?.color} />}
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
              <div className="flex flex-1 flex-col space-y-3">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  {ep.nigafiy_id && (
                    <span className="text-muted">
                      {rx.nigafiyId}: <span className="mono font-medium text-fg">{rx.idValue(ep.nigafiy_id)}</span>
                    </span>
                  )}
                  {(ep.tags ?? []).map((tag) => (
                    <button key={tag} type="button" onClick={() => setTagFilter(tag)} className="rounded-[4px] border border-line bg-raised px-1.5 py-0.5 text-[11px] text-muted hover:text-fg" dir="auto">
                      #{tag}
                    </button>
                  ))}
                  {ep.my_last_session_at && <span className="text-faint">{rx.lastSession(relativeTime(ep.my_last_session_at, locale))}</span>}
                </div>
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

                <div className="mt-auto flex items-center justify-between border-t border-line pt-2.5 text-xs">
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
