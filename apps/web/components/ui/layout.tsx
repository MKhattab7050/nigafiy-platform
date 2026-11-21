'use client';

import clsx from 'clsx';

/** Every page opens the same way: title, one line of what it is for, and its actions on the end side. */
export function PageHeader({ title, description, actions, icon }: { title: string; description?: string; actions?: React.ReactNode; icon?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
      <div className="flex min-w-0 items-start gap-3">
        {icon && <span className="mt-0.5 hidden size-9 shrink-0 items-center justify-center rounded-[9px] border border-line bg-surface text-muted sm:flex">{icon}</span>}
        <div className="min-w-0">
          <h1 className="text-[22px] font-semibold leading-tight tracking-[-0.01em] text-fg" dir="auto">
            {title}
          </h1>
          {description && (
            <p className="mt-1 max-w-3xl text-[13px] leading-relaxed text-muted" dir="auto">
              {description}
            </p>
          )}
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Card({
  title,
  description,
  action,
  children,
  className,
  padded = true,
}: {
  title?: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  padded?: boolean;
}) {
  return (
    <section className={clsx('min-w-0 rounded-[var(--radius-card)] border border-line bg-surface shadow-[var(--shadow-card)]', className)}>
      {(title || action) && (
        <header className="flex min-h-12 flex-wrap items-center justify-between gap-x-3 gap-y-1.5 border-b border-line px-4 py-2.5">
          <div className="min-w-0">
            <h2 className="text-[13.5px] font-semibold text-fg">{title}</h2>
            {description && <p className="mt-0.5 text-xs text-muted">{description}</p>}
          </div>
          {action}
        </header>
      )}
      <div className={padded ? 'p-4' : undefined}>{children}</div>
    </section>
  );
}

/** A small heading inside a card or panel. */
export function SectionLabel({ children, className }: { children: React.ReactNode; className?: string }) {
  return <h3 className={clsx('mb-2 text-xs font-medium text-muted', className)}>{children}</h3>;
}
