'use client';

import type { NetworkEvent } from '@nigafiy/shared-types';
import { BellOff } from 'lucide-react';
import { useState } from 'react';
import { Button, ErrorNote, Field, Modal, Notice, Select } from '@/components/ui';
import { type ApiError, api } from '@/lib/api';
import { useApp } from '@/lib/app';
import { EVENT_TYPE_LABEL } from '@/lib/format';
import { type Key, useI18n } from '@/lib/i18n';

/** "Mute…" on an event (calm alerts, item 12): stop messages for its device, its kind, or both, for a while. Admins only. */
export function MuteAction({ event }: { event: Pick<NetworkEvent, 'type' | 'device_id'> }) {
  const { t, locale } = useI18n();
  const { can } = useApp();
  const [open, setOpen] = useState(false);
  const [what, setWhat] = useState<'device' | 'type' | 'both'>(event.device_id ? 'device' : 'type');
  const [minutes, setMinutes] = useState('1440');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  if (!can('admin') || event.type === 'notification_summary' || event.type === 'notification_test') return null;
  const typeOk = /^[a-z0-9_]{1,60}$/.test(event.type);
  if (!event.device_id && !typeOk) return null;
  const typeLabel = EVENT_TYPE_LABEL[event.type]?.[locale] ?? event.type;

  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        <BellOff className="size-3.5" aria-hidden />
        {t('mute.button')}
      </Button>
      {open && (
        <Modal
          title={t('mute.title')}
          onClose={() => {
            setOpen(false);
            setDone(false);
          }}
        >
          {done ? (
            <Notice>{t('mute.done')}</Notice>
          ) : (
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                setBusy(true);
                setError(null);
                api('/notifications/mutes', {
                  method: 'POST',
                  body: {
                    device_id: what === 'type' ? null : event.device_id,
                    event_type: what === 'device' ? null : event.type,
                    minutes: minutes === 'forever' ? null : Number(minutes),
                  },
                })
                  .then(() => setDone(true))
                  .catch((err) => setError(err as ApiError))
                  .finally(() => setBusy(false));
              }}
            >
              {error && <ErrorNote error={error} />}
              <Field label={t('mute.what')}>
                {(id) => (
                  <Select id={id} value={what} onChange={(e) => setWhat(e.target.value as typeof what)}>
                    {event.device_id && <option value="device">{t('mute.thisDevice')}</option>}
                    {typeOk && <option value="type">{`${t('mute.thisType')} (${typeLabel})`}</option>}
                    {event.device_id && typeOk && <option value="both">{`${t('mute.thisTypeOnDevice')} (${typeLabel})`}</option>}
                  </Select>
                )}
              </Field>
              <Field label={t('mute.for')}>
                {(id) => (
                  <Select id={id} value={minutes} onChange={(e) => setMinutes(e.target.value)}>
                    {(['60', '1440', '10080', 'forever'] as const).map((m) => (
                      <option key={m} value={m}>
                        {t(`mute.for.${m}` as Key)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <p className="text-xs text-muted">{t('mute.note')}</p>
              <Button type="submit" variant="primary" busy={busy}>
                {t('mute.apply')}
              </Button>
            </form>
          )}
        </Modal>
      )}
    </>
  );
}
