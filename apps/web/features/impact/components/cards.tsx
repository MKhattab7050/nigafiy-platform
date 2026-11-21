'use client';

import { GitBranch } from 'lucide-react';
import Link from 'next/link';
import type { ImpactResult, SpofReport } from '@lan-detective/shared-types';
import { Async, Card, SkeletonBlock } from '@/components/ui';
import { qs } from '@/lib/api';
import { useQuery } from '@/lib/app';
import { useI18n } from '@/lib/i18n';
import { ImpactResultView } from './impact-result';
import { SpofList } from './spof-list';

/** Device page: "what depends on this device?" (GET /impact/devices/:id). */
export function DeviceImpactCard({ deviceId, siteId }: { deviceId: string; siteId: string }) {
  const { t } = useI18n();
  const query = useQuery<ImpactResult>(`/impact/devices/${deviceId}`, ['devices', 'collectors'], 120_000);
  return (
    <Card
      title={t('imp.device.title')}
      action={
        <Link href={`/watch/impact${qs({ site: siteId, device: deviceId })}`} className="text-xs font-medium text-accent-hover hover:underline">
          {t('imp.device.open')}
        </Link>
      }
    >
      <Async query={query} skeleton={<SkeletonBlock lines={3} />}>
        {(r) => <ImpactResultView result={r} hideFailed />}
      </Async>
    </Card>
  );
}

/** Network map page: the site's single points of failure (GET /impact/spof). */
export function TopologySpofCard({ siteId }: { siteId: string }) {
  const { t } = useI18n();
  const query = useQuery<SpofReport>(`/impact/spof${qs({ site_id: siteId })}`, ['devices', 'collectors'], 120_000);
  return (
    <Card
      title={t('imp.topo.title')}
      description={t('imp.spof.hint')}
      padded={false}
      action={
        <Link href={`/watch/impact${qs({ site: siteId })}`} className="inline-flex items-center gap-1 text-xs font-medium text-accent-hover hover:underline">
          <GitBranch className="size-3.5" aria-hidden />
          {t('imp.topo.more')}
        </Link>
      }
    >
      <Async query={query} skeleton={<SkeletonBlock className="px-4 py-3" lines={3} />}>
        {(r) => (r.items.length ? <SpofList items={r.items} limit={5} /> : <p className="px-4 py-3 text-[13px] text-muted">{t('imp.spof.none')}</p>)}
      </Async>
    </Card>
  );
}
