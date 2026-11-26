'use client';

import { Download, KeyRound, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Button, Card, CopyBlock, ErrorNote, Field, Input, Notice } from '@/components/ui';
import { type ApiError, api } from '@/lib/api';
import { useApp } from '@/lib/app';
import { fill, useI18n } from '@/lib/i18n';

/**
 * UX review item 6: the desktop app signs its owner in with an account it created itself
 * (owner-…@nigafiy.local, a random password nobody knows). These pieces let the person choose their
 * own password and keep recovery codes, so they can sign in from a phone or another browser.
 */

export const OWN_PASSWORD_PATH = '/settings/own-password';
const LATER_KEY = 'nigafiy.ownPassword.later';

/** The one-time recovery codes, with copy, download and "I saved them". */
export function RecoveryCodesPanel({ email, codes, onDone }: { email: string; codes: string[]; onDone: () => void }) {
  const { t } = useI18n();
  function download() {
    const text = `${fill(t('ownpw.fileHeader'), { email })}\r\n\r\n${codes.join('\r\n')}\r\n`;
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'nigafiy-recovery-codes.txt';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <div className="space-y-4">
      <h2 className="text-[15px] font-semibold text-fg">{t('ownpw.codesTitle')}</h2>
      <p className="text-[13px] leading-relaxed text-muted">{t('ownpw.codesBody')}</p>
      <p className="text-[13px] text-fg">
        {fill(t('ownpw.signInAs'), { email: '⁨' + email + '⁩' })}
      </p>
      <div dir="ltr">
        <CopyBlock value={codes.join('\n')} multiline />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button onClick={download}>
          <Download className="size-3.5" aria-hidden />
          {t('ownpw.download')}
        </Button>
        <Button variant="primary" onClick={onDone}>
          {t('ownpw.saved')}
        </Button>
      </div>
    </div>
  );
}

/** Non-blocking card above every page while the owner has not chosen a password. "Not now" hides it for this browser session. */
export function OwnPasswordBanner() {
  const { t } = useI18n();
  const { me } = useApp();
  const pathname = usePathname();
  const [later, setLater] = useState(true);
  useEffect(() => {
    try {
      setLater(sessionStorage.getItem(LATER_KEY) === '1');
    } catch {
      setLater(false);
    }
  }, []);
  if (!me.user.needs_own_password || later || pathname === OWN_PASSWORD_PATH) return null;
  return (
    <div role="region" aria-label={t('ownpw.bannerTitle')} className="mb-5 flex flex-wrap items-start gap-3 rounded-[var(--radius-card)] border border-accent/30 bg-accent/[0.08] px-4 py-3">
      <KeyRound className="mt-0.5 size-4 shrink-0 text-accent-hover" aria-hidden />
      <div className="min-w-0 flex-1 basis-64">
        <p className="text-[13.5px] font-semibold text-fg">{t('ownpw.bannerTitle')}</p>
        <p className="mt-0.5 text-[13px] leading-relaxed text-muted">{t('ownpw.bannerBody')}</p>
      </div>
      <div className="flex items-center gap-2">
        <Link
          href={OWN_PASSWORD_PATH}
          className="inline-flex h-8 items-center rounded-[var(--radius-control)] bg-accent px-3 text-[13px] font-medium text-on-accent hover:bg-accent-strong"
        >
          {t('ownpw.bannerAction')}
        </Link>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            try {
              sessionStorage.setItem(LATER_KEY, '1');
            } catch {
              /* storage unavailable: hide for this page view only */
            }
            setLater(true);
          }}
        >
          <X className="size-3.5" aria-hidden />
          {t('ownpw.bannerLater')}
        </Button>
      </div>
    </div>
  );
}

