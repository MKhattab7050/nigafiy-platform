'use client';

import { useState } from 'react';
import type { NotificationChannel } from '@lan-detective/shared-types';
import { Button, ErrorNote, Field, Input, Modal, Select, SuggestedBadge } from '@/components/ui';
import { type ApiError, api } from '@/lib/api';
import { useApp } from '@/lib/app';
import { fill, useI18n } from '@/lib/i18n';

type Security = 'starttls' | 'tls' | 'none';

/**
 * Outgoing mail servers of well-known public mail providers. Only a suggestion, labelled as such:
 * company domains usually relay through their own server, which the admin types in.
 */
const KNOWN_SMTP: { domains: string[]; host: string; port: number; security: Security }[] = [
  { domains: ['gmail.com', 'googlemail.com'], host: 'smtp.gmail.com', port: 587, security: 'starttls' },
  { domains: ['outlook.com', 'hotmail.com', 'live.com', 'msn.com'], host: 'smtp-mail.outlook.com', port: 587, security: 'starttls' },
  { domains: ['yahoo.com', 'ymail.com'], host: 'smtp.mail.yahoo.com', port: 465, security: 'tls' },
  { domains: ['icloud.com', 'me.com', 'mac.com'], host: 'smtp.mail.me.com', port: 587, security: 'starttls' },
  { domains: ['aol.com'], host: 'smtp.aol.com', port: 465, security: 'tls' },
  { domains: ['zoho.com', 'zohomail.com'], host: 'smtp.zoho.com', port: 465, security: 'tls' },
  { domains: ['gmx.com', 'gmx.net', 'gmx.de'], host: 'mail.gmx.com', port: 587, security: 'starttls' },
  { domains: ['yandex.com', 'yandex.ru'], host: 'smtp.yandex.com', port: 465, security: 'tls' },
  { domains: ['fastmail.com', 'fastmail.fm'], host: 'smtp.fastmail.com', port: 465, security: 'tls' },
];

const splitList = (value: string) => value.split(/[\s,;،]+/).filter(Boolean);
const domainOf = (address: string | undefined) => address?.split('@')[1]?.trim().toLowerCase() ?? '';
const smtpFor = (domain: string) => (domain ? (KNOWN_SMTP.find((k) => k.domains.includes(domain)) ?? null) : null);

