'use client';

import clsx from 'clsx';
import { ChevronDown } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import type { AccessDevice, AccessPage } from '@lan-detective/shared-types';
import { Badge, Button, Card, ErrorNote, Field, Select, Spinner, Textarea } from '@/components/ui';
import { type ApiError, api } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { fill, useI18n } from '@/lib/i18n';
import { PauseControl } from './pause-control';
import { linesToList } from './rule-editors';
import { accessText } from '../text';

export interface Activity {
  hours: number;
  queries: number;
  blocked: number;
  domains: { domain: string; count: number; blocked: number; category: string | null; reason: string | null; last_seen: string }[];
}

/** Device page card: internet state, pause, profile and what the device used recently. */
export function DeviceAccessCard({ deviceId, siteId }: { deviceId: string; siteId: string }) {
  const { locale } = useI18n();
  return (
    <Card title={accessText(locale).deviceCard}>
      <DeviceAccessCardBody deviceId={deviceId} siteId={siteId} />
    </Card>
  );
}

function DeviceAccessCardBody({ deviceId, siteId }: { deviceId: string; siteId: string }) {
  const { locale } = useI18n();
  const tx = accessText(locale);
  const { can } = useApp();
  const page = useQuery<AccessPage>(`/access?site_id=${siteId}`, ['devices'], 30_000);
  const activity = useQuery<Activity>(`/devices/${deviceId}/activity?hours=24`, [], 60_000);
  const d = page.data?.devices.find((x) => x.id === deviceId);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  if (!page.data) return <Spinner />;
  if (!page.data.settings.enabled || !d)
    return (
      <div className="space-y-2 text-sm text-muted">
        <p>{tx.deviceCardOff}</p>
        <Link href="/guard/access" className="text-accent hover:underline">
          {tx.setUp}
        </Link>
      </div>
    );
  async function setProfile(profile_id: string) {
    setSaving(true);
    setError(null);
    try {
      await api(`/devices/${deviceId}/access`, { method: 'PATCH', body: { profile_id: profile_id || null } });
      page.reload();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="space-y-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
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
        >
          {tx.enforcement.mode[d.enforcement_mode ?? (d.protected ? 'dns_only' : 'unprotected')]}
        </Badge>
        {d.router_blocked && <Badge tone="crit">{tx.enforcement.deviceRouterBlocked}</Badge>}
        {d.doh_bypass_24h > 0 && (
          <span title={d.doh_domains_24h.join(', ')}>
            <Badge tone="warn">{fill(tx.enforcement.deviceDohBadge, { n: d.doh_bypass_24h })}</Badge>
          </span>
        )}
        {!d.internet_off && !d.paused_until && !d.router_blocked && <Badge tone="ok">{tx.internetOn}</Badge>}
      </div>
      <PauseControl path={`/devices/${deviceId}/pause`} pausedUntil={d.paused_until} internetOff={d.internet_off} canPause={can('technician')} onChanged={page.reload} />
      <label className="block text-xs text-muted">
        {tx.profile}
        <Select value={d.profile_id ?? ''} disabled={!can('admin') || saving} onChange={(e) => setProfile(e.target.value)} className="mt-1 !h-8 text-xs">
          <option value="">{tx.noProfile}</option>
          {page.data.profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
      </label>
      {error && <ErrorNote error={error} />}
      <DeviceOwnRules device={d} admin={can('admin')} onChanged={page.reload} />
      <div>
        <p className="mb-1 text-xs font-medium text-muted">{tx.activity}</p>
        {!activity.data || activity.data.queries === 0 ? (
          <p className="text-xs text-faint">{tx.noActivity}</p>
        ) : (
          <>
            <p className="mb-2 text-xs text-muted tnum">
              {activity.data.queries} {tx.queries} · {activity.data.blocked} {tx.blocked}
            </p>
            <ul className="max-h-64 space-y-1 overflow-y-auto">
              {activity.data.domains.map((x) => (
                <li key={x.domain} className="flex items-center justify-between gap-2 text-xs">
                  <span className={`mono truncate ${x.blocked ? 'text-crit' : ''}`} dir="ltr">
                    {x.domain}
                  </span>
                  <span className="shrink-0 text-faint tnum">
                    {x.blocked ? `${tx.reasons[x.reason as keyof typeof tx.reasons] ?? ''}${x.category ? ` · ${tx.cat[x.category] ?? x.category}` : ''} · ` : ''}
                    {x.count}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}

function DeviceOwnRules({ device, admin, onChanged }: { device: AccessDevice; admin: boolean; onChanged: () => void }) {
  const { locale } = useI18n();
  const tx = accessText(locale);
  const serverBlocked = device.blocked_domains.join('\n');
  const serverAllowed = device.allowed_domains.join('\n');
  const ruleCount = device.blocked_domains.length + device.allowed_domains.length;

  const [open, setOpen] = useState(ruleCount > 0);
  const [blocked, setBlocked] = useState(serverBlocked);
  const [allowed, setAllowed] = useState(serverAllowed);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(savedTimer.current), []);
  useEffect(() => {
    setBlocked(serverBlocked);
  }, [serverBlocked]);
  useEffect(() => {
    setAllowed(serverAllowed);
  }, [serverAllowed]);

  async function saveRules() {
    setBusy(true);
    setError(null);
    try {
      await api(`/devices/${device.id}/access`, {
        method: 'PATCH',
        body: {
          blocked_domains: linesToList(blocked),
          allowed_domains: linesToList(allowed),
        },
      });
      setSaved(true);
      clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setSaved(false), 2000);
      onChanged();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border-t border-line pt-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="inline-flex h-7 items-center gap-1.5 rounded px-1 text-xs font-medium text-muted hover:text-fg"
      >
        <span>{tx.ownRules}</span>
        {ruleCount > 0 && (
          <Badge tone="idle" dot={false}>
            {ruleCount}
          </Badge>
        )}
        <ChevronDown className={clsx('size-3.5 transition-transform duration-150', open && 'rotate-180')} aria-hidden />
      </button>
      {open && (
        <div className="mt-2 space-y-2.5">
          <p className="text-[11px] text-faint">{tx.ownRulesHint}</p>
          <Field label={tx.blockedDomains} hint={tx.domainsHint}>
            {(id) => (
              <Textarea
                id={id}
                rows={2}
                dir="ltr"
                value={blocked}
                disabled={!admin || busy}
                onChange={(e) => setBlocked(e.target.value)}
                placeholder="tiktok.com"
              />
            )}
          </Field>
          <Field label={tx.allowedDomains} hint={tx.domainsHint}>
            {(id) => (
              <Textarea
                id={id}
                rows={2}
                dir="ltr"
                value={allowed}
                disabled={!admin || busy}
                onChange={(e) => setAllowed(e.target.value)}
                placeholder="khanacademy.org"
              />
            )}
          </Field>
          {error && <ErrorNote error={error} />}
          {admin && (
            <Button size="sm" variant="primary" busy={busy} onClick={saveRules}>
              {saved ? tx.saved : tx.save}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
