'use client';

import type { SwitchSummary } from '@lan-detective/shared-types';
import { ArrowRight, ToggleRight } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { Async, Card, Field, PageHeader, Select } from '@/components/ui';
import { ProgramLink } from '@/features/platform';
import { qs } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { useI18n } from '@/lib/i18n';
import { RequestHistory } from '../components/request-history';
import { SitePortControlCard } from '../components/site-port-control';
import { SwitchControlCard } from '../components/switch-control';

/**
 * Guard, Switch port control (spec §5): the site's quarantine VLAN, each switch's write credentials,
 * VLANs and quarantined devices, and the history of every port change. The same components that
 * used to sit under Radar's port list; the per-port buttons stay on the port rows.
 */
function PortControlView() {
  const { t } = useI18n();
  const { siteId, sites, can } = useApp();
  const router = useRouter();
  const params = useSearchParams();
  const admin = can('admin');
  const list = useQuery<{ items: SwitchSummary[] }>(`/switches${qs({ site_id: siteId })}`, ['devices'], 20_000);
  const settingsSite = siteId ?? (sites.length === 1 ? sites[0]!.id : null);
  const raw = params.get('switch');
  const selected = (raw && list.data?.items.some((s) => s.id === raw) ? raw : list.data?.items[0]?.id) ?? null;

  return (
    <>
      <PageHeader icon={<ToggleRight className="size-[18px]" aria-hidden />} title={t('platform.nav.portControl')} description={t('platform.portControl.intro')} />
      <div className="space-y-4">
        {settingsSite ? (
          <SitePortControlCard siteId={settingsSite} admin={admin} />
        ) : (
          <Card>
            <p className="text-[13px] text-muted">{t('platform.portControl.pickSite')}</p>
          </Card>
        )}
        <Async query={list}>
          {(data) =>
            data.items.length === 0 ? (
              <Card>
                <p className="text-[13px] text-muted">{t('platform.portControl.noSwitch')}</p>
                <ProgramLink program="radar" href="/radar/ports" className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-accent-hover hover:underline">
                  {t('platform.portControl.toPorts')}
                  <ArrowRight className="size-3.5 rtl:-scale-x-100" aria-hidden />
                </ProgramLink>
              </Card>
            ) : (
              <>
                {data.items.length > 1 && (
                  <div className="w-full sm:w-80">
                    <Field label={t('platform.portControl.switch')}>
                      {(id) => (
                        <Select id={id} value={selected ?? ''} onChange={(e) => router.replace(`/guard/port-control?switch=${encodeURIComponent(e.target.value)}`)}>
                          {data.items.map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.name} ({s.host})
                            </option>
                          ))}
                        </Select>
                      )}
                    </Field>
                  </div>
                )}
                {selected && <SwitchControlCard key={selected} switchId={selected} admin={admin} />}
              </>
            )
          }
        </Async>
        <Card title={t('platform.portControl.history')} padded={false}>
          <div className="pt-1">
            <RequestHistory limit={50} />
          </div>
        </Card>
      </div>
    </>
  );
}

export function PortControlScreen() {
  return (
    <Suspense>
      <PortControlView />
    </Suspense>
  );
}
