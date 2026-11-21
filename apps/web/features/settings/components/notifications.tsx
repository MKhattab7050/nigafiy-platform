'use client';

import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { NotificationChannel } from '@lan-detective/shared-types';
import { Async, Badge, Button, Card, CopyBlock, ErrorNote, Input, Modal, Select } from '@/components/ui';
import { type ApiError, api } from '@/lib/api';
import { useQuery } from '@/lib/app';
import { absoluteTime, relativeTime } from '@/lib/format';
import { type Key, useI18n } from '@/lib/i18n';
import { EmailChannelModal } from './email-channel-modal';

export function Notifications() {
  const { t, locale } = useI18n();
  const query = useQuery<{ items: NotificationChannel[] }>('/notification-channels', ['events'], 15_000);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [severity, setSeverity] = useState('warning');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState('');
  const [secret, setSecret] = useState<string | null>(null);
  const [emailOpen, setEmailOpen] = useState(false);

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    setNotice('');
    try {
      await fn();
      query.reload();
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy('');
    }
  };

  return (
    <Card title={t('settings.notifications')}>
      <p className="mb-3 text-[13px] text-muted">{t('settings.notificationsIntro')}</p>
      {error && (
        <div className="mb-3">
          <ErrorNote error={error} />
        </div>
      )}
      {notice && <p role="status" className="mb-3 rounded-md border border-accent/30 bg-accent/10 px-3 py-2 text-[13px]">{notice}</p>}
      <Async query={query}>
        {({ items }) =>
          items.length === 0 ? (
            <p className="text-[13px] text-muted">{t('settings.noChannels')}</p>
          ) : (
            <ul className="divide-y divide-line rounded-md border border-line">
              {items.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-3 py-2.5">
                  <span className="text-[13px] font-medium" dir="auto">{c.name}</span>
                  <Badge tone="idle" dot={false}>
                    {t(`settings.kind.${c.kind}` as Key)}
                  </Badge>
                  <span className="mono max-w-[22rem] truncate text-xs text-muted">
                    {c.kind === 'email' ? c.url.replace(/^mailto:/, '').replaceAll(',', ', ') : c.url}
                  </span>
                  {c.kind === 'email' && c.config.host && (
                    <span className="text-xs text-faint">
                      {t('settings.email.via')} <span className="mono">{c.config.host}:{c.config.port}</span>
                    </span>
                  )}
                  <Badge tone="info" dot={false}>
                    ≥ {t(`severity.${c.min_severity}`)}
                  </Badge>
                  {c.kind === 'email' && c.use_for_account_emails && (
                    <Badge tone="ok" dot={false}>
                      {t('settings.email.accountMailBadge')}
                    </Badge>
                  )}
                  {c.last_delivery_status && (
                    <span className="text-xs text-faint" title={absoluteTime(c.last_delivery_at, locale)}>
                      {t('settings.lastDelivery')}:{' '}
                      <span className={c.last_delivery_status === 'failed' ? 'text-crit' : c.last_delivery_status === 'delivered' ? 'text-ok' : ''}>{t(`settings.delivery.${c.last_delivery_status}` as Key)}</span> ·{' '}
                      {relativeTime(c.last_delivery_at, locale)}
                    </span>
                  )}
                  {c.last_delivery_status !== 'delivered' && c.last_delivery_error && (
                    <span className="basis-full text-xs text-crit" dir="ltr">
                      {c.last_delivery_error}
                    </span>
                  )}
                  <span className="ms-auto flex items-center gap-1">
                    {c.kind === 'email' && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          void act(`acct-${c.id}`, () =>
                            api(`/notification-channels/${c.id}`, {
                              method: 'PATCH',
                              body: { use_for_account_emails: !c.use_for_account_emails },
                            }),
                          )
                        }
                      >
                        {t('settings.email.accountMailBadge')}: {c.use_for_account_emails ? t('common.enabled') : t('common.disabled')}
                      </Button>
                    )}
                    <Button size="sm" busy={busy === `test-${c.id}`} onClick={() => void act(`test-${c.id}`, async () => { await api(`/notification-channels/${c.id}/test`, { method: 'POST' }); setNotice(t('settings.testQueued')); })}>
                      {t('settings.sendTest')}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => void act(c.id, () => api(`/notification-channels/${c.id}`, { method: 'PATCH', body: { enabled: !c.enabled } }))}>
                      {c.enabled ? t('common.enabled') : t('common.disabled')}
                    </Button>
                    <Button size="sm" variant="ghost" aria-label={`${t('common.delete')}: ${c.name}`} onClick={() => window.confirm(`${t('common.delete')}?`) && void act(c.id, () => api(`/notification-channels/${c.id}`, { method: 'DELETE' }))}>
                      <Trash2 className="size-3.5" aria-hidden />
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          )
        }
      </Async>
      <form
        className="mt-3 grid gap-2 lg:grid-cols-[12rem_1fr_10rem_auto]"
        onSubmit={(e) => {
          e.preventDefault();
          void act('add', async () => {
            const res = await api<{ signing_secret: string }>('/notification-channels', { method: 'POST', body: { name, url, min_severity: severity } });
            setSecret(res.signing_secret);
            setName('');
            setUrl('');
          });
        }}
      >
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('common.name')} aria-label={t('common.name')} required maxLength={80} />
        <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://hooks.example.com/lan-detective" aria-label={t('settings.url')} required type="url" dir="ltr" />
        <Select value={severity} onChange={(e) => setSeverity(e.target.value)} aria-label={t('settings.minSeverity')}>
          {(['info', 'warning', 'critical'] as const).map((s) => (
            <option key={s} value={s}>
              ≥ {t(`severity.${s}`)}
            </option>
          ))}
        </Select>
        <Button type="submit" variant="primary" busy={busy === 'add'} disabled={!name.trim() || !url}>
          <Plus className="size-4" aria-hidden />
          {t('settings.addChannel')}
        </Button>
      </form>
      <div className="mt-2">
        <Button onClick={() => setEmailOpen(true)}>
          <Plus className="size-4" aria-hidden />
          {t('settings.addEmail')}
        </Button>
      </div>
      {emailOpen && (
        <EmailChannelModal
          onClose={() => setEmailOpen(false)}
          onSaved={() => {
            setEmailOpen(false);
            setNotice(t('settings.testQueued'));
            query.reload();
          }}
        />
      )}
      {secret && (
        <Modal title={t('settings.secretTitle')} onClose={() => setSecret(null)}>
          <p className="mb-3 text-[13px] text-muted">{t('settings.secretOnce')}</p>
          <CopyBlock value={secret} />
        </Modal>
      )}
    </Card>
  );
}
