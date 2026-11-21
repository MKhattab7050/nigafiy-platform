'use client';

import { AlertTriangle, RotateCcw } from 'lucide-react';
import { type ErrorInfo, catchError } from 'next/error';
import { useEffect } from 'react';
import { useReportAttention } from '@/lib/attention';
import { useI18n } from '@/lib/i18n';
import { Button } from './ui';

/**
 * What a crashed feature shows instead of itself: a short, translated note with a retry.
 * Everything outside the boundary (sidebar, top bar, other widgets) keeps working.
 */
export function FeatureError({ error, retry, compact }: { error: unknown; retry?: () => void; compact?: boolean }) {
  const { t } = useI18n();
  useEffect(() => {
    console.error(error);
  }, [error]);
  const detail = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return (
    <div role="alert" className={`rounded-lg border border-crit/30 bg-crit/5 ${compact ? 'px-4 py-3' : 'px-5 py-6'}`}>
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-crit" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold text-fg">{t(compact ? 'error.widget' : 'error.title')}</p>
          <p className="mt-0.5 text-[13px] leading-relaxed text-muted">{t('error.body')}</p>
          {detail && (
            <p className="mono mt-2 break-words text-start text-[11px] text-faint" dir="ltr">
              {detail}
            </p>
          )}
        </div>
        <Button size="sm" onClick={retry}>
          <RotateCcw className="size-3.5" aria-hidden />
          {t('common.retry')}
        </Button>
      </div>
    </div>
  );
}

/** Tells "Needs your attention" that this widget crashed, so it is not counted as "nothing to report". */
function ReportCrash({ source }: { source: string }) {
  useReportAttention(source, { state: 'error' });
  return null;
}

function Fallback(props: { compact?: boolean; attentionSource?: string }, { error, retry }: ErrorInfo) {
  return (
    <>
      {props.attentionSource && <ReportCrash source={props.attentionSource} />}
      <FeatureError error={error} retry={retry} compact={props.compact ?? true} />
    </>
  );
}

/**
 * Wrap any independent part of the UI (a dashboard widget, a card owned by another feature) in this.
 * `attentionSource`: the dashboard widget's attention source, reported as failed when it crashes.
 */
export const FeatureBoundary = catchError(Fallback);