/** Email (optional), password twice, then the recovery codes once. */
export function OwnPasswordScreen() {
  const { t } = useI18n();
  const { me, reloadMe } = useApp();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [tried, setTried] = useState(false);
  const [result, setResult] = useState<{ email: string; codes: string[] } | null>(null);

  const tooShort = password.length < 10;
  const mismatch = repeat !== password;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setTried(true);
    if (tooShort || mismatch) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ ok: true; email: string; recovery_codes: string[] }>('/auth/own-password', {
        method: 'POST',
        body: { ...(email.trim() ? { email: email.trim() } : {}), password },
      });
      setPassword('');
      setRepeat('');
      setResult({ email: res.email, codes: res.recovery_codes });
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-lg">
      <Card>
        {result ? (
          <RecoveryCodesPanel
            email={result.email}
            codes={result.codes}
            onDone={() => {
              reloadMe();
              router.push('/');
            }}
          />
        ) : !me.user.needs_own_password ? (
          <div className="space-y-4">
            <Notice>{t('ownpw.alreadySet')}</Notice>
            <Link href="/settings" className="text-[13px] font-medium text-accent-hover hover:underline">
              {t('ownpw.toSettings')}
            </Link>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-4" noValidate>
            <div>
              <h1 className="text-[17px] font-semibold text-fg">{t('ownpw.title')}</h1>
              <p className="mt-1 text-[13px] leading-relaxed text-muted">{t('ownpw.intro')}</p>
            </div>
            <Field
              label={t('ownpw.email')}
              hint={fill(t('ownpw.emailHint'), { email: '⁨' + me.user.email + '⁩' })}
              error={error?.details?.find((d) => d.path === 'email')?.message}
            >
              {(id) => <Input id={id} type="email" autoComplete="email" dir="ltr" value={email} onChange={(e) => setEmail(e.target.value)} />}
            </Field>
            <Field label={t('ownpw.password')} hint={t('ownpw.passwordHint')} error={tried && tooShort ? t('ownpw.tooShort') : undefined}>
              {(id) => (
                <Input id={id} type="password" autoComplete="new-password" required minLength={10} dir="ltr" value={password} onChange={(e) => setPassword(e.target.value)} />
              )}
            </Field>
            <Field label={t('ownpw.repeat')} error={tried && !tooShort && mismatch ? t('ownpw.mismatch') : undefined}>
              {(id) => (
                <Input id={id} type="password" autoComplete="new-password" required dir="ltr" value={repeat} onChange={(e) => setRepeat(e.target.value)} />
              )}
            </Field>
            {error && !error.details?.length && <ErrorNote error={error} />}
            <Button type="submit" variant="primary" busy={busy} className="w-full">
              {t('ownpw.save')}
            </Button>
          </form>
        )}
      </Card>
    </div>
  );
}

/** Settings → Account: how many recovery codes are left, and a new set (needs the current password). */
export function AccountRecoveryCodes() {
  const { t } = useI18n();
  const { me, reloadMe } = useApp();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  if (me.user.needs_own_password || me.user.recovery_codes_left === undefined) return null;
  // Shown once codes exist (someone who set their own password on an installed copy).
  if (me.user.recovery_codes_left === 0 && !codes) return null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ recovery_codes: string[] }>('/auth/account-recovery-codes', { method: 'POST', body: { password } });
      setPassword('');
      setCodes(res.recovery_codes);
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  }

  if (codes) {
    return (
      <RecoveryCodesPanel
        email={me.user.email}
        codes={codes}
        onDone={() => {
          setCodes(null);
          setOpen(false);
          reloadMe();
        }}
      />
    );
  }
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[13px] text-fg">{fill(t('ownpw.codesLeft'), { count: me.user.recovery_codes_left })}</p>
        {!open && (
          <Button size="sm" onClick={() => setOpen(true)}>
            {t('ownpw.newCodes')}
          </Button>
        )}
      </div>
      {open && (
        <form onSubmit={submit} className="space-y-3">
          <Field label={t('auth.password')} hint={t('ownpw.newCodesHint')}>
            {(id) => (
              <Input id={id} type="password" autoComplete="current-password" required dir="ltr" value={password} onChange={(e) => setPassword(e.target.value)} />
            )}
          </Field>
          {error && <ErrorNote error={error} />}
          <Button type="submit" variant="primary" busy={busy} disabled={!password}>
            {t('ownpw.newCodes')}
          </Button>
        </form>
      )}
    </div>
  );
}
