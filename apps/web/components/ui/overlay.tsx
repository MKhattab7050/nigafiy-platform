'use client';

import clsx from 'clsx';
import { X } from 'lucide-react';
import { useEffect, useId, useRef } from 'react';
import { useI18n } from '@/lib/i18n';

function useShowModal(ref: React.RefObject<HTMLDialogElement | null>) {
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal(); // native <dialog>: focus trap + Escape for free
  }, [ref]);
}

function DialogHeader({ id, title, onClose }: { id: string; title: string; onClose: () => void }) {
  const { t } = useI18n();
  return (
    <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3.5">
      <h2 id={id} className="text-[15px] font-semibold" dir="auto">
        {title}
      </h2>
      <button type="button" onClick={onClose} aria-label={t('common.close')} className="rounded-[6px] p-1.5 text-muted transition-colors hover:bg-raised hover:text-fg">
        <X className="size-4" aria-hidden />
      </button>
    </div>
  );
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useShowModal(ref);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
      className={clsx(
        'm-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] animate-enter overflow-y-auto rounded-[12px] border border-line-strong bg-surface p-0 text-fg shadow-[var(--shadow-overlay)] backdrop:bg-[rgb(5_9_14/0.6)]',
        wide ? 'max-w-2xl' : 'max-w-md',
      )}
    >
      <DialogHeader id={titleId} title={title} onClose={onClose} />
      <div className="p-5">{children}</div>
    </dialog>
  );
}

/** A panel that slides in from the end side: details that should not cover the whole page. */
export function Drawer({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useShowModal(ref);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
      className="fixed inset-y-0 start-auto end-0 m-0 h-dvh max-h-dvh w-[min(28rem,100%)] max-w-full animate-enter overflow-y-auto border-s border-line-strong bg-surface p-0 text-fg shadow-[var(--shadow-overlay)] backdrop:bg-[rgb(5_9_14/0.5)]"
    >
      <DialogHeader id={titleId} title={title} onClose={onClose} />
      <div className="p-5">{children}</div>
    </dialog>
  );
}

/**
 * A short hint shown on hover and on keyboard focus. The trigger keeps its own accessible name;
 * the tooltip text is supplementary (aria-describedby is not needed for a duplicate of the label).
 */
export function Tooltip({ label, children, side = 'top' }: { label: string; children: React.ReactNode; side?: 'top' | 'bottom' }) {
  return (
    <span className="group/tt relative inline-flex">
      {children}
      <span
        aria-hidden
        className={clsx(
          'pointer-events-none absolute start-1/2 z-50 w-max max-w-56 -translate-x-1/2 rounded-[6px] border border-line-strong bg-raised px-2 py-1 text-[11.5px] leading-snug text-fg opacity-0 shadow-[var(--shadow-overlay)] transition-opacity duration-[120ms] group-focus-within/tt:opacity-100 group-hover/tt:opacity-100 rtl:translate-x-1/2',
          side === 'top' ? 'bottom-full mb-1.5' : 'top-full mt-1.5',
        )}
      >
        {label}
      </span>
    </span>
  );
}
