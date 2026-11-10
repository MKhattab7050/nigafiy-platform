'use client';

import clsx from 'clsx';
import { Activity, Clock, Gauge, History, LogOut, Menu, MonitorSmartphone, Network, Radar, Settings, Siren, Stethoscope, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useApp } from '@/lib/app';
import { type Key, useI18n } from '@/lib/i18n';
import { Dot, Select } from './ui';

// Only modules that are actually implemented appear here. No placeholder entries.
const NAV: { group: Key; items: { href: string; label: Key; icon: typeof Gauge }[] }[] = [
  {
    group: 'nav.group.observe',
    items: [
      { href: '/', label: 'nav.overview', icon: Gauge },
      { href: '/devices', label: 'nav.devices', icon: MonitorSmartphone },
      { href: '/topology', label: 'nav.topology', icon: Network },
      { href: '/monitoring', label: 'nav.monitoring', icon: Activity },
    ],
  },
  {
    group: 'nav.group.investigate',
    items: [
      { href: '/incidents', label: 'nav.incidents', icon: Siren },
      { href: '/doctor', label: 'nav.doctor', icon: Stethoscope },
      { href: '/time-machine', label: 'nav.timeMachine', icon: Clock },
      { href: '/events', label: 'nav.events', icon: History },
    ],
  },
  {
    group: 'nav.group.manage',
    items: [
      { href: '/discovery', label: 'nav.discovery', icon: Radar },
      { href: '/settings', label: 'nav.settings', icon: Settings },
    ],
  },
];

export function Logo({ compact }: { compact?: boolean }) {
  return (
    <span className="flex items-center gap-2.5">
      <svg viewBox="0 0 28 28" className="size-7 shrink-0" aria-hidden>
        <rect width="28" height="28" rx="7" className="fill-accent" />
        <circle cx="12.5" cy="12.5" r="5.5" fill="none" stroke="#fff" strokeWidth="2" />
        <path d="M16.8 16.8 21.5 21.5" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" />
        <circle cx="12.5" cy="12.5" r="1.6" className="fill-cyan" />
      </svg>
      {!compact && <span className="text-[15px] font-semibold tracking-tight text-fg">LAN Detective</span>}
    </span>
  );
}

export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { t, locale, setLocale } = useI18n();
  const { me, sites, siteId, setSiteId, live, signOut } = useApp();
  const [open, setOpen] = useState(false);

  useEffect(() => setOpen(false), [pathname]);

  const isActive = (href: string) => (href === '/' ? pathname === '/' : pathname.startsWith(href));

  const sidebar = (
    <nav aria-label="Main" className="flex h-full flex-col">
      <div className="flex h-14 items-center justify-between px-4">
        <Link href="/" aria-label="LAN Detective">
          <Logo />
        </Link>
        <button type="button" className="rounded p-1.5 text-muted hover:bg-raised lg:hidden" onClick={() => setOpen(false)} aria-label={t('common.close')}>
          <X className="size-4" />
        </button>
      </div>
      <div className="flex-1 space-y-5 overflow-y-auto px-3 py-3">
        {NAV.map((group) => (
          <div key={group.group}>
            <p className="mb-1.5 px-2 text-[11px] font-medium uppercase tracking-wider text-faint">{t(group.group)}</p>
            <ul className="space-y-0.5">
              {group.items.map(({ href, label, icon: Icon }) => (
                <li key={href}>
                  <Link
                    href={href}
                    aria-current={isActive(href) ? 'page' : undefined}
                    className={clsx(
                      'flex h-9 items-center gap-2.5 rounded-md px-2 text-[13px] transition-colors',
                      isActive(href) ? 'bg-accent/15 font-medium text-fg' : 'text-muted hover:bg-raised hover:text-fg',
                    )}
                  >
                    <Icon className={clsx('size-4 shrink-0', isActive(href) ? 'text-accent-hover' : '')} aria-hidden />
                    {t(label)}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="border-t border-line p-3">
        <p className="truncate px-2 text-[13px] font-medium text-fg">{me.organization.name}</p>
        <p className="truncate px-2 text-xs text-muted">
          {me.user.display_name} · {me.role}
        </p>
        <button type="button" onClick={() => void signOut()} className="mt-2 flex h-8 w-full items-center gap-2 rounded-md px-2 text-[13px] text-muted hover:bg-raised hover:text-fg">
          <LogOut className="size-4 rtl:-scale-x-100" aria-hidden />
          {t('top.signOut')}
        </button>
      </div>
    </nav>
  );

  return (
    <div className="min-h-dvh lg:ps-60">
      <aside className="fixed inset-y-0 start-0 z-30 hidden w-60 border-e border-line bg-surface lg:block">{sidebar}</aside>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/60" onClick={() => setOpen(false)} aria-hidden />
          <aside className="absolute inset-y-0 start-0 w-64 border-e border-line bg-surface">{sidebar}</aside>
        </div>
      )}

      <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-line bg-bg/90 px-4 backdrop-blur lg:px-6">
        <button type="button" className="rounded p-1.5 text-muted hover:bg-raised lg:hidden" onClick={() => setOpen(true)} aria-label={t('top.menu')}>
          <Menu className="size-5" />
        </button>
        <div className="lg:hidden">
          <Logo compact />
        </div>
        <div className="w-44 max-w-[45vw]">
          <Select aria-label={t('common.site')} value={siteId ?? ''} onChange={(e) => setSiteId(e.target.value || null)} className="h-8">
            <option value="">{t('top.allSites')}</option>
            {sites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="ms-auto flex items-center gap-3">
          <span className="hidden items-center gap-1.5 text-xs text-muted sm:flex" role="status">
            <Dot tone={live ? 'ok' : 'warn'} />
            {live ? t('top.live') : t('top.reconnecting')}
          </span>
          <button
            type="button"
            onClick={() => {
              const next = locale === 'en' ? 'ar' : 'en';
              setLocale(next);
              void api('/auth/me', { method: 'PATCH', body: { locale: next } }).catch(() => undefined);
            }}
            className="h-8 rounded-md border border-line-strong px-2.5 text-xs font-medium text-muted hover:bg-raised hover:text-fg"
            aria-label={t('settings.language')}
          >
            {locale === 'en' ? 'العربية' : 'English'}
          </button>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1400px] px-4 py-5 lg:px-6 lg:py-6">{children}</main>
    </div>
  );
}
