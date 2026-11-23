'use client';

import { useState } from 'react';
import type { AuditEntry } from '@nigafiy/shared-types';
import { Async, Card, EmptyState, Segmented } from '@/components/ui';
import { useQuery } from '@/lib/app';
import { absoluteTime, relativeTime } from '@/lib/format';
import { fill, useI18n } from '@/lib/i18n';
import { localizeAuditAction } from '@/lib/localize';
import { automationName } from '../automation-text';

const LIMIT = 100;
type ActorFilter = 'all' | 'user' | 'system';

export function AuditLog() {
  const { t, locale } = useI18n();
  // GET /audit-logs has no actor filter, so filtering happens on the loaded entries only (said below the filter).
  const query = useQuery<{ items: AuditEntry[] }>(`/audit-logs?limit=${LIMIT}`, [], 60_000);
  const [filter, setFilter] = useState<ActorFilter>('all');

  const actorText = (a: AuditEntry) => {
    if (a.actor === 'user') return a.user_email ?? '—';
    const automation = typeof a.metadata.automation === 'string' ? a.metadata.automation : null;
    const who = t(a.actor === 'collector' ? 'settings.audit.collector' : 'settings.audit.system');
    return automation ? `${who} · ${automationName(t, automation)}` : who;
  };

  return (
    <Card
      title={t('settings.audit')}
      padded={false}
      action={
        <Segmented
          label={t('settings.audit.filter')}
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: t('settings.audit.filterAll') },
            { value: 'user', label: t('settings.audit.filterUser') },
            { value: 'system', label: t('settings.audit.filterSystem') },
          ]}
        />
      }
    >
      <Async query={query}>
        {({ items }) => {
          const shown = filter === 'all' ? items : items.filter((a) => (filter === 'user' ? a.actor === 'user' : a.actor !== 'user'));
          return items.length === 0 ? (
            <EmptyState title={t('settings.auditEmpty')} />
          ) : (
            <>
              {filter !== 'all' && <p className="border-b border-line px-4 py-2 text-xs text-faint">{fill(t('settings.audit.filterNote'), { count: items.length })}</p>}
              {shown.length === 0 ? (
                <EmptyState title={t('settings.audit.noneForFilter')} />
              ) : (
                <div className="max-h-[28rem] overflow-auto">
                  <table className="w-full min-w-[560px] text-[13px]">
                    <tbody className="divide-y divide-line">
                      {shown.map((a) => (
                        <tr key={a.id}>
                          <td className="whitespace-nowrap px-4 py-2 text-xs text-muted" title={absoluteTime(a.created_at, locale)}>
                            {relativeTime(a.created_at, locale)}
                          </td>
                          <td className={locale === 'ar' ? 'px-3 py-2 text-start text-xs' : 'mono px-3 py-2 text-start text-xs'} title={a.action}>
                            {localizeAuditAction(a.action, locale)}
                          </td>
                          <td className={a.actor === 'user' ? 'mono px-3 py-2 text-start text-xs text-muted' : 'px-3 py-2 text-start text-xs text-accent-hover'} dir="auto">
                            {actorText(a)}
                          </td>
                          <td className="mono max-w-[18rem] truncate px-4 py-2 text-start text-xs text-faint" title={JSON.stringify(a.metadata)}>
                            {Object.keys(a.metadata).length ? JSON.stringify(a.metadata) : ''}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          );
        }}
      </Async>
    </Card>
  );
}
