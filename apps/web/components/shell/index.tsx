'use client';

import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useFocusTrap } from '@/components/ui/focus-trap';
import { useSession } from '@/lib/app';
import { useI18n } from '@/lib/i18n';
import { useProgramId } from '@/lib/programs-context';
import { useTheme } from '@/lib/theme';
import { ShellPartBoundary } from './part-boundary';
import { Sidebar } from './sidebar';
import { TopBar } from './top-bar';

/** One screen: one sidebar (fixed on desktop, collapsible to an icon rail; a drawer on phones), one top bar, and the page. */
export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { me } = useSession();
  const { bindUser } = useTheme();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const drawer = useRef<HTMLDivElement>(null);
  const program = useProgramId();

  // The program's accent tokens (globals.css, html[data-program]) follow the URL. Set before paint so a
  // program never flashes in another program's colour; removed when the shell unmounts (sign-in pages).
  useLayoutEffect(() => {
    document.documentElement.dataset.program = program;
  }, [program]);
  useLayoutEffect(
    () => () => {
      delete document.documentElement.dataset.program;
    },
    [],
  );

  useEffect(() => bindUser(me.user.id), [bindUser, me.user.id]);
  useEffect(() => setOpen(false), [pathname]);
  // Phone menu: focus moves in, Tab stays inside, Escape closes, focus returns to the menu button.
  useFocusTrap(drawer, open, close);

  return (
    <div className="min-h-dvh transition-[padding] duration-200 lg:ps-60 lg:rail:ps-[4.25rem]">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:start-3 focus:top-3 focus:z-50 focus:rounded-[6px] focus:border focus:border-line-strong focus:bg-surface focus:px-3 focus:py-2 focus:text-fg focus:shadow-[var(--shadow-overlay)]"
      >
        {t('shell.skipToContent')}
      </a>
      <aside className="fixed inset-y-0 start-0 z-30 hidden w-60 border-e border-line bg-surface transition-[width] duration-200 lg:block lg:rail:w-[4.25rem]">
        <ShellPartBoundary part="sidebar">
          <Sidebar />
        </ShellPartBoundary>
      </aside>
      {open && (
        <div ref={drawer} className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label={t('shell.navigation')} tabIndex={-1}>
          <div className="absolute inset-0 animate-enter bg-[rgb(5_9_14/0.55)]" onClick={close} aria-hidden />
          <aside className="absolute inset-y-0 start-0 w-72 max-w-[85vw] animate-enter border-e border-line bg-surface shadow-[var(--shadow-overlay)]">
            <ShellPartBoundary part="sidebar">
              <Sidebar onClose={close} />
            </ShellPartBoundary>
          </aside>
        </div>
      )}
      <ShellPartBoundary part="topBar">
        <TopBar onMenu={() => setOpen(true)} />
      </ShellPartBoundary>
      <main key={pathname} id="main" tabIndex={-1} className="outline-none mx-auto w-full min-w-0 max-w-[1480px] animate-enter px-4 py-6 lg:px-8 lg:py-7">
        {children}
      </main>
    </div>
  );
}
