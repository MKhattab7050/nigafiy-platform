'use client';

import { ShieldCheck, ShieldOff } from 'lucide-react';
import { useState } from 'react';
import { ButtonLink } from '@/components/widget';
import { useSiteScope } from '@/components/site-scope';
import { Async, Button, Card, EmptyState, ErrorNote, Notice, PageHeader, Segmented, Tabs } from '@/components/ui';
import { type ApiError, api, qs } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { type Key, fill, useI18n } from '@/lib/i18n';
import { CheckStatus } from '../components/check-status';
import { ExpectedList } from '../components/expected-list';
import { FindingRow } from '../components/finding-row';
import { Banners, DhcpServers, Fingerprints, UpnpGateways, WifiLinks } from '../components/measurements';
import { CHECKS, type Finding, type FindingCategory, RUNNABLE, type RunnableCheck, type SecurityOverview } from '../types';

type Tab = 'findings' | 'dhcp' | 'upnp' | 'wifi' | 'banners' | 'fingerprints' | 'expected';
type StatusFilter = 'open' | 'resolved' | 'all';

function FindingsList({ siteId, onChanged }: { siteId: string; onChanged: () => void }) {
  const { t } = useI18n();
  const [status, setStatus] = useState<StatusFilter>('open');
  const [category, setCategory] = useState<FindingCategory | 'all'>('all');
  const query = useQuery<{ items: Finding[] }>(`/security/findings${qs({ site_id: siteId, status, category: category === 'all' ? null : category })}`, ['checks'], 60_000);
  const filtered = status !== 'open' || category !== 'all';
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
        <Segmented
          label={t('security.f.status')}
          value={status}
          onChange={setStatus}
          options={(['open', 'resolved', 'all'] as const).map((v) => ({ value: v, label: t(`security.f.status.${v}` as Key) }))}
        />
        <Segmented
          label={t('security.f.category')}
          value={category}
          onChange={setCategory}
          options={(['all', 'dhcp', 'upnp', 'wifi'] as const).map((v) => ({ value: v, label: t(`security.f.category.${v}` as Key) }))}
        />
      </div>
      <Async query={query}>
        {({ items }) =>
          items.length === 0 ? (
            filtered ? (
              <p className="px-4 py-6 text-center text-[13px] text-muted">{t('security.f.noneFilter')}</p>
            ) : (
              <EmptyState icon={<ShieldCheck />} title={t('security.f.none')}>
                <p>{t('security.f.noneHint')}</p>
              </EmptyState>
            )
          ) : (
            <ul className="divide-y divide-line">
              {items.map((f) => (
                <FindingRow
                  key={f.id}
                  finding={f}
                  onChanged={() => {
                    query.reload();
                    onChanged();
                  }}
                />
              ))}
            </ul>
          )
        }
      </Async>
    </div>
  );
}

