'use client';

import clsx from 'clsx';
import { Check, ChevronsUpDown } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';
import { ProgramGlyph } from '@/features/platform';
import { fill, useI18n } from '@/lib/i18n';
import { PROGRAM_REGISTRY, installHref, programById } from '@/lib/programs';
import { usePrograms, useProgramId } from '@/lib/programs-context';

/**
 * Top of every program's sidebar: the current program's glyph and name, and a menu to move to any
 * other program (spec §6.2). A program that is not installed stays in the list and leads to the
 * Hub's install page instead of opening.
 */
export function ProgramSwitcher() {
  const { t, locale } = useI18n();
  const current = programById(useProgramId());
  const { installed } = usePrograms();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    // Focus the current program's entry so arrow keys (the sidebar's own handler) start from it.
    box.current?.querySelector<HTMLElement>('[aria-current="true"]')?.focus();
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  return (
    <div ref={box} className="relative min-w-0 flex-1 lg:rail:flex-none">
      <button
        ref={button}
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title={fill(t('platform.switcher.current'), { name: current.name[locale] })}
        onClick={() => setOpen((v) => !v)}
        className="group relative flex h-10 w-full min-w-0 items-center gap-2.5 rounded-[var(--radius-control)] px-1.5 text-start hover:bg-raised lg:rail:w-10 lg:rail:justify-center lg:rail:px-0"
      >
        <ProgramGlyph id={current.id} size={28} />
        <span className="min-w-0 flex-1 lg:rail:hidden">
          <span className="block text-[10.5px] leading-tight text-faint">Nigafiy</span>
          <span className="block truncate text-[14px] font-semibold leading-tight text-fg">
            <bdi>{current.shortName}</bdi>
          </span>
        </span>
        <ChevronsUpDown className="size-4 shrink-0 text-faint group-hover:text-muted lg:rail:hidden" aria-hidden />
        <span className="sr-only">{t('platform.switcher')}</span>
      </button>
      {open && (
        <nav
          id={menuId}
          aria-label={t('platform.switcher')}
          className="absolute start-0 top-[calc(100%+6px)] z-50 w-72 max-w-[85vw] animate-enter rounded-[10px] border border-line-strong bg-raised p-1.5 shadow-[var(--shadow-overlay)]"
        >
          <ul className="space-y-0.5">
            {PROGRAM_REGISTRY.map((p) => {
              const here = p.id === current.id;
              const ok = installed(p.id);
              return (
                <li key={p.id}>
                  <Link
                    href={ok ? p.home : installHref(p.id)}
                    aria-current={here ? 'true' : undefined}
                    onClick={() => setOpen(false)}
                    className={clsx('flex min-w-0 items-center gap-2.5 rounded-[7px] px-2 py-1.5 hover:bg-surface', here && 'bg-surface')}
                  >
                    <ProgramGlyph id={p.id} size={26} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium text-fg">
                        <bdi>{p.name[locale]}</bdi>
                      </span>
                      <span className="block truncate text-[11.5px] text-muted">{ok ? p.job[locale] : `${t('platform.switcher.notInstalled')} · ${t('platform.install')}`}</span>
                    </span>
                    {here && <Check className="size-4 shrink-0 text-accent-hover" aria-hidden />}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      )}
    </div>
  );
}
