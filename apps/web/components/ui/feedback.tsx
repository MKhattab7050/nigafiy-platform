'use client';

import clsx from 'clsx';
import { AlertTriangle, Loader2 } from 'lucide-react';
import type { ApiError } from '@/lib/api';
import { type Locale, useI18n } from '@/lib/i18n';
import { ERROR_UI, errorMessage, errorTechnicalDetails } from '@/lib/i18n/error-messages';
import { Button } from './controls';

/** A placeholder block with the shape of the content that is coming. */
export function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden className={clsx('block animate-shimmer rounded-[5px] bg-raised', className ?? 'h-4 w-full')} />;
}

/** Loading state for a list, card or chart: grey lines in the shape of what will appear. */
export function SkeletonBlock({ lines = 3, chart, className }: { lines?: number; chart?: boolean; className?: string }) {
  const { t } = useI18n();
  const widths = ['w-11/12', 'w-8/12', 'w-10/12', 'w-7/12', 'w-9/12'];
  return (
    <div role="status" className={clsx('space-y-2.5 py-1', className)}>
      <span className="sr-only">{t('common.loading')}</span>
      {chart && <Skeleton className="mb-3 h-28 w-full" />}
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className={clsx('h-3.5', widths[i % widths.length])} />
      ))}
    </div>
  );
}

/** Kept for places that wait on something with no shape (a whole page booting). Prefer SkeletonBlock. */
export function Spinner({ label }: { label?: string }) {
  const { t } = useI18n();
  return (
    <div role="status" className="flex items-center justify-center gap-2 py-10 text-[13px] text-muted">
      <Loader2 className="size-4 animate-spin" aria-hidden />
      {label ?? t('common.loading')}
    </div>
  );
}

/**
 * Honest empty state: what is missing, one sentence on why, and the action that fixes it.
 * `children` is rendered in a <div> so callers may pass paragraphs, lists or links.
 */
export function EmptyState({ icon, title, children, action, illustration }: { icon?: React.ReactNode; title: string; children?: React.ReactNode; action?: React.ReactNode; illustration?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-10 text-center">
      {illustration ? <div className="mb-4 text-faint">{illustration}</div> : icon && <div className="mb-3 flex size-12 items-center justify-center rounded-full border border-line bg-sunken text-faint [&_svg]:size-6">{icon}</div>}
      <p className="text-[14px] font-medium text-fg" dir="auto">
        {title}
      </p>
      {children && <div className="mt-1.5 max-w-md text-[13px] leading-relaxed text-muted [&_p+p]:mt-2">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/**
 * The sentence to show for an error in the user's language. An API error is worded from its `code`
 * (lib/i18n/error-messages.ts), never from the server's technical English; a message a screen
 * already translated (`localized`) or a plain Error the screen wrote itself is shown as it is.
 */
export function errorSentence(error: ApiError | Error, locale: Locale, fallback: string): string {
  if (!isApiError(error) || error.localized) return error.message || fallback;
  return errorMessage(error, locale);
}

const isApiError = (e: ApiError | Error): e is ApiError => typeof (e as ApiError).code === 'string' && 'status' in e;

export function ErrorNote({ error, onRetry }: { error: ApiError | Error | null; onRetry?: () => void }) {
  const { t, locale } = useI18n();
  if (!error) return null;
  const sentence = errorSentence(error, locale, t('common.error'));
  // The original wording, code, field paths and request id stay available for support, behind a toggle.
  const technical = isApiError(error) ? errorTechnicalDetails(error, locale).filter(([, v]) => v !== sentence) : [];
  return (
    <div role="alert" className="flex items-start gap-2.5 rounded-[var(--radius-control)] border border-crit/30 bg-crit/[0.07] px-3 py-2.5 text-[13px] text-fg">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-crit" aria-hidden />
      <div className="min-w-0 flex-1">
        <p dir="auto">{sentence}</p>
        {technical.length > 0 && (
          <details className="mt-1 text-xs text-muted">
            <summary className="w-fit cursor-pointer select-none rounded-sm text-faint hover:text-muted focus-visible:outline-2 focus-visible:outline-accent">{ERROR_UI.details[locale]}</summary>
            <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
              {technical.map(([label, value]) => (
                <div key={`${label}:${value}`} className="contents">
                  <dt className="text-faint">{label}</dt>
                  <dd dir="ltr" className="mono min-w-0 break-words text-start">
                    {value}
                  </dd>
                </div>
              ))}
            </dl>
          </details>
        )}
      </div>
      {onRetry && (
        <Button size="sm" variant="ghost" onClick={onRetry}>
          {t('common.retry')}
        </Button>
      )}
    </div>
  );
}

/** A short confirmation that something was queued or saved (announced to screen readers). */
export function Notice({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <p role="status" className={clsx('rounded-[var(--radius-control)] border border-accent/30 bg-accent/[0.08] px-3 py-2 text-[13px] text-fg', className)}>
      {children}
    </p>
  );
}

/** Loading / error / content wrapper so every data view handles all three states the same way. */
export function Async<T>({
  query,
  children,
  skeleton,
}: {
  query: { data: T | undefined; error: ApiError | null; loading: boolean; reload: () => void };
  children: (data: T) => React.ReactNode;
  /** Shape of the placeholder while loading. */
  skeleton?: React.ReactNode;
}) {
  if (query.data === undefined) {
    if (query.error) return <ErrorNote error={query.error} onRetry={query.reload} />;
    return <>{skeleton ?? <SkeletonBlock />}</>;
  }
  return (
    <>
      {query.error && (
        <div className="mb-3">
          <ErrorNote error={query.error} onRetry={query.reload} />
        </div>
      )}
      {children(query.data)}
    </>
  );
}
