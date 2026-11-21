'use client';

import { Sparkles } from 'lucide-react';
import { Async, Card, EmptyState, PageHeader } from '@/components/ui';
import { Metric } from '@/components/widget';
import { useApp } from '@/lib/app';
import { useI18n } from '@/lib/i18n';
import { AssistantSettings } from '../components/assistant-settings';
import { ChatPanel } from '../components/chat-panel';
import { useAssistantStatus } from '../components/explain-button';

export function AssistantScreen() {
  const { t } = useI18n();
  const { can } = useApp();
  const status = useAssistantStatus();

  return (
    <>
      <PageHeader icon={<Sparkles className="size-[18px]" aria-hidden />} title={t('ai.title')} description={t('ai.intro')} />
      <div className="space-y-4">
        <Async query={status}>
          {(s) =>
            s.available ? (
              <>
                <div className="grid grid-cols-3 gap-2 rounded-[var(--radius-card)] border border-line bg-surface px-2 py-2">
                  <Metric label={t('ai.usage.budget')} value={`${s.budget.used}/${s.budget.limit}`} tone={s.budget.used >= s.budget.limit ? 'crit' : 'idle'} />
                  <Metric label={t('ai.usage.rate')} value={`${s.rate.used}/${s.rate.limit}`} tone={s.rate.used >= s.rate.limit ? 'warn' : 'idle'} />
                  <Metric label={t('ai.usage.tokens')} value={(s.tokens_24h.input + s.tokens_24h.output).toLocaleString()} />
                </div>
                <ChatPanel status={s} onAsked={status.reload} />
              </>
            ) : (
              <Card>
                <EmptyState icon={<Sparkles />} title={t('ai.off')}>
                  <p>{t('ai.offHint')}</p>
                  {can('admin') && <p>{t('ai.offAdmin')}</p>}
                </EmptyState>
              </Card>
            )
          }
        </Async>
        {can('admin') && <AssistantSettings onChanged={status.reload} />}
      </div>
    </>
  );
}
