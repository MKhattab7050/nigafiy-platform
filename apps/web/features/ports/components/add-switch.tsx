'use client';

import { useState } from 'react';
import type { Site } from '@lan-detective/shared-types';
import { Button, Card, ErrorNote, Field, Input, Select } from '@/components/ui';
import { type ApiError, api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { portsText } from '../text';
import {
  SnmpCredentialsFields,
  buildSnmpCredentials,
  initialCredentialsDraft,
  snmpCredentialsReady,
} from './snmp-credentials-fields';
import { SwitchCandidates } from './switch-candidates';

export function AddSwitch({ siteId, sites, onDone }: { siteId: string | null; sites?: Site[]; onDone: (id?: string) => void }) {
  const { locale, t } = useI18n();
  const tx = portsText(locale);
  const [chosenSite, setChosenSite] = useState(sites?.[0]?.id ?? '');
  const site = siteId ?? (sites?.some((s) => s.id === chosenSite) ? chosenSite : sites?.[0]?.id ?? '');
  const [host, setHost] = useState('');
  const [name, setName] = useState('');
  const [creds, setCreds] = useState(() => initialCredentialsDraft('2c'));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  async function save() {
    if (!site) return;
    setBusy(true);
    setError(null);
    const credentials = buildSnmpCredentials(creds);
    try {
      const res = await api<{ id: string }>('/switches', { method: 'POST', body: { site_id: site, host: host.trim(), ...(name.trim() ? { name: name.trim() } : {}), credentials } });
      onDone(res.id);
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  }
  const ready = Boolean(site && host.trim() && snmpCredentialsReady(creds));

  return (
    <Card title={tx.addSwitch}>
      {!siteId && sites && sites.length > 1 && (
        <div className="mb-4 max-w-sm">
          <Field label={t('common.site')}>
            {(id) => (
              <Select id={id} value={site} onChange={(e) => setChosenSite(e.target.value)}>
                {sites.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
      )}
      {site && (
        <SwitchCandidates
          site={site}
          chosen={host.trim()}
          onChoose={(c) => {
            // Only the address (and, when empty, the name) is filled in; SNMP credentials stay empty for the admin to type.
            if (c.ip) setHost(c.ip);
            if (!name.trim()) setName(c.label.slice(0, 80));
          }}
        />
      )}
      <div className="grid gap-3 md:grid-cols-2">
        <Field label={tx.host} hint={tx.hostHint}>
          {(id) => <Input id={id} dir="ltr" value={host} onChange={(e) => setHost(e.target.value)} placeholder="192.168.1.2" maxLength={15} />}
        </Field>
        <Field label={tx.name}>{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />}</Field>
        <SnmpCredentialsFields value={creds} onChange={setCreds} tx={tx} />
      </div>
      {error && (
        <div className="mt-3">
          <ErrorNote error={error} />
        </div>
      )}
      <div className="mt-4 flex gap-2">
        <Button variant="primary" busy={busy} disabled={!ready} onClick={save}>
          {tx.save}
        </Button>
        <Button variant="ghost" onClick={() => onDone()}>
          {tx.cancel}
        </Button>
      </div>
    </Card>
  );
}
