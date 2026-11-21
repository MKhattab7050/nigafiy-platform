'use client';

import { Info } from 'lucide-react';
import type { ControlAction } from '@/lib/controls';
import { useApp } from '@/lib/app';
import { type Key, fill, useI18n } from '@/lib/i18n';
import { Button } from './ui';

/** Why an action is not possible, in words: the translated reason plus the API's own note when it adds something. */
export function useActionReason(): (action: ControlAction) => string | null {
  const { t } = useI18n();
  const { can } = useApp();
  return (action) => {
    if (action.possible) {
      if (action.min_role && !can(action.min_role)) return fill(t('control.needsRole'), { role: t(`control.role.${action.min_role}` as Key) });
      return null;
    }
    const key = `control.reason.${action.reason ?? 'unknown'}` as Key;
    const text = t(key) === key ? t('control.reason.unknown') : t(key);
    return action.note && action.reason !== 'already_monitored' ? `${text} ${action.note}` : text;
  };
}

/**
 * A button for one action the API described. Not possible (or not allowed for this role): the
 * button stays visible but disabled, with the reason written next to it, never a dead button.
 */
export function ActionButton({
  action,
  children,
  onRun,
  busy,
  variant = 'secondary',
  size = 'sm',
}: {
  action: ControlAction;
  children: React.ReactNode;
  onRun: () => void;
  busy?: boolean;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
}) {
  const reason = useActionReason()(action);
  return (
    <span className="inline-flex max-w-full flex-col items-start gap-1">
      <Button size={size} variant={variant} busy={busy} disabled={Boolean(reason)} onClick={onRun} aria-describedby={undefined}>
        {children}
      </Button>
      {reason && <ReasonNote>{reason}</ReasonNote>}
    </span>
  );
}

/** The small "why not" line under a disabled control. */
export function ReasonNote({ children }: { children: React.ReactNode }) {
  return (
    <span className="flex max-w-prose items-start gap-1 text-[11.5px] leading-snug text-muted" dir="auto">
      <Info className="mt-px size-3 shrink-0 text-faint" aria-hidden />
      <span className="min-w-0">{children}</span>
    </span>
  );
}
