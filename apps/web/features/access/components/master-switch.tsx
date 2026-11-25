'use client';

import { ShieldCheck, ShieldOff } from 'lucide-react';
import { useState } from 'react';
import type { AccessPage } from '@nigafiy/shared-types';
import { Button, Card, ErrorNote, Modal, useConfirm } from '@/components/ui';
import { type ApiError, api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { accessText } from '../text';

const ADS_MALWARE = 'ads_malware';

export function MasterSwitch({ data, site, admin, onChanged }: { data: AccessPage; site: string; admin: boolean; onChanged: () => void }) {
  const { locale, t } = useI18n();
  const confirm = useConfirm();
  const tx = accessText(locale);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const on = data.settings.enabled;
  const s = data.settings;
  // No rule was ever saved for this site: treat it as the first time and offer the ads & malware list, pre-selected.
  const firstTime = !on && data.categories.includes(ADS_MALWARE) && s.blocked_categories.length === 0 && s.blocked_domains.length === 0 && s.allowed_domains.length === 0;
  const [adsMalware, setAdsMalware] = useState(true);

  async function put(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      await api('/access/settings', { method: 'PUT', body: { site_id: site, ...body } });
      setConfirming(false);
      onChanged();
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  }

  async function toggle() {
    if (on) {
      if (await confirm(tx.disableConfirm, { destructive: true })) void put({ enabled: false });
      return;
    }
    setAdsMalware(true);
    setError(null);
    setConfirming(true);
  }

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          {on ? <ShieldCheck className="size-6 text-ok" aria-hidden /> : <ShieldOff className="size-6 text-faint" aria-hidden />}
          <div>
            <p className="font-medium">{on ? tx.enabled : tx.enable}</p>
            {on && (
              <p className="text-xs text-muted">
                <span className="tnum">{data.setup.protected_devices}</span> {tx.protectedCount}
              </p>
            )}
          </div>
        </div>
        {admin ? (
          <Button variant={on ? 'secondary' : 'primary'} busy={busy && !confirming} onClick={toggle}>
            {on ? tx.disable : tx.enable}
          </Button>
        ) : (
          <span className="text-xs text-muted">{tx.onlyAdmins}</span>
        )}
      </div>
      {error && !confirming && (
        <div className="mt-3">
          <ErrorNote error={error} />
        </div>
      )}
      {confirming && (
        <Modal title={t('access.enable.title')} onClose={() => setConfirming(false)}>
          <div className="space-y-4">
            <p className="text-[13px] leading-relaxed text-fg">{tx.enableConfirm}</p>
            {firstTime && (
              <label className="flex cursor-pointer items-start gap-2.5 rounded-[var(--radius-control)] border border-line p-3">
                <input type="checkbox" checked={adsMalware} onChange={(e) => setAdsMalware(e.target.checked)} className="mt-0.5 size-4 shrink-0 accent-[var(--color-accent)]" />
                <span>
                  <span className="block text-[13px] text-fg">{t('access.enable.adsMalware')}</span>
                  <span className="block text-xs text-muted">{t('access.enable.adsMalwareHint')}</span>
                </span>
              </label>
            )}
            {error && <ErrorNote error={error} />}
            <div className="flex justify-end gap-2">
              <Button onClick={() => setConfirming(false)}>{t('common.cancel')}</Button>
              <Button
                variant="primary"
                busy={busy}
                onClick={() => void put({ enabled: true, ...(firstTime && adsMalware ? { blocked_categories: [...new Set([...s.blocked_categories, ADS_MALWARE])] } : {}) })}
              >
                {t('access.enable.confirm')}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </Card>
  );
}
