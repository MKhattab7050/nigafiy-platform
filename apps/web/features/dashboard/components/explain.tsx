'use client';

import clsx from 'clsx';
import { Info } from 'lucide-react';
import { useState } from 'react';
import { Modal } from '@/components/ui';
import { duration } from '@/lib/format';
import { useI18n } from '@/lib/i18n';

/** "5m", "1.0h": the short form the dashboard uses for a span of time (a check or scan interval). */
export const every = (seconds: number) => duration(new Date(0).toISOString(), new Date(seconds * 1000).toISOString());

/** What a number is based on, in four plain rows. */
export interface Basis {
  from: React.ReactNode;
  window: React.ReactNode;
  counted: React.ReactNode;
  left: React.ReactNode;
}

export function BasisList({ basis }: { basis: Basis }) {
  const { t } = useI18n();
  const rows: [string, React.ReactNode][] = [
    [t('dash.explain.from'), basis.from],
    [t('dash.explain.window'), basis.window],
    [t('dash.explain.counted'), basis.counted],
    [t('dash.explain.left'), basis.left],
  ];
  return (
    <dl className="space-y-4">
      {rows.map(([label, body]) => (
        <div key={label}>
          <dt className="text-[11.5px] font-medium uppercase tracking-[0.04em] text-faint">{label}</dt>
          <dd className="mt-1 text-[13px] leading-relaxed text-fg" dir="auto">
            {body}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * "How is this worked out?": the trigger is either the number itself (`children`) or, without
 * children, a small info button. The explanation opens in the app's own dialog, which also suits a phone.
 */
export function Explain({ title, basis, children, className }: { title: string; basis: () => Basis; children?: React.ReactNode; className?: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        title={t('dash.explain.open')}
        aria-label={children ? undefined : t('dash.explain.open')}
        className={clsx(
          children
            ? 'rounded-[var(--radius-control)] text-start decoration-dotted underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2'
            : 'inline-flex size-6 items-center justify-center rounded-full text-faint transition-colors hover:bg-raised hover:text-fg',
          className,
        )}
      >
        {children ?? <Info className="size-3.5" aria-hidden />}
        {children && <span className="sr-only"> · {t('dash.explain.open')}</span>}
      </button>
      {open && (
        <Modal title={title} onClose={() => setOpen(false)}>
          <BasisList basis={basis()} />
        </Modal>
      )}
    </>
  );
}
