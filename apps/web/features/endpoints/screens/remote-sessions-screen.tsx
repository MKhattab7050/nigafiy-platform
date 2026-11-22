'use client';

import { MonitorSmartphone } from 'lucide-react';
import { PageHeader } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { rdText } from '../components/remote-desktop/rd-text';
import { SessionHistory } from '../components/remote-desktop/session-history';

/** Nigafiy Fleet: every remote support session of the organization (technicians and above). */
export function RemoteSessionsScreen() {
  const { locale } = useI18n();
  const tx = rdText(locale);
  return (
    <div>
      <PageHeader title={tx.historyTitle} description={tx.historySubtitle} icon={<MonitorSmartphone className="size-5" aria-hidden />} />
      <SessionHistory limit={200} />
    </div>
  );
}
