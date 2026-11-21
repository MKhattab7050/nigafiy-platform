'use client';

import clsx from 'clsx';
import { ChevronDown, Loader2 } from 'lucide-react';
import { useId, useRef } from 'react';

// ── buttons ──

export const BUTTON_VARIANT = {
  primary: 'bg-accent text-on-accent border-transparent hover:bg-accent-strong active:bg-accent-strong/90',
  secondary: 'bg-surface text-fg border-line-strong hover:bg-raised active:bg-line',
  ghost: 'bg-transparent text-muted border-transparent hover:text-fg hover:bg-raised active:bg-line',
  danger: 'bg-transparent text-crit border-crit/40 hover:bg-crit/10 active:bg-crit/15',
} as const;

export const BUTTON_SIZE = { sm: 'h-8 px-2.5 text-xs gap-1.5', md: 'h-9 px-3.5 text-[13px] gap-2' } as const;

export const BUTTON_BASE =
  'inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap rounded-[var(--radius-control)] border font-medium transition-[background-color,color,border-color,transform] duration-[120ms] active:translate-y-px disabled:pointer-events-none disabled:opacity-50';

export function Button({
  variant = 'secondary',
  size = 'md',
  busy,
  className,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: keyof typeof BUTTON_VARIANT; size?: 'sm' | 'md'; busy?: boolean }) {
  return (
    <button type="button" {...props} disabled={props.disabled || busy} aria-busy={busy || undefined} className={clsx(BUTTON_BASE, BUTTON_SIZE[size], BUTTON_VARIANT[variant], className)}>
      {busy && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
      {children}
    </button>
  );
}

// ── form fields ──

export const FIELD =
  'h-9 w-full min-w-0 rounded-[var(--radius-control)] border border-line-strong bg-sunken px-3 text-[13px] text-fg placeholder:text-faint transition-[border-color,box-shadow] duration-[120ms] hover:border-faint/60 focus:border-accent focus:shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-accent)_22%,transparent)] focus:outline-none disabled:cursor-not-allowed disabled:opacity-60 aria-[invalid=true]:border-crit';

/** Visible label, optional hint, inline error (announced, and linked to the input for screen readers). */
export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: (id: string) => React.ReactNode }) {
  const id = useId();
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="mb-1.5 block text-xs font-medium text-fg/85">
        {label}
      </label>
      {children(id)}
      {error ? (
        <p id={`${id}-error`} role="alert" className="mt-1.5 text-xs text-crit">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="mt-1.5 text-xs leading-relaxed text-faint">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={clsx(FIELD, props.className)} />;
}

export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={clsx(FIELD, 'h-auto min-h-20 py-2 leading-relaxed', props.className)} />;
}

export function Select({ children, className, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className={clsx('relative block min-w-0', className)}>
      <select {...props} className={clsx(FIELD, 'cursor-pointer appearance-none pe-8', className?.match(/\bh-\d+\b/)?.[0])}>
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute end-2.5 top-1/2 size-3.5 -translate-y-1/2 text-faint" aria-hidden />
    </span>
  );
}

/** A small set of mutually exclusive choices (ranges, filters). */
export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="group" aria-label={label} className="inline-flex max-w-full rounded-[var(--radius-control)] border border-line-strong bg-sunken p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
          className={clsx(
            'h-7 whitespace-nowrap rounded-[5px] px-2.5 text-xs font-medium transition-colors duration-[120ms]',
            o.value === value ? 'bg-surface text-fg shadow-[0_0_0_1px_var(--color-line-strong)]' : 'text-muted hover:text-fg',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Tabs for detail pages: a real tablist (arrow keys, Home/End), scrolling sideways on narrow
 * screens instead of widening the page.
 */
export function Tabs<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string; count?: number }[]; onChange: (v: T) => void; label: string }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const move = (index: number) => {
    const i = (index + options.length) % options.length;
    onChange(options[i]!.value);
    refs.current[i]?.focus();
  };
  return (
    <div className="-mx-1 mb-5 max-w-[calc(100%+0.5rem)] overflow-x-auto px-1">
      <div role="tablist" aria-label={label} className="flex min-w-max gap-1 border-b border-line">
        {options.map((o, i) => {
          const selected = o.value === value;
          return (
            <button
              key={o.value}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              role="tab"
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
              onClick={() => onChange(o.value)}
              onKeyDown={(e) => {
                const rtl = document.documentElement.dir === 'rtl';
                if (e.key === (rtl ? 'ArrowLeft' : 'ArrowRight')) move(i + 1);
                else if (e.key === (rtl ? 'ArrowRight' : 'ArrowLeft')) move(i - 1);
                else if (e.key === 'Home') move(0);
                else if (e.key === 'End') move(options.length - 1);
                else return;
                e.preventDefault();
              }}
              className={clsx(
                'relative -mb-px flex h-10 items-center gap-1.5 whitespace-nowrap border-b-2 px-3 text-[13px] font-medium transition-colors duration-[120ms]',
                selected ? 'border-accent text-fg' : 'border-transparent text-muted hover:text-fg',
              )}
            >
              {o.label}
              {o.count !== undefined && <span className={clsx('tnum rounded-[4px] px-1 text-[11px] leading-4', selected ? 'bg-accent/15 text-accent-hover' : 'bg-raised text-faint')}>{o.count}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** On/off for a setting that applies immediately. Pass `label` for the accessible name when no visible label points at it. */
export function Switch({ checked, onChange, disabled, label, id }: { checked: boolean; onChange: (next: boolean) => void; disabled?: boolean; label?: string; id?: string }) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={clsx(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors duration-[120ms] disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'border-transparent bg-accent' : 'border-line-strong bg-sunken',
      )}
    >
      <span
        aria-hidden
        className={clsx(
          'absolute top-1/2 size-3.5 -translate-y-1/2 rounded-full transition-[inset-inline-start] duration-[120ms]',
          checked ? 'start-[18px] bg-on-accent' : 'start-0.5 bg-faint',
        )}
      />
    </button>
  );
}
