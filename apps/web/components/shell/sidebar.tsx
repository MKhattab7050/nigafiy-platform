'use client';

import clsx from 'clsx';
import { LogOut, PanelLeftClose, PanelLeftOpen, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
// The component file, not the feature index: the shell must not pull the guide's content into every page.
import { GuideNavLink } from '@/features/guide/components/help-button';
import { type Feature, type NavBadge, isActiveRoute } from '@/features/registry';
import { api } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { type Key, fill, useI18n } from '@/lib/i18n';
import { programById } from '@/lib/programs';
import { useProgramId } from '@/lib/programs-context';
import { SIDEBAR_STORAGE_KEY } from '@/lib/theme-boot';
import { Select } from '../ui';
import { ProgramSwitcher } from './program-switcher';

/** In rail mode a label becomes a hover / focus tooltip beside the icon. */
const RAIL_LABEL =
  'lg:rail:pointer-events-none lg:rail:absolute lg:rail:start-[calc(100%+12px)] lg:rail:z-50 lg:rail:w-max lg:rail:rounded-[6px] lg:rail:border lg:rail:border-line-strong lg:rail:bg-raised lg:rail:px-2 lg:rail:py-1 lg:rail:text-xs lg:rail:text-fg lg:rail:opacity-0 lg:rail:shadow-[var(--shadow-overlay)] lg:rail:transition-opacity lg:rail:group-hover:opacity-100 lg:rail:group-focus-visible:opacity-100';

function BadgeCount({ badge }: { badge: NavBadge }) {
  const { t } = useI18n();
  const { siteId } = useApp();
  const query = useQuery<unknown>(badge.path(siteId), badge.topics, 60_000);
  const count = query.data === undefined ? 0 : badge.count(query.data);
  if (!count) return null;
  return (
    <span className="tnum ms-auto inline-flex h-5 min-w-5 items-center justify-center rounded-[5px] bg-crit px-1 text-[11px] font-semibold text-on-accent lg:rail:absolute lg:rail:-top-1 lg:rail:end-0.5 lg:rail:ms-0 lg:rail:h-4 lg:rail:min-w-4 lg:rail:text-[10px]">
      {count}
      <span className="sr-only"> {t(badge.label)}</span>
    </span>
  );
}

function NavLink({ feature, pathname, siblings }: { feature: Feature; pathname: string; siblings: readonly string[] }) {
  const { t } = useI18n();
  const active = isActiveRoute(feature.route, pathname, siblings);
  const Icon = feature.icon;
  return (
    <Link
      href={feature.route}
      aria-current={active ? 'page' : undefined}
      className={clsx(
        'group relative flex h-9 items-center gap-3 rounded-[var(--radius-control)] px-2.5 text-[13px] transition-colors duration-[120ms] lg:rail:justify-center lg:rail:px-0',
        active ? 'bg-accent/[0.12] font-medium text-fg' : 'text-muted hover:bg-raised hover:text-fg',
      )}
    >
      {/* active marker on the start edge, so the current page reads without colour too */}
      <span aria-hidden className={clsx('absolute inset-y-2 start-0 w-[3px] rounded-e-full bg-accent transition-opacity', active ? 'opacity-100' : 'opacity-0')} />
      <Icon className={clsx('size-[17px] shrink-0', active ? 'text-accent-hover' : 'text-faint group-hover:text-muted')} aria-hidden />
      <span className={clsx('min-w-0 truncate', RAIL_LABEL)}>{t(feature.label)}</span>
      {feature.badge && <BadgeCount badge={feature.badge} />}
    </Link>
  );
}

/** Up / Down / Home / End move between the sidebar's links and buttons. */
function onNavKey(e: React.KeyboardEvent<HTMLElement>) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('a[href], button:not([disabled])'));
  const i = items.indexOf(document.activeElement as HTMLElement);
  if (i < 0) return;
  e.preventDefault();
  const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
  items[next]?.focus();
}

function toggleRail() {
  const root = document.documentElement;
  const rail = root.getAttribute('data-sidebar') !== 'rail';
  if (rail) root.setAttribute('data-sidebar', 'rail');
  else root.removeAttribute('data-sidebar');
  try {
    if (rail) window.localStorage.setItem(SIDEBAR_STORAGE_KEY, 'rail');
    else window.localStorage.removeItem(SIDEBAR_STORAGE_KEY);
  } catch {
    /* storage blocked: applies to this page only */
  }
}

/**
 * The one sidebar: fixed on desktop (collapsible to an icon rail), inside the drawer on small screens.
 * It shows only the current program's sections (spec §6.2), from the program registry, under the
 * program switcher. The account block and sign-out are the same in every program.
 */
