'use client';

import { useState } from 'react';
import type { NotificationChannel } from '@nigafiy/shared-types';
import { Button, ErrorNote, Field, Input, Modal, Select } from '@/components/ui';
import { type ApiError, api } from '@/lib/api';
import { type Key, useI18n } from '@/lib/i18n';
import { TelegramLinkModal } from './telegram-link';

export type InstantChannelKind = 'telegram' | 'slack' | 'discord' | 'ntfy';

type NtfyAuthMode = 'none' | 'token' | 'basic';

export function InstantChannelModal({
  kind,
  onClose,
  onSaved,
}: {
  kind: InstantChannelKind;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(() => t(`settings.${kind}.defaultName` as Key));
  const [severity, setSeverity] = useState<'info' | 'warning' | 'critical'>('warning');
  // Telegram
  const [botToken, setBotToken] = useState('');
  const [chatId, setChatId] = useState('');
  const [threadId, setThreadId] = useState('');
  // Item 10: the chat is linked by QR after saving; typing a chat ID stays possible for groups and channels.
  const [typeChat, setTypeChat] = useState(false);
  const [linkChannel, setLinkChannel] = useState<string | null>(null);
  // Slack / Discord
  const [webhookUrl, setWebhookUrl] = useState('');
  // ntfy
  const [serverUrl, setServerUrl] = useState('https://ntfy.sh');
  const [topic, setTopic] = useState('');
  const [ntfyAuth, setNtfyAuth] = useState<NtfyAuthMode>('none');
  const [ntfyToken, setNtfyToken] = useState('');
  const [ntfyUser, setNtfyUser] = useState('');
  const [ntfyPass, setNtfyPass] = useState('');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const ready = (() => {
    if (!name.trim()) return false;
    if (kind === 'telegram') return Boolean(botToken.trim() && (!typeChat || chatId.trim()));
    if (kind === 'slack' || kind === 'discord') return Boolean(webhookUrl.trim());
    if (kind === 'ntfy') {
      if (!serverUrl.trim() || !topic.trim()) return false;
      if (ntfyAuth === 'token' && !ntfyToken.trim()) return false;
      if (ntfyAuth === 'basic' && (!ntfyUser.trim() || !ntfyPass)) return false;
      return true;
    }
    return false;
  })();

  async function save() {
    setBusy(true);
    setError(null);
    try {
      let body: Record<string, unknown>;
      if (kind === 'telegram') {
        const parsedThread = threadId.trim() ? Number(threadId.trim()) : undefined;
        body = {
          kind: 'telegram',
          name: name.trim(),
          min_severity: severity,
          bot_token: botToken.trim(),
          ...(typeChat && chatId.trim() ? { chat_id: chatId.trim() } : {}),
          ...(typeChat && parsedThread ? { message_thread_id: parsedThread } : {}),
        };
      } else if (kind === 'slack' || kind === 'discord') {
        body = {
          kind,
          name: name.trim(),
          min_severity: severity,
          webhook_url: webhookUrl.trim(),
        };
      } else {
        body = {
          kind: 'ntfy',
          name: name.trim(),
          min_severity: severity,
          server_url: serverUrl.trim(),
          topic: topic.trim(),
          ...(ntfyAuth === 'token' ? { token: ntfyToken.trim() } : {}),
          ...(ntfyAuth === 'basic' ? { username: ntfyUser.trim(), password: ntfyPass } : {}),
        };
      }

      const res = await api<{ channel: NotificationChannel }>('/notification-channels', {
        method: 'POST',
        body,
      });
      if (kind === 'telegram' && !(typeChat && chatId.trim())) {
        // No chat yet: show the QR code; the test message goes out once a chat is linked.
        setLinkChannel(res.channel.id);
        return;
      }
      await api(`/notification-channels/${res.channel.id}/test`, { method: 'POST' });
      onSaved();
    } catch (err) {
      setError(err as ApiError);
      setBusy(false);
    }
  }

  if (linkChannel) return <TelegramLinkModal channelId={linkChannel} onClose={onSaved} />;

  return (
    <Modal title={t(`settings.${kind}.title` as Key)} onClose={onClose} wide>
      <p className="mb-3 text-[13px] text-muted">{kind === 'telegram' ? t('tglink.intro') : t(`settings.${kind}.intro` as Key)}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('common.name')}>
          {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />}
        </Field>
        <Field label={t('settings.minSeverity')}>
          {(id) => (
            <Select id={id} value={severity} onChange={(e) => setSeverity(e.target.value as 'info' | 'warning' | 'critical')}>
              {(['info', 'warning', 'critical'] as const).map((s) => (
                <option key={s} value={s}>
                  ≥ {t(`severity.${s}`)}
                </option>
              ))}
            </Select>
          )}
        </Field>

        {kind === 'telegram' && (
          <>
            <div className="sm:col-span-2">
              <Field label={t('settings.telegram.botToken')} hint={t('settings.telegram.botTokenHint')}>
                {(id) => (
                  <Input
                    id={id}
                    dir="ltr"
                    type="password"
                    autoComplete="new-password"
                    value={botToken}
                    onChange={(e) => setBotToken(e.target.value)}
                    placeholder="123456789:AAH..."
                    maxLength={200}
                  />
                )}
              </Field>
            </div>
            <label className="flex items-center gap-2 text-[13px] text-muted sm:col-span-2">
              <input type="checkbox" checked={typeChat} onChange={(e) => setTypeChat(e.target.checked)} />
              {t('tglink.typeChatId')}
            </label>
            {typeChat && (
              <>
            <Field label={t('settings.telegram.chatId')} hint={t('settings.telegram.chatIdHint')}>
              {(id) => (
                <Input
                  id={id}
                  dir="ltr"
                  value={chatId}
                  onChange={(e) => setChatId(e.target.value)}
                  placeholder="-1001234567890"
                  maxLength={64}
                />
              )}
            </Field>
            <Field label={t('settings.telegram.threadId')} hint={t('settings.telegram.threadIdHint')}>
              {(id) => (
                <Input
                  id={id}
                  dir="ltr"
                  inputMode="numeric"
                  value={threadId}
                  onChange={(e) => setThreadId(e.target.value.replace(/\D/g, ''))}
                  placeholder="42"
                  maxLength={10}
                />
              )}
            </Field>
              </>
            )}
          </>
        )}

        {(kind === 'slack' || kind === 'discord') && (
          <div className="sm:col-span-2">
            <Field label={t(`settings.${kind}.webhookUrl` as Key)} hint={t(`settings.${kind}.webhookUrlHint` as Key)}>
              {(id) => (
                <Input
                  id={id}
                  dir="ltr"
                  type="password"
                  autoComplete="new-password"
                  value={webhookUrl}
                  onChange={(e) => setWebhookUrl(e.target.value)}
                  placeholder={kind === 'slack' ? 'https://hooks.slack.com/services/T.../B.../...' : 'https://discord.com/api/webhooks/...'}
                  maxLength={500}
                />
              )}
            </Field>
          </div>
        )}

        {kind === 'ntfy' && (
          <>
            <Field label={t('settings.ntfy.serverUrl')} hint={t('settings.ntfy.serverUrlHint')}>
              {(id) => (
                <Input
                  id={id}
                  dir="ltr"
                  type="url"
                  value={serverUrl}
                  onChange={(e) => setServerUrl(e.target.value)}
                  placeholder="https://ntfy.sh"
                  maxLength={300}
                />
              )}
            </Field>
            <Field label={t('settings.ntfy.topic')} hint={t('settings.ntfy.topicHint')}>
              {(id) => (
                <Input
                  id={id}
                  dir="ltr"
                  value={topic}
                  onChange={(e) => setTopic(e.target.value)}
                  placeholder="nigafiy-alerts-9f2a"
                  maxLength={64}
                />
              )}
            </Field>
            <div className="sm:col-span-2">
              <Field label={t('settings.ntfy.auth')}>
                {(id) => (
                  <Select id={id} value={ntfyAuth} onChange={(e) => setNtfyAuth(e.target.value as NtfyAuthMode)}>
                    <option value="none">{t('settings.ntfy.authNone')}</option>
                    <option value="token">{t('settings.ntfy.authToken')}</option>
                    <option value="basic">{t('settings.ntfy.authBasic')}</option>
                  </Select>
                )}
              </Field>
            </div>
            {ntfyAuth === 'token' && (
              <div className="sm:col-span-2">
                <Field label={t('settings.ntfy.token')} hint={t('settings.email.passwordHint')}>
                  {(id) => (
                    <Input
                      id={id}
                      dir="ltr"
                      type="password"
                      autoComplete="new-password"
                      value={ntfyToken}
                      onChange={(e) => setNtfyToken(e.target.value)}
                      placeholder="tk_..."
                      maxLength={256}
                    />
                  )}
                </Field>
              </div>
            )}
            {ntfyAuth === 'basic' && (
              <>
                <Field label={t('settings.email.username')}>
                  {(id) => <Input id={id} dir="ltr" autoComplete="off" value={ntfyUser} onChange={(e) => setNtfyUser(e.target.value)} maxLength={128} />}
                </Field>
                <Field label={t('settings.email.password')} hint={t('settings.email.passwordHint')}>
                  {(id) => (
                    <Input
                      id={id}
                      dir="ltr"
                      type="password"
                      autoComplete="new-password"
                      value={ntfyPass}
                      onChange={(e) => setNtfyPass(e.target.value)}
                      maxLength={256}
                    />
                  )}
                </Field>
              </>
            )}
          </>
        )}
      </div>

      {error && (
        <div className="mt-3">
          <ErrorNote error={error} />
        </div>
      )}
      <div className="mt-4 flex gap-2">
        <Button variant="primary" busy={busy} disabled={!ready} onClick={() => void save()}>
          {t('settings.email.saveAndTest')}
        </Button>
        <Button variant="ghost" onClick={onClose}>
          {t('common.cancel')}
        </Button>
      </div>
    </Modal>
  );
}
