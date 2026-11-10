'use client';

import { CheckCircle2, CircleAlert, ExternalLink, Pencil, Plus, ShieldCheck, ShieldOff, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { type AccessPage, type AccessProfile, CategoryPicker, PauseControl, ScheduleEditor, type ScheduleWindow, linesToList } from '@/components/access';
import { Async, Badge, Button, Card, CopyBlock, EmptyState, ErrorNote, Field, Input, PageHeader, Select, StatusBadge, Textarea } from '@/components/ui';
import { type ApiError, api, qs } from '@/lib/api';
import { accessText } from '@/lib/access-text';
import { useApp, useQuery } from '@/lib/app';
import { useI18n } from '@/lib/i18n';

type Draft = { id?: string; name: string; blocked_categories: string[]; blocked_domains: string; allowed_domains: string; schedule: ScheduleWindow[] };

const TEMPLATES: Record<string, Omit<Draft, 'name'>> = {
  kids: { blocked_categories: ['adult', 'gambling', 'ads_malware'], blocked_domains: '', allowed_domains: '', schedule: [{ days: [0, 1, 2, 3, 4], from: '22:00', to: '07:00' }, { days: [5, 6], from: '23:30', to: '08:00' }] },
  guests: { blocked_categories: ['adult', 'gambling', 'ads_malware'], blocked_domains: '', allowed_domains: '', schedule: [] },
  focus: { blocked_categories: ['social', 'video', 'games'], blocked_domains: '', allowed_domains: '', schedule: [] },
  blank: { blocked_categories: [], blocked_domains: '', allowed_domains: '', schedule: [] },
};

export default function AccessPageView() {
  const { locale } = useI18n();
  const tx = accessText(locale);
  const { siteId, sites, can } = useApp();
  const site = siteId ?? sites[0]?.id ?? null;
  const query = useQuery<AccessPage>(site ? `/access${qs({ site_id: site })}` : null, ['devices', 'collectors'], 20_000);
  const admin = can('admin');

  return (
    <>
      <PageHeader title={tx.title} description={tx.subtitle} />
      {!site ? null : (
        <Async query={query}>
          {(data) => (
            <div className="space-y-4">
              <MasterSwitch data={data} site={site} admin={admin} onChanged={query.reload} />
              {data.settings.enabled && <Setup data={data} />}
              <SiteRules data={data} site={site} admin={admin} onChanged={query.reload} />
              <Profiles data={data} site={site} admin={admin} canPause={can('technician')} onChanged={query.reload} />
              <Devices data={data} admin={admin} canPause={can('technician')} onChanged={query.reload} />
            </div>
          )}
        </Async>
      )}
    </>
  );
}

function MasterSwitch({ data, site, admin, onChanged }: { data: AccessPage; site: string; admin: boolean; onChanged: () => void }) {
  const { locale } = useI18n();
  const tx = accessText(locale);
  const [busy, setBusy] = useState(false);
  const on = data.settings.enabled;
  async function toggle() {
    if (!window.confirm(on ? tx.disableConfirm : tx.enableConfirm)) return;
    setBusy(true);
    try {
      await api('/access/settings', { method: 'PUT', body: { site_id: site, enabled: !on } });
      onChanged();
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          {on ? <ShieldCheck className="size-6 text-ok" aria-hidden /> : <ShieldOff className="size-6 text-faint" aria-hidden />}
          <div>
            <p className="font-medium">{on ? tx.enabled : tx.enable}</p>
            {on && (
              <p className="text-xs text-muted">
                <span className="tnum">{data.setup.protected_devices}</span> {tx.protectedCount}
              </p>
            )}
          </div>
        </div>
        {admin ? (
          <Button variant={on ? 'secondary' : 'primary'} busy={busy} onClick={toggle}>
            {on ? tx.disable : tx.enable}
          </Button>
        ) : (
          <span className="text-xs text-muted">{tx.onlyAdmins}</span>
        )}
      </div>
    </Card>
  );
}

function Setup({ data }: { data: AccessPage }) {
  const { locale } = useI18n();
  const tx = accessText(locale);
  const st = data.setup;
  const running = st.collector?.online && st.status?.listening;
  return (
    <Card title={tx.setup}>
      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        {running ? (
          <Badge tone="ok">
            <CheckCircle2 className="size-3" aria-hidden /> {tx.statusListening}
          </Badge>
        ) : (
          <Badge tone="crit">
            <CircleAlert className="size-3" aria-hidden /> {st.collector?.online ? tx.statusNotListening : tx.statusOff}
          </Badge>
        )}
        {st.status?.error && <span className="text-xs text-crit">{st.status.error}</span>}
        {st.status?.list_error && <span className="text-xs text-warn">{st.status.list_error}</span>}
      </div>
      <p className="mb-2 text-sm text-muted">{tx.setupIntro}</p>
      <ol className="list-decimal space-y-2 ps-5 text-sm">
        <li>
          {tx.step1}
          {st.gateway_ip && (
            <a href={`http://${st.gateway_ip}/`} target="_blank" rel="noreferrer" className="ms-2 inline-flex items-center gap-1 text-accent hover:underline">
              http://{st.gateway_ip}/ <ExternalLink className="size-3" aria-hidden />
            </a>
          )}
        </li>
        <li>
          {tx.step2} {st.dns_server_ip ? <span className="inline-block align-middle"><CopyBlock value={st.dns_server_ip} /></span> : <em>{tx.step2NoIp}</em>}
        </li>
        <li>{tx.step3}</li>
        <li>{tx.step4}</li>
      </ol>
      <p className="mt-3 text-xs text-muted">{tx.stepAlt}</p>
      <p className="mt-1 text-xs text-warn">{tx.keepOn}</p>
      <p className="mt-3 border-t border-line pt-3 text-xs text-faint">{tx.limits}</p>
    </Card>
  );
}

function SiteRules({ data, site, admin, onChanged }: { data: AccessPage; site: string; admin: boolean; onChanged: () => void }) {
  const { locale } = useI18n();
  const tx = accessText(locale);
  const [cats, setCats] = useState(data.settings.blocked_categories);
  const [blocked, setBlocked] = useState(data.settings.blocked_domains.join('\n'));
  const [allowed, setAllowed] = useState(data.settings.allowed_domains.join('\n'));
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api('/access/settings', { method: 'PUT', body: { site_id: site, blocked_categories: cats, blocked_domains: linesToList(blocked), allowed_domains: linesToList(allowed) } });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      onChanged();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card title={tx.siteRules}>
      <p className="mb-3 text-xs text-muted">{tx.siteRulesHint}</p>
      <div className="space-y-4">
        <div>
          <p className="mb-2 text-xs font-medium text-muted">{tx.categories}</p>
          <CategoryPicker all={data.categories} value={cats} onChange={setCats} disabled={!admin} />
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <Field label={tx.blockedDomains} hint={tx.domainsHint}>
            {(id) => <Textarea id={id} rows={4} dir="ltr" value={blocked} disabled={!admin} onChange={(e) => setBlocked(e.target.value)} placeholder="tiktok.com" />}
          </Field>
          <Field label={tx.allowedDomains} hint={tx.domainsHint}>
            {(id) => <Textarea id={id} rows={4} dir="ltr" value={allowed} disabled={!admin} onChange={(e) => setAllowed(e.target.value)} placeholder="khanacademy.org" />}
          </Field>
        </div>
        {error && <ErrorNote error={error} />}
        {admin && (
          <Button variant="primary" busy={busy} onClick={save}>
            {saved ? tx.saved : tx.save}
          </Button>
        )}
      </div>
    </Card>
  );
}

function Profiles({ data, site, admin, canPause, onChanged }: { data: AccessPage; site: string; admin: boolean; canPause: boolean; onChanged: () => void }) {
  const { locale } = useI18n();
  const tx = accessText(locale);
  const [draft, setDraft] = useState<Draft | null>(null);
  const toDraft = (p: AccessProfile): Draft => ({
    id: p.id,
    name: p.name,
    blocked_categories: p.blocked_categories,
    blocked_domains: p.blocked_domains.join('\n'),
    allowed_domains: p.allowed_domains.join('\n'),
    schedule: p.schedule,
  });
  async function remove(p: AccessProfile) {
    if (!window.confirm(tx.deleteConfirm)) return;
    await api(`/access/profiles/${p.id}`, { method: 'DELETE' });
    onChanged();
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

function ProfileForm({ draft, setDraft, categories, site, onSaved }: { draft: Draft; setDraft: (d: Draft | null) => void; categories: string[]; site: string; onSaved: () => void }) {
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

function Devices({ data, admin, canPause, onChanged }: { data: AccessPage; admin: boolean; canPause: boolean; onChanged: () => void }) {
  const { locale } = useI18n();
  const tx = accessText(locale);
  const [saving, setSaving] = useState<string | null>(null);
  async function setProfile(id: string, profile_id: string) {
    setSaving(id);
    try {
      await api(`/devices/${id}/access`, { method: 'PATCH', body: { profile_id: profile_id || null } });
      onChanged();
    } finally {
      setSaving(null);
    }
  }
  if (!data.devices.length) return <EmptyState title={tx.devices} />;
  return (
    <Card title={tx.devices} padded={false}>
      <p className="px-4 pt-3 text-xs text-muted">{tx.devicesHint}</p>
      <ul className="divide-y divide-line">
        {data.devices.map((d) => (
          <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <div className="min-w-0">
              <Link href={`/devices/${d.id}`} className="block truncate font-medium hover:text-accent-hover" dir="auto">
                {d.name}
              </Link>
              <p className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted">
                <StatusBadge status={d.status as 'online'} />
                <span className="mono">{d.ip ?? '—'}</span>
                {data.settings.enabled && (
                  <Badge tone={d.protected ? 'ok' : 'idle'} dot>
                    {d.protected ? tx.protected : tx.notProtected}
                  </Badge>
                )}
                {(d.queries_24h > 0 || d.blocked_24h > 0) && (
                  <span className="tnum">
                    {d.queries_24h} {tx.queries} · <span className={d.blocked_24h ? 'text-crit' : ''}>{d.blocked_24h} {tx.blocked}</span> ({tx.activity24})
                  </span>
                )}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Select
                aria-label={tx.profile}
                value={d.profile_id ?? ''}
                disabled={!admin || saving === d.id}
                onChange={(e) => setProfile(d.id, e.target.value)}
                className="!h-8 w-44 text-xs"
              >
                <option value="">{tx.noProfile}</option>
                {data.profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
              <PauseControl path={`/devices/${d.id}/pause`} pausedUntil={d.paused_until} internetOff={d.internet_off} canPause={canPause} onChanged={onChanged} />
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}
