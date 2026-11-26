'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { Device, Paginated } from '@nigafiy/shared-types';
import { DeviceIcon } from '@/components/device-icon';
import { DeviceLink } from '@/components/device-link';
import { Button, Card, ErrorNote, Input } from '@/components/ui';
import { type ApiError, api, qs } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { DEVICE_TYPE_LABEL, relativeTime } from '@/lib/format';
import { fill, useI18n } from '@/lib/i18n';

/** Rows shown at once; the next unnamed device moves up when one is saved or skipped. */
const VISIBLE = 5;
/** Most recently seen devices scanned for unnamed ones (the API's maximum page size). */
const SAMPLE = 200;

/**
 * A device has no friendly name when neither the user (display_name) nor discovery (hostname:
 * rDNS, mDNS, NetBIOS, DHCP…) gave it one: the same test as the `named` flag behind the
 * 'nameless_phones' insight (display_name IS NOT NULL OR hostname IS NOT NULL).
 */
export const isUnnamed = (d: Pick<Device, 'display_name' | 'hostname'>): boolean => !d.display_name?.trim() && !d.hostname?.trim();

/**
 * "Who owns this device?" — name unnamed devices in place, one line each. Saves with
 * PATCH /devices/:id { display_name } (technician or higher). Hidden when nothing needs a name or
 * the user may not rename devices.
 */
export function QuickNameCard({ siteId: siteProp }: { siteId?: string | null } = {}) {
  const { t, tn, locale } = useI18n();
  const app = useApp();
  const siteId = siteProp !== undefined ? siteProp : app.siteId;
  const allowed = app.can('technician');
  const query = useQuery<Paginated<Device>>(allowed ? `/devices${qs({ site_id: siteId, sort: 'last_seen', page_size: SAMPLE })}` : null, ['devices'], 60_000);
  // Hidden locally right away (saved ones until the refreshed list no longer has them; skipped ones for this visit).
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());

  if (!allowed || !query.data) return null;
  const unnamed = query.data.items.filter((d) => isUnnamed(d) && !hidden.has(d.id));
  if (unnamed.length === 0) return null;
  // Beyond the sampled page the API's total is not split by name, so the count covers the sample only.
  const hide = (id: string) => setHidden((s) => new Set(s).add(id));

  return (
    <Card
      title={t('devices.quick.title')}
      description={fill(tn('devices.quick.remaining', unnamed.length), { count: unnamed.length })}
      action={
        <Link href="/radar/devices?sort=last_seen" className="text-[13px] font-medium text-accent hover:text-accent-hover">
          {t('devices.quick.seeAll')}
        </Link>
      }
      padded={false}
    >
      <p className="border-b border-line px-4 py-2.5 text-xs text-muted">{t('devices.quick.hint')}</p>
      <ul className="divide-y divide-line">
        {unnamed.slice(0, VISIBLE).map((d) => (
          <QuickNameRow key={d.id} device={d} locale={locale} onDone={() => hide(d.id)} onSkip={() => hide(d.id)} />
        ))}
      </ul>
    </Card>
  );
}

function QuickNameRow({ device: d, locale, onDone, onSkip }: { device: Device; locale: 'en' | 'ar'; onDone: () => void; onSkip: () => void }) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const inputId = `quick-name-${d.id}`;

  const type = d.device_type !== 'unknown' ? DEVICE_TYPE_LABEL[d.device_type]?.[locale] : null;
  const maker = d.vendor ?? (d.mac_randomized ? t('devices.randomizedMac') : null);
  const macTail = !d.vendor && d.primary_mac ? d.primary_mac.slice(-5) : null;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const value = name.trim();
    if (!value) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/devices/${d.id}`, { method: 'PATCH', body: { display_name: value } });
      onDone();
    } catch (err) {
      setError(err as ApiError);
      setBusy(false);
    }
  }

  return (
    <li className="px-4 py-3">
      <form onSubmit={save} className="flex flex-col gap-2.5 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-[8px] border border-line bg-sunken text-muted" aria-hidden>
            <DeviceIcon type={d.device_type} />
          </span>
          <div className="min-w-0">
            <DeviceLink id={d.id} className="block truncate text-[13px] font-medium text-fg hover:text-accent-hover">
              {type ?? t('devices.quick.unknownDevice')}
            </DeviceLink>
            <span className="flex flex-wrap items-center gap-x-2 text-xs text-muted">
              {maker && <span className="max-w-[14rem] truncate">{maker}</span>}
              {d.current_ip && (
                <span className="mono" dir="ltr">
                  {d.current_ip}
                </span>
              )}
              {macTail && <span>{fill(t('devices.quick.macHint'), { tail: `⁦${macTail}⁩` })}</span>}
              <span className="text-faint">{fill(t('devices.quick.seen'), { when: relativeTime(d.last_seen_at, locale) })}</span>
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2 sm:w-[22rem]">
          <label htmlFor={inputId} className="sr-only">
            {t('devices.quick.inputLabel')}
          </label>
          <Input id={inputId} value={name} maxLength={80} dir="auto" placeholder={t('devices.quick.placeholder')} onChange={(e) => setName(e.target.value)} className="min-w-0 flex-1" />
          <Button type="submit" size="sm" variant="primary" busy={busy} disabled={!name.trim()}>
            {t('common.save')}
          </Button>
          <Button size="sm" variant="ghost" onClick={onSkip} disabled={busy}>
            {t('devices.quick.skip')}
          </Button>
        </div>
      </form>
      {error && (
        <div className="mt-2">
          <ErrorNote error={error} />
        </div>
      )}
    </li>
  );
}
