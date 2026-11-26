'use client';

import { ListChecks } from 'lucide-react';
import type { InsightsReport } from '@nigafiy/shared-types';
import { ToneIcon, severityTone } from '@/components/ui';
import type { Query } from '@/lib/app';
import { fill, useI18n } from '@/lib/i18n';
import { actionText, insightText } from '../insights-text';
import { type NextStep, nextSteps, stepText } from '../guidance-text';
import { Action } from './insights-panel';

function StepRow({ step, onDone }: { step: NextStep; onDone: () => void }) {
  const { t, tn, locale } = useI18n();
  const { insight, action } = step;
  const words = stepText(insight.code);
  const sentence = words ? fill(words.plural ? tn(words.text, Number(insight.params.count ?? 1)) : t(words.text), { count: 1, ...insight.params }) : insightText(insight, locale).title;
  const label = words ? t(words.button) : actionText(action, locale).label;
  return (
    <li className="flex flex-col gap-2.5 px-4 py-3 sm:flex-row sm:items-center sm:gap-4 sm:px-5">
      <p className="flex min-w-0 flex-1 items-start gap-2.5 text-[13.5px] leading-snug text-fg" dir="auto">
        <ToneIcon tone={severityTone(insight.severity)} className="mt-0.5 size-4 shrink-0" />
        <span className="sr-only">{t(`severity.${insight.severity}`)}: </span>
        <span>{sentence}</span>
      </p>
      <div className="shrink-0 ps-[26px] sm:ps-0">
        <Action action={action} label={label} primary onDone={onDone} />
      </div>
    </li>
  );
}

/**
 * "Next": the one to three things worth doing now, each with the button that does it or opens the
 * exact place to do it. Built from the insights the API already computes; nothing to act on, nothing shown.
 */
export function NextSteps({ insights, skip }: { insights: Query<InsightsReport>; skip?: ReadonlySet<string> }) {
  const { t, tn } = useI18n();
  const { steps, more } = nextSteps(insights.data, skip);
  if (steps.length === 0) return null;
  return (
    <section aria-labelledby="next-title" className="rounded-[var(--radius-card)] border border-line bg-surface shadow-[var(--shadow-card)]">
      <header className="flex min-h-11 items-center gap-2.5 border-b border-line px-4 py-2 sm:px-5">
        <ListChecks className="size-4 text-accent-hover" aria-hidden />
        <h2 id="next-title" className="text-[13.5px] font-semibold text-fg">
          {t('dash.next.title')}
        </h2>
      </header>
      <ol className="divide-y divide-line">
        {steps.map((s) => (
          <StepRow key={s.insight.id} step={s} onDone={insights.reload} />
        ))}
      </ol>
      {more > 0 && (
        <p className="border-t border-line px-4 py-2 text-xs sm:px-5">
          <a href="#insights-title" className="font-medium text-accent-hover hover:underline">
            {fill(tn('dash.next.more', more), { count: more })}
          </a>
        </p>
      )}
    </section>
  );
}
