'use client';

import clsx from 'clsx';
import { AlertTriangle, Check, Copy, Loader2, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { CheckState, DeviceStatus, Severity } from '@lan-detective/shared-types';
import type { ApiError } from '@/lib/api';
import { type Key, useI18n } from '@/lib/i18n';

// ── layout primitives ──

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: React.ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight text-fg">{title}</h1>
        {description && <p className="mt-1 max-w-3xl text-[13px] leading-relaxed text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Card({ title, action, children, className, padded = true }: { title?: React.ReactNode; action?: React.ReactNode; children: React.ReactNode; className?: string; padded?: boolean }) {
  return (
    <section className={clsx('rounded-lg border border-line bg-surface', className)}>
      {(title || action) && (
        <header className="flex min-h-11 items-center justify-between gap-3 border-b border-line px-4 py-2">
          <h2 className="text-[13px] font-semibold text-fg">{title}</h2>
          {action}
        </header>
      )}
      <div className={padded ? 'p-4' : undefined}>{children}</div>
    </section>
  );
}

// ── state colours: the only place state → colour is decided ──

const TONE = {
  ok: { dot: 'bg-ok', text: 'text-ok', soft: 'bg-ok/10 text-ok border-ok/25' },
  warn: { dot: 'bg-warn', text: 'text-warn', soft: 'bg-warn/10 text-warn border-warn/25' },
  crit: { dot: 'bg-crit', text: 'text-crit', soft: 'bg-crit/10 text-crit border-crit/25' },
  idle: { dot: 'bg-idle', text: 'text-muted', soft: 'bg-idle/10 text-muted border-idle/25' },
  info: { dot: 'bg-accent', text: 'text-accent', soft: 'bg-accent/10 text-accent-hover border-accent/25' },
} as const;
export type Tone = keyof typeof TONE;

export const statusTone = (s: DeviceStatus): Tone => (s === 'online' ? 'ok' : s === 'offline' ? 'crit' : 'idle');
export const stateTone = (s: CheckState | null): Tone => (s === 'ok' ? 'ok' : s === 'degraded' ? 'warn' : s === 'down' ? 'crit' : 'idle');
export const severityTone = (s: Severity): Tone => (s === 'critical' ? 'crit' : s === 'warning' ? 'warn' : 'info');

export function Dot({ tone, className }: { tone: Tone; className?: string }) {
  return <span aria-hidden className={clsx('inline-block size-2 shrink-0 rounded-full', TONE[tone].dot, className)} />;
}

/** State is always conveyed by text as well as colour. */
export function Badge({ tone, children, dot = true }: { tone: Tone; children: React.ReactNode; dot?: boolean }) {
  return (
    <span className={clsx('inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4', TONE[tone].soft)}>
      {dot && <Dot tone={tone} className="size-1.5" />}
      {children}
    </span>
  );
}

export function Tag({ children }: { children: React.ReactNode }) {
  return <span className="inline-flex items-center rounded border border-line-strong bg-raised px-1.5 py-px text-[11px] text-muted">{children}</span>;
}

export function StatusBadge({ status }: { status: DeviceStatus }) {
  const { t } = useI18n();
  return <Badge tone={statusTone(status)}>{t(`status.${status}` as Key)}</Badge>;
}

export function StateBadge({ state }: { state: CheckState | null }) {
  const { t } = useI18n();
  return <Badge tone={stateTone(state)}>{t(`state.${state ?? 'unknown'}` as Key)}</Badge>;
}

// ── controls ──

const BUTTON = {
  primary: 'bg-accent text-white hover:bg-accent-hover border-transparent',
  secondary: 'bg-raised text-fg hover:bg-line border-line-strong',
  ghost: 'bg-transparent text-muted hover:text-fg hover:bg-raised border-transparent',
  danger: 'bg-transparent text-crit hover:bg-crit/10 border-crit/40',
} as const;

export function Button({
  variant = 'secondary',
  size = 'md',
  busy,
  className,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: keyof typeof BUTTON; size?: 'sm' | 'md'; busy?: boolean }) {
  return (
    <button
      type="button"
      {...props}
      disabled={props.disabled || busy}
      className={clsx(
        'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md border font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-9 px-3.5 text-[13px]',
        BUTTON[variant],
        className,
      )}
    >
      {busy && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
      {children}
    </button>
  );
}

const FIELD = 'h-9 w-full rounded-md border border-line-strong bg-bg px-3 text-[13px] text-fg placeholder:text-faint focus:border-accent focus:outline-none disabled:opacity-60';

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: (id: string) => React.ReactNode }) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-xs font-medium text-muted">
        {label}
      </label>
      {children(id)}
      {error ? <p className="mt-1 text-xs text-crit">{error}</p> : hint ? <p className="mt-1 text-xs text-faint">{hint}</p> : null}
    </div>
  );
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={clsx(FIELD, props.className)} />;
}

