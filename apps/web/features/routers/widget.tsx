'use client';

import { Router } from 'lucide-react';
import { Async } from '@/components/ui';
import { Metric, NextStep, Widget, attentionFrom } from '@/components/widget';
import { qs } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { type AttentionItem, useReportAttention } from '@/lib/attention';
import { fill, useI18n } from '@/lib/i18n';
import type { SiteRouter } from './types';

export default function RoutersWidget() {
  const { t } = useI18n();
  const { siteId } = useApp();
  const query = useQuery<{ items: SiteRouter[] }>(`/routers${qs({ site_id: siteId })}`, ['devices', 'collectors'], 30_000);

  useReportAttention(
    'routers',
    attentionFrom([query], (data) =>
      data.items.flatMap((r): AttentionItem[] => {
        if (!r.enabled) return [];
        const action = { label: t('routers.attn.open'), href: `/routers/${r.id}` };
        if (r.delivery === 'awaiting_certificate') {
          return [{ id: `router-cert-${r.id}`, tone: 'warn' as const, text: fill(t('routers.attn.awaitingCertificate'), { name: r.name }), action }];
        }
        if (r.delivery === 'out_of_scope') {
          return [{ id: `router-scope-${r.id}`, tone: 'warn' as const, text: fill(t('routers.attn.outOfScope'), { name: r.name }), action }];
        }
        if (r.login_paused_reason === 'bad_credentials' || r.status === 'login_failed') {
          return [{ id: `router-login-${r.id}`, tone: 'crit' as const, text: fill(t('routers.attn.loginFailed'), { name: r.name }), action }];
        }
        if (r.login_paused_reason === 'locked_out' || r.status === 'locked_out') {
          return [{ id: `router-lock-${r.id}`, tone: 'warn' as const, text: fill(t('routers.attn.lockedOut'), { name: r.name }), action }];
        }
        if (r.status === 'unreachable') {
          return [{ id: `router-unreach-${r.id}`, tone: 'crit' as const, text: fill(t('routers.attn.unreachable'), { name: r.name }), action }];
        }
        return [];
      }),
    ),
  );

  return (
    <Widget title={t('nav.routers')} icon={Router} href="/routers">
      <Async query={query}>
        {(data) => {
          if (data.items.length === 0) {
            return <NextStep text={t('routers.widget.empty')} label={t('routers.add')} href="/routers" />;
          }
          const reachable = data.items.filter((r) => r.status === 'ok').length;
          const clients = data.items.reduce((sum, r) => sum + r.client_count, 0);
          return (
            <div className="grid grid-cols-2 gap-2">
              <Metric
                label={t('routers.widget.reachable')}
                value={`${reachable}/${data.items.length}`}
                tone={reachable === data.items.length ? 'ok' : reachable > 0 ? 'warn' : 'crit'}
              />
              <Metric label={t('routers.widget.clients')} value={clients} />
            </div>
          );
        }}
      </Async>
    </Widget>
  );
}
