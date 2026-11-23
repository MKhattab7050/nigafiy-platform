'use client';

import { ShieldCheck } from 'lucide-react';
import type { AccessPage } from '@nigafiy/shared-types';
import { Async, PageHeader } from '@/components/ui';
import { qs } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { useI18n } from '@/lib/i18n';
import { MasterSwitch } from '../components/master-switch';
import { Setup } from '../components/setup';
import { SiteRules } from '../components/site-rules';
import { Profiles } from '../components/profiles';
import { Devices } from '../components/access-devices';
import { EnforcementBanner } from '../components/enforcement-banner';
import { accessText } from '../text';

export function AccessScreen() {
  const { locale } = useI18n();
  const tx = accessText(locale);
  const { siteId, sites, can } = useApp();
  const site = siteId ?? sites[0]?.id ?? null;
  const query = useQuery<AccessPage>(site ? `/access${qs({ site_id: site })}` : null, ['devices', 'collectors'], 20_000);
  const admin = can('admin');

  return (
    <>
      <PageHeader icon={<ShieldCheck className="size-[18px]" aria-hidden />} title={tx.title} description={tx.subtitle} />
      {!site ? null : (
        <Async query={query}>
          {(data) => (
            <div className="space-y-4">
              <MasterSwitch data={data} site={site} admin={admin} onChanged={query.reload} />
              <EnforcementBanner data={data} />
              {data.settings.enabled && <Setup data={data} />}
              {/* Re-mount when the saved rules change elsewhere (e.g. enabling with ads & malware) so the form never saves stale values back. */}
              <SiteRules key={`${site}:${JSON.stringify(data.settings)}`} data={data} site={site} admin={admin} onChanged={query.reload} />
              <Profiles data={data} site={site} admin={admin} canPause={can('technician')} onChanged={query.reload} />
              <Devices data={data} admin={admin} canPause={can('technician')} onChanged={query.reload} />
            </div>
          )}
        </Async>
      )}
    </>
  );
}
