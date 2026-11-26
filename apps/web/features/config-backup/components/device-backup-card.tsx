'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button, Card, ErrorNote, SkeletonBlock } from '@/components/ui';
import { type ApiError, api, qs } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { relativeTime } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { useView } from '@/lib/view';
import type { Suggestions, Target } from '../types';
import { TargetStatusBadge } from './status';

/**
 * Device page card: its backup target if there is one, otherwise "Back up this device" when the device is suggested.
 * The simple (Home) view shows it only for a device that is already backed up, so a home never meets the SSH
 * prompts; the full view always shows it.
 */
export function DeviceBackupCard({ deviceId, siteId }: { deviceId: string; siteId: string }) {
  const { t } = useI18n();
  const { view } = useView();
  const targets = useQuery<{ items: Target[] }>(`/config-backup/targets${qs({ site_id: siteId })}`, ['devices'], 60_000);
  if (view === 'home' && !targets.data?.items.some((x) => x.device_id === deviceId)) return null;
  return (
    <Card title={t('cb.card.title')}>
      <Body deviceId={deviceId} siteId={siteId} />
    </Card>
  );
}

function Body({ deviceId, siteId }: { deviceId: string; siteId: string }) {
  const { t, locale } = useI18n();
  const { can } = useApp();
  const router = useRouter();
  const targets = useQuery<{ items: Target[] }>(`/config-backup/targets${qs({ site_id: siteId })}`, ['devices'], 60_000);
  const target = targets.data?.items.find((x) => x.device_id === deviceId) ?? null;
  const suggestions = useQuery<Suggestions>(targets.data && !target ? `/config-backup/suggestions${qs({ site_id: siteId })}` : null, ['devices'], 120_000);
  const suggestion = suggestions.data?.items.find((s) => s.device_id === deviceId) ?? null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  if (targets.error && !targets.data) return <ErrorNote error={targets.error} onRetry={targets.reload} />;
  if (!targets.data || (!target && !suggestions.data && !suggestions.error)) return <SkeletonBlock lines={2} />;

  if (target)
    return (
      <div className="space-y-2 text-[13px]">
        <p className="flex flex-wrap items-center gap-2">
          <TargetStatusBadge target={target} />
          <span className="text-muted">{target.last_success_at ? relativeTime(target.last_success_at, locale) : t('common.never')}</span>
        </p>
        <Link href={`/guard/config-backup/${target.id}`} className="text-accent-hover hover:underline">
          {t('cb.card.open')}
        </Link>
      </div>
    );

  const add = async () => {
    if (!suggestion) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ items: Target[] }>('/config-backup/targets', { method: 'POST', body: { site_id: siteId, targets: [{ address: suggestion.address }], run_now: false } });
      router.push(`/guard/config-backup/${r.items[0]!.id}?added=noCreds`);
    } catch (e) {
      setError(e as ApiError);
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2 text-[13px] text-muted">
      {suggestion ? (
        <>
          <p>{t('cb.card.suggest')}</p>
          <p className="text-xs">{suggestion.reasons.map((r) => r.text).join(' · ')}</p>
          {can('admin') ? (
            <Button size="sm" variant="primary" busy={busy} onClick={() => void add()}>
              {t('cb.card.add')}
            </Button>
          ) : (
            <p className="text-xs">{t('cb.onlyAdmins')}</p>
          )}
          {error && <ErrorNote error={error} />}
        </>
      ) : (
        <>
          <p>{suggestions.error ? suggestions.error.message : t('cb.card.none')}</p>
          <Link href="/guard/config-backup" className="text-accent-hover hover:underline">
            {t('cb.card.openPage')}
          </Link>
        </>
      )}
    </div>
  );
}
