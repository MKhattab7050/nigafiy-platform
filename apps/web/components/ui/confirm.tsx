'use client';

import { TriangleAlert } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { Button } from './controls';

export interface ConfirmOptions {
  /** Short question; defaults to "Are you sure?". */
  title?: string;
  /** Label of the confirming button; defaults to "Confirm". */
  confirmLabel?: string;
  /** Deletes, revokes, stops or cuts something off: red button and a warning icon. */
  destructive?: boolean;
}

type Ask = (message: string, options?: ConfirmOptions) => Promise<boolean>;

const Ctx = createContext<Ask | null>(null);

interface Pending extends ConfirmOptions {
  message: string;
  resolve: (ok: boolean) => void;
}

/**
 * One confirmation dialog for the whole app, in place of `window.confirm()`: in the page's language
 * and direction, named and described for screen readers (role="alertdialog"), focus starts on
 * Cancel (the safe choice), Escape or a click outside cancels, and focus goes back afterwards.
 */
export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const ask = useCallback<Ask>(
    (message, options) =>
      new Promise<boolean>((resolve) => {
        setPending((prev) => {
          prev?.resolve(false); // a second question replaces an unanswered one
          return { message, ...options, resolve };
        });
      }),
    [],
  );
  const answer = useCallback((ok: boolean) => {
    setPending((prev) => {
      prev?.resolve(ok);
      return null;
    });
  }, []);
  return (
    <Ctx.Provider value={ask}>
      {children}
      {pending && <ConfirmDialog key={pending.message} pending={pending} onAnswer={answer} />}
    </Ctx.Provider>
  );
}

/** `const confirm = useConfirm(); if (!(await confirm(text, { destructive: true }))) return;` */
export function useConfirm(): Ask {
  const ask = useContext(Ctx);
  if (!ask) throw new Error('useConfirm outside ConfirmProvider');
  return ask;
}

function ConfirmDialog({ pending, onAnswer }: { pending: Pending; onAnswer: (ok: boolean) => void }) {
  const { t } = useI18n();
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const bodyId = useId();
  useEffect(() => {
    const dialog = ref.current;
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (dialog && !dialog.open) dialog.showModal(); // native modal: the page behind is inert
    dialog?.querySelector<HTMLButtonElement>('[data-confirm-cancel]')?.focus();
    return () => {
      if (before?.isConnected) before.focus();
    };
  }, []);
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the click is on the backdrop only; Escape reaches onCancel
    <dialog
      ref={ref}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      onCancel={(e) => {
        e.preventDefault();
        onAnswer(false);
      }}
      onClick={(e) => e.target === ref.current && onAnswer(false)}
      // open:flex keeps the UA's display:none while closed. Phones: above the bottom bar and the safe
      // area (same rule as Modal), the message scrolls and the buttons below it always stay in view.
      className="m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-md animate-enter flex-col overflow-hidden rounded-[12px] border border-line-strong bg-surface p-0 text-fg shadow-[var(--shadow-overlay)] backdrop:bg-[rgb(5_9_14/0.6)] open:flex max-md:bottom-[calc(3.5rem+env(safe-area-inset-bottom))] max-md:max-h-[calc(100dvh-3.5rem-env(safe-area-inset-bottom)-2rem)]"
    >
      <div className="flex min-h-0 flex-1 gap-3 overflow-y-auto overscroll-contain px-5 pt-5 pb-5">
        {pending.destructive && (
          <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-crit/15 text-crit" aria-hidden>
            <TriangleAlert className="size-4" />
          </span>
        )}
        <div className="min-w-0">
          <h2 id={titleId} className="text-[15px] font-semibold" dir="auto">
            {pending.title ?? t('confirm.title')}
          </h2>
          <p id={bodyId} className="mt-1.5 whitespace-pre-line text-[13px] text-muted" dir="auto">
            {pending.message}
          </p>
        </div>
      </div>
      <div className="flex shrink-0 justify-end gap-2 border-t border-line px-5 py-3.5">
        <Button data-confirm-cancel onClick={() => onAnswer(false)}>
          {t('common.cancel')}
        </Button>
        <Button variant={pending.destructive ? 'danger' : 'primary'} onClick={() => onAnswer(true)}>
          {pending.confirmLabel ?? t('confirm.ok')}
        </Button>
      </div>
    </dialog>
  );
}
