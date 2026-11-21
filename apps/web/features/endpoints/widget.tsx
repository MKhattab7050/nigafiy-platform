'use client';

import { Cpu } from 'lucide-react';
import type { EndpointComplianceStatus, EndpointPlatform, EndpointSummary } from '@lan-detective/shared-types';
import { Donut, Legend, ProportionBar, SERIES } from '@/components/charts';
import { Async, SectionLabel } from '@/components/ui';
import { Metric, NextStep, Widget, attentionFrom } from '@/components/widget';
import { qs } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { useReportAttention } from '@/lib/attention';
import { fill, useI18n } from '@/lib/i18n';
import { endpointsText } from './text';

const isOnline = (e: EndpointSummary) => e.status === 'active' && e.connection_state === 'online';
const COMPLIANCE: { key: EndpointComplianceStatus; color: string }[] = [
  { key: 'compliant', color: 'var(--color-ok)' },
  { key: 'attention', color: 'var(--color-warn)' },
  { key: 'non_compliant', color: 'var(--color-crit)' },
  { key: 'unknown', color: 'var(--color-idle)' },
];
const PLATFORMS: EndpointPlatform[] = ['windows', 'linux', 'macos'];

/** Dashboard: managed computers — reachability, compliance split and platform mix (GET /endpoints). */
export default function EndpointsWidget() {
  const { t, locale } = useI18n();
  const tx = endpointsText(locale);
  const { siteId } = useApp();
  const query = useQuery<{ items: EndpointSummary[] }>(`/endpoints${qs({ site_id: siteId })}`, ['devices'], 30_000);

  useReportAttention(
    'endpoints',
    attentionFrom([query], ({ items }) => {
      const active = items.filter((e) => e.status !== 'revoked');
      const bad = active.filter((e) => e.compliance_status === 'non_compliant').length;
      const check = active.filter((e) => e.compliance_status === 'attention').length;
      return [
        ...(bad ? [{ id: 'endpoints-noncompliant', tone: 'crit' as const, text: fill(t('endpoints.attn.nonCompliant'), { count: bad }), action: { label: t('endpoints.attn.review'), href: '/endpoints' } }] : []),
        ...(check ? [{ id: 'endpoints-attention', tone: 'warn' as const, text: fill(t('endpoints.attn.attention'), { count: check }), action: { label: t('endpoints.attn.review'), href: '/endpoints' } }] : []),
      ];
    }),
  );

  return (
    <Widget title={t('nav.managedComputers')} icon={Cpu} href="/endpoints">
      <Async query={query}>
        {({ items }) => {
          const active = items.filter((e) => e.status !== 'revoked');
          if (active.length === 0) return <NextStep text={t('endpoints.widget.none')} label={t('endpoints.widget.enroll')} href="/endpoints" />;
          const online = active.filter(isOnline).length;
          const pending = active.filter((e) => e.status === 'pending').length;
          const offline = active.length - online - pending;
          const compliance = COMPLIANCE.map((c) => ({ key: c.key, label: tx.complianceStatus[c.key], value: active.filter((e) => e.compliance_status === c.key).length, color: c.color }));
          const platforms = PLATFORMS.map((p, i) => ({ key: p, label: tx.platforms[p], value: active.filter((e) => e.platform === p).length, color: SERIES[i]! }));
          return (
            <div className="space-y-5">
              <div className="grid grid-cols-3 gap-2">
                <Metric label={tx.fleetStats.total} value={active.length} />
                <Metric label={tx.online} value={online} tone={online ? 'ok' : 'idle'} />
                <Metric label={tx.offline} value={offline} tone={offline ? 'warn' : 'idle'} />
              </div>
              <div>
                <SectionLabel>{t('dash.compliance')}</SectionLabel>
                <div className="flex items-center gap-5">
                  <Donut slices={compliance} size={88} thickness={11} label={`${t('dash.compliance')}: ${compliance.map((c) => `${c.label} ${c.value}`).join(', ')}`}>
                    <span className="tnum text-base font-semibold leading-none">{compliance[0]!.value}</span>
                    <span className="mt-0.5 text-[10px] text-faint">/ {active.length}</span>
                  </Donut>
                  <div className="min-w-0 flex-1">
                    <Legend slices={compliance.filter((c) => c.value > 0 || c.key !== 'unknown')} total={active.length} />
                  </div>
                </div>
              </div>
              <div>
                <SectionLabel>{t('dash.platforms')}</SectionLabel>
                <ProportionBar label={t('dash.platforms')} slices={platforms} />
              </div>
              {pending > 0 && (
                <p className="tnum text-xs text-muted">
                  {tx.pending}: {pending}
                </p>
              )}
            </div>
          );
        }}
      </Async>
    </Widget>
  );
}