export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={clsx(FIELD, 'h-auto min-h-20 py-2', props.className)} />;
}

export function Select({ children, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...props} className={clsx(FIELD, 'appearance-none bg-[length:0] pe-8', props.className)} style={{ colorScheme: 'dark' }}>
      {children}
    </select>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="group" aria-label={label} className="inline-flex rounded-md border border-line-strong bg-bg p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
          className={clsx('h-7 rounded px-2.5 text-xs font-medium transition-colors', o.value === value ? 'bg-raised text-fg' : 'text-muted hover:text-fg')}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ── feedback ──

export function Spinner({ label }: { label?: string }) {
  const { t } = useI18n();
  return (
    <div role="status" className="flex items-center justify-center gap-2 py-10 text-[13px] text-muted">
      <Loader2 className="size-4 animate-spin" aria-hidden />
      {label ?? t('common.loading')}
    </div>
  );
}

export function EmptyState({ icon, title, children, action }: { icon?: React.ReactNode; title: string; children?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-10 text-center">
      {icon && <div className="mb-3 text-faint">{icon}</div>}
      <p className="text-[13px] font-medium text-fg">{title}</p>
      {children && <p className="mt-1 max-w-md text-[13px] leading-relaxed text-muted">{children}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorNote({ error, onRetry }: { error: ApiError | Error | null; onRetry?: () => void }) {
  const { t } = useI18n();
  if (!error) return null;
  const details = 'details' in error && error.details ? error.details : [];
  return (
    <div role="alert" className="flex items-start gap-2.5 rounded-md border border-crit/30 bg-crit/10 px-3 py-2.5 text-[13px] text-fg">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-crit" aria-hidden />
      <div className="min-w-0 flex-1">
        <p>{error.message || t('common.error')}</p>
        {details.length > 0 && (
          <ul className="mt-1 list-inside list-disc text-xs text-muted">
            {details.map((d, i) => (
              <li key={i}>
                {d.path ? `${d.path}: ` : ''}
                {d.message}
              </li>
            ))}
          </ul>
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

/** Loading / error / content wrapper so every data view handles all three states the same way. */
export function Async<T>({ query, children }: { query: { data: T | undefined; error: ApiError | null; loading: boolean; reload: () => void }; children: (data: T) => React.ReactNode }) {
  if (query.data === undefined) {
    if (query.error) return <ErrorNote error={query.error} onRetry={query.reload} />;
    return <Spinner />;
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

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  const { t } = useI18n();
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal(); // native <dialog>: focus trap + Escape for free
  }, []);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
      className={clsx('m-auto w-[calc(100%-2rem)] rounded-lg border border-line-strong bg-surface p-0 text-fg shadow-2xl shadow-black/60 backdrop:bg-black/60', wide ? 'max-w-2xl' : 'max-w-md')}
    >
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <h2 className="text-sm font-semibold">{title}</h2>
        <button type="button" onClick={onClose} aria-label={t('common.close')} className="rounded p-1 text-muted hover:bg-raised hover:text-fg">
          <X className="size-4" />
        </button>
      </div>
      <div className="p-4">{children}</div>
    </dialog>
  );
}

export function CopyBlock({ value, label, multiline }: { value: string; label?: string; multiline?: boolean }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <div>
      {label && <p className="mb-1.5 text-xs font-medium text-muted">{label}</p>}
      <div className="flex items-start gap-2 rounded-md border border-line-strong bg-bg p-2">
        <code className={clsx('mono min-w-0 flex-1 text-xs leading-relaxed text-fg', multiline ? 'whitespace-pre-wrap break-all' : 'truncate py-1')}>{value}</code>
        <Button
          size="sm"
          onClick={() => {
            void navigator.clipboard.writeText(value).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
          {copied ? t('common.copied') : t('common.copy')}
        </Button>
      </div>
    </div>
  );
}

/** Definition row used on detail pages: label, value, and where the value came from. */
export function Fact({ label, children, source }: { label: string; children: React.ReactNode; source?: string }) {
  return (
    <div className="grid grid-cols-[9rem_1fr] gap-3 border-b border-line py-2.5 last:border-0 sm:grid-cols-[11rem_1fr]">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="min-w-0 text-[13px] text-fg">
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
  const render = (value: unknown): React.ReactNode => {
    if (Array.isArray(value)) {
      if (value.every((v) => typeof v !== 'object')) return value.join(', ');
      return <pre className="mono overflow-x-auto whitespace-pre-wrap text-[11px] text-muted">{JSON.stringify(value, null, 2)}</pre>;
    }
    if (typeof value === 'object' && value !== null) {
      return (
        <dl className="space-y-0.5">
          {Object.entries(value).map(([k, v]) => (
            <div key={k} className="flex gap-2">
              <dt className="text-faint">{k.replaceAll('_', ' ')}</dt>
              <dd className="mono min-w-0 break-words">{v === null ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v)}</dd>
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
