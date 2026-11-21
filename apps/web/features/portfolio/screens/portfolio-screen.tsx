'use client';

import { Building2, Lock } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { PortfolioOrganizations, PortfolioSites } from '@lan-detective/shared-types';
import { Async, Badge, Button, Card, DataTable, EmptyState, ErrorNote, PageHeader, SkeletonBlock } from '@/components/ui';
import { type ApiError, api } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { type Key, fill, useI18n } from '@/lib/i18n';
import { KpiCells, KpiHeaders } from '../components/kpi-cells';

export function PortfolioScreen() {
  const { t } = useI18n();
  const { me, setSiteId } = useApp();
  const router = useRouter();
  const sites = useQuery<PortfolioSites>('/portfolio/sites', ['devices', 'events', 'checks', 'collectors'], 60_000);
  const orgs = useQuery<PortfolioOrganizations>(me.memberships.length > 1 ? '/portfolio/organizations' : null, ['devices', 'events', 'checks', 'collectors'], 120_000);
  const [switching, setSwitching] = useState('');
  const [error, setError] = useState<ApiError | null>(null);

  async function switchOrg(id: string) {
    setSwitching(id);
    setError(null);
    try {
      await api('/auth/switch-organization', { method: 'POST', body: { organization_id: id } });
      window.location.href = '/portfolio';
    } catch (err) {
      setError(err as ApiError);
      setSwitching('');
    }
  }

  return (
    <>
      <PageHeader icon={<Building2 className="size-[18px]" aria-hidden />} title={t('pf.title')} description={t('pf.intro')} />
      <div className="space-y-4">
        <Card title={fill(t('pf.sites'), { org: me.organization.name })} padded={false}>
          <Async query={sites} skeleton={<SkeletonBlock className="p-4" lines={4} />}>
            {(r) =>
              r.items.length === 0 ? (
                <EmptyState icon={<Building2 />} title={t('pf.noSites')} />
              ) : (
                <DataTable minWidth={960}>
                  <thead>
                    <tr className="border-b border-line text-xs text-muted">
                      <th className="px-3 py-2 text-start font-medium">{t('pf.col.site')}</th>
                      <KpiHeaders />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {r.items.map((s) => (
                      <tr key={s.site_id}>
                        <td className="px-3 py-2.5 align-top">
                          <span className="block text-[13px] font-medium" dir="auto">
                            {s.name}
                          </span>
                          <span className="mono block text-[11px] text-faint">{s.timezone}</span>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="-ms-2.5 mt-1"
                            onClick={() => {
                              setSiteId(s.site_id);
                              router.push('/');
                            }}
                          >
                            {t('pf.openSite')}
                          </Button>
                        </td>
                        <KpiCells k={s} />
                      </tr>
                    ))}
                  </tbody>
                </DataTable>
              )
            }
          </Async>
        </Card>

        {me.memberships.length > 1 && (
          <Card title={t('pf.orgs')} padded={false}>
            {error && (
              <div className="p-3">
                <ErrorNote error={error} />
              </div>
            )}
            <Async query={orgs} skeleton={<SkeletonBlock className="p-4" lines={3} />}>
              {(r) => (
                <DataTable minWidth={1040}>
                  <thead>
                    <tr className="border-b border-line text-xs text-muted">
                      <th className="px-3 py-2 text-start font-medium">{t('pf.col.org')}</th>
                      <th className="px-3 py-2 text-start font-medium">{t('pf.col.sites')}</th>
                      <KpiHeaders />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {r.items.map((o) => (
                      <tr key={o.organization_id}>
                        <td className="px-3 py-2.5 align-top">
                          <span className="block text-[13px] font-medium" dir="auto">
                            {o.name}
                          </span>
                          <span className="block text-[11px] text-faint">{t(`control.role.${o.role}` as Key)}</span>
                          {o.current ? (
                            <Badge tone="info" dot={false}>
                              {t('pf.current')}
                            </Badge>
                          ) : (
                            <Button size="sm" variant="ghost" className="-ms-2.5 mt-1" busy={switching === o.organization_id} onClick={() => void switchOrg(o.organization_id)}>
                              {t('pf.switch')}
                            </Button>
                          )}
                        </td>
                        <td className="tnum px-3 py-2.5 align-top text-[13px]">{o.sites}</td>
                        {o.locked ? (
                          <td colSpan={6} className="px-3 py-2.5 align-top text-xs text-muted">
                            <span className="inline-flex items-center gap-1.5 font-medium text-fg">
                              <Lock className="size-3.5" aria-hidden />
                              {t('pf.locked')}
                            </span>
                            <span className="block">{t('pf.lockedHint')}</span>
                          </td>
                        ) : (
                          <KpiCells k={o} />
                        )}
                      </tr>
                    ))}
                  </tbody>
                </DataTable>
              )}
            </Async>
          </Card>
        )}
      </div>
    </>
  );
}
