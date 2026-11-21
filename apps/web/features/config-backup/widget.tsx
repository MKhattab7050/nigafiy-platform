'use client';

import { History } from 'lucide-react';
import Link from 'next/link';
import { Async } from '@/components/ui';
import { Metric, NextStep, Widget, attentionFrom } from '@/components/widget';
import { qs } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { useReportAttention } from '@/lib/attention';
import { fill, useI18n } from '@/lib/i18n';
import { TargetStatusBadge } from './components/status';
import type { Target } from './types';

const needsDecision = (x: Target) => x.readiness === 'host_key_changed' || x.readiness === 'credentials_rejected';

/** Dashboard: backed-up devices; failed backups and changed host keys go to "Needs your attention". */
export default function ConfigBackupWidget() {
  const { t } = useI18n();
  const { siteId } = useApp();
  const query = useQuery<{ items: Target[] }>(`/config-backup/targets${qs({ site_id: siteId })}`, ['devices'], 60_000);

  useReportAttention(
    'config-backup',
    attentionFrom([query], ({ items }) =>
      items
        .filter((x) => x.enabled && (needsDecision(x) || x.last_status === 'failed'))
        .slice(0, 5)
        .map((x) => ({
          id: `config-backup-${x.id}`,
          tone: needsDecision(x) ? ('crit' as const) : ('warn' as const),
          text: fill(t(x.readiness === 'host_key_changed' ? 'cb.attn.hostKey' : x.readiness === 'credentials_rejected' ? 'cb.attn.creds' : 'cb.attn.failed'), { name: x.name }),
          action: { label: t('cb.attn.open'), href: `/config-backup/${x.id}` },
        })),
    ),
  );

  return (
    <Widget title={t('nav.configBackup')} icon={History} href="/config-backup">
      <Async query={query}>
        {({ items }) => {
          if (items.length === 0) return <NextStep text={t('cb.widget.empty')} label={t('cb.addDevice')} href="/config-backup" />;
          const failing = items.filter((x) => x.enabled && x.last_status === 'failed').length;
          const decide = items.filter(needsDecision).length;
          return (
            <div className="space-y-3">
              <div className="grid grid-cols-3 gap-2">
                <Metric label={t('cb.widget.devices')} value={items.length} href="/config-backup" />
                <Metric label={t('cb.widget.failing')} value={failing} tone={failing ? 'warn' : 'idle'} href="/config-backup" />
                <Metric label={t('cb.widget.attention')} value={decide} tone={decide ? 'crit' : 'idle'} href="/config-backup" />
              </div>
              <ul className="divide-y divide-line rounded-[8px] border border-line">
                {items.slice(0, 4).map((x) => (
                  <li key={x.id}>
                    <Link href={`/config-backup/${x.id}`} className="flex items-center justify-between gap-3 px-3 py-2 hover:bg-raised/60">
                      <span className="min-w-0 truncate text-[13px]" dir="auto">
                        {x.name}
                      </span>
                      <TargetStatusBadge target={x} />
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
