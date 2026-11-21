'use client';

import { ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { Async, Badge, severityTone } from '@/components/ui';
import { Metric, Widget, attentionFrom } from '@/components/widget';
import { qs } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { useReportAttention } from '@/lib/attention';
import { type Key, fill, useI18n } from '@/lib/i18n';
import type { Finding } from './types';

/** Dashboard: open findings of the smart checks; critical and warning ones go to "Needs your attention". */
export default function SecurityWidget() {
  const { t } = useI18n();
  const { siteId } = useApp();
  const query = useQuery<{ items: Finding[] }>(`/security/findings${qs({ site_id: siteId, status: 'open', limit: 200 })}`, ['checks'], 60_000);

  useReportAttention(
    'security',
    attentionFrom([query], ({ items }) =>
      items
        .filter((f) => f.severity !== 'info' && !f.acknowledged_at)
        .slice(0, 5)
        .map((f) => ({
          id: `security-${f.id}`,
          tone: f.severity === 'critical' ? ('crit' as const) : ('warn' as const),
          text: fill(t('security.attn'), { title: f.title }),
          action: { label: t('security.attn.review'), href: '/guard/security' },
        })),
    ),
  );

  return (
    <Widget title={t('nav.security')} icon={ShieldCheck} href="/guard/security">
      <Async query={query}>
        {({ items }) => {
          const critical = items.filter((f) => f.severity === 'critical').length;
          const warning = items.filter((f) => f.severity === 'warning').length;
          return (
            <div className="space-y-3">
              <div className="grid grid-cols-3 gap-2">
                <Metric label={t('security.widget.open')} value={items.length} href="/guard/security" />
                <Metric label={t('security.widget.critical')} value={critical} tone={critical ? 'crit' : 'idle'} href="/guard/security" />
                <Metric label={t('security.widget.warning')} value={warning} tone={warning ? 'warn' : 'idle'} href="/guard/security" />
              </div>
              {items.length === 0 ? (
                <p className="text-xs leading-relaxed text-muted">{t('security.widget.none')}</p>
              ) : (
                <ul className="divide-y divide-line rounded-[8px] border border-line">
                  {items.slice(0, 4).map((f) => (
                    <li key={f.id}>
                      <Link href="/guard/security" className="flex items-center justify-between gap-3 px-3 py-2 hover:bg-raised/60">
                        <span className="min-w-0 truncate text-[13px]" dir="auto">
                          {f.title}
                        </span>
                        <Badge tone={severityTone(f.severity)}>{t(`security.sev.${f.severity}` as Key)}</Badge>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        }}
      </Async>
    </Widget>
  );
}
