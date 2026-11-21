'use client';

import { Clock } from 'lucide-react';
import { useState } from 'react';
import { PageHeader, Segmented } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { SnapshotView } from '../components/snapshot-view';
import { CompareView } from '../components/compare-view';

export function TimeMachineScreen() {
  const { t } = useI18n();
  const [tab, setTab] = useState<'snapshot' | 'compare'>('snapshot');
  return (
    <>
      <PageHeader icon={<Clock className="size-[18px]" aria-hidden />}
        title={t('tm.title')}
        description={t('tm.intro')}
        actions={<Segmented label={t('tm.title')} value={tab} onChange={setTab} options={[{ value: 'snapshot', label: t('tm.tab.snapshot') }, { value: 'compare', label: t('tm.tab.compare') }]} />}
      />
      {tab === 'snapshot' ? <SnapshotView /> : <CompareView />}
    </>
  );
}
