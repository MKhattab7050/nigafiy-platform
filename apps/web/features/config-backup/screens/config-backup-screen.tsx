'use client';

import { Archive, History, Plus, Radar } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useSiteScope } from '@/components/site-scope';
import { Async, Badge, Button, Card, DataTable, EmptyState, ErrorNote, PageHeader, type Tone } from '@/components/ui';
import { ButtonLink } from '@/components/widget';
import { type ApiError, api, qs } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { absoluteTime, relativeTime } from '@/lib/format';
import { type Key, fill, useI18n } from '@/lib/i18n';
import { TargetStatusBadge, VendorLabel } from '../components/status';
import { type AddedCode, AddTargetForm, hourText } from '../components/target-form';
import type { Suggestion, Suggestions, Target } from '../types';

const SSH_TONE: Record<Suggestion['ssh']['state'], Tone> = { open: 'ok', closed: 'idle', unknown: 'idle' };
const SOURCE_TONE = { observed: 'ok', inferred: 'info', manual: 'idle' } as const;
const SOURCE_KEY = { observed: 'common.observed', inferred: 'common.inferred', manual: 'common.manual' } as const;
const CONF = ['high', 'medium', 'low'] as const;

function SuggestionsCard({ siteId, onAdded }: { siteId: string; onAdded: (id: string) => void }) {
  const { t, locale } = useI18n();
  const { can } = useApp();
  const [pending, setPending] = useState<string | null>(null);
  const query = useQuery<Suggestions>(`/config-backup/suggestions${qs({ site_id: siteId })}`, ['devices'], pending ? 4000 : 60_000);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const lastProbe = query.data?.last_probe;
  const probing = Boolean(pending) || lastProbe?.status === 'pending';
  // Poll faster while the check we asked for runs; stop once the collector reported it (or it expired).
  useEffect(() => {
    if (pending && lastProbe?.id === pending && lastProbe.status !== 'pending') setPending(null);
  }, [pending, lastProbe?.id, lastProbe?.status]);

  const probe = async () => {
    setBusy('probe');
    setError(null);
    try {
      const r = await api<{ probe_id: string }>('/config-backup/probe', { method: 'POST', body: { site_id: siteId } });
      setPending(r.probe_id);
      query.reload();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(null);
    }
  };

  const add = async (s: Suggestion) => {
    setBusy(s.address);
    setError(null);
    try {
      const r = await api<{ items: Target[] }>('/config-backup/targets', { method: 'POST', body: { site_id: siteId, targets: [{ address: s.address }], run_now: false } });
      onAdded(r.items[0]!.id);
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(null);
    }
  };

  const last = query.data?.last_probe ?? null;
  return (
    <Card
      title={t('cb.sug.title')}
      description={t('cb.sug.hint')}
      action={
        can('technician') ? (
          <Button size="sm" busy={busy === 'probe' || probing} onClick={() => void probe()}>
            <Radar className="size-3.5" aria-hidden />
            {t('cb.probe.run')}
          </Button>
        ) : undefined
      }
      padded={false}
    >
      <div className="space-y-1 border-b border-line px-4 py-2.5 text-xs text-muted">
        <p>{t('cb.probe.hint')}</p>
        <p className="text-fg">
          {!last
            ? t('cb.probe.never')
            : last.status === 'pending'
              ? fill(t('cb.probe.pending'), { n: last.address_count })
              : last.status === 'expired'
                ? fill(t('cb.probe.expired'), { when: relativeTime(last.created_at, locale) })
                : fill(t('cb.probe.done'), { when: relativeTime(last.completed_at, locale), open: last.open_count ?? 0, n: last.address_count })}
        </p>
      </div>
      {error && (
        <div className="px-4 pt-3">
          <ErrorNote error={error} />
        </div>
      )}
      <Async query={query}>
        {({ items }) =>
          items.length === 0 ? (
            <EmptyState icon={<Radar />} title={t('cb.sug.none')}>
              <p>{t('cb.sug.noneHint')}</p>
            </EmptyState>
          ) : (
            <ul className="divide-y divide-line">
              {items.map((s) => {
                const conf = CONF.find((c) => c === s.suggested_driver.confidence) ?? null;
                return (
                  <li key={s.address} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
                    <div className="min-w-0 space-y-1">
                      <p className="text-[13.5px] font-medium">
                        {s.device_id ? (
                          <Link href={`/devices/${s.device_id}`} className="hover:underline" dir="auto">
                            {s.name ?? s.address}
                          </Link>
                        ) : (
                          <span dir="auto">{s.name ?? s.address}</span>
                        )}{' '}
                        <span className="mono text-xs text-muted" dir="ltr">
                          {s.address}
                        </span>
                      </p>
                      <div className="flex flex-wrap items-center gap-1.5 text-xs">
                        <Badge tone={SSH_TONE[s.ssh.state]}>{t(`cb.sug.ssh.${s.ssh.state}` as Key)}</Badge>
                        {s.ssh.server_version && (
                          <span className="mono text-faint" dir="ltr">
                            {s.ssh.server_version}
                          </span>
                        )}
                        <span className="text-muted">
                          {t('cb.sug.vendor')}: {s.suggested_driver.name ?? t('cb.sug.noVendor')}
                        </span>
                        {s.suggested_driver.driver && (
                          <Badge tone="info" dot={false}>
                            {t('common.inferred')}
                          </Badge>
                        )}
                        {conf && <span className="text-faint">{t(`dx.confidence.${conf}` as Key)}</span>}
                      </div>
                      <ul className="flex flex-wrap gap-1.5">
                        {s.reasons.map((r, i) => (
                          <li key={i}>
                            <Badge tone={SOURCE_TONE[r.source]} dot={false}>
                              {t(SOURCE_KEY[r.source])}: <span dir="auto">{r.text}</span>
                            </Badge>
                          </li>
                        ))}
                      </ul>
                    </div>
                    {can('admin') && (
                      <Button size="sm" busy={busy === s.address} onClick={() => void add(s)}>
                        <Plus className="size-3.5" aria-hidden />
                        {t('cb.sug.add')}
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )
        }
      </Async>
    </Card>
  );
}

function TargetsCard({ siteId }: { siteId: string }) {
  const { t, locale } = useI18n();
  const { can } = useApp();
  const query = useQuery<{ items: Target[] }>(`/config-backup/targets${qs({ site_id: siteId })}`, ['devices'], 30_000);
  return (
    <Card title={t('cb.targets')} padded={false}>
      <Async query={query}>
        {({ items }) =>
          items.length === 0 ? (
            <EmptyState icon={<Archive />} title={t('cb.empty')}>
              <p>{t('cb.emptyHint')}</p>
              {!can('admin') && <p className="text-xs text-faint">{t('cb.onlyAdmins')}</p>}
            </EmptyState>
          ) : (
            <DataTable stack>
              <thead>
                <tr>
                  <th>{t('cb.col.device')}</th>
                  <th>{t('cb.col.vendor')}</th>
                  <th>{t('cb.col.status')}</th>
                  <th>{t('cb.col.lastBackup')}</th>
                  <th>{t('cb.col.schedule')}</th>
                  <th>{t('cb.col.versions')}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((x) => (
                  <tr key={x.id}>
                    <td data-label={t('cb.col.device')}>
                      <Link href={`/config-backup/${x.id}`} className="font-medium text-accent-hover hover:underline" dir="auto">
                        {x.name}
                      </Link>
                      <span className="mono block text-xs text-muted" dir="ltr">
                        {x.address}:{x.port}
                      </span>
                    </td>
                    <td data-label={t('cb.col.vendor')}>
                      <VendorLabel target={x} />
                    </td>
                    <td data-label={t('cb.col.status')}>
                      <TargetStatusBadge target={x} />
                      {x.last_status === 'failed' && x.last_error_kind && <span className="mt-0.5 block text-xs text-muted">{t(`cb.err.${x.last_error_kind}` as Key)}</span>}
                    </td>
                    <td data-label={t('cb.col.lastBackup')} title={absoluteTime(x.last_success_at, locale)}>
                      {x.last_success_at ? relativeTime(x.last_success_at, locale) : t('common.never')}
                    </td>
                    <td data-label={t('cb.col.schedule')}>{x.schedule === 'daily' ? fill(t('cb.schedule.daily'), { hour: hourText(x.schedule_hour) }) : t('cb.schedule.off')}</td>
                    <td data-label={t('cb.col.versions')} className="tnum">
                      {x.version_count}
                    </td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          )
        }
      </Async>
    </Card>
  );
}

function SiteBackups({ siteId }: { siteId: string }) {
  const { t } = useI18n();
  const { can, sites } = useApp();
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const drivers = useQuery<Suggestions>(adding ? `/config-backup/suggestions${qs({ site_id: siteId })}` : null, [], 0);
  const timezone = sites.find((s) => s.id === siteId)?.timezone ?? 'UTC';
  const goTo = (id: string, added: AddedCode) => router.push(`/config-backup/${id}?added=${added}`);
  return (
    <div className="space-y-4">
      {can('admin') && !adding && (
        <div className="flex justify-end">
          <Button variant="primary" size="sm" onClick={() => setAdding(true)}>
            <Plus className="size-3.5" aria-hidden />
            {t('cb.addDevice')}
          </Button>
        </div>
      )}
      {!can('admin') && <p className="text-xs text-muted">{t('cb.onlyAdmins')}</p>}
      {adding && drivers.data && (
        <AddTargetForm siteId={siteId} timezone={timezone} drivers={drivers.data.drivers} onCancel={() => setAdding(false)} onDone={(r) => goTo(r.id, r.added)} />
      )}
      {adding && drivers.error && <ErrorNote error={drivers.error} onRetry={drivers.reload} />}
      <TargetsCard siteId={siteId} />
      <SuggestionsCard siteId={siteId} onAdded={(id) => goTo(id, 'noCreds')} />
    </div>
  );
}

export function ConfigBackupScreen() {
  const { t } = useI18n();
  const { siteId, picker } = useSiteScope();
  return (
    <>
      <PageHeader icon={<History className="size-[18px]" aria-hidden />} title={t('cb.title')} description={t('cb.subtitle')} actions={picker} />
      {siteId ? (
        <SiteBackups key={siteId} siteId={siteId} />
      ) : (
        <Card>
          <EmptyState icon={<Archive />} title={t('cb.noSite')} action={<ButtonLink href="/discovery">{t('cb.toDiscovery')}</ButtonLink>}>
            <p>{t('cb.noSiteHint')}</p>
          </EmptyState>
        </Card>
      )}
    </>
  );
}
