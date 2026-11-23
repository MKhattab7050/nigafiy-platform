'use client';

import { ShieldCheck } from 'lucide-react';
import type { AccessPage } from '@nigafiy/shared-types';
import { ProportionBar } from '@/components/charts';
import { Async, Badge, SectionLabel } from '@/components/ui';
import { Metric, NextStep, Widget, attentionFrom } from '@/components/widget';
import { qs } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { useReportAttention } from '@/lib/attention';
import { useI18n } from '@/lib/i18n';
import { accessText } from './text';

/**
 * Dashboard: is access control on, and is the filter actually running (GET /access)? Turning it on
 * stays an explicit admin action on the Access page; this widget only links there.
 */
export default function AccessWidget() {
  const { t, locale } = useI18n();
  const tx = accessText(locale);
  const { siteId, sites } = useApp();
  const site = siteId ?? sites[0]?.id ?? null;
  const query = useQuery<AccessPage>(site ? `/access${qs({ site_id: site })}` : null, ['devices', 'collectors'], 30_000);

  useReportAttention(
    'access',
    // No site yet: nothing to report here; the discovery widget already asks for the first setup step.
    !site ? { state: 'ready', items: [] } : attentionFrom([query], (data) => {
      if (!data.settings.enabled) return [];
      const s = data.setup;
      if (!s.collector?.online) return [{ id: 'access-collector', tone: 'crit' as const, text: t('access.attn.offline'), action: { label: t('access.attn.check'), href: '/guard/access' } }];
      if (s.status?.listening === false) return [{ id: 'access-listening', tone: 'crit' as const, text: t('access.attn.notListening'), action: { label: t('access.attn.check'), href: '/guard/access' } }];
      return [];
    }),
  );

  return (
    <Widget title={tx.title} icon={ShieldCheck} href="/guard/access">
      {!site ? (
        <NextStep text={tx.subtitle} label={t('overview.setupCta')} href="/radar/discovery" />
      ) : (
        <Async query={query}>
          {(data) => {
            if (!data.settings.enabled) return <NextStep text={tx.subtitle} label={tx.enable} href="/guard/access" />;
            const s = data.setup;
            const online = !!s.collector?.online;
            const running = online && s.status?.listening !== false;
            const off = data.devices.filter((d) => d.internet_off !== null).length;
            // Per-device 24 h counters reported by the filter; summed here, never estimated.
            const queries = data.devices.reduce((n, d) => n + d.queries_24h, 0);
            const blocked = data.devices.reduce((n, d) => n + d.blocked_24h, 0);
            return (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[13px] font-medium">{tx.enabled}</span>
                  <Badge tone={running ? 'ok' : 'crit'}>{!online ? tx.statusOff : running ? tx.statusListening : tx.statusNotListening}</Badge>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <Metric label={tx.protectedCount} value={s.protected_devices} tone={s.protected_devices ? 'ok' : 'idle'} />
                  <Metric label={tx.profiles} value={data.profiles.length} />
                </div>
                {queries > 0 && (
                  <div>
                    <SectionLabel>{t('dash.dnsBlocked')}</SectionLabel>
                    <ProportionBar
                      label={t('dash.dnsBlocked')}
                      slices={[
                        { key: 'allowed', label: t('dash.dnsAllowed'), value: queries - blocked, color: 'var(--color-series-1)' },
                        { key: 'blocked', label: t('dash.dnsBlockedPart'), value: blocked, color: 'var(--color-series-2)' },
                      ]}
                    />
                  </div>
                )}
                {off > 0 && <p className="tnum text-xs text-muted">{`${t('access.widget.offNow')}: ${off}`}</p>}
              </div>
            );
          }}
        </Async>
      )}
    </Widget>
  );
}
