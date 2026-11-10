'use client';

import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { AuditEntry, NotificationChannel } from '@lan-detective/shared-types';
import { Async, Badge, Button, Card, CopyBlock, EmptyState, ErrorNote, Fact, Input, Modal, PageHeader, Select } from '@/components/ui';
import { type ApiError, api } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { absoluteTime, relativeTime } from '@/lib/format';
import { type Key, useI18n } from '@/lib/i18n';

function Notifications() {
  const { t, locale } = useI18n();
  const query = useQuery<{ items: NotificationChannel[] }>('/notification-channels', ['events'], 15_000);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [severity, setSeverity] = useState('warning');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState('');
  const [secret, setSecret] = useState<string | null>(null);

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
                  <span className="mono max-w-[22rem] truncate text-xs text-muted">{c.url}</span>
                  <Badge tone="info" dot={false}>
                    ≥ {t(`severity.${c.min_severity}`)}
                  </Badge>
                  {c.last_delivery_status && (
                    <span className="text-xs text-faint" title={absoluteTime(c.last_delivery_at, locale)}>
                      {t('settings.lastDelivery')}:{' '}
                      <span className={c.last_delivery_status === 'failed' ? 'text-crit' : c.last_delivery_status === 'delivered' ? 'text-ok' : ''}>{t(`settings.delivery.${c.last_delivery_status}` as Key)}</span> ·{' '}
                      {relativeTime(c.last_delivery_at, locale)}
                    </span>
                  )}
                  <span className="ms-auto flex items-center gap-1">
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
      {secret && (
        <Modal title={t('settings.secretTitle')} onClose={() => setSecret(null)}>
          <p className="mb-3 text-[13px] text-muted">{t('settings.secretOnce')}</p>
          <CopyBlock value={secret} />
        </Modal>
      )}
    </Card>
  );
}

function AuditLog() {
  const { t, locale } = useI18n();
  const query = useQuery<{ items: AuditEntry[] }>('/audit-logs?limit=100', [], 60_000);
  return (
    <Card title={t('settings.audit')} padded={false}>
      <Async query={query}>
        {({ items }) =>
          items.length === 0 ? (
            <EmptyState title={t('settings.auditEmpty')} />
          ) : (
            <div className="max-h-[28rem] overflow-auto">
              <table className="w-full min-w-[560px] text-[13px]">
                <tbody className="divide-y divide-line">
                  {items.map((a) => (
                    <tr key={a.id}>
                      <td className="whitespace-nowrap px-4 py-2 text-xs text-muted" title={absoluteTime(a.created_at, locale)}>
                        {relativeTime(a.created_at, locale)}
                      </td>
                      <td className="mono px-3 py-2 text-start text-xs">{a.action}</td>
                      <td className="mono px-3 py-2 text-start text-xs text-muted">{a.user_email ?? '—'}</td>
                      <td className="mono max-w-[18rem] truncate px-4 py-2 text-start text-xs text-faint" title={JSON.stringify(a.metadata)}>
                        {Object.keys(a.metadata).length ? JSON.stringify(a.metadata) : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </Async>
    </Card>
  );
}

export default function SettingsPage() {
  const { t, locale, setLocale } = useI18n();
  const { me, can } = useApp();
  return (
    <>
      <PageHeader title={t('settings.title')} />
      <div className="space-y-4">
        <Card title={t('settings.organization')}>
          <dl>
            <Fact label={t('settings.organization')}>{me.organization.name}</Fact>
            <Fact label={t('auth.email')}>
              <span className="mono">{me.user.email}</span>
            </Fact>
            <Fact label={t('settings.role')}>{me.role}</Fact>
            <Fact label={t('settings.language')}>
              <Select
                value={locale}
                aria-label={t('settings.language')}
                className="w-40"
                onChange={(e) => {
                  const next = e.target.value as 'en' | 'ar';
                  setLocale(next);
                  void api('/auth/me', { method: 'PATCH', body: { locale: next } }).catch(() => undefined);
                }}
              >
                <option value="en">English</option>
                <option value="ar">العربية</option>
              </Select>
            </Fact>
          </dl>
        </Card>
        {can('admin') ? (
          <>
            <Notifications />
            <AuditLog />
          </>
        ) : (
          <Card>
            <p className="text-[13px] text-muted">{t('settings.adminOnly')}</p>
          </Card>
        )}
      </div>
    </>
  );
}
