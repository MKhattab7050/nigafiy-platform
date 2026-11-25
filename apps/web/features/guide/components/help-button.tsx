'use client';

import clsx from 'clsx';
import { BookMarked, CircleHelp } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useI18n } from '@/lib/i18n';
import { guideHref, guideTargetForPath } from '../route-map';

/**
 * The help button in the top bar of every signed-in page: a link to the guide section that explains
 * the page (route-map.ts), so it works with the keyboard, opens in a new tab with a middle click and
 * is announced as "Help for this page".
 */
export function HelpButton() {
  const { t } = useI18n();
  const pathname = usePathname() ?? '/';
  const href = guideHref(guideTargetForPath(pathname));
  return (
    <Link
      href={href}
      data-help-button
      aria-label={t('guide.help')}
      title={t('guide.help')}
      className="flex size-8 shrink-0 items-center justify-center rounded-[var(--radius-control)] border border-line-strong text-muted transition-colors hover:bg-raised hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    >
      <CircleHelp className="size-4 rtl:-scale-x-100" aria-hidden />
    </Link>
  );
}

/** "User guide" in the sidebar's account block, the same in every program. */
export function GuideNavLink({ labelClassName }: { labelClassName?: string }) {
  const { t } = useI18n();
  const pathname = usePathname() ?? '/';
  const active = pathname === '/guide' || pathname.startsWith('/guide/');
  return (
    <Link
      href="/guide"
      aria-current={active ? 'page' : undefined}
      className={clsx(
        'group relative mt-1 flex h-9 w-full items-center gap-3 rounded-[var(--radius-control)] px-2.5 text-[13px] hover:bg-raised hover:text-fg lg:rail:justify-center lg:rail:px-0',
        active ? 'bg-accent/[0.12] font-medium text-fg' : 'text-muted',
      )}
    >
      <BookMarked className="size-4 shrink-0" aria-hidden />
      <span className={labelClassName}>{t('guide.nav')}</span>
    </Link>
  );
}
