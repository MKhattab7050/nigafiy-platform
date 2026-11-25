'use client';

import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { AccessPage, AccessProfile } from '@nigafiy/shared-types';
import { Badge, Button, Card, ErrorNote, useConfirm } from '@/components/ui';
import { type ApiError, api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { type Draft, TEMPLATES } from './profile-draft';
import { ProfileForm } from './profile-form';
import { PauseControl } from './pause-control';
import { accessText } from '../text';

export function Profiles({ data, site, admin, canPause, onChanged }: { data: AccessPage; site: string; admin: boolean; canPause: boolean; onChanged: () => void }) {
  const confirm = useConfirm();
  const { locale } = useI18n();
  const tx = accessText(locale);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const toDraft = (p: AccessProfile): Draft => ({
    id: p.id,
    name: p.name,
    blocked_categories: p.blocked_categories,
    blocked_domains: p.blocked_domains.join('\n'),
    allowed_domains: p.allowed_domains.join('\n'),
    schedule: p.schedule,
  });
  async function remove(p: AccessProfile) {
    if (!(await confirm(tx.deleteConfirm, { destructive: true }))) return;
    setError(null);
    try {
      await api(`/access/profiles/${p.id}`, { method: 'DELETE' });
      onChanged();
    } catch (e) {
      setError(e as ApiError);
    }
  }
  return (
    <Card
      title={tx.profiles}
      action={
        admin && !draft ? (
          <Button size="sm" onClick={() => setDraft({ name: tx.tplKids, ...TEMPLATES.kids! })}>
            <Plus className="size-3.5" aria-hidden />
            {tx.newProfile}
          </Button>
        ) : undefined
      }
    >
      <p className="mb-3 text-xs text-muted">{tx.profilesHint}</p>
      {error && (
        <div className="mb-3">
          <ErrorNote error={error} />
        </div>
      )}
      {draft && <ProfileForm draft={draft} setDraft={setDraft} categories={data.categories} site={site} onSaved={() => (setDraft(null), onChanged())} />}
      {data.profiles.length === 0 && !draft ? null : (
        <ul className="divide-y divide-line">
          {data.profiles.map((p) => (
            <li key={p.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="font-medium">
                  {p.name} <span className="text-xs font-normal text-muted">· {p.device_count} {tx.devicesIn}</span>
                </p>
                <p className="mt-1 flex flex-wrap gap-1">
                  {p.blocked_categories.map((c) => (
                    <Badge key={c} tone="crit" dot={false}>
                      {tx.cat[c] ?? c}
                    </Badge>
                  ))}
                  {p.blocked_domains.length > 0 && (
                    <Badge tone="idle" dot={false}>
                      {p.blocked_domains.length} {tx.blockedDomains.toLowerCase()}
                    </Badge>
                  )}
                </p>
                {p.schedule.map((w, i) => (
                  <p key={i} className="mt-1 text-xs text-muted">
                    🌙 {w.days.map((d) => tx.days[d]).join(locale === 'ar' ? '، ' : ', ')} · {w.from} → {w.to}
                  </p>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <PauseControl path={`/access/profiles/${p.id}/pause`} pausedUntil={p.paused_until} canPause={canPause} onChanged={onChanged} />
                {admin && (
                  <>
                    <Button size="sm" variant="ghost" onClick={() => setDraft(toDraft(p))} aria-label={tx.edit}>
                      <Pencil className="size-3.5" aria-hidden />
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => remove(p)} aria-label={tx.delete}>
                      <Trash2 className="size-3.5" aria-hidden />
                    </Button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
