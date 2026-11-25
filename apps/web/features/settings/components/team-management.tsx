'use client';

import { KeyRound, Trash2, UserPlus } from 'lucide-react';
import { useState } from 'react';
import {
  type InvitationCreated,
  type MfaRequirement,
  type PasswordResetIssued,
  ROLES,
  type Role,
  type TeamOverview,
} from '@nigafiy/shared-types';
import { Async, Badge, Button, Card, CopyBlock, ErrorNote, Field, Input, Modal, Select } from '@/components/ui';
import { type ApiError, api } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { relativeTime } from '@/lib/format';
import { type Key, useI18n } from '@/lib/i18n';

export function TeamManagement() {
  const { t, locale } = useI18n();
  const { me, reloadMe } = useApp();
  const query = useQuery<TeamOverview>('/team', [], 30_000);

  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<Role>('technician');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const [createdInvite, setCreatedInvite] = useState<InvitationCreated | null>(null);
  const [issuedReset, setIssuedReset] = useState<{ email: string; res: PasswordResetIssued } | null>(null);

  const act = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      query.reload();
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy('');
    }
  };

  const availableRoles = ROLES.filter((r) => r !== 'owner' || me.role === 'owner');

  return (
    <Card title={t('settings.team.title')}>
      <div className="space-y-5">
        {error && <ErrorNote error={error} />}

        <Async query={query}>
          {(team) => (
            <div className="space-y-6">
              {/* Organization MFA Requirement */}
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div className="min-w-64 flex-1 max-w-sm">
                  <Field label={t('settings.team.mfaPolicy')}>
                    {(id) => (
                      <Select
                        id={id}
                        value={team.mfa_required}
                        disabled={busy === 'mfa-policy'}
                        onChange={(e) => {
                          const next = e.target.value as MfaRequirement;
                          void act('mfa-policy', async () => {
                            await api('/team/security', {
                              method: 'PATCH',
                              body: { mfa_required: next },
                            });
                            reloadMe();
                          });
                        }}
                      >
                        <option value="off">{t('settings.team.mfaPolicy.off')}</option>
                        <option value="admins">{t('settings.team.mfaPolicy.admins')}</option>
                        <option value="all">{t('settings.team.mfaPolicy.all')}</option>
                      </Select>
                    )}
                  </Field>
                </div>
              </div>

              {/* Invite new member */}
              <form
                className="space-y-3 border-t border-line pt-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!inviteEmail.trim()) return;
                  void act('invite', async () => {
                    const res = await api<InvitationCreated>('/team/invitations', {
                      method: 'POST',
                      body: { email: inviteEmail.trim(), role: inviteRole },
                    });
                    setInviteEmail('');
                    setCreatedInvite(res);
                  });
                }}
              >
                <h3 className="text-[13px] font-semibold text-fg">{t('settings.team.inviteTitle')}</h3>
                <div className="grid gap-2 sm:grid-cols-[1fr_11rem_auto]">
                  <Input
                    type="email"
                    dir="ltr"
                    required
                    placeholder="colleague@example.com"
                    aria-label={t('auth.email')}
                    value={inviteEmail}
                    onChange={(e) => setInviteEmail(e.target.value)}
                  />
                  <Select
                    aria-label={t('settings.role')}
                    value={inviteRole}
                    onChange={(e) => setInviteRole(e.target.value as Role)}
                  >
                    {availableRoles.map((r) => (
                      <option key={r} value={r}>
                        {t(('control.role.' + r) as Key)}
                      </option>
                    ))}
                  </Select>
                  <Button type="submit" variant="primary" busy={busy === 'invite'} disabled={!inviteEmail.trim()}>
                    <UserPlus className="size-4" aria-hidden />
                    {t('settings.team.inviteBtn')}
                  </Button>
                </div>
              </form>

              {createdInvite && (
                <div className="space-y-2 rounded-md border border-accent/30 bg-accent/[0.06] p-3">
                  <p className="text-xs font-medium text-fg">{t('settings.team.inviteCreated')}</p>
                  <CopyBlock value={createdInvite.invite_url} />
                </div>
              )}

              {/* Pending Invitations */}
              {team.invitations.length > 0 && (
                <div className="space-y-2 border-t border-line pt-4">
                  <h3 className="text-[13px] font-semibold text-fg">{t('settings.team.pendingInvites')}</h3>
                  <ul className="divide-y divide-line rounded-md border border-line">
                    {team.invitations.map((inv) => (
                      <li key={inv.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5 text-[13px]">
                        <span className="mono font-medium">{inv.email}</span>
                        <Badge tone="info" dot={false}>
                          {t(('control.role.' + inv.role) as Key)}
                        </Badge>
                        <span className="text-xs text-faint">{relativeTime(inv.created_at, locale)}</span>
                        <span className="ms-auto">
                          <Button
                            size="sm"
                            variant="ghost"
                            busy={busy === `rev-${inv.id}`}
                            onClick={() =>
                              void act(`rev-${inv.id}`, async () => {
                                await api(`/team/invitations/${inv.id}`, { method: 'DELETE' });
                              })
                            }
                          >
                            <Trash2 className="size-3.5" aria-hidden />
                            {t('settings.team.revokeInvite')}
                          </Button>
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Members list */}
              <div className="space-y-2 border-t border-line pt-4">
                <h3 className="text-[13px] font-semibold text-fg">{t('settings.team.members')}</h3>
                <ul className="divide-y divide-line rounded-md border border-line">
                  {team.members.map((m) => {
                    const isSelf = m.id === me.user.id;
                    const canManageMember = m.role !== 'owner' || me.role === 'owner';
                    return (
                      <li key={m.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5 text-[13px]">
                        <div className="min-w-44">
                          <p className="font-medium text-fg" dir="auto">
                            {m.display_name}
                          </p>
                          <p className="mono text-xs text-muted">{m.email}</p>
                        </div>

                        <Badge tone={m.status === 'active' ? 'ok' : 'idle'}>
                          {t(`settings.team.status.${m.status}` as Key)}
                        </Badge>

                        {m.mfa_enabled && (
                          <Badge tone="info" dot={false}>
                            2FA
                          </Badge>
                        )}

                        <div className="ms-auto flex flex-wrap items-center gap-2">
                          {canManageMember ? (
                            <Select
                              aria-label={`${t('settings.role')}: ${m.email}`}
                              value={m.role}
                              className="w-36"
                              disabled={busy === `role-${m.id}`}
                              onChange={(e) => {
                                const nextRole = e.target.value as Role;
                                void act(`role-${m.id}`, async () => {
                                  await api(`/team/members/${m.id}`, {
                                    method: 'PATCH',
                                    body: { role: nextRole },
                                  });
                                });
                              }}
                            >
                              {availableRoles.map((r) => (
                                <option key={r} value={r}>
                                  {t(('control.role.' + r) as Key)}
                                </option>
                              ))}
                            </Select>
                          ) : (
                            <Badge tone="idle" dot={false}>
                              {t(('control.role.' + m.role) as Key)}
                            </Badge>
                          )}

                          {canManageMember && (m.role !== 'admin' || me.role === 'owner') && (
                            <Button
                              size="sm"
                              variant="ghost"
                              busy={busy === `pw-${m.id}`}
                              onClick={() =>
                                void act(`pw-${m.id}`, async () => {
                                  const res = await api<PasswordResetIssued>(
                                    `/team/members/${m.id}/reset-password`,
                                    { method: 'POST' },
                                  );
                                  setIssuedReset({ email: m.email, res });
                                })
                              }
                            >
                              <KeyRound className="size-3.5" aria-hidden />
                              {t('settings.team.resetPassword')}
                            </Button>
                          )}

                          {canManageMember && !isSelf && (
                            <Button
                              size="sm"
                              variant="ghost"
                              busy={busy === `st-${m.id}`}
                              onClick={() =>
                                void act(`st-${m.id}`, async () => {
                                  await api(`/team/members/${m.id}`, {
                                    method: 'PATCH',
                                    body: { status: m.status === 'active' ? 'deactivated' : 'active' },
                                  });
                                })
                              }
                            >
                              {m.status === 'active'
                                ? t('settings.team.deactivate')
                                : t('settings.team.reactivate')}
                            </Button>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            </div>
          )}
        </Async>
      </div>

      {issuedReset && (
        <Modal
          title={`${t('settings.team.resetPassword')} — ${issuedReset.email}`}
          onClose={() => setIssuedReset(null)}
        >
          <div className="space-y-4">
            <p className="text-[13px] text-muted">{t('settings.team.resetIssued')}</p>
            <CopyBlock value={issuedReset.res.reset_url} />
            <div className="flex justify-end">
              <Button variant="primary" onClick={() => setIssuedReset(null)}>
                {t('common.close')}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </Card>
  );
}
