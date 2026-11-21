'use client';

import { Bell } from 'lucide-react';
import type { NotificationChannel } from '@lan-detective/shared-types';
import { Async } from '@/components/ui';
import { Metric, NextStep, Widget, attentionFrom } from '@/components/widget';
import { useQuery } from '@/lib/app';
import { type AttentionItem, useReportAttention } from '@/lib/attention';
import { fill, useI18n } from '@/lib/i18n';

/** Dashboard (admins): will anyone hear about an outage? Notification channels and their last delivery (GET /notification-channels). */
export default function SettingsWidget() {
  const { t } = useI18n();
  const query = useQuery<{ items: NotificationChannel[] }>('/notification-channels', ['events'], 30_000);

  useReportAttention(
    'settings',
    attentionFrom([query], ({ items }) => {
      const out: AttentionItem[] = [];
      if (items.filter((c) => c.enabled).length === 0) out.push({ id: 'channels-none', tone: 'info', text: t('settings.attn.none'), action: { label: t('settings.attn.add'), href: '/settings' } });
      for (const c of items.filter((x) => x.enabled && x.last_delivery_status === 'failed'))
        out.push({ id: `channel-failed-${c.id}`, tone: 'warn', text: fill(t('settings.attn.failed'), { name: c.name }), action: { label: t('settings.attn.fix'), href: '/settings' } });
      return out;
    }),
  );

  return (
    <Widget title={t('settings.notifications')} icon={Bell} href="/settings">
      <Async query={query}>
        {({ items }) => {
          if (items.length === 0) return <NextStep text={t('settings.attn.none')} label={t('settings.attn.add')} href="/settings" />;
          const enabled = items.filter((c) => c.enabled).length;
          const failed = items.filter((c) => c.enabled && c.last_delivery_status === 'failed').length;
          return (
            <div className="grid grid-cols-2 gap-2">
              <Metric label={t('settings.widget.active')} value={`${enabled} / ${items.length}`} tone={enabled ? 'ok' : 'warn'} />
              <Metric label={t('settings.widget.failing')} value={failed} tone={failed ? 'crit' : 'idle'} />
            </div>
          );
        }}
      </Async>
    </Widget>
  );
}
