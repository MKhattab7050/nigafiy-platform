'use client';

import { BookMarked, FileBarChart2, Menu, Search } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { GuideSearchIndex } from '@/features/guide/search';
import type { SearchHit, SearchHitKind, SearchResponse } from '@nigafiy/shared-types';
import { type ApiError, api, qs } from '@/lib/api';
import { useLive, useSites } from '@/lib/app';
import { type Key, useI18n } from '@/lib/i18n';
// The component file, not the feature index: the top bar must not pull the guide's content into every page.
import { HelpButton } from '@/features/guide/components/help-button';
import { Logo } from '../logo';
import { SummaryReportView } from '../summary-report';
import { Badge, Button, ErrorNote, Input, Modal, Select, SkeletonBlock } from '../ui';
import { LanguageButton } from './language-button';
import { ThemeSwitch } from './theme-switch';

const SEARCH_GROUPS: SearchHitKind[] = ['device', 'endpoint', 'incident', 'switch', 'subnet', 'scope', 'router'];

/** Site selector, global search, executive summary report, live indicator, theme and language: identical on every page. */
export function TopBar({ onMenu }: { onMenu: () => void }) {
  const router = useRouter();
  const { t, locale } = useI18n();
  const { sites, siteId, setSiteId } = useSites();
  const live = useLive();

  // Global search modal state
  const [searchOpen, setSearchOpen] = useState(false);
  const [queryText, setQueryText] = useState('');
  const [searchHits, setSearchHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<ApiError | null>(null);

  // The user guide is searched in the browser (features/guide/search.ts), loaded the first time the
  // search opens so its content is not part of every page.
  const [guideIndex, setGuideIndex] = useState<{ locale: string; index: GuideSearchIndex } | null>(null);
  useEffect(() => {
    if (!searchOpen || guideIndex?.locale === locale) return;
    let active = true;
    void Promise.all([import('@/features/guide/content'), import('@/features/guide/search')]).then(([content, search]) => {
      if (active) setGuideIndex({ locale, index: search.buildGuideIndex(content.GUIDE_CONTENT[locale], [content.GUIDE_CONTENT[locale === 'en' ? 'ar' : 'en']]) });
    });
    return () => {
      active = false;
    };
  }, [searchOpen, locale, guideIndex]);
  const guideHits = guideIndex && queryText.trim() ? guideIndex.index.query(queryText, 5) : [];

  // Executive summary report modal (the report itself is components/summary-report.tsx, also Watch, Reports)
  const [reportOpen, setReportOpen] = useState(false);

  // Debounced search query
  useEffect(() => {
    if (!searchOpen) return;
    const q = queryText.trim();
    if (!q) {
      setSearchHits([]);
      setSearching(false);
      setSearchError(null);
      return;
    }
    let active = true;
    setSearching(true);
    setSearchError(null);
    const timer = setTimeout(() => {
      api<SearchResponse>(`/search${qs({ q, site_id: siteId })}`)
        .then((res) => {
          if (active) setSearchHits(res.items);
        })
        .catch((err) => {
          if (active) setSearchError(err as ApiError);
        })
        .finally(() => {
          if (active) setSearching(false);
        });
    }, 220);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [queryText, siteId, searchOpen]);

  return (
    <header className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b border-line bg-bg px-3 sm:gap-3 sm:px-4 lg:px-6">
      <button
        type="button"
        className="flex size-9 shrink-0 items-center justify-center rounded-[var(--radius-control)] text-muted hover:bg-raised hover:text-fg lg:hidden"
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
        onClick={() => setSearchOpen(true)}
        className="flex h-8 shrink-0 items-center justify-center gap-2 rounded-[var(--radius-control)] border border-line-strong bg-sunken text-xs text-muted transition-colors hover:border-faint/60 hover:text-fg max-sm:w-8 sm:min-w-0 sm:max-w-64 sm:flex-1 sm:shrink sm:justify-start sm:px-2.5"
        aria-label={t('top.searchTitle')}
      >
        <Search className="size-3.5 shrink-0 text-faint" aria-hidden />
        <span className="truncate max-sm:sr-only">{t('top.searchPlaceholder')}</span>
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

      {/* Global Search Modal */}
      {searchOpen && (
        <Modal title={t('top.searchTitle')} onClose={() => setSearchOpen(false)} wide>
          <div className="space-y-4">
            <Input
              autoFocus
              type="search"
              placeholder={t('top.searchPlaceholder')}
              aria-label={t('top.searchTitle')}
              value={queryText}
              onChange={(e) => setQueryText(e.target.value)}
            />
            {searchError && <ErrorNote error={searchError} />}
            {searching ? (
              <SkeletonBlock lines={4} />
            ) : queryText.trim() && searchHits.length === 0 && guideHits.length === 0 ? (
              <p className="py-6 text-center text-[13px] text-muted">{t('top.searchEmpty')}</p>
            ) : (
              <div className="space-y-4">
                {SEARCH_GROUPS.map((kind) => {
                  const group = searchHits.filter((h) => h.kind === kind);
                  if (!group.length) return null;
                  return (
                    <div key={kind}>
                      <p className="mb-1.5 text-xs font-semibold text-muted">{t(`top.searchKind.${kind}` as Key)}</p>
                      <ul className="divide-y divide-line rounded-md border border-line">
                        {group.map((hit) => (
                          <li key={`${hit.kind}-${hit.id}`}>
                            <button
                              type="button"
                              onClick={() => {
                                setSearchOpen(false);
                                router.push(hit.href);
                              }}
                              className="flex w-full flex-wrap items-center justify-between gap-2 px-3 py-2 text-start text-[13px] hover:bg-raised"
                            >
                              <div className="min-w-0">
                                <p className="truncate font-medium text-fg" dir="auto">
                                  {hit.title}
                                </p>
                                {hit.subtitle && (
                                  <p className="mono truncate text-xs text-muted" dir="ltr">
                                    {hit.subtitle}
                                  </p>
                                )}
                              </div>
                              <div className="flex items-center gap-1.5">
                                {hit.site_name && (
                                  <Badge tone="idle" dot={false}>
                                    {hit.site_name}
                                  </Badge>
                                )}
                                {hit.status && (
                                  <Badge
                                    tone={
                                      hit.status === 'online' || hit.status === 'ok' || hit.status === 'enabled'
                                        ? 'ok'
                                        : hit.status === 'offline' || hit.status === 'down' || hit.status === 'error'
                                          ? 'crit'
                                          : 'info'
                                    }
                                  >
                                    {hit.status}
                                  </Badge>
                                )}
                              </div>
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })}
              </div>
            )}
            {guideHits.length > 0 && (
              <div data-search-guide>
                <p className="mb-1.5 text-xs font-semibold text-muted">{t('guide.searchKind')}</p>
                <ul className="divide-y divide-line rounded-md border border-line">
                  {guideHits.map((hit) => (
                    <li key={hit.id}>
                      <button
                        type="button"
                        onClick={() => {
                          setSearchOpen(false);
                          router.push(`/guide/${hit.id}${hit.anchor ? `#${hit.anchor}` : ''}`);
                        }}
                        className="flex w-full items-start gap-2.5 px-3 py-2 text-start text-[13px] hover:bg-raised"
                      >
                        <BookMarked className="mt-0.5 size-3.5 shrink-0 text-faint" aria-hidden />
                        <span className="min-w-0">
                          <span className="block truncate font-medium text-fg">{hit.title}</span>
                          <span className="line-clamp-2 block text-xs text-muted">{hit.snippet.replace(/`/g, '')}</span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </Modal>
      )}

      {/* Executive Summary Report Modal */}
      {reportOpen && (
        <Modal title={t('top.reportTitle')} onClose={() => setReportOpen(false)} wide>
          <SummaryReportView />
        </Modal>
      )}
    </header>
  );
}
