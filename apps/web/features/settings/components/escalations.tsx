'use client';

import type { NotificationChannel, NotificationEscalation } from '@nigafiy/shared-types';
import { BellRing, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Async, Badge, Button, Card, ErrorNote, Field, Input, Select, useConfirm } from '@/components/ui';
import { type ApiError, api } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { fill, type Key, useI18n } from '@/lib/i18n';

export function Escalations({ channels }: { channels: NotificationChannel[] }) {
  const confirm = useConfirm();
  const { t, tn } = useI18n();
  const { sites } = useApp();
  const query = useQuery<{ items: NotificationEscalation[] }>('/notifications/escalations', ['events'], 15_000);

  const [name, setName] = useState('');
  const [channelId, setChannelId] = useState('');
  const [siteId, setSiteId] = useState('');
  const [minSeverity, setMinSeverity] = useState<'info' | 'warning' | 'critical'>('critical');
  const [delayMinutes, setDelayMinutes] = useState('15');
  const [maxRepeats, setMaxRepeats] = useState('1');
  const [repeatInterval, setRepeatInterval] = useState('30');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    if (!channelId && channels[0]) setChannelId(channels[0].id);
  }, [channels, channelId]);

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      query.reload();
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy('');
    }
  };

  const repeatsNum = Math.max(1, Math.min(10, Number(maxRepeats) || 1));
  const delayNum = Number(delayMinutes) || 0;
  const repeatNum = Number(repeatInterval) || 0;
  const canSubmit = Boolean(name.trim() && channelId && delayNum >= 1 && delayNum <= 1440 && (repeatsNum === 1 || (repeatNum >= 5 && repeatNum <= 1440)));

  return (
    <Card
      title={
        <span className="inline-flex items-center gap-2">
          <BellRing className="size-4 text-accent" aria-hidden />
          {t('settings.escalation.title')}
        </span>
      }
    >
      <p className="mb-3 text-[13px] text-muted">{t('settings.escalation.intro')}</p>
      {error && (
        <div className="mb-3">
          <ErrorNote error={error} />
        </div>
      )}

      <Async query={query}>
        {({ items }) =>
          items.length === 0 ? (
            <p className="text-[13px] text-muted">{t('settings.escalation.empty')}</p>
          ) : (
            <ul className="divide-y divide-line rounded-md border border-line">
              {items.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2.5">
                  <span className="text-[13px] font-medium" dir="auto">
                    {p.name}
                  </span>
                  <Badge tone="idle" dot={false}>
                    {p.channel_name} · {t(`settings.kind.${p.channel_kind}` as Key)}
                  </Badge>
                  <Badge tone="info" dot={false}>
                    ≥ {t(`severity.${p.min_severity}`)}
                  </Badge>
                  <Badge tone="idle" dot={false}>
                    {p.site_name ?? t('settings.escalation.allSites')}
                  </Badge>
                  <span className="text-xs text-muted">
                    {p.max_repeats > 1 && p.repeat_interval_minutes
                      ? fill(t('settings.escalation.scheduleRepeat'), {
                          delay: p.delay_minutes,
                          repeat: p.repeat_interval_minutes,
                          max: p.max_repeats,
                        })
                      : fill(t('settings.escalation.scheduleOnce'), { delay: p.delay_minutes })}
                  </span>
                  <span className="ms-auto flex items-center gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      busy={busy === `toggle-${p.id}`}
                      onClick={() =>
                        void act(`toggle-${p.id}`, () =>
                          api(`/notifications/escalations/${p.id}`, {
                            method: 'PATCH',
                            body: { enabled: !p.enabled },
                          }),
                        )
                      }
                    >
                      {p.enabled ? t('common.enabled') : t('common.disabled')}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`${t('common.delete')}: ${p.name}`}
                      onClick={async () =>
                        (await confirm(`${t('common.delete')}?`, { destructive: true, confirmLabel: t('common.delete') })) &&
                        void act(`del-${p.id}`, () => api(`/notifications/escalations/${p.id}`, { method: 'DELETE' }))
                      }
                    >
                      <Trash2 className="size-3.5" aria-hidden />
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          )
        }
      </Async>

      {channels.length === 0 ? (
        <p className="mt-3 text-xs text-muted">{t('settings.escalation.needChannel')}</p>
      ) : (
        <form
          className="mt-4 grid gap-3 border-t border-line pt-4 sm:grid-cols-2 lg:grid-cols-3"
          onSubmit={(e) => {
            e.preventDefault();
            void act('add', async () => {
              await api('/notifications/escalations', {
                method: 'POST',
                body: {
                  name: name.trim(),
                  channel_id: channelId,
                  site_id: siteId || null,
                  min_severity: minSeverity,
                  delay_minutes: delayNum,
                  max_repeats: repeatsNum,
                  ...(repeatsNum > 1 ? { repeat_interval_minutes: repeatNum } : {}),
                },
              });
              setName('');
            });
          }}
        >
          <Field label={t('settings.escalation.policyName')}>
            {(id) => (
              <Input
                id={id}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('settings.escalation.namePlaceholder')}
                maxLength={80}
                required
              />
            )}
          </Field>
          <Field label={t('settings.escalation.channel')}>
            {(id) => (
              <Select id={id} value={channelId} onChange={(e) => setChannelId(e.target.value)}>
                {channels.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({t(`settings.kind.${c.kind}` as Key)})
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('settings.escalation.site')}>
            {(id) => (
              <Select id={id} value={siteId} onChange={(e) => setSiteId(e.target.value)}>
                <option value="">{t('settings.escalation.allSites')}</option>
                {sites.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('settings.minSeverity')}>
            {(id) => (
              <Select id={id} value={minSeverity} onChange={(e) => setMinSeverity(e.target.value as 'info' | 'warning' | 'critical')}>
                {(['critical', 'warning', 'info'] as const).map((s) => (
                  <option key={s} value={s}>
                    ≥ {t(`severity.${s}`)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('settings.escalation.delayMinutes')} hint={t('settings.escalation.delayHint')}>
            {(id) => (
              <Input
                id={id}
                dir="ltr"
                inputMode="numeric"
                value={delayMinutes}
                onChange={(e) => setDelayMinutes(e.target.value.replace(/\D/g, ''))}
                maxLength={4}
              />
            )}
          </Field>
          <Field label={t('settings.escalation.maxRepeats')}>
            {(id) => (
              <Select id={id} value={maxRepeats} onChange={(e) => setMaxRepeats(e.target.value)}>
                {[1, 2, 3, 5, 10].map((n) => (
                  <option key={n} value={String(n)}>
                    {n === 1 ? t('settings.escalation.once') : fill(tn('settings.escalation.upToTimes', n), { n })}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {repeatsNum > 1 && (
            <Field label={t('settings.escalation.repeatInterval')} hint={t('settings.escalation.repeatHint')}>
              {(id) => (
                <Input
                  id={id}
                  dir="ltr"
                  inputMode="numeric"
                  value={repeatInterval}
                  onChange={(e) => setRepeatInterval(e.target.value.replace(/\D/g, ''))}
                  maxLength={4}
                />
              )}
            </Field>
          )}
          <div className="flex items-end sm:col-span-2 lg:col-span-3">
            <Button type="submit" variant="primary" busy={busy === 'add'} disabled={!canSubmit}>
              <Plus className="size-4" aria-hidden />
              {t('settings.escalation.add')}
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}
