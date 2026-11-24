'use client';

import { Check, Lock, LockKeyhole, Minus, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { FLEET_PERMISSION_KEYS, type FleetGroup, type FleetPermissionProfile } from '@nigafiy/shared-types';
import { Async, Badge, Button, Card, DataTable, Notice, PageHeader, Tag } from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { useI18n } from '@/lib/i18n';
import { ltr } from '@/lib/localize/bidi';
import { GroupEditor } from '../components/fleet-policy/group-editor';
import { codeMessage, policyText, profileLabel } from '../components/fleet-policy/policy-text';
import { ProfileEditor } from '../components/fleet-policy/profile-editor';

/**
 * Nigafiy Fleet → Access policies: permission profiles (built-ins and custom), fleet groups with
 * their access policy, and what no policy can turn off. Technicians read; admins change.
 */
export function FleetPoliciesScreen() {
  const { locale } = useI18n();
  const tx = policyText(locale);
  const { can } = useApp();
  const admin = can('admin');
  const profilesQ = useQuery<{ profiles: FleetPermissionProfile[] }>('/fleet/profiles', ['devices'], 60_000);
  const groupsQ = useQuery<{ groups: FleetGroup[] }>('/fleet/groups', ['devices'], 60_000);
  const [profileEdit, setProfileEdit] = useState<FleetPermissionProfile | 'new' | null>(null);
  const [groupEdit, setGroupEdit] = useState<FleetGroup | 'new' | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const reload = () => {
    void profilesQ.reload();
    void groupsQ.reload();
  };

  async function remove(path: string, confirmText: string) {
    if (!window.confirm(confirmText)) return;
    setError(null);
    try {
      await api(path, { method: 'DELETE' });
      reload();
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, 'error', String(err)));
    }
  }

  const profiles = profilesQ.data?.profiles ?? [];
  const nameOf = (id: string) => {
    const p = profiles.find((x) => x.id === id);
    return p ? profileLabel(tx, p) : '—';
  };

  return (
    <div className="space-y-5">
      <PageHeader title={tx.pageTitle} description={tx.pageSub} icon={<LockKeyhole className="size-5" aria-hidden />} />
      {!admin && <Notice>{tx.readOnly}</Notice>}
      {error && (
        <p role="alert" className="rounded-md border border-crit/30 bg-crit/[0.07] px-3 py-2 text-sm">
          {codeMessage(tx, error)}
        </p>
      )}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <Card
          title={tx.groups}
          description={tx.groupsNote}
          action={
            admin && profiles.length > 0 ? (
              <Button size="sm" variant="primary" onClick={() => setGroupEdit('new')}>
                <Plus className="size-3.5" aria-hidden />
                {tx.newGroup}
              </Button>
            ) : undefined
          }
        >
          <Async query={groupsQ}>
            {({ groups }) => (
              <ul className="divide-y divide-line">
                {groups.map((g) => (
                  <li key={g.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
                    <div className="min-w-0 space-y-1">
                      <p className="flex items-center gap-2 text-sm font-medium" dir="auto">
                        <span className="size-2.5 shrink-0 rounded-full" style={{ background: g.color ?? 'var(--line-strong)' }} aria-hidden />
                        {g.name}
                        <span className="text-xs font-normal text-muted">{tx.members(g.endpoint_count)}</span>
                      </p>
                      {g.description && (
                        <p className="text-xs text-muted" dir="auto">
                          {g.description}
                        </p>
                      )}
                      <div className="flex flex-wrap gap-1">
                        <Badge tone={g.access_mode === 'attended' ? 'ok' : 'info'}>{g.access_mode === 'attended' ? tx.attended : tx.unattended}</Badge>
                        {g.mfa_required && <Badge tone="info">MFA</Badge>}
                        {g.approval_required && g.access_mode === 'unattended' && <Badge tone="warn">{tx.approvals}</Badge>}
                        <Tag>{`${tx.defaultProfile}: ${nameOf(g.default_profile_id)}`}</Tag>
                        <Tag>{`${tx.maxProfile}: ${nameOf(g.max_profile_id)}`}</Tag>
                        <Tag>{`${tx.hours}: ${g.allowed_hours.length ? g.allowed_hours.map((w) => `${w.days.map((d) => tx.days[d]).join(' ')} ${ltr(`${w.start}–${w.end}`)}`).join(' · ') : tx.hoursAny}`}</Tag>
                        <Tag>{`${tx.roles}: ${g.allowed_roles.map((r) => tx.role[r]).join(', ')}`}</Tag>
                        <Tag>{`${tx.ipList}: ${g.ip_allowlist.length ? ltr(g.ip_allowlist.join(', ')) : tx.ipAny}`}</Tag>
                      </div>
                    </div>
                    {admin && (
                      <div className="flex gap-1.5">
                        <Button size="sm" onClick={() => setGroupEdit(g)}>
                          <Pencil className="size-3.5" aria-hidden />
                          {tx.edit}
                        </Button>
                        <Button size="sm" variant="danger" onClick={() => void remove(`/fleet/groups/${g.id}`, tx.confirmDeleteGroup(g.name))} aria-label={`${tx.delete} ${g.name}`}>
                          <Trash2 className="size-3.5" aria-hidden />
                        </Button>
                      </div>
                    )}
                  </li>
                ))}
                <li className="py-3">
                  <p className="text-sm font-medium">{tx.orgDefault}</p>
                  <p className="text-xs text-muted">{tx.orgDefaultNote}</p>
                </li>
                {groups.length === 0 && <li className="py-3 text-sm text-muted">{tx.noGroups}</li>}
              </ul>
            )}
          </Async>
        </Card>

        {/* Transparency: these stay on whatever a policy or profile says. */}
        <Card title={tx.lockH}>
          <ul className="space-y-2 text-sm">
            {tx.locked.map((l) => (
              <li key={l} className="flex items-start gap-2">
                <Lock className="mt-0.5 size-3.5 shrink-0 text-ok" aria-hidden />
                {l}
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <Card
        title={tx.profiles}
        description={tx.profNote}
        action={
          admin ? (
            <Button size="sm" variant="primary" onClick={() => setProfileEdit('new')}>
              <Plus className="size-3.5" aria-hidden />
              {tx.newProfile}
            </Button>
          ) : undefined
        }
      >
        <Async query={profilesQ}>
          {({ profiles: list }) => (
            <DataTable minWidth={560}>
              <thead>
                <tr>
                  <th>{tx.permission}</th>
                  {list.map((p) => (
                    <th key={p.id} className="text-center">
                      <span className="block" dir="auto">
                        {profileLabel(tx, p)}
                      </span>
                      {p.builtin_key ? (
                        <Tag>{tx.builtinTag}</Tag>
                      ) : (
                        admin && (
                          <span className="mt-1 inline-flex gap-1">
                            <Button size="sm" onClick={() => setProfileEdit(p)} aria-label={`${tx.edit} ${p.name}`} title={tx.edit}>
                              <Pencil className="size-3" aria-hidden />
                            </Button>
                            <Button
                              size="sm"
                              variant="danger"
                              disabled={p.used_by_groups > 0}
                              title={p.used_by_groups > 0 ? tx.usedBy(p.used_by_groups) : tx.delete}
                              aria-label={`${tx.delete} ${p.name}`}
                              onClick={() => void remove(`/fleet/profiles/${p.id}`, tx.confirmDeleteProfile(p.name))}
                            >
                              <Trash2 className="size-3" aria-hidden />
                            </Button>
                          </span>
                        )
                      )}
                      {p.used_by_groups > 0 && <span className="block text-[11px] font-normal text-faint">{tx.usedBy(p.used_by_groups)}</span>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {FLEET_PERMISSION_KEYS.map((k) => (
                  <tr key={k}>
                    <td>{tx.perm[k]}</td>
                    {list.map((p) => (
                      <td key={p.id} className="text-center">
                        {p[k] ? <Check className="mx-auto size-4 text-ok" aria-label={tx.pass} /> : <Minus className="mx-auto size-4 text-faint" aria-label={tx.fail} />}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </DataTable>
          )}
        </Async>
      </Card>

      {profileEdit && <ProfileEditor profile={profileEdit === 'new' ? null : profileEdit} onClose={() => setProfileEdit(null)} onSaved={reload} />}
      {groupEdit && <GroupEditor group={groupEdit === 'new' ? null : groupEdit} profiles={profiles} onClose={() => setGroupEdit(null)} onSaved={reload} />}
    </div>
  );
}
