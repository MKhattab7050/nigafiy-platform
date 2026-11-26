'use client';

import { FileBarChart2, Menu, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useLive, useSites } from '@/lib/app';
import { useI18n } from '@/lib/i18n';
// The component file, not the feature index: the top bar must not pull the guide's content into every page.
import { HelpButton } from '@/features/guide/components/help-button';
import { Logo } from '../logo';
import { SummaryReportView } from '../summary-report';
import { Button, Modal, Select } from '../ui';
import { LanguageButton } from './language-button';
import { ThemeSwitch } from './theme-switch';

/** Site selector, the search (opens the command palette), executive summary report, live indicator, theme and language: identical on every page. */
export function TopBar({ onMenu, onSearch }: { onMenu: () => void; onSearch: () => void }) {
  const { t } = useI18n();
  const { sites, siteId, setSiteId } = useSites();
  const live = useLive();

  // Executive summary report modal (the report itself is components/summary-report.tsx, also Watch, Reports)
  const [reportOpen, setReportOpen] = useState(false);

  // The shortcut as this keyboard writes it.
  const [mac, setMac] = useState(false);
  useEffect(() => setMac(/Mac|iPhone|iPad/.test(navigator.platform)), []);

  return (
    <header className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b border-line bg-bg px-3 sm:gap-3 sm:px-4 lg:px-6">
      <button
        type="button"
        className="flex size-9 shrink-0 items-center justify-center rounded-[var(--radius-control)] text-muted hover:bg-raised hover:text-fg max-md:hidden lg:hidden"
        onClick={onMenu}
        aria-label={t('top.menu')}
      >
        <Menu className="size-5" aria-hidden />
      </button>
      <div className="hidden sm:block lg:hidden">
        <Logo compact />
      </div>
      <div className="min-w-0 flex-1 sm:w-44 sm:max-w-48 sm:flex-none">
        <Select aria-label={t('common.site')} value={siteId ?? ''} onChange={(e) => setSiteId(e.target.value || null)} className="h-8">
          <option value="">{t('top.allSites')}</option>
          {sites.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
      </div>

      {/* Global Search trigger */}
      <button
        type="button"
        onClick={onSearch}
        aria-haspopup="dialog"
        aria-keyshortcuts={mac ? 'Meta+K' : 'Control+K'}
        className="flex h-8 shrink-0 items-center justify-center gap-2 rounded-[var(--radius-control)] border border-line-strong bg-sunken text-xs text-muted transition-colors hover:border-faint/60 hover:text-fg max-sm:w-8 sm:min-w-0 sm:max-w-64 sm:flex-1 sm:shrink sm:justify-start sm:px-2.5"
        aria-label={t('top.searchTitle')}
      >
        <Search className="size-3.5 shrink-0 text-faint" aria-hidden />
        <span className="truncate max-sm:sr-only">{t('top.searchShort')}</span>
        <kbd className="ms-auto hidden shrink-0 rounded-[4px] border border-line px-1 font-sans text-[10.5px] text-faint lg:inline" dir="ltr" aria-hidden>
          {mac ? '⌘K' : 'Ctrl K'}
        </kbd>
      </button>

      <div className="ms-auto flex shrink-0 items-center gap-2 sm:gap-2.5">
        <Button size="sm" variant="secondary" onClick={() => setReportOpen(true)}>
          <FileBarChart2 className="size-3.5" aria-hidden />
          <span className="max-md:sr-only">{t('top.reportBtn')}</span>
        </Button>

        <span className="flex items-center gap-1.5 text-xs text-muted" role="status" title={live ? t('top.live') : t('top.reconnecting')}>
          <span className="relative flex size-2">
            {live && <span className="absolute inset-0 animate-ping rounded-full bg-ok/50 [animation-duration:2.4s]" aria-hidden />}
            <span className={`relative size-2 rounded-full ${live ? 'bg-ok' : 'bg-warn'}`} aria-hidden />
          </span>
          <span className="max-sm:sr-only">{live ? t('top.live') : t('top.reconnecting')}</span>
        </span>
        <HelpButton />
        {/* Phones: theme and language live in the menu drawer (sidebar), so the site selector and search keep their room. */}
        <span className="max-sm:hidden">
          <ThemeSwitch />
        </span>
        <LanguageButton className="max-sm:hidden" />
      </div>

      {/* Executive Summary Report Modal */}
      {reportOpen && (
        <Modal title={t('top.reportTitle')} onClose={() => setReportOpen(false)} wide>
          <SummaryReportView />
        </Modal>
      )}
    </header>
  );
}
