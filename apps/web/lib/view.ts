'use client';

import { useCallback, useSyncExternalStore } from 'react';
import { DEFAULT_VIEW, VIEW_STORAGE_KEY, type ViewMode, parseView } from './view-mode';

/** Same-tab change notice (the `storage` event only reaches other tabs). */
const CHANGE_EVENT = 'nigafiy:view';

/** Holds the choice when storage is blocked, so the switch still works until the page reloads. */
let memory: ViewMode | null = null;

function read(): ViewMode {
  if (memory) return memory;
  try {
    return parseView(window.localStorage.getItem(VIEW_STORAGE_KEY));
  } catch {
    return DEFAULT_VIEW;
  }
}

function subscribe(onChange: () => void): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === VIEW_STORAGE_KEY) onChange();
  };
  window.addEventListener('storage', onStorage);
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener('storage', onStorage);
    window.removeEventListener(CHANGE_EVENT, onChange);
  };
}

/** The simple / full view of this browser (lib/view-mode.ts), shared by every part of the shell and kept in step across tabs. */
export function useView(): { view: ViewMode; setView: (next: ViewMode) => void } {
  const view = useSyncExternalStore(subscribe, read, () => DEFAULT_VIEW);
  const setView = useCallback((next: ViewMode) => {
    try {
      window.localStorage.setItem(VIEW_STORAGE_KEY, next);
    } catch {
      /* storage blocked: the change still applies to this page */
      memory = next;
    }
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }, []);
  return { view, setView };
}