export function Sidebar({ onClose }: { onClose?: () => void }) {
  const pathname = usePathname();
  const { t, locale } = useI18n();
  const { me, can, signOut } = useApp();
  const program = programById(useProgramId());
  const visible = program.sections.filter((f) => !f.minRole || can(f.minRole));
  const siblings = program.sections.map((f) => f.route);
  const main = visible.filter((f) => !f.pinBottom);
  const bottom = visible.filter((f) => f.pinBottom);
  const initials = me.user.display_name
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

  return (
    <nav aria-label={fill(t('platform.programNav'), { name: program.name[locale] })} className="flex h-full flex-col" onKeyDown={onNavKey}>
      <div className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-line px-2.5 lg:rail:justify-center lg:rail:px-0">
        <ProgramSwitcher />
        {onClose && (
          <button type="button" className="rounded-[6px] p-1.5 text-muted hover:bg-raised hover:text-fg lg:hidden" onClick={onClose} aria-label={t('common.close')}>
            <X className="size-4" aria-hidden />
          </button>
        )}
      </div>
      <div className="flex-1 space-y-5 overflow-y-auto px-3 py-4 lg:rail:overflow-visible lg:rail:px-2.5">
        <ul className="space-y-0.5">
          {main.map((f) => (
            <li key={f.id}>
              <NavLink feature={f} pathname={pathname} siblings={siblings} />
            </li>
          ))}
        </ul>
      </div>
      <div className="shrink-0 border-t border-line p-3 lg:rail:px-2.5">
        {bottom.length > 0 && (
          <ul className="mb-2 space-y-0.5">
            {bottom.map((f) => (
              <li key={f.id}>
                <NavLink feature={f} pathname={pathname} siblings={siblings} />
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-center gap-2.5 rounded-[var(--radius-control)] px-1.5 py-1.5 lg:rail:justify-center lg:rail:px-0">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-full border border-line-strong bg-raised text-[11px] font-semibold text-muted" title={me.user.display_name} aria-hidden>
            {initials || '·'}
          </span>
          <div className="min-w-0 flex-1 lg:rail:hidden">
            {me.memberships.length > 1 ? (
              <Select
                aria-label={t('top.switchOrg')}
                value={me.organization.id}
                className="mb-1 h-7 text-xs"
                onChange={(e) => {
                  const nextOrg = e.target.value;
                  if (!nextOrg || nextOrg === me.organization.id) return;
                  void api('/auth/switch-organization', {
                    method: 'POST',
                    body: { organization_id: nextOrg },
                  }).then(() => {
                    window.location.reload();
                  });
                }}
              >
                {me.memberships.map((m) => (
                  <option key={m.organization_id} value={m.organization_id}>
                    {m.organization_name}
                  </option>
                ))}
              </Select>
            ) : (
              <p className="truncate text-[13px] font-medium text-fg" dir="auto">
                {me.organization.name}
              </p>
            )}
            <p className="truncate text-xs text-muted" dir="auto">
              {me.user.display_name} · {t(('control.role.' + me.role) as Key)}
            </p>
          </div>
        </div>
        <GuideNavLink labelClassName={RAIL_LABEL} />
        <button type="button" onClick={() => void signOut()} className="group relative mt-1 flex h-9 w-full items-center gap-3 rounded-[var(--radius-control)] px-2.5 text-[13px] text-muted hover:bg-raised hover:text-fg lg:rail:justify-center lg:rail:px-0">
          <LogOut className="size-4 shrink-0 rtl:-scale-x-100" aria-hidden />
          <span className={RAIL_LABEL}>{t('top.signOut')}</span>
        </button>
        <button
          type="button"
          onClick={toggleRail}
          className="group relative mt-1 hidden h-9 w-full items-center gap-3 rounded-[var(--radius-control)] px-2.5 text-[13px] text-muted hover:bg-raised hover:text-fg lg:flex lg:rail:justify-center lg:rail:px-0"
        >
          <PanelLeftClose className="size-4 shrink-0 rtl:-scale-x-100 lg:rail:hidden" aria-hidden />
          <PanelLeftOpen className="hidden size-4 shrink-0 rtl:-scale-x-100 lg:rail:block" aria-hidden />
          <span className={clsx(RAIL_LABEL, 'lg:rail:hidden')}>{t('nav.collapse')}</span>
          <span className={clsx(RAIL_LABEL, 'hidden lg:rail:block')}>{t('nav.expand')}</span>
        </button>
      </div>
    </nav>
  );
}
