'use client';

import { AlertTriangle, Fingerprint } from 'lucide-react';
import { useState } from 'react';
import { Button, Card, ErrorNote, Modal } from '@/components/ui';
import { type ApiError, api } from '@/lib/api';
import { useApp } from '@/lib/app';
import { absoluteTime, relativeTime } from '@/lib/format';
import { type Key, fill, useI18n } from '@/lib/i18n';
import type { Target } from '../types';

const KeyLine = ({ type, sha256 }: { type: string | null; sha256: string }) => (
  <p className="mono break-all rounded-[var(--radius-control)] border border-line bg-sunken px-2.5 py-1.5 text-xs" dir="ltr">
    {type ? `${type} ` : ''}
    {sha256}
  </p>
);

/**
 * The SSH host key the device is pinned to. A changed key stops backups until an administrator
 * explicitly trusts the exact key the collector saw (or forgets the pin); both are confirmed first.
 */
export function HostKeyPanel({ target, onChanged }: { target: Target; onChanged: () => void }) {
  const { t, locale } = useI18n();
  const { can } = useApp();
  const admin = can('admin');
  const [dialog, setDialog] = useState<'trust' | 'forget' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const presented = target.presented_host_key;
  const changed = target.host_key_status === 'changed';

  const post = async (path: string, body: unknown) => {
    setBusy(true);
    setError(null);
    try {
      await api(`/config-backup/targets/${target.id}/host-key/${path}`, { method: 'POST', body });
      setDialog(null);
      onChanged();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title={t('cb.hk.title')}>
      <div className="space-y-3 text-[13px]">
        {target.host_key_sha256 ? (
          <div className="space-y-1.5">
            <p className="flex items-center gap-2 text-xs text-muted">
              <Fingerprint className="size-3.5" aria-hidden />
              {changed ? t('cb.hk.previous') : null}
              {changed ? ' · ' : null}
              <span title={absoluteTime(target.host_key_pinned_at, locale)}>{fill(t('cb.hk.pinned'), { when: relativeTime(target.host_key_pinned_at, locale) })}</span>
              {target.host_key_pinned_via && <span>· {t(`cb.hk.via.${target.host_key_pinned_via}` as Key)}</span>}
            </p>
            <KeyLine type={target.host_key_type} sha256={target.host_key_sha256} />
          </div>
        ) : (
          <p className="text-muted">{t('cb.hk.none')}</p>
        )}
        {changed && (
          <div className="space-y-2 rounded-[var(--radius-control)] border border-crit/40 bg-crit/[0.06] p-3">
            <p className="flex items-start gap-2 font-medium text-crit">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
              {t('cb.hk.changed')}
            </p>
            {presented && (
              <>
                <p className="text-xs text-muted">{fill(t('cb.hk.presented'), { when: relativeTime(presented.seen_at, locale) })}</p>
                <KeyLine type={presented.type} sha256={presented.sha256} />
              </>
            )}
            {admin && presented && (
              <Button variant="primary" size="sm" onClick={() => (setError(null), setDialog('trust'))}>
                {t('cb.hk.trust')}
              </Button>
            )}
          </div>
        )}
        {admin && target.host_key_sha256 && (
          <Button size="sm" variant="danger" onClick={() => (setError(null), setDialog('forget'))}>
            {t('cb.hk.forget')}
          </Button>
        )}
        {error && !dialog && <ErrorNote error={error} />}
      </div>

      {dialog === 'trust' && presented && (
        <Modal title={t('cb.hk.trustTitle')} onClose={() => setDialog(null)}>
          <div className="space-y-3">
            <p className="text-[13px] text-fg">{t('cb.hk.trustBody')}</p>
            <KeyLine type={presented.type} sha256={presented.sha256} />
            <ErrorNote error={error} />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setDialog(null)}>
                {t('common.cancel')}
              </Button>
              <Button variant="primary" busy={busy} onClick={() => void post('accept', { sha256: presented.sha256 })}>
                {t('cb.hk.trustConfirm')}
              </Button>
            </div>
          </div>
        </Modal>
      )}
      {dialog === 'forget' && (
        <Modal title={t('cb.hk.forgetTitle')} onClose={() => setDialog(null)}>
          <div className="space-y-3">
            <p className="text-[13px] text-fg">{t('cb.hk.forgetBody')}</p>
            <ErrorNote error={error} />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setDialog(null)}>
                {t('common.cancel')}
              </Button>
              <Button variant="danger" busy={busy} onClick={() => void post('forget', { confirm: true })}>
                {t('cb.hk.forgetConfirm')}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </Card>
  );
}
