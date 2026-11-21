'use client';

import { Calculator } from 'lucide-react';
import { PageHeader } from '@/components/ui';
import { SubnetCalculator } from '@/features/ipam';
import { useI18n } from '@/lib/i18n';

/** Toolbox, Subnet calculator (spec §5): the IP-address page's calculator on its own, offline. It stays in Radar's IP addresses too. */
export function SubnetScreen() {
  const { t } = useI18n();
  return (
    <>
      <PageHeader icon={<Calculator className="size-[18px]" aria-hidden />} title={t('platform.nav.subnet')} description={t('platform.subnet.intro')} />
      <SubnetCalculator />
    </>
  );
}
