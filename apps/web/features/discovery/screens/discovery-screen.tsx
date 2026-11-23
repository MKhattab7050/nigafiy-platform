'use client';

import { Plus, Radar } from 'lucide-react';
import { useState } from 'react';
import type { Collector, CollectorCreated, NetworkScope } from '@nigafiy/shared-types';
import { Async, Button, Card, EmptyState, ErrorNote, Field, Input, Notice, PageHeader } from '@/components/ui';
import { type ApiError, api } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { browserTimeZone } from '@/lib/format';
import { fill, useI18n } from '@/lib/i18n';
import { TokenModal } from '../components/token-modal';
import { SiteSection } from '../components/site-section';

export function DiscoveryScreen() {
  const { t } = useI18n();
  const { sites, siteId, reloadSites, can } = useApp();
  const scopes = useQuery<{ items: NetworkScope[] }>('/scopes', ['collectors', 'devices']);
  const collectors = useQuery<{ items: Collector[] }>('/collectors', ['collectors'], 15_000);
  const [token, setToken] = useState<CollectorCreated | null>(null);
  const [siteName, setSiteName] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const [created, setCreated] = useState('');
  const reload = () => {
    scopes.reload();
    collectors.reload();
    reloadSites();
  };
  const visible = sites.filter((s) => !siteId || s.id === siteId);

  return (
    <>
      <PageHeader icon={<Radar className="size-[18px]" aria-hidden />} title={t('discovery.title')} description={t('discovery.intro')} />
      <Async query={scopes}>
        {(sc) => (
          <Async query={collectors}>
            {(co) => (
              <div className="space-y-4">
                {visible.length === 0 && (
                  <Card>
                    <EmptyState icon={<Radar className="size-8" />} title={t('common.noData')} />
                  </Card>
                )}
                {visible.map((site) => (
                  <SiteSection
                    key={site.id}
                    site={site}
                    scopes={sc.items.filter((s) => s.site_id === site.id)}
                    collectors={co.items.filter((c) => c.site_id === site.id)}
                    reload={reload}
                    onToken={setToken}
                  />
                ))}
                {can('admin') && (
                  <form
                    className="space-y-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      setError(null);
                      setCreated('');
                      // The new site starts in this browser's time zone; it is shown and editable on the site card.
                      const timezone = browserTimeZone();
                      api('/sites', { method: 'POST', body: { name: siteName.trim(), ...(timezone ? { timezone } : {}) } })
                        .then(() => {
                          setSiteName('');
                          if (timezone) setCreated(timezone);
                          reload();
                        })
                        .catch((err: ApiError) => setError(err));
                    }}
                  >
                    <div className="flex flex-wrap items-end gap-2">
                      <div className="w-full sm:w-64">
                        <Field label={t('discovery.siteName')}>{(id) => <Input id={id} value={siteName} onChange={(e) => setSiteName(e.target.value)} maxLength={80} />}</Field>
                      </div>
                      <Button type="submit" disabled={!siteName.trim()}>
                        <Plus className="size-4" aria-hidden />
                        {t('discovery.addSite')}
                      </Button>
                    </div>
                    {created && <Notice>{fill(t('discovery.site.newTimezone'), { zone: created })}</Notice>}
                    {error && <ErrorNote error={error} />}
                  </form>
                )}
              </div>
            )}
          </Async>
        )}
      </Async>
      {token && <TokenModal created={token} onClose={() => setToken(null)} />}
    </>
  );
}
