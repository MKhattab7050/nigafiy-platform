'use client';

import clsx from 'clsx';
import { BellRing, BookMarked, CornerDownLeft, type LucideIcon, Network, ScanSearch, Search, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { Collector, SearchHit, SearchHitKind, SearchResponse } from '@nigafiy/shared-types';
import type { GuideSearchIndex } from '@/features/guide/search';
import { FEATURES } from '@/features/registry';
import { type ApiError, api, qs } from '@/lib/api';
import { useApp } from '@/lib/app';
import { type Key, useI18n } from '@/lib/i18n';
import { programById } from '@/lib/programs';
import { usePrograms } from '@/lib/programs-context';
import { Badge, type ConnState, ErrorNote, StatusBadge, type Tone } from '../ui';

const HIT_GROUPS: SearchHitKind[] = ['device', 'endpoint', 'incident', 'switch', 'subnet', 'scope', 'router', 'knowledge'];

interface Item {
  id: string;
  title: string;
  subtitle?: string | null;
  /** Subtitles that are addresses (IP, MAC) read left to right in both languages. */
  ltrSubtitle?: boolean;
  icon?: LucideIcon;
  site?: string | null;
  status?: string | null;
  /** Devices and computers: their status uses the shared state badge (same word, tone and tooltip as their pages). */
  sharedState?: boolean;
  run: () => void;
  /** Pages: also matched by URL; the home-view pages lead the list before anything is typed. */
  route?: string;
  home?: boolean;
}

interface Group {
  id: string;
  label: string;
  items: Item[];
}

const fold = (s: string) => s.toLocaleLowerCase().normalize('NFKD').replace(/[̀-ًͯ-ٟ]/g, '');

function hitTone(status: string): Tone {
  if (status === 'online' || status === 'ok' || status === 'enabled' || status === 'published') return 'ok';
  if (status === 'offline' || status === 'down' || status === 'error') return 'crit';
  return 'info';
}

/**
 * The one search (Ctrl+K / ⌘K, or the search box in the top bar): pages, common actions, devices,
 * managed computers, incidents, switches, subnets, routers and knowledge (GET /search), and the user
 * guide. A combobox over a grouped listbox: ↑ ↓ move, Enter opens, Esc closes. Full screen on phones.
 */
export function CommandPalette({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const { t, locale, dir } = useI18n();
  const { siteId, can } = useApp();
  const { installed } = usePrograms();
  const dialog = useRef<HTMLDialogElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const baseId = useId();
  const titleId = `${baseId}-title`;
  const listId = `${baseId}-list`;
  const optionId = (i: number) => `${baseId}-opt-${i}`;

  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  // The full placeholder ("Search pages, devices, IPs, MACs…") is cut off on a phone; a short one reads whole.
  const [narrow, setNarrow] = useState(false);
  useEffect(() => setNarrow(window.matchMedia('(max-width: 639px)').matches), []);
  const q = query.trim();

  useEffect(() => {
    const d = dialog.current;
    if (d && !d.open) d.showModal(); // native <dialog>: focus stays inside, Escape closes
  }, []);

  // Server search, debounced.
  useEffect(() => {
    if (!q) {
      setHits([]);
      setSearching(false);
      setError(null);
      return;
    }
    let live = true;
    setSearching(true);
    setError(null);
    const timer = setTimeout(() => {
      api<SearchResponse>(`/search${qs({ q, site_id: siteId })}`)
        .then((res) => live && setHits(res.items))
        .catch((err) => live && setError(err as ApiError))
        .finally(() => live && setSearching(false));
    }, 200);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [q, siteId]);

  // The user guide is searched in the browser, loaded when the palette first opens (not part of every page).
  const [guide, setGuide] = useState<{ locale: string; index: GuideSearchIndex } | null>(null);
  useEffect(() => {
    if (guide?.locale === locale) return;
    let live = true;
    void Promise.all([import('@/features/guide/content'), import('@/features/guide/search')]).then(([content, search]) => {
      if (live) setGuide({ locale, index: search.buildGuideIndex(content.GUIDE_CONTENT[locale], [content.GUIDE_CONTENT[locale === 'en' ? 'ar' : 'en']]) });
    });
    return () => {
      live = false;
    };
  }, [locale, guide]);

  const go = (href: string) => {
    onClose();
    router.push(href);
  };

  async function scanNow() {
    setBusy(true);
    setNotice('');
    setError(null);
    try {
      const res = await api<{ items: Collector[] }>('/collectors');
      const targets = res.items.filter((c) => c.status === 'active' && c.connection_state === 'online' && (!siteId || c.site_id === siteId));
      if (targets.length === 0) {
        go('/sensors');
        return;
      }
      await Promise.all(targets.map((c) => api(`/collectors/${c.id}/scan`, { method: 'POST' })));
      setNotice(t('discovery.scanQueued'));
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  }

  const arrow = dir === 'rtl' ? '←' : '→';
  const actions: Item[] = useMemo(() => {
    const out: Item[] = [];
    if (can('technician')) out.push({ id: 'act-scan', title: t('discovery.scanNow'), icon: ScanSearch, run: () => void scanNow() });
    out.push({ id: 'act-network', title: t('palette.action.addNetwork'), icon: Network, run: () => go('/radar/discovery') });
    out.push({ id: 'act-notify', title: `${t('nav.settings')} ${arrow} ${t('settings.notifications')}`, icon: BellRing, run: () => go('/watch/notifications') });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, can, arrow, siteId]);

  const pages: Item[] = useMemo(
    () =>
      FEATURES.filter((f) => installed(f.program) && (!f.minRole || can(f.minRole))).map((f) => ({
        id: `page-${f.id}`,
        title: t(f.label),
        subtitle: f.program === 'hub' ? null : programById(f.program).name[locale],
        icon: f.icon,
        run: () => go(f.route),
        home: f.home,
        route: f.route,
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t, locale, can, installed],
  );

  const groups: Group[] = useMemo(() => {
    const out: Group[] = [];
    const needle = fold(q);
    const match = (it: Item) => fold(`${it.title} ${it.subtitle ?? ''} ${it.route ?? ''}`).includes(needle);
    const acts = q ? actions.filter(match) : actions;
    if (acts.length) out.push({ id: 'actions', label: t('palette.group.actions'), items: acts });
    const pgs = q ? pages.filter(match).slice(0, 6) : pages.filter((p) => p.home).slice(0, 8);
    if (pgs.length) out.push({ id: 'pages', label: t('palette.group.pages'), items: pgs });
    for (const kind of HIT_GROUPS) {
      const group = hits.filter((h) => h.kind === kind);
      if (!group.length) continue;
      out.push({
        id: kind,
        label: t(`top.searchKind.${kind}` as Key),
        items: group.map((h) => ({
          id: `${h.kind}-${h.id}`,
          title: h.title,
          subtitle: h.subtitle,
          ltrSubtitle: kind !== 'knowledge',
          site: h.site_name,
          status: h.status,
          sharedState: h.kind === 'device' || h.kind === 'endpoint',
          run: () => go(h.href),
        })),
      });
    }
    const guideHits = guide && q ? guide.index.query(q, 4) : [];
    if (guideHits.length)
      out.push({
        id: 'guide',
        label: t('guide.searchKind'),
        items: guideHits.map((h) => ({
          id: `guide-${h.id}-${h.anchor ?? ''}`,
          title: h.title,
          subtitle: h.snippet.replace(/`/g, ''),
          icon: BookMarked,
          run: () => go(`/guide/${h.id}${h.anchor ? `#${h.anchor}` : ''}`),
        })),
      });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, actions, pages, hits, guide, t]);

  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  useEffect(() => setActive(0), [q, hits]);
  const current = Math.min(active, Math.max(flat.length - 1, 0));

  useEffect(() => {
    document.getElementById(optionId(current))?.scrollIntoView({ block: 'nearest' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  function onKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!flat.length) return;
      setActive((current + (e.key === 'ArrowDown' ? 1 : -1) + flat.length) % flat.length);
    } else if ((e.key === 'Home' || e.key === 'End') && e.ctrlKey) {
      e.preventDefault();
      setActive(e.key === 'Home' ? 0 : flat.length - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (!busy) flat[current]?.run();
    }
  }

  let index = -1;
  const empty = q && !searching && flat.length === 0;

  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(e) => e.target === dialog.current && onClose()}
      className="animate-enter overflow-hidden bg-surface p-0 text-fg backdrop:bg-[rgb(5_9_14/0.6)] max-sm:m-0 max-sm:h-dvh max-sm:max-h-dvh max-sm:w-full max-sm:max-w-full sm:mx-auto sm:mt-[12vh] sm:max-h-[min(36rem,76vh)] sm:w-[calc(100%-2rem)] sm:max-w-xl sm:rounded-[12px] sm:border sm:border-line-strong sm:shadow-[var(--shadow-overlay)]"
    >
      <div className="flex h-full flex-col sm:max-h-[min(36rem,76vh)]">
        <h2 id={titleId} className="sr-only">
          {t('top.searchTitle')}
        </h2>
        <div className="flex shrink-0 items-center gap-2.5 border-b border-line px-4 transition-colors focus-within:border-accent max-sm:pt-[env(safe-area-inset-top)]">
          <Search className="size-4 shrink-0 text-faint" aria-hidden />
          <input
            autoFocus
            type="text"
            role="combobox"
            aria-expanded={flat.length > 0}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={flat.length ? optionId(current) : undefined}
            aria-label={t('top.searchTitle')}
            placeholder={t(narrow ? 'top.searchPlaceholderShort' : 'top.searchPlaceholder')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKey}
            autoComplete="off"
            spellCheck={false}
            enterKeyHint="go"
            // The global :focus-visible ring is unlayered, so Tailwind's outline-none cannot beat it; inside
            // the dialog the ring was clipped at the top. The always-focused field shows focus through the
            // row's accent border instead.
            style={{ outline: 'none' }}
            className="h-12 min-w-0 flex-1 bg-transparent text-[14px] text-fg outline-none placeholder:text-faint"
          />
          <button type="button" onClick={onClose} aria-label={t('common.close')} className="rounded-[6px] p-1.5 text-muted transition-colors hover:bg-raised hover:text-fg">
            <X className="size-4" aria-hidden />
          </button>
        </div>

        {(error || notice) && (
          <div className="shrink-0 space-y-2 px-4 pt-3">
            {error && <ErrorNote error={error} />}
            {notice && (
              <p role="status" className="rounded-md border border-accent/30 bg-accent/10 px-3 py-2 text-[13px]">
                {notice}
              </p>
            )}
          </div>
        )}

        <div ref={list} id={listId} role="listbox" aria-label={t('top.searchTitle')} aria-busy={searching || busy} className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
          {groups.map((g) => (
            <div key={g.id} role="group" data-search-group={g.id} aria-labelledby={`${baseId}-g-${g.id}`} className="pb-1.5">
              <p id={`${baseId}-g-${g.id}`} role="presentation" className="px-2.5 pb-1 pt-2 text-[11px] font-semibold text-faint">
                {g.label}
              </p>
              {g.items.map((it) => {
                index += 1;
                const i = index;
                const selected = i === current;
                const Icon = it.icon;
                return (
                  <div
                    key={it.id}
                    id={optionId(i)}
                    role="option"
                    aria-selected={selected}
                    tabIndex={-1}
                    onMouseMove={() => active !== i && setActive(i)}
                    onClick={() => !busy && it.run()}
                    className={clsx('flex cursor-pointer items-center gap-2.5 rounded-[8px] px-2.5 py-2 text-[13px]', selected ? 'bg-accent/[0.12] text-fg' : 'text-fg')}
                  >
                    {Icon && <Icon className={clsx('size-4 shrink-0', selected ? 'text-accent-hover' : 'text-faint')} aria-hidden />}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium" dir="auto">
                        {it.title}
                      </span>
                      {it.subtitle && (
                        <span className={clsx('block truncate text-xs text-muted', it.ltrSubtitle && 'mono text-start')} dir={it.ltrSubtitle ? 'ltr' : 'auto'}>
                          {it.subtitle}
                        </span>
                      )}
                    </span>
                    {it.site && (
                      <span className="max-sm:hidden">
                        <Badge tone="idle" dot={false}>
                          {it.site}
                        </Badge>
                      </span>
                    )}
                    {it.status && (it.sharedState ? <StatusBadge status={it.status as ConnState} /> : <Badge tone={hitTone(it.status)}>{it.status}</Badge>)}
                    {selected && <CornerDownLeft className="size-3.5 shrink-0 text-faint max-sm:hidden rtl:-scale-x-100" aria-hidden />}
                  </div>
                );
              })}
            </div>
          ))}
          {searching && flat.length === 0 && <p className="px-3 py-6 text-center text-[13px] text-muted">{t('palette.searching')}</p>}
          {empty && <p className="px-3 py-6 text-center text-[13px] text-muted">{t('top.searchEmpty')}</p>}
        </div>

        <p className="shrink-0 border-t border-line px-4 py-2 text-[11px] text-faint max-sm:hidden" aria-hidden>
          {t('palette.hint')}
        </p>
      </div>
    </dialog>
  );
}
