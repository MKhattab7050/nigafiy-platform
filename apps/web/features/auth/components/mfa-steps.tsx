'use client';

import { useState } from 'react';
import type { LoginResponse, MfaConfirmResponse, MfaSetupResponse } from '@lan-detective/shared-types';
import { Button, CopyBlock, ErrorNote, Field, Input } from '@/components/ui';
import { type ApiError, api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';

export type MfaStep =
  | { kind: 'mfa_verify'; mfaToken: string }
  | { kind: 'mfa_setup'; mfaToken: string; secret: string; otpauthUri: string }
  | { kind: 'mfa_recovery'; recoveryCodes: string[] };

/** Converts an unauthenticated MFA LoginResponse into the next UI step, fetching setup secrets when required. */
export async function resolveMfaStep(res: LoginResponse): Promise<MfaStep | null> {
  if (res.ok) return null;
  if ('mfa_required' in res && res.mfa_required) {
    return { kind: 'mfa_verify', mfaToken: res.mfa_token };
  }
  if ('mfa_setup_required' in res && res.mfa_setup_required) {
    const setup = await api<MfaSetupResponse>('/auth/mfa/setup', {
      method: 'POST',
      body: { mfa_token: res.mfa_token },
    });
    return {
      kind: 'mfa_setup',
      mfaToken: res.mfa_token,
      secret: setup.secret,
      otpauthUri: setup.otpauth_uri,
    };
  }
  return null;
}

/** Shared TOTP verification, forced MFA enrollment, and recovery code steps for sign-in and invite acceptance. */
export function MfaChallenge({
  step,
  onStepChange,
  onBack,
}: {
  step: MfaStep;
  onStepChange: (next: MfaStep) => void;
  onBack: () => void;
}) {
  const { t } = useI18n();
  const [mfaCode, setMfaCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const fieldError = (path: string) => error?.details?.find((d) => d.path === path)?.message;

  async function submitMfaVerify(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (step.kind !== 'mfa_verify') return;
    setBusy(true);
    setError(null);
    try {
      await api('/auth/login/mfa', {
        method: 'POST',
        body: { mfa_token: step.mfaToken, code: mfaCode.trim() },
      });
      window.location.href = '/';
    } catch (err) {
      setError(err as ApiError);
      setBusy(false);
    }
  }

  async function submitMfaConfirm(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (step.kind !== 'mfa_setup') return;
    setBusy(true);
    setError(null);
    try {
      const res = await api<MfaConfirmResponse>('/auth/mfa/confirm', {
        method: 'POST',
        body: { mfa_token: step.mfaToken, code: mfaCode.trim() },
      });
      onStepChange({ kind: 'mfa_recovery', recoveryCodes: res.recovery_codes });
      setMfaCode('');
      setBusy(false);
    } catch (err) {
      setError(err as ApiError);
      setBusy(false);
    }
  }

  if (step.kind === 'mfa_verify') {
    return (
      <>
        <h1 className="text-xl font-semibold tracking-[-0.01em]">{t('auth.mfaTitle')}</h1>
        <p className="mt-1 text-[13px] text-muted">{t('auth.mfaDesc')}</p>
        <form onSubmit={submitMfaVerify} className="mt-5 space-y-4">
          <Field label={t('auth.mfaCode')} error={fieldError('code')}>
            {(id) => (
              <Input
                id={id}
                name="code"
                autoComplete="one-time-code"
                required
                dir="ltr"
                value={mfaCode}
                onChange={(e) => setMfaCode(e.target.value)}
                placeholder="123456"
              />
            )}
          </Field>
          {error && !error.details?.length && <ErrorNote error={error} />}
          <Button type="submit" variant="primary" busy={busy} disabled={!mfaCode.trim()} className="w-full">
            {t('auth.mfaVerify')}
          </Button>
          <Button type="button" variant="ghost" className="w-full" onClick={onBack}>
            {t('auth.backToSignIn')}
          </Button>
        </form>
      </>
    );
  }

  if (step.kind === 'mfa_setup') {
    return (
      <>
        <h1 className="text-xl font-semibold tracking-[-0.01em]">{t('auth.mfaSetupTitle')}</h1>
        <p className="mt-1 text-[13px] text-muted">{t('auth.mfaSetupDesc')}</p>
        <div className="mt-4 space-y-3">
          <CopyBlock label={t('auth.mfaSecret')} value={step.secret} />
          <CopyBlock label={t('auth.mfaOtpauthUri')} value={step.otpauthUri} multiline />
        </div>
        <form onSubmit={submitMfaConfirm} className="mt-4 space-y-4">
          <Field label={t('auth.mfaConfirmCode')} error={fieldError('code')}>
            {(id) => (
              <Input
                id={id}
                name="code"
                autoComplete="one-time-code"
                inputMode="numeric"
                required
                dir="ltr"
                value={mfaCode}
                onChange={(e) => setMfaCode(e.target.value)}
                placeholder="123456"
              />
            )}
          </Field>
          {error && !error.details?.length && <ErrorNote error={error} />}
          <Button type="submit" variant="primary" busy={busy} disabled={mfaCode.trim().length < 6} className="w-full">
            {t('auth.mfaConfirmBtn')}
          </Button>
          <Button type="button" variant="ghost" className="w-full" onClick={onBack}>
            {t('auth.backToSignIn')}
          </Button>
        </form>
      </>
    );
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold tracking-[-0.01em]">{t('auth.recoveryCodesTitle')}</h1>
      <p className="text-[13px] text-muted">{t('auth.recoveryCodesDesc')}</p>
      <CopyBlock value={step.recoveryCodes.join('\n')} multiline />
      <Button
        type="button"
        variant="primary"
        className="w-full"
        onClick={() => {
          window.location.href = '/';
        }}
      >
        {t('auth.continueToDashboard')}
      </Button>
    </div>
  );
}
