'use client';

import { BookOpen, Check } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import type { KnowledgeSuggestResponse } from '@nigafiy/shared-types';
import { markdownToText } from '@nigafiy/shared-types/markdown';
import { Async, Badge, Button, Card, ErrorNote, SkeletonBlock } from '@/components/ui';
import { type ApiError, api, qs } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { type Key, fill, useI18n } from '@/lib/i18n';
import { EntryStats } from './entry-meta';

/**
 * "Fixes that worked before": published knowledge ranked against an incident, a device or a live
 * Network Doctor rule. Each suggestion shows why it matched; on an incident a technician can mark
 * the one that fixed it, which links the two (and notes it on the incident's activity).
 */
export function KnowledgeSuggestions({ incidentId, deviceId, rule, siteId }: { incidentId?: string; deviceId?: string; rule?: string; siteId?: string | null }) {
  const { t } = useI18n();
  const { can } = useApp();
  const path = incidentId || deviceId || rule ? `/knowledge/suggest${qs({ incident_id: incidentId, device_id: incidentId ? undefined : deviceId, rule: incidentId || deviceId ? undefined : rule, site_id: rule ? siteId : undefined, limit: 5 })}` : null;
  const query = useQuery<KnowledgeSuggestResponse>(path, ['events'], 120_000);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const [marked, setMarked] = useState<Set<string>>(new Set());

  async function markUsed(entryId: string) {
    if (!incidentId) return;
    setBusy(entryId);
    setError(null);
    try {
      await api(`/knowledge/${entryId}/uses`, { method: 'POST', body: { incident_id: incidentId } });
      setMarked((s) => new Set(s).add(entryId));
      query.reload();
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy('');
    }
  }

  return (
    <Card title={t('kb.suggest.title')} description={t('kb.suggest.hint')} padded={false} action={<BookOpen className="size-4 text-faint" aria-hidden />}>
      <Async query={query} skeleton={<SkeletonBlock className="px-4 py-3" lines={3} />}>
        {(data) =>
          data.items.length === 0 ? (
            <p className="px-4 py-3 text-[13px] text-muted">{t('kb.suggest.none')}</p>
          ) : (
            <>
              {error && (
                <div className="px-4 pt-3">
                  <ErrorNote error={error} />
                </div>
              )}
              <ul className="divide-y divide-line">
                {data.items.map(({ entry, score, reasons }) => (
                  <li key={entry.id} className="space-y-1.5 px-4 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link href={`/mind/knowledge/${entry.id}`} className="min-w-0 text-[13px] font-medium text-accent-hover hover:underline" dir="auto">
                        {entry.title}
                      </Link>
                      <Badge tone="info" dot={false}>
                        {fill(t('kb.suggest.score'), { score: Math.round(score) })}
                      </Badge>
                    </div>
                    {entry.fix_steps && (
                      <p className="line-clamp-2 text-xs leading-relaxed text-muted" dir="auto">
                        {markdownToText(entry.fix_steps)}
                      </p>
                    )}
                    <p className="text-[11.5px] text-faint">
                      {t('kb.suggest.matchedOn')}:{' '}
                      {reasons
                        .filter((r) => r.points > 0)
                        .map((r) => `${t(`kb.reason.${r.code}` as Key)}${r.detail ? ` (${r.detail})` : ''} +${Math.round(r.points)}`)
                        .join(' · ')}
                    </p>
                    <div className="flex flex-wrap items-center gap-3">
                      <EntryStats entry={entry} />
                      {incidentId &&
                        can('technician') &&
                        (marked.has(entry.id) ? (
                          <span className="inline-flex items-center gap-1 text-xs text-ok">
                            <Check className="size-3.5" aria-hidden />
                            {t('kb.suggest.usedDone')}
                          </span>
                        ) : (
                          <Button size="sm" busy={busy === entry.id} onClick={() => void markUsed(entry.id)}>
                            {t('kb.suggest.used')}
                          </Button>
                        ))}
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )
        }
      </Async>
    </Card>
  );
}
