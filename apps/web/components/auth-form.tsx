'use client';

import Link from 'next/link';
import { useState } from 'react';
import { type ApiError, api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { Logo } from './shell';
import { Button, ErrorNote, Field, Input } from './ui';

export function AuthForm({ mode }: { mode: 'login' | 'register' }) {
  const { t, locale, setLocale } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const register = mode === 'register';
  const fieldError = (path: string) => error?.details?.find((d) => d.path === path)?.message;

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    setBusy(true);
    setError(null);
    try {
      await api(register ? '/auth/register' : '/auth/login', { method: 'POST', body: form });
      window.location.href = '/';
    } catch (err) {
      setError(err as ApiError);
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-between">
          <Logo />
          <button type="button" onClick={() => setLocale(locale === 'en' ? 'ar' : 'en')} className="text-xs text-muted hover:text-fg">
            {locale === 'en' ? 'العربية' : 'English'}
          </button>
        </div>
        <div className="rounded-lg border border-line bg-surface p-6">
          <h1 className="text-lg font-semibold">{register ? t('auth.registerTitle') : t('auth.signInTitle')}</h1>
          <p className="mt-1 text-[13px] text-muted">{t('app.tagline')}</p>
          <form onSubmit={submit} className="mt-5 space-y-4" noValidate>
            {register && (
              <>
                <Field label={t('auth.yourName')} error={fieldError('display_name')}>
                  {(id) => <Input id={id} name="display_name" autoComplete="name" required maxLength={80} />}
                </Field>
                <Field label={t('auth.orgName')} error={fieldError('organization_name')}>
                  {(id) => <Input id={id} name="organization_name" autoComplete="organization" required maxLength={80} />}
                </Field>
                <Field label={t('auth.siteName')} hint={t('auth.siteHint')} error={fieldError('site_name')}>
                  {(id) => <Input id={id} name="site_name" required maxLength={80} defaultValue={locale === 'ar' ? 'المكتب الرئيسي' : 'Head office'} />}
                </Field>
              </>
            )}
            <Field label={t('auth.email')} error={fieldError('email')}>
              {(id) => <Input id={id} name="email" type="email" autoComplete="email" required dir="ltr" />}
            </Field>
            <Field label={t('auth.password')} hint={register ? t('auth.passwordHint') : undefined} error={fieldError('password')}>
              {(id) => <Input id={id} name="password" type="password" autoComplete={register ? 'new-password' : 'current-password'} required minLength={register ? 10 : 1} dir="ltr" />}
            </Field>
            {error && !error.details?.length && <ErrorNote error={error} />}
            <Button type="submit" variant="primary" busy={busy} className="w-full">
              {register ? t('auth.createAccount') : t('auth.signIn')}
            </Button>
          </form>
        </div>
        <p className="mt-4 text-center text-[13px] text-muted">
          {register ? t('auth.haveAccount') : t('auth.noAccount')}{' '}
          <Link href={register ? '/login' : '/register'} className="font-medium text-accent-hover hover:underline">
            {register ? t('auth.signIn') : t('auth.createAccount')}
          </Link>
        </p>
      </div>
    </div>
  );
}
