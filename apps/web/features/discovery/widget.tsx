'use client';

import { Radar, ScanSearch } from 'lucide-react';
import { useState } from 'react';
import type { Collector, NetworkScope } from '@lan-detective/shared-types';
import { Async, Badge, Button, ErrorNote } from '@/components/ui';
import { NextStep, Widget, attentionFrom } from '@/components/widget';
import { type ApiError, api } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { type AttentionItem, useReportAttention } from '@/lib/attention';
import { relativeTime } from '@/lib/format';
import { fill, useI18n } from '@/lib/i18n';
import { ScopeSuggestionList, useScopeSuggestions } from './components/scope-suggestions';

/** Dashboard: are the collectors reporting, and is there anything authorized to scan? (GET /collectors, GET /scopes) */
export default function DiscoveryWidget() {
  const { t, locale } = useI18n();
  const { siteId, sites, can } = useApp();
  const collectors = useQuery<{ items: Collector[] }>('/collectors', ['collectors'], 15_000);
  const scopes = useQuery<{ items: NetworkScope[] }>('/scopes', ['collectors', 'devices']);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const inSite = <T extends { site_id: string }>(list: T[]) => list.filter((x) => !siteId || x.site_id === siteId);
  // Nothing authorized yet: offer the ranges the collectors detected (for the selected site, or the only one).
  const targetSite = siteId ?? (sites.length === 1 ? sites[0]!.id : null);
  const noRanges = scopes.data !== undefined && inSite(scopes.data.items).length === 0;
  const suggestions = useScopeSuggestions(noRanges ? targetSite : null);

  useReportAttention(
    'discovery',
    attentionFrom([collectors, scopes], (co, sc) => {
      const list = inSite(co.items).filter((c) => c.status !== 'revoked');
      const items: AttentionItem[] = [];
      if (list.length === 0) items.push({ id: 'collector-none', tone: 'info', text: t('discovery.widget.noCollector'), action: { label: t('discovery.widget.install'), href: '/sensors' } });
      for (const c of list) {
        if (c.status === 'active' && c.connection_state === 'offline')
          items.push({ id: `collector-off-${c.id}`, tone: 'crit', text: fill(t('discovery.attn.offline'), { name: c.name }), action: { label: t('discovery.attn.check'), href: '/sensors' } });
        if (c.status === 'pending') items.push({ id: `collector-pending-${c.id}`, tone: 'info', text: fill(t('discovery.attn.pending'), { name: c.name }), action: { label: t('discovery.widget.install'), href: '/sensors' } });
      }
      if (list.length > 0 && inSite(sc.items).filter((s) => s.enabled).length === 0)
        items.push({ id: 'scope-none', tone: 'warn', text: t('discovery.attn.noScope'), action: { label: t('discovery.addScope'), href: '/radar/discovery' } });
      return items;
    }),
  );

  async function scan(c: Collector) {
    setBusy(c.id);
    setError(null);
    setNotice('');
    try {
      await api(`/collectors/${c.id}/scan`, { method: 'POST' });
      setNotice(t('discovery.scanQueued'));
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy('');
    }
  }

  return (
    <Widget title={t('overview.collectors')} icon={Radar} href="/radar/discovery">
      <Async query={collectors}>
        {(co) => {
          const list = inSite(co.items).filter((c) => c.status !== 'revoked');
          if (list.length === 0) return <NextStep text={t('discovery.widget.noCollector')} label={t('discovery.widget.install')} href="/sensors" />;
          const ranges = scopes.data ? inSite(scopes.data.items) : null;
          return (
            <div className="space-y-3">
              {error && <ErrorNote error={error} />}
              {notice && (
                <p role="status" className="rounded-md border border-accent/30 bg-accent/10 px-3 py-2 text-xs">
                  {notice}
                </p>
              )}
              <ul className="divide-y divide-line rounded-md border border-line">
                {list.map((c) => (
                  <li key={c.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2">
                    <span className="min-w-0 truncate text-[13px] font-medium" dir="auto">
                      {c.name}
                    </span>
                    {c.status === 'pending' ? (
                      <Badge tone="info">{t('discovery.pending')}</Badge>
                    ) : (
                      <Badge tone={c.connection_state === 'online' ? 'ok' : c.connection_state === 'offline' ? 'crit' : 'idle'}>{t(`discovery.conn.${c.connection_state}`)}</Badge>
                    )}
                    {c.status === 'active' && (
                      <span className="text-[11px] text-faint">
                        {t('discovery.lastHeartbeat')}: {c.last_heartbeat_at ? relativeTime(c.last_heartbeat_at, locale) : t('common.never')}
                      </span>
                    )}
                    {c.status === 'active' && c.connection_state === 'online' && can('technician') && (
                      <Button size="sm" className="ms-auto" busy={busy === c.id} onClick={() => void scan(c)}>
                        <ScanSearch className="size-3.5" aria-hidden />
                        {t('discovery.scanNow')}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
              {ranges && ranges.length === 0 && targetSite && suggestions.data && suggestions.data.items.length > 0 && (
                <div>
                  <p className="mb-1.5 text-xs font-medium text-fg">{t('discovery.sugg.title')}</p>
                  <ScopeSuggestionList
                    siteId={targetSite}
                    items={suggestions.data.items}
                    admin={can('admin')}
                    limit={2}
                    onAuthorized={() => {
                      suggestions.reload();
                      scopes.reload();
                    }}
                  />
                </div>
              )}
              {ranges && (
                <p className="text-xs text-muted">
                  {t('discovery.scopes')}:{' '}
                  {ranges.length === 0 ? (
                    <span className="text-warn">{t('common.none')}</span>
                  ) : (
                    <span className="mono">{ranges.map((s) => s.cidr).join(', ')}</span>
                  )}
                </p>
              )}
            </div>
          );
        }}
      </Async>
    </Widget>
  );
}
