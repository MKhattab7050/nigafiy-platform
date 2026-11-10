'use client';

import { useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { Me, Role, Site } from '@lan-detective/shared-types';
import { ApiError, api } from './api';
import { useI18n } from './i18n';

export type Topic = 'events' | 'devices' | 'checks' | 'collectors';
type Listener = (topic: Topic) => void;

interface AppState {
  me: Me;
  sites: Site[];
  reloadSites: () => void;
  /** null = all sites */
  siteId: string | null;
  setSiteId: (id: string | null) => void;
  live: boolean;
  subscribe: (listener: Listener) => () => void;
  can: (min: Role) => boolean;
  signOut: () => Promise<void>;
}

const RANK: Record<Role, number> = { viewer: 0, technician: 1, admin: 2, owner: 3 };
const Ctx = createContext<AppState | null>(null);

export function useApp(): AppState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useApp outside AppProvider');
  return ctx;
}

/** Loads the session, keeps one Server-Sent-Events connection, and exposes the site filter. */
export function AppProvider({ children, fallback }: { children: React.ReactNode; fallback: React.ReactNode }) {
  const router = useRouter();
  const { setLocale, locale } = useI18n();
  const [me, setMe] = useState<Me | null>(null);
  const [sites, setSites] = useState<Site[]>([]);
  const [siteId, setSiteIdState] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const listeners = useRef(new Set<Listener>());

  const reloadSites = useCallback(() => {
    api<{ items: Site[] }>('/sites')
      .then((r) => setSites(r.items))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    let cancelled = false;
    api<Me>('/auth/me')
      .then((m) => {
        if (cancelled) return;
        setMe(m);
        if (m.user.locale !== locale && !document.cookie.includes('ld_locale=')) setLocale(m.user.locale);
        reloadSites();
        const saved = window.localStorage.getItem('ld_site');
        if (saved) setSiteIdState(saved);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) router.replace('/login');
        else setTimeout(() => window.location.reload(), 5000); // server unreachable: retry
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A saved site filter may point at a site that no longer exists.
  useEffect(() => {
    if (siteId && sites.length && !sites.some((s) => s.id === siteId)) setSiteIdState(null);
  }, [siteId, sites]);

  useEffect(() => {
    if (!me) return;
    // The stream only says "topic X changed"; data is always re-fetched through the authorized REST API.
    const source = new EventSource('/api/v1/stream');
    source.addEventListener('ready', () => setLive(true));
    source.addEventListener('change', (e) => {
      try {
        const { topic } = JSON.parse((e as MessageEvent).data) as { topic: Topic };
        for (const listener of listeners.current) listener(topic);
      } catch {
        /* ignore malformed frame */
      }
    });
    source.onerror = () => setLive(false); // EventSource reconnects by itself
    return () => source.close();
  }, [me]);

  const value = useMemo<AppState | null>(() => {
    if (!me) return null;
    return {
      me,
      sites,
      reloadSites,
      siteId,
      setSiteId: (id) => {
        setSiteIdState(id);
        if (id) window.localStorage.setItem('ld_site', id);
        else window.localStorage.removeItem('ld_site');
      },
      live,
      subscribe: (listener) => {
        listeners.current.add(listener);
        return () => void listeners.current.delete(listener);
      },
      can: (min) => RANK[me.role] >= RANK[min],
      signOut: async () => {
        await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
        window.location.href = '/login';
      },
    };
  }, [me, sites, siteId, live, reloadSites]);

  if (!value) return <>{fallback}</>;
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

interface Query<T> {
  data: T | undefined;
  error: ApiError | null;
  loading: boolean;
  reload: () => void;
}

/**
 * Fetch `path` and keep it fresh: re-fetch when the server signals a change on one of `topics`
 * (debounced), and on a slow interval as a safety net when the live stream is down.
 */
export function useQuery<T>(path: string | null, topics: Topic[] = [], refreshMs = 30_000): Query<T> {
  const { subscribe } = useApp();
  const [state, setState] = useState<{ data?: T; error: ApiError | null; loading: boolean; path: string | null }>({ error: null, loading: true, path });
  const seq = useRef(0);
  const topicKey = topics.join(',');

  const load = useCallback(() => {
    if (!path) return;
    const mine = ++seq.current;
    api<T>(path)
      .then((data) => mine === seq.current && setState({ data, error: null, loading: false, path }))
      .catch((error: ApiError) => {
        if (mine !== seq.current) return;
        if (error.status === 401) window.location.href = '/login';
        // Keep showing the last good data; surface the error next to it.
        setState((s) => ({ data: s.path === path ? s.data : undefined, error, loading: false, path }));
      });
  }, [path]);

  useEffect(() => {
    if (!path) return;
    setState((s) => (s.path === path ? s : { data: undefined, error: null, loading: true, path }));
    load();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = subscribe((topic) => {
      if (!topicKey.split(',').includes(topic)) return;
      clearTimeout(timer);
      timer = setTimeout(load, 400);
    });
    const interval = setInterval(() => document.visibilityState === 'visible' && load(), refreshMs);
    return () => {
      unsubscribe();
      clearTimeout(timer);
      clearInterval(interval);
    };
  }, [path, load, subscribe, topicKey, refreshMs]);

  return { data: state.path === path ? state.data : undefined, error: state.error, loading: state.loading || state.path !== path, reload: load };
}
