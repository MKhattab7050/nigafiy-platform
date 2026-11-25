'use client';

import { useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { Me, Role, Site } from '@nigafiy/shared-types';
import { ApiError, api } from './api';
import { useI18n } from './i18n';
import { isRetryable, retryDelayMs } from './retry';

export type Topic = 'events' | 'devices' | 'checks' | 'collectors';
type Listener = (topic: Topic) => void;
const ALL_TOPICS: readonly Topic[] = ['events', 'devices', 'checks', 'collectors'];

interface AppState {
  me: Me;
  reloadMe: () => void;
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

/** True when `role` is at least `min`. */
export const hasRole = (role: Role, min: Role): boolean => RANK[role] >= RANK[min];

// Identical GETs issued at the same moment (e.g. two dashboard widgets reading /overview) share one request.
const inflight = new Map<string, Promise<unknown>>();
function sharedGet<T>(path: string): Promise<T> {
  let p = inflight.get(path);
  if (!p) {
    p = api<T>(path).finally(() => inflight.delete(path));
    inflight.set(path, p);
  }
  return p as Promise<T>;
}
// Four contexts so a change in one part does not re-render (or re-fetch) consumers of another:
// the SSE connection flag flips often, the stream subscription never changes identity.
interface SessionState {
  me: Me;
  reloadMe: () => void;
  can: (min: Role) => boolean;
  signOut: () => Promise<void>;
}
interface SitesState {
  sites: Site[];
  reloadSites: () => void;
  siteId: string | null;
  setSiteId: (id: string | null) => void;
}
type Subscribe = (listener: Listener) => () => void;
const SessionCtx = createContext<SessionState | null>(null);
const SitesCtx = createContext<SitesState | null>(null);
const LiveCtx = createContext(false);
const StreamCtx = createContext<Subscribe | null>(null);

function need<T>(value: T | null, name: string): T {
  if (value === null) throw new Error(`${name} outside AppProvider`);
  return value;
}
export const useSession = (): SessionState => need(useContext(SessionCtx), 'useSession');
export const useSites = (): SitesState => need(useContext(SitesCtx), 'useSites');
/** True while the live stream is connected. */
export const useLive = (): boolean => useContext(LiveCtx);
/** Stable for the whole session: listen for "topic changed" frames from the server. */
export const useSubscribe = (): Subscribe => need(useContext(StreamCtx), 'useSubscribe');

/** Everything at once (re-renders on any change). Prefer the narrower hooks in hot paths. */
export function useApp(): AppState {
  const session = useSession();
  const sites = useSites();
  const live = useLive();
  const subscribe = useSubscribe();
  return useMemo(() => ({ ...session, ...sites, live, subscribe }), [session, sites, live, subscribe]);
}

/** Loads the session, keeps one Server-Sent-Events connection, and exposes the site filter. */
export interface Unreachable {
  error: ApiError;
  /** Epoch ms of the next automatic attempt; null when the failure will not fix itself by retrying. */
  retryAt: number | null;
  retryNow: () => void;
}

export function AppProvider({ children, fallback, unreachable: renderUnreachable }: { children: React.ReactNode; fallback: React.ReactNode; unreachable: (state: Unreachable) => React.ReactNode }) {
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

  const reloadMe = useCallback(() => {
    api<Me>('/auth/me')
      .then((m) => setMe(m))
      .catch(() => undefined);
  }, []);

  // Boot: read the session. While the server cannot be reached, retry with a capped exponential
  // backoff (lib/retry.ts) and show why, instead of reloading the page in a loop.
  const [unreachable, setUnreachable] = useState<{ error: ApiError; retryAt: number | null } | null>(null);
  const [bootAttempt, setBootAttempt] = useState(0);
  const failures = useRef(0);
  useEffect(() => {
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    api<Me>('/auth/me')
      .then((m) => {
        if (cancelled) return;
        failures.current = 0;
        setUnreachable(null);
        setMe(m);
        if (m.user.locale !== locale && !document.cookie.includes('ld_locale=')) setLocale(m.user.locale);
        reloadSites();
        const saved = window.localStorage.getItem('ld_site');
        if (saved) setSiteIdState(saved);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const error = err instanceof ApiError ? err : new ApiError(0, 'network_error', String(err));
        if (error.status === 401 || error.status === 403) {
          router.replace('/login');
          return;
        }
        const delay = isRetryable(error.status) ? retryDelayMs(failures.current++) : null;
        setUnreachable({ error, retryAt: delay === null ? null : Date.now() + delay });
        if (delay !== null) retryTimer = setTimeout(() => setBootAttempt((a) => a + 1), delay);
      });
    return () => {
      cancelled = true;
      clearTimeout(retryTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bootAttempt]);
  const retryNow = useCallback(() => setBootAttempt((a) => a + 1), []);

  // A saved site filter may point at a site that no longer exists.
  useEffect(() => {
    if (siteId && sites.length && !sites.some((s) => s.id === siteId)) setSiteIdState(null);
  }, [siteId, sites]);

  const signedIn = me !== null;
  useEffect(() => {
    if (!signedIn) return;
    // The stream only says "topic X changed"; data is always re-fetched through the authorized REST API.
    const source = new EventSource('/api/v1/stream');
    const emit = (topic: Topic) => {
      for (const listener of listeners.current) listener(topic);
    };
    let dropped = false;
    source.addEventListener('ready', () => {
      setLive(true);
      // Frames sent while the stream was down are lost: refresh every topic once after a reconnect.
      if (dropped) for (const topic of ALL_TOPICS) emit(topic);
      dropped = false;
    });
    source.addEventListener('change', (e) => {
      try {
        const { topic } = JSON.parse((e as MessageEvent).data) as { topic: Topic };
        emit(topic);
      } catch {
        /* ignore malformed frame */
      }
    });
    source.onerror = () => {
      dropped = true;
      setLive(false); // EventSource reconnects by itself
    };
    return () => source.close();
  }, [signedIn]);

  const subscribe = useCallback<Subscribe>((listener) => {
    listeners.current.add(listener);
    return () => void listeners.current.delete(listener);
  }, []);
  const signOut = useCallback(async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
    window.location.href = '/login';
  }, []);
  const setSiteId = useCallback((id: string | null) => {
    setSiteIdState(id);
    if (id) window.localStorage.setItem('ld_site', id);
    else window.localStorage.removeItem('ld_site');
  }, []);
  const session = useMemo<SessionState | null>(() => (me ? { me, reloadMe, can: (min) => hasRole(me.role, min), signOut } : null), [me, reloadMe, signOut]);
  const sitesValue = useMemo<SitesState>(() => ({ sites, reloadSites, siteId, setSiteId }), [sites, reloadSites, siteId, setSiteId]);

  if (!session) return <>{unreachable ? renderUnreachable({ ...unreachable, retryNow }) : fallback}</>;
  return (
    <SessionCtx.Provider value={session}>
      <SitesCtx.Provider value={sitesValue}>
        <StreamCtx.Provider value={subscribe}>
          <LiveCtx.Provider value={live}>{children}</LiveCtx.Provider>
        </StreamCtx.Provider>
      </SitesCtx.Provider>
    </SessionCtx.Provider>
  );
}

export interface Query<T> {
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
  const subscribe = useSubscribe();
  const [state, setState] = useState<{ data?: T; error: ApiError | null; loading: boolean; path: string | null }>({ error: null, loading: Boolean(path), path });
  const seq = useRef(0);
  const topicKey = topics.join(',');

  const load = useCallback(() => {
    if (!path) return;
    const mine = ++seq.current;
    sharedGet<T>(path)
      .then((data) => mine === seq.current && setState({ data, error: null, loading: false, path }))
      .catch((error: ApiError) => {
        if (mine !== seq.current) return;
        if (error.status === 401) window.location.href = '/login';
        // Keep showing the last good data; surface the error next to it.
        setState((s) => ({ data: s.path === path ? s.data : undefined, error, loading: false, path }));
      });
  }, [path]);

  useEffect(() => {
    if (!path) {
      setState({ data: undefined, error: null, loading: false, path: null });
      return;
    }
    setState((s) => (s.path === path ? s : { data: undefined, error: null, loading: true, path }));
    load();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = subscribe((topic) => {
      if (document.visibilityState === 'hidden') return;
      if (!topicKey.split(',').includes(topic)) return;
      clearTimeout(timer);
      timer = setTimeout(load, 350 + Math.floor(Math.random() * 200));
    });
    const interval = refreshMs > 0 ? setInterval(() => document.visibilityState === 'visible' && load(), refreshMs) : null;
    return () => {
      unsubscribe();
      clearTimeout(timer);
      if (interval) clearInterval(interval);
    };
  }, [path, load, subscribe, topicKey, refreshMs]);

  return { data: path && state.path === path ? state.data : undefined, error: path ? state.error : null, loading: path ? state.loading || state.path !== path : false, reload: load };
}
