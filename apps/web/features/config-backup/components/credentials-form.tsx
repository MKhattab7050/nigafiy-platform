'use client';

import { KeyRound } from 'lucide-react';
import { useState } from 'react';
import { Button, Card, ErrorNote, Field, Input, Notice, Select, Textarea } from '@/components/ui';
import { type ApiError, api } from '@/lib/api';
import { relativeTime } from '@/lib/format';
import { type Key, fill, useI18n } from '@/lib/i18n';
import type { Target } from '../types';

export interface CredentialDraft {
  username: string;
  password: string;
  private_key: string;
  passphrase: string;
  enable_secret: string;
}

export const EMPTY_CREDENTIALS: CredentialDraft = { username: '', password: '', private_key: '', passphrase: '', enable_secret: '' };

/** The body the API accepts (empty optional fields left out), or null when it is incomplete. */
export function credentialsBody(c: CredentialDraft): Record<string, string> | null {
  if (!c.username.trim() || (!c.password && !c.private_key.trim())) return null;
  const out: Record<string, string> = { username: c.username.trim() };
  if (c.password) out.password = c.password;
  if (c.private_key.trim()) out.private_key = c.private_key.trim();
  if (c.passphrase) out.passphrase = c.passphrase;
  if (c.enable_secret) out.enable_secret = c.enable_secret;
  return out;
}

/** The input fields. Secrets are typed fresh every time: nothing is ever filled in from the server. */
export function CredentialFields({ value, onChange, errors }: { value: CredentialDraft; onChange: (v: CredentialDraft) => void; errors?: Record<string, string> }) {
  const { t } = useI18n();
  const set = (k: keyof CredentialDraft) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange({ ...value, [k]: e.target.value });
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label={t('cb.cred.username')} error={errors?.['credentials.username'] ?? errors?.username}>
        {(id) => <Input id={id} dir="ltr" autoComplete="off" maxLength={64} value={value.username} onChange={set('username')} />}
      </Field>
      <Field label={t('cb.cred.password')} error={errors?.['credentials.password'] ?? errors?.password}>
        {(id) => <Input id={id} type="password" dir="ltr" autoComplete="new-password" maxLength={256} value={value.password} onChange={set('password')} />}
      </Field>
      <div className="sm:col-span-2">
        <Field label={t('cb.cred.key')} hint={t('cb.cred.keyHint')} error={errors?.['credentials.private_key'] ?? errors?.private_key}>
          {(id) => <Textarea id={id} dir="ltr" spellCheck={false} autoComplete="off" className="mono text-xs" rows={4} maxLength={16384} value={value.private_key} onChange={set('private_key')} />}
        </Field>
      </div>
      <Field label={t('cb.cred.passphrase')}>
        {(id) => <Input id={id} type="password" dir="ltr" autoComplete="new-password" maxLength={256} value={value.passphrase} onChange={set('passphrase')} />}
      </Field>
      <Field label={t('cb.cred.enable')} hint={t('cb.cred.enableHint')}>
        {(id) => <Input id={id} type="password" dir="ltr" autoComplete="new-password" maxLength={256} value={value.enable_secret} onChange={set('enable_secret')} />}
      </Field>
    </div>
  );
}

/** Details of the API's validation errors, keyed by path, so each shows next to its field. */
export function fieldErrors(error: ApiError | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const d of error?.details ?? []) if (!(d.path in out)) out[d.path] = d.message;
  return out;
}

/** Target page card: what is saved (never the values), and a form to replace or copy them. Administrators only. */
export function CredentialsCard({ target, others, onSaved }: { target: Target; others: Target[]; onSaved: () => void }) {
  const { t, locale } = useI18n();
  const [draft, setDraft] = useState<CredentialDraft>(EMPTY_CREDENTIALS);
  const [copyFrom, setCopyFrom] = useState('');
  const [busy, setBusy] = useState<'save' | 'copy' | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [done, setDone] = useState(false);
  const c = target.credentials;
  const body = credentialsBody(draft);
  const sources = others.filter((o) => o.id !== target.id && o.credentials.set);

  const submit = async (kind: 'save' | 'copy', payload: unknown) => {
    setBusy(kind);
    setError(null);
    setDone(false);
    try {
      await api(`/config-backup/targets/${target.id}/credentials`, { method: 'PUT', body: payload });
      setDraft(EMPTY_CREDENTIALS);
      setCopyFrom('');
      setDone(true);
      onSaved();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card title={t('cb.cred.title')} description={t('cb.cred.hint')}>
      <div className="space-y-4">
        <p className="flex items-center gap-2 text-[13px]">
          <KeyRound className="size-4 shrink-0 text-faint" aria-hidden />
          {c.unreadable ? (
            <span className="text-warn">{t('cb.cred.unreadable')}</span>
          ) : c.set ? (
            <span>
              {fill(t('cb.cred.saved'), { when: relativeTime(c.updated_at, locale), auth: c.auth ? t(`cb.cred.auth.${c.auth}` as Key) : '—' })}
              {c.enable_secret_set && ` · ${t('cb.cred.enableSet')}`}
            </span>
          ) : (
            <span className="text-muted">{t('cb.cred.none')}</span>
          )}
        </p>
        <form
          autoComplete="off"
          onSubmit={(e) => {
            e.preventDefault();
            if (body) void submit('save', { credentials: body });
          }}
          className="space-y-3"
        >
          <CredentialFields value={draft} onChange={setDraft} errors={fieldErrors(error)} />
          {!body && (draft.username || draft.password || draft.private_key) && <p className="text-xs text-muted">{t('cb.cred.needSecret')}</p>}
          <div className="flex justify-end">
            <Button type="submit" variant="primary" busy={busy === 'save'} disabled={!body}>
              {c.set ? t('cb.cred.replace') : t('cb.cred.save')}
            </Button>
          </div>
        </form>
        {sources.length > 0 && (
          <div className="space-y-2 border-t border-line pt-3">
            <p className="text-xs font-medium text-muted">{t('cb.cred.copy')}</p>
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-56 flex-1">
                <Field label={t('cb.cred.copyFrom')}>
                  {(id) => (
                    <Select id={id} value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)}>
                      <option value="">—</option>
                      {sources.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name} ({s.address})
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
              </div>
              <Button busy={busy === 'copy'} disabled={!copyFrom} onClick={() => void submit('copy', { copy_from_target_id: copyFrom })}>
                {t('cb.cred.copyBtn')}
              </Button>
            </div>
          </div>
        )}
        {error && <ErrorNote error={error} />}
        {done && <Notice>{t('cb.cred.done')}</Notice>}
      </div>
    </Card>
  );
}
