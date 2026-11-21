'use client';

import { useState } from 'react';
import { Async, Badge, Button, Card, ErrorNote, Field, Select } from '@/components/ui';
import { type ApiError, api } from '@/lib/api';
import { useQuery } from '@/lib/app';
import { useI18n } from '@/lib/i18n';
import { controlText } from '../control-text';
import type { SitePortControl } from '../control-types';

/** Ports page → the site's port-control settings (the quarantine VLAN). */
export function SitePortControlCard({ siteId, admin }: { siteId: string; admin: boolean }) {
  const { locale } = useI18n();
  const cx = controlText(locale);
  const q = useQuery<SitePortControl>(`/sites/${siteId}/port-control`, ['devices'], 60_000);
  return (
    <Card title={cx.siteSettings}>
      <Async query={q}>{(s) => <SiteForm key={`${s.site_id}:${s.quarantine_vlan}`} s={s} admin={admin} onSaved={q.reload} />}</Async>
    </Card>
  );
}

function SiteForm({ s, admin, onSaved }: { s: SitePortControl; admin: boolean; onSaved: () => void }) {
  const { locale } = useI18n();
  const cx = controlText(locale);
  const [value, setValue] = useState(s.quarantine_vlan === null ? '' : String(s.quarantine_vlan));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [saved, setSaved] = useState(false);
  const changed = value !== (s.quarantine_vlan === null ? '' : String(s.quarantine_vlan));
  // The configured VLAN stays selectable even when no read switch currently reports it.
  const options = s.quarantine_vlan !== null && !s.vlans.some((v) => v.id === s.quarantine_vlan) ? [{ id: s.quarantine_vlan, name: null, switches: 0 }, ...s.vlans] : s.vlans;
  const missing = s.switches.filter((x) => x.quarantine_vlan === null && x.quarantine_vlan_present === false);

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await api(`/sites/${s.site_id}/port-control`, { method: 'PUT', body: { quarantine_vlan: value ? Number(value) : null } });
      setSaved(true);
      onSaved();
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted">{cx.siteSettingsIntro}</p>
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-[240px] flex-1">
          <Field label={cx.quarantineVlan} hint={cx.siteVlanHint}>
            {(id) => (
              <Select id={id} value={value} disabled={!admin} onChange={(e) => (setValue(e.target.value), setSaved(false))}>
                <option value="">{cx.noneOption}</option>
                {options.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.id}
                    {v.name ? ` · ${v.name}` : ''} ({v.switches} {cx.onSwitches})
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        {admin && (
          <Button size="sm" busy={busy} disabled={!changed} onClick={save}>
            {cx.save}
          </Button>
        )}
        {saved && <span className="text-xs text-ok">{cx.saved}</span>}
      </div>
      {missing.length > 0 && (
        <p className="text-xs text-warn">
          {cx.notOnSwitch}:{' '}
          {missing.map((x) => (
            <span key={x.id} className="me-1">
              <Badge tone="warn" dot={false}>
                <span dir="auto">{x.name}</span>
              </Badge>
            </span>
          ))}
        </p>
      )}
      {error && <ErrorNote error={error} />}
    </div>
  );
}
