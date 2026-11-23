'use client';

import clsx from 'clsx';
import { ArrowRight } from 'lucide-react';
import { programForPath } from '@nigafiy/shared-types/routes';
import Link from 'next/link';
import { ProgramGlyph } from '@/features/platform';
import type { ApiError } from '@/lib/api';
import type { AttentionItem, AttentionReport } from '@/lib/attention';
import { fill, useI18n } from '@/lib/i18n';
import { programById } from '@/lib/programs';
import { BUTTON_BASE, BUTTON_VARIANT, type Tone } from './ui';

// Building blocks shared by every dashboard widget, so all of them look and behave the same:
// title row → one key figure or chart → one to three supporting facts → one link.

/** A link that looks like a button: every "next step" on the dashboard is one of these. */
export function ButtonLink({ href, children, variant = 'secondary', className }: { href: string; children: React.ReactNode; variant?: 'primary' | 'secondary'; className?: string }) {
  return (
    <Link href={href} className={clsx(BUTTON_BASE, BUTTON_VARIANT[variant], 'h-8 gap-1.5 px-3 text-xs', className)}>
      {children}
    </Link>
  );
}

/**
 * Dashboard card: title with icon, the program that owns it (glyph and name, from the page it opens),
 * a link to the feature's full page, and its own content.
 */
export function Widget({
  title,
  icon: Icon,
  href,
  action,
  children,
  padded = true,
}: {
  title: string;
  icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  href: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  padded?: boolean;
}) {
  const { t, locale } = useI18n();
  const owner = programById(programForPath(href));
  return (
    <section data-program={owner.id} className="flex h-full min-w-0 flex-col rounded-[var(--radius-card)] border border-line bg-surface shadow-[var(--shadow-card)]">
      <header className="flex min-h-12 items-center gap-2.5 px-4 pt-3">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-[7px] bg-raised text-muted">
          <Icon className="size-[15px]" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[13.5px] font-semibold text-fg">{title}</h2>
          {owner.id !== 'hub' && (
            <p className="flex items-center gap-1 text-[11px] leading-tight text-faint" title={fill(t('platform.from'), { name: owner.name[locale] })}>
              <ProgramGlyph id={owner.id} size={12} />
              <bdi>{owner.shortName}</bdi>
            </p>
          )}
        </div>
        {action}
        <Link href={href} className="group inline-flex shrink-0 items-center gap-1 rounded-[5px] px-1.5 py-1 text-xs font-medium text-accent-hover hover:bg-accent/10">
          {t('common.open')}
          <ArrowRight className="size-3.5 transition-transform duration-[120ms] group-hover:translate-x-0.5 rtl:-scale-x-100 rtl:group-hover:-translate-x-0.5" aria-hidden />
          <span className="sr-only">{title}</span>
        </Link>
      </header>
      <div className={clsx('min-w-0 flex-1', padded ? 'p-4 pt-3' : 'pt-2')}>{children}</div>
    </section>
  );
}

/** Honest empty / setup state: one sentence and one button to the step that fixes it. */
export function NextStep({ text, label, href, art }: { text: string; label?: string; href?: string; art?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-3 py-1">
      {art && <div className="text-faint">{art}</div>}
      <p className="text-[13px] leading-relaxed text-muted">{text}</p>
      {label && href && (
        <ButtonLink href={href} variant="primary">
          {label}
          <ArrowRight className="size-3.5 rtl:-scale-x-100" aria-hidden />
        </ButtonLink>
      )}
    </div>
  );
}

const METRIC_TONE: Record<Tone, string> = { ok: 'text-ok', warn: 'text-warn', crit: 'text-crit', idle: 'text-fg', info: 'text-accent-hover' };

/** One number with its label. When `href` is set the whole metric links to the filtered page. */
export function Metric({ label, value, tone = 'idle', href, size = 'md' }: { label: string; value: React.ReactNode; tone?: Tone; href?: string; size?: 'md' | 'lg' }) {
  const body = (
    <>
      <span className={clsx('tnum block font-semibold leading-none tracking-[-0.02em]', size === 'lg' ? 'text-[28px]' : 'text-[22px]', METRIC_TONE[tone])}>{value}</span>
      <span className="mt-1.5 block text-[11.5px] leading-tight text-muted">{label}</span>
    </>
  );
  return href ? (
    <Link href={href} className="block min-w-0 rounded-[7px] px-1.5 py-1 transition-colors hover:bg-raised">
      {body}
    </Link>
  ) : (
    <div className="min-w-0 px-1.5 py-1">{body}</div>
  );
}

type QueryLike<T> = { data: T | undefined; error: ApiError | null };

/** Turns a widget's queries into its attention report: loading until every query answered, error if one failed. */
export function attentionFrom<T extends unknown[]>(queries: { [K in keyof T]: QueryLike<T[K]> }, derive: (...data: T) => AttentionItem[]): AttentionReport {
  if (queries.some((q) => q.data === undefined && q.error)) return { state: 'error' };
  if (queries.some((q) => q.data === undefined)) return { state: 'loading' };
  return { state: 'ready', items: derive(...(queries.map((q) => q.data) as T)) };
}
