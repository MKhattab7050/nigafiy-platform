'use client';

import clsx from 'clsx';
import { Bell, House, type LucideIcon, Menu, MonitorSmartphone, Settings } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { FEATURES, isActiveRoute } from '@/features/registry';
import { type Key, useI18n } from '@/lib/i18n';
import { usePrograms } from '@/lib/programs-context';
import { BadgeCount } from './sidebar';

const TABS: { id: string; route: string; label: Key; icon: LucideIcon }[] = [
  { id: 'dashboard', route: '/', label: 'nav.bottom.home', icon: House },
  { id: 'devices', route: '/radar/devices', label: 'nav.devices', icon: MonitorSmartphone },
  { id: 'incidents', route: '/watch/incidents', label: 'nav.bottom.alerts', icon: Bell },
  { id: 'settings', route: '/settings', label: 'nav.settings', icon: Settings },
];

const ITEM = 'relative flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 px-1 pt-1.5 pb-1 text-[11px] leading-tight transition-colors duration-[120ms]';

/**
 * Phones (below 768 px): the main places as a fixed bar at the bottom, in thumb reach. "More" opens
 * the full menu (the sidebar drawer). The shell pads the page by the bar's height, so nothing hides
 * behind it; the bar keeps clear of the home indicator (safe area).
 */
export function BottomNav({ onMore, moreOpen }: { onMore: () => void; moreOpen: boolean }) {
  const pathname = usePathname() ?? '/';
  const { t } = useI18n();
  const { installed } = usePrograms();
  const tabs = TABS.filter((tab) => installed(FEATURES.find((f) => f.id === tab.id)?.program ?? 'hub'));
  const activeId = tabs.find((tab) => isActiveRoute(tab.route, pathname))?.id;

  return (
    <nav
      aria-label={t('nav.bottom.label')}
      className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden print:hidden"
    >
      <ul className="mx-auto flex h-14 max-w-md items-stretch">
        {tabs.map((tab) => {
          const active = tab.id === activeId;
          const Icon = tab.icon;
          const badge = FEATURES.find((f) => f.id === tab.id)?.badge;
          return (
            <li key={tab.id} className="flex min-w-0 flex-1">
              <Link href={tab.route} aria-current={active ? 'page' : undefined} className={clsx(ITEM, active ? 'font-medium text-fg' : 'text-muted hover:text-fg')}>
                {/* active marker on the top edge, so the current place reads without colour too */}
                <span aria-hidden className={clsx('absolute inset-x-4 top-0 h-[3px] rounded-b-full bg-accent transition-opacity', active ? 'opacity-100' : 'opacity-0')} />
                <span className="relative">
                  <Icon className={clsx('size-5', active ? 'text-accent-hover' : 'text-faint')} aria-hidden />
                  {badge && (
                    <BadgeCount
                      badge={badge}
                      className="tnum absolute -top-1.5 start-3 inline-flex h-4 min-w-4 items-center justify-center rounded-[5px] bg-crit px-1 text-[10px] font-semibold text-on-accent"
                    />
                  )}
                </span>
                <span className="max-w-full truncate">{t(tab.label)}</span>
              </Link>
            </li>
          );
        })}
        <li className="flex min-w-0 flex-1">
          <button type="button" onClick={onMore} aria-expanded={moreOpen} aria-haspopup="dialog" className={clsx(ITEM, !activeId || moreOpen ? 'font-medium text-fg' : 'text-muted hover:text-fg')}>
            <span aria-hidden className={clsx('absolute inset-x-4 top-0 h-[3px] rounded-b-full bg-accent transition-opacity', !activeId ? 'opacity-100' : 'opacity-0')} />
            <Menu className={clsx('size-5', !activeId ? 'text-accent-hover' : 'text-faint')} aria-hidden />
            <span className="max-w-full truncate">{t('nav.bottom.more')}</span>
          </button>
        </li>
      </ul>
    </nav>
  );
}
