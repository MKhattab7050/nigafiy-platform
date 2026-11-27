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

/**
 * Phones (below md) have the fixed bottom bar (components/shell/bottom-nav.tsx: h-14 = 3.5rem, plus the
 * home-indicator safe area). A modal dialog is in the browser's top layer, so it is always drawn over
 * the bar, but its lower edge would still sit where the bar and the system navigation are: there the
 * dialog keeps to the area above them (inset-block-end), and its height fits what is left.
 */
const PHONE_CLEAR_BAR = 'max-md:bottom-[calc(3.5rem+env(safe-area-inset-bottom))] max-md:max-h-[calc(100dvh-3.5rem-env(safe-area-inset-bottom)-2rem)]';

/**
 * The action row (the last `flex justify-end` row of buttons, the convention every dialog follows,
 * inside the body or its form) stays in view on phones: sticky to the bottom of the scrolling body,
 * on the surface colour, with a hairline above. The side shadows paint the body's 1.25rem padding so
 * scrolled content does not show beside the row. Desktop is unchanged.
 */
const DIALOG_STICKY_FOOTER =
  'max-md:[&_.justify-end:last-child:has(>button)]:sticky max-md:[&_.justify-end:last-child:has(>button)]:bottom-0 max-md:[&_.justify-end:last-child:has(>button)]:z-10 max-md:[&_.justify-end:last-child:has(>button)]:border-t max-md:[&_.justify-end:last-child:has(>button)]:border-line max-md:[&_.justify-end:last-child:has(>button)]:bg-surface max-md:[&_.justify-end:last-child:has(>button)]:py-3 max-md:[&_.justify-end:last-child:has(>button)]:flex-wrap max-md:[&_.justify-end:last-child:has(>button)]:shadow-[1.25rem_0_0_var(--color-surface),-1.25rem_0_0_var(--color-surface)]';

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
        // open:flex, not flex: a plain display class would beat the UA's dialog:not([open]) { display: none }
        'm-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] animate-enter flex-col overflow-hidden rounded-[12px] border border-line-strong bg-surface p-0 text-fg shadow-[var(--shadow-overlay)] backdrop:bg-[rgb(5_9_14/0.6)] open:flex',
        PHONE_CLEAR_BAR,
        wide ? 'max-w-2xl' : 'max-w-md',
      )}
    >
      <DialogHeader id={titleId} title={title} onClose={onClose} />
      {/* the body scrolls, the header stays; the scroller has no padding so a sticky action row meets its edge */}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className={clsx('p-5', DIALOG_STICKY_FOOTER)}>{children}</div>
      </div>
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
      {/* the panel runs to the bottom edge: keep its end clear of the home indicator / system bar */}
      <div className="p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))]">{children}</div>
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
