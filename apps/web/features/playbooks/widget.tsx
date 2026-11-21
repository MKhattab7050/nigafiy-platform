'use client';

import { GitBranch } from 'lucide-react';
import Link from 'next/link';
import { Async, Badge } from '@/components/ui';
import { Metric, Widget, attentionFrom } from '@/components/widget';
import { useQuery } from '@/lib/app';
import { useReportAttention } from '@/lib/attention';
import { fill, useI18n } from '@/lib/i18n';
import { usePbText } from './components/common';
import { actionLabel } from './text';
import type { Approval, Run } from './types';

/** Dashboard: steps waiting for an administrator (also in "Needs your attention") and runs in progress. */
export default function PlaybooksWidget() {
  const tx = usePbText();
  const { t, locale } = useI18n();
  const approvals = useQuery<{ items: Approval[] }>('/playbook-approvals?page_size=100', ['events'], 30_000);
  const active = useQuery<{ items: Run[]; total: number }>('/playbook-runs?status=active&page_size=1', ['events'], 30_000);

  useReportAttention(
    'playbooks',
    attentionFrom([approvals], ({ items }) =>
      items.slice(0, 5).map((a) => ({
        id: `playbook-approval-${a.step.id}`,
        tone: 'warn' as const,
        text: fill(tx.attnApproval, { playbook: a.run.playbook_name, action: actionLabel(a.step.action, locale) }),
        action: { label: tx.attnOpen, href: `/mind/playbooks/runs/${a.run.id}` },
      })),
    ),
  );

  return (
    <Widget title={t('nav.playbooks')} icon={GitBranch} href="/mind/playbooks">
      <Async query={approvals}>
        {({ items }) => (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <Metric label={tx.widgetWaiting} value={items.length} tone={items.length ? 'warn' : 'idle'} href="/mind/playbooks" />
              <Metric label={tx.widgetActive} value={active.data?.total ?? '—'} href="/mind/playbooks/runs" />
            </div>
            {items.length === 0 ? (
              <p className="text-xs leading-relaxed text-muted">{tx.widgetNone}</p>
            ) : (
              <ul className="divide-y divide-line rounded-[8px] border border-line">
                {items.slice(0, 4).map((a) => (
                  <li key={a.step.id}>
                    <Link href={`/mind/playbooks/runs/${a.run.id}`} className="flex items-center justify-between gap-3 px-3 py-2 hover:bg-raised/60">
                      <span className="min-w-0 truncate text-[13px]" dir="auto">
                        {a.run.playbook_name}
                      </span>
                      <Badge tone="warn">{actionLabel(a.step.action, locale)}</Badge>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </Async>
    </Widget>
  );
}
