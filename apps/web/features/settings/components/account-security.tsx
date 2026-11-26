'use client';

import { KeyRound, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import type { MfaConfirmResponse, MfaSetupResponse } from '@nigafiy/shared-types';
import { Badge, Button, Card, CopyBlock, ErrorNote, Field, Input, Modal, Notice } from '@/components/ui';
import { type ApiError, api } from '@/lib/api';
import { useApp } from '@/lib/app';
import { useI18n } from '@/lib/i18n';
import { AccountRecoveryCodes, OWN_PASSWORD_PATH } from '@/features/auth';
import Link from 'next/link';

export function AccountSecurity() {
  const { t } = useI18n();
  const { me, reloadMe } = useApp();

  const [displayName, setDisplayName] = useState(me.user.display_name);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState('');

  // MFA setup state
  const [setupData, setSetupData] = useState<MfaSetupResponse | null>(null);
  const [mfaCode, setMfaCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);

  // MFA disable / regenerate modal state
  const [passwordModal, setPasswordModal] = useState<'disable' | 'regenerate' | null>(null);
  const [confirmPassword, setConfirmPassword] = useState('');

  async function saveDisplayName(e: React.FormEvent) {
    e.preventDefault();
    if (!displayName.trim()) return;
    setBusy('name');
    setError(null);
    setNotice('');
    try {
      await api('/auth/me', {
        method: 'PATCH',
        body: { display_name: displayName.trim() },
      });
      reloadMe();
      setNotice(t('settings.security.nameSaved'));
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy('');
    }
  }

  async function savePassword(e: React.FormEvent) {
    e.preventDefault();
    if (!currentPassword || newPassword.length < 10) return;
    setBusy('password');
    setError(null);
    setNotice('');
    try {
      await api('/auth/password', {
        method: 'POST',
        body: {
          current_password: currentPassword,
          new_password: newPassword,
        },
      });
      setCurrentPassword('');
      setNewPassword('');
      setNotice(t('settings.security.passwordChanged'));
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy('');
    }
  }

  async function startMfaSetup() {
    setBusy('mfa-setup');
    setError(null);
    setNotice('');
    try {
      const res = await api<MfaSetupResponse>('/auth/mfa/setup', { method: 'POST', body: {} });
      setSetupData(res);
      setMfaCode('');
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy('');
    }
  }

  async function confirmMfaSetup(e: React.FormEvent) {
    e.preventDefault();
    if (mfaCode.trim().length < 6) return;
    setBusy('mfa-confirm');
    setError(null);
    try {
      const res = await api<MfaConfirmResponse>('/auth/mfa/confirm', {
        method: 'POST',
        body: { code: mfaCode.trim() },
      });
      setSetupData(null);
      setMfaCode('');
      setRecoveryCodes(res.recovery_codes);
      reloadMe();
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy('');
    }
  }

  async function submitPasswordModal(e: React.FormEvent) {
    e.preventDefault();
    if (!passwordModal || !confirmPassword) return;
    setBusy(passwordModal);
    setError(null);
    try {
      if (passwordModal === 'regenerate') {
        const res = await api<{ recovery_codes: string[] }>('/auth/mfa/recovery-codes', {
          method: 'POST',
          body: { password: confirmPassword },
        });
        setPasswordModal(null);
        setConfirmPassword('');
        setRecoveryCodes(res.recovery_codes);
      } else {
        await api('/auth/mfa/disable', {
          method: 'POST',
          body: { password: confirmPassword },
        });
        setPasswordModal(null);
        setConfirmPassword('');
        reloadMe();
      }
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy('');
    }
  }

  return (
    <Card title={t('settings.security.title')}>
      <div className="space-y-6">
        {error && <ErrorNote error={error} />}
        {notice && <Notice>{notice}</Notice>}

        {/* Display name */}
        <form onSubmit={saveDisplayName} className="flex flex-wrap items-end gap-3">
          <div className="min-w-56 flex-1">
            <Field label={t('settings.security.displayName')}>
              {(id) => (
                <Input
                  id={id}
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  maxLength={80}
                  required
                />
              )}
            </Field>
          </div>
          <Button
            type="submit"
            variant="secondary"
            busy={busy === 'name'}
            disabled={!displayName.trim() || displayName.trim() === me.user.display_name}
          >
            {t('settings.security.saveName')}
          </Button>
        </form>

        {/* Change password (the desktop's auto-created account has none the person knows: set one instead) */}
        {me.user.needs_own_password ? (
          <div className="space-y-2 border-t border-line pt-4">
            <h3 className="flex items-center gap-2 text-[13px] font-semibold text-fg">
              <KeyRound className="size-4 text-muted" aria-hidden />
              {t('ownpw.title')}
            </h3>
            <p className="text-[13px] leading-relaxed text-muted">{t('ownpw.bannerBody')}</p>
            <Link href={OWN_PASSWORD_PATH} className="text-[13px] font-medium text-accent-hover hover:underline">
              {t('ownpw.bannerAction')}
            </Link>
          </div>
        ) : (
        <form onSubmit={savePassword} className="space-y-3 border-t border-line pt-4">
          <h3 className="flex items-center gap-2 text-[13px] font-semibold text-fg">
            <KeyRound className="size-4 text-muted" aria-hidden />
            {t('settings.security.changePassword')}
          </h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('settings.security.currentPassword')}>
              {(id) => (
                <Input
                  id={id}
                  type="password"
                  autoComplete="current-password"
                  dir="ltr"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                />
              )}
            </Field>
            <Field label={t('settings.security.newPassword')} hint={t('auth.passwordHint')}>
              {(id) => (
                <Input
                  id={id}
                  type="password"
                  autoComplete="new-password"
                  dir="ltr"
                  minLength={10}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                />
              )}
            </Field>
          </div>
          <div>
            <Button
              type="submit"
              variant="secondary"
              busy={busy === 'password'}
              disabled={!currentPassword || newPassword.length < 10}
            >
              {t('settings.security.updatePassword')}
            </Button>
          </div>
        </form>
        )}
        <AccountRecoveryCodes />

        {/* Two-Factor Authentication */}
        <div className="space-y-3 border-t border-line pt-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="flex items-center gap-2 text-[13px] font-semibold text-fg">
              <ShieldCheck className="size-4 text-muted" aria-hidden />
              {t('settings.security.mfaTitle')}
            </h3>
            <Badge tone={me.user.mfa_enabled ? 'ok' : 'idle'}>
              {me.user.mfa_enabled ? t('settings.security.mfaEnabled') : t('settings.security.mfaDisabled')}
            </Badge>
          </div>

          {!me.user.mfa_enabled && !setupData && (
            <div>
              <Button variant="primary" busy={busy === 'mfa-setup'} onClick={() => void startMfaSetup()}>
                {t('settings.security.mfaSetupBtn')}
              </Button>
            </div>
          )}

          {setupData && (
            <form onSubmit={confirmMfaSetup} className="space-y-3 rounded-md border border-line bg-sunken/40 p-3.5">
              <p className="text-xs text-muted">{t('settings.security.mfaSetupHint')}</p>
              <CopyBlock label={t('auth.mfaSecret')} value={setupData.secret} />
              <CopyBlock label={t('auth.mfaOtpauthUri')} value={setupData.otpauth_uri} multiline />
              <div className="flex flex-wrap items-end gap-2">
                <div className="w-48">
                  <Field label={t('auth.mfaConfirmCode')}>
                    {(id) => (
                      <Input
                        id={id}
                        dir="ltr"
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        placeholder="123456"
                        value={mfaCode}
                        onChange={(e) => setMfaCode(e.target.value)}
                      />
                    )}
                  </Field>
                </div>
                <Button
                  type="submit"
                  variant="primary"
                  busy={busy === 'mfa-confirm'}
                  disabled={mfaCode.trim().length < 6}
                >
                  {t('settings.security.mfaConfirmBtn')}
                </Button>
                <Button variant="ghost" onClick={() => setSetupData(null)}>
                  {t('common.cancel')}
                </Button>
              </div>
            </form>
          )}

          {me.user.mfa_enabled && (
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                onClick={() => {
                  setError(null);
                  setConfirmPassword('');
                  setPasswordModal('regenerate');
                }}
              >
                {t('settings.security.mfaRegenerateBtn')}
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  setError(null);
                  setConfirmPassword('');
                  setPasswordModal('disable');
                }}
              >
                {t('settings.security.mfaDisableBtn')}
              </Button>
            </div>
          )}
        </div>
      </div>

      {passwordModal && (
        <Modal
          title={
            passwordModal === 'regenerate'
              ? t('settings.security.mfaRegenerateBtn')
              : t('settings.security.mfaDisableBtn')
          }
          onClose={() => setPasswordModal(null)}
        >
          <form onSubmit={submitPasswordModal} className="space-y-4">
            <Field label={t('settings.security.confirmPassword')}>
              {(id) => (
                <Input
                  id={id}
                  type="password"
                  autoComplete="current-password"
                  dir="ltr"
                  required
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                />
              )}
            </Field>
            {error && <ErrorNote error={error} />}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setPasswordModal(null)}>
                {t('common.cancel')}
              </Button>
              <Button
                type="submit"
                variant={passwordModal === 'disable' ? 'danger' : 'primary'}
                busy={busy === passwordModal}
                disabled={!confirmPassword}
              >
                {passwordModal === 'regenerate'
                  ? t('settings.security.mfaRegenerateBtn')
                  : t('settings.security.mfaDisableBtn')}
              </Button>
            </div>
          </form>
        </Modal>
      )}

      {recoveryCodes && (
        <Modal title={t('auth.recoveryCodesTitle')} onClose={() => setRecoveryCodes(null)}>
          <div className="space-y-4">
            <p className="text-[13px] text-muted">{t('auth.recoveryCodesDesc')}</p>
            <CopyBlock value={recoveryCodes.join('\n')} multiline />
            <div className="flex justify-end">
              <Button variant="primary" onClick={() => setRecoveryCodes(null)}>
                {t('common.close')}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </Card>
  );
}
