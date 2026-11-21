'use client';

import { useState } from 'react';
import { Button, ErrorNote, Field, Input, Textarea } from '@/components/ui';
import { type ApiError, api, qs } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { type Draft, TEMPLATES } from './profile-draft';
import { linesToList, CategoryPicker, ScheduleEditor } from './rule-editors';
import { accessText } from '../text';

export function ProfileForm({ draft, setDraft, categories, site, onSaved }: { draft: Draft; setDraft: (d: Draft | null) => void; categories: string[]; site: string; onSaved: () => void }) {
  const { locale } = useI18n();
  const tx = accessText(locale);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  async function save() {
    setBusy(true);
    setError(null);
    const body = {
      name: draft.name,
      blocked_categories: draft.blocked_categories,
      blocked_domains: linesToList(draft.blocked_domains),
      allowed_domains: linesToList(draft.allowed_domains),
      schedule: draft.schedule,
    };
    try {
      if (draft.id) await api(`/access/profiles/${draft.id}`, { method: 'PATCH', body });
      else await api(`/access/profiles${qs({ site_id: site })}`, { method: 'POST', body });
      onSaved();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mb-4 space-y-3 rounded-lg border border-line-strong bg-raised/40 p-3">
      {!draft.id && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
          {tx.templates}:
          {(
            [
              ['kids', tx.tplKids],
              ['guests', tx.tplGuests],
              ['focus', tx.tplFocus],
              ['blank', tx.tplBlank],
            ] as const
          ).map(([k, label]) => (
            <Button key={k} size="sm" variant="ghost" onClick={() => setDraft({ name: k === 'blank' ? '' : label, ...TEMPLATES[k]! })}>
              {label}
            </Button>
          ))}
        </div>
      )}
      <Field label={tx.name}>{(id) => <Input id={id} value={draft.name} maxLength={60} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />}</Field>
      <div>
        <p className="mb-2 text-xs font-medium text-muted">{tx.categories}</p>
        <CategoryPicker all={categories} value={draft.blocked_categories} onChange={(v) => setDraft({ ...draft, blocked_categories: v })} />
      </div>
      <div>
        <p className="mb-2 text-xs font-medium text-muted">{tx.bedtime}</p>
        <ScheduleEditor value={draft.schedule} onChange={(v) => setDraft({ ...draft, schedule: v })} />
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <Field label={tx.blockedDomains} hint={tx.domainsHint}>
          {(id) => <Textarea id={id} rows={3} dir="ltr" value={draft.blocked_domains} onChange={(e) => setDraft({ ...draft, blocked_domains: e.target.value })} />}
        </Field>
        <Field label={tx.allowedDomains} hint={tx.domainsHint}>
          {(id) => <Textarea id={id} rows={3} dir="ltr" value={draft.allowed_domains} onChange={(e) => setDraft({ ...draft, allowed_domains: e.target.value })} />}
        </Field>
      </div>
      {error && <ErrorNote error={error} />}
      <div className="flex gap-2">
        <Button variant="primary" busy={busy} disabled={!draft.name.trim()} onClick={save}>
          {tx.save}
        </Button>
        <Button variant="ghost" onClick={() => setDraft(null)}>
          {tx.cancel}
        </Button>
      </div>
    </div>
  );
}
