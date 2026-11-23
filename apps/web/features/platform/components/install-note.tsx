'use client';

import type { ProgramId } from '@nigafiy/shared-types/programs';
import clsx from 'clsx';
import { Download } from 'lucide-react';
import Link from 'next/link';
import type { ComponentProps } from 'react';
import { fill, useI18n } from '@/lib/i18n';
import { installHref, programById } from '@/lib/programs';
import { usePrograms } from '@/lib/programs-context';
import { ProgramGlyph } from './programs-strip';

/**
 * What a not-installed program's action reads instead (spec §6.1, Milestone 4 plan): "Available in
 * Nigafiy X: Install", leading to the Hub's programs page where the program and how to get it are
 * described. Never hidden, never a dead button.
 */
export function InstallNote({ program, className }: { program: ProgramId; className?: string }) {
  const { t, locale } = useI18n();
  const p = programById(program);
  const name = p.name[locale];
  return (
    <span data-install-note={program} className={clsx('inline-flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted', className)}>
      <ProgramGlyph id={program} size={18} />
      <span>
        <bdi>{fill(t('platform.availableIn'), { name })}</bdi>:
      </span>
      <Link
        href={installHref(program)}
        aria-label={fill(t('platform.installAria'), { name })}
        className="inline-flex items-center gap-1 rounded-[5px] px-1 font-medium text-accent-hover hover:underline focus-visible:outline-2 focus-visible:outline-accent"
      >
        <Download className="size-3.5" aria-hidden />
        {t('platform.install')}
      </Link>
    </span>
  );
}

/**
 * A link into another program's page: the link itself while that program is installed, otherwise
 * the install note. Used where one program points at a feature another program owns.
 */
export function ProgramLink({ program, ...props }: { program: ProgramId } & ComponentProps<typeof Link>) {
  const { installed } = usePrograms();
  if (!installed(program)) return <InstallNote program={program} />;
  return <Link {...props} />;
}
