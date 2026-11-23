'use client';

import { Cable } from 'lucide-react';
import Link from 'next/link';
import type { SwitchSummary } from '@nigafiy/shared-types';
import { ProportionBar } from '@/components/charts';
import { Async, Badge } from '@/components/ui';
import { Metric, NextStep, Widget, attentionFrom } from '@/components/widget';
import { qs } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { useReportAttention } from '@/lib/attention';
import { fill, useI18n } from '@/lib/i18n';
import { portsText } from './text';

const STATUS_TONE = { never: 'idle', ok: 'ok', error: 'crit' } as const;

/** Dashboard: switches read over SNMP and how many ports are up (GET /switches). */
export default function PortsWidget() {
  const { t, locale } = useI18n();
  const tx = portsText(locale);
  const { siteId } = useApp();
  const query = useQuery<{ items: SwitchSummary[] }>(`/switches${qs({ site_id: siteId })}`, ['devices'], 20_000);

  useReportAttention(
    'ports',
    attentionFrom([query], ({ items }) =>
      items
        .filter((s) => s.enabled && s.last_status === 'error')
        .map((s) => ({ id: `switch-${s.id}`, tone: 'warn' as const, text: fill(t('ports.attn.error'), { name: s.name }), action: { label: t('ports.attn.check'), href: `/radar/ports?switch=${s.id}` } })),
    ),
  );

  return (
    <Widget title={t('nav.switchPorts')} icon={Cable} href="/radar/ports">
      <Async query={query}>
        {({ items }) => {
          if (items.length === 0) return <NextStep text={tx.emptyTitle} label={tx.addSwitch} href="/radar/ports" />;
          const ports = items.reduce((n, s) => n + s.port_count, 0);
          const up = items.reduce((n, s) => n + s.ports_up, 0);
          return (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <Metric label={tx.switches} value={items.length} />
                <Metric label={tx.portsUp} value={`${up} / ${ports}`} />
              </div>
              {ports > 0 && (
                <ProportionBar
                  label={tx.portsUp}
                  legend={false}
                  slices={[
                    { key: 'up', label: tx.portsUp, value: up, color: 'var(--color-series-1)' },
                    { key: 'rest', label: '', value: ports - up, color: 'var(--color-line-strong)' },
                  ]}
                />
              )}
              <ul className="divide-y divide-line rounded-[8px] border border-line">
                {items.slice(0, 4).map((s) => (
                  <li key={s.id}>
                    <Link href={`/radar/ports?switch=${s.id}`} className="flex items-center justify-between gap-3 px-3 py-2 hover:bg-raised/60">
                      <span className="min-w-0 truncate text-[13px]" dir="auto">
                        {s.name}
                      </span>
                      <Badge tone={s.enabled ? STATUS_TONE[s.last_status] : 'idle'}>{tx.status[s.last_status]}</Badge>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          );
        }}
      </Async>
    </Widget>
  );
}
