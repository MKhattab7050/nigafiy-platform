'use client';

import { useEffect, useState } from 'react';
import { Async, Button, Card, ErrorNote, Field, Input, Switch } from '@/components/ui';
import { type ApiError, api } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { fill } from '@/lib/i18n';
import type { PlaybookSettings } from '../types';
import { usePbText } from './common';

/** The organization's approval rules (two-person rule, how long a request stays open). Admin writes; everyone reads. */
export function SettingsCard() {
  const tx = usePbText();
  const query = useQuery<PlaybookSettings>('/playbooks/settings', ['events'], 0);
  return (
    <Card title={tx.settingsTitle}>
      <Async query={query}>{(s) => <SettingsForm settings={s} onSaved={query.reload} />}</Async>
    </Card>
  );
}

function SettingsForm({ settings, onSaved }: { settings: PlaybookSettings; onSaved: () => void }) {
  const tx = usePbText();
  const { can } = useApp();
  const admin = can('admin');
  const [twoPerson, setTwoPerson] = useState(settings.two_person_rule);
  const [ttl, setTtl] = useState(String(settings.approval_ttl_minutes));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setTwoPerson(settings.two_person_rule);
    setTtl(String(settings.approval_ttl_minutes));
  }, [settings.two_person_rule, settings.approval_ttl_minutes]);

  const ttlNum = Number(ttl);
  const changed: Partial<Pick<PlaybookSettings, 'two_person_rule' | 'approval_ttl_minutes'>> = {};
  if (twoPerson !== settings.two_person_rule) changed.two_person_rule = twoPerson;
  if (ttlNum !== settings.approval_ttl_minutes) changed.approval_ttl_minutes = ttlNum;
  const dirty = Object.keys(changed).length > 0;

  const save = async () => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await api('/playbooks/settings', { method: 'PUT', body: changed });
      setSaved(true);
      onSaved();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  const ttlError = error?.details?.find((d) => d.path === 'approval_ttl_minutes')?.message;
  return (
    <div className="space-y-4">
      {!admin && <p className="text-xs text-muted">{tx.settingsReadOnly}</p>}
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-[13px] font-medium">{tx.twoPerson}</p>
          <p className="mt-0.5 text-xs text-muted">{tx.twoPersonHint}</p>
        </div>
        <Switch checked={twoPerson} onChange={setTwoPerson} disabled={!admin} label={tx.twoPerson} />
      </div>
      <Field label={tx.ttl} hint={tx.ttlHint} error={ttlError}>
        {(id) => <Input id={id} type="number" min={5} max={1440} value={ttl} disabled={!admin} onChange={(e) => setTtl(e.target.value)} className="w-32" />}
      </Field>
      <p className="text-xs text-muted">{fill(tx.approversCount, { n: settings.approvers })}</p>
      {error && !ttlError && <ErrorNote error={error} />}
      {admin && (
        <div className="flex items-center gap-3">
          <Button variant="primary" size="sm" busy={busy} disabled={!dirty} onClick={() => void save()}>
            {tx.save}
          </Button>
          {saved && !dirty && <span className="text-xs text-ok">{tx.saved}</span>}
        </div>
      )}
    </div>
  );
}
