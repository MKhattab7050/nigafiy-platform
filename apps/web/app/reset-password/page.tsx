'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Logo } from '@/components/logo';
import { Button, ErrorNote, Field, Input, Notice, SkeletonBlock } from '@/components/ui';
import { type ApiError, api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';

function ResetPasswordInner() {
  const { t } = useI18n();
  const searchParams = useSearchParams();
  const token = searchParams.get('token')?.trim() ?? '';
  const [newPassword, setNewPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [done, setDone] = useState(false);

  const fieldError = (path: string) => error?.details?.find((d) => d.path === path)?.message;

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      await api('/auth/reset-password', {
        method: 'POST',
        body: { token, new_password: newPassword },
      });
      setDone(true);
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-[var(--radius-card)] border border-line bg-surface p-6 shadow-[var(--shadow-card)]">
      <h1 className="text-xl font-semibold tracking-[-0.01em]">{t('auth.resetTitle')}</h1>
      <p className="mt-1 text-[13px] text-muted">{t('auth.resetDesc')}</p>

      {!token ? (
        <div className="mt-4 space-y-4">
          <ErrorNote error={new Error(t('auth.resetMissingToken'))} />
          <Link
            href="/login"
            className="inline-flex h-9 w-full items-center justify-center rounded-[var(--radius-control)] border border-line-strong bg-surface px-3.5 text-[13px] font-medium text-fg hover:bg-raised"
          >
            {t('auth.backToSignIn')}
          </Link>
        </div>
      ) : done ? (
        <div className="mt-4 space-y-4">
          <Notice>{t('auth.resetSuccess')}</Notice>
          <Link
            href="/login"
            className="inline-flex h-9 w-full items-center justify-center rounded-[var(--radius-control)] bg-accent px-3.5 text-[13px] font-medium text-on-accent hover:bg-accent-strong"
          >
            {t('auth.signIn')}
          </Link>
        </div>
      ) : (
        <form onSubmit={submit} className="mt-5 space-y-4">
          <Field
            label={t('auth.newPassword')}
            hint={t('auth.passwordHint')}
            error={fieldError('new_password')}
          >
            {(id) => (
              <Input
                id={id}
                name="new_password"
                type="password"
                autoComplete="new-password"
                required
                minLength={10}
                dir="ltr"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
              />
            )}
          </Field>
          {error && !error.details?.length && <ErrorNote error={error} />}
          <Button
            type="submit"
            variant="primary"
            busy={busy}
            disabled={newPassword.length < 10}
            className="w-full"
          >
            {t('auth.resetSubmit')}
          </Button>
          <div className="text-center">
            <Link href="/login" className="text-xs font-medium text-accent-hover hover:underline">
              {t('auth.backToSignIn')}
            </Link>
          </div>
        </form>
      )}
    </div>
  );
}

export default function ResetPasswordPage() {
  const { locale, setLocale } = useI18n();
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
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
        <Suspense
          fallback={
            <div className="rounded-[var(--radius-card)] border border-line bg-surface p-6 shadow-[var(--shadow-card)]">
              <SkeletonBlock lines={4} />
            </div>
          }
        >
          <ResetPasswordInner />
        </Suspense>
      </div>
    </div>
  );
}
