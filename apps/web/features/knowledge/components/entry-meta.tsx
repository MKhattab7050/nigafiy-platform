'use client';

import { ThumbsDown, ThumbsUp, Wrench } from 'lucide-react';
import type { KnowledgeEntry, KnowledgeStatus } from '@nigafiy/shared-types';
import { Badge, type Tone } from '@/components/ui';
import { type Key, fill, useI18n } from '@/lib/i18n';

const STATUS_TONE: Record<KnowledgeStatus, Tone> = { candidate: 'warn', draft: 'idle', published: 'ok', discarded: 'idle' };

export function KnowledgeStatusBadge({ status }: { status: KnowledgeStatus }) {
  const { t } = useI18n();
  return <Badge tone={STATUS_TONE[status]}>{t(`kb.statusOne.${status}` as Key)}</Badge>;
}

/** Where the entry came from: a resolved incident (pre-filled by Nigafiy) or a person. */
export function SourceLabel({ entry }: { entry: KnowledgeEntry }) {
  const { t } = useI18n();
  return <span>{entry.source === 'incident' && entry.incident_number !== null ? fill(t('kb.source.incident'), { n: entry.incident_number }) : t('kb.source.manual')}</span>;
}

/** Feedback counts: how often it helped, did not help, and was used as the fix. */
export function EntryStats({ entry }: { entry: KnowledgeEntry }) {
  const { t } = useI18n();
  return (
    <span className="inline-flex flex-wrap items-center gap-3 text-[11.5px] text-muted">
      <span className="inline-flex items-center gap-1" title={t('kb.helpful')}>
        <ThumbsUp className="size-3" aria-hidden />
        <span className="tnum">{entry.helpful}</span>
        <span className="sr-only">{t('kb.helpful')}</span>
      </span>
      <span className="inline-flex items-center gap-1" title={t('kb.notHelpful')}>
        <ThumbsDown className="size-3" aria-hidden />
        <span className="tnum">{entry.not_helpful}</span>
        <span className="sr-only">{t('kb.notHelpful')}</span>
      </span>
      <span className="inline-flex items-center gap-1" title={t('kb.uses')}>
        <Wrench className="size-3" aria-hidden />
        <span className="tnum">{entry.uses}</span>
        <span className="sr-only">{t('kb.uses')}</span>
      </span>
    </span>
  );
}
