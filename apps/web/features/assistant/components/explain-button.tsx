'use client';

import { Sparkles } from 'lucide-react';
import { useState } from 'react';
import { Button, ErrorNote, SkeletonBlock } from '@/components/ui';
import { type ApiError, api } from '@/lib/api';
import { useQuery } from '@/lib/app';
import { useI18n } from '@/lib/i18n';
import type { AssistantAnswer, AssistantStatus } from '../types';
import { AnswerView } from './answer-view';

type Subject = { subject: 'incident'; incidentId: string } | { subject: 'doctor'; siteId: string };

/** Whether the organization's assistant is on (any member may ask). Shared by every assistant button. */
export function useAssistantStatus() {
  return useQuery<AssistantStatus>('/assistant/status', [], 120_000);
}

/**
 * "Explain with AI" under a Network Doctor diagnosis. Renders nothing while the assistant is off,
 * so no member ever sees a button that cannot work. The answer is always labelled AI-generated.
 */
export function ExplainWithAi(props: Subject) {
  const { t, locale } = useI18n();
  const status = useAssistantStatus();
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<AssistantAnswer | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [open, setOpen] = useState(false);

  if (!status.data?.available) return null;

  async function run() {
    setOpen(true);
    setBusy(true);
    setError(null);
    try {
      const body = props.subject === 'incident' ? { subject: 'incident', incident_id: props.incidentId, locale } : { subject: 'doctor', site_id: props.siteId, locale };
      setAnswer(await api<AssistantAnswer>('/assistant/explain', { method: 'POST', body }));
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 space-y-2 border-t border-line pt-3">
      <div className="flex flex-wrap items-center gap-2">
        {open ? (
          <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
            {t('ai.hide')}
          </Button>
        ) : (
          <Button size="sm" busy={busy} onClick={() => (answer ? setOpen(true) : void run())}>
            <Sparkles className="size-3.5" aria-hidden />
            {t('ai.explain')}
          </Button>
        )}
        {open && (answer || error) && !busy && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setAnswer(null);
              void run();
            }}
          >
            {t('common.retry')}
          </Button>
        )}
      </div>
      {open && (
        <section aria-label={t('ai.explainTitle')} className="rounded-[var(--radius-control)] border border-accent/25 bg-accent/[0.04] px-3 py-2.5">
          <p className="mb-2 text-[11.5px] leading-relaxed text-muted">{t('ai.explainHint')}</p>
          {error && <ErrorNote error={error} />}
          {busy && !answer && <SkeletonBlock lines={3} />}
          {answer && <AnswerView text={answer.text} citations={answer.citations} sources={answer.sources} lookups={answer.lookups} model={answer.model} usage={answer.usage} refused={answer.refused} truncated={answer.truncated} />}
        </section>
      )}
    </div>
  );
}
