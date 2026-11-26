'use client';

import clsx from 'clsx';
import { Check, Copy } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { Button } from './controls';

export function CopyBlock({ value, label, multiline }: { value: string; label?: string; multiline?: boolean }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  return (
    <div>
      {label && <p className="mb-1.5 text-xs font-medium text-muted">{label}</p>}
      <div className="flex items-start gap-2 rounded-[var(--radius-control)] border border-line-strong bg-sunken p-2">
        <code className={clsx('mono min-w-0 flex-1 text-xs leading-relaxed text-fg', multiline ? 'whitespace-pre-wrap break-all' : 'truncate py-1')}>{value}</code>
        <Button
          size="sm"
          onClick={() => {
            void navigator.clipboard
              ?.writeText(value)
              .then(() => {
                setCopied(true);
                clearTimeout(timerRef.current);
                timerRef.current = setTimeout(() => setCopied(false), 1500);
              })
              .catch(() => undefined);
          }}
        >
          {copied ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
          <span aria-live="polite">{copied ? t('common.copied') : t('common.copy')}</span>
        </Button>
      </div>
    </div>
  );
}

/** Definition row used on detail pages: label, value, and where the value came from. */
export function Fact({ label, children, source }: { label: string; children: React.ReactNode; source?: string }) {
  return (
    <div className="grid grid-cols-[minmax(0,8.5rem)_minmax(0,1fr)] gap-3 border-b border-line py-2.5 last:border-0 sm:grid-cols-[11rem_minmax(0,1fr)]">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="min-w-0 break-words text-[13px] text-fg">
        {children}
        {source && <span className="mt-0.5 block text-[11px] text-faint">{source}</span>}
      </dd>
    </div>
  );
}

/** Renders an event's evidence object so a human can inspect exactly what was observed. */
export function Evidence({ details }: { details: Record<string, unknown> }) {
  const entries = Object.entries(details).filter(([, v]) => v !== null && v !== undefined && v !== '');
  if (!entries.length) return null;
  // Nested values are shown as labelled rows (a few levels deep), never as raw JSON.
  const render = (value: unknown, depth = 0): React.ReactNode => {
    if (value === null || value === undefined || value === '') return '—';
    if (Array.isArray(value)) {
      if (value.every((v) => v === null || typeof v !== 'object')) return value.map((v) => (v === null ? '—' : String(v))).join(', ');
      return (
        <ul className="space-y-1">
          {value.map((v, i) => (
            <li key={i} className="border-s border-line ps-2">
              {render(v, depth + 1)}
            </li>
          ))}
        </ul>
      );
    }
    if (typeof value === 'object') {
      if (depth > 3) return '…';
      return (
        <dl className="space-y-0.5">
          {Object.entries(value as Record<string, unknown>).map(([k, v]) => (
            <div key={k} className="flex gap-2">
              <dt className="shrink-0 text-faint">{k.replaceAll('_', ' ')}</dt>
              <dd className="mono min-w-0 break-words">{render(v, depth + 1)}</dd>
            </div>
          ))}
        </dl>
      );
    }
    return String(value);
  };
  return (
    <dl dir="ltr" className="grid gap-x-4 gap-y-1.5 text-start text-xs sm:grid-cols-[11rem_1fr]">
      {entries.map(([key, value]) => (
        <div key={key} className="contents">
          <dt className="capitalize text-faint">{key.replaceAll('_', ' ')}</dt>
          <dd className="min-w-0 break-words text-muted">{render(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Table frame. `stack` turns each row into a labelled card below 768 px (give every <td> a
 * `data-label`); without it the table scrolls sideways inside its own frame, never the page.
 */
export function DataTable({ children, stack, minWidth, className }: { children: React.ReactNode; stack?: boolean; minWidth?: number; className?: string }) {
  return (
    // A stacked table never needs to scroll, so its header can stay pinned under the top bar.
    // A scrolling one becomes its own scroll box, so a pinned header would sit 3.5rem down inside it, on top of the first row.
    <div className={clsx(!stack && 'data-table-scroll overflow-x-auto', className)}>
      <table className={clsx('data-table', stack && 'stack')} style={minWidth ? { minWidth: stack ? undefined : minWidth } : undefined}>
        {children}
      </table>
    </div>
  );
}
