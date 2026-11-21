'use client';

import { History } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Async, Badge, Button, Card, DataTable, EmptyState, PageHeader, Segmented } from '@/components/ui';
import { qs } from '@/lib/api';
import { useQuery } from '@/lib/app';
import { relativeTime } from '@/lib/format';
import { fill, useI18n } from '@/lib/i18n';
import { RunStatusBadge, usePbText } from '../components/common';
import type { Run } from '../types';

type Filter = 'all' | 'active' | 'finished';
interface RunsPage {
  items: Run[];
  total: number;
  page: number;
  page_size: number;
}

/** A page of playbook runs, newest first. Optional `playbookId` limits it to one playbook. */
export function RunsTable({ playbookId, pageSize = 25, paged = true, showPlaybook = true }: { playbookId?: string; pageSize?: number; paged?: boolean; showPlaybook?: boolean }) {
  const tx = usePbText();
  const { locale } = useI18n();
  const [filter, setFilter] = useState<Filter>('all');
  const [page, setPage] = useState(1);
  const query = useQuery<RunsPage>(`/playbook-runs${qs({ playbook_id: playbookId, status: filter, page, page_size: pageSize })}`, ['events'], 15_000);
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
        <Segmented
          label={tx.status}
          value={filter}
          onChange={(v) => {
            setFilter(v);
            setPage(1);
          }}
          options={(['all', 'active', 'finished'] as const).map((v) => ({ value: v, label: tx.filter[v] }))}
        />
      </div>
      <Async query={query}>
        {(data) => {
          const pages = Math.max(1, Math.ceil(data.total / data.page_size));
          if (!data.items.length)
            return filter === 'all' ? (
              <EmptyState icon={<History />} title={tx.noRuns} />
            ) : (
              <p className="px-4 py-6 text-center text-[13px] text-muted">{tx.noRuns}</p>
            );
          return (
            <>
              <DataTable stack minWidth={720}>
                <thead>
                  <tr>
                    {showPlaybook && <th>{tx.playbook}</th>}
                    <th>{tx.status}</th>
                    <th>{tx.trigger}</th>
                    <th>{tx.progress}</th>
                    <th>{tx.started}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((r) => (
                    <tr key={r.id}>
                      {showPlaybook && (
                        <td data-label={tx.playbook}>
                          <span dir="auto" className="font-medium">
                            {r.playbook_name}
                          </span>{' '}
                          <span className="text-xs text-faint">{fill(tx.version, { v: r.playbook_version })}</span>
                        </td>
                      )}
                      <td data-label={tx.status}>
                        <span className="inline-flex flex-wrap items-center gap-1.5">
                          <RunStatusBadge status={r.status} />
                          {r.dry_run && <Badge tone="info">{tx.dryRun}</Badge>}
                        </span>
                      </td>
                      <td data-label={tx.trigger} className="text-xs text-muted">
                        {fill(tx.triggeredBy[r.trigger_kind], { who: r.started_by_email ?? '—' })}
                      </td>
                      <td data-label={tx.progress} className="tnum text-xs">
                        {r.steps_done ?? 0} / {r.steps_total ?? 0}
                      </td>
                      <td data-label={tx.started} className="text-xs text-muted">
                        {relativeTime(r.created_at, locale)}
                      </td>
                      <td>
                        <Link href={`/playbooks/runs/${r.id}`} className="text-[13px] text-accent-hover hover:underline">
                          {tx.open}
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </DataTable>
              {paged && pages > 1 && (
                <div className="flex items-center justify-between gap-2 border-t border-line px-4 py-2.5 text-xs text-muted">
                  <span>{fill(tx.page, { page: data.page, pages })}</span>
                  <span className="flex gap-2">
                    <Button size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                      {tx.prev}
                    </Button>
                    <Button size="sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>
                      {tx.next}
                    </Button>
                  </span>
                </div>
              )}
            </>
          );
        }}
      </Async>
    </div>
  );
}

export function RunsScreen() {
  const tx = usePbText();
  return (
    <div className="space-y-5">
      <PageHeader
        title={tx.runsTitle}
        description={tx.runsSubtitle}
        actions={
          <Link href="/playbooks" className="text-[13px] text-accent-hover hover:underline">
            {tx.back}
          </Link>
        }
      />
      <Card padded={false}>
        <RunsTable />
      </Card>
    </div>
  );
}
