'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useLayoutEffect, useState } from 'react';
import { useSession } from '@/lib/app';
import { useProgramId } from '@/lib/programs-context';
import { useTheme } from '@/lib/theme';
import { Sidebar } from './sidebar';
import { TopBar } from './top-bar';

/** One screen: one sidebar (fixed on desktop, collapsible to an icon rail; a drawer on phones), one top bar, and the page. */
export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { me } = useSession();
  const { bindUser } = useTheme();
  const [open, setOpen] = useState(false);
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
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <div className="min-h-dvh transition-[padding] duration-200 lg:ps-60 lg:rail:ps-[4.25rem]">
      <aside className="fixed inset-y-0 start-0 z-30 hidden w-60 border-e border-line bg-surface transition-[width] duration-200 lg:block lg:rail:w-[4.25rem]">
        <Sidebar />
      </aside>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true">
          <div className="absolute inset-0 animate-enter bg-[rgb(5_9_14/0.55)]" onClick={() => setOpen(false)} aria-hidden />
          <aside className="absolute inset-y-0 start-0 w-72 max-w-[85vw] animate-enter border-e border-line bg-surface shadow-[var(--shadow-overlay)]">
            <Sidebar onClose={() => setOpen(false)} />
          </aside>
        </div>
      )}
      <TopBar onMenu={() => setOpen(true)} />
      <main key={pathname} className="mx-auto w-full min-w-0 max-w-[1480px] animate-enter px-4 py-6 lg:px-8 lg:py-7">
        {children}
      </main>
    </div>
  );
}
