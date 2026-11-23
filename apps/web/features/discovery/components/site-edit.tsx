'use client';

import { useMemo, useState } from 'react';
import type { Site } from '@nigafiy/shared-types';
import { Button, ErrorNote, Field, Input, Modal } from '@/components/ui';
import { type ApiError, api } from '@/lib/api';
import { allTimeZones, browserTimeZone } from '@/lib/format';
import { fill, useI18n } from '@/lib/i18n';

/** Site name and time zone (PATCH /sites/:id). The zone is picked from the IANA list this browser knows. */
export function SiteEditModal({ site, onClose, onSaved }: { site: Site; onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n();
  const zones = useMemo(allTimeZones, []);
  const browserZone = browserTimeZone();
  const [name, setName] = useState(site.name);
  const [zone, setZone] = useState(site.timezone);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const needle = search.trim().toLowerCase().replaceAll(' ', '_');
  const matches = needle ? zones.filter((z) => z.toLowerCase().includes(needle)) : zones;
  // Keep the chosen zone visible in the list even when the search hides it.
  const options = matches.includes(zone) ? matches : [zone, ...matches];

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, string> = {};
      if (name.trim() !== site.name) body.name = name.trim();
      if (zone !== site.timezone) body.timezone = zone;
      if (Object.keys(body).length) await api<Site>(`/sites/${site.id}`, { method: 'PATCH', body });
      onSaved();
      onClose();
    } catch (err) {
      setError(err as ApiError);
      setBusy(false);
    }
  }

  return (
    <Modal title={t('discovery.site.edit')} onClose={onClose}>
      <form onSubmit={save} className="space-y-3.5">
        <Field label={t('discovery.siteName')}>{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} />}</Field>
        <Field label={t('discovery.site.searchZone')}>
          {(id) => <Input id={id} type="search" dir="ltr" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Africa/Cairo" autoComplete="off" />}
        </Field>
        <Field label={t('discovery.site.zoneList')} hint={matches.length === 0 ? t('discovery.site.noZoneMatch') : undefined}>
          {(id) => (
            <select
              id={id}
              size={8}
              dir="ltr"
              value={zone}
              onChange={(e) => setZone(e.target.value)}
              className="mono w-full rounded-[var(--radius-control)] border border-line-strong bg-sunken p-1 text-[13px] text-fg focus:border-accent focus:outline-none"
            >
              {options.map((z) => (
                <option key={z} value={z} className="rounded-[4px] px-2 py-1">
                  {z}
                </option>
              ))}
            </select>
          )}
        </Field>
        {browserZone && browserZone !== zone && (
          <Button size="sm" variant="ghost" onClick={() => setZone(browserZone)}>
            {fill(t('discovery.site.useBrowser'), { zone: browserZone })}
          </Button>
        )}
        <ErrorNote error={error} />
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" variant="primary" busy={busy} disabled={!name.trim()}>
            {t('common.save')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
