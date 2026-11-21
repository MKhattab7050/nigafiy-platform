'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { InvitationPreview, LoginResponse } from '@lan-detective/shared-types';
import { Logo } from '@/components/logo';
import { Badge, Button, ErrorNote, Fact, Field, Input, SkeletonBlock } from '@/components/ui';
import { MfaChallenge, type MfaStep, resolveMfaStep } from '@/features/auth';
import { type ApiError, api } from '@/lib/api';
import { type Key, fill, useI18n } from '@/lib/i18n';

function nameFromEmail(email: string): string {
  const local = email.split('@')[0] ?? '';
  return local
    .split(/[._\-+]+/)
    .filter((w) => w && !/^\d+$/.test(w))
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
    .slice(0, 80);
}

export default function InvitePage() {
  const { t, locale, setLocale } = useI18n();
  const params = useParams<{ token: string }>();
  const token = typeof params?.token === 'string' ? params.token : '';

  const [preview, setPreview] = useState<InvitationPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<ApiError | null>(null);

  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<ApiError | null>(null);
  const [mfaStep, setMfaStep] = useState<MfaStep | null>(null);

  useEffect(() => {
    if (!token) {
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    setLoadError(null);
    api<InvitationPreview>(`/auth/invitations/${encodeURIComponent(token)}`)
      .then((res) => {
        if (!active) return;
        setPreview(res);
        setDisplayName(nameFromEmail(res.email));
      })
      .catch((err) => {
        if (!active) return;
        setLoadError(err as ApiError);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [token]);

  const fieldError = (path: string) => submitError?.details?.find((d) => d.path === path)?.message;

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!preview || !token) return;
    setBusy(true);
    setSubmitError(null);
    try {
      const res = await api<LoginResponse | undefined>(`/auth/invitations/${encodeURIComponent(token)}/accept`, {
        method: 'POST',
        body: {
          ...(preview.existing_user
            ? {}
            : { display_name: displayName.trim() || preview.email.split('@')[0] }),
          password,
        },
      });
      if (res) {
        const nextMfa = await resolveMfaStep(res);
        if (nextMfa) {
          setMfaStep(nextMfa);
          setBusy(false);
          return;
        }
      }
      window.location.href = '/';
    } catch (err) {
      setSubmitError(err as ApiError);
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-6 flex items-center justify-between">
          <Logo />
          <button
            type="button"
            onClick={() => setLocale(locale === 'en' ? 'ar' : 'en')}
            className="rounded-[5px] px-1.5 py-1 text-xs text-muted hover:bg-raised hover:text-fg"
            lang={locale === 'en' ? 'ar' : 'en'}
          >
            {locale === 'en' ? 'العربية' : 'English'}
          </button>
        </div>

        <div className="rounded-[var(--radius-card)] border border-line bg-surface p-6 shadow-[var(--shadow-card)]">
          {mfaStep ? (
            <MfaChallenge
              step={mfaStep}
              onStepChange={setMfaStep}
              onBack={() => {
                window.location.href = '/login';
              }}
            />
          ) : (
            <>
              <h1 className="text-xl font-semibold tracking-[-0.01em]">{t('auth.inviteTitle')}</h1>

              {loading ? (
                <div className="mt-4 space-y-2">
                  <p className="text-xs text-muted">{t('auth.inviteLoading')}</p>
                  <SkeletonBlock lines={4} />
                </div>
              ) : loadError || !preview ? (
                <div className="mt-4 space-y-4">
                  <ErrorNote error={loadError ?? new Error(t('common.error'))} />
                  <Link
                    href="/login"
                    className="inline-flex h-9 w-full items-center justify-center rounded-[var(--radius-control)] border border-line-strong bg-surface px-3.5 text-[13px] font-medium text-fg hover:bg-raised"
                  >
                    {t('auth.backToSignIn')}
                  </Link>
                </div>
              ) : (
                <>
                  <p className="mt-1 text-[13px] text-muted" dir="auto">
                    {preview.invited_by_name
                      ? fill(t('auth.inviteInvitedBy'), {
                          inviter: preview.invited_by_name,
                          org: preview.organization_name,
                        })
                      : fill(t('auth.inviteJoinOrg'), { org: preview.organization_name })}
                  </p>

                  <dl className="mt-4 rounded-md border border-line bg-sunken/50 px-3 py-1">
                    <Fact label={t('auth.orgName')}>{preview.organization_name}</Fact>
                    <Fact label={t('auth.email')}>
                      <span className="mono">{preview.email}</span>
                    </Fact>
                    <Fact label={t('auth.inviteRole')}>
                      <Badge tone="info" dot={false}>
                        {t(('control.role.' + preview.role) as Key)}
                      </Badge>
                    </Fact>
                  </dl>

                  <p className="mt-4 text-xs leading-relaxed text-muted">
                    {preview.existing_user ? t('auth.inviteExistingHint') : t('auth.inviteNewHint')}
                  </p>

                  <form onSubmit={submit} className="mt-4 space-y-4">
                    {!preview.existing_user && (
                      <Field label={t('auth.yourName')} error={fieldError('display_name')}>
                        {(id) => (
                          <Input
                            id={id}
                            name="display_name"
                            autoComplete="name"
                            maxLength={80}
                            required
                            value={displayName}
                            onChange={(e) => setDisplayName(e.target.value)}
                          />
                        )}
                      </Field>
                    )}
                    <Field
                      label={t('auth.password')}
                      hint={preview.existing_user ? undefined : t('auth.passwordHint')}
                      error={fieldError('password')}
                    >
                      {(id) => (
                        <Input
                          id={id}
                          name="password"
                          type="password"
                          autoComplete={preview.existing_user ? 'current-password' : 'new-password'}
                          required
                          minLength={preview.existing_user ? 1 : 10}
                          dir="ltr"
                          value={password}
                          onChange={(e) => setPassword(e.target.value)}
                        />
                      )}
                    </Field>
                    {submitError && !submitError.details?.length && <ErrorNote error={submitError} />}
                    <Button
                      type="submit"
                      variant="primary"
                      busy={busy}
                      disabled={!password || (!preview.existing_user && password.length < 10)}
                      className="w-full"
                    >
                      {t('auth.inviteAccept')}
                    </Button>
                  </form>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