export function EmailChannelModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n();
  const { me } = useApp();
  // Prefilled and editable: the channel name, and the signed-in user's own address as the recipient.
  const [name, setName] = useState(() => t('settings.email.defaultName'));
  const [recipients, setRecipients] = useState(me.user.email);
  const initial = smtpFor(domainOf(me.user.email));
  // Host, port and security follow the suggestion for the first recipient's domain until the admin edits one of them.
  const [serverTouched, setServerTouched] = useState(false);
  const [host, setHost] = useState(initial?.host ?? '');
  const [security, setSecurity] = useState<Security>(initial?.security ?? 'starttls');
  const [port, setPort] = useState(String(initial?.port ?? 587));
  // Credentials are never prefilled.
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [from, setFrom] = useState('');
  const [severity, setSeverity] = useState('warning');
  const [useForAccountEmails, setUseForAccountEmails] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const list = splitList(recipients);
  const ready = name.trim() && list.length > 0 && host.trim() && Number(port) > 0 && from.trim();
  const suggestionDomain = domainOf(list[0]);
  const suggestion = smtpFor(suggestionDomain);
  const showSuggested = Boolean(!serverTouched && suggestion && host === suggestion.host && Number(port) === suggestion.port && security === suggestion.security);

  const changeRecipients = (value: string) => {
    setRecipients(value);
    if (serverTouched) return;
    const next = smtpFor(domainOf(splitList(value)[0]));
    setHost(next?.host ?? '');
    setPort(String(next?.port ?? 587));
    setSecurity(next?.security ?? 'starttls');
  };

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const login = security !== 'none' && username.trim() ? { username: username.trim(), ...(password ? { password } : {}) } : {};
      const res = await api<{ channel: NotificationChannel }>('/notification-channels', {
        method: 'POST',
        body: {
          kind: 'email',
          name: name.trim(),
          recipients: list,
          min_severity: severity,
          use_for_account_emails: useForAccountEmails,
          smtp: { host: host.trim(), port: Number(port), security, from: from.trim(), ...login },
        },
      });
      // Send a test straight away so a wrong server or password shows up now, not during an outage.
      await api(`/notification-channels/${res.channel.id}/test`, { method: 'POST' });
      onSaved();
    } catch (err) {
      setError(err as ApiError);
      setBusy(false);
    }
  }

  return (
    <Modal title={t('settings.email.title')} onClose={onClose} wide>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('common.name')} hint={t('common.prefilled')}>
          {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />}
        </Field>
        <Field label={t('settings.minSeverity')}>
          {(id) => (
            <Select id={id} value={severity} onChange={(e) => setSeverity(e.target.value)}>
              {(['info', 'warning', 'critical'] as const).map((s) => (
                <option key={s} value={s}>
                  ≥ {t(`severity.${s}`)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <div className="sm:col-span-2">
          <Field label={t('settings.email.recipients')} hint={recipients === me.user.email ? `${t('settings.email.recipientsHint')} ${t('settings.email.recipientsPrefilled')}` : t('settings.email.recipientsHint')}>
            {(id) => <Input id={id} dir="ltr" value={recipients} onChange={(e) => changeRecipients(e.target.value)} placeholder="it@example.com" maxLength={600} />}
          </Field>
        </div>
        <div className="min-w-0">
          <Field label={t('settings.email.host')} hint={showSuggested ? fill(t('settings.email.suggestedHint'), { domain: suggestionDomain }) : undefined}>
            {(id) => (
              <Input
                id={id}
                dir="ltr"
                value={host}
                onChange={(e) => {
                  setServerTouched(true);
                  setHost(e.target.value);
                }}
                placeholder="smtp.example.com"
                maxLength={253}
              />
            )}
          </Field>
          {showSuggested && (
            <div className="mt-1.5">
              <SuggestedBadge>{fill(t('settings.email.suggestedFor'), { domain: suggestionDomain })}</SuggestedBadge>
            </div>
          )}
        </div>
        <Field label={t('settings.email.from')}>{(id) => <Input id={id} dir="ltr" type="email" value={from} onChange={(e) => setFrom(e.target.value)} placeholder="lan-detective@example.com" maxLength={254} />}</Field>
        <Field label={t('settings.email.security')}>
          {(id) => (
            <Select
              id={id}
              value={security}
              onChange={(e) => {
                const v = e.target.value as Security;
                setServerTouched(true);
                setSecurity(v);
                setPort(v === 'tls' ? '465' : v === 'starttls' ? '587' : '25');
              }}
            >
              <option value="starttls">{t('settings.email.starttls')}</option>
              <option value="tls">{t('settings.email.tls')}</option>
              <option value="none">{t('settings.email.none')}</option>
            </Select>
          )}
        </Field>
        <Field label={t('settings.email.port')}>
          {(id) => (
            <Input
              id={id}
              dir="ltr"
              inputMode="numeric"
              value={port}
              onChange={(e) => {
                setServerTouched(true);
                setPort(e.target.value.replace(/\D/g, ''));
              }}
              maxLength={5}
            />
          )}
        </Field>
        {security !== 'none' && (
          <>
            <Field label={t('settings.email.username')} hint={t('settings.email.usernameHint')}>
              {(id) => <Input id={id} dir="ltr" autoComplete="off" value={username} onChange={(e) => setUsername(e.target.value)} maxLength={254} />}
            </Field>
            <Field label={t('settings.email.password')} hint={t('settings.email.passwordHint')}>
              {(id) => <Input id={id} dir="ltr" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} maxLength={500} disabled={!username.trim()} />}
            </Field>
          </>
        )}
        <label className="flex cursor-pointer items-start gap-2.5 pt-1 sm:col-span-2">
          <input
            type="checkbox"
            checked={useForAccountEmails}
            onChange={(e) => setUseForAccountEmails(e.target.checked)}
            className="mt-0.5 size-4 accent-[var(--color-accent)]"
          />
          <span>
            <span className="block text-[13px] font-medium text-fg">{t('settings.email.useForAccountEmails')}</span>
            <span className="block text-xs text-muted">{t('settings.email.useForAccountEmailsHint')}</span>
          </span>
        </label>
      </div>
      {error && (
        <div className="mt-3">
          <ErrorNote error={error} />
        </div>
      )}
      <div className="mt-4 flex gap-2">
        <Button variant="primary" busy={busy} disabled={!ready} onClick={save}>
          {t('settings.email.saveAndTest')}
        </Button>
        <Button variant="ghost" onClick={onClose}>
          {t('common.cancel')}
        </Button>
      </div>
    </Modal>
  );
}
