'use client';

import { BookOpen } from 'lucide-react';
import { Async } from '@/components/ui';
import { ButtonLink, Metric, Widget } from '@/components/widget';
import { useApp, useQuery } from '@/lib/app';
import { useI18n } from '@/lib/i18n';

type Counts = { candidate: number; draft: number; published: number; discarded: number };

/** Dashboard: how much the team has learned, and candidates waiting for a person (GET /knowledge/counts). */
export default function KnowledgeWidget() {
  const { t } = useI18n();
  const { can } = useApp();
  const query = useQuery<Counts>('/knowledge/counts', ['events'], 120_000);
  return (
    <Widget title={t('nav.knowledge')} icon={BookOpen} href="/mind/knowledge">
      <Async query={query}>
        {(c) => (
          <div className="space-y-3">
            <div className="grid grid-cols-3 gap-2">
              <Metric label={t('kb.widget.published')} value={c.published} href="/mind/knowledge" />
              {can('technician') && <Metric label={t('kb.widget.candidates')} value={c.candidate} tone={c.candidate ? 'warn' : 'idle'} href="/mind/knowledge" />}
              {can('technician') && <Metric label={t('kb.widget.drafts')} value={c.draft} href="/mind/knowledge" />}
            </div>
            {can('technician') && c.candidate > 0 && <ButtonLink href="/mind/knowledge">{t('kb.widget.review')}</ButtonLink>}
            {c.published === 0 && c.candidate === 0 && <p className="text-xs leading-relaxed text-muted">{t('kb.emptyHint')}</p>}
          </div>
        )}
      </Async>
    </Widget>
  );
}