function SiteChecks({ siteId }: { siteId: string }) {
  const { t, locale } = useI18n();
  const { can } = useApp();
  const query = useQuery<SecurityOverview>(`/security${qs({ site_id: siteId })}`, ['checks'], 30_000);
  const [tab, setTab] = useState<Tab>('findings');
  const [running, setRunning] = useState<RunnableCheck[] | null>(null);
  const [queued, setQueued] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  const run = async (checks: RunnableCheck[]) => {
    setRunning(checks);
    setError(null);
    setQueued(null);
    try {
      const r = await api<{ checks: RunnableCheck[]; collectors: string[] }>('/security/run', { method: 'POST', body: { site_id: siteId, checks } });
      const sep = locale === 'ar' ? '، ' : ', ';
      setQueued(fill(t('security.runQueued'), { collectors: r.collectors.join(sep), checks: r.checks.map((c) => t(`security.check.${c}` as Key)).join(sep) }));
      query.reload();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setRunning(null);
    }
  };

  return (
    <Async query={query}>
      {(d) => {
        const online = d.collectors.some((c) => c.online);
        const canRun = can('technician');
        return (
          <div className="space-y-4">
            {d.collectors.length === 0 ? (
              <Card>
                <EmptyState icon={<ShieldOff />} title={t('security.noCollector')} action={<ButtonLink href="/discovery">{t('security.toDiscovery')}</ButtonLink>}>
                  <p>{t('security.noCollectorHint')}</p>
                </EmptyState>
              </Card>
            ) : (
              !online && <ErrorNote error={new Error(t('security.offline'))} />
            )}
            {!canRun && <p className="text-xs text-muted">{t('security.readOnly')}</p>}
            {canRun && d.collectors.length > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="primary" size="sm" busy={running !== null && running.length > 1} onClick={() => void run(RUNNABLE)}>
                  {t('security.runAll')}
                </Button>
              </div>
            )}
            {queued && <Notice>{queued}</Notice>}
            {error && <ErrorNote error={error} />}

            <div className="grid gap-4 lg:grid-cols-2">
              {CHECKS.map((check) => {
                const runnable = (RUNNABLE as string[]).includes(check);
                return (
                  <CheckStatus
                    key={check}
                    check={check}
                    schedule={d.schedule[check]}
                    runs={d.runs.filter((r) => r.check_kind === check)}
                    requestedAt={d.requests.find((r) => r.check_kind === check)?.requested_at ?? null}
                    canRun={canRun && d.collectors.length > 0}
                    running={running !== null && running.length === 1 && running[0] === check}
                    onRun={runnable ? () => void run([check as RunnableCheck]) : null}
                  />
                );
              })}
            </div>

            <Card padded={false}>
              <div className="px-4 pt-2">
                <Tabs<Tab>
                  label={t('security.title')}
                  value={tab}
                  onChange={setTab}
                  options={[
                    { value: 'findings', label: t('security.tab.findings'), count: d.findings.length },
                    { value: 'dhcp', label: t('security.tab.dhcp'), count: d.dhcp.servers.length },
                    { value: 'upnp', label: t('security.tab.upnp'), count: d.upnp.gateways.length },
                    { value: 'wifi', label: t('security.tab.wifi'), count: d.wifi.length },
                    { value: 'banners', label: t('security.tab.banners'), count: d.banners.length },
                    { value: 'fingerprints', label: t('security.tab.fingerprints'), count: d.fingerprints.length },
                    { value: 'expected', label: t('security.tab.expected'), count: d.expected.length },
                  ]}
                />
              </div>
              <div className="-mt-5">
                {tab === 'findings' && <FindingsList siteId={siteId} onChanged={query.reload} />}
                {tab === 'dhcp' && <DhcpServers dhcp={d.dhcp} />}
                {tab === 'upnp' && <UpnpGateways gateways={d.upnp.gateways} />}
                {tab === 'wifi' && <WifiLinks wifi={d.wifi} />}
                {tab === 'banners' && <Banners banners={d.banners} />}
                {tab === 'fingerprints' && <Fingerprints items={d.fingerprints} />}
                {tab === 'expected' && <ExpectedList siteId={siteId} items={d.expected} onChanged={query.reload} />}
              </div>
            </Card>
          </div>
        );
      }}
    </Async>
  );
}

export function SecurityScreen() {
  const { t } = useI18n();
  const { siteId, picker } = useSiteScope();
  return (
    <>
      <PageHeader icon={<ShieldCheck className="size-[18px]" aria-hidden />} title={t('security.title')} description={t('security.subtitle')} actions={picker} />
      {siteId ? (
        <SiteChecks key={siteId} siteId={siteId} />
      ) : (
        <Card>
          <EmptyState icon={<ShieldOff />} title={t('security.noSite')} action={<ButtonLink href="/discovery">{t('security.toDiscovery')}</ButtonLink>}>
            <p>{t('security.noSiteHint')}</p>
          </EmptyState>
        </Card>
      )}
    </>
  );
}
